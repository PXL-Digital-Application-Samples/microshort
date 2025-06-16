# Auth Service

Simple authentication service for the microshort URL shortener.

## Features

- User registration and login with JWT tokens
- API key generation and validation
- PostgreSQL storage with `postgres` library
- Minimal dependencies, simple code

## API Endpoints

### `POST /auth/register`
Register a new user.
```json
{
  "email": "user@example.com",
  "password": "securepassword"
}
```

Returns:
```json
{
  "token": "jwt.token.here",
  "userId": 1
}
```

### `POST /auth/login`
Login with existing credentials.
```json
{
  "email": "user@example.com",
  "password": "securepassword"
}
```

### `GET /auth/me`
Get current user profile (requires JWT token).
```
Authorization: Bearer <jwt-token>
```

Returns:
```json
{
  "id": 1,
  "email": "user@example.com",
  "createdAt": "2024-06-15T10:00:00Z"
}
```

### `POST /auth/api-keys`
Generate a new API key (requires JWT token).
```
Authorization: Bearer <jwt-token>
```
```json
{
  "name": "My API Key"
}
```

Returns:
```json
{
  "apiKey": "msh_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "keyId": 1,
  "name": "My API Key"
}
```

### `POST /auth/validate`
Validate an API key (used by other services).
```json
{
  "apiKey": "msh_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

Returns:
```json
{
  "valid": true,
  "userId": 1,
  "keyId": 1
}
```

### `GET /auth/api-keys`
List user's API keys (requires JWT token).
```
Authorization: Bearer <jwt-token>
```

Returns:
```json
{
  "keys": [
    {
      "id": 1,
      "name": "My API Key",
      "createdAt": "2024-06-15T10:00:00Z",
      "lastUsedAt": "2024-06-15T11:00:00Z"
    }
  ]
}
```

### `DELETE /auth/api-keys/:keyId`
Revoke an API key (requires JWT token).
```
Authorization: Bearer <jwt-token>
DELETE /auth/api-keys/1
```

Returns:
```json
{
  "message": "API key revoked",
  "keyId": 1
}
```

### `GET /health`
Health check endpoint.

## Environment Variables

- `PORT` - Service port (default: 3001)
- `DB_HOST` - PostgreSQL host (default: auth-db)
- `DB_PORT` - PostgreSQL port (default: 5432)
- `DB_NAME` - Database name (default: auth)
- `DB_USER` - Database user (default: authuser)
- `DB_PASSWORD` - Database password (default: authpass)
- `JWT_SECRET` - Secret for JWT signing

## Development

```bash
npm install
npm run dev
```

## Testing

See `example.http` for HTTP client examples or `example.ps1` for PowerShell examples.

## API Key Format

API keys follow the format: `msh_<32-character-nanoid>`

Example: `msh_V1StGXR8Z5jdHi6B4myT1CxZ5dPf9eR`
