package be.pxl.microshort.analytics.model;

import io.swagger.v3.oas.annotations.media.Schema;

import java.time.Instant;

@Schema(description = "A single click event recorded when a short URL is resolved")
public record ClickEvent(
    @Schema(description = "The short URL slug that was clicked", example = "abc123")
    String slug,

    @Schema(description = "UTC timestamp of the click", example = "2024-06-11T12:00:00Z")
    Instant ts,

    @Schema(description = "HTTP Referer header value, empty string if absent", example = "https://example.com")
    String referrer,

    @Schema(description = "User-Agent header value", example = "Mozilla/5.0 ...")
    String userAgent,

    @Schema(description = "SHA-256 hash of the visitor IP + salt (never the raw IP)", example = "a1b2c3d4...")
    String ipHash
) {}
