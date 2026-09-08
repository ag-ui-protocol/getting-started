package com.agui.community.client;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
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

    @Test
    void rejectsAggregateDataBeyondDefaultLimit() {
        String line = "data: " + "x".repeat(8192);
        assertThrows(HttpAgentException.class, () -> {
            for (int i = 0; i < 1024; i++) {
                parser.feed(line);
            }
        });
    }

    @Test
    void acceptsAggregateDataAtExactLimitIncludingInsertedNewlinesAndUtf8Bytes() {
        SseEventParser limited = new SseEventParser(9);

        assertTrue(limited.feed("data: \uD83D\uDE00").isEmpty());
        assertTrue(limited.feed("data: abcd").isEmpty());

        assertEquals(Optional.of("\uD83D\uDE00\nabcd"), limited.feed(""));
    }

    @Test
    void rejectsAggregateDataOneByteOverLimitIncludingInsertedNewline() {
        SseEventParser limited = new SseEventParser(8);

        assertTrue(limited.feed("data: \u00A2\u20AC").isEmpty());

        HttpAgentException error = assertThrows(HttpAgentException.class, () -> limited.feed("data: xyz"));
        assertTrue(error.getMessage().contains("8 bytes"));
    }

    @Test
    void acceptsLineAtExactByteLimitWithUtf8Characters() throws IOException {
        SseLineReader reader = reader("a\u00A2\u20AC\n", 6);

        assertEquals("a\u00A2\u20AC", reader.readLine());
        assertEquals(null, reader.readLine());
    }

    @Test
    void rejectsLineOneByteOverLimit() {
        SseLineReader reader = reader("1234567\n", 6);

        HttpAgentException error = assertThrows(HttpAgentException.class, reader::readLine);
        assertTrue(error.getMessage().contains("6 bytes"));
    }

    @Test
    void readsLinesTerminatedByLfCrCrLfAndFinalEofFlush() throws IOException {
        SseLineReader reader = reader("lf\ncr\rcrlf\r\nfinal", 64);

        assertEquals("lf", reader.readLine());
        assertEquals("cr", reader.readLine());
        assertEquals("crlf", reader.readLine());
        assertEquals("final", reader.readLine());
        assertEquals(null, reader.readLine());
    }

    @Test
    void preservesUtf8CharactersSplitAcrossSmallInputChunks() throws IOException {
        SseLineReader reader = new SseLineReader(
                new OneByteAtATimeInputStream("emoji-\uD83D\uDE00\n".getBytes(StandardCharsets.UTF_8)), 32);

        assertEquals("emoji-\uD83D\uDE00", reader.readLine());
    }

    @Test
    void rejectsOversizedUnterminatedLineBeforeConsumingWholeStream() {
        CountingInputStream input = new CountingInputStream("x".repeat(10_000).getBytes(StandardCharsets.UTF_8));
        SseLineReader reader = new SseLineReader(input, 8);

        assertThrows(HttpAgentException.class, reader::readLine);

        assertEquals(9, input.bytesRead());
    }

    @Test
    void rejectsOversizedIgnoredAndCommentLinesBeforeConsumingWholeStream() {
        assertRejectedBeforeWholeStream(": " + "x".repeat(10_000), 9);
        assertRejectedBeforeWholeStream("ignored: " + "x".repeat(10_000), 9);
    }

    private static SseLineReader reader(String body, int maxLineBytes) {
        return new SseLineReader(new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)), maxLineBytes);
    }

    private static void assertRejectedBeforeWholeStream(String body, int maxLineBytes) {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        CountingInputStream input = new CountingInputStream(bytes);
        SseLineReader reader = new SseLineReader(input, maxLineBytes);

        assertThrows(HttpAgentException.class, reader::readLine);

        assertTrue(input.bytesRead() < bytes.length);
        assertEquals(maxLineBytes + 1, input.bytesRead());
    }

    private static final class OneByteAtATimeInputStream extends InputStream {
        private final byte[] bytes;
        private int offset;

        private OneByteAtATimeInputStream(byte[] bytes) {
            this.bytes = bytes;
        }

        @Override
        public int read() {
            return offset == bytes.length ? -1 : bytes[offset++] & 0xff;
        }

        @Override
        public int read(byte[] buffer, int off, int len) {
            int next = read();
            if (next == -1) {
                return -1;
            }
            buffer[off] = (byte) next;
            return 1;
        }
    }

    private static final class CountingInputStream extends InputStream {
        private final byte[] bytes;
        private int offset;

        private CountingInputStream(byte[] bytes) {
            this.bytes = bytes;
        }

        @Override
        public int read() {
            return offset == bytes.length ? -1 : bytes[offset++] & 0xff;
        }

        @Override
        public int read(byte[] buffer, int off, int len) {
            int next = read();
            if (next == -1) {
                return -1;
            }
            buffer[off] = (byte) next;
            return 1;
        }

        private int bytesRead() {
            return offset;
        }
    }
}
