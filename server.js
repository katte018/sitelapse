// Sitelapse server
// 1. Looks up a site's captures in the Wayback Machine (CDX API)
// 2. Picks frames spread evenly across the chosen range
// 3. Screenshots each capture with headless Chromium and caches it on disk
// 4. Streams progress to the browser with Server-Sent Events

import express from 'express';
import { chromium } from 'playwright';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 3000;
// Only this computer can reach the app unless HOST says otherwise (the Dockerfile sets 0.0.0.0).
const HOST = process.env.HOST || '127.0.0.1';
// Chromium's sandbox stays on, except inside containers, where it can't start.
const NO_SANDBOX = process.env.SITELAPSE_NO_SANDBOX === '1' || process.getuid?.() === 0;
const WAYBACK = (process.env.WAYBACK_BASE || 'https://web.archive.org').replace(/\/$/, '');
const CACHE_DIR = path.resolve(process.env.CACHE_DIR || path.join(__dirname, 'cache'));
const CONCURRENCY = Math.max(1, Number(process.env.CAPTURE_CONCURRENCY) || 3);
const CAPTURE_TIMEOUT = Number(process.env.CAPTURE_TIMEOUT_MS) || 45000;
const VIEWPORT = { width: 1280, height: 800 };
const USER_AGENT = 'Sitelapse/1.0 (website timelapse viewer)';

// Range presets: how far back to look and how many frames to build.
export const RANGES = {
  '1y': { years: 1, frames: 12 },
  '5y': { years: 5, frames: 20 },
  '10y': { years: 10, frames: 24 },
  all: { years: null, frames: 30 },
};

// ---------- helpers ----------

export function normalizeTarget(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Enter a web address, like apple.com');
  if (s.length > 2048) throw new Error('That address is too long');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error('That does not look like a web address');
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http and https addresses are supported');
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (!host.includes('.')) throw new Error('Enter a full domain, like apple.com');
  const pathPart = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
  const key = host + pathPart + u.search;
  return { key, display: key };
}

export const tsToDate = (ts) =>
  new Date(Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8) || 1, +ts.slice(8, 10) || 0, +ts.slice(10, 12) || 0, +ts.slice(12, 14) || 0));

const dateToTs = (d) =>
  d.getUTCFullYear().toString() +
  String(d.getUTCMonth() + 1).padStart(2, '0') +
  String(d.getUTCDate()).padStart(2, '0');

// Pick n captures spread evenly in time (not by index), so busy years
// don't crowd out quiet ones.
export function pickFrames(rows, n) {
  if (rows.length <= n) return rows.slice();
  const times = rows.map((r) => tsToDate(r.ts).getTime());
  const t0 = times[0];
  const t1 = times[times.length - 1];
  const used = new Set();
  for (let k = 0; k < n; k++) {
    const target = t0 + ((t1 - t0) * k) / (n - 1);
    // binary search for the closest capture
    let lo = 0;
    let hi = times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    // walk outwards to the nearest unused capture
    let best = -1;
    for (let d = 0; d < times.length && best < 0; d++) {
      const cands = [lo - d, lo + d - 1, lo + d].filter((i) => i >= 0 && i < times.length && !used.has(i));
      if (cands.length) best = cands.reduce((a, b) => (Math.abs(times[a] - target) <= Math.abs(times[b] - target) ? a : b));
    }
    if (best >= 0) used.add(best);
  }
  return [...used].sort((a, b) => a - b).map((i) => rows[i]);
}

async function fetchWithRetry(url, { attempts = 3, timeout = 30000 } = {}) {
  let lastErr;
  for (let a = 0; a < attempts; a++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(timeout) });
      if (res.status === 429 || res.status >= 500) throw new Error(`Wayback Machine returned ${res.status}`);
      if (!res.ok) throw Object.assign(new Error(`Wayback Machine returned ${res.status}`), { fatal: true });
      return res;
    } catch (e) {
      lastErr = e;
      if (e.fatal) break;
      await new Promise((r) => setTimeout(r, 1500 * (a + 1)));
    }
  }
  throw lastErr;
}

const cdxCache = new Map(); // `${key}|${range}` -> { at, rows }
const CDX_TTL = 60 * 60 * 1000;

async function getCaptures(key, rangeKey) {
  const cacheKey = `${key}|${rangeKey}`;
  const hit = cdxCache.get(cacheKey);
  if (hit && Date.now() - hit.at < CDX_TTL) return hit.rows;

  const params = new URLSearchParams({
    url: key,
    output: 'json',
    fl: 'timestamp,original',
    collapse: 'timestamp:6', // at most one capture per month
  });
  params.append('filter', 'statuscode:200');
  params.append('filter', 'mimetype:text/html');
  const { years } = RANGES[rangeKey];
  if (years) {
    const from = new Date();
    from.setUTCFullYear(from.getUTCFullYear() - years);
    params.set('from', dateToTs(from));
  }
  const res = await fetchWithRetry(`${WAYBACK}/cdx/search/cdx?${params}`);
  const text = await res.text();
  let json = [];
  if (text.trim()) json = JSON.parse(text);
  const rows = json
    .slice(1) // first row is the header
    .map(([ts, original]) => ({ ts, original }))
    .filter((r) => /^\d{14}$/.test(r.ts))
    .sort((a, b) => (a.ts < b.ts ? -1 : 1));
  cdxCache.set(cacheKey, { at: Date.now(), rows });
  return rows;
}

// ---------- screenshots ----------

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium
      .launch({
        executablePath: process.env.CHROMIUM_PATH || undefined,
        chromiumSandbox: !NO_SANDBOX,
        args: ['--disable-dev-shm-usage'],
      })
      .catch((e) => {
        browserPromise = null;
        throw e;
      });
  }
  return browserPromise;
}

const inflight = new Map(); // file -> Promise

const siteDir = (key) => crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function ensureShot(key, frame, signal) {
  const dir = siteDir(key);
  const file = path.join(CACHE_DIR, dir, `${frame.ts}.jpg`);
  const src = `shots/${dir}/${frame.ts}.jpg`;
  if (await exists(file)) return src;
  if (!inflight.has(file)) {
    const job = capture(frame, file, signal).finally(() => inflight.delete(file));
    inflight.set(file, job);
  }
  await inflight.get(file);
  return src;
}

async function capture(frame, file, signal) {
  if (signal?.aborted) throw new Error('aborted');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, userAgent: undefined });
  const onAbort = () => context.close().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const page = await context.newPage();
    // Video and audio never help a still frame and slow the archive down.
    await page.route('**/*', (route) =>
      route.request().resourceType() === 'media' ? route.abort() : route.continue()
    );
    // `if_` serves the archived page without the Wayback toolbar.
    const url = `${WAYBACK}/web/${frame.ts}if_/${frame.original}`;
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CAPTURE_TIMEOUT });
    // Don't keep a picture of an archive error page.
    if (response && response.status() >= 400) throw new Error(`Archive returned ${response.status()}`);
    await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
    await page
      .addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' })
      .catch(() => {});
    await page.waitForTimeout(500);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await page.screenshot({ path: tmp, type: 'jpeg', quality: 80 });
    await fs.rename(tmp, file);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await context.close().catch(() => {});
  }
}

async function runPool(items, size, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

const shortErr = (e) => String(e?.message || e).split('\n')[0].slice(0, 160);

// ---------- app ----------

const app = express();
app.disable('x-powered-by');

app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'sitelapse', version: '1.0.0' }));

app.get('/api/capture', async (req, res) => {
  let target;
  try {
    target = normalizeTarget(req.query.url);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const rangeKey = Object.hasOwn(RANGES, req.query.range) ? req.query.range : 'all';

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const ac = new AbortController();
  let closed = false;
  res.on('close', () => {
    closed = true;
    ac.abort();
  });
  const send = (event, data) => {
    if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const ping = setInterval(() => !closed && res.write(': ping\n\n'), 15000);

  try {
    send('status', { phase: 'lookup' });
    let rows;
    try {
      rows = await getCaptures(target.key, rangeKey);
    } catch (e) {
      send('fail', {
        reason: 'lookup_failed',
        message: 'The Wayback Machine did not answer. Wait a minute and try again.',
        detail: shortErr(e),
      });
      return;
    }
    if (rows.length === 0) {
      send('fail', {
        reason: 'no_captures',
        message: `The Wayback Machine has no saved copies of ${target.display} in this range.`,
      });
      return;
    }

    const frames = pickFrames(rows, RANGES[rangeKey].frames).map((r, i) => ({
      i,
      ts: r.ts,
      original: r.original,
      archiveUrl: `${WAYBACK}/web/${r.ts}/${r.original}`,
    }));
    send('meta', {
      url: target.display,
      range: rangeKey,
      total: rows.length,
      frames: frames.map(({ i, ts, archiveUrl }) => ({ i, ts, archiveUrl })),
    });

    let captured = 0;
    await runPool(frames, CONCURRENCY, async (f) => {
      if (ac.signal.aborted) return;
      try {
        const src = await ensureShot(target.key, f, ac.signal);
        captured++;
        send('frame', { i: f.i, ts: f.ts, src });
      } catch (e) {
        if (!ac.signal.aborted) send('skip', { i: f.i, ts: f.ts, message: shortErr(e) });
      }
    });
    send('done', { captured });
  } catch (e) {
    send('fail', { reason: 'server_error', message: 'Something went wrong while building the timeline.', detail: shortErr(e) });
  } finally {
    clearInterval(ping);
    if (!closed) res.end();
  }
});

app.use('/shots', express.static(CACHE_DIR, { immutable: true, maxAge: '30d', fallthrough: false }));
// The whole front end is one file next to this one.
app.get(['/', '/index.html'], (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const server = app.listen(PORT, HOST, () => {
    console.log(`Sitelapse running at http://localhost:${PORT}`);
  });
  const shutdown = async () => {
    server.close();
    if (browserPromise) await (await browserPromise).close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export default app;
