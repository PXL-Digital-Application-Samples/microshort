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
        if (events.size() > 1000) {
            return ResponseEntity.status(413).build();
        }
        repository.insertBatch(events);
        return ResponseEntity.accepted().build();
    }
}
