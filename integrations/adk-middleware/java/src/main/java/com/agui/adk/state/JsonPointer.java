package com.agui.adk.state;

/** JSON Pointer segment encoding as defined by RFC 6901. */
public final class JsonPointer {
    private JsonPointer() { }

    /**
     * Escapes a JSON object key for use as one JSON Pointer segment.
     *
     * @param key unescaped object key
     * @return escaped pointer segment
     */
    public static String escape(String key) {
        return key.replace("~", "~0").replace("/", "~1");
    }
}
