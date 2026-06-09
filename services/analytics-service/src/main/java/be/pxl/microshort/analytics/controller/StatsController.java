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
