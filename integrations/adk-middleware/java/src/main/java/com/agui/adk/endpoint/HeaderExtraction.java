package com.agui.adk.endpoint;

/**
 * Pure port of the Python {@code endpoint.py _header_to_key} / header extraction mechanics:
 * converts an HTTP header name into an AG-UI state key.
 *
 * <p>Strips a leading {@code x-} prefix and converts hyphens to underscores, lower-cased:
 * {@code x-user-id} -&gt; {@code user_id}, {@code x-tenant-id} -&gt; {@code tenant_id}.
 * The broader HTTP endpoint wire-up (FastAPI/SSE/GET /capabilities) is hosting-app territory
 * (NO_JAVA_EQUIVALENT); this key normalization is the pure, offline-testable core.
 */
public final class HeaderExtraction {

    private HeaderExtraction() {
    }

    /**
     * Converts a header name to an AG-UI state key (Python {@code _header_to_key}).
     *
     * @param headerName the HTTP header name (e.g. {@code X-User-Id})
     * @return the state key (e.g. {@code user_id})
     */
    public static String headerToKey(String headerName) {
        String key = headerName.toLowerCase();
        if (key.startsWith("x-")) {
            key = key.substring(2);
        }
        return key.replace('-', '_');
    }
}
