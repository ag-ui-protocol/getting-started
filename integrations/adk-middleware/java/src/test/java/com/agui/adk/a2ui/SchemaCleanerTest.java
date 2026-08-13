package com.agui.adk.a2ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import org.junit.jupiter.api.Test;

class SchemaCleanerTest {

    private static final ObjectMapper M = new ObjectMapper();

    private static JsonNode json(String s) throws Exception {
        return M.readTree(s);
    }

    @Test
    void stripsDollarPrefixedAndRejectedKeys() throws Exception {
        JsonNode out = SchemaCleaner.clean(json(
                "{\"$schema\":\"x\",\"$id\":\"y\",\"type\":\"object\","
                + "\"additionalProperties\":false,\"description\":\"d\"}"));
        assertThat(out.get("type").asText()).isEqualTo("object");
        assertThat(out.get("description").asText()).isEqualTo("d");
        assertThat(out.has("$schema")).isFalse();
        assertThat(out.has("$id")).isFalse();
        assertThat(out.has("additionalProperties")).isFalse();
    }

    @Test
    void mapsExamplesFirstToExample() throws Exception {
        JsonNode out = SchemaCleaner.clean(json("{\"examples\":[1,2,3]}"));
        assertThat(out.has("examples")).isFalse();
        assertThat(out.get("example").asInt()).isEqualTo(1);
    }

    @Test
    void mapsConstToStringOrJsonEnum() throws Exception {
        JsonNode s = SchemaCleaner.clean(json("{\"const\":\"abc\"}"));
        assertThat(s.get("enum").get(0).asText()).isEqualTo("abc");
        JsonNode n = SchemaCleaner.clean(json("{\"const\":42}"));
        assertThat(n.get("enum").get(0).asText()).isEqualTo("42");
    }

    @Test
    void mapsOneOfToAnyOf() throws Exception {
        JsonNode out = SchemaCleaner.clean(json("{\"oneOf\":[{\"type\":\"string\"}]}"));
        assertThat(out.has("oneOf")).isFalse();
        assertThat(out.get("anyOf").get(0).get("type").asText()).isEqualTo("string");
    }

    @Test
    void allowlistsUnknownKeysAndRecursesPropertiesPreservingNames() throws Exception {
        JsonNode out = SchemaCleaner.clean(json(
                "{\"type\":\"object\",\"foo\":1,\"properties\":{\"a\":{\"type\":\"string\"},"
                + "\"b\":{\"additionalProperties\":true,\"type\":\"number\"}}}"));
        assertThat(out.has("foo")).isFalse();
        assertThat(out.get("properties").get("a").get("type").asText()).isEqualTo("string");
        assertThat(out.get("properties").get("b").has("additionalProperties")).isFalse();
        assertThat(out.get("properties").get("b").get("type").asText()).isEqualTo("number");
    }

    @Test
    void keepsEnumExampleDefaultOpaque() throws Exception {
        JsonNode out = SchemaCleaner.clean(json(
                "{\"enum\":[\"x\",{\"k\":1}],\"default\":{\"n\":2}}"));
        assertThat(out.get("enum").get(1).get("k").asInt()).isEqualTo(1);
        assertThat(out.get("default").get("n").asInt()).isEqualTo(2);
    }

    @Test
    void recursesArrays() throws Exception {
        JsonNode out = SchemaCleaner.clean(json("[{\"$ref\":\"#\",\"type\":\"string\"}]"));
        assertThat(out.isArray()).isTrue();
        assertThat(out.get(0).has("$ref")).isFalse();
        assertThat(out.get(0).get("type").asText()).isEqualTo("string");
    }
}
