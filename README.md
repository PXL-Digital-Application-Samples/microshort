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

| Service           | Language             | Description                                                                                    |
| ----------------- | -------------------- | ---------------------------------------------------------------------------------------------- |
| config-service    | Node.js / TypeScript | Provides shared configuration settings (e.g., domain). Serves JSON-based config via REST.      |
| auth-service      | Node.js              | Manages user authentication and API key issuance. Uses JWT and simple REST endpoints.          |
| url-service       | Python               | Handles business logic for slug generation, URL validation, and storage in MySQL.              |
| redirect-service  | C++                  | Highly efficient redirection layer for resolving short URLs and forwarding requests.           |
| analytics-service | Java                 | Collects and processes click logs. Stores data in MongoDB and provides aggregated statistics.  |
| admin-service     | Go                   | Exposes management APIs for reviewing users, links, and analytics. Lightweight and concurrent. |

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

## Directory Structure

```
microshort/
├── compose.yml
├── .env
└── services/
    ├── config-service/      # Node.js / TypeScript
    ├── auth-service/        # Node.js
    ├── url-service/         # Python
    ├── redirect-service/    # C++
    ├── analytics-service/   # Java
    └── admin-service/       # Go
```

## Possible Future Features

* Web frontend for user interaction
* Notification hooks (e.g., Slack, email)
* Admin-editable configuration via the config-service

## Testing

* Unit and integration tests for individual services
* Health check endpoints for container readiness

---

This project is designed as a practical platform to explore microservice architecture, DevOps workflows, and cloud deployment patterns.
