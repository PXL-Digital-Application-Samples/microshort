# Admin Service

Administrative API for the microshort platform. Provides centralized management capabilities by aggregating data from other microservices.

## Features

- Dashboard overview with system statistics
- User management (list all users)
- URL management (list all URLs, search)
- Configuration management
- Service health monitoring
- No direct database access - uses microservice APIs

## Authentication

All endpoints require an admin API key (currently user ID 1's API key).

Use header: `X-API-Key: msh_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

## API Endpoints

### `GET /admin/dashboard`
Get system overview with statistics.

Returns:
```json
{
  "users": {
    "total": 42,
    "recentSignups": 5,
    "totalApiKeys": 38
  },
  "urls": {
    "total": 156,
    "totalClicks": 1523,
    "recentUrls": 23,
    "topUrls": [...]
  }
}
```

### `GET /admin/users`
List all users in the system.

Returns:
```json
{
  "users": [
    {
      "id": 1,
      "email": "admin@example.com",
      "createdAt": "2024-06-15T10:00:00Z"
    }
  ]
}
```

### `GET /admin/urls`
List all URLs in the system.

Returns:
```json
{
  "urls": [
    {
      "id": 1,
      "shortUrl": "http://localhost:8080/abc123",
      "longUrl": "https://example.com",
      "slug": "abc123",
      "clicks": 42,
      "userId": 1,
      "createdAt": "2024-06-15T10:00:00Z"
    }
  ]
}
```

### `GET /admin/search/urls?q=query`
Search URLs by slug or long URL.

### `GET /admin/config`
Get current configuration.

### `PUT /admin/config`
Update configuration.
```json
{
  "domain": "http://localhost:8080"
}
```

### `GET /admin/health/services`
Check health of all microservices.

Returns:
```json
{
  "services": [
    {
      "service": "auth",
      "status": "healthy"
    },
    {
      "service": "url",
      "status": "healthy"
    },
    {
      "service": "config",
      "status": "healthy"
    }
  ]
}
```

### `GET /health`
Health check endpoint.

## Environment Variables

- `PORT` - Service port (default: 3003)
- `AUTH_SERVICE_URL` - Auth service URL (default: http://auth-service:3001)
- `URL_SERVICE_URL` - URL service URL (default: http://url-service:3002)
- `CONFIG_SERVICE_URL` - Config service URL (default: http://config-service:3000)

## Development

```bash
npm install
npm run dev
```

## Future Enhancements

This service is designed to support a future web UI with endpoints that provide:
- Aggregated data from multiple services
- Consistent JSON responses
- CORS enabled for browser access
- Pagination ready (to be implemented)
- Real-time stats (via WebSocket, to be implemented)

## Current Limitations

- Simple admin check (user ID 1)
- No user detail endpoint (needs additional microservice support)
- Client-side search filtering
- No pagination on list endpoints

## Usage with Web UI

The service is CORS-enabled and ready to be consumed by a React/Vue/Angular admin panel. All responses are JSON formatted for easy frontend integration.
