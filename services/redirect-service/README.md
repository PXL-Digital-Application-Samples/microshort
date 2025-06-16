# Redirect Service

High-performance redirect service for the microshort platform. This is the public-facing service that handles short URL redirects.

## Features

- Fast redirects with in-memory caching
- Simple home page at root domain
- 404 page for invalid short URLs
- Logging for future analytics integration
- No database required - uses url-service API

## How It Works

1. Receives requests like `http://sho.rt/abc123`
2. Extracts slug (`abc123`) from URL path
3. Queries url-service to get the long URL (with caching)
4. Returns 301 redirect to the long URL
5. Logs the redirect for analytics

## Endpoints

### `GET /`
Shows a simple home page with service info.

### `GET /:slug`
Redirects to the long URL associated with the slug.
- Returns 301 redirect if found
- Returns 404 page if not found

### `GET /health`
Health check endpoint.

## Caching

- In-memory LRU cache with 5-minute TTL
- Maximum 10,000 entries
- Automatic cleanup of expired entries
- Significantly reduces load on url-service

## Environment Variables

- `PORT` - Service port (default: 8080)
- `URL_SERVICE_URL` - URL service endpoint (default: http://url-service:3002)
- `CONFIG_SERVICE_URL` - Config service endpoint (default: http://config-service:3000)

## Performance

- Minimal dependencies (express + node-fetch)
- In-memory caching for fast lookups
- Async logging (non-blocking)
- Efficient slug validation

## Development

```bash
npm install
npm run dev
```

## Production Considerations

- Should be behind a CDN for global performance
- Consider Redis for distributed caching
- Add rate limiting for abuse prevention
- Monitor cache hit rates