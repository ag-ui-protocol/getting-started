use crate::agent::{AgentError, AgentStateMutation};
use crate::core::event::Event;
use crate::core::types::{FunctionCall, Message, MessageId, Role, RunAgentInput, ToolCall};
use crate::core::{AgentState, FwdProps, JsonValue};
use crate::subscriber::{AgentSubscriberParams, Subscribers};
use json_patch::PatchOperation;
use log::error;
use std::collections::{HashMap, HashSet};

/// Captures the run state and handles events
#[derive(Clone)]
pub(crate) struct EventHandler<'a, StateT, FwdPropsT>
where
    StateT: AgentState,
    FwdPropsT: FwdProps,
{
    pub messages: Vec<Message>,
    pub state: StateT,
    pub input: &'a RunAgentInput<StateT, FwdPropsT>,
    pub subscribers: Subscribers<StateT, FwdPropsT>,
    pub result: JsonValue,
}

impl<'a, StateT, FwdPropsT> EventHandler<'a, StateT, FwdPropsT>
where
    StateT: AgentState,
    FwdPropsT: FwdProps,
{
    pub fn new(
        messages: Vec<Message>,
        state: StateT,
        input: &'a RunAgentInput<StateT, FwdPropsT>,
        subscribers: Subscribers<StateT, FwdPropsT>,
    ) -> Self {
        Self {
            messages,
            state,
            input,
            subscribers,
            result: JsonValue::Null,
        }
    }

    fn to_subscriber_params(&'a self) -> AgentSubscriberParams<'a, StateT, FwdPropsT> {
        AgentSubscriberParams {
            messages: &self.messages,
            state: &self.state,
            input: self.input,
        }
    }

    // Helper method to directly update state and messages without using apply_mutation
    fn update_from_mutation(&mut self, mutation: &AgentStateMutation<StateT>) {
        if let Some(messages) = &mutation.messages {
            self.messages = messages.clone();
        }
        if let Some(state) = &mutation.state {
            self.state = state.clone();
        }
    }

    // Helper method to process a subscriber's mutation
    fn process_mutation(
        &mut self,
        mutation: AgentStateMutation<StateT>,
        current_mutation: &mut AgentStateMutation<StateT>,
    ) {
        // Apply any mutations
        if mutation.messages.is_some() || mutation.state.is_some() {
            // Update directly without using apply_mutation
            self.update_from_mutation(&mutation);

            // Update current_mutation with the applied changes
            if mutation.messages.is_some() {
                current_mutation.messages = mutation.messages;
            }
            if mutation.state.is_some() {
                current_mutation.state = mutation.state;
            }
        }
    }

    pub async fn handle_event(
        &mut self,
        event: &Event<StateT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        let mut current_mutation = AgentStateMutation::default();
        let mut mutations = Vec::new();

        // Clone subscribers to avoid borrowing issues
        for subscriber in &self.subscribers.clone() {
            let params = self.to_subscriber_params();
            let mutation = subscriber.on_event(event, params).await?;
            mutations.push(mutation);
        }

        // Then handle specific event types
        match event {
            Event::TextMessageStart(e) => {
                // Default behavior
                if !self.messages.iter().any(|m| m.id() == &e.message_id) {
                    let new_message = match e.role {
                        Role::Developer => Message::Developer {
                            id: e.message_id.clone(),
                            content: String::new(),
                            name: e.name.clone(),
                            encrypted_value: None,
                        },
                        Role::System => Message::System {
                            id: e.message_id.clone(),
                            content: String::new(),
                            name: e.name.clone(),
                            encrypted_value: None,
                        },
                        Role::User => Message::User {
                            id: e.message_id.clone(),
                            content: String::new(),
                            name: e.name.clone(),
                            encrypted_value: None,
                        },
                        Role::Reasoning => Message::Reasoning {
                            id: e.message_id.clone(),
                            content: String::new(),
                            encrypted_value: None,
                        },
                        Role::Assistant | Role::Tool | Role::Activity => Message::Assistant {
                            id: e.message_id.clone(),
                            content: Some(String::new()),
                            name: e.name.clone(),
                            tool_calls: None,
                            encrypted_value: None,
                        },
                    };
                    self.messages.push(new_message);
                    current_mutation.messages = Some(self.messages.clone());
                }

                for subscriber in &self.subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_text_message_start_event(e, params).await?;
                    mutations.push(mutation);
                }
            }
            Event::TextMessageContent(e) => {
                // Default behavior
                if let Some(last_message) = self
                    .messages
                    .iter_mut()
                    .find(|message| message.id() == &e.message_id)
                {
                    let content = last_message.content_mut();
                    if let Some(s) = content {
                        s.push_str(&e.delta)
                    }
                    current_mutation.messages = Some(self.messages.clone());
                }

                // Get the current text message buffer
                let text_message_buffer = self
                    .messages
                    .iter()
                    .find(|message| message.id() == &e.message_id)
                    .and_then(|m| m.content())
                    .unwrap_or_default()
                    .to_string(); // Clone to avoid borrowing issues

                for subscriber in &self.subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber
                        .on_text_message_content_event(e, &text_message_buffer, params)
                        .await?;
                    mutations.push(mutation);
                }
            }
            Event::TextMessageEnd(e) => {
                // Get the current text message buffer
                let text_message_buffer = self
                    .messages
                    .iter()
                    .find(|message| message.id() == &e.message_id)
                    .and_then(|m| m.content())
                    .unwrap_or_default()
                    .to_string(); // Clone to avoid borrowing issues

                for subscriber in &self.subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber
                        .on_text_message_end_event(e, &text_message_buffer, params)
                        .await?;
                    mutations.push(mutation);
                }
            }
            Event::TextMessageChunk(e) => {
                for subscriber in &self.subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_text_message_chunk_event(e, params).await?;
                    mutations.push(mutation);
                }
            }
            Event::ThinkingTextMessageStart(e) => {
                for subscriber in &self.subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber
                        .on_thinking_text_message_start_event(e, params)
                        .await?;
                    mutations.push(mutation);
                }
            }
            Event::ThinkingTextMessageContent(e) => {
                for subscriber in &self.subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber
                        .on_thinking_text_message_content_event(e, params)
                        .await?;
                    mutations.push(mutation);
                }
            }
            Event::ThinkingTextMessageEnd(e) => {
                for subscriber in &self.subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber
                        .on_thinking_text_message_end_event(e, params)
                        .await?;
                    mutations.push(mutation);
                }
            }
            Event::ToolCallStart(e) => {
                // Default behavior
                let new_tool_call = ToolCall {
                    id: e.tool_call_id.clone(),
                    call_type: "function".to_string(),
                    function: FunctionCall {
                        name: e.tool_call_name.clone(),
                        arguments: String::new(),
                    },
                    encrypted_value: None,
                };

                let parent_message_index = e.parent_message_id.as_ref().and_then(|parent_id| {
                    self.messages
                        .iter()
                        .position(|message| message.id() == parent_id)
                });

                let target_assistant_index = parent_message_index.and_then(|index| {
                    matches!(self.messages.get(index), Some(Message::Assistant { .. }))
                        .then_some(index)
                });

                if let Some(index) = target_assistant_index {
                    if let Some(tool_calls) = self.messages[index].tool_calls_mut() {
                        tool_calls.push(new_tool_call);
                    }
                } else {
                    let new_message = Message::Assistant {
                        id: if parent_message_index.is_some() {
                            MessageId::random()
                        } else {
                            e.parent_message_id
                                .clone()
                                .unwrap_or_else(MessageId::random)
                        },
                        content: None,
                        name: None,
                        tool_calls: Some(vec![new_tool_call]),
                        encrypted_value: None,
                    };
                    self.messages.push(new_message);
                }
                current_mutation.messages = Some(self.messages.clone());

                for subscriber in &self.subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_tool_call_start_event(e, params).await?;
                    mutations.push(mutation);
                }
            }
            Event::ToolCallArgs(e) => {
                // Default behavior
                if let Some(tool_call) = self
                    .messages
                    .iter_mut()
                    .filter_map(|message| match message {
                        Message::Assistant {
                            tool_calls: Some(tool_calls),
                            ..
                        } => Some(tool_calls),
                        _ => None,
                    })
                    .find_map(|tool_calls| {
                        tool_calls
                            .iter_mut()
                            .find(|tool_call| tool_call.id == e.tool_call_id)
                    })
                {
                    tool_call.function.arguments.push_str(&e.delta);
                    current_mutation.messages = Some(self.messages.clone());
                }

                // Get the current tool call buffer and name
                let (tool_call_buffer, tool_call_name, partial_args) = self
                    .messages
                    .iter()
                    .filter_map(|message| message.tool_calls())
                    .find_map(|tool_calls| {
                        tool_calls
                            .iter()
                            .find(|tool_call| tool_call.id == e.tool_call_id)
                    })
                    .map(|tool_call| {
                        let partial_args = serde_json::from_str::<HashMap<String, JsonValue>>(
                            &tool_call.function.arguments,
                        )
                        .unwrap_or_default();
                        (
                            tool_call.function.arguments.clone(),
                            tool_call.function.name.clone(),
                            partial_args,
                        )
                    })
                    .unwrap_or_else(|| (String::new(), String::new(), HashMap::new()));

                for subscriber in &self.subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber
                        .on_tool_call_args_event(
                            e,
                            &tool_call_buffer,
                            &tool_call_name,
                            &partial_args,
                            params,
                        )
                        .await?;
                    mutations.push(mutation);
                }
            }
            Event::ToolCallEnd(e) => {
                // Get the current tool call buffer and name
                let (tool_call_name, tool_call_args) = self
                    .messages
                    .iter()
                    .filter_map(|message| message.tool_calls())
                    .find_map(|tool_calls| {
                        tool_calls
                            .iter()
                            .find(|tool_call| tool_call.id == e.tool_call_id)
                    })
                    .map(|tool_call| {
                        let args = serde_json::from_str::<HashMap<String, JsonValue>>(
                            &tool_call.function.arguments,
                        )
                        .unwrap_or_default();
                        (tool_call.function.name.clone(), args)
                    })
                    .unwrap_or_else(|| (String::new(), HashMap::new()));

                for subscriber in &self.subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber
                        .on_tool_call_end_event(e, &tool_call_name, &tool_call_args, params)
                        .await?;
                    mutations.push(mutation);
                }
            }
            Event::ToolCallChunk(e) => {
                for subscriber in &self.subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_tool_call_chunk_event(e, params).await?;
                    mutations.push(mutation);
                }
            }
            Event::ToolCallResult(e) => {
                for subscriber in &self.subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_tool_call_result_event(e, params).await?;
                    mutations.push(mutation);
                }
            }
            Event::ThinkingStart(e) => {
                for subscriber in &self.subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_thinking_start_event(e, params).await?;
                    mutations.push(mutation);
                }
            }
            Event::ThinkingEnd(e) => {
                for subscriber in &self.subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_thinking_end_event(e, params).await?;
                    mutations.push(mutation);
                }
            }
            Event::StateSnapshot(e) => {
                // Default behavior
                self.state = e.snapshot.clone();
                current_mutation.state = Some(self.state.clone());

                for subscriber in &self.subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_state_snapshot_event(e, params).await?;
                    mutations.push(mutation);
                }
            }
            Event::StateDelta(e) => {
                // Default behavior
                let mut state_val = serde_json::to_value(&self.state)?;

                // TODO: This cast to and from JsonValue seems unnecessary
                let patches: Vec<PatchOperation> =
                    serde_json::from_value(serde_json::to_value(e.delta.clone())?)?;

                json_patch::patch(&mut state_val, &patches).map_err(|err| {
                    AgentError::Execution {
                        message: format!("Failed to apply state patch: {err}"),
                    }
                })?;
                let new_state: StateT = serde_json::from_value(state_val)?;
                self.state = new_state;
                current_mutation.state = Some(self.state.clone());

                for subscriber in &self.subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_state_delta_event(e, params).await?;
                    mutations.push(mutation);
                }
            }
            Event::MessagesSnapshot(e) => {
                // Default behavior
                let snapshot_has_activity = e
                    .messages
                    .iter()
                    .any(|message| matches!(message, Message::Activity { .. }));
                let snapshot_has_reasoning = e
                    .messages
                    .iter()
                    .any(|message| matches!(message, Message::Reasoning { .. }));

                self.messages.retain(|message| {
                    let in_snapshot = e
                        .messages
                        .iter()
                        .any(|snapshot_message| snapshot_message.id() == message.id());
                    let preserved_client_only = matches!(message, Message::Activity { .. })
                        && !snapshot_has_activity
                        || matches!(message, Message::Reasoning { .. }) && !snapshot_has_reasoning;
                    in_snapshot || preserved_client_only
                });

                for snapshot_message in &e.messages {
                    if let Some(existing_message) = self
                        .messages
                        .iter_mut()
                        .find(|message| message.id() == snapshot_message.id())
                    {
                        *existing_message = snapshot_message.clone();
                    } else {
                        self.messages.push(snapshot_message.clone());
                    }
                }

                current_mutation.messages = Some(self.messages.clone());

                for subscriber in &self.subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_messages_snapshot_event(e, params).await?;
                    mutations.push(mutation);
                }
            }
            Event::ActivitySnapshot(e) => {
                // Default behavior
                let new_message = Message::Activity {
                    id: e.message_id.clone(),
                    activity_type: e.activity_type.clone(),
                    content: e.content.clone(),
                };
                if let Some(index) = self.messages.iter().position(|m| m.id() == &e.message_id) {
                    let existing_is_activity =
                        matches!(self.messages.get(index), Some(Message::Activity { .. }));
                    if existing_is_activity || e.replace {
                        self.messages[index] = new_message;
                        current_mutation.messages = Some(self.messages.clone());
                    }
                } else {
                    self.messages.push(new_message);
                    current_mutation.messages = Some(self.messages.clone());
                }

                for subscriber in &self.subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_activity_snapshot_event(e, params).await?;
                    mutations.push(mutation);
                }
            }
            Event::ActivityDelta(e) => {
                // Default behavior
                if let Some(Message::Activity {
                    activity_type,
                    content,
                    ..
                }) = self.messages.iter_mut().find(|m| m.id() == &e.message_id)
                {
                    let patches: Vec<PatchOperation> =
                        serde_json::from_value(serde_json::to_value(e.patch.clone())?)?;

                    json_patch::patch(content, &patches).map_err(|err| AgentError::Execution {
                        message: format!("Failed to apply activity patch: {err}"),
                    })?;
                    *activity_type = e.activity_type.clone();
                    current_mutation.messages = Some(self.messages.clone());
                }

                for subscriber in &self.subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_activity_delta_event(e, params).await?;
                    mutations.push(mutation);
                }
            }
            Event::Raw(e) => {
                for subscriber in &self.subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_raw_event(e, params).await?;
                    mutations.push(mutation);
                }
            }
            Event::Custom(e) => {
                for subscriber in &self.subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_custom_event(e, params).await?;
                    mutations.push(mutation);
                }
            }
            Event::RunStarted(e) => {
                if let Some(input) = &e.input {
                    for message in &input.messages {
                        if !self.messages.iter().any(|m| m.id() == message.id()) {
                            self.messages.push(message.clone());
                        }
                    }
                    current_mutation.messages = Some(self.messages.clone());
                }

                for subscriber in &self.subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_run_started_event(e, params).await?;
                    mutations.push(mutation);
                }
            }
            Event::RunFinished(e) => {
                // Default behavior
                self.result = e.result.clone().unwrap_or(JsonValue::Null);

                for subscriber in &self.subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_run_finished_event(e, params).await?;
                    mutations.push(mutation);
                }
            }
            Event::RunError(e) => {
                for subscriber in &self.subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_run_error_event(e, params).await?;
                    mutations.push(mutation);
                }
            }
            Event::StepStarted(e) => {
                for subscriber in &self.subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_step_started_event(e, params).await?;
                    mutations.push(mutation);
                }
            }
            Event::StepFinished(e) => {
                for subscriber in &self.subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_step_finished_event(e, params).await?;
                    mutations.push(mutation);
                }
            }
            Event::ReasoningStart(e) => {
                for subscriber in &self.subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_reasoning_start_event(e, params).await?;
                    mutations.push(mutation);
                }
            }
            Event::ReasoningMessageStart(e) => {
                if !self.messages.iter().any(|m| m.id() == &e.message_id) {
                    self.messages.push(Message::Reasoning {
                        id: e.message_id.clone(),
                        content: String::new(),
                        encrypted_value: None,
                    });
                    current_mutation.messages = Some(self.messages.clone());
                }

                for subscriber in &self.subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber
                        .on_reasoning_message_start_event(e, params)
                        .await?;
                    mutations.push(mutation);
                }
            }
            Event::ReasoningMessageContent(e) => {
                if let Some(message) = self.messages.iter_mut().find(|m| m.id() == &e.message_id)
                    && let Some(content) = message.content_mut()
                {
                    content.push_str(&e.delta);
                    current_mutation.messages = Some(self.messages.clone());
                }

                let reasoning_message_buffer = self
                    .messages
                    .iter()
                    .find(|m| m.id() == &e.message_id)
                    .and_then(|m| m.content())
                    .unwrap_or_default()
                    .to_string();

                for subscriber in &self.subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber
                        .on_reasoning_message_content_event(e, &reasoning_message_buffer, params)
                        .await?;
                    mutations.push(mutation);
                }
            }
            Event::ReasoningMessageEnd(e) => {
                let reasoning_message_buffer = self
                    .messages
                    .iter()
                    .find(|m| m.id() == &e.message_id)
                    .and_then(|m| m.content())
                    .unwrap_or_default()
                    .to_string();

                for subscriber in &self.subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber
                        .on_reasoning_message_end_event(e, &reasoning_message_buffer, params)
                        .await?;
                    mutations.push(mutation);
                }
            }
            Event::ReasoningMessageChunk(e) => {
                for subscriber in &self.subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber
                        .on_reasoning_message_chunk_event(e, params)
                        .await?;
                    mutations.push(mutation);
                }
            }
            Event::ReasoningEnd(e) => {
                for subscriber in &self.subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_reasoning_end_event(e, params).await?;
                    mutations.push(mutation);
                }
            }
            Event::ReasoningEncryptedValue(e) => {
                let mut entity_updated = false;
                match e.subtype {
                    crate::core::event::ReasoningEncryptedValueSubtype::ToolCall => {
                        for message in &mut self.messages {
                            if let Message::Assistant {
                                tool_calls: Some(tool_calls),
                                ..
                            } = message
                                && let Some(tool_call) = tool_calls
                                    .iter_mut()
                                    .find(|tc| tc.id.to_string() == e.entity_id)
                            {
                                tool_call.encrypted_value = Some(e.encrypted_value.clone());
                                entity_updated = true;
                                break;
                            }
                        }
                    }
                    crate::core::event::ReasoningEncryptedValueSubtype::Message => {
                        if let Some(encrypted_value) = self
                            .messages
                            .iter_mut()
                            .find(|message| message.id().to_string() == e.entity_id)
                            .and_then(|message| message.encrypted_value_mut())
                        {
                            *encrypted_value = Some(e.encrypted_value.clone());
                            entity_updated = true;
                        }
                    }
                }

                if entity_updated {
                    current_mutation.messages = Some(self.messages.clone());
                }

                for subscriber in &self.subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber
                        .on_reasoning_encrypted_value_event(e, params)
                        .await?;
                    mutations.push(mutation);
                }
            }
        }

        for mutation in mutations {
            if mutation.stop_propagation {
                self.update_from_mutation(&mutation);
                return Ok(mutation);
            } else {
                self.process_mutation(mutation, &mut current_mutation);
            }
        }

        Ok(current_mutation)
    }

    pub async fn apply_mutation(
        &mut self,
        mutation: AgentStateMutation<StateT>,
    ) -> Result<(), AgentError> {
        if let Some(messages) = mutation.messages {
            // Check for new messages to notify about
            let old_message_ids: HashSet<&MessageId> =
                self.messages.iter().map(|m| m.id()).collect();

            let new_messages: Vec<&Message> = messages
                .iter()
                .filter(|m| !old_message_ids.contains(m.id()))
                .collect();

            // Set the new messages first
            self.messages = messages.clone();

            // Notify about new messages
            for message in new_messages {
                self.notify_new_message(message).await?;

                // If the message is from assistant and has tool calls, notify about those too
                if message.role() == Role::Assistant && message.tool_calls().is_some() {
                    for tool_call in message.tool_calls().unwrap() {
                        self.notify_new_tool_call(tool_call).await?;
                    }
                }
            }

            // Then notify about messages changed
            self.notify_messages_changed().await?;
        }

        if let Some(state) = mutation.state {
            self.state = state;
            self.notify_state_changed().await?;
        }

        Ok(())
    }

    async fn notify_new_message(&self, message: &Message) -> Result<(), AgentError> {
        for subscriber in &self.subscribers {
            subscriber
                .on_new_message(message, self.to_subscriber_params())
                .await?;
        }
        Ok(())
    }

    async fn notify_new_tool_call(&self, tool_call: &ToolCall) -> Result<(), AgentError> {
        for subscriber in &self.subscribers {
            subscriber
                .on_new_tool_call(tool_call, self.to_subscriber_params())
                .await?;
        }
        Ok(())
    }

    async fn notify_messages_changed(&self) -> Result<(), AgentError> {
        for subscriber in &self.subscribers {
            subscriber
                .on_messages_changed(self.to_subscriber_params())
                .await?;
        }
        Ok(())
    }

    async fn notify_state_changed(&self) -> Result<(), AgentError> {
        for subscriber in &self.subscribers {
            subscriber
                .on_state_changed(self.to_subscriber_params())
                .await?;
        }
        Ok(())
    }

    pub async fn on_error(&self, error: &AgentError) -> Result<(), AgentError> {
        error!("Agent error: {error}");
        for subscriber in &self.subscribers {
            let _mutation = subscriber
                .on_run_failed(error, self.to_subscriber_params())
                .await?;
        }
        Ok(())
    }

    pub async fn on_finalize(&self) -> Result<(), AgentError> {
        for subscriber in &self.subscribers {
            let _mutation = subscriber
                .on_run_finalized(self.to_subscriber_params())
                .await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::event::{
        BaseEvent, TextMessageContentEvent, TextMessageStartEvent, ToolCallArgsEvent,
        ToolCallStartEvent,
    };
    use crate::core::types::{RunId, ThreadId, ToolCallId};
    use crate::subscriber::Subscribers;
    use serde_json::json;

    fn base_event() -> BaseEvent {
        BaseEvent {
            timestamp: None,
            raw_event: None,
        }
    }

    fn input() -> RunAgentInput {
        RunAgentInput::new(
            ThreadId::random(),
            RunId::random(),
            json!({}),
            vec![],
            vec![],
            vec![],
            json!({}),
        )
    }

    #[tokio::test]
    async fn text_events_use_role_name_and_message_id() {
        let input = input();
        let message_id = MessageId::random();
        let mut handler = EventHandler::new(
            vec![Message::Assistant {
                id: MessageId::random(),
                content: Some("existing".to_string()),
                name: None,
                tool_calls: None,
                encrypted_value: None,
            }],
            json!({}),
            &input,
            Subscribers::new(vec![]),
        );

        handler
            .handle_event(&Event::TextMessageStart(TextMessageStartEvent {
                base: base_event(),
                message_id: message_id.clone(),
                role: Role::User,
                name: Some("Alice".to_string()),
            }))
            .await
            .unwrap();

        handler.messages.push(Message::Assistant {
            id: MessageId::random(),
            content: Some("tail".to_string()),
            name: None,
            tool_calls: None,
            encrypted_value: None,
        });

        handler
            .handle_event(&Event::TextMessageContent(TextMessageContentEvent {
                base: base_event(),
                message_id: message_id.clone(),
                delta: "hello".to_string(),
            }))
            .await
            .unwrap();

        let target = handler
            .messages
            .iter()
            .find(|message| message.id() == &message_id)
            .unwrap();
        match target {
            Message::User { content, name, .. } => {
                assert_eq!(content, "hello");
                assert_eq!(name.as_deref(), Some("Alice"));
            }
            _ => panic!("expected user message"),
        }
    }

    #[tokio::test]
    async fn tool_call_start_without_parent_keeps_tool_call() {
        let input = input();
        let tool_call_id = ToolCallId::random();
        let mut handler = EventHandler::new(
            vec![Message::new_user("hello")],
            json!({}),
            &input,
            Subscribers::new(vec![]),
        );

        handler
            .handle_event(&Event::ToolCallStart(ToolCallStartEvent {
                base: base_event(),
                tool_call_id: tool_call_id.clone(),
                tool_call_name: "search".to_string(),
                parent_message_id: None,
            }))
            .await
            .unwrap();

        handler
            .handle_event(&Event::ToolCallArgs(ToolCallArgsEvent {
                base: base_event(),
                tool_call_id: tool_call_id.clone(),
                delta: "{\"q\":\"ag-ui\"}".to_string(),
            }))
            .await
            .unwrap();

        let tool_call = handler
            .messages
            .iter()
            .filter_map(|message| message.tool_calls())
            .flatten()
            .find(|tool_call| tool_call.id == tool_call_id)
            .unwrap();

        assert_eq!(tool_call.function.name, "search");
        assert_eq!(tool_call.function.arguments, "{\"q\":\"ag-ui\"}");
    }
}
