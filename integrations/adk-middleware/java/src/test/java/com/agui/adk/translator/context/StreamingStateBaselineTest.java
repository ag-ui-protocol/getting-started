package com.agui.adk.translator.context;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;

class StreamingStateBaselineTest {

    private StreamingState streamingState;

    @BeforeEach
    void setUp() {
        streamingState = new StreamingState();
    }

    private void startAndAppend(String text) {
        streamingState.startStreaming();
        streamingState.appendToCurrentText(text);
    }

    @Test
    void shouldBeInInitialState_whenConstructed() {
        assertTrue(streamingState.getMessageId().isEmpty());
        assertFalse(streamingState.isStreaming());
        assertNull(streamingState.getLastStreamedText());
        assertNull(streamingState.getLastStreamedRunId());
    }

    @Test
    void shouldStartNewStream_whenNotAlreadyStreaming() {
        Optional<String> messageId = streamingState.startStreaming();
        assertTrue(messageId.isPresent());
        assertTrue(streamingState.isStreaming());
        assertEquals(messageId, streamingState.getMessageId());
        assertNull(streamingState.getLastStreamedText());
    }

    @Test
    void shouldReturnEmptyOptional_whenAlreadyStreaming() {
        streamingState.startStreaming(); // Start first stream
        Optional<String> secondMessageId = streamingState.startStreaming(); // Try to start another
        assertTrue(secondMessageId.isEmpty());
    }

    @Test
    void shouldAppendText_whenCalled() {
        startAndAppend("Hello");
        streamingState.appendToCurrentText(" World");

        streamingState.endStream("run-1");

        assertEquals("Hello World", streamingState.getLastStreamedText());
    }

    @Test
    void shouldUpdateLastStreamedAndReset_whenEndStreamCalled() {
        String runId = "testRun123";
        startAndAppend("Some streamed content");
        String msgId = streamingState.getMessageId().get();

        streamingState.endStream(runId);

        assertFalse(streamingState.isStreaming());
        assertTrue(streamingState.getMessageId().isEmpty());
        assertEquals("Some streamed content", streamingState.getLastStreamedText());
        assertEquals(runId, streamingState.getLastStreamedRunId());
    }

    @Test
    void shouldNotUpdateLastStreamed_whenEndStreamCalledWithEmptyText() {
        String runId = "testRun456";
        streamingState.startStreaming();
        streamingState.endStream(runId); // End stream without appending text

        assertNull(streamingState.getLastStreamedText());
        assertNull(streamingState.getLastStreamedRunId());
    }

    @Test
    void shouldClearLastStreamedData_whenResetHistoryCalled() {
        startAndAppend("Content");
        streamingState.endStream("runId");
        assertNotNull(streamingState.getLastStreamedText());

        streamingState.resetHistory();
        assertNull(streamingState.getLastStreamedText());
        assertNull(streamingState.getLastStreamedRunId());
    }
}
