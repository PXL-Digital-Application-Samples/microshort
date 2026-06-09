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
