use crate::JsonValue;
use crate::state::AgentState;
use crate::types::{Interrupt, Message, Role, RunAgentInput};
use crate::types::{MessageId, RunId, ThreadId, ToolCallId};
use serde::{Deserialize, Serialize};

/// Event types for AG-UI protocol
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EventType {
    /// Event indicating the start of a text message
    TextMessageStart,
    /// Event containing a piece of text message content
    TextMessageContent,
    /// Event indicating the end of a text message
    TextMessageEnd,
    /// Event containing a chunk of text message content
    TextMessageChunk,
    /// Event indicating the start of a thinking text message
    ThinkingTextMessageStart,
    /// Event indicating a piece of a thinking text message
    ThinkingTextMessageContent,
    /// Event indicating the end of a thinking text message
    ThinkingTextMessageEnd,
    /// Event indicating the start of a tool call
    ToolCallStart,
    /// Event containing tool call arguments
    ToolCallArgs,
    /// Event indicating the end of a tool call
    ToolCallEnd,
    /// Event containing a chunk of tool call content
    ToolCallChunk,
    /// Event containing the result of a tool call
    ToolCallResult,
    /// Event indicating the start of a thinking step event
    ThinkingStart,
    /// Event indicating the end of a thinking step event
    ThinkingEnd,
    /// Event containing a snapshot of the state
    StateSnapshot,
    /// Event containing a delta of the state
    StateDelta,
    /// Event containing a snapshot of the messages
    MessagesSnapshot,
    /// Event containing a snapshot of structured activity
    ActivitySnapshot,
    /// Event containing a delta for structured activity
    ActivityDelta,
    /// Event containing a raw event
    Raw,
    /// Event containing a custom event
    Custom,
    /// Event indicating that a run has started
    RunStarted,
    /// Event indicating that a run has finished
    RunFinished,
    /// Event indicating that a run has encountered an error
    RunError,
    /// Event indicating that a step has started
    StepStarted,
    /// Event indicating that a step has finished
    StepFinished,
    /// Event indicating the start of a reasoning block
    ReasoningStart,
    /// Event indicating the start of a reasoning message
    ReasoningMessageStart,
    /// Event containing a reasoning message delta
    ReasoningMessageContent,
    /// Event indicating the end of a reasoning message
    ReasoningMessageEnd,
    /// Event containing a chunk of reasoning message content
    ReasoningMessageChunk,
    /// Event indicating the end of a reasoning block
    ReasoningEnd,
    /// Event carrying an encrypted reasoning value
    ReasoningEncryptedValue,
}

/// Base event for all events in the Agent User Interaction Protocol.
/// Contains common fields that are present in all event types.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BaseEvent {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<f64>,
    #[serde(rename = "rawEvent", skip_serializing_if = "Option::is_none")]
    pub raw_event: Option<JsonValue>,
}

/// The interrupt-aware outcome of a completed run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum RunFinishedOutcome {
    Success,
    Interrupt { interrupts: Vec<Interrupt> },
}

/// Entity subtype for encrypted reasoning values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReasoningEncryptedValueSubtype {
    Message,
    ToolCall,
}

/// Event indicating the start of a text message.
/// This event is sent when the agent begins generating a text message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextMessageStartEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "messageId")]
    pub message_id: MessageId,
    #[serde(default = "Role::assistant")]
    pub role: Role, // "assistant"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// Event containing a piece of text message content.
/// This event is sent for each chunk of content as the agent generates a message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextMessageContentEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "messageId")]
    pub message_id: MessageId,
    pub delta: String,
}

/// Event indicating the end of a text message.
/// This event is sent when the agent completes a text message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextMessageEndEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "messageId")]
    pub message_id: MessageId,
}

/// Event containing a chunk of text message content.
/// This event combines start, content, and potentially end information in a single event,
/// with optional fields that may or may not be present.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextMessageChunkEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "messageId", skip_serializing_if = "Option::is_none")]
    pub message_id: Option<MessageId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<Role>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// Event indicating the start of a thinking text message.
/// This event is sent when the agent begins generating internal thinking content.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThinkingTextMessageStartEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
}

/// Event indicating a piece of a thinking text message.
/// This event contains chunks of the agent's internal thinking process.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThinkingTextMessageContentEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    pub delta: String,
}

/// Event indicating the end of a thinking text message.
/// This event is sent when the agent completes its internal thinking process.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThinkingTextMessageEndEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
}

/// Event indicating the start of a tool call.
/// This event is sent when the agent begins to call a tool with specific parameters.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCallStartEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "toolCallId")]
    pub tool_call_id: ToolCallId,
    #[serde(rename = "toolCallName")]
    pub tool_call_name: String,
    #[serde(rename = "parentMessageId", skip_serializing_if = "Option::is_none")]
    pub parent_message_id: Option<MessageId>,
}

/// Event containing tool call arguments.
/// This event contains chunks of the arguments being passed to a tool.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCallArgsEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "toolCallId")]
    pub tool_call_id: ToolCallId,
    pub delta: String,
}

/// Event indicating the end of a tool call.
/// This event is sent when the agent completes sending arguments to a tool.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCallEndEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "toolCallId")]
    pub tool_call_id: ToolCallId,
}

/// Event containing the result of a tool call.
/// This event is sent when a tool has completed execution and returns its result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCallResultEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "messageId")]
    pub message_id: MessageId,
    #[serde(rename = "toolCallId")]
    pub tool_call_id: ToolCallId,
    pub content: String,
    #[serde(default = "Role::tool")]
    pub role: Role, // "tool"
}

/// Event containing a chunk of tool call content.
/// This event combines start, args, and potentially end information in a single event,
/// with optional fields that may or may not be present.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCallChunkEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "toolCallId", skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<ToolCallId>,
    #[serde(rename = "toolCallName", skip_serializing_if = "Option::is_none")]
    pub tool_call_name: Option<String>,
    #[serde(rename = "parentMessageId", skip_serializing_if = "Option::is_none")]
    pub parent_message_id: Option<MessageId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta: Option<String>,
}

/// Event indicating the start of a thinking step event.
/// This event is sent when the agent begins a deliberate thinking phase.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThinkingStartEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// Event indicating the end of a thinking step event.
/// This event is sent when the agent completes a thinking phase.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThinkingEndEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
}

/// Event containing a snapshot of the state.
/// This event provides a complete representation of the current agent state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(bound(deserialize = ""))]
pub struct StateSnapshotEvent<StateT: AgentState = JsonValue> {
    #[serde(flatten)]
    pub base: BaseEvent,
    pub snapshot: StateT,
}

/// Event containing a delta of the state.
/// This event contains JSON Patch operations (RFC 6902) that describe changes to the agent state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StateDeltaEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    pub delta: Vec<JsonValue>,
}

/// Event containing a snapshot of the messages.
/// This event provides a complete list of all current conversation messages.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MessagesSnapshotEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    pub messages: Vec<Message>,
}

/// Event containing a full structured activity snapshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActivitySnapshotEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "messageId")]
    pub message_id: MessageId,
    #[serde(rename = "activityType")]
    pub activity_type: String,
    pub content: JsonValue,
    #[serde(default = "default_activity_replace")]
    pub replace: bool,
}

fn default_activity_replace() -> bool {
    true
}

/// Event containing JSON Patch operations for an activity message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActivityDeltaEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "messageId")]
    pub message_id: MessageId,
    #[serde(rename = "activityType")]
    pub activity_type: String,
    pub patch: Vec<JsonValue>,
}

/// Event containing a raw event.
/// This event type allows wrapping arbitrary events from external sources.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RawEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    pub event: JsonValue,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// Event containing a custom event.
/// This event type allows for application-specific custom events with arbitrary data.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CustomEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<JsonValue>,
}

/// Event indicating that a run has started.
/// This event is sent when an agent run begins execution within a specific thread.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunStartedEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "threadId")]
    pub thread_id: ThreadId,
    #[serde(rename = "runId")]
    pub run_id: RunId,
    #[serde(rename = "parentRunId", skip_serializing_if = "Option::is_none")]
    pub parent_run_id: Option<RunId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<RunAgentInput>,
}

/// Event indicating that a run has finished.
/// This event is sent when an agent run completes successfully, potentially with a result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunFinishedEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "threadId")]
    pub thread_id: ThreadId,
    #[serde(rename = "runId")]
    pub run_id: RunId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<RunFinishedOutcome>,
}

/// Event indicating that a run has encountered an error.
/// This event is sent when an agent run fails with an error message and optional error code.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunErrorEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

/// Event indicating that a step has started.
/// This event is sent when a specific named step within a run begins execution.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StepStartedEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "stepName")]
    pub step_name: String,
}

/// Event indicating that a step has finished.
/// This event is sent when a specific named step within a run completes execution.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StepFinishedEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "stepName")]
    pub step_name: String,
}

/// Event indicating the start of a reasoning block.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReasoningStartEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "messageId")]
    pub message_id: MessageId,
}

/// Event indicating the start of a reasoning message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReasoningMessageStartEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "messageId")]
    pub message_id: MessageId,
    #[serde(default = "Role::reasoning")]
    pub role: Role,
}

/// Event containing a piece of reasoning message content.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReasoningMessageContentEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "messageId")]
    pub message_id: MessageId,
    pub delta: String,
}

/// Event indicating the end of a reasoning message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReasoningMessageEndEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "messageId")]
    pub message_id: MessageId,
}

/// Event containing a chunk of reasoning message content.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReasoningMessageChunkEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "messageId", skip_serializing_if = "Option::is_none")]
    pub message_id: Option<MessageId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta: Option<String>,
}

/// Event indicating the end of a reasoning block.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReasoningEndEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "messageId")]
    pub message_id: MessageId,
}

/// Event carrying encrypted reasoning data for a message or tool call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReasoningEncryptedValueEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    pub subtype: ReasoningEncryptedValueSubtype,
    #[serde(rename = "entityId")]
    pub entity_id: String,
    #[serde(rename = "encryptedValue")]
    pub encrypted_value: String,
}

/// Union of all possible events in the Agent User Interaction Protocol.
/// This enum represents the full set of events that can be exchanged
/// between the agent and the client.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "SCREAMING_SNAKE_CASE",
    bound(deserialize = "")
)]
pub enum Event<StateT: AgentState = JsonValue> {
    /// Signals the start of a text message from an agent.
    /// Contains the message ID and role information.
    TextMessageStart(TextMessageStartEvent),

    /// Represents a chunk of content being added to an in-progress text message.
    /// Contains the message ID and the text delta to append.
    TextMessageContent(TextMessageContentEvent),

    /// Signals the completion of a text message.
    /// Contains the message ID of the completed message.
    TextMessageEnd(TextMessageEndEvent),

    /// Represents a complete or partial message chunk in a single event.
    /// May contain optional message ID, role, and delta information.
    TextMessageChunk(TextMessageChunkEvent),

    /// Signals the start of a thinking text message.
    /// Used for internal agent thought processes that should be displayed to the user.
    ThinkingTextMessageStart(ThinkingTextMessageStartEvent),

    /// Represents content being added to an in-progress thinking text message.
    /// Contains the delta text to append.
    ThinkingTextMessageContent(ThinkingTextMessageContentEvent),

    /// Signals the completion of a thinking text message.
    ThinkingTextMessageEnd(ThinkingTextMessageEndEvent),

    /// Signals the start of a tool call by the agent.
    /// Contains the tool call ID, name, and optional parent message ID.
    ToolCallStart(ToolCallStartEvent),

    /// Represents arguments being added to an in-progress tool call.
    /// Contains the tool call ID and argument data delta.
    ToolCallArgs(ToolCallArgsEvent),

    /// Signals the completion of a tool call.
    /// Contains the tool call ID of the completed call.
    ToolCallEnd(ToolCallEndEvent),

    /// Represents a complete or partial tool call in a single event.
    /// May contain optional tool call ID, name, parent message ID, and delta.
    ToolCallChunk(ToolCallChunkEvent),

    /// Represents the result of a completed tool call.
    /// Contains the message ID, tool call ID, content, and optional role.
    ToolCallResult(ToolCallResultEvent),

    /// Signals the start of a thinking process.
    /// Contains an optional title describing the thinking process.
    ThinkingStart(ThinkingStartEvent),

    /// Signals the end of a thinking process.
    ThinkingEnd(ThinkingEndEvent),

    /// Provides a complete snapshot of the current state.
    /// Contains the full state as a JSON value.
    StateSnapshot(StateSnapshotEvent<StateT>),

    /// Provides incremental changes to the state.
    /// Contains a vector of delta operations to apply to the state.
    StateDelta(StateDeltaEvent),

    /// Provides a complete snapshot of all messages.
    /// Contains a vector of all current messages.
    MessagesSnapshot(MessagesSnapshotEvent),

    /// Provides a complete structured activity snapshot.
    ActivitySnapshot(ActivitySnapshotEvent),

    /// Provides incremental structured activity changes.
    ActivityDelta(ActivityDeltaEvent),

    /// Wraps a raw event from an external source.
    /// Contains the original event as a JSON value and an optional source identifier.
    Raw(RawEvent),

    /// Represents a custom event type not covered by the standard events.
    /// Contains a name identifying the custom event type and an associated value.
    Custom(CustomEvent),

    /// Signals the start of an agent run.
    /// Contains thread ID and run ID to identify the run.
    RunStarted(RunStartedEvent),

    /// Signals the completion of an agent run.
    /// Contains thread ID, run ID, and optional result data.
    RunFinished(RunFinishedEvent),

    /// Signals an error that occurred during an agent run.
    /// Contains error message and optional error code.
    RunError(RunErrorEvent),

    /// Signals the start of a step within an agent run.
    /// Contains the name of the step being started.
    StepStarted(StepStartedEvent),

    /// Signals the completion of a step within an agent run.
    /// Contains the name of the completed step.
    StepFinished(StepFinishedEvent),

    /// Signals the start of a reasoning block.
    ReasoningStart(ReasoningStartEvent),

    /// Signals the start of a reasoning message.
    ReasoningMessageStart(ReasoningMessageStartEvent),

    /// Represents content being added to an in-progress reasoning message.
    ReasoningMessageContent(ReasoningMessageContentEvent),

    /// Signals the completion of a reasoning message.
    ReasoningMessageEnd(ReasoningMessageEndEvent),

    /// Represents a complete or partial reasoning message chunk in a single event.
    ReasoningMessageChunk(ReasoningMessageChunkEvent),

    /// Signals the end of a reasoning block.
    ReasoningEnd(ReasoningEndEvent),

    /// Carries encrypted reasoning data for a message or tool call.
    ReasoningEncryptedValue(ReasoningEncryptedValueEvent),
}

impl<StateT: AgentState> Event<StateT> {
    /// Get the event type
    pub fn event_type(&self) -> EventType {
        match self {
            Event::TextMessageStart(_) => EventType::TextMessageStart,
            Event::TextMessageContent(_) => EventType::TextMessageContent,
            Event::TextMessageEnd(_) => EventType::TextMessageEnd,
            Event::TextMessageChunk(_) => EventType::TextMessageChunk,
            Event::ThinkingTextMessageStart(_) => EventType::ThinkingTextMessageStart,
            Event::ThinkingTextMessageContent(_) => EventType::ThinkingTextMessageContent,
            Event::ThinkingTextMessageEnd(_) => EventType::ThinkingTextMessageEnd,
            Event::ToolCallStart(_) => EventType::ToolCallStart,
            Event::ToolCallArgs(_) => EventType::ToolCallArgs,
            Event::ToolCallEnd(_) => EventType::ToolCallEnd,
            Event::ToolCallChunk(_) => EventType::ToolCallChunk,
            Event::ToolCallResult(_) => EventType::ToolCallResult,
            Event::ThinkingStart(_) => EventType::ThinkingStart,
            Event::ThinkingEnd(_) => EventType::ThinkingEnd,
            Event::StateSnapshot(_) => EventType::StateSnapshot,
            Event::StateDelta(_) => EventType::StateDelta,
            Event::MessagesSnapshot(_) => EventType::MessagesSnapshot,
            Event::ActivitySnapshot(_) => EventType::ActivitySnapshot,
            Event::ActivityDelta(_) => EventType::ActivityDelta,
            Event::Raw(_) => EventType::Raw,
            Event::Custom(_) => EventType::Custom,
            Event::RunStarted(_) => EventType::RunStarted,
            Event::RunFinished(_) => EventType::RunFinished,
            Event::RunError(_) => EventType::RunError,
            Event::StepStarted(_) => EventType::StepStarted,
            Event::StepFinished(_) => EventType::StepFinished,
            Event::ReasoningStart(_) => EventType::ReasoningStart,
            Event::ReasoningMessageStart(_) => EventType::ReasoningMessageStart,
            Event::ReasoningMessageContent(_) => EventType::ReasoningMessageContent,
            Event::ReasoningMessageEnd(_) => EventType::ReasoningMessageEnd,
            Event::ReasoningMessageChunk(_) => EventType::ReasoningMessageChunk,
            Event::ReasoningEnd(_) => EventType::ReasoningEnd,
            Event::ReasoningEncryptedValue(_) => EventType::ReasoningEncryptedValue,
        }
    }

    /// Get the timestamp if available
    pub fn timestamp(&self) -> Option<f64> {
        match self {
            Event::TextMessageStart(e) => e.base.timestamp,
            Event::TextMessageContent(e) => e.base.timestamp,
            Event::TextMessageEnd(e) => e.base.timestamp,
            Event::TextMessageChunk(e) => e.base.timestamp,
            Event::ThinkingTextMessageStart(e) => e.base.timestamp,
            Event::ThinkingTextMessageContent(e) => e.base.timestamp,
            Event::ThinkingTextMessageEnd(e) => e.base.timestamp,
            Event::ToolCallStart(e) => e.base.timestamp,
            Event::ToolCallArgs(e) => e.base.timestamp,
            Event::ToolCallEnd(e) => e.base.timestamp,
            Event::ToolCallChunk(e) => e.base.timestamp,
            Event::ToolCallResult(e) => e.base.timestamp,
            Event::ThinkingStart(e) => e.base.timestamp,
            Event::ThinkingEnd(e) => e.base.timestamp,
            Event::StateSnapshot(e) => e.base.timestamp,
            Event::StateDelta(e) => e.base.timestamp,
            Event::MessagesSnapshot(e) => e.base.timestamp,
            Event::ActivitySnapshot(e) => e.base.timestamp,
            Event::ActivityDelta(e) => e.base.timestamp,
            Event::Raw(e) => e.base.timestamp,
            Event::Custom(e) => e.base.timestamp,
            Event::RunStarted(e) => e.base.timestamp,
            Event::RunFinished(e) => e.base.timestamp,
            Event::RunError(e) => e.base.timestamp,
            Event::StepStarted(e) => e.base.timestamp,
            Event::StepFinished(e) => e.base.timestamp,
            Event::ReasoningStart(e) => e.base.timestamp,
            Event::ReasoningMessageStart(e) => e.base.timestamp,
            Event::ReasoningMessageContent(e) => e.base.timestamp,
            Event::ReasoningMessageEnd(e) => e.base.timestamp,
            Event::ReasoningMessageChunk(e) => e.base.timestamp,
            Event::ReasoningEnd(e) => e.base.timestamp,
            Event::ReasoningEncryptedValue(e) => e.base.timestamp,
        }
    }
}

/// Validation error types for events in the Agent User Interaction Protocol.
/// These errors represent validation failures when creating or processing events.
#[derive(Debug, thiserror::Error)]
pub enum EventValidationError {
    #[error("Delta must not be an empty string")]
    EmptyDelta,
    #[error("Invalid event format: {0}")]
    InvalidFormat(String),
}

/// Validate text message content event
impl TextMessageContentEvent {
    pub fn validate(&self) -> Result<(), EventValidationError> {
        if self.delta.is_empty() {
            return Err(EventValidationError::EmptyDelta);
        }
        Ok(())
    }
}

/// Builder pattern for creating events
impl TextMessageStartEvent {
    pub fn new(message_id: impl Into<MessageId>) -> Self {
        Self {
            base: BaseEvent {
                timestamp: None,
                raw_event: None,
            },
            message_id: message_id.into(),
            role: Role::Assistant,
            name: None,
        }
    }

    pub fn with_timestamp(mut self, timestamp: f64) -> Self {
        self.base.timestamp = Some(timestamp);
        self
    }

    pub fn with_raw_event(mut self, raw_event: JsonValue) -> Self {
        self.base.raw_event = Some(raw_event);
        self
    }

    pub fn with_name(mut self, name: String) -> Self {
        self.name = Some(name);
        self
    }
}

impl TextMessageContentEvent {
    pub fn new(
        message_id: impl Into<MessageId>,
        delta: String,
    ) -> Result<Self, EventValidationError> {
        let event = Self {
            base: BaseEvent {
                timestamp: None,
                raw_event: None,
            },
            message_id: message_id.into(),
            delta,
        };
        event.validate()?;
        Ok(event)
    }

    pub fn with_timestamp(mut self, timestamp: f64) -> Self {
        self.base.timestamp = Some(timestamp);
        self
    }
}
