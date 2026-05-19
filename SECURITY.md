# Security

Website Viewer is intended to run locally on a user's computer at `http://localhost:4174/`.

## Defaults

- The server binds to `127.0.0.1` by default.
- API responses and static files use no-store caching.
- API routes require a same-origin browser signal.
- Localhost, intranet, private-IP, link-local, and reserved network targets are blocked by default.
- Lists, decisions, screenshots, and metadata are not saved between sessions.
- The local server shuts down automatically a few minutes after all Website Viewer tabs are closed.

Set `ALLOW_PRIVATE_TARGETS=1` only when intentionally reviewing trusted internal or local URLs.

## Reporting

If you find a security issue, do not include sensitive URL lists or screenshots in the report. Share the affected version, the steps to reproduce, and the smallest safe example URL or file you can provide.
