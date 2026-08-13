package com.agui.adk.translator;

import com.agui.community.core.event.CustomEvent;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.Optional;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class TranslationContextBaselineTest {

    private TranslationContext context;

    @Mock
    private PredictStateMapping predictStateMapping;

    private static final String THREAD_ID = "test-thread";
    private static final String RUN_ID = "test-run";
    private static final String TOOL_A = "toolA";
    private static final String TOOL_1 = "tool1";

    @BeforeEach
    void setUp() {
        // We test with a real TranslationContext and its real sub-contexts
        // Provide a default stub for the mocked mapping to avoid NPE in constructor
        when(predictStateMapping.toolName()).thenReturn("defaultTool");

        List<PredictStateMapping> predictConfig = List.of(predictStateMapping);
        context = new TranslationContext(THREAD_ID, RUN_ID, predictConfig);
    }

    @Test
    void shouldInitializeCorrectly_whenConstructed() {
        assertEquals(THREAD_ID, context.getThreadId());
        assertEquals(RUN_ID, context.getRunId());
        assertFalse(context.isStreaming());
        assertTrue(context.getAndClearDeferredConfirmEvents().isEmpty());
    }

    @Test
    void rejectsFrontendToolNamesWithoutPersistenceEmitter() {
        IllegalArgumentException error = assertThrows(
                IllegalArgumentException.class,
                () -> context.configureFrontendToolPersistence(null, "invocation", Set.of("browser_tool"), null));

        assertEquals("frontend tool persistence requires an emitter", error.getMessage());
    }

    @Test
    void acceptsEmptyFrontendToolNamesWithoutPersistenceEmitter() {
        context.configureFrontendToolPersistence(null, "invocation", Set.of(), null);

        assertFalse(context.isFrontendTool("browser_tool"));
    }

    @Test
    void observesEffectiveFrontendNamesResolvedAfterTranslatorConfiguration() {
        Set<String> liveNames = ConcurrentHashMap.newKeySet();
        liveNames.add("original");
        context.configureFrontendToolPersistence(
                null,
                "invocation",
                liveNames,
                mock(com.agui.adk.hitl.PendingToolCallEmitter.class));

        liveNames.clear();
        liveNames.add("frontend_original");

        assertFalse(context.isFrontendTool("original"));
        assertTrue(context.isFrontendTool("frontend_original"));
    }

    @Test
    void shouldStartAndEndStream_whenLifecycleIsManaged() {
        // Initial state
        assertFalse(context.isStreaming());
        assertTrue(context.getStreamingMessageId().isEmpty());

        // Start streaming
        Optional<String> messageId = context.startStreamingIfNeeded();
        assertTrue(messageId.isPresent());
        assertTrue(context.isStreaming());
        assertEquals(messageId, context.getStreamingMessageId());

        // End stream
        context.endStream();
        assertFalse(context.isStreaming());
        assertTrue(context.getStreamingMessageId().isEmpty());
    }

    @Test
    void shouldHandleDuplicateStream_whenSameTextIsProcessed() {
        // Arrange
        context.startStreamingIfNeeded();
        context.appendToCurrentStreamText("duplicate text");
        context.endStream(); // This moves "duplicate text" to lastStreamedText

        // Act & Assert
        // Now, handle a new message with the same text
        Optional<String> result = context.handleDuplicateOrEmptyStream("duplicate text");
        assertTrue(result.isEmpty());
    }

    @Test
    void shouldTrackToolLifecycle_whenManaged() {
        assertFalse(context.isActive(TOOL_1));

        context.startTrackingToolCall(TOOL_1);
        assertTrue(context.isActive(TOOL_1));

        context.endTrackingToolCall(TOOL_1);
        assertFalse(context.isActive(TOOL_1));
    }

    @Test
    void shouldManageDeferredEvents_whenAddedAndCleared() {
        assertTrue(context.getAndClearDeferredConfirmEvents().isEmpty());

        List<com.agui.community.core.event.Event> events =
                List.of(new CustomEvent("deferred", "value"));
        context.addDeferredConfirmEvents(events);

        List<com.agui.community.core.event.Event> retrievedEvents = context.getAndClearDeferredConfirmEvents();
        assertEquals(events, retrievedEvents);
        assertTrue(context.getAndClearDeferredConfirmEvents().isEmpty());
    }

    @Test
    void shouldReturnCorrectPredictiveState_whenQueried() {
        // Arrange
        when(predictStateMapping.toolName()).thenReturn(TOOL_A);

        // Re-create context with this specific mock behavior
        context = new TranslationContext(THREAD_ID, RUN_ID, List.of(predictStateMapping));

        // Act & Assert
        assertFalse(context.lacksPredictiveStateForTool(TOOL_A));
        assertTrue(context.lacksPredictiveStateForTool("non-existent-tool"));
    }
}
