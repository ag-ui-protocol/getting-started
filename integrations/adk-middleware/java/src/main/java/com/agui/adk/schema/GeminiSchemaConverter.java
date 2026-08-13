package com.agui.adk.schema;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.genai.types.Schema;
import com.google.genai.types.Type;
import com.agui.adk.input.RunInputValidator;

import java.math.BigDecimal;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Converts normalized JSON Schema into the Google GenAI Java schema model.
 */
public final class GeminiSchemaConverter {

    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();

    private static final TypeReference<Map<String, Object>> MAP_VALUE = new TypeReference<>() { };

    private static final TypeReference<List<Object>> LIST_VALUE = new TypeReference<>() { };

    private final GeminiSchemaNormalizer normalizer;

    /** Creates a converter with the standard schema normalizer. */
    public GeminiSchemaConverter() {
        this(new GeminiSchemaNormalizer());
    }

    /**
     * Creates a converter with an explicit normalizer.
     *
     * @param normalizer rich schema normalizer
     */
    public GeminiSchemaConverter(GeminiSchemaNormalizer normalizer) {
        this.normalizer = normalizer;
    }

    /**
     * Normalizes and converts a rich JSON schema.
     *
     * @param source rich source schema
     * @return GenAI schema
     */
    public Schema convert(JsonNode source) {
        return convertNormalized(normalizer.normalize(source));
    }

    /**
     * Maps one normalized JSON schema object to GenAI's immutable schema model.
     *
     * @param schema normalized JSON schema
     * @return immutable GenAI schema
     */
    private Schema convertNormalized(JsonNode schema) {
        if (!schema.isObject()) {
            throw unsupported("schema nodes must be objects");
        }
        Schema.Builder builder = Schema.builder();
        text(schema, "description", builder::description);
        text(schema, "format", builder::format);
        text(schema, "pattern", builder::pattern);
        text(schema, "title", builder::title);
        type(schema, builder);
        if (schema.has("nullable") && !schema.get("nullable").isNull()) {
            builder.nullable(booleanValue(schema.get("nullable"), "nullable"));
        }
        if (schema.has("default")) {
            apiJsonValue(schema.get("default")).ifPresent(builder::default_);
        }
        if (schema.has("example")) {
            apiJsonValue(schema.get("example")).ifPresent(builder::example);
        }
        stringArray(schema, "enum", builder::enum_);
        stringArray(schema, "required", builder::required);
        stringArray(schema, "propertyOrdering", builder::propertyOrdering);
        if (schema.has("items")) {
            JsonNode items = schema.get("items");
            requireObject(items, "items");
            builder.items(convertNormalized(items));
        }
        if (schema.has("anyOf")) {
            JsonNode anyOf = schema.get("anyOf");
            requireArray(anyOf, "anyOf");
            builder.anyOf(schemas(anyOf, "anyOf"));
        }
        if (schema.has("properties")) {
            JsonNode sourceProperties = schema.get("properties");
            requireObject(sourceProperties, "properties");
            Map<String, Schema> properties = new LinkedHashMap<>();
            sourceProperties.fields().forEachRemaining(field -> {
                requireObject(field.getValue(), "properties entries");
                properties.put(field.getKey(), convertNormalized(field.getValue()));
            });
            builder.properties(properties);
        }
        integer(schema, "maxItems", builder::maxItems);
        integer(schema, "maxLength", builder::maxLength);
        integer(schema, "maxProperties", builder::maxProperties);
        integer(schema, "minItems", builder::minItems);
        integer(schema, "minLength", builder::minLength);
        integer(schema, "minProperties", builder::minProperties);
        number(schema, "maximum", builder::maximum);
        number(schema, "minimum", builder::minimum);
        return builder.build();
    }

    /**
     * Converts a JSON string array to a GenAI string collection when present.
     *
     * @param schema normalized JSON schema
     * @param name schema field name
     * @param setter GenAI builder setter
     */
    private static void stringArray(
            JsonNode schema, String name, java.util.function.Consumer<List<String>> setter) {
        if (!schema.has(name)) {
            return;
        }
        JsonNode values = schema.get(name);
        requireArray(values, name);
        setter.accept(java.util.stream.StreamSupport.stream(values.spliterator(), false)
                .map(value -> {
                    if (!value.isTextual()) {
                        throw unsupported(name + " values must be strings");
                    }
                    return value.textValue();
                })
                .toList());
    }

    /**
     * Converts each validated composite branch recursively.
     *
     * @param values composite schema branches
     * @param name schema field name
     * @return converted GenAI schema branches
     */
    private List<Schema> schemas(JsonNode values, String name) {
        return java.util.stream.StreamSupport.stream(values.spliterator(), false)
                .map(value -> {
                    requireObject(value, name + " entries");
                    return convertNormalized(value);
                })
                .toList();
    }

    /**
     * Converts a JSON default or example into the value GenAI keeps in its opaque Object API.
     *
     * <p>Composite values pass through as maps and lists the way the Python middleware forwards
     * them untouched. JSON nulls carry no information GenAI can hold, so the term is dropped
     * instead of failing the run.
     *
     * @param value JSON value
     * @return equivalent GenAI API value, or empty when the term carries no representable value
     */
    private static Optional<Object> apiJsonValue(JsonNode value) {
        if (value.isTextual()) {
            return Optional.of(value.textValue());
        }
        if (value.isNumber()) {
            return Optional.of(value.numberValue());
        }
        if (value.isBoolean()) {
            return Optional.of(value.booleanValue());
        }
        if (value.isObject()) {
            return Optional.of(OBJECT_MAPPER.convertValue(value, MAP_VALUE));
        }
        if (value.isArray()) {
            return Optional.of(OBJECT_MAPPER.convertValue(value, LIST_VALUE));
        }
        return Optional.empty();
    }

    /**
     * Applies an optional text field to a schema builder.
     *
     * @param schema normalized JSON schema
     * @param name schema field name
     * @param setter GenAI builder setter
     */
    private static void text(JsonNode schema, String name, java.util.function.Consumer<String> setter) {
        if (!schema.has(name)) {
            return;
        }
        JsonNode value = schema.get(name);
        if (!value.isTextual()) {
            throw unsupported(name + " must be a string");
        }
        setter.accept(value.textValue());
    }

    /**
     * Applies and validates an optional GenAI type value.
     *
     * @param schema normalized JSON schema
     * @param builder GenAI schema builder
     */
    private static void type(JsonNode schema, Schema.Builder builder) {
        if (!schema.has("type")) {
            return;
        }
        JsonNode value = schema.get("type");
        if (!value.isTextual()) {
            throw unsupported("type must be a string");
        }
        try {
            Type.Known type = Type.Known.valueOf(value.textValue().toUpperCase(Locale.ROOT));
            if (type == Type.Known.TYPE_UNSPECIFIED) {
                throw unsupported("type must be a supported GenAI type");
            }
            builder.type(type);
        } catch (IllegalArgumentException error) {
            throw unsupported("type must be a supported GenAI type");
        }
    }

    /**
     * Applies a Pydantic-compatible integer constraint to the GenAI builder.
     *
     * @param schema normalized JSON schema
     * @param name schema field name
     * @param setter GenAI builder setter
     */
    private static void integer(
            JsonNode schema, String name, java.util.function.Consumer<Long> setter) {
        if (!schema.has(name)) {
            return;
        }
        JsonNode value = schema.get(name);
        if (value.isBoolean()) {
            setter.accept(value.booleanValue() ? 1L : 0L);
            return;
        }
        if (value.isNumber()) {
            try {
                setter.accept(value.decimalValue().longValueExact());
                return;
            } catch (ArithmeticException ignored) {
                // Fall through to the stable unsupported-schema error.
            }
        }
        if (value.isTextual()) {
            String integerText = value.textValue().trim();
            if (integerText.matches("[+-]?\\d+")) {
                try {
                    setter.accept(new BigDecimal(integerText).longValueExact());
                    return;
                } catch (ArithmeticException | NumberFormatException ignored) {
                    // Fall through to the stable unsupported-schema error.
                }
            }
        }
        throw unsupported(name + " must be a representable integer or integer string");
    }

    /**
     * Applies a Pydantic-compatible numeric constraint to the GenAI builder.
     *
     * @param schema normalized JSON schema
     * @param name schema field name
     * @param setter GenAI builder setter
     */
    private static void number(
            JsonNode schema, String name, java.util.function.Consumer<Double> setter) {
        if (!schema.has(name)) {
            return;
        }
        JsonNode value = schema.get(name);
        if (value.isBoolean()) {
            setter.accept(value.booleanValue() ? 1.0 : 0.0);
            return;
        }
        if (value.isNumber()) {
            setter.accept(value.doubleValue());
            return;
        }
        if (value.isTextual()) {
            try {
                setter.accept(Double.parseDouble(value.textValue()));
                return;
            } catch (NumberFormatException ignored) {
                // Fall through to the stable unsupported-schema error.
            }
        }
        throw unsupported(name + " must be a number or numeric string");
    }

    /**
     * Coerces the boolean spellings accepted by Pydantic.
     *
     * @param value retained nullable value
     * @param name schema field name
     * @return coerced boolean
     */
    private static boolean booleanValue(JsonNode value, String name) {
        if (value.isBoolean()) {
            return value.booleanValue();
        }
        if (value.isTextual()) {
            String text = value.textValue().toLowerCase(Locale.ROOT);
            if (Set.of("true", "1", "on", "yes", "y", "t").contains(text)) {
                return true;
            }
            if (Set.of("false", "0", "off", "no", "n", "f").contains(text)) {
                return false;
            }
        }
        if (value.isNumber()) {
            double number = value.doubleValue();
            if (number == 0.0 || number == 1.0) {
                return number == 1.0;
            }
        }
        throw unsupported(name + " must be a boolean or boolean string");
    }

    /**
     * Requires an array-valued retained field.
     *
     * @param value retained field value
     * @param name retained field name
     */
    private static void requireArray(JsonNode value, String name) {
        if (!value.isArray()) {
            throw unsupported(name + " must be an array");
        }
    }

    /**
     * Requires an object-valued retained field.
     *
     * @param value retained field value
     * @param name retained field name
     */
    private static void requireObject(JsonNode value, String name) {
        if (!value.isObject()) {
            throw unsupported(name + " must be an object");
        }
    }

    private static IllegalArgumentException unsupported(String detail) {
        return RunInputValidator.invalidInput("UNSUPPORTED_TOOL_SCHEMA: " + detail);
    }
}
