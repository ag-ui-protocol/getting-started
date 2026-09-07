package com.agui.community.client;

/**
 * Per-line and per-event limits for an SSE response. Both limits count UTF-8
 * bytes, not Java characters, and must be positive.
 *
 * @param maxLineBytes maximum bytes in any line, excluding its CR/LF terminator;
 *                     applies to comments and ignored fields as well as data
 * @param maxEventBytes maximum bytes in the combined, decoded event data,
 *                      including the newlines inserted between data fields
 */
public record SseLimits(int maxLineBytes, int maxEventBytes) {

    /** Defaults: 1 MiB per wire line and 8 MiB per event data payload. */
    public static final SseLimits DEFAULT = new SseLimits(1024 * 1024, 8 * 1024 * 1024);

    public SseLimits {
        if (maxLineBytes <= 0 || maxEventBytes <= 0) {
            throw new IllegalArgumentException("SSE size limits must be positive");
        }
    }
}
