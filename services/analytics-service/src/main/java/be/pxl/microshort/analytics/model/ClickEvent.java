package be.pxl.microshort.analytics.model;

import java.time.Instant;

public record ClickEvent(
    String slug,
    Instant ts,
    String referrer,
    String userAgent,
    String ipHash
) {}
