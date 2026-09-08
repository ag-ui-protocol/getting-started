package com.agui.community.spring.server.core.jackson;

import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonSubTypes.Type;
import com.fasterxml.jackson.annotation.JsonTypeInfo;
import com.agui.community.core.event.ActivityDeltaEvent;
import com.agui.community.core.event.ActivitySnapshotEvent;
import com.agui.community.core.event.CustomEvent;
import com.agui.community.core.event.MessagesSnapshotEvent;
import com.agui.community.core.event.MetaEvent;
import com.agui.community.core.event.RawEvent;
import com.agui.community.core.event.ReasoningEncryptedValueEvent;
import com.agui.community.core.event.ReasoningEndEvent;
import com.agui.community.core.event.ReasoningMessageChunkEvent;
import com.agui.community.core.event.ReasoningMessageContentEvent;
import com.agui.community.core.event.ReasoningMessageEndEvent;
import com.agui.community.core.event.ReasoningMessageStartEvent;
import com.agui.community.core.event.ReasoningStartEvent;
import com.agui.community.core.event.RunErrorEvent;
import com.agui.community.core.event.RunFinishedEvent;
import com.agui.community.core.event.RunStartedEvent;
import com.agui.community.core.event.StateDeltaEvent;
import com.agui.community.core.event.StateSnapshotEvent;
import com.agui.community.core.event.StepFinishedEvent;
import com.agui.community.core.event.StepStartedEvent;
import com.agui.community.core.event.TextMessageChunkEvent;
import com.agui.community.core.event.TextMessageContentEvent;
import com.agui.community.core.event.TextMessageEndEvent;
import com.agui.community.core.event.TextMessageStartEvent;
import com.agui.community.core.event.ToolCallArgsEvent;
import com.agui.community.core.event.ToolCallChunkEvent;
import com.agui.community.core.event.ToolCallEndEvent;
import com.agui.community.core.event.ToolCallResultEvent;
import com.agui.community.core.event.ToolCallStartEvent;

/**
 * Jackson mix-in that maps the {@link com.agui.community.core.event.Event} sealed
 * hierarchy to its {@code type} discriminator on the wire. Applied to
 * {@code Event} via {@code ObjectMapper#addMixIn} so the {@code core} module
 * stays free of Jackson annotations.
 *
 * <p>The subtype names match {@link com.agui.community.core.event.EventType}.
 * Jackson writes and reads the {@code type} property itself, so it does not rely
 * on the (computed) {@code type()} accessor being exposed as a bean property.
 */
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "type")
@JsonSubTypes({
        @Type(value = RunStartedEvent.class, name = "RUN_STARTED"),
        @Type(value = RunFinishedEvent.class, name = "RUN_FINISHED"),
        @Type(value = RunErrorEvent.class, name = "RUN_ERROR"),
        @Type(value = StepStartedEvent.class, name = "STEP_STARTED"),
        @Type(value = StepFinishedEvent.class, name = "STEP_FINISHED"),
        @Type(value = TextMessageStartEvent.class, name = "TEXT_MESSAGE_START"),
        @Type(value = TextMessageContentEvent.class, name = "TEXT_MESSAGE_CONTENT"),
        @Type(value = TextMessageEndEvent.class, name = "TEXT_MESSAGE_END"),
        @Type(value = TextMessageChunkEvent.class, name = "TEXT_MESSAGE_CHUNK"),
        @Type(value = ToolCallStartEvent.class, name = "TOOL_CALL_START"),
        @Type(value = ToolCallArgsEvent.class, name = "TOOL_CALL_ARGS"),
        @Type(value = ToolCallEndEvent.class, name = "TOOL_CALL_END"),
        @Type(value = ToolCallChunkEvent.class, name = "TOOL_CALL_CHUNK"),
        @Type(value = ToolCallResultEvent.class, name = "TOOL_CALL_RESULT"),
        @Type(value = ReasoningStartEvent.class, name = "REASONING_START"),
        @Type(value = ReasoningEndEvent.class, name = "REASONING_END"),
        @Type(value = ReasoningMessageStartEvent.class, name = "REASONING_MESSAGE_START"),
        @Type(value = ReasoningMessageContentEvent.class, name = "REASONING_MESSAGE_CONTENT"),
        @Type(value = ReasoningMessageEndEvent.class, name = "REASONING_MESSAGE_END"),
        @Type(value = ReasoningMessageChunkEvent.class, name = "REASONING_MESSAGE_CHUNK"),
        @Type(value = ReasoningEncryptedValueEvent.class, name = "REASONING_ENCRYPTED_VALUE"),
        @Type(value = StateSnapshotEvent.class, name = "STATE_SNAPSHOT"),
        @Type(value = StateDeltaEvent.class, name = "STATE_DELTA"),
        @Type(value = MessagesSnapshotEvent.class, name = "MESSAGES_SNAPSHOT"),
        @Type(value = ActivitySnapshotEvent.class, name = "ACTIVITY_SNAPSHOT"),
        @Type(value = ActivityDeltaEvent.class, name = "ACTIVITY_DELTA"),
        @Type(value = RawEvent.class, name = "RAW"),
        @Type(value = CustomEvent.class, name = "CUSTOM"),
        @Type(value = MetaEvent.class, name = "META_EVENT"),
})
public interface EventMixin {
}
