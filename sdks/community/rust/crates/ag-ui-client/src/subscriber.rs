#![allow(unused)]

use std::collections::HashMap;
use std::slice::Iter;
use std::sync::Arc;

use crate::agent::{AgentError, AgentStateMutation};
use crate::core::event::*;
use crate::core::types::{Message, RunAgentInput, ToolCall};
use crate::core::{AgentState, FwdProps, JsonValue};

pub struct AgentSubscriberParams<'a, StateT: AgentState, FwdPropsT: FwdProps> {
    pub messages: &'a [Message],
    pub state: &'a StateT,
    pub input: &'a RunAgentInput<StateT, FwdPropsT>,
}

/// Subscriber trait for hooking into Agent run lifecycle events.
/// Currently makes use of the [`async_trait`] crate.
#[async_trait::async_trait]
pub trait AgentSubscriber<StateT = JsonValue, FwdPropsT = JsonValue>: Send + Sync
where
    StateT: AgentState,
    FwdPropsT: FwdProps,
{
    // Request lifecycle
    async fn on_run_initialized(
        &self,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_run_failed(
        &self,
        error: &AgentError,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_run_finalized(
        &self,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    // Events
    async fn on_event(
        &self,
        event: &Event<StateT>,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_run_started_event(
        &self,
        event: &RunStartedEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_run_finished_event(
        &self,
        event: &RunFinishedEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_run_error_event(
        &self,
        event: &RunErrorEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_step_started_event(
        &self,
        event: &StepStartedEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_step_finished_event(
        &self,
        event: &StepFinishedEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_text_message_start_event(
        &self,
        event: &TextMessageStartEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_text_message_content_event(
        &self,
        event: &TextMessageContentEvent,
        _text_message_buffer: &str,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_text_message_end_event(
        &self,
        event: &TextMessageEndEvent,
        _text_message_buffer: &str,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_tool_call_start_event(
        &self,
        event: &ToolCallStartEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_tool_call_args_event(
        &self,
        event: &ToolCallArgsEvent,
        _tool_call_buffer: &str,
        tool_call_name: &str,
        _partial_tool_call_args: &HashMap<String, JsonValue>,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_tool_call_end_event(
        &self,
        event: &ToolCallEndEvent,
        tool_call_name: &str,
        _tool_call_args: &HashMap<String, JsonValue>,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_tool_call_result_event(
        &self,
        event: &ToolCallResultEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_state_snapshot_event(
        &self,
        event: &StateSnapshotEvent<StateT>,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_state_delta_event(
        &self,
        event: &StateDeltaEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_messages_snapshot_event(
        &self,
        event: &MessagesSnapshotEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_activity_snapshot_event(
        &self,
        event: &ActivitySnapshotEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_activity_delta_event(
        &self,
        event: &ActivityDeltaEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_raw_event(
        &self,
        event: &RawEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_custom_event(
        &self,
        event: &CustomEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_text_message_chunk_event(
        &self,
        event: &TextMessageChunkEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_thinking_text_message_start_event(
        &self,
        event: &ThinkingTextMessageStartEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_thinking_text_message_content_event(
        &self,
        event: &ThinkingTextMessageContentEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_thinking_text_message_end_event(
        &self,
        event: &ThinkingTextMessageEndEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_tool_call_chunk_event(
        &self,
        event: &ToolCallChunkEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_thinking_start_event(
        &self,
        event: &ThinkingStartEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_thinking_end_event(
        &self,
        event: &ThinkingEndEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_reasoning_start_event(
        &self,
        event: &ReasoningStartEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_reasoning_message_start_event(
        &self,
        event: &ReasoningMessageStartEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_reasoning_message_content_event(
        &self,
        event: &ReasoningMessageContentEvent,
        _reasoning_message_buffer: &str,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_reasoning_message_end_event(
        &self,
        event: &ReasoningMessageEndEvent,
        _reasoning_message_buffer: &str,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_reasoning_message_chunk_event(
        &self,
        event: &ReasoningMessageChunkEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_reasoning_end_event(
        &self,
        event: &ReasoningEndEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_reasoning_encrypted_value_event(
        &self,
        event: &ReasoningEncryptedValueEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    // State changes
    async fn on_messages_changed(
        &self,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<(), AgentError> {
        Ok(())
    }

    async fn on_state_changed(
        &self,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<(), AgentError> {
        Ok(())
    }

    async fn on_new_message(
        &self,
        message: &Message,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<(), AgentError> {
        Ok(())
    }

    async fn on_new_tool_call(
        &self,
        tool_call: &ToolCall,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<(), AgentError> {
        Ok(())
    }
}

/// Wrapper for subscriber implementations.
///
/// Facilitates easy casting to and from types that implement [`AgentSubscriber`].
///
/// # Examples
///
/// ```
/// # use ag_ui_client::subscriber::{Subscribers, AgentSubscriber};
/// # use std::sync::Arc;
/// # struct MySubscriber;
/// # impl AgentSubscriber for MySubscriber {}
///
/// // Create from a single subscriber
/// let subscriber = MySubscriber;
/// let subscribers = Subscribers::from_subscriber(subscriber);
///
/// // Create from multiple subscribers
/// let subscriber_vec = vec![MySubscriber, MySubscriber];
/// let subscribers = Subscribers::from_iter(subscriber_vec);
///
/// // Create from pre-wrapped Arc subscribers
/// let arc_subscribers: Vec<Arc<dyn AgentSubscriber>> = vec![
///     Arc::new(MySubscriber)
/// ];
/// let subscribers = Subscribers::new(arc_subscribers);
/// ```
///
#[derive(Clone)]
pub struct Subscribers<StateT: AgentState = JsonValue, FwdPropsT: FwdProps = JsonValue> {
    subs: Vec<Arc<dyn AgentSubscriber<StateT, FwdPropsT>>>,
}

impl<StateT, FwdPropsT> Subscribers<StateT, FwdPropsT>
where
    StateT: AgentState,
    FwdPropsT: FwdProps,
{
    pub fn new(subscribers: Vec<Arc<dyn AgentSubscriber<StateT, FwdPropsT>>>) -> Self {
        Self { subs: subscribers }
    }

    /// Creates a new Subscribers collection from a single subscriber
    pub fn from_subscriber<T>(subscriber: T) -> Self
    where
        T: AgentSubscriber<StateT, FwdPropsT> + 'static,
    {
        Self::new(vec![Arc::new(subscriber)])
    }
}

impl<StateT, FwdPropsT, T> FromIterator<T> for Subscribers<StateT, FwdPropsT>
where
    StateT: AgentState,
    FwdPropsT: FwdProps,
    T: AgentSubscriber<StateT, FwdPropsT> + 'static,
{
    fn from_iter<I: IntoIterator<Item = T>>(iter: I) -> Self {
        Self::new(
            iter.into_iter()
                .map(|s| Arc::new(s) as Arc<dyn AgentSubscriber<StateT, FwdPropsT>>)
                .collect(),
        )
    }
}

impl<'a, StateT, FwdPropsT> IntoIterator for &'a Subscribers<StateT, FwdPropsT>
where
    StateT: AgentState,
    FwdPropsT: FwdProps,
{
    type Item = &'a Arc<dyn AgentSubscriber<StateT, FwdPropsT>>;
    type IntoIter = Iter<'a, Arc<dyn AgentSubscriber<StateT, FwdPropsT>>>;

    fn into_iter(self) -> Self::IntoIter {
        self.subs.iter()
    }
}

/// Trait for types that can be converted into a Subscribers collection
/// This allows for flexible input types in APIs that accept subscribers
pub trait IntoSubscribers<StateT: AgentState, FwdPropsT: FwdProps>: Send {
    fn into_subscribers(self) -> Subscribers<StateT, FwdPropsT>;
}

// Implementation for Subscribers itself (identity conversion)
impl<StateT, FwdPropsT> IntoSubscribers<StateT, FwdPropsT> for Subscribers<StateT, FwdPropsT>
where
    StateT: AgentState,
    FwdPropsT: FwdProps,
{
    fn into_subscribers(self) -> Subscribers<StateT, FwdPropsT> {
        self
    }
}

// Implementation for no subscriber
impl<StateT, FwdPropsT> IntoSubscribers<StateT, FwdPropsT> for Option<()>
where
    StateT: AgentState,
    FwdPropsT: FwdProps,
{
    fn into_subscribers(self) -> Subscribers<StateT, FwdPropsT> {
        Subscribers::new(vec![])
    }
}

// Implementation for single subscribers, as a unit-sized tuple
impl<StateT, FwdPropsT, T> IntoSubscribers<StateT, FwdPropsT> for (T,)
where
    StateT: AgentState,
    FwdPropsT: FwdProps,
    T: AgentSubscriber<StateT, FwdPropsT> + 'static,
{
    fn into_subscribers(self) -> Subscribers<StateT, FwdPropsT> {
        Subscribers::from_subscriber(self.0)
    }
}

// Implementation for Vec of subscribers
impl<StateT, FwdPropsT, T> IntoSubscribers<StateT, FwdPropsT> for Vec<T>
where
    StateT: AgentState,
    FwdPropsT: FwdProps,
    T: AgentSubscriber<StateT, FwdPropsT> + 'static,
{
    fn into_subscribers(self) -> Subscribers<StateT, FwdPropsT> {
        Subscribers::from_iter(self)
    }
}

// Implementation for arrays of subscribers
impl<StateT, FwdPropsT, T, const N: usize> IntoSubscribers<StateT, FwdPropsT> for [T; N]
where
    StateT: AgentState,
    FwdPropsT: FwdProps,
    T: AgentSubscriber<StateT, FwdPropsT> + 'static,
{
    fn into_subscribers(self) -> Subscribers<StateT, FwdPropsT> {
        Subscribers::from_iter(self)
    }
}

// Implementation for empty case (no subscribers)
impl<StateT, FwdPropsT> IntoSubscribers<StateT, FwdPropsT> for ()
where
    StateT: AgentState,
    FwdPropsT: FwdProps,
{
    fn into_subscribers(self) -> Subscribers<StateT, FwdPropsT> {
        Subscribers::new(vec![])
    }
}
