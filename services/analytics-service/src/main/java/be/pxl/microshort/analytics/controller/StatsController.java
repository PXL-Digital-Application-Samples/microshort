package be.pxl.microshort.analytics.controller;

import be.pxl.microshort.analytics.repository.ClickHouseRepository;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.tags.Tag;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Arrays;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/stats")
@Tag(name = "Stats", description = "Query click statistics from ClickHouse")
public class StatsController {

    private final ClickHouseRepository repository;

    public StatsController(ClickHouseRepository repository) {
        this.repository = repository;
    }

    @Operation(summary = "Overall click statistics",
               description = "Returns total click count and number of distinct slugs.")
    @ApiResponse(responseCode = "200", description = "Overview stats")
    @ApiResponse(responseCode = "401", description = "Service token missing or invalid")
    @GetMapping("/overview")
    public ResponseEntity<Map<String, Object>> overview() {
        return ResponseEntity.ok(repository.getOverview());
    }

    @Operation(summary = "Top slugs by click count")
    @ApiResponse(responseCode = "200", description = "Ranked list of slugs")
    @ApiResponse(responseCode = "401", description = "Service token missing or invalid")
    @GetMapping("/top")
    public ResponseEntity<List<Map<String, Object>>> top(
        @Parameter(description = "Maximum number of results", example = "10")
        @RequestParam(defaultValue = "10") int limit,
        @Parameter(description = "Only count clicks since this ISO-8601 date (e.g. 2024-01-01)", example = "2024-01-01")
        @RequestParam(required = false) String since
    ) {
        return ResponseEntity.ok(repository.getTop(limit, since));
    }

    @Operation(summary = "Per-slug statistics for a date range")
    @ApiResponse(responseCode = "200", description = "Slug stats")
    @ApiResponse(responseCode = "401", description = "Service token missing or invalid")
    @GetMapping("/slug/{slug}")
    public ResponseEntity<Map<String, Object>> slug(
        @Parameter(description = "The short URL slug", example = "abc123")
        @PathVariable String slug,
        @Parameter(description = "Start date (inclusive), ISO-8601", example = "1970-01-01")
        @RequestParam(defaultValue = "1970-01-01") String from,
        @Parameter(description = "End date (inclusive), ISO-8601", example = "2099-12-31")
        @RequestParam(defaultValue = "2099-12-31") String to
    ) {
        return ResponseEntity.ok(repository.getSlugStats(slug, from, to));
    }

    @Operation(summary = "Click timeseries for a slug",
               description = "Returns daily click counts for the given slug and date range.")
    @ApiResponse(responseCode = "200", description = "Timeseries data")
    @ApiResponse(responseCode = "401", description = "Service token missing or invalid")
    @GetMapping("/timeseries")
    public ResponseEntity<?> timeseries(
        @Parameter(description = "The short URL slug", example = "abc123", required = true)
        @RequestParam String slug,
        @Parameter(description = "Start date (inclusive), ISO-8601", example = "1970-01-01")
        @RequestParam(defaultValue = "1970-01-01") String from,
        @Parameter(description = "End date (inclusive), ISO-8601", example = "2099-12-31")
        @RequestParam(defaultValue = "2099-12-31") String to
    ) {
        return ResponseEntity.ok(repository.getTimeseries(slug, from, to));
    }

    @Operation(summary = "Bulk click counts via query string",
               description = "Accepts a comma-separated list of slugs and returns a map of slug → count.")
    @ApiResponse(responseCode = "200", description = "Click counts by slug")
    @ApiResponse(responseCode = "401", description = "Service token missing or invalid")
    @GetMapping("/counts")
    public ResponseEntity<Map<String, Long>> counts(
        @Parameter(description = "Comma-separated list of slugs", example = "abc123,def456")
        @RequestParam String slugs
    ) {
        List<String> slugList = Arrays.stream(slugs.split(","))
            .map(String::trim)
            .filter(s -> !s.isBlank())
            .toList();
        return ResponseEntity.ok(repository.getCounts(slugList));
    }

    @Operation(summary = "Bulk click counts via request body",
               description = "Accepts a JSON array of slugs (max 2000) and returns a map of slug → count.")
    @ApiResponse(responseCode = "200", description = "Click counts by slug")
    @ApiResponse(responseCode = "401", description = "Service token missing or invalid")
    @ApiResponse(responseCode = "413", description = "Request body exceeds 2000 slugs")
    @PostMapping("/counts")
    public ResponseEntity<Map<String, Long>> countsByPost(@RequestBody List<String> slugs) {
        if (slugs == null || slugs.isEmpty()) {
            return ResponseEntity.ok(Map.of());
        }
        if (slugs.size() > 2000) {
            return ResponseEntity.status(413).build();
        }
        return ResponseEntity.ok(repository.getCounts(slugs));
    }
}
