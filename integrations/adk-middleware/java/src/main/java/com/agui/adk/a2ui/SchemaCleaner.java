package com.agui.adk.a2ui;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.util.Iterator;
import java.util.Map;
import java.util.Set;

/**
 * Pure port of the Python {@code client_proxy_tool.py _clean_schema_for_genai}: recursively clean
 * a JSON Schema dict for {@code google.genai.types.Schema}.
 *
 * <p>Transformations (identical to Python): (1) strip {@code $}-prefixed keys ({@code $schema},
 * {@code $id}, {@code $ref}, {@code $defs}, {@code $comment}); (2) map {@code examples} -> a single
 * {@code example} (first element only), {@code const} -> {@code enum} (single-value list, non-string
 * values JSON-stringified), and {@code oneOf} -> {@code anyOf}; (3) filter remaining keys to an
 * allowlist (so e.g. {@code additionalProperties} from zod schemas, which the Gemini
 * {@code generateContent} function-calling API rejects, is stripped). {@code enum}/{@code example}/
 * {@code default} are kept as opaque values (not recursed).
 */
public final class SchemaCleaner {

    private static final Set<String> GENAI_REJECTED_SCHEMA_KEYS =
            Set.of("additionalProperties", "additional_properties");

    private static final Set<String> ALLOWED_SCHEMA_KEYS = Set.of(
            "type", "format", "description", "nullable", "enum", "example",
            "items", "properties", "required", "default", "title", "pattern",
            "minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength",
            "minProperties", "maxProperties", "anyOf", "ref", "defs", "propertyOrdering");

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private SchemaCleaner() {
    }

    /**
     * Recursively cleans a JSON schema node for google-genai {@code Schema}.
     *
     * @param schema the raw schema
     * @return the cleaned schema
     */
    public static JsonNode clean(JsonNode schema) {
        if (schema == null || schema.isNull()) {
            return schema;
        }
        if (schema.isObject()) {
            return cleanObject(schema);
        }
        if (schema.isArray()) {
            ArrayNode result = MAPPER.createArrayNode();
            for (JsonNode item : schema) {
                result.add(clean(item));
            }
            return result;
        }
        return schema;
    }

    /**
     * Cleans the supported fields of one schema object.
     *
     * @param schema source schema object
     * @return cleaned schema object
     */
    private static ObjectNode cleanObject(JsonNode schema) {
        ObjectNode result = MAPPER.createObjectNode();
        Iterator<Map.Entry<String, JsonNode>> fields = schema.fields();
        while (fields.hasNext()) {
            Map.Entry<String, JsonNode> entry = fields.next();
            cleanField(result, entry.getKey(), entry.getValue());
        }
        return result;
    }

    /**
     * Applies the cleaner's mapping and filtering rules to one schema field.
     *
     * @param result target schema object
     * @param key source field name
     * @param value source field value
     */
    private static void cleanField(ObjectNode result, String key, JsonNode value) {
        if (key.startsWith("$") || GENAI_REJECTED_SCHEMA_KEYS.contains(key)) {
            return;
        }
        if ("examples".equals(key) && value.isArray() && !value.isEmpty()) {
            result.set("example", value.get(0));
            return;
        }
        if ("const".equals(key)) {
            result.set("enum", singleValueEnum(value));
            return;
        }
        if ("oneOf".equals(key)) {
            result.set("anyOf", clean(value));
            return;
        }
        if (!ALLOWED_SCHEMA_KEYS.contains(key)) {
            return;
        }
        if (("properties".equals(key) || "defs".equals(key)) && value.isObject()) {
            result.set(key, cleanSchemaMap(value));
            return;
        }
        result.set(key, isOpaqueValue(key) ? value : clean(value));
    }

    /**
     * Builds the single-value enum used to represent a JSON Schema const.
     *
     * @param value const value
     * @return single-value enum array
     */
    private static ArrayNode singleValueEnum(JsonNode value) {
        ArrayNode values = MAPPER.createArrayNode();
        values.add(value.isTextual() ? value.textValue() : jsonStringify(value));
        return values;
    }

    /**
     * Recursively cleans a map whose keys are user-defined property or definition names.
     *
     * @param schemaMap source property or definition map
     * @return cleaned schema map
     */
    private static ObjectNode cleanSchemaMap(JsonNode schemaMap) {
        ObjectNode cleaned = MAPPER.createObjectNode();
        schemaMap.fields().forEachRemaining(entry -> cleaned.set(entry.getKey(), clean(entry.getValue())));
        return cleaned;
    }

    /**
     * Returns whether a schema value must be copied without recursive cleaning.
     *
     * @param key schema field name
     * @return true for opaque values
     */
    private static boolean isOpaqueValue(String key) {
        return "default".equals(key) || "example".equals(key) || "enum".equals(key);
    }

    /**
     * Serializes a JSON node to a compact JSON string (Python {@code json.dumps}).
     *
     * @param node the node to serialize
     * @return the compact JSON string
     */
    private static String jsonStringify(JsonNode node) {
        try {
            return MAPPER.writeValueAsString(node);
        } catch (JsonProcessingException e) {
            return node.toString();
        }
    }
}
