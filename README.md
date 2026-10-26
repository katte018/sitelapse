---
title: Sitelapse
sdk: docker
app_port: 3000
pinned: false
short_description: Drag a slider through a website's history
---

# Sitelapse

Type a website address, wait a moment, then drag a slider to watch the site change over the years. Snapshots come from the Internet Archive's Wayback Machine.

## Run it

You need Node.js 18.17 or newer.

```bash
npm install
npm run setup     # downloads the headless Chromium used for screenshots (one time)
npm start
```

Open http://localhost:3000 and search for a site, for example `apple.com`.

The first search for a site takes about a minute, because each snapshot is loaded from the archive and screenshotted. Screenshots are cached in `cache/`, so the same site and range load almost instantly the next time.

You can link straight to a timeline: `http://localhost:3000/?url=apple.com&range=10y`

## Safety and removing it

- **Only your computer can open the app.** The server listens on 127.0.0.1, so other devices on your network can't reach it. Set `HOST=0.0.0.0` only if you deliberately want to share it on your network.
- **The screenshot browser keeps Chromium's sandbox on**, the same protection your everyday browser uses for web pages. (Containers turn it off with `SITELAPSE_NO_SANDBOX=1`, because it can't start there.)
- **What leaves your computer:** the addresses you search are sent to the Wayback Machine (web.archive.org), and the archived pages are loaded from there. Nothing else is sent anywhere.
- **Library versions are pinned** in `package.json` and `package-lock.json`, so every install gets the exact same tested code.
- **Nothing runs in the background.** The app runs only while `npm start` is running in Terminal.

To remove everything:
1. Delete this folder (it includes the screenshot cache).
2. Delete the downloaded Chromium, which Playwright keeps outside the project: `~/Library/Caches/ms-playwright` on a Mac, `%USERPROFILE%\AppData\Local\ms-playwright` on Windows, `~/.cache/ms-playwright` on Linux.
3. Optionally uninstall Node.js.

## How it works

1. **Find captures.** The server asks the Wayback Machine's CDX API for successful HTML captures of the address, at most one per month.
2. **Pick frames.** It chooses frames spread evenly in *time* across the range (12 for the last year, 20 for 5 years, 24 for 10 years, 30 for all time), so a year with lots of captures doesn't crowd out quiet years.
3. **Screenshot.** Headless Chromium opens each capture in the archive's toolbar-free view (`/web/<timestamp>if_/<url>`) at 1280×800 and saves a JPEG. Three run at once. Pages that fail or time out are skipped.
4. **Stream.** Progress is sent to the browser as Server-Sent Events, so frames appear on the timeline as they finish.
5. **Scrub.** The browser decodes every frame up front into GPU-ready bitmaps and draws them on a canvas. Slider position is continuous, so between two snapshots the page cross-fades in proportion to where the thumb is. Easing on drag and a snap to the nearest capture on release keep it smooth.

Controls: drag the slider, use ← and → (Home and End jump to the ends), swipe sideways on a trackpad over the page, or press Space to play the timelapse.

## Settings

All optional, set as environment variables.

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `HOST` | `127.0.0.1` | Network address to listen on. `0.0.0.0` makes it reachable from other devices. |
| `CACHE_DIR` | `./cache` | Where screenshots are stored |
| `CAPTURE_CONCURRENCY` | `3` | Snapshots captured at the same time. Keep it low to be polite to the archive. |
| `CAPTURE_TIMEOUT_MS` | `45000` | How long to wait for one archived page |
| `CHROMIUM_PATH` | (Playwright's) | Use an existing Chrome or Chromium instead of the downloaded one |
| `WAYBACK_BASE` | `https://web.archive.org` | Archive base URL |

## Deploying

The server needs a real machine or container that can run Chromium. Serverless platforms such as Vercel or Netlify Functions are a poor fit because of Chromium's size and their request time limits.

### GitHub Codespaces (free, no install, private to you)

The `.devcontainer/devcontainer.json` file sets everything up.

1. Put these files in a GitHub repository, including `.devcontainer/devcontainer.json`.
2. On the repository page, click **Code → Codespaces → Create codespace on main**.
3. The first launch takes a few minutes while it installs. Then the app starts and opens in a new tab. If the tab doesn't open, use the **Ports** panel and click the globe icon next to port 3000.
4. Codespaces stop themselves after a period of inactivity. Reopen yours from github.com/codespaces and the app starts again.

Inside the codespace, Chromium's sandbox is off (`SITELAPSE_NO_SANDBOX=1`) because it can't start in that container. The codespace itself is an isolated cloud machine.

### Hugging Face Spaces (needs PRO for most new accounts)

This project is ready to run as a Docker Space. The block at the top of this README tells Hugging Face how to run it.

1. Sign in at huggingface.co and choose **New Space**.
2. Name it, pick **Docker** as the SDK and **Blank** as the template, keep the free **CPU basic** hardware, and create it.
3. In the new Space, open **Files**, choose **Add file → Upload files**, and drag in the five files from this folder: `Dockerfile`, `package.json`, `server.js`, `index.html` and `README.md`. It replaces the README the Space started with. Commit. (If a multi-file upload stalls, upload them one at a time.)
4. The Space builds for a few minutes, then the app appears on the Space's page.

Free Spaces go to sleep when nobody uses them for a while and wake on the next visit. Their disk is not permanent, so the screenshot cache empties when the Space restarts.

### Any Docker host

Render, Railway, Fly.io or a VPS all work with the included Dockerfile.

```bash
docker build -t sitelapse .
docker run -p 3000:3000 -v sitelapse-cache:/app/cache sitelapse
```

## Things to know

- **Speed depends on the archive.** Archived pages often load slowly. If the Wayback Machine is busy it may answer with errors; the server retries the lookup, and the page offers a retry button.
- **Some sites are excluded.** Site owners can ask the archive not to show their pages. Those addresses return no captures.
- **Not every capture renders well.** Older captures can be missing images or styles because the archive didn't save them. That's part of the charm.
- **Preview mode.** If `index.html` is opened without the server behind it, the page detects that and switches to preview mode, where it draws sample frames in the browser so the interface can be tried anywhere.

Please consider [supporting the Internet Archive](https://archive.org/donate). This app depends on it.
