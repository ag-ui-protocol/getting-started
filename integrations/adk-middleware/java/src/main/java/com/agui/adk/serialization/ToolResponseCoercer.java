package com.agui.adk.serialization;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Recursively coerces arbitrary tool-response objects into JSON-serializable structures,
 * mirroring the Python {@code _coerce_tool_response}/{@code _serialize_tool_response}.
 *
 * <p>Handles dumpable objects, maps, collections, byte arrays (strictly decoded as UTF-8), and
 * instance fields, guarding against reference cycles and skipping private/underscore fields.
 * Non-coercible values fall back to their {@code toString()}.
 */
public final class ToolResponseCoercer {

    private ToolResponseCoercer() {
    }

    /**
     * Coerces an arbitrary object into a JSON-serializable value (maps, lists, scalars).
     *
     * @param value the raw tool response payload
     * @return a JSON-serializable structure
     */
    public static Object coerce(Object value) {
        return coerce(value, new IdentityHashMap<>());
    }

    /**
     * Coerces a value with cycle-tracking context.
     *
     * @param value the raw value
     * @param visited the active reference-identity stack for cycle detection
     * @return a JSON-serializable value
     */
    private static Object coerce(Object value, IdentityHashMap<Object, Boolean> visited) {
        if (value == null || value instanceof String || value instanceof Boolean
                || value instanceof Number || value instanceof Character) {
            return value;
        }
        if (value instanceof byte[] bytes) {
            return decodeUtf8OrBytes(bytes);
        }
        if (visited.containsKey(value)) {
            return stringifyRepeatedIdentity(value);
        }
        visited.put(value, Boolean.TRUE);
        try {
            // Preferred dump methods precede container handling, matching Python dispatch order.
            for (String methodName : List.of("model_dump", "to_dict", "toMap", "toDict", "dump")) {
                Object dumped = invokeNoArg(value, methodName);
                if (dumped != null && dumped != value) {
                    return coerce(dumped, visited);
                }
            }
            if (value instanceof Map<?, ?> map) {
                Map<String, Object> out = new LinkedHashMap<>();
                for (Map.Entry<?, ?> entry : map.entrySet()) {
                    out.put(String.valueOf(entry.getKey()), coerce(entry.getValue(), visited));
                }
                return out;
            }
            if (value instanceof Iterable<?> iterable) {
                List<Object> out = new ArrayList<>();
                for (Object item : iterable) {
                    out.add(coerce(item, visited));
                }
                return out;
            }
            Map<String, Object> reflected = reflectFields(value, visited);
            if (!reflected.isEmpty()) {
                return reflected;
            }
            return value.toString();
        } finally {
            visited.remove(value);
        }
    }

    /**
     * Invokes a no-argument bean dump method when present.
     *
     * @param value the target object
     * @param methodName the dump method name
     * @return the dumped value, or {@code null} when unavailable
     */
    private static Object invokeNoArg(Object value, String methodName) {
        try {
            Method method = value.getClass().getMethod(methodName);
            if (Modifier.isStatic(method.getModifiers())) {
                return null;
            }
            method.setAccessible(true);
            Object result = method.invoke(value);
            return !(result instanceof CharSequence) ? result : null;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Reflects non-static instance fields from the full class hierarchy into a map.
     *
     * @param value the target object
     * @param visited the active reference-identity stack for cycle detection
     * @return a map of field name to coerced value
     */
    private static Map<String, Object> reflectFields(
            Object value, IdentityHashMap<Object, Boolean> visited) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (Class<?> type = value.getClass(); type != null && type != Object.class;
                type = type.getSuperclass()) {
            for (Field field : type.getDeclaredFields()) {
                if (Modifier.isStatic(field.getModifiers()) || Modifier.isTransient(field.getModifiers())
                        || field.isSynthetic() || field.getName().startsWith("_")
                        || out.containsKey(field.getName())) {
                    continue;
                }
                try {
                    field.setAccessible(true);
                    out.put(field.getName(), coerce(field.get(value), visited));
                } catch (Exception ignored) {
                    // Skip inaccessible fields.
                }
            }
        }
        return out;
    }

    /**
     * Stringifies a repeated identity without allowing recursive Java container strings to overflow.
     *
     * @param value the repeated object
     * @return its string representation, or an identity string when Java's implementation recurses
     */
    private static String stringifyRepeatedIdentity(Object value) {
        try {
            return value.toString();
        } catch (StackOverflowError error) {
            return value.getClass().getName() + "@" + Integer.toHexString(System.identityHashCode(value));
        }
    }

    /**
     * Strictly decodes UTF-8 or returns unsigned byte values when the input is malformed.
     *
     * @param bytes the bytes to decode or expand
     * @return the decoded string or a list of unsigned byte values
     */
    private static Object decodeUtf8OrBytes(byte[] bytes) {
        try {
            return StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes))
                    .toString();
        } catch (CharacterCodingException e) {
            List<Object> out = new ArrayList<>();
            for (byte value : bytes) {
                out.add(Byte.toUnsignedInt(value));
            }
            return out;
        }
    }
}
