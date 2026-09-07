package com.agui.adk.input;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.agui.community.core.agent.RunAgentInput;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/**
 * Attaches compatibility extensions to copied official AG-UI run inputs.
 */
public final class RunExtensionSupport {

    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();

    private RunExtensionSupport() {
    }

    /**
     * Copies an official input and attaches the supplied extensions.
     *
     * @param source official input to copy
     * @param extensions compatibility extensions to attach
     * @return copied input carrying the extensions
     */
    public static RunAgentInput attach(RunAgentInput source, AdkRunExtensions extensions) {
        Objects.requireNonNull(source, "source");
        Objects.requireNonNull(extensions, "extensions");

        Map<String, Object> forwardedProps = copyForwardedProps(source.forwardedProps());
        if (forwardedProps.containsKey(AdkRunExtensions.FORWARDED_PROPS_KEY)) {
            throw RunInputValidator.invalidInput(
                    "forwarded properties must not contain reserved key "
                            + AdkRunExtensions.FORWARDED_PROPS_KEY);
        }
        forwardedProps.put(AdkRunExtensions.FORWARDED_PROPS_KEY, extensions);
        return copyWithForwardedProps(source, forwardedProps);
    }

    /**
     * Extracts extensions from typed or wire-decoded official input values.
     *
     * @param source official input to inspect
     * @return typed extensions, or empty when absent
     */
    public static Optional<AdkRunExtensions> extract(RunAgentInput source) {
        Objects.requireNonNull(source, "source");
        Map<String, Object> forwardedProps = copyForwardedProps(source.forwardedProps());
        if (!forwardedProps.containsKey(AdkRunExtensions.FORWARDED_PROPS_KEY)) {
            return Optional.empty();
        }
        Object value = forwardedProps.get(AdkRunExtensions.FORWARDED_PROPS_KEY);
        if (value instanceof AdkRunExtensions extensions) {
            return Optional.of(extensions);
        }
        if (value instanceof Map<?, ?> extensionMap) {
            return Optional.of(decodeExtensions(extensionMap));
        }
        throw invalidExtension("must be an object");
    }

    /**
     * Copies an official input without exposing the reserved extension property.
     *
     * @param source official input to copy
     * @return copied input without the reserved extension property
     */
    public static RunAgentInput detach(RunAgentInput source) {
        Objects.requireNonNull(source, "source");
        Map<String, Object> forwardedProps = copyForwardedProps(source.forwardedProps());
        forwardedProps.remove(AdkRunExtensions.FORWARDED_PROPS_KEY);
        return copyWithForwardedProps(source, forwardedProps);
    }

    /**
     * Decodes a Jackson-style map-shaped compatibility extension.
     *
     * @param source wire-decoded extension map
     * @return typed extension
     */
    private static AdkRunExtensions decodeExtensions(Map<?, ?> source) {
        Map<String, Object> values = copyStringKeyedMap(source, "reserved extension object");
        String parentRunId = optionalString(values.get("parentRunId"), "parentRunId");
        Object rawSchemasValue = values.get("rawToolSchemas");
        List<RawToolSchema> rawSchemas = rawSchemasValue == null
                ? List.of()
                : decodeRawToolSchemas(rawSchemasValue);
        AdkRunExtensions.RequestAction action = values.containsKey("action")
                ? decodeAction(values.get("action"))
                : null;
        try {
            return new AdkRunExtensions(parentRunId, rawSchemas, action);
        } catch (RuntimeException exception) {
            throw invalidExtension(exception.getMessage());
        }
    }

    /**
     * Decodes a strictly shaped request action.
     *
     * @param source candidate action object
     * @return immutable action value
     */
    private static AdkRunExtensions.RequestAction decodeAction(Object source) {
        if (!(source instanceof Map<?, ?> actionMap)) {
            throw invalidExtension("action must be an object");
        }
        Map<String, Object> values = copyStringKeyedMap(actionMap, "action");
        String kind = requiredString(values.get("kind"), "action.kind");
        try {
            return switch (kind) {
                case "auth" -> {
                    requireOnlyKeys(values, "kind", "requestId", "input");
                    yield new AdkRunExtensions.AuthAction(
                            requiredString(values.get("requestId"), "action.requestId"),
                            requiredMap(values.get("input"), "action.input"));
                }
                default -> throw invalidExtension("action.kind is unsupported");
            };
        } catch (IllegalArgumentException exception) {
            if (exception.getMessage().startsWith(RunInputValidator.ERROR_CODE)) {
                throw exception;
            }
            throw invalidExtension(exception.getMessage());
        }
    }

    /**
     * Rejects fields not defined by a discriminated action variant.
     *
     * @param values decoded action fields
     * @param allowed permitted field names
     */
    private static void requireOnlyKeys(Map<String, Object> values, String... allowed) {
        java.util.Set<String> permitted = java.util.Set.of(allowed);
        if (!permitted.containsAll(values.keySet())) {
            throw invalidExtension("action contains unsupported fields");
        }
    }

    /**
     * Decodes wire-shaped raw tool schemas.
     *
     * @param source candidate schema list
     * @return typed schemas
     */
    private static List<RawToolSchema> decodeRawToolSchemas(Object source) {
        if (!(source instanceof List<?> schemas)) {
            throw invalidExtension("rawToolSchemas must be a list");
        }
        List<RawToolSchema> decoded = new ArrayList<>(schemas.size());
        for (Object schemaValue : schemas) {
            if (!(schemaValue instanceof Map<?, ?> schemaMap)) {
                throw invalidExtension("rawToolSchemas entries must be objects");
            }
            Map<String, Object> values = copyStringKeyedMap(
                    schemaMap, "rawToolSchemas entries");
            int position = requiredInteger(values.get("position"), "position");
            String name = requiredString(values.get("name"), "name");
            Object rawSchema = values.get("schema");
            if (rawSchema == null) {
                throw invalidExtension("schema must not be null");
            }
            JsonNode schema = OBJECT_MAPPER.valueToTree(rawSchema);
            try {
                decoded.add(new RawToolSchema(position, name, schema));
            } catch (RuntimeException exception) {
                throw invalidExtension(exception.getMessage());
            }
        }
        return List.copyOf(decoded);
    }

    /**
     * Copies forwarded properties after validating their public shape.
     *
     * @param source forwarded properties to copy
     * @return mutable copy preserving every entry
     */
    private static Map<String, Object> copyForwardedProps(Object source) {
        if (source == null) {
            return new LinkedHashMap<>();
        }
        if (!(source instanceof Map<?, ?> sourceMap)) {
            throw RunInputValidator.invalidInput("forwardedProps must be null or a map");
        }
        return copyStringKeyedMap(sourceMap, "forwardedProps");
    }

    /**
     * Copies a map whose keys must all be strings.
     *
     * @param source map to copy
     * @param name validation name
     * @return mutable string-keyed copy
     */
    private static Map<String, Object> copyStringKeyedMap(Map<?, ?> source, String name) {
        Map<String, Object> copy = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : source.entrySet()) {
            if (!(entry.getKey() instanceof String key)) {
                throw RunInputValidator.invalidInput(name + " must contain only string keys");
            }
            copy.put(key, entry.getValue());
        }
        return copy;
    }

    /**
     * Returns an optional string without coercion.
     *
     * @param value candidate value
     * @param name field name
     * @return string or {@code null}
     */
    private static String optionalString(Object value, String name) {
        if (value == null) {
            return null;
        }
        return requiredString(value, name);
    }

    /**
     * Returns a required string without coercion.
     *
     * @param value candidate value
     * @param name field name
     * @return string value
     */
    private static String requiredString(Object value, String name) {
        if (!(value instanceof String string)) {
            throw invalidExtension(name + " must be a string");
        }
        return string;
    }

    /**
     * Returns an immutable string-keyed map without coercion.
     *
     * @param value candidate value
     * @param name field name
     * @return immutable map
     */
    private static Map<String, Object> requiredMap(Object value, String name) {
        if (!(value instanceof Map<?, ?> map)) {
            throw invalidExtension(name + " must be an object");
        }
        return Collections.unmodifiableMap(copyStringKeyedMap(map, name));
    }

    /**
     * Returns a required integer without numeric truncation.
     *
     * @param value candidate value
     * @param name field name
     * @return integer value
     */
    private static int requiredInteger(Object value, String name) {
        if (!(value instanceof Byte
                || value instanceof Short
                || value instanceof Integer
                || value instanceof Long)) {
            throw invalidExtension(name + " must be an integer");
        }
        long longValue = ((Number) value).longValue();
        if (longValue < Integer.MIN_VALUE || longValue > Integer.MAX_VALUE) {
            throw invalidExtension(name + " is outside the integer range");
        }
        return (int) longValue;
    }

    /**
     * Creates a stable reserved-extension validation failure.
     *
     * @param detail validation detail
     * @return invalid-input exception
     */
    private static IllegalArgumentException invalidExtension(String detail) {
        return RunInputValidator.invalidInput(
                AdkRunExtensions.FORWARDED_PROPS_KEY + " " + detail);
    }

    /**
     * Creates an official input copy with immutable forwarded properties.
     *
     * @param source official input to copy
     * @param forwardedProps forwarded properties for the copy
     * @return copied official input
     */
    private static RunAgentInput copyWithForwardedProps(
            RunAgentInput source,
            Map<String, Object> forwardedProps) {
        return new RunAgentInput(
                source.threadId(),
                source.runId(),
                source.state(),
                source.messages(),
                source.tools(),
                source.context(),
                Collections.unmodifiableMap(new LinkedHashMap<>(forwardedProps)),
                source.resume());
    }
}
