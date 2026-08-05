package com.agui.community.client;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Optional;
import org.junit.jupiter.api.Test;

class SseEventParserTest {

    private final SseEventParser parser = new SseEventParser();

    @Test
    void emitsDataPayloadOnBlankLine() {
        assertTrue(parser.feed("data: hello").isEmpty());
        assertEquals(Optional.of("hello"), parser.feed(""));
    }

    @Test
    void concatenatesMultipleDataLinesWithNewline() {
        assertTrue(parser.feed("data: line1").isEmpty());
        assertTrue(parser.feed("data: line2").isEmpty());
        assertEquals(Optional.of("line1\nline2"), parser.feed(""));
    }

    @Test
    void stripsOnlyASingleLeadingSpaceAfterColon() {
        assertTrue(parser.feed("data:  two-leading-spaces").isEmpty());
        assertEquals(Optional.of(" two-leading-spaces"), parser.feed(""));
    }

    @Test
    void handlesDataWithoutLeadingSpace() {
        assertTrue(parser.feed("data:nospace").isEmpty());
        assertEquals(Optional.of("nospace"), parser.feed(""));
    }

    @Test
    void ignoresCommentLines() {
        assertTrue(parser.feed(": this is a comment").isEmpty());
        assertTrue(parser.feed("data: payload").isEmpty());
        assertEquals(Optional.of("payload"), parser.feed(""));
    }

    @Test
    void ignoresNonDataFields() {
        assertTrue(parser.feed("event: message").isEmpty());
        assertTrue(parser.feed("id: 42").isEmpty());
        assertTrue(parser.feed("retry: 1000").isEmpty());
        assertTrue(parser.feed("data: payload").isEmpty());
        assertEquals(Optional.of("payload"), parser.feed(""));
    }

    @Test
    void blankLineWithoutDataEmitsNothing() {
        assertTrue(parser.feed("").isEmpty());
    }

    @Test
    void parsesConsecutiveEvents() {
        parser.feed("data: first");
        assertEquals(Optional.of("first"), parser.feed(""));
        parser.feed("data: second");
        assertEquals(Optional.of("second"), parser.feed(""));
    }

    @Test
    void flushEmitsPendingEventWithoutTrailingBlankLine() {
        assertTrue(parser.feed("data: dangling").isEmpty());
        assertEquals(Optional.of("dangling"), parser.flush());
    }

    @Test
    void flushWithoutPendingDataEmitsNothing() {
        assertTrue(parser.flush().isEmpty());
    }

    @Test
    void fieldWithNoColonIsTreatedAsEmptyValueField() {
        // A bare "data" line (no colon) contributes an empty data value.
        assertTrue(parser.feed("data").isEmpty());
        assertEquals(Optional.of(""), parser.feed(""));
    }
}
