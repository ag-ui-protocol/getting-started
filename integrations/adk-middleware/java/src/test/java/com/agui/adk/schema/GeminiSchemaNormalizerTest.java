package com.agui.adk.schema;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.agui.adk.input.RawToolSchema;
import com.agui.adk.tool.ToolNameValidator;
import com.agui.community.core.tool.Tool;
import com.agui.community.core.tool.ToolParameters;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class GeminiSchemaNormalizerTest {

    private final ObjectMapper mapper = new ObjectMapper();
    private final GeminiSchemaNormalizer normalizer = new GeminiSchemaNormalizer();

    @Test
    void stripsLocalDefsAndReferencesWithoutMutatingSource() throws Exception {
        JsonNode source = mapper.readTree("""
                {"type":"object","$defs":{"entry":{"type":"object","additionalProperties":false,
                "properties":{"id":{"type":"string"}}}},"properties":{"entries":{"type":"array",
                "items":{"$ref":"#/$defs/entry"}}}}
                """);

        JsonNode normalized = normalizer.normalize(source);

        assertThat(normalized.at("/properties/entries/items").isObject()).isTrue();
        assertThat(normalized.at("/properties/entries/items").isEmpty()).isTrue();
        assertThat(normalized.toString()).doesNotContain("$defs", "$ref", "additionalProperties", "id");
        assertThat(source.at("/$defs/entry/additionalProperties").asBoolean()).isFalse();
    }

    @Test
    void stripsLegacyDefinitionsAndReferencedContent() throws Exception {
        JsonNode source = mapper.readTree("""
                {"type":"object","definitions":{"choice":{"oneOf":[{"const":"a","examples":["first","second"]},
                {"type":"object","additional_properties":true,"properties":{"nested":{"const":4}}}]}},
                "properties":{"value":{"$ref":"#/definitions/choice"}}}
                """);

        JsonNode normalized = normalizer.normalize(source);

        assertThat(normalized.at("/properties/value").isObject()).isTrue();
        assertThat(normalized.at("/properties/value").isEmpty()).isTrue();
        assertThat(normalized.toString()).doesNotContain("definitions", "$ref", "choice", "nested");
    }

    @Test
    void degradesCyclicAndUnresolvedLocalReferencesWithoutFailingTheRun() throws Exception {
        JsonNode cyclic = mapper.readTree("""
                {"$defs":{"node":{"$ref":"#/$defs/node"}},"$ref":"#/$defs/node"}
                """);
        JsonNode unresolved = mapper.readTree("""
                {"type":"object","properties":{"missing":{"$ref":"#/$defs/missing"}}}
                """);

        assertThat(normalizer.normalize(cyclic).isObject()).isTrue();
        assertThat(normalizer.normalize(unresolved).at("/properties/missing").isObject()).isTrue();
    }

    @Test
    void dropsUnresolvableReferencesWhilePreservingSiblingSchemaTerms() throws Exception {
        JsonNode source = mapper.readTree("""
                {"type":"object","properties":{
                "missing":{"$ref":"#/$defs/absent","type":"string","description":"kept","minLength":2},
                "remote":{"$ref":"https://example.com/schema.json","type":"number"},
                "cyclic":{"$ref":"#/properties/cyclic","title":"loop"}},
                "required":["missing"]}
                """);

        JsonNode normalized = normalizer.normalize(source);

        assertThat(normalized.at("/properties/missing/type").asText()).isEqualTo("string");
        assertThat(normalized.at("/properties/missing/description").asText()).isEqualTo("kept");
        assertThat(normalized.at("/properties/missing/minLength").asInt()).isEqualTo(2);
        assertThat(normalized.at("/properties/remote/type").asText()).isEqualTo("number");
        assertThat(normalized.at("/properties/cyclic/title").asText()).isEqualTo("loop");
        assertThat(normalized.at("/required/0").asText()).isEqualTo("missing");
        assertThat(normalized.toString()).doesNotContain("$ref");
        assertThat(new GeminiSchemaConverter().convert(source).properties().orElseThrow())
                .containsKeys("missing", "remote", "cyclic");
    }

    @Test
    void stringifiesNonStringConstantsIntoTheStringOnlyGeminiEnum() throws Exception {
        GeminiSchemaConverter converter = new GeminiSchemaConverter();

        assertThat(normalizer.normalize(mapper.readTree("{\"const\":42}")).at("/enum/0").textValue())
                .isEqualTo("42");
        assertThat(normalizer.normalize(mapper.readTree("{\"const\":true}")).at("/enum/0").textValue())
                .isEqualTo("true");
        assertThat(normalizer.normalize(mapper.readTree("{\"const\":null}")).at("/enum/0").textValue())
                .isEqualTo("null");
        assertThat(normalizer.normalize(mapper.readTree("{\"const\":{\"a\":1}}")).at("/enum/0").textValue())
                .isEqualTo("{\"a\":1}");
        assertThat(normalizer.normalize(mapper.readTree("{\"const\":\"kept\"}")).at("/enum/0").textValue())
                .isEqualTo("kept");
        assertThat(converter.convert(mapper.readTree("{\"type\":\"integer\",\"const\":42}")).enum_())
                .contains(List.of("42"));
        assertThat(converter.convert(mapper.readTree("{\"type\":\"boolean\",\"const\":true}")).enum_())
                .contains(List.of("true"));
    }

    @Test
    void preservesNestedArrayObjectConstraintsWhileRemovingUnsupportedKeywords() throws Exception {
        JsonNode source = mapper.readTree("""
                {"type":"object","minProperties":1,"additionalProperties":false,"properties":{"rows":{"type":"array",
                "minItems":1,"items":{"type":"object","required":["name"],"additionalProperties":false,
                "properties":{"name":{"type":"string","minLength":2,"maxLength":8,"pattern":"[a-z]+"},
                "score":{"type":"number","minimum":0,"maximum":10}}}}}}
                """);

        JsonNode normalized = normalizer.normalize(source);

        assertThat(normalized.at("/minProperties").asInt()).isEqualTo(1);
        assertThat(normalized.at("/properties/rows/minItems").asInt()).isEqualTo(1);
        assertThat(normalized.at("/properties/rows/items/required/0").asText()).isEqualTo("name");
        assertThat(normalized.at("/properties/rows/items/properties/name/pattern").asText()).isEqualTo("[a-z]+");
        assertThat(normalized.at("/properties/rows/items/properties/score/maximum").asInt()).isEqualTo(10);
        assertThat(normalized.toString()).doesNotContain("additionalProperties");
    }

    @Test
    void rejectsNonStringEnumValuesWithoutCoercion() throws Exception {
        GeminiSchemaConverter converter = new GeminiSchemaConverter();

        for (String value : List.of("1", "true", "null", "{}")) {
            assertThatThrownBy(() -> converter.convert(mapper.readTree(
                    "{\"type\":\"string\",\"enum\":[\"valid\"," + value + "]}")))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("UNSUPPORTED_TOOL_SCHEMA")
                    .hasMessageContaining("enum values must be strings");
        }
    }

    @Test
    void coercesPydanticCompatibleStringConstraints() throws Exception {
        GeminiSchemaConverter converter = new GeminiSchemaConverter();
        com.google.genai.types.Schema schema = converter.convert(mapper.readTree("""
                {"maxItems":" 2 ","minLength":-1.0,"minimum":"1.5","nullable":"false"}
                """));

        assertThat(schema.maxItems()).contains(2L);
        assertThat(schema.minLength()).contains(-1L);
        assertThat(schema.minimum()).contains(1.5);
        assertThat(schema.nullable()).contains(false);
    }

    @Test
    void rejectsWrongScalarConstraintTypesThatPydanticDoesNotCoerce() throws Exception {
        GeminiSchemaConverter converter = new GeminiSchemaConverter();

        for (String schema : List.of(
                "{\"description\":1}",
                "{\"format\":false}",
                "{\"pattern\":null}",
                "{\"title\":{}}",
                "{\"type\":[]}",
                "{\"nullable\":\"not-a-boolean\"}")) {
            assertUnsupported(() -> converter.convert(mapper.readTree(schema)));
        }
    }

    @Test
    void rejectsScientificNotationStringsForIntegralConstraints() throws Exception {
        GeminiSchemaConverter converter = new GeminiSchemaConverter();

        for (String name : List.of(
                "maxItems", "maxLength", "maxProperties",
                "minItems", "minLength", "minProperties")) {
            assertUnsupported(() -> converter.convert(mapper.readTree(
                    "{\"" + name + "\":\"1e2\"}")));
        }

        com.google.genai.types.Schema accepted = converter.convert(mapper.readTree(
                "{\"maxItems\":\" 100 \",\"minItems\":\"-2\"}"));
        assertThat(accepted.maxItems()).contains(100L);
        assertThat(accepted.minItems()).contains(-2L);
    }

    @Test
    void coercesBooleanNumericBoundsLikePydantic() throws Exception {
        GeminiSchemaConverter converter = new GeminiSchemaConverter();

        com.google.genai.types.Schema schema = converter.convert(mapper.readTree(
                "{\"minimum\":false,\"maximum\":true}"));

        assertThat(schema.minimum()).contains(0.0);
        assertThat(schema.maximum()).contains(1.0);
    }

    @Test
    void acceptsJsonNullNullableAsAnUnsetOptionalBoolean() throws Exception {
        GeminiSchemaConverter converter = new GeminiSchemaConverter();

        com.google.genai.types.Schema schema = converter.convert(mapper.readTree(
                "{\"type\":\"object\",\"nullable\":null}"));

        assertThat(schema.nullable()).isEmpty();
    }

    @Test
    void rejectsInvalidIntegralConstraintDomainsWithoutTruncation() throws Exception {
        GeminiSchemaConverter converter = new GeminiSchemaConverter();

        for (String schema : List.of(
                "{\"maxItems\":1.5}",
                "{\"maxItems\":\"1.5\"}",
                "{\"maxProperties\":null}",
                "{\"minProperties\":[]}",
                "{\"maxItems\":9223372036854775808}")) {
            assertUnsupported(() -> converter.convert(mapper.readTree(schema)));
        }
    }

    @Test
    void rejectsWrongCompositeSchemaShapesWithoutDroppingThem() throws Exception {
        GeminiSchemaConverter converter = new GeminiSchemaConverter();

        for (String schema : List.of(
                "{\"enum\":\"value\"}",
                "{\"required\":{}}",
                "{\"propertyOrdering\":null}",
                "{\"anyOf\":{}}",
                "{\"properties\":[]}",
                "{\"items\":\"string\"}")) {
            assertUnsupported(() -> converter.convert(mapper.readTree(schema)));
        }
    }

    @Test
    void passesCompositeDefaultAndExampleValuesThroughInsteadOfFailingTheRun() throws Exception {
        GeminiSchemaConverter converter = new GeminiSchemaConverter();

        for (String schema : List.of(
                "{\"default\":{}}",
                "{\"default\":[]}",
                "{\"default\":null}",
                "{\"example\":{}}",
                "{\"example\":[]}",
                "{\"example\":null}")) {
            assertThat(converter.convert(mapper.readTree(schema))).isNotNull();
        }

        com.google.genai.types.Schema composite = converter.convert(mapper.readTree("""
                {"type":"object","default":{"nested":{"flag":true}},"example":[1,"two"]}
                """));

        assertThat(composite.default_()).contains(Map.of("nested", Map.of("flag", true)));
        assertThat(composite.example()).contains(List.of(1, "two"));
    }

    @Test
    void dropsNullDefaultAndExampleValuesGenAiCannotRepresent() throws Exception {
        GeminiSchemaConverter converter = new GeminiSchemaConverter();

        com.google.genai.types.Schema schema = converter.convert(
                mapper.readTree("{\"type\":\"string\",\"default\":null,\"example\":null}"));

        assertThat(schema.default_()).isEmpty();
        assertThat(schema.example()).isEmpty();
    }

    @Test
    void convertsValidatedConstraintsToGoogleSchemaWithoutLoss() throws Exception {
        GeminiSchemaConverter converter = new GeminiSchemaConverter();
        com.google.genai.types.Schema schema = converter.convert(mapper.readTree("""
                {"type":"object","description":"A result","nullable":false,
                "default":"fallback","example":2,
                "minimum":-1.5,"maximum":2.5,"minProperties":0,"maxProperties":3,
                "required":["name"],"propertyOrdering":["name"],
                "properties":{"name":{"type":"string","title":"Name","format":"text",
                "pattern":"[a-z]+","minLength":1,"maxLength":10,"enum":["a","b"]},
                "tags":{"type":"array","minItems":0,"maxItems":2,"items":{"type":"string"}}}}
                """));

        assertThat(schema.description()).contains("A result");
        assertThat(schema.nullable()).contains(false);
        assertThat(schema.minimum()).contains(-1.5);
        assertThat(schema.maximum()).contains(2.5);
        assertThat(schema.minProperties()).contains(0L);
        assertThat(schema.maxProperties()).contains(3L);
        assertThat(schema.required()).contains(List.of("name"));
        assertThat(schema.propertyOrdering()).contains(List.of("name"));
        assertThat(schema.properties().orElseThrow().get("name").enum_()).contains(List.of("a", "b"));
        assertThat(schema.properties().orElseThrow().get("tags").items().orElseThrow().type().orElseThrow()
                .toString()).isEqualTo("STRING");
        assertThat(mapper.readTree(schema.toJson()).get("default")).isEqualTo(mapper.readTree("\"fallback\""));
        assertThat(mapper.readTree(schema.toJson()).get("example")).isEqualTo(mapper.readTree("2"));
    }

    @Test
    void appliesLastWriteWinsWhenConstAndEnumAreBothPresent() throws Exception {
        JsonNode constThenEnum = normalizer.normalize(mapper.readTree(
                "{\"const\":\"fixed\",\"enum\":[\"other\"]}"));
        JsonNode enumThenConst = normalizer.normalize(mapper.readTree(
                "{\"enum\":[\"other\"],\"const\":\"fixed\"}"));

        assertThat(constThenEnum.at("/enum/0").asText()).isEqualTo("other");
        assertThat(enumThenConst.at("/enum/0").asText()).isEqualTo("fixed");
    }

    @Test
    void acceptsNegativeAndLargeConstraintsWithGenAiApiCoercion() throws Exception {
        GeminiSchemaConverter converter = new GeminiSchemaConverter();
        com.google.genai.types.Schema schema = converter.convert(mapper.readTree(
                "{\"minItems\":-1,\"maxItems\":9223372036854775807,"
                        + "\"minimum\":9007199254740993,\"maximum\":-9007199254740993}"));

        assertThat(schema.minItems()).contains(-1L);
        assertThat(schema.maxItems()).contains(Long.MAX_VALUE);
        assertThat(schema.minimum()).contains(9007199254740992.0);
        assertThat(schema.maximum()).contains(-9007199254740992.0);
    }

    @Test
    void preservesLosslesslyRepresentableIntegerAndDecimalBoundsInTheGenAiApi() throws Exception {
        GeminiSchemaConverter converter = new GeminiSchemaConverter();
        com.google.genai.types.Schema schema = converter.convert(mapper.readTree(
                "{\"minimum\":9007199254740992,\"maximum\":0.1}"));
        JsonNode serialized = mapper.readTree(schema.toJson());

        assertThat(serialized.get("minimum").decimalValue())
                .isEqualByComparingTo("9007199254740992");
        assertThat(serialized.get("maximum").decimalValue()).isEqualByComparingTo("0.1");
    }

    private static void assertUnsupported(org.assertj.core.api.ThrowableAssert.ThrowingCallable conversion) {
        assertThatThrownBy(conversion)
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageStartingWith("INVALID_RUN_INPUT: UNSUPPORTED_TOOL_SCHEMA: ");
    }

    @Test
    void rejectsDuplicateFrontendToolNamesInRequestOrder() throws Exception {
        Tool first = new Tool("client_action", "first", new ToolParameters(Map.of(), List.of()));
        Tool second = new Tool("client_action", "second", new ToolParameters(Map.of(), List.of()));
        JsonNode schema = mapper.readTree("{\"type\":\"object\"}");

        assertThatThrownBy(() -> ToolNameValidator.validatePairs(List.of(first, second), List.of(
                new RawToolSchema(0, "client_action", schema),
                new RawToolSchema(1, "client_action", schema))))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("DUPLICATE_TOOL_NAME: client_action");
    }

    @Test
    void rejectsMissingExtraDuplicateAndMismatchedRawSchemaPairs() throws Exception {
        Tool first = new Tool("first", "first", new ToolParameters(Map.of(), List.of()));
        Tool second = new Tool("second", "second", new ToolParameters(Map.of(), List.of()));
        JsonNode schema = mapper.readTree("{" + "\"type\":\"object\"}");

        assertThatThrownBy(() -> ToolNameValidator.validatePairs(List.of(first, second), List.of(
                new RawToolSchema(0, "first", schema))))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("INVALID_RUN_INPUT")
                .hasMessageContaining("missing");
        assertThatThrownBy(() -> ToolNameValidator.validatePairs(List.of(first, second), List.of(
                new RawToolSchema(0, "first", schema), new RawToolSchema(2, "second", schema))))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("INVALID_RUN_INPUT")
                .hasMessageContaining("outside");
        assertThatThrownBy(() -> ToolNameValidator.validatePairs(List.of(first), List.of(
                new RawToolSchema(0, "different", schema))))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("INVALID_RUN_INPUT")
                .hasMessageContaining("does not match");
        assertThatThrownBy(() -> ToolNameValidator.validatePairs(List.of(first), List.of(
                new RawToolSchema(0, "first", schema), new RawToolSchema(0, "first", schema))))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("INVALID_RUN_INPUT")
                .hasMessageContaining("duplicate");
    }
}
