package com.agui.adk.a2ui;

import java.util.List;
import java.util.Map;

/**
 * Serializes a Java object tree (ordered {@link Map}/{@link List}/String/Number/Boolean/null) into
 * the byte-exact forms produced by CPython's {@code json} module, so byte-level parity with the
 * reference A2UI renderer and toolkit envelopes is preserved:
 *
 * <ul>
 *   <li>{@link #stringify} — {@code json.dumps(value, ensure_ascii=True, separators=(",",":"))}
 *       (compact, used by the Google a2ui-agent-sdk renderer path);</li>
 *   <li>{@link #stringifySpaced} — {@code json.dumps(value)} defaults
 *       ({@code separators=(", ", ": ")}, used by the toolkit envelope assemblers);</li>
 *   <li>{@link #stringifyIndent2} — {@code json.dumps(value, indent=2)} (used by the sub-agent
 *       prompt's previous-surface edit block).</li>
 * </ul>
 *
 * <p>Character escaping mirrors CPython's {@code _json.encode_basestring_ascii}: ASCII printables
 * ({@code 0x20..0x7e}) except {@code "} and {@code \} are kept literal; the five named control
 * escapes are used; every other char ({@code <0x20} and {@code >=0x7f}, including non-ASCII) is
 * emitted as a lowercase 4-digit {@code backslash-u-XXXX} escape.
 */
final class PythonJson {

    private PythonJson() { }

    /**
     * Serializes a value to compact JSON using Python-style separators for byte-parity with
     * {@code json.dumps(value, separators=(",",":"))}.
     *
     * @param value the value to serialize
     * @return the JSON string
     */
    static String stringify(Object value) {
        StringBuilder sb = new StringBuilder();
        write(sb, value, Compact.INSTANCE);
        return sb.toString();
    }

    /**
     * Serializes a value to JSON using Python's default {@code json.dumps(value)} formatting
     * ({@code ", "} item separator, {@code ": "} key separator) — the byte-exact wire form of the
     * toolkit's {@code wrap_as_operations_envelope} / {@code wrap_error_envelope} /
     * {@code _wrap_recovery_exhausted_envelope}.
     *
     * @param value the value to serialize
     * @return the JSON string
     */
    static String stringifySpaced(Object value) {
        StringBuilder sb = new StringBuilder();
        write(sb, value, Spaced.INSTANCE);
        return sb.toString();
    }

    /**
     * Serializes a value to JSON with Python's {@code json.dumps(value, indent=2)} formatting: a
     * trailing newline is NOT emitted (CPython emits one at top level; the prompt block joins
     * sections itself), containers break across lines at two spaces per level, separators are
     * {@code (",", ": ")} and empty containers stay inline ({@code {}} / {@code []}).
     *
     * @param value the value to serialize
     * @return the JSON string
     */
    static String stringifyIndent2(Object value) {
        StringBuilder sb = new StringBuilder();
        writeIndent(sb, value, 0);
        return sb.toString();
    }

    /** Separator policy shared by the flat writers. */
    private interface Separators {
        String item();

        String key();

        boolean compact();
    }

    /** Compact separators ({@code ","} / {@code ":"}). */
    private static final class Compact implements Separators {
        private static final Compact INSTANCE = new Compact();

        @Override
        public String item() {
            return ",";
        }

        @Override
        public String key() {
            return ":";
        }

        @Override
        public boolean compact() {
            return true;
        }
    }

    /** Python-default spaced separators ({@code ", "} / {@code ": "}). */
    private static final class Spaced implements Separators {
        private static final Spaced INSTANCE = new Spaced();

        @Override
        public String item() {
            return ", ";
        }

        @Override
        public String key() {
            return ": ";
        }

        @Override
        public boolean compact() {
            return false;
        }
    }

    /**
     * Appends a single JSON value to the builder using the given separators.
     *
     * @param sb    the target builder
     * @param value the value to write
     * @param sep   separator policy
     */
    private static void write(StringBuilder sb, Object value, Separators sep) {
        if (value == null) {
            sb.append("null");
        } else if (value instanceof Boolean b) {
            sb.append(b ? "true" : "false");
        } else if (value instanceof String s) {
            writeString(sb, s);
        } else if (value instanceof Long || value instanceof Integer || value instanceof Short) {
            sb.append(value.toString());
        } else if (value instanceof Double || value instanceof Float) {
            sb.append(pyFloat(((Number) value).doubleValue()));
        } else if (value instanceof Map<?, ?> map) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> e : map.entrySet()) {
                if (!first) {
                    sb.append(sep.item());
                }
                first = false;
                writeString(sb, String.valueOf(e.getKey()));
                sb.append(sep.key());
                write(sb, e.getValue(), sep);
            }
            sb.append('}');
        } else if (value instanceof Iterable<?> it) {
            sb.append('[');
            boolean first = true;
            for (Object item : it) {
                if (!first) {
                    sb.append(sep.item());
                }
                first = false;
                write(sb, item, sep);
            }
            sb.append(']');
        } else {
            writeString(sb, String.valueOf(value));
        }
    }

    /**
     * Appends a single JSON value to the builder using Python {@code indent=2} layout.
     *
     * @param sb    the target builder
     * @param value the value to write
     * @param depth current container nesting depth
     */
    private static void writeIndent(StringBuilder sb, Object value, int depth) {
        if (value == null) {
            sb.append("null");
        } else if (value instanceof Boolean b) {
            sb.append(b ? "true" : "false");
        } else if (value instanceof String s) {
            writeString(sb, s);
        } else if (value instanceof Long || value instanceof Integer || value instanceof Short) {
            sb.append(value.toString());
        } else if (value instanceof Double || value instanceof Float) {
            sb.append(pyFloat(((Number) value).doubleValue()));
        } else if (value instanceof Map<?, ?> map) {
            if (map.isEmpty()) {
                sb.append("{}");
                return;
            }
            sb.append('{');
            for (Map.Entry<?, ?> e : map.entrySet()) {
                sb.append('\n');
                indent(sb, depth + 1);
                writeString(sb, String.valueOf(e.getKey()));
                sb.append(": ");
                writeIndent(sb, e.getValue(), depth + 1);
                sb.append(',');
            }
            sb.setLength(sb.length() - 1); // drop trailing item separator
            sb.append('\n');
            indent(sb, depth);
            sb.append('}');
        } else if (value instanceof Iterable<?> it) {
            if (!it.iterator().hasNext()) {
                sb.append("[]");
                return;
            }
            sb.append('[');
            for (Object item : it) {
                sb.append('\n');
                indent(sb, depth + 1);
                writeIndent(sb, item, depth + 1);
                sb.append(',');
            }
            sb.setLength(sb.length() - 1);
            sb.append('\n');
            indent(sb, depth);
            sb.append(']');
        } else {
            writeString(sb, String.valueOf(value));
        }
    }

    /**
     * Appends {@code 2 * depth} spaces.
     *
     * @param sb    the target builder
     * @param depth indentation depth
     */
    private static void indent(StringBuilder sb, int depth) {
        for (int i = 0; i < depth * 2; i++) {
            sb.append(' ');
        }
    }

    /**
     * Appends a JSON-escaped string to the builder.
     *
     * @param sb the target builder
     * @param s the string to escape and write
     */
    private static void writeString(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                case '\b' -> sb.append("\\b");
                case '\f' -> sb.append("\\f");
                default -> {
                    if (c >= 0x20 && c <= 0x7e) {
                        sb.append(c);
                    } else {
                        sb.append('\\').append('u');
                        String hex = Integer.toHexString(c);
                        for (int pad = hex.length(); pad < 4; pad++) {
                            sb.append('0');
                        }
                        sb.append(hex);
                    }
                }
            }
        }
        sb.append('"');
    }

    /**
     * Best-effort Python {@code float.__repr__} for the (rare) floats in catalogs/assets: integral
     * doubles render with a trailing {@code .0}, otherwise the shortest round-trip representation.
     *
     * @param d double value
     * @return Python-style representation
     */
    private static String pyFloat(double d) {
        if (d == Math.rint(d) && !Double.isInfinite(d) && !Double.isNaN(d)
                && Math.abs(d) < 9_007_199_254_740_992L) {
            return String.valueOf((long) d) + ".0";
        }
        String s = Double.toString(d);
        return s;
    }
}
