# URL Service

URL shortening service for the microshort platform.

## Features

- Create short URLs with random or custom slugs
- Track click counts
- List user's URLs
- Delete URLs
- Validates API keys via auth-service
- Gets domain configuration from config-service

## API Endpoints

### `POST /urls`
Create a new short URL (requires API key).
```
X-API-Key: msh_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```
```json
{
  "url": "https://example.com/very/long/url",
  "customSlug": "mylink"  // optional
}
```

Returns:
```json
{
  "id": 1,
  "shortUrl": "https://sho.rt/abc123",
  "longUrl": "https://example.com/very/long/url",
  "slug": "abc123",
  "createdAt": "2024-06-15T10:00:00Z"
}
```

### `GET /urls/:slug`
Get URL details by slug (public endpoint).
```
GET /urls/abc123
```

Returns:
```json
{
  "longUrl": "https://example.com/very/long/url",
  "slug": "abc123"
}
```

### `GET /urls`
List user's URLs (requires API key).
```
X-API-Key: msh_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Returns:
```json
{
  "urls": [
    {
      "id": 1,
      "shortUrl": "https://sho.rt/abc123",
      "longUrl": "https://example.com/very/long/url",
      "slug": "abc123",
      "clicks": 42,
      "createdAt": "2024-06-15T10:00:00Z"
    }
  ]
}
```

### `DELETE /urls/:slug`
Delete a URL (requires API key and ownership).
```
X-API-Key: msh_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
DELETE /urls/abc123
```

Returns:
```json
{
  "message": "URL deleted",
  "slug": "abc123"
}
```

### `GET /health`
Health check endpoint.

### Admin Endpoints (require admin API key)

### `GET /admin/urls`
List all URLs across all users (admin only - user ID 1).
```
X-API-Key: msh_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### `GET /admin/stats`
Get URL statistics including top URLs (admin only).
```
X-API-Key: msh_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

## Environment Variables

- `PORT` - Service port (default: 3002)
- `DB_HOST` - MySQL host (default: url-db)
- `DB_PORT` - MySQL port (default: 3306)
- `DB_NAME` - Database name (default: urlshort)
- `DB_USER` - Database user (default: urluser)
- `DB_PASSWORD` - Database password
- `AUTH_SERVICE_URL` - Auth service URL (default: http://auth-service:3001)
- `CONFIG_SERVICE_URL` - Config service URL (default: http://config-service:3000)

## Development

```bash
npm install
npm run dev
```

## Slug Format

- Random slugs: 6 character nanoid (e.g., `V1StGX`)
- Custom slugs: alphanumeric with `-` and `_`, max 50 chars
- Case-sensitive

## Testing

See `example.http` for HTTP client examples or `example.ps1` for PowerShell examples.