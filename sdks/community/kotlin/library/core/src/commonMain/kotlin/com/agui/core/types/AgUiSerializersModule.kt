package com.agui.core.types

import kotlinx.serialization.modules.SerializersModule
import kotlinx.serialization.modules.polymorphic
import kotlinx.serialization.modules.subclass

/**
 * Defines polymorphic serialization for all AG-UI Data Types.
 */
@Suppress("DEPRECATION")
val AgUiSerializersModule by lazy {
    SerializersModule {
        // Polymorphic serialization for events
        polymorphic(BaseEvent::class) {
            // Lifecycle Events (5)
            subclass(RunStartedEvent::class)
            subclass(RunFinishedEvent::class)
            subclass(RunErrorEvent::class)
            subclass(StepStartedEvent::class)
            subclass(StepFinishedEvent::class)

            // Text Message Events (3)
            subclass(TextMessageStartEvent::class)
            subclass(TextMessageContentEvent::class)
            subclass(TextMessageEndEvent::class)

            // Tool Call Events (4)
            subclass(ToolCallStartEvent::class)
            subclass(ToolCallArgsEvent::class)
            subclass(ToolCallEndEvent::class)
            subclass(ToolCallResultEvent::class)

            // State Management Events (3)
            subclass(StateSnapshotEvent::class)
            subclass(StateDeltaEvent::class)
            subclass(MessagesSnapshotEvent::class)

            // Chunk Events (2)
            subclass(TextMessageChunkEvent::class)
            subclass(ToolCallChunkEvent::class)

            // Activity Events (2)
            subclass(ActivitySnapshotEvent::class)
            subclass(ActivityDeltaEvent::class)

            // Reasoning Events (6)
            subclass(ReasoningStartEvent::class)
            subclass(ReasoningEndEvent::class)
            subclass(ReasoningMessageStartEvent::class)
            subclass(ReasoningMessageContentEvent::class)
            subclass(ReasoningMessageEndEvent::class)
            subclass(ReasoningMessageChunkEvent::class)

            // Deprecated Thinking Events (5) — kept for backward compatibility with legacy servers
            subclass(ThinkingStartEvent::class)
            subclass(ThinkingEndEvent::class)
            subclass(ThinkingTextMessageStartEvent::class)
            subclass(ThinkingTextMessageContentEvent::class)
            subclass(ThinkingTextMessageEndEvent::class)

            // Special Events (2)
            subclass(RawEvent::class)
            subclass(CustomEvent::class)
        }

        polymorphic(Message::class) {
            subclass(DeveloperMessage::class)
            subclass(SystemMessage::class)
            subclass(AssistantMessage::class)
            subclass(UserMessage::class)
            subclass(ToolMessage::class)
        }

        // Polymorphic serialization for InputContent parts
        polymorphic(InputContent::class) {
            subclass(TextInputContent::class)
            subclass(ImageInputContent::class)
            subclass(AudioInputContent::class)
            subclass(VideoInputContent::class)
            subclass(DocumentInputContent::class)
            @Suppress("DEPRECATION")
            subclass(BinaryInputContent::class)
        }

        // Polymorphic serialization for InputContentSource
        polymorphic(InputContentSource::class) {
            subclass(InputContentDataSource::class)
            subclass(InputContentUrlSource::class)
        }

        // Polymorphic serialization for RUN_FINISHED outcomes
        polymorphic(RunFinishedOutcome::class) {
            subclass(RunFinishedSuccessOutcome::class)
            subclass(RunFinishedInterruptOutcome::class)
        }
    }
}
