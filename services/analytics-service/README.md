# analytics-service

Collects click events from redirect-service, stores them in ClickHouse, and serves aggregated statistics to admin-service and url-service.

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for the full analytics pipeline design, ClickHouse schema, and the rationale behind all key decisions (302, at-most-once, ip_hash, 90-day TTL).

---

## Technology

- Java 21 (LTS)
- Spring Boot 3.4 (Spring Web, Spring JDBC, Spring Boot Actuator)
- ClickHouse via `clickhouse-java` JDBC driver
- Micrometer + Prometheus (metrics)
- Maven

---

## API endpoints

All endpoints require `X-Service-Token: <SERVICE_TOKEN>`.

### Ingestion (called by redirect-service)

#### `POST /events`

Ingest a single click event. Returns `202 Accepted`.

```json
{
  "slug":      "abc123",
  "ts":        "2026-06-09T12:00:00Z",
  "referrer":  "https://news.example/",
  "userAgent": "Mozilla/5.0 …",
  "ipHash":    "9f86d081…"
}
```

#### `POST /events:batch`

Ingest an array of click events. Returns `202 Accepted`. Malformed individual events are rejected; valid events in the batch are still inserted.

### Statistics (called by admin-service and url-service)

#### `GET /stats/overview`

System-wide totals: total clicks, last-7-day clicks, approximate unique visitors.

#### `GET /stats/top?limit=10&since=<ISO>`

Top slugs by click count.

#### `GET /stats/slug/{slug}?from=<ISO>&to=<ISO>`

Per-slug breakdown: totals, referrer distribution, user-agent distribution.

#### `GET /stats/timeseries?slug=<slug>&from=<ISO>&to=<ISO>&interval=day`

Time-series click data for charting.

#### `GET /stats/counts?slugs=a,b,c`

Bulk slug→click-count lookup. Used by url-service to refresh its denormalized `click_count` cache.

### Observability (Spring Boot Actuator)

| Endpoint | Purpose |
|----------|---------|
| `GET /actuator/health` | Full health (includes ClickHouse check) |
| `GET /actuator/health/liveness` | Liveness probe |
| `GET /actuator/health/readiness` | Readiness probe (fails if ClickHouse unreachable) |
| `GET /actuator/prometheus` | Prometheus metrics |

---

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SERVICE_TOKEN` | yes | — | Shared inter-service auth token |
| `CLICKHOUSE_URL` | no | `jdbc:clickhouse://clickhouse:8123/analytics` | ClickHouse JDBC URL |
| `CLICKHOUSE_USER` | no | `default` | ClickHouse user |
| `CLICKHOUSE_PASSWORD` | yes | — | ClickHouse password |
| `PORT` | no | `3005` | HTTP port |

---

## Development

```bash
cd services/analytics-service

# Compile and run tests
mvn verify

# Run locally (requires a running ClickHouse instance)
mvn spring-boot:run

# Build Docker image only
docker build -t microshort-analytics:dev .
```

Maven skips TLS verification (`-Dmaven.wagon.http.ssl.insecure=true`) for environments behind a corporate SSL proxy.

---

## Docker

Multi-stage Dockerfile: Maven build + tests → slim Temurin JRE 21 runtime. Runs as `appuser` (non-root).

```bash
# From repo root:
docker compose up -d --build analytics-service
```

ClickHouse schema is auto-applied on first boot via the init SQL mounted at `/docker-entrypoint-initdb.d/` in the ClickHouse container. See `services/analytics-service/clickhouse-init/`.
