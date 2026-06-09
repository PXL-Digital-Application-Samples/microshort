# admin-ui

Web-based admin dashboard. Zero build tools — a plain Express static server delivers VanJS + htm app files directly to the browser.

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for the runtime config injection pattern and the reason VanJS/htm are vendored locally.

---

## Technology

- Node.js 26 / Express (static file server)
- VanJS 1.6.0 (reactive UI, vendored at `vendor/van.min.js`)
- htm 3.1.1 (JSX-like syntax, vendored at `vendor/htm.module.js`)
- Plain CSS (`styles.css`)
- No bundler, no transpiler, no build step

---

## Features

- Dashboard — system overview (users, URLs, clicks, top URLs by clicks)
- Users — list all registered users with role badges and join dates
- URLs — browse and search all shortened URLs
- Configuration — update the public domain
- Health — real-time status of all services

---

## API base URL (runtime config)

The dashboard calls admin-service for all data. The admin-service URL is injected at runtime via the `ADMIN_API_URL` environment variable — the UI never has the URL hard-coded.

`server.js` serves `GET /config.js` which sets `window.ADMIN_API_BASE` in the browser. `app.js` reads this value on load.

To point the dashboard at a different admin-service host:

```bash
# In .env:
ADMIN_API_URL=http://my-admin-host:3003

# Restart admin-ui:
docker compose up -d --build admin-ui
```

Verify the config endpoint:

```bash
curl http://localhost:3004/config.js
# window.ADMIN_API_BASE = "http://localhost:3003";
```

---

## Vendored libraries

VanJS and htm are committed to `vendor/` and served from the UI's own static server. No CDN requests, no internet access required at runtime or during image build.

To upgrade either library:
1. Download the new minified file from the project's release page
2. Replace the file in `services/admin-ui/vendor/`
3. Rebuild the image: `docker compose up -d --build admin-ui`

---

## Endpoints

| Path | Description |
|------|-------------|
| `GET /` | SPA entrypoint (`index.html`) |
| `GET /config.js` | Runtime config — sets `window.ADMIN_API_BASE` |
| `GET /vendor/van.min.js` | VanJS 1.6.0 |
| `GET /vendor/htm.module.js` | htm 3.1.1 |
| `GET /health` | Liveness |
| `GET /ready` | Readiness |

---

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ADMIN_API_URL` | no | `http://localhost:3003` | Browser-reachable URL for admin-service |
| `PORT` | no | `3004` | HTTP port |

---

## Development

```bash
npm install
npm run dev    # node --watch server.js (hot reload)
npm start      # node server.js
```

Open http://localhost:3004. API calls go to `ADMIN_API_URL` (default: `http://localhost:3003`). The full stack must be running for the dashboard to show data.

---

## Docker

Runs as the `node` user (non-root). No persistent storage.

```bash
# From repo root:
docker compose up -d --build admin-ui
```
