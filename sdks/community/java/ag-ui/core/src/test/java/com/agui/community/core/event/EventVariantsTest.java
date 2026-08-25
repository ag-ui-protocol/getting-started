package com.agui.community.core.event;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.agui.community.core.message.Role;
import com.agui.community.core.message.UserMessage;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * Exercises every concrete {@link Event} variant: the convenience constructors,
 * the {@link Event#type()} discriminator, the optional-field defaults, the
 * required-field validation and the defensive copying of collection fields.
 */
class EventVariantsTest {

    private static final JsonPatchOperation PATCH = new JsonPatchOperation("add", "/a", 1);

    /** One instance of each event built through its convenience constructor. */
    static List<Arguments> conciseConstructors() {
        return List.of(
                Arguments.of(new RunStartedEvent("t", "r"), EventType.RUN_STARTED),
                Arguments.of(new RunFinishedEvent("t", "r"), EventType.RUN_FINISHED),
                Arguments.of(new RunErrorEvent("boom"), EventType.RUN_ERROR),
                Arguments.of(new StepStartedEvent("step"), EventType.STEP_STARTED),
                Arguments.of(new StepFinishedEvent("step"), EventType.STEP_FINISHED),
                Arguments.of(new TextMessageStartEvent("m", Role.ASSISTANT), EventType.TEXT_MESSAGE_START),
                Arguments.of(new TextMessageContentEvent("m", "hi"), EventType.TEXT_MESSAGE_CONTENT),
                Arguments.of(new TextMessageEndEvent("m"), EventType.TEXT_MESSAGE_END),
                Arguments.of(new TextMessageChunkEvent("m", Role.ASSISTANT, "hi"), EventType.TEXT_MESSAGE_CHUNK),
                Arguments.of(new ToolCallStartEvent("c", "search"), EventType.TOOL_CALL_START),
                Arguments.of(new ToolCallArgsEvent("c", "{}"), EventType.TOOL_CALL_ARGS),
                Arguments.of(new ToolCallEndEvent("c"), EventType.TOOL_CALL_END),
                Arguments.of(new ToolCallChunkEvent("c", "search", "{}"), EventType.TOOL_CALL_CHUNK),
                Arguments.of(new ToolCallResultEvent("m", "c", "result"), EventType.TOOL_CALL_RESULT),
                Arguments.of(new ReasoningStartEvent("m"), EventType.REASONING_START),
                Arguments.of(new ReasoningEndEvent("m"), EventType.REASONING_END),
                Arguments.of(new ReasoningMessageStartEvent("m"), EventType.REASONING_MESSAGE_START),
                Arguments.of(new ReasoningMessageContentEvent("m", "think"), EventType.REASONING_MESSAGE_CONTENT),
                Arguments.of(new ReasoningMessageEndEvent("m"), EventType.REASONING_MESSAGE_END),
                Arguments.of(new ReasoningMessageChunkEvent("m", "think"), EventType.REASONING_MESSAGE_CHUNK),
                Arguments.of(new ReasoningEncryptedValueEvent("message", "e", "blob"), EventType.REASONING_ENCRYPTED_VALUE),
                Arguments.of(new StateSnapshotEvent(new Object()), EventType.STATE_SNAPSHOT),
                Arguments.of(new StateDeltaEvent(List.of(PATCH)), EventType.STATE_DELTA),
                Arguments.of(new MessagesSnapshotEvent(List.of(new UserMessage("m", "hi"))), EventType.MESSAGES_SNAPSHOT),
                Arguments.of(new ActivitySnapshotEvent("m", "PLAN", new Object()), EventType.ACTIVITY_SNAPSHOT),
                Arguments.of(new ActivityDeltaEvent("m", "PLAN", List.of(PATCH)), EventType.ACTIVITY_DELTA),
                Arguments.of(new RawEvent(new Object()), EventType.RAW),
                Arguments.of(new CustomEvent("name", new Object()), EventType.CUSTOM),
                Arguments.of(new MetaEvent("feedback", new Object()), EventType.META_EVENT));
    }

    @ParameterizedTest(name = "{1}")
    @MethodSource("conciseConstructors")
    void conciseConstructorReportsTypeAndLeavesOptionalFieldsNull(Event event, EventType expected) {
        assertEquals(expected, event.type());
        assertNull(event.timestamp(), "timestamp should default to null");
        assertNull(event.rawEvent(), "rawEvent should default to null");
    }

    @Test
    void conciseConstructorsCoverEveryEventType() {
        long covered = conciseConstructors().stream()
                .map(args -> ((Event) args.get()[0]).type())
                .distinct()
                .count();
        assertEquals(EventType.values().length, covered, "every EventType should have a sample event");
    }

    @Test
    void runFinishedExposesValuesAndNullsOptionalPayloads() {
        RunFinishedEvent event = new RunFinishedEvent("thread", "run");
        assertEquals("thread", event.threadId());
        assertEquals("run", event.runId());
        assertNull(event.outcome());
        assertNull(event.result());
    }

    @Test
    void runErrorExposesMessageAndNullCode() {
        RunErrorEvent event = new RunErrorEvent("kaboom");
        assertEquals("kaboom", event.message());
        assertNull(event.code());
    }

    @Test
    void toolCallResultExposesRequiredFields() {
        ToolCallResultEvent event = new ToolCallResultEvent("m1", "c1", "output");
        assertEquals("m1", event.messageId());
        assertEquals("c1", event.toolCallId());
        assertEquals("output", event.content());
        assertNull(event.role());
    }

    @Test
    void reasoningEncryptedValueExposesRequiredFields() {
        ReasoningEncryptedValueEvent event = new ReasoningEncryptedValueEvent("tool-call", "tc1", "cipher");
        assertEquals("tool-call", event.subtype());
        assertEquals("tc1", event.entityId());
        assertEquals("cipher", event.encryptedValue());
    }

    @Test
    void activitySnapshotLeavesReplaceFlagNullByDefault() {
        ActivitySnapshotEvent event = new ActivitySnapshotEvent("m1", "SEARCH", new Object());
        assertEquals("SEARCH", event.activityType());
        assertNull(event.replace());
    }

    @Test
    void reasoningMessageContentRejectsEmptyAndNullDelta() {
        assertThrows(IllegalArgumentException.class, () -> new ReasoningMessageContentEvent("m", ""));
        assertThrows(NullPointerException.class, () -> new ReasoningMessageContentEvent("m", null));
        assertThrows(NullPointerException.class, () -> new ReasoningMessageContentEvent(null, "x"));
    }

    @Test
    void reasoningMessageChunkAllowsNullDelta() {
        ReasoningMessageChunkEvent event = new ReasoningMessageChunkEvent("m", null);
        assertNull(event.delta());
        assertEquals(EventType.REASONING_MESSAGE_CHUNK, event.type());
    }

    @Test
    void stateDeltaCopiesPatchListDefensivelyAndIsUnmodifiable() {
        List<JsonPatchOperation> patches = new ArrayList<>();
        patches.add(PATCH);

        StateDeltaEvent event = new StateDeltaEvent(patches);
        patches.clear();

        assertEquals(1, event.delta().size());
        assertThrows(UnsupportedOperationException.class, () -> event.delta().add(PATCH));
    }

    @Test
    void activityDeltaCopiesPatchListDefensivelyAndIsUnmodifiable() {
        List<JsonPatchOperation> patches = new ArrayList<>();
        patches.add(PATCH);

        ActivityDeltaEvent event = new ActivityDeltaEvent("m", "PLAN", patches);
        patches.clear();

        assertEquals(1, event.patch().size());
        assertThrows(UnsupportedOperationException.class, () -> event.patch().add(PATCH));
    }

    @Test
    void messagesSnapshotCopiesMessageListDefensivelyAndIsUnmodifiable() {
        List<com.agui.community.core.message.Message> messages = new ArrayList<>();
        messages.add(new UserMessage("m1", "hi"));

        MessagesSnapshotEvent event = new MessagesSnapshotEvent(messages);
        messages.clear();

        assertEquals(1, event.messages().size());
        assertThrows(UnsupportedOperationException.class,
                () -> event.messages().add(new UserMessage("m2", "yo")));
    }

    /** Each entry constructs an event missing one required field. */
    static List<org.junit.jupiter.api.function.Executable> missingRequiredFields() {
        return List.of(
                () -> new RunFinishedEvent(null, "r"),
                () -> new RunFinishedEvent("t", null),
                () -> new RunErrorEvent(null),
                () -> new StepStartedEvent(null),
                () -> new StepFinishedEvent(null),
                () -> new TextMessageStartEvent(null, Role.ASSISTANT),
                () -> new TextMessageStartEvent("m", null),
                () -> new TextMessageEndEvent(null),
                () -> new ToolCallStartEvent(null, "search"),
                () -> new ToolCallStartEvent("c", null),
                () -> new ToolCallArgsEvent(null, "{}"),
                () -> new ToolCallArgsEvent("c", null),
                () -> new ToolCallEndEvent(null),
                () -> new ToolCallResultEvent(null, "c", "r"),
                () -> new ToolCallResultEvent("m", null, "r"),
                () -> new ToolCallResultEvent("m", "c", null),
                () -> new ReasoningStartEvent(null),
                () -> new ReasoningEndEvent(null),
                () -> new ReasoningMessageStartEvent(null),
                () -> new ReasoningMessageEndEvent(null),
                () -> new ReasoningMessageChunkEvent(null, "x"),
                () -> new ReasoningEncryptedValueEvent(null, "e", "v"),
                () -> new ReasoningEncryptedValueEvent("s", null, "v"),
                () -> new ReasoningEncryptedValueEvent("s", "e", null),
                () -> new StateSnapshotEvent(null),
                () -> new StateDeltaEvent(null),
                () -> new MessagesSnapshotEvent(null),
                () -> new ActivitySnapshotEvent(null, "PLAN", new Object()),
                () -> new ActivitySnapshotEvent("m", null, new Object()),
                () -> new ActivitySnapshotEvent("m", "PLAN", null),
                () -> new ActivityDeltaEvent(null, "PLAN", List.of()),
                () -> new ActivityDeltaEvent("m", null, List.of()),
                () -> new ActivityDeltaEvent("m", "PLAN", null),
                () -> new RawEvent(null),
                () -> new CustomEvent(null, new Object()),
                () -> new CustomEvent("name", null),
                () -> new MetaEvent(null, new Object()),
                () -> new MetaEvent("type", null));
    }

    @ParameterizedTest
    @MethodSource("missingRequiredFields")
    void missingRequiredFieldThrowsNullPointer(org.junit.jupiter.api.function.Executable construction) {
        assertThrows(NullPointerException.class, construction);
    }

    @Test
    void jsonPatchOperationValidatesAndDefaultsFrom() {
        JsonPatchOperation withFrom = new JsonPatchOperation("move", "/dst", "/src", null);
        assertEquals("/src", withFrom.from());

        JsonPatchOperation withoutFrom = new JsonPatchOperation("add", "/a", 42);
        assertNull(withoutFrom.from());
        assertEquals(42, withoutFrom.value());

        assertThrows(NullPointerException.class, () -> new JsonPatchOperation(null, "/a", 1));
        assertThrows(NullPointerException.class, () -> new JsonPatchOperation("add", null, 1));
    }

    @Test
    void rawEventCarriesSourceWhenProvided() {
        RawEvent event = new RawEvent("payload", "upstream", 123L, "orig");
        assertEquals("payload", event.event());
        assertEquals("upstream", event.source());
        assertEquals(123L, event.timestamp());
        assertSame("orig", event.rawEvent());
        assertTrue(event.type() == EventType.RAW);
    }
}
