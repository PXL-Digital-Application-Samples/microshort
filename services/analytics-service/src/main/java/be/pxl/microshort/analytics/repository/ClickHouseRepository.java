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
