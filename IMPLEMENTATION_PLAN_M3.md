# Implementation Plan — M3: Analytics-service (Java + ClickHouse)

> Companion to [PLANNING.md](./PLANNING.md) (§5 → M3 and §6) and
> [CODE_REVIEW.md](./CODE_REVIEW.md). This document turns the M3 milestone into a
> concrete, file-level work plan. **M2 is a prerequisite** (role model, key
> hashing, rate limiting, `CONFIG_WRITE_TOKEN`). M3's goal: _"stand up the new
> analytics-service and rewire click tracking around it."_ All design decisions
> are finalised in PLANNING.md §6.1; this document implements them.

---

## 0. Scope

M3 resolves exactly these findings and PLANNING.md items:

| # | Tag | Finding / Item | Workstream |
|---|-----|----------------|------------|
| CR 3.1 | 🔴 | Clicks counted on lookup (not on visit); cache hides most visits | **F** |
| CR 3.2 | 🟡 | `url_analytics` table defined but never written; `logRedirect` is a stub | **E** |
| CR 3.3 | 🔵 | 301 permanent redirects break analytics | **E** |
| PLAN §6.2 | — | Scaffold analytics-service (Spring Boot 3.x / Java 21 / Maven, port 3005) | **A** |
| PLAN §6.5 | — | ClickHouse schema: raw `clicks` table + `clicks_daily` aggregating rollup | **B** |
| PLAN §6.3 | — | Ingestion API (`POST /events`, `POST /events:batch`) | **C** |
| PLAN §6.3 | — | Stats query API (overview / top / slug / timeseries / counts) | **D** |
| PLAN §6.6 | — | redirect-service: 302 + `Cache-Control: no-store`, edge `ip_hash`, buffered emit | **E** |
| PLAN §6.6 | — | url-service: drop `incrementClicks` from hot path; add scheduled sync | **F** |
| PLAN §6.6 | — | admin-service dashboard sources click metrics from analytics-service | **G** |
| PLAN §6.6/6.7 | — | compose + `.env`: analytics-service + ClickHouse containers, `SERVICE_TOKEN`, `IP_HASH_SALT` | **H** |
| PLAN §6.7 | — | `mvn verify` CI job + M3 integration tests | **I** |

Explicitly **not** in M3 (do not creep):

- Liveness/readiness split for Node services, structured logging, Prometheus metrics for
  Node services, graceful shutdown, shared Redis cache → M4. *(analytics-service gets
  Actuator health + Prometheus for free from Spring Boot; that is in scope. The Node
  services do not gain observability in this milestone.)*
- Config backing store, `.env` → secrets injection, HMAC-SHA256 key hardening → M5.
- Admin UI runtime config, CDN vendoring, camelCase normalisation (CR 4.2) → M6.
- Doc reconciliation, compose-file collapse → M7.

### Decisions locked for this plan

1. **Spring Boot version — 3.5.x (latest stable 3.x GA).** Check
   [spring.io/projects/spring-boot](https://spring.io/projects/spring-boot) for the
   current patch at time of implementation; the pom.xml `<parent>` version pin should
   match the latest `3.5.x` GA. Spring Boot 4.1 is in milestone and deliberately
   skipped (aligns with PLANNING §6.1 decision 4).
2. **clickhouse-java JDBC — `com.clickhouse:clickhouse-jdbc:0.9.8`, `all`
   classifier.** The `all` shaded jar bundles all transitive dependencies and avoids
   version conflicts with Spring Boot's managed deps. The JDBC URL prefix is
   `jdbc:clickhouse://`.
3. **ClickHouse server image — `clickhouse/clickhouse-server:26.3`.** The 26.3 branch
   is the current LTS track (26.3.x); use it for teaching stability. The
   `clickhouse/clickhouse-server:latest` tag tracks non-LTS releases and should be
   avoided.
4. **Java 21 everywhere.** Docker images use `maven:3.9-eclipse-temurin-21` (build)
   and `eclipse-temurin:21-jre-noble` (runtime). Locally, Java 21 is installed at
   `/usr/lib/jvm/java-21-openjdk`; activate it once per shell session:
   ```bash
   export JAVA_HOME=/usr/lib/jvm/java-21-openjdk
   export PATH=$JAVA_HOME/bin:$PATH
   ```
   This is only needed for running `mvn` outside Docker. CI uses
   `actions/setup-java@v4` with `distribution: temurin, java-version: 21`.
5. **Corporate SSL proxy in Docker.** Maven dependency downloads inside Docker hit the
   same corporate SSL inspection proxy that required `npm config set strict-ssl false`
   in M1. The Dockerfile build stage passes
   `-Dmaven.wagon.http.ssl.insecure=true -Dmaven.wagon.http.ssl.allowall=true` to all
   `mvn` invocations. These flags are harmless on CI (GitHub public runners have no
   proxy); they can be removed per-environment if not needed.
6. **AMT schema correction (deviates from PLANNING §6.5).** PLANNING §6.5 declares
   `clicks_daily.clicks UInt64` fed by `count() AS clicks`. In an
   `AggregatingMergeTree`, plain numeric columns are **not** merged during background
   part merges — only `AggregateFunction` and `SimpleAggregateFunction` columns are.
   The plan corrects this to `SimpleAggregateFunction(sum, UInt64)`. `count()` produces
   a `UInt64` that is stored as-is; during merges ClickHouse sums the values.
   Querying uses `sum(clicks)` (not a `-Merge` combinator). The `uniq_visitors`
   column uses `AggregateFunction(uniq, FixedString(64))` with `uniqState` / `uniqMerge`,
   which is correct as specified.
7. **url-service `clicks` column name is preserved.** PLANNING §6.1 says "repurpose
   `clicks` → `click_count` as a cache." This plan keeps the column named `clicks`
   (no schema rename) to minimise breakage: the semantics change (periodic sync
   instead of increment-on-lookup) but the column name, existing queries, and the
   url-service response shape (`"clicks": 42`) remain identical. A rename is a
   breaking schema change for no user-facing benefit.
8. **`ip_hash` uses `req.ip` in redirect-service.** In a bare Docker Compose setup
   without a reverse proxy in front, `req.ip` is the Docker bridge gateway IP — all
   hashes will be identical. The mechanism is correct; the limitation is the
   missing proxy layer, which M4 addresses when a shared cache / proxy is added.
   `app.set('trust proxy', 1)` is added to redirect-service now so it is proxy-ready,
   but it has no effect without an actual proxy.
9. **`url_analytics` MySQL table is dropped.** It was defined in M0 and has never
   been written. Dropping it in M3 is the correct cleanup per PLANNING §6.5: "This
   supersedes the unused `url_analytics` table." This is a breaking schema change —
   existing databases must be recreated (`docker compose down -v && docker compose
   up -d`).
10. **Service token stays plaintext in `.env`.** Consistent with the M2
    `CONFIG_WRITE_TOKEN` pattern: plaintext in `.env` for local dev, loud comments
    everywhere, hardened in M5.

---

## 1. Current-state facts this plan relies on

Verified against the working tree (post-M2):

- `redirect-service/src/index.js:123` — `res.redirect(301, redirectUrl)` → must
  change to `302`.
- `redirect-service/src/index.js:127-130` — `logRedirect()` is a `console.log` stub;
  no `app.set('trust proxy', 1)`; no `ANALYTICS_SERVICE_URL` env var; no `SERVICE_TOKEN`.
- `url-service/src/index.js:145-147` — `incrementClicks(urlRecord.id).catch(...)` is
  called inside `GET /urls/:slug`; this is the write-on-lookup bug (CR 3.1).
- `url-service/src/db.js:58-63` — `incrementClicks(urlId)` does
  `UPDATE urls SET clicks = clicks + 1 WHERE id = ?`.
- `url-service/src/db.js:1` — imports from `mysql2/promise`; no `ANALYTICS_SERVICE_URL`.
- `url-service/init/01-schema.sql:16-26` — `url_analytics` table defined, never
  written, to be dropped.
- `admin-service/src/index.js:54-92` — `/admin/dashboard` calls auth-service
  `/admin/stats` and url-service `/admin/stats` in parallel; click data comes from
  url-service; no analytics-service call; no `ANALYTICS_SERVICE_URL` or `SERVICE_TOKEN`.
- `tests/integration/happy-path.test.js` — asserts `expect(res.status).toBe(301)`;
  must change to `302` and add `Cache-Control: no-store` assertion.
- `tests/integration/setup.js` — health-polls 5 services; must add analytics-service
  on port 3005.
- `tests/integration/helpers.js` — `BASE` object has 5 entries; `analytics` missing.
- `compose.yml:165-169` — analytics block is commented out; ClickHouse container
  absent; no `analytics-db-data` volume.
- `compose-simple.yml` — same; analytics and ClickHouse absent.
- `.env` — no `SERVICE_TOKEN`, no `IP_HASH_SALT`, no `CLICKHOUSE_PASSWORD`.
- `services/analytics-service/` — **does not exist**. Workstream A creates it
  from scratch.
- `.github/workflows/` — `config-service.yml`, `services.yml` exist; no
  `analytics-service.yml` or `integration.yml`.

---

## 2. Workstreams

### A — Scaffold analytics-service (PLAN §6.2)

**New directory:** `services/analytics-service/`

This creates the full Maven project from scratch: `pom.xml`, source tree, Dockerfile.

#### A1 — Directory structure

```
services/analytics-service/
├── Dockerfile
├── pom.xml
├── clickhouse-init/
│   └── 01-schema.sql          ← created in workstream B
└── src/
    ├── main/
    │   ├── java/be/pxl/microshort/analytics/
    │   │   ├── AnalyticsApplication.java
    │   │   ├── config/
    │   │   │   └── ServiceTokenFilter.java
    │   │   ├── controller/
    │   │   │   ├── EventController.java
    │   │   │   └── StatsController.java
    │   │   ├── model/
    │   │   │   └── ClickEvent.java
    │   │   └── repository/
    │   │       └── ClickHouseRepository.java
    │   └── resources/
    │       └── application.properties
    └── test/
        ├── java/be/pxl/microshort/analytics/
        │   └── AnalyticsApplicationTests.java
        └── resources/
            └── application.properties   ← disables DataSource for unit tests
```

#### A2 — `pom.xml`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>

  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.5.0</version>  <!-- pin to latest 3.5.x GA at implementation time -->
    <relativePath/>
  </parent>

  <groupId>be.pxl.microshort</groupId>
  <artifactId>analytics-service</artifactId>
  <version>0.1.0-SNAPSHOT</version>
  <name>analytics-service</name>

  <properties>
    <java.version>21</java.version>
    <clickhouse-jdbc.version>0.9.8</clickhouse-jdbc.version>
  </properties>

  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-jdbc</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-actuator</artifactId>
    </dependency>
    <dependency>
      <groupId>io.micrometer</groupId>
      <artifactId>micrometer-registry-prometheus</artifactId>
    </dependency>
    <!-- ClickHouse JDBC — all-in-one shaded jar, no transitive conflicts -->
    <dependency>
      <groupId>com.clickhouse</groupId>
      <artifactId>clickhouse-jdbc</artifactId>
      <version>${clickhouse-jdbc.version}</version>
      <classifier>all</classifier>
      <exclusions>
        <exclusion><groupId>*</groupId><artifactId>*</artifactId></exclusion>
      </exclusions>
    </dependency>

    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-test</artifactId>
      <scope>test</scope>
    </dependency>
  </dependencies>

  <build>
    <plugins>
      <plugin>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-maven-plugin</artifactId>
      </plugin>
    </plugins>
  </build>
</project>
```

> **Shaded-jar note.** The `classifier>all</classifier>` + blanket `<exclusions>`
> pattern tells Maven to use only the shaded jar and ignore transitive deps declared
> in the POM — exactly how the driver is documented for use in environments with
> potential classpath conflicts.

#### A3 — `src/main/resources/application.properties`

```properties
server.port=${PORT:3005}

# ClickHouse DataSource — HTTP interface (8123)
spring.datasource.url=${CLICKHOUSE_URL:jdbc:clickhouse://clickhouse:8123/analytics}
spring.datasource.driver-class-name=com.clickhouse.jdbc.ClickHouseDriver
spring.datasource.username=${CLICKHOUSE_USER:default}
spring.datasource.password=${CLICKHOUSE_PASSWORD:}
spring.datasource.hikari.connection-test-query=SELECT 1
spring.datasource.hikari.maximum-pool-size=5

# Actuator — expose health (probes) and Prometheus metrics
management.endpoints.web.exposure.include=health,prometheus
management.endpoint.health.probes.enabled=true
management.health.livenessstate.enabled=true
management.health.readinessstate.enabled=true
# Include the DataSource (ClickHouse) check in the readiness probe
management.endpoint.health.group.readiness.include=readinessState,db
management.endpoint.health.show-details=always

# Service token (validated in ServiceTokenFilter)
service.token=${SERVICE_TOKEN:dev-service-token-change-in-production}
```

#### A4 — `src/test/resources/application.properties`

This disables the DataSource auto-configuration so unit tests run without a live
ClickHouse:

```properties
spring.autoconfigure.exclude=\
  org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration,\
  org.springframework.boot.autoconfigure.jdbc.DataSourceTransactionManagerAutoConfiguration

service.token=test-token
```

#### A5 — `AnalyticsApplication.java`

```java
package be.pxl.microshort.analytics;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class AnalyticsApplication {
    public static void main(String[] args) {
        SpringApplication.run(AnalyticsApplication.class, args);
    }
}
```

#### A6 — `config/ServiceTokenFilter.java`

Protects all non-Actuator paths with `X-Service-Token`:

```java
package be.pxl.microshort.analytics.config;

import jakarta.servlet.*;
import jakarta.servlet.http.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

@Component
public class ServiceTokenFilter extends OncePerRequestFilter {

    @Value("${service.token}")
    private String serviceToken;

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res,
                                    FilterChain chain) throws ServletException, IOException {
        if (req.getRequestURI().startsWith("/actuator")) {
            chain.doFilter(req, res);
            return;
        }
        String token = req.getHeader("X-Service-Token");
        if (serviceToken == null || !serviceToken.equals(token)) {
            res.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
            res.setContentType("application/json");
            res.getWriter().write("{\"error\":\"Unauthorized\"}");
            return;
        }
        chain.doFilter(req, res);
    }
}
```

> `/actuator/**` is excluded so compose healthchecks and Prometheus scraping work
> without the service token. These endpoints are internal-only by virtue of being
> inside the Docker network; no additional auth is required here.

#### A7 — `model/ClickEvent.java`

```java
package be.pxl.microshort.analytics.model;

import java.time.Instant;

public record ClickEvent(
    String slug,
    Instant ts,
    String referrer,
    String userAgent,
    String ipHash
) {}
```

#### A8 — `src/test/java/.../AnalyticsApplicationTests.java`

```java
package be.pxl.microshort.analytics;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;

@SpringBootTest
class AnalyticsApplicationTests {
    @Test
    void contextLoads() {
        // Spring context loads without ClickHouse (DataSource disabled in test properties)
    }
}
```

#### A9 — `Dockerfile`

Multi-stage build: Maven + JDK 21 build stage → slim JRE 21 runtime. SSL proxy
bypass flags are applied to all `mvn` commands (harmless on CI/public runners):

```dockerfile
# --- Build stage ---
FROM maven:3.9-eclipse-temurin-21 AS builder
WORKDIR /build

# Resolve dependencies first (layer cached unless pom.xml changes)
COPY pom.xml .
RUN mvn -B dependency:go-offline --no-transfer-progress \
    -Dmaven.wagon.http.ssl.insecure=true \
    -Dmaven.wagon.http.ssl.allowall=true

COPY src ./src
RUN mvn -B package -DskipTests --no-transfer-progress \
    -Dmaven.wagon.http.ssl.insecure=true \
    -Dmaven.wagon.http.ssl.allowall=true

# --- Runtime stage ---
FROM eclipse-temurin:21-jre-noble
WORKDIR /app

# curl is required for the compose healthcheck probe.
# eclipse-temurin:21-jre-noble (Ubuntu 24.04) does not ship curl by default.
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --system appgroup && \
    useradd --system --gid appgroup --no-create-home appuser

COPY --from=builder /build/target/analytics-service-*.jar app.jar

USER appuser
EXPOSE 3005
ENTRYPOINT ["java", "-jar", "app.jar"]
```

> **Layer caching.** The `COPY pom.xml` + `dependency:go-offline` layer is cached
> separately from `COPY src`. Rebuilding after a source-only change skips the
> dependency download step — important because the SSL proxy makes Maven downloads
> slow locally.

**Verify workstream A:**
- `cd services/analytics-service && mvn -B verify` (with Java 21 active) → passes.
- `docker build -t microshort-analytics:ci services/analytics-service` → image builds.

---

### B — ClickHouse schema + container (PLAN §6.5)

**New file:** `services/analytics-service/clickhouse-init/01-schema.sql`

```sql
-- Create analytics database
CREATE DATABASE IF NOT EXISTS analytics;

-- Raw click events: append-only, TTL 90 days
CREATE TABLE IF NOT EXISTS analytics.clicks (
    slug       String,
    ts         DateTime,
    referrer   String,
    user_agent String,
    ip_hash    FixedString(64)
) ENGINE = MergeTree
ORDER BY (slug, ts)
TTL ts + INTERVAL 90 DAY;

-- Daily rollup: retained indefinitely, fed by the materialized view below
CREATE TABLE IF NOT EXISTS analytics.clicks_daily (
    slug          String,
    day           Date,
    -- SimpleAggregateFunction: stored as plain UInt64, summed during part merges.
    -- Correction to PLANNING §6.5 which used bare UInt64 (not aggregated by AMT).
    clicks        SimpleAggregateFunction(sum, UInt64),
    uniq_visitors AggregateFunction(uniq, FixedString(64))
) ENGINE = AggregatingMergeTree
ORDER BY (slug, day);

-- Materialized view: fires on every INSERT into clicks, routes partial state to clicks_daily
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.clicks_daily_mv
TO analytics.clicks_daily AS
SELECT
    slug,
    toDate(ts)         AS day,
    count()            AS clicks,       -- UInt64; feeds SimpleAggregateFunction(sum)
    uniqState(ip_hash) AS uniq_visitors -- partial state; feeds AggregateFunction(uniq)
FROM analytics.clicks
GROUP BY slug, day;
```

> **Query pattern.** Because `clicks` is `SimpleAggregateFunction(sum, UInt64)`,
> always aggregate it in queries: `SELECT slug, sum(clicks) FROM analytics.clicks_daily
> GROUP BY slug`. Reading without aggregation may return partial-part values before
> a background merge runs.

> **Schema deviation note.** Inform the maintainer that PLANNING §6.5's
> `clicks UInt64` has been corrected to `SimpleAggregateFunction(sum, UInt64)`.
> The SQL file is the authoritative schema; PLANNING §6.5 may be updated in M7's
> doc reconciliation pass.

The ClickHouse container is added to compose in workstream H.

---

### C — Ingestion API (PLAN §6.3)

**File:** `services/analytics-service/src/main/java/.../controller/EventController.java`

```java
package be.pxl.microshort.analytics.controller;

import be.pxl.microshort.analytics.model.ClickEvent;
import be.pxl.microshort.analytics.repository.ClickHouseRepository;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
public class EventController {

    private final ClickHouseRepository repository;

    public EventController(ClickHouseRepository repository) {
        this.repository = repository;
    }

    // Single event
    @PostMapping("/events")
    public ResponseEntity<Void> ingest(@RequestBody ClickEvent event) {
        repository.insertBatch(List.of(event));
        return ResponseEntity.accepted().build();
    }

    // Batch of events (primary path from redirect-service)
    @PostMapping("/events:batch")
    public ResponseEntity<Void> ingestBatch(@RequestBody List<ClickEvent> events) {
        if (events == null || events.isEmpty()) {
            return ResponseEntity.badRequest().build();
        }
        repository.insertBatch(events);
        return ResponseEntity.accepted().build();
    }
}
```

Both endpoints return `202 Accepted`; redirect-service ignores the response
(fire-and-forget). Malformed JSON returns `400` via Spring's default `HttpMessageNotReadableException` handler.

> **Colon-in-path note.** `@PostMapping("/events:batch")` is RFC-legal and Spring's
> `PathPatternParser` treats it as a literal path. Verify this works end-to-end with
> `curl -X POST http://localhost:3005/events:batch -H 'X-Service-Token: ...' -H 'Content-Type: application/json' -d '[]'`
> and confirm you get `400` (empty list) rather than `404`. If Tomcat rejects the
> colon (has happened in older versions), the fallback is to rename the path to
> `/events/batch` and update the `flushEvents` URL in redirect-service to match.

---

### D — Stats query API (PLAN §6.3)

**File:** `services/analytics-service/src/main/java/.../repository/ClickHouseRepository.java`

```java
package be.pxl.microshort.analytics.repository;

import be.pxl.microshort.analytics.model.ClickEvent;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

@Repository
public class ClickHouseRepository {

    private final JdbcTemplate jdbc;

    public ClickHouseRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public void insertBatch(List<ClickEvent> events) {
        String sql = "INSERT INTO analytics.clicks (slug, ts, referrer, user_agent, ip_hash) VALUES (?, ?, ?, ?, ?)";
        jdbc.batchUpdate(sql, events, events.size(), (ps, event) -> {
            ps.setString(1, event.slug());
            ps.setTimestamp(2, Timestamp.from(event.ts() != null ? event.ts() : Instant.now()));
            ps.setString(3, event.referrer() != null ? event.referrer() : "");
            ps.setString(4, event.userAgent() != null ? event.userAgent() : "");
            ps.setString(5, event.ipHash() != null ? event.ipHash() : "");
        });
    }

    public Map<String, Object> getOverview() {
        Map<String, Object> totals = jdbc.queryForMap(
            "SELECT sum(clicks) AS totalClicks, uniqMerge(uniq_visitors) AS approxUniqueVisitors " +
            "FROM analytics.clicks_daily"
        );
        Map<String, Object> recent = jdbc.queryForMap(
            "SELECT sum(clicks) AS last7DayClicks FROM analytics.clicks_daily " +
            "WHERE day >= today() - 7"
        );
        totals.put("last7DayClicks", recent.get("last7DayClicks"));
        return totals;
    }

    public List<Map<String, Object>> getTop(int limit, String since) {
        if (since != null && !since.isBlank()) {
            return jdbc.queryForList(
                "SELECT slug, sum(clicks) AS totalClicks FROM analytics.clicks_daily " +
                "WHERE day >= toDate(?) GROUP BY slug ORDER BY totalClicks DESC LIMIT ?",
                since, limit
            );
        }
        return jdbc.queryForList(
            "SELECT slug, sum(clicks) AS totalClicks FROM analytics.clicks_daily " +
            "GROUP BY slug ORDER BY totalClicks DESC LIMIT ?",
            limit
        );
    }

    public Map<String, Object> getSlugStats(String slug, String from, String to) {
        String sql = "SELECT sum(clicks) AS totalClicks, uniqMerge(uniq_visitors) AS uniqueVisitors " +
            "FROM analytics.clicks_daily WHERE slug = ? AND day BETWEEN toDate(?) AND toDate(?)";
        Map<String, Object> stats = jdbc.queryForMap(sql, slug, from, to);

        List<Map<String, Object>> referrers = jdbc.queryForList(
            "SELECT referrer, count() AS clicks FROM analytics.clicks " +
            "WHERE slug = ? AND ts BETWEEN ? AND ? GROUP BY referrer ORDER BY clicks DESC LIMIT 20",
            slug, from, to
        );
        List<Map<String, Object>> userAgents = jdbc.queryForList(
            "SELECT user_agent AS userAgent, count() AS clicks FROM analytics.clicks " +
            "WHERE slug = ? AND ts BETWEEN ? AND ? GROUP BY user_agent ORDER BY clicks DESC LIMIT 10",
            slug, from, to
        );
        stats.put("slug", slug);
        stats.put("referrers", referrers);
        stats.put("userAgents", userAgents);
        return stats;
    }

    public List<Map<String, Object>> getTimeseries(String slug, String from, String to) {
        return jdbc.queryForList(
            "SELECT day, sum(clicks) AS clicks, uniqMerge(uniq_visitors) AS uniqueVisitors " +
            "FROM analytics.clicks_daily WHERE slug = ? AND day BETWEEN toDate(?) AND toDate(?) " +
            "GROUP BY day ORDER BY day",
            slug, from, to
        );
    }

    /** Bulk slug → click count map. Slugs absent from the rollup return 0. */
    public Map<String, Long> getCounts(List<String> slugs) {
        if (slugs.isEmpty()) return Map.of();
        String placeholders = slugs.stream().map(s -> "?").collect(Collectors.joining(","));
        List<Map<String, Object>> rows = jdbc.queryForList(
            "SELECT slug, sum(clicks) AS cnt FROM analytics.clicks_daily " +
            "WHERE slug IN (" + placeholders + ") GROUP BY slug",
            slugs.toArray()
        );
        Map<String, Long> result = slugs.stream()
            .collect(Collectors.toMap(s -> s, s -> 0L));
        rows.forEach(r -> result.put((String) r.get("slug"),
            ((Number) r.get("cnt")).longValue()));
        return result;
    }
}
```

**File:** `services/analytics-service/src/main/java/.../controller/StatsController.java`

```java
package be.pxl.microshort.analytics.controller;

import be.pxl.microshort.analytics.repository.ClickHouseRepository;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Arrays;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/stats")
public class StatsController {

    private final ClickHouseRepository repository;

    public StatsController(ClickHouseRepository repository) {
        this.repository = repository;
    }

    @GetMapping("/overview")
    public ResponseEntity<Map<String, Object>> overview() {
        return ResponseEntity.ok(repository.getOverview());
    }

    @GetMapping("/top")
    public ResponseEntity<List<Map<String, Object>>> top(
        @RequestParam(defaultValue = "10") int limit,
        @RequestParam(required = false) String since
    ) {
        return ResponseEntity.ok(repository.getTop(limit, since));
    }

    @GetMapping("/slug/{slug}")
    public ResponseEntity<Map<String, Object>> slug(
        @PathVariable String slug,
        @RequestParam(defaultValue = "1970-01-01") String from,
        @RequestParam(defaultValue = "2099-12-31") String to
    ) {
        return ResponseEntity.ok(repository.getSlugStats(slug, from, to));
    }

    @GetMapping("/timeseries")
    public ResponseEntity<?> timeseries(
        @RequestParam String slug,
        @RequestParam(defaultValue = "1970-01-01") String from,
        @RequestParam(defaultValue = "2099-12-31") String to
    ) {
        return ResponseEntity.ok(repository.getTimeseries(slug, from, to));
    }

    @GetMapping("/counts")
    public ResponseEntity<Map<String, Long>> counts(@RequestParam String slugs) {
        List<String> slugList = Arrays.stream(slugs.split(","))
            .map(String::trim)
            .filter(s -> !s.isBlank())
            .toList();
        return ResponseEntity.ok(repository.getCounts(slugList));
    }
}
```

All stats endpoints require the `X-Service-Token` header (enforced by
`ServiceTokenFilter`). Default date bounds (`1970-01-01` / `2099-12-31`) return
all-time data when no window is specified.

**Verify workstreams C + D:**
- `POST /events:batch` with valid token and a JSON array → `202`.
- `POST /events:batch` without token → `401`.
- `GET /stats/overview` with token → `200` with `totalClicks`, `approxUniqueVisitors`,
  `last7DayClicks`.
- `GET /stats/counts?slugs=abc,xyz` with token → `200` `{"abc": 0, "xyz": 0}` (no
  data yet) or real counts after events are inserted.

---

### E — redirect-service rewire (CR 3.2, 3.3; PLAN §6.6)

**File:** `redirect-service/src/index.js`

Three changes: 302 + `Cache-Control: no-store`; edge `ip_hash`; buffered
fire-and-forget emit.

#### E1 — New env vars + trust proxy

Add at the top of `index.js` (after the existing `URL_SERVICE_URL` line):

```js
const ANALYTICS_SERVICE_URL = process.env.ANALYTICS_SERVICE_URL || 'http://analytics-service:3005';
const SERVICE_TOKEN         = process.env.SERVICE_TOKEN          || '';
const IP_HASH_SALT          = process.env.IP_HASH_SALT           || 'dev-ip-hash-salt-change-in-production';
const ANALYTICS_BATCH_SIZE  = parseInt(process.env.ANALYTICS_BATCH_SIZE  ?? '50');
const ANALYTICS_FLUSH_MS    = parseInt(process.env.ANALYTICS_FLUSH_MS    ?? '5000');

// Enable trust proxy so req.ip reflects the real client when behind a proxy (M4).
// In bare Compose without a proxy, req.ip is the Docker bridge gateway; the
// ip_hash mechanism is correct but all events will share the same hash.
app.set('trust proxy', 1);
```

Add the crypto import near the top (Node built-in, no new dependency):

```js
import { createHash } from 'crypto';
```

#### E2 — ip_hash helper

```js
function hashIp(ip) {
  return createHash('sha256').update((ip || '0.0.0.0') + IP_HASH_SALT).digest('hex');
}
```

#### E3 — Event buffer + flush

```js
const eventBuffer = [];

function bufferEvent(slug, userAgent, referer, ip) {
  eventBuffer.push({
    slug,
    ts:        new Date().toISOString(),
    referrer:  referer    || '',
    userAgent: userAgent  || '',
    ipHash:    hashIp(ip)
  });
  if (eventBuffer.length >= ANALYTICS_BATCH_SIZE) flushEvents();
}

function flushEvents() {
  if (eventBuffer.length === 0) return;
  const batch = eventBuffer.splice(0);
  fetch(`${ANALYTICS_SERVICE_URL}/events:batch`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Service-Token': SERVICE_TOKEN },
    body:    JSON.stringify(batch),
    signal:  AbortSignal.timeout(5000)
  }).catch(err => console.error('Analytics flush failed:', err));
  // Response is intentionally ignored — fire-and-forget, at-most-once semantics.
}

setInterval(flushEvents, ANALYTICS_FLUSH_MS);
```

`eventBuffer.splice(0)` atomically drains the buffer into a local array before the
async fetch, so concurrent flushes do not double-emit the same events.

#### E4 — Redirect handler: 302, `Cache-Control`, and emit

Replace the existing redirect handler's last two lines (the `logRedirect` call and
`res.redirect(301, ...)`):

```js
  // Was: logRedirect(slug, ...).catch(...) + res.redirect(301, redirectUrl)
  bufferEvent(slug, req.headers['user-agent'], req.headers['referer'], req.ip);
  res.set('Cache-Control', 'no-store');
  res.redirect(302, redirectUrl);
```

#### E5 — Remove the old `logRedirect` function entirely

Delete lines 126-130 (`async function logRedirect(...) { console.log(...) }`).

**Verify workstream E:**
- `curl -I http://localhost:8080/<slug>` → `302 Found`, `Cache-Control: no-store`.
- Wait ≤5 s; `GET /stats/counts?slugs=<slug>` on analytics-service (with token) →
  count increments.
- `GET /actuator/health/readiness` on analytics-service → `200` (ClickHouse reachable).

---

### F — url-service rewire (CR 3.1; PLAN §6.6)

**Files:** `url-service/src/index.js`, `url-service/src/db.js`,
`url-service/init/01-schema.sql`

#### F1 — `init/01-schema.sql`: drop `url_analytics`

Remove the entire `url_analytics` table definition and its foreign key from
`01-schema.sql`. The raw clicks data now lives in ClickHouse exclusively.

> **Breaking schema change.** Existing databases must be recreated:
> `docker compose down -v && docker compose up -d --build`.
> Add a `NOTE` comment at the top of the file (like the M2 `api_keys` note):
> ```sql
> -- NOTE (M3): url_analytics table removed. Existing databases must be recreated.
> -- Run: docker compose down -v && docker compose up -d
> ```

#### F2 — `db.js`: remove `incrementClicks`, add `updateClickCount`

Remove the `incrementClicks` function. Add:

```js
// Updates the eventually-consistent click count cache. Called by the
// scheduled analytics sync job, not on the request hot path.
export async function updateClickCount(slug, count) {
  await pool.execute(
    'UPDATE urls SET clicks = ? WHERE slug = ?',
    [count, slug]
  );
}
```

Remove `incrementClicks` from all exports.

#### F3 — `index.js`: add env vars + scheduled sync, remove increment call

Add near the top (after `CONFIG_SERVICE_URL`):

```js
const ANALYTICS_SERVICE_URL = process.env.ANALYTICS_SERVICE_URL || 'http://analytics-service:3005';
const SERVICE_TOKEN         = process.env.SERVICE_TOKEN          || '';
const CLICK_SYNC_INTERVAL_MS = parseInt(process.env.CLICK_SYNC_INTERVAL_MS ?? '60000');
```

Update the import from db.js — replace `incrementClicks` with `updateClickCount`:

```js
import { createUrl, getUrlBySlug, getUserUrls, deleteUrl,
         updateClickCount, getAllUrls, getUrlStats } from './db.js';
```

In `GET /urls/:slug`, remove the `incrementClicks` call:

```js
// Before (remove these three lines):
incrementClicks(urlRecord.id).catch(err =>
  console.error('Failed to increment clicks:', err)
);

// After: nothing — clicks are tracked by analytics-service via redirect events.
```

Add the scheduled sync job at the bottom of `index.js` (before `app.listen`):

```js
async function syncClickCounts() {
  try {
    const [rows] = await pool.execute('SELECT slug FROM urls');
    if (rows.length === 0) return;

    const slugs = rows.map(r => r.slug).join(',');
    const res = await fetch(
      `${ANALYTICS_SERVICE_URL}/stats/counts?slugs=${encodeURIComponent(slugs)}`,
      { headers: { 'X-Service-Token': SERVICE_TOKEN }, signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return;

    const counts = await res.json(); // { slug: count, ... }
    await Promise.all(
      Object.entries(counts).map(([slug, count]) => updateClickCount(slug, count))
    );
  } catch (err) {
    console.error('Click count sync failed:', err);
  }
}

setInterval(syncClickCounts, CLICK_SYNC_INTERVAL_MS);
```

> **Teaching note for the commit message.** `clicks` in MySQL is now an
> eventually-consistent cache: it reflects the last successful `syncClickCounts`
> run. It may be stale by up to `CLICK_SYNC_INTERVAL_MS` (default 60 s). If
> analytics-service is down, the cache holds the last known value. `GET /urls`
> (user's URL list) and url-service `/admin/stats` continue to serve these cached
> counts without depending on analytics availability.

**Verify workstream F:**
- `GET /urls/:slug` no longer triggers a DB write in url-service (check mysql-bin
  log or `SHOW STATUS LIKE 'Com_update'` before/after).
- After a redirect and the 60 s sync interval, the `clicks` column in MySQL
  reflects the value from ClickHouse.
- With analytics-service stopped, url-service still serves URLs and returns stale
  click counts without crashing.

---

### G — admin-service dashboard rewire (PLAN §6.6)

**File:** `admin-service/src/index.js`

#### G1 — Add env vars

```js
const ANALYTICS_SERVICE_URL = process.env.ANALYTICS_SERVICE_URL || 'http://analytics-service:3005';
const SERVICE_TOKEN         = process.env.SERVICE_TOKEN          || '';
```

#### G2 — Update `/admin/dashboard`

Replace the current two-way parallel fetch with a four-way parallel fetch:

```js
app.get('/admin/dashboard', validateAdminKey, async (req, res) => {
  try {
    const [authStatsRes, urlStatsRes, analyticsOverviewRes, analyticsTopRes] = await Promise.all([
      fetch(`${AUTH_SERVICE_URL}/admin/stats`, {
        headers: { 'X-API-Key': req.headers['x-api-key'] },
        signal: AbortSignal.timeout(2000)
      }),
      fetch(`${URL_SERVICE_URL}/admin/stats`, {
        headers: { 'X-API-Key': req.headers['x-api-key'] },
        signal: AbortSignal.timeout(2000)
      }),
      fetch(`${ANALYTICS_SERVICE_URL}/stats/overview`, {
        headers: { 'X-Service-Token': SERVICE_TOKEN },
        signal: AbortSignal.timeout(2000)
      }),
      fetch(`${ANALYTICS_SERVICE_URL}/stats/top?limit=10`, {
        headers: { 'X-Service-Token': SERVICE_TOKEN },
        signal: AbortSignal.timeout(2000)
      })
    ]);

    if (!authStatsRes.ok || !urlStatsRes.ok || !analyticsOverviewRes.ok || !analyticsTopRes.ok) {
      throw new Error('Failed to fetch stats from upstream services');
    }

    const authStats        = await authStatsRes.json();
    const urlStats         = await urlStatsRes.json();
    const analyticsOverview = await analyticsOverviewRes.json();
    const analyticsTop     = await analyticsTopRes.json();

    res.json({
      users: {
        total:        authStats.totalUsers,
        recentSignups: authStats.recentUsers,
        totalApiKeys: authStats.totalApiKeys
      },
      urls: {
        total:       urlStats.totalUrls,
        recentUrls:  urlStats.recentUrls,
        // Click metrics sourced from analytics-service (authoritative)
        totalClicks: analyticsOverview.totalClicks,
        topUrls:     analyticsTop.map(t => ({ slug: t.slug, clicks: t.totalClicks }))
      }
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});
```

> The admin-ui `Dashboard.js` consumes `urls.totalClicks` and `urls.topUrls`
> unchanged — the response shape is backwards-compatible. No admin-ui change is
> needed in M3.

#### G3 — Update `/admin/health/services`

Add analytics-service to the health check list:

```js
const services = [
  { name: 'auth',      url: `${AUTH_SERVICE_URL}/health` },
  { name: 'url',       url: `${URL_SERVICE_URL}/health` },
  { name: 'config',    url: `${CONFIG_SERVICE_URL}/health` },
  { name: 'analytics', url: `${ANALYTICS_SERVICE_URL}/actuator/health/liveness` }
];
```

---

### H — Compose + `.env` (PLAN §6.6/6.7)

#### H1 — `.env`

Add:
```
# Analytics service + ClickHouse
SERVICE_TOKEN=dev-service-token-change-in-production
IP_HASH_SALT=dev-ip-hash-salt-change-in-production
CLICKHOUSE_PASSWORD=
```

> `SERVICE_TOKEN` is shared by redirect-service (emitter) and admin-service
> (consumer) to call analytics-service. `IP_HASH_SALT` is used only by
> redirect-service. Both are plaintext for local dev; M5 is the milestone that
> injects these as proper secrets.

#### H2 — `compose.yml`

**Add to `redirect-service` environment:**
```yaml
- ANALYTICS_SERVICE_URL=http://analytics-service:3005
- SERVICE_TOKEN=${SERVICE_TOKEN:-dev-service-token-change-in-production}
- IP_HASH_SALT=${IP_HASH_SALT:-dev-ip-hash-salt-change-in-production}
```

**Add to `url-service` environment:**
```yaml
- ANALYTICS_SERVICE_URL=http://analytics-service:3005
- SERVICE_TOKEN=${SERVICE_TOKEN:-dev-service-token-change-in-production}
```

**Add to `admin-service` environment:**
```yaml
- ANALYTICS_SERVICE_URL=http://analytics-service:3005
- SERVICE_TOKEN=${SERVICE_TOKEN:-dev-service-token-change-in-production}
```

**Replace the commented-out analytics block with the real service:**
```yaml
  # Analytics Service
  analytics-service:
    build: ./services/analytics-service
    ports:
      - "3005:3005"
    environment:
      - PORT=3005
      - CLICKHOUSE_URL=jdbc:clickhouse://clickhouse:8123/analytics
      - CLICKHOUSE_USER=${CLICKHOUSE_USER:-default}
      - CLICKHOUSE_PASSWORD=${CLICKHOUSE_PASSWORD:-}
      - SERVICE_TOKEN=${SERVICE_TOKEN:-dev-service-token-change-in-production}
    depends_on:
      clickhouse:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "curl -sf http://localhost:3005/actuator/health/liveness || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 40s  # JVM startup is slower than Node

  # ClickHouse — columnar store for analytics-service
  clickhouse:
    image: clickhouse/clickhouse-server:26.3
    environment:
      - CLICKHOUSE_DB=analytics
      - CLICKHOUSE_USER=default
      - CLICKHOUSE_PASSWORD=${CLICKHOUSE_PASSWORD:-}
    volumes:
      - clickhouse-data:/var/lib/clickhouse
      - ./services/analytics-service/clickhouse-init:/docker-entrypoint-initdb.d
    ports:
      - "8123:8123"  # HTTP — exposed to host for local inspection/tooling
    healthcheck:
      test: ["CMD-SHELL", "wget -q --spider http://localhost:8123/ping || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 20s
    ulimits:
      nofile:
        soft: 262144
        hard: 262144
```

**Update `depends_on` for services that call analytics:**
- `redirect-service`: add `analytics-service` as a **plain** (no condition) entry:
  ```yaml
  depends_on:
    url-service:
      condition: service_healthy
    config-service:
      condition: service_healthy
    analytics-service:        # no condition — redirect must boot even if analytics is down
      condition: service_started
  ```
  The redirect path is fire-and-forget: analytics being temporarily down must not
  block the public-facing service from starting or handling requests. Using
  `condition: service_started` (the default) ensures container ordering without
  requiring analytics to be healthy.
- `admin-service`: add `analytics-service: condition: service_healthy`. The dashboard
  actively calls analytics; coupling to its health is acceptable here, and the admin
  path is not public-critical.
- `url-service` does NOT hard-depend on analytics (the sync job is optional / best-effort)

**Add `clickhouse-data` to the top-level `volumes:`:**
```yaml
volumes:
  auth-db-data:
  url-db-data:
  clickhouse-data:
```

#### H3 — `compose-simple.yml`

Apply the same additions (without healthchecks, using plain `depends_on` lists):

```yaml
  analytics-service:
    build: ./services/analytics-service
    ports:
      - "3005:3005"
    environment:
      - PORT=3005
      - CLICKHOUSE_URL=jdbc:clickhouse://clickhouse:8123/analytics
      - CLICKHOUSE_USER=${CLICKHOUSE_USER:-default}
      - CLICKHOUSE_PASSWORD=${CLICKHOUSE_PASSWORD:-}
      - SERVICE_TOKEN=${SERVICE_TOKEN:-dev-service-token-change-in-production}
    depends_on:
      - clickhouse

  clickhouse:
    image: clickhouse/clickhouse-server:26.3
    environment:
      - CLICKHOUSE_DB=analytics
      - CLICKHOUSE_USER=default
      - CLICKHOUSE_PASSWORD=${CLICKHOUSE_PASSWORD:-}
    volumes:
      - clickhouse-data:/var/lib/clickhouse
      - ./services/analytics-service/clickhouse-init:/docker-entrypoint-initdb.d
    ulimits:
      nofile: { soft: 262144, hard: 262144 }
```

Add `clickhouse-data:` to `compose-simple.yml` `volumes:` as well.

---

### I — CI + integration tests (PLAN §6.7; PLAN §5/M3)

#### I1 — New CI workflow: `.github/workflows/analytics-service.yml`

```yaml
name: Analytics Service CI

on:
  push:
    paths:
      - 'services/analytics-service/**'
      - '.github/workflows/analytics-service.yml'
    branches: [main]
  pull_request:
    paths:
      - 'services/analytics-service/**'

jobs:
  build:
    name: Build and test analytics-service
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          java-version: '21'
          distribution: 'temurin'
          cache: maven
      - name: Run unit tests
        working-directory: services/analytics-service
        run: mvn -B verify --no-transfer-progress
      - name: Build Docker image
        run: docker build -t microshort-analytics:ci services/analytics-service
```

> Tests run with the test `application.properties` that excludes DataSource
> auto-configuration — no ClickHouse needed in this job. The full integration
> test (with a live stack) runs in the integration workflow.

#### I2 — New CI workflow: `.github/workflows/integration.yml`

```yaml
name: Integration Tests

on:
  push:
    paths: ['services/**', 'tests/**', 'compose.yml', 'package.json']
    branches: [main]
  pull_request:
    paths: ['services/**', 'tests/**', 'compose.yml', 'package.json']

jobs:
  integration:
    name: Integration test suite
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 26
          cache: npm
          cache-dependency-path: package-lock.json
      - run: npm ci
      - name: Start stack
        run: docker compose up -d --build --wait
        timeout-minutes: 10
      - name: Run integration tests
        run: npm test
      - name: Print service logs on failure
        if: failure()
        run: docker compose logs --no-color
      - name: Tear down
        if: always()
        run: docker compose down -v
```

> `--wait` requires Docker Compose ≥ 2.17. The analytics-service `start_period: 40s`
> healthcheck means the stack may take up to 60–90 s to become fully healthy.
> `timeout-minutes: 10` provides headroom.

#### I3 — Update `tests/integration/setup.js`

Add analytics-service to the health-poll list:

```js
const HEALTH_URLS = [
  'http://localhost:3000/health',                    // config-service
  'http://localhost:3001/health',                    // auth-service
  'http://localhost:3002/health',                    // url-service
  'http://localhost:8080/health',                    // redirect-service
  'http://localhost:3003/health',                    // admin-service
  'http://localhost:3005/actuator/health/liveness',  // analytics-service
];
```

#### I4 — Update `tests/integration/helpers.js`

Add `analytics` to the `BASE` object and add analytics helper functions:

```js
export const BASE = {
  config:    'http://localhost:3000',
  auth:      'http://localhost:3001',
  urls:      'http://localhost:3002',
  redirect:  'http://localhost:8080',
  admin:     'http://localhost:3003',
  analytics: 'http://localhost:3005',
};

const SERVICE_TOKEN = process.env.SERVICE_TOKEN || 'dev-service-token-change-in-production';

export async function postEvents(events) {
  const res = await fetch(`${BASE.analytics}/events:batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Service-Token': SERVICE_TOKEN },
    body: JSON.stringify(events),
  });
  return { status: res.status };
}

export async function getSlugCounts(slugs) {
  const res = await fetch(
    `${BASE.analytics}/stats/counts?slugs=${slugs.join(',')}`,
    { headers: { 'X-Service-Token': SERVICE_TOKEN } }
  );
  return { status: res.status, ...(res.ok ? await res.json() : {}) };
}
```

#### I5 — Update `tests/integration/happy-path.test.js`

The redirect assertion must change from `301` to `302` and add `Cache-Control`:

```js
// Before:
const res = await fetch(`${BASE.redirect}/${slug}`, { redirect: 'manual' });
expect(res.status).toBe(301);
expect(res.headers.get('location')).toBe('https://example.com');

// After:
const res = await fetch(`${BASE.redirect}/${slug}`, { redirect: 'manual' });
expect(res.status).toBe(302);
expect(res.headers.get('location')).toBe('https://example.com');
expect(res.headers.get('cache-control')).toBe('no-store');
```

#### I6 — New file: `tests/integration/m3/analytics.test.js`

```js
import { describe, it, expect } from 'vitest';
import { BASE, uniqueEmail, register, createApiKey, createShortUrl, postEvents, getSlugCounts } from '../helpers.js';

const wait = ms => new Promise(r => setTimeout(r, ms));

describe('Analytics service', () => {
  it('liveness probe returns 200', async () => {
    const res = await fetch(`${BASE.analytics}/actuator/health/liveness`);
    expect(res.status).toBe(200);
  });

  it('readiness probe returns 200 (ClickHouse reachable)', async () => {
    const res = await fetch(`${BASE.analytics}/actuator/health/readiness`);
    expect(res.status).toBe(200);
  });

  it('POST /events:batch without token → 401', async () => {
    const res = await fetch(`${BASE.analytics}/events:batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([])
    });
    expect(res.status).toBe(401);
  });

  it('POST /events:batch with token → 202', async () => {
    const { status } = await postEvents([{
      slug: 'test-slug',
      ts: new Date().toISOString(),
      referrer: '',
      userAgent: 'test-agent',
      ipHash: 'a'.repeat(64)
    }]);
    expect(status).toBe(202);
  });

  it('GET /stats/counts returns zero for unknown slug', async () => {
    const { status, ...counts } = await getSlugCounts(['unknown-slug-xyz']);
    expect(status).toBe(200);
    expect(counts['unknown-slug-xyz']).toBe(0);
  });

  it('click event is recorded and queryable', async () => {
    const slug = `test-${Date.now()}`;
    await postEvents([{
      slug,
      ts: new Date().toISOString(),
      referrer: 'https://example.com',
      userAgent: 'Mozilla/5.0',
      ipHash: 'b'.repeat(64)
    }]);

    // ClickHouse materialized views update asynchronously — allow up to 5 s
    let counts = {};
    for (let i = 0; i < 10; i++) {
      await wait(500);
      const result = await getSlugCounts([slug]);
      if (result[slug] > 0) { counts = result; break; }
    }
    expect(counts[slug]).toBeGreaterThanOrEqual(1);
  });

  it('redirect returns 302 with Cache-Control: no-store', async () => {
    const email = uniqueEmail('m3redir');
    const { token } = await register(email);
    const { apiKey } = await (async () => {
      const r = await fetch(`${BASE.auth}/auth/api-keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: 'm3-key' })
      });
      return r.json();
    })();
    const { slug } = await createShortUrl(apiKey, 'https://example.com/m3');
    const res = await fetch(`${BASE.redirect}/${slug}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('GET /stats/overview returns expected shape', async () => {
    const res = await fetch(`${BASE.analytics}/stats/overview`, {
      headers: { 'X-Service-Token': process.env.SERVICE_TOKEN || 'dev-service-token-change-in-production' }
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('totalClicks');
    expect(body).toHaveProperty('last7DayClicks');
  });
});
```

#### I7 — Update `vitest.config.js`

The M3 tests are safe against a warm stack (unique slugs, no state pollution).
Include them in the default run and exclude only rate-limiting:

```js
// No change to the include/exclude logic needed.
// tests/integration/m3/analytics.test.js is picked up by the existing
// include: ['tests/integration/**/*.test.js'] glob.
```

Update `package.json` scripts to add an M3 convenience target:

```json
"test:m3": "vitest run --reporter=verbose tests/integration/m3"
```

---

## 3. File-change summary

| File | Workstream | Change |
|------|-----------|--------|
| `services/analytics-service/` (new directory) | A | Full Spring Boot service scaffold |
| `services/analytics-service/Dockerfile` | A | Multi-stage Maven 3.9 + Temurin 21 build; SSL bypass flags |
| `services/analytics-service/pom.xml` | A | Spring Boot 3.5.x parent; web, jdbc, actuator, prometheus, clickhouse-jdbc:all |
| `services/analytics-service/src/main/resources/application.properties` | A | Port, datasource, actuator probes, service token |
| `services/analytics-service/src/test/resources/application.properties` | A | Exclude DataSource auto-config for unit tests |
| `services/analytics-service/src/.../AnalyticsApplication.java` | A | Main class |
| `services/analytics-service/src/.../config/ServiceTokenFilter.java` | A | Token filter, bypasses `/actuator/**` |
| `services/analytics-service/src/.../model/ClickEvent.java` | A | Record type (slug, ts, referrer, userAgent, ipHash) |
| `services/analytics-service/src/.../AnalyticsApplicationTests.java` | A | Context load test (no DB) |
| `services/analytics-service/clickhouse-init/01-schema.sql` | B | `clicks` MergeTree TTL 90d; `clicks_daily` AggregatingMergeTree with `SimpleAggregateFunction(sum, UInt64)`; materialized view |
| `services/analytics-service/src/.../controller/EventController.java` | C | `POST /events`, `POST /events:batch` → 202 |
| `services/analytics-service/src/.../repository/ClickHouseRepository.java` | D | `insertBatch`, `getOverview`, `getTop`, `getSlugStats`, `getTimeseries`, `getCounts` |
| `services/analytics-service/src/.../controller/StatsController.java` | D | `GET /stats/overview`, `/top`, `/slug/{slug}`, `/timeseries`, `/counts` |
| `services/redirect-service/src/index.js` | E | Add trust proxy, crypto import, `hashIp`, `bufferEvent`, `flushEvents`, setInterval flush; 302 + `Cache-Control: no-store`; remove `logRedirect` stub |
| `services/url-service/init/01-schema.sql` | F | Drop `url_analytics` table + FK; add recreate note |
| `services/url-service/src/db.js` | F | Remove `incrementClicks`; add `updateClickCount(slug, count)` |
| `services/url-service/src/index.js` | F | Remove `incrementClicks` call; add `ANALYTICS_SERVICE_URL`, `SERVICE_TOKEN`, `CLICK_SYNC_INTERVAL_MS`; add `syncClickCounts` scheduled job |
| `services/admin-service/src/index.js` | G | Add `ANALYTICS_SERVICE_URL`, `SERVICE_TOKEN`; update `/admin/dashboard` to call analytics overview + top; update `/admin/health/services` to include analytics |
| `.env` | H | Add `SERVICE_TOKEN`, `IP_HASH_SALT`, `CLICKHOUSE_PASSWORD` |
| `compose.yml` | H | Add analytics-service + clickhouse containers with healthchecks; add env vars to redirect/url/admin; add `clickhouse-data` volume; update `depends_on` for redirect+admin |
| `compose-simple.yml` | H | Same (no healthchecks, plain depends_on) |
| `.github/workflows/analytics-service.yml` | I | NEW: `mvn verify` + `docker build` CI job |
| `.github/workflows/integration.yml` | I | NEW: full-stack integration test job |
| `tests/integration/setup.js` | I | Add analytics-service liveness URL to health-poll list |
| `tests/integration/helpers.js` | I | Add `analytics` to BASE; add `postEvents`, `getSlugCounts` helpers |
| `tests/integration/happy-path.test.js` | I | Change `301` → `302`; add `Cache-Control: no-store` assertion |
| `tests/integration/m3/analytics.test.js` | I | NEW: probe health, ingestion, counts, redirect 302, overview shape |
| `package.json` (root) | I | Add `"test:m3"` script |

---

## 4. Commit sequencing

Each commit should leave the stack in a working state (or clearly note it is
intermediate):

1. **ClickHouse schema + analytics-service scaffold (A + B)** — `pom.xml`, source
   tree, `clickhouse-init/01-schema.sql`, `Dockerfile`. Verify: `mvn verify` passes;
   `docker build` succeeds.
2. **Ingestion + stats API (C + D)** — `EventController`, `ClickHouseRepository`,
   `StatsController`. The service is now fully functional. Verify against a manually
   started ClickHouse.
3. **Compose + `.env` (H)** — analytics-service and ClickHouse added to both compose
   files; new env vars. `docker compose up -d --build --wait` brings all services
   healthy. **This is the first commit where the full stack can be tested end-to-end.**
4. **redirect-service rewire (E)** — 302, `Cache-Control`, buffer, ip_hash. Depends
   on compose (step 3) so analytics receives events. Verify redirect returns 302 and
   events appear in `/stats/counts`.
5. **url-service rewire (F)** — drop `incrementClicks`, add sync job, drop
   `url_analytics`. This is a **breaking schema change** — document `down -v` in
   commit message. Verify click counts in MySQL sync from analytics after 60 s.
6. **admin-service rewire (G)** — dashboard calls analytics. Verify `/admin/dashboard`
   returns `totalClicks` from analytics (should reflect real click events).
7. **Integration test updates + CI (I)** — update `setup.js`, `helpers.js`,
   `happy-path.test.js`; add `analytics.test.js`; add `analytics-service.yml` and
   `integration.yml`. Run `npm test` (warm stack) and `npm run test:m3` to confirm
   all pass.

---

## 5. Definition of done (M3 acceptance criteria)

- [ ] **CR 3.3** — `curl -I http://localhost:8080/<slug>` returns `302 Found`
  with `Cache-Control: no-store`. `grep -n 'redirect(301' services/redirect-service/src/index.js`
  returns nothing.
- [ ] **CR 3.2 / CR 3.1** — `grep -n 'logRedirect\|incrementClicks' services/redirect-service/src/index.js services/url-service/src/index.js`
  returns nothing. The click path is: redirect-service buffers event → analytics-service
  records it in ClickHouse → url-service sync job refreshes MySQL cache.
- [ ] **Analytics health** — `GET http://localhost:3005/actuator/health/liveness` → `200`;
  `GET .../readiness` → `200` (ClickHouse connection confirmed).
- [ ] **Ingestion auth** — `POST /events:batch` without `X-Service-Token` → `401`.
  Same call with the correct token → `202`.
- [ ] **End-to-end click tracking** — follow a short URL (via browser or `curl -L`);
  within 10 s, `GET /stats/counts?slugs=<slug>` (with token) returns `{"<slug>": 1}`.
- [ ] **Admin dashboard** — `GET /admin/dashboard` (admin API key) returns `totalClicks`
  from analytics-service, not from url-service's cached column directly.
- [ ] **url-service eventually consistent** — wait 60 s after a redirect; the `clicks`
  column in MySQL (`SELECT slug, clicks FROM urls WHERE slug='<slug>'`) reflects the
  value from ClickHouse.
- [ ] **url_analytics removed** — `SELECT * FROM url_analytics` in the url-db MySQL
  container returns `ERROR 1146 (42S02): Table 'urlshort.url_analytics' doesn't exist`.
- [ ] **`mvn verify`** (Java 21 active) passes in `services/analytics-service`.
- [ ] **`docker compose up -d --build --wait`** (after `down -v`) brings all 8
  containers (6 services + auth-db + url-db + analytics + clickhouse) to healthy.
- [ ] **Integration tests** — `npm test` (warm stack) passes, including `analytics.test.js`.
  `npm run test:m3` passes. `npm run test:e2e` from a clean volume passes all tests.

---

## 6. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Maven dependency download inside Docker fails (corporate SSL proxy). | `Dockerfile` passes `-Dmaven.wagon.http.ssl.insecure=true -Dmaven.wagon.http.ssl.allowall=true` to all `mvn` invocations. Test with `docker compose build analytics-service` before committing. |
| Local `mvn verify` uses Java 17 (system default). | Run `export JAVA_HOME=/usr/lib/jvm/java-21-openjdk && export PATH=$JAVA_HOME/bin:$PATH` once per shell. Add this to `~/.bashrc` or equivalent to make it permanent. |
| JVM startup time causes analytics-service healthcheck to fail during compose up. | `start_period: 40s` in the healthcheck gives the JVM time to warm up before retries begin. `docker compose up --wait` will block until all services are healthy. |
| ClickHouse materialized view populates asynchronously. | Integration test polls `/stats/counts` with a 10× 500 ms retry loop. Production analytics queries read from `clicks_daily` which reflects inserts within seconds under normal load. |
| `clicks_daily` query without explicit `sum()` returns partial-part values. | All `ClickHouseRepository` query methods use `sum(clicks)` and `uniqMerge(uniq_visitors)`. Document this query pattern in a code comment so future contributors do not omit the aggregation. |
| `ip_hash` collisions: bare Compose sets `req.ip` to the Docker bridge gateway. | Expected and documented in decision 8. `app.set('trust proxy', 1)` is added now; the real-IP fix arrives with M4's proxy/Redis layer. Mention this in the commit message. |
| `SERVICE_TOKEN` is the same secret for all callers (redirect + admin → analytics). | Acceptable for M3 teaching context. A per-caller token registry is an M5 hardening option. |
| `docker compose down -v` required for url-service schema change (drop `url_analytics`). | Document prominently in the commit message and in a `NOTE` comment at the top of `01-schema.sql`. Mirror the M2 pattern exactly. |
| analytics-service down → admin dashboard throws 500. | The current `throw new Error('Failed to fetch stats')` escalation is acceptable for M3. M4 hardens admin-service with graceful degradation (per CR §8.2). |
| ClickHouse `ulimits: nofile` not supported on all Docker hosts. | The `ulimits` block is advisory. ClickHouse runs without it; it is best practice for production. Remove it if your Docker Desktop version doesn't support it. |

---

## 7. Out of scope (deferred, do not creep)

Liveness/readiness for Node services, structured JSON logging, per-service Prometheus
metrics, graceful shutdown, shared Redis cache (M4); config backing store, `.env` →
secrets injection, HMAC service tokens (M5); admin-UI runtime config, CDN vendoring,
camelCase normalisation of the API surface (M6); README/architecture reconciliation,
compose-file collapse, full contract test suites (M7).

---

*Sources consulted while writing this plan:*
- [Spring Boot releases — spring.io](https://spring.io/projects/spring-boot/) — confirmed Spring Boot 3.5.x as latest stable 3.x GA (Spring Boot 4.1 in milestone, skipped per PLANNING §6.1)
- [clickhouse-java JDBC — Maven Central](https://central.sonatype.com/artifact/com.clickhouse/clickhouse-jdbc) — confirmed `com.clickhouse:clickhouse-jdbc:0.9.8`, `all` classifier
- [clickhouse-java GitHub](https://github.com/ClickHouse/clickhouse-java) — confirmed `jdbc:clickhouse://` URL prefix and shaded-jar exclusion pattern
- [ClickHouse Docker Hub](https://hub.docker.com/r/clickhouse/clickhouse-server) — confirmed `26.3` as current LTS branch (26.3.x)
- [ClickHouse AggregatingMergeTree / SimpleAggregateFunction](https://clickhouse.com/docs/sql-reference/aggregate-functions/combinators) — confirmed `SimpleAggregateFunction(sum, UInt64)` is the correct type for a count that sums correctly during part merges; plain `UInt64` is not merged by the engine
- [micrometer-registry-prometheus — Spring Boot Actuator docs](https://docs.spring.io/spring-boot/reference/actuator/metrics.html) — confirmed `io.micrometer:micrometer-registry-prometheus` dep + `management.endpoints.web.exposure.include=prometheus`
