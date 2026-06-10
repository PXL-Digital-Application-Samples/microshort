package be.pxl.microshort.analytics.controller;

import be.pxl.microshort.analytics.model.ClickEvent;
import be.pxl.microshort.analytics.repository.ClickHouseRepository;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.tags.Tag;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@Tag(name = "Events", description = "Ingest click events from redirect-service")
public class EventController {

    private final ClickHouseRepository repository;

    public EventController(ClickHouseRepository repository) {
        this.repository = repository;
    }

    @Operation(summary = "Ingest a single click event")
    @ApiResponse(responseCode = "202", description = "Event accepted")
    @ApiResponse(responseCode = "401", description = "Service token missing or invalid")
    @PostMapping("/events")
    public ResponseEntity<Void> ingest(@RequestBody ClickEvent event) {
        repository.insertBatch(List.of(event));
        return ResponseEntity.accepted().build();
    }

    @Operation(summary = "Ingest a batch of click events (primary path from redirect-service)",
               description = "Accepts up to 1000 events per request.")
    @ApiResponse(responseCode = "202", description = "Batch accepted")
    @ApiResponse(responseCode = "400", description = "Empty or null batch")
    @ApiResponse(responseCode = "401", description = "Service token missing or invalid")
    @ApiResponse(responseCode = "413", description = "Batch exceeds 1000 events")
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
