# Website Viewer 1.0

A local-first tool for checking large lists of websites in a thumbnail review grid. It does not save lists, review decisions, screenshots, or metadata between sessions.

## Download And Start

For the easiest team install, download the latest `Website-Viewer-vX.Y.Z.zip` from GitHub Releases and extract it to a normal folder such as Desktop or Documents.

Install Node.js 18 or newer once from https://nodejs.org/ if it is not already installed.

Then use the launcher for your computer:

- Windows: double-click `Start Website Viewer.bat`
- macOS: right-click `Start Website Viewer.command`, choose Open
- Linux: run `./start-viewer.sh`

The first launch installs the required packages and a browser for screenshots, so it may take a few minutes. After that, the launcher starts the local viewer and opens it in your default browser.

Keep the launcher window open while using Website Viewer. When you close all Website Viewer browser tabs, the local server shuts down automatically after a few minutes. You can also close the launcher window or press `Ctrl+C` to stop it right away.

## Manual Start

From the project folder:

```bash
npm install
npm run launch
```

Open http://localhost:4174/ if the browser does not open automatically.

## Daily Use

1. Paste URLs into the Add URLs box, or import a `.txt`, `.csv`, `.json`, or bookmarks `.html` file.
2. Click Load list to start a fresh list, or Append to add URLs to the current list.
3. Review thumbnails, open any site in a real browser window, and mark URLs valid or invalid.
4. Export results from the export button at the bottom of the sidebar.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `J` / `↓` / `→` | Next URL |
| `K` / `↑` / `←` | Previous URL |
| `Enter` | Open current URL in popup window |
| `R` | Recheck all statuses |
| `X` | Toggle select on current |
| `A` / `Shift+A` | Select all filtered / clear selection |
| `Y` / `N` | Approve or reject current URL and move next |
| `F` | Flag current |
| `V` | Mark current reviewed |
| `[` / `]` | Previous / next URL that still needs manual review |
| `Del` | Remove current or selected |
| `Backspace` | Remove selected URLs only |
| `Escape` | Close modals or leave a text field |
| `/` | Focus filter |
| `\` | Toggle sidebar |
| `T` | Toggle theme |
| `?` | Help |

## Troubleshooting

- If the launcher says Node.js is missing, install the current LTS version from https://nodejs.org/ and run the launcher again.
- If the first launch fails during install, check that the computer is online and that your company network allows npm downloads, then try the launcher again.
- If port `4174` is busy, the launcher will try the next available local port and open that address.
- If a website preview is blank or solid-colored, use Reload. If it still looks wrong, use Open window. Some websites block or slow automated screenshot capture.

## Config

Environment variables:

- `PORT` - default `4174`
- `HOST` - default `127.0.0.1`; keep this unless you intentionally want the tool reachable from another computer on your network
- `ALLOW_PRIVATE_TARGETS` - default `0`; set to `1` only when you intentionally need localhost, intranet, or private-IP URLs
- `SCREENSHOT_CONCURRENCY` - default `8`
- `SCREENSHOT_JPEG_QUALITY` - default `72`
- `SCREENSHOT_SESSION_CACHE_TTL_HOURS` - default `12`; only affects the current running session
- `CAPTURE_TIMEOUT_MS` - default `30000`; max total time for one browser capture
- `CAPTURE_NAV_TIMEOUT_MS` - default `8000`
- `CAPTURE_IDLE_MS` - default `250`; quiet-network time required before an optional settle wait completes
- `CAPTURE_IDLE_TIMEOUT_MS` - default `500`; lower for speed, raise if pages need more time to finish painting
- `CAPTURE_SETTLE_MS` - default `300`; short wait after initial load before the screenshot
- `CAPTURE_SPARSE_EXTRA_WAIT_MS` - default `1600`; extra wait only when the page still looks visually empty
- `SCREENSHOT_STEP_TIMEOUT_MS` - default `8000`; max time for the final screenshot step
- `META_STORE_MAX_ENTRIES` - default `10000`; maximum in-memory metadata records kept during one session
- `AUTO_SHUTDOWN` - default `1`; set to `0` to keep the local server running until manually stopped
- `AUTO_SHUTDOWN_GRACE_MS` - default `300000`; time to wait after all Website Viewer tabs close before stopping the server
- `AUTO_SHUTDOWN_STARTUP_GRACE_MS` - default `1800000`; extra time allowed for the first browser tab to connect on slow first launch
- `VIEWER_SESSION_TTL_MS` - default `90000`; how long a quiet browser tab can go without a heartbeat before it is treated as closed
- `SERVER_CHECK_CONCURRENCY` - default `6`
- `PROVIDER_SHOT_CONCURRENCY` - default `2`
- `THROTTLED_PROVIDER_SHOT_CONCURRENCY` - default `1` for providers like LinkedIn, Facebook, Instagram, TikTok, YouTube, Amazon, and similar high-friction sites
- `PROVIDER_SHOT_DELAY_MS` - default `350`
- `THROTTLED_PROVIDER_SHOT_DELAY_MS` - default `2500`
- `PROVIDER_CHECK_CONCURRENCY` - default `2`
- `THROTTLED_PROVIDER_CHECK_CONCURRENCY` - default `1`
- `PROVIDER_CHECK_DELAY_MS` - default `250`
- `THROTTLED_PROVIDER_CHECK_DELAY_MS` - default `1500`

## Storage

Everything stays local. No third-party APIs are used.

Website Viewer stores the active list and review decisions only in the open browser tab. Screenshots are written to a temporary operating-system folder while the server is running so the browser can display them, and that temporary folder is removed on shutdown. Reloading or restarting the app starts clean.

For safety, localhost, intranet, private-IP, link-local, and other reserved network targets are blocked by default. This prevents a pasted URL list from turning the app into a scanner for the user's own machine or office network. Use `ALLOW_PRIVATE_TARGETS=1` only for a trusted internal review list.

## Preparing a Team Copy

Run this before sharing the app:

```bash
npm run release
```

Upload the generated `dist/Website-Viewer-vX.Y.Z.zip` file to the GitHub release. The script also creates `dist/Website-Viewer-release/` for local inspection. Both exclude `node_modules`, `dist`, old zip files, logs, common env/key/cert files, and other runtime output so the package stays clean.
