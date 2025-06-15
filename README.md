# microshort

A lightweight, containerized URL shortener platform built using modern microservices.

## Project Overview

The **microshort** system provides basic URL shortening capabilities as a modular, extensible platform. It includes services for URL creation, redirection, analytics, authentication, administration, and configuration management.

### Core Features

* Short URL creation with optional custom slugs
* Fast redirection handler
* Analytics tracking of clicks and referrers
* API key-based authentication
* Admin endpoints for link and user management
* Configuration service for shared system-wide settings

## Microservices Architecture

| Service           | Language             | Description                                                                                      |
| ----------------- | -------------------- | ------------------------------------------------------------------------------------------------ |
| config-service    | Node.js / TypeScript | Provides shared configuration settings (e.g., domain). Serves JSON-based config via REST.        |
| auth-service      | Node.js              | User authentication and API key management. PostgreSQL storage with JWT tokens.                  |
| url-service       | Python               | Handles business logic for slug generation, URL validation, and storage in MySQL.                |
| redirect-service  | C++                  | Highly efficient redirection layer for resolving short URLs and forwarding requests.             |
| analytics-service | Java                 | Collects and processes click logs. Stores data in MongoDB and provides aggregated statistics.    |
| admin-service     | Go                   | Exposes management APIs for reviewing users, links, and analytics. Lightweight and concurrent.   |

## Request Flow Example

1. A user registers using `auth-service` and receives an API key
2. The user submits a long URL to `url-service` and gets back a short URL, such as `https://sho.rt/abc123`
3. A client accesses the short URL, which triggers a redirect by `redirect-service`
4. The redirect is logged by `analytics-service`
5. Admins query data using `admin-service`

## Configuration

All services retrieve shared settings from the `config-service`. Services are configured using an environment variable:

```env
CONFIG_SERVICE_URL=http://config-service:3000
```

This ensures flexibility across environments and allows services to locate the domain name and other global parameters.

## Development Environment

* The project includes a `compose.yml` file to start all services
* Configuration values are loaded via a shared `.env` file
* Service discovery is handled by internal DNS in Docker or Kubernetes

## Quick Start

```bash
# Linux/Mac
chmod +x quickstart.sh
./quickstart.sh

# Windows PowerShell
.\quickstart.ps1

# Or manually:
docker compose up -d
```

The quickstart scripts will:
- Build and start all services
- Wait for services to be healthy
- Display service URLs
- Show example API commands

To stop services:
```bash
docker compose down
```

To view logs:
```bash
docker compose logs -f
```

## Services

### Config Service
- **Port**: 3000
- **Docs**: http://localhost:3000/docs
- **Purpose**: Provides shared configuration (domain, etc.)

### Auth Service
- **Port**: 3001
- **Purpose**: User registration, login, API key management
- **Storage**: PostgreSQL
- **Features**:
  - JWT-based authentication
  - API key generation with format: `msh_<32-char-nanoid>`
  - User management endpoints

## Testing

* Unit and integration tests for individual services
* Health check endpoints for container readiness

## Possible Future Features

* Web frontend for user interaction
* Notification hooks (e.g., Slack, email)
* Admin-editable configuration via the config-service

---

This project is designed as a practical platform to explore microservice architecture, DevOps workflows, and cloud deployment patterns.