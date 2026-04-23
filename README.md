# Website Viewer v2

A local-first tool for triaging large lists of URLs. 


# Get started

From the project root:

```bash
npm run viewer-v2
```

Open http://localhost:4174/


## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `J` / `↓` / `→` | Next URL |
| `K` / `↑` / `←` | Previous URL |
| `Enter` | Open current URL in popup window |
| `G` / `S` / `C` | Grid / Single / Compare view |
| `1` / `2` / `3` | Desktop / Tablet / Mobile viewport |
| `R` | Recheck all statuses |
| `X` | Toggle select on current |
| `A` / `Shift+A` | Select all filtered / clear selection |
| `F` | Flag current |
| `V` | Mark current reviewed |
| `Del` / `Backspace` | Remove current or selected |
| `/` | Focus filter |
| `\` | Toggle sidebar |
| `T` | Toggle theme |
| `?` | This help |

## Endpoints

- `GET /api/check?url=...` — raw HTTP status, redirects, response time, server header, and metadata extracted from HTML. Fast, no browser.
- `GET /api/screenshot?url=...&viewport=desktop|tablet|mobile&fullPage=0|1` — Puppeteer screenshot, cached by (url, viewport, fullPage).
- `GET /api/metadata?url=...` — cached metadata JSON for a URL.
- `GET /api/favicon?url=...` — favicon bytes, proxied and cached locally.
- `GET /api/projects` — list projects.
- `GET /api/projects/:id` — get full project.
- `POST /api/projects` — create or update.
- `DELETE /api/projects/:id` — delete.

## Config

Environment variables:

- `PORT` — default `4174`.
- `SCREENSHOT_CONCURRENCY` — default `2`.
- `SCREENSHOT_CACHE_TTL_HOURS` — default `168` (one week).

## Storage

Everything local. No third-party APIs.

```
Website Viewer/v2/
├── .wv2-data/
│   ├── cache/         (screenshot PNGs keyed by url+viewport+fullPage hash)
│   ├── meta/          (per-URL metadata JSON)
│   ├── favicons/      (favicon blobs, proxied and cached)
│   └── projects/      (per-project JSON: urls, tags, notes, reviews)
├── public/            (client)
└── server.js
```

Delete `.wv2-data/` to wipe all local state.
