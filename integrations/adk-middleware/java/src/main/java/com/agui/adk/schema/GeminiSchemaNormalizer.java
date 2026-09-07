package com.agui.adk.schema;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;

/**
 * Normalizes the rich JSON Schema retained by AG-UI into the supported Gemini Schema subset.
 */
public final class GeminiSchemaNormalizer {

    private static final Set<String> SUPPORTED_FIELDS = Set.of(
            "anyOf", "default", "description", "enum", "example", "format", "items",
            "maxItems", "maxLength", "maxProperties", "maximum", "minItems", "minLength",
            "minProperties", "minimum", "nullable", "pattern", "properties", "propertyOrdering",
            "required", "title", "type");

    /** Terms holding instance data rather than nested schemas, copied verbatim like Python does. */
    private static final Set<String> OPAQUE_FIELDS = Set.of("default", "enum", "example");

    /**
     * Returns an independent, Gemini-compatible schema tree.
     *
     * @param source unmodified source JSON schema
     * @return normalized schema
     */
    public JsonNode normalize(JsonNode source) {
        if (source == null || !source.isObject()) {
            ObjectNode emptyObjectSchema = JsonNodeFactory.instance.objectNode();
            emptyObjectSchema.put("type", "object");
            emptyObjectSchema.set("properties", JsonNodeFactory.instance.objectNode());
            return emptyObjectSchema;
        }
        return normalizeNode(source);
    }

    /**
     * Recursively copies supported schema terms while stripping JSON Schema infrastructure.
     *
     * @param node node currently being normalized
     * @return independent normalized node
     */
    private JsonNode normalizeNode(JsonNode node) {
        if (node.isArray()) {
            ArrayNode result = JsonNodeFactory.instance.arrayNode();
            node.forEach(value -> result.add(normalizeNode(value)));
            return result;
        }
        if (!node.isObject()) {
            return node.deepCopy();
        }

        ObjectNode normalized = JsonNodeFactory.instance.objectNode();
        Iterator<Map.Entry<String, JsonNode>> fields = node.fields();
        while (fields.hasNext()) {
            Map.Entry<String, JsonNode> field = fields.next();
            String name = field.getKey();
            if (name.startsWith("$") || name.equals("additionalProperties")
                    || name.equals("additional_properties")) {
                continue;
            }
            if (name.equals("examples")) {
                copyFirstExample(normalized, field.getValue());
            } else if (name.equals("const")) {
                ArrayNode values = normalized.putArray("enum");
                values.add(constEnumValue(field.getValue()));
            } else if (name.equals("oneOf")) {
                normalized.set("anyOf", normalizeNode(field.getValue()));
            } else if (name.equals("properties")) {
                normalized.set(name, normalizeProperties(field.getValue()));
            } else if (OPAQUE_FIELDS.contains(name)) {
                normalized.set(name, field.getValue().deepCopy());
            } else if (SUPPORTED_FIELDS.contains(name)) {
                normalized.set(name, normalizeNode(field.getValue()));
            }
        }
        return normalized;
    }

    /**
     * Normalizes each schema mapped by a JSON Schema properties object.
     *
     * @param properties source properties object
     * @return independent normalized properties object
     */
    private JsonNode normalizeProperties(JsonNode properties) {
        if (!properties.isObject()) {
            return normalizeNode(properties);
        }
        ObjectNode normalized = JsonNodeFactory.instance.objectNode();
        properties.fields().forEachRemaining(field -> normalized.set(
                field.getKey(), normalizeNode(field.getValue())));
        return normalized;
    }

    /**
     * Stringifies a constant so it fits Gemini's string-only enum, as the Python middleware does.
     *
     * @param value source constant value
     * @return textual constants unchanged, every other constant as compact JSON
     */
    private static String constEnumValue(JsonNode value) {
        return value.isTextual() ? value.textValue() : value.toString();
    }

    /**
     * Converts a nonempty examples array into Gemini's single example field.
     *
     * @param normalized destination schema object
     * @param examples source examples value
     */
    private static void copyFirstExample(ObjectNode normalized, JsonNode examples) {
        if (examples.isArray() && !examples.isEmpty()) {
            normalized.set("example", examples.get(0).deepCopy());
        }
    }

}
