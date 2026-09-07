package com.agui.adk.a2ui;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * P0 #1 (SDK-independent subset) — A2UI JSON argument healing, ported from the Python
 * {@code heal_json_arg} / {@code parse_and_fix} ({@code a2ui_google_sdk.py}, oss-158):
 * smart-quote normalization, trailing-comma autofix, single-object-to-list wrapping, and the
 * {@code expect="list"/"dict"} unwrap semantics.
 */
class A2uiJsonHealerTest {

    @Test
    void singleObjectIsWrappedInList() {
        JsonNode result = A2uiJsonHealer.parseAndFix("{\"a\": 1}");
        assertTrue(result.isArray());
        assertEquals(1, result.size());
        assertEquals(1, result.get(0).get("a").asInt());
    }

    @Test
    void listIsReturnedAsIs() {
        JsonNode result = A2uiJsonHealer.parseAndFix("[{\"a\": 1}, {\"b\": 2}]");
        assertTrue(result.isArray());
        assertEquals(2, result.size());
    }

    @Test
    void smartCurlyQuotesAreNormalized() {
        JsonNode result = A2uiJsonHealer.parseAndFix("{\"k\": \u201Chello\u201D}");
        assertTrue(result.isArray());
        assertEquals("hello", result.get(0).get("k").asText());
    }

    @Test
    void singleQuoteApostropheInsideStringIsNormalized() {
        // \u2019 is an apostrophe inside a double-quoted value -> normalized to a straight quote.
        JsonNode result = A2uiJsonHealer.parseAndFix("{\"k\": \"Bob\u2019s\"}");
        assertEquals("Bob's", result.get(0).get("k").asText());
    }

    @Test
    void trailingCommasAreAutofixed() {
        JsonNode result = A2uiJsonHealer.parseAndFix("[{\"a\": 1,}, {\"b\": 2,}]");
        assertTrue(result.isArray());
        assertEquals(2, result.size());
        assertEquals(1, result.get(0).get("a").asInt());
        assertEquals(2, result.get(1).get("b").asInt());
    }

    @Test
    void healArgListExpectReturnsList() {
        JsonNode result = A2uiJsonHealer.healArg("[{\"a\": 1}]", "list");
        assertTrue(result.isArray());
        assertEquals(1, result.size());
    }

    @Test
    void healArgDictExpectUnwrapsSingleObject() {
        JsonNode result = A2uiJsonHealer.healArg("{\"a\": 1}", "dict");
        assertTrue(result.isObject());
        assertEquals(1, result.get("a").asInt());
    }

    @Test
    void healArgDictExpectRejectsMultiElementList() {
        assertThrows(IllegalArgumentException.class,
                () -> A2uiJsonHealer.healArg("[{\"a\": 1}, {\"b\": 2}]", "dict"));
    }

    @Test
    void healArgHardParseFailureThrows() {
        assertThrows(IllegalArgumentException.class,
                () -> A2uiJsonHealer.healArg("{{{ not json", "list"));
    }
}
