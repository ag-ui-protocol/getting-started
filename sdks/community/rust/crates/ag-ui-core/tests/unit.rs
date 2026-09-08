#[cfg(test)]
mod tests {
    use ag_ui_core::error::AgUiError;
    use ag_ui_core::event::{
        ActivityDeltaEvent, ActivitySnapshotEvent, BaseEvent, Event, EventType,
        ReasoningEncryptedValueEvent, ReasoningEncryptedValueSubtype, ReasoningMessageContentEvent,
        RunFinishedEvent, RunFinishedOutcome, TextMessageStartEvent,
    };
    use ag_ui_core::types::{
        AssistantMessage, Context, DeveloperMessage, FunctionCall, Interrupt, Message, MessageId,
        ResumeEntry, ResumeStatus, Role, RunAgentInput, RunId, SystemMessage, ThreadId, Tool,
        ToolCall, ToolCallId, ToolMessage, UserMessage,
    };
    use serde::{Deserialize, Serialize};
    use serde_json::json;
    use uuid::Uuid;

    fn base_event() -> BaseEvent {
        BaseEvent {
            timestamp: None,
            raw_event: None,
        }
    }

    #[test]
    fn test_role_serialization() {
        let role = Role::Developer;
        let json = serde_json::to_string(&role).unwrap();
        assert_eq!(json, r#""developer""#);

        let role = Role::Reasoning;
        let json = serde_json::to_string(&role).unwrap();
        assert_eq!(json, r#""reasoning""#);
    }

    #[test]
    fn test_message_types() {
        let dev_msg = DeveloperMessage::new(MessageId::random(), "dev content".to_string())
            .with_name("dev".to_string());
        assert_eq!(dev_msg.role, Role::Developer);
        assert_eq!(dev_msg.name, Some("dev".to_string()));

        let sys_msg = SystemMessage::new(MessageId::random(), "sys content".to_string())
            .with_name("sys".to_string());
        assert_eq!(sys_msg.role, Role::System);

        let user_msg = UserMessage::new(MessageId::random(), "user content".to_string())
            .with_name("user".to_string());
        assert_eq!(user_msg.role, Role::User);

        let tool_msg = ToolMessage::new(
            MessageId::random(),
            "result".to_string(),
            ToolCallId::random(),
        )
        .with_error("error".to_string());
        assert_eq!(tool_msg.role, Role::Tool);
        assert_eq!(tool_msg.error, Some("error".to_string()));
    }

    #[test]
    fn test_message_serialization() {
        let user_msg = Message::User {
            id: MessageId::random(),
            content: "Hello".to_string(),
            name: None,
            encrypted_value: None,
        };

        let json = serde_json::to_string(&user_msg).unwrap();
        let deserialized: Message = serde_json::from_str(&json).unwrap();

        assert_eq!(user_msg, deserialized);
    }

    #[test]
    fn test_tool_call_creation() {
        let function_call = FunctionCall {
            name: "test_function".to_string(),
            arguments: "{}".to_string(),
        };

        let tool_call = ToolCall::new(ToolCallId::random(), function_call);
        assert_eq!(tool_call.call_type, "function");

        let tool_call = tool_call.with_encrypted_value("enc".to_string());
        assert_eq!(tool_call.encrypted_value, Some("enc".to_string()));
    }

    #[test]
    fn test_assistant_message_builder() {
        let msg = AssistantMessage::new(MessageId::random())
            .with_content("Hello".to_string())
            .with_name("Assistant".to_string());

        assert_eq!(msg.content, Some("Hello".to_string()));
        assert_eq!(msg.name, Some("Assistant".to_string()));
    }

    #[test]
    fn test_context_and_tool() {
        let context = Context::new("test desc".to_string(), "test value".to_string());
        assert_eq!(context.description, "test desc");

        let tool = Tool::new(
            "test_tool".to_string(),
            "tool desc".to_string(),
            json!({"type": "object"}),
        )
        .with_metadata(json!({"renderer": "a2ui"}));
        assert_eq!(tool.name, "test_tool");
        assert_eq!(tool.metadata, Some(json!({"renderer": "a2ui"})));
    }

    #[test]
    fn test_agui_error() {
        let error = AgUiError::new("test error");
        assert_eq!(error.to_string(), "AG-UI Error: test error");
    }

    #[test]
    fn test_custom_state() {
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
        struct CustomState {
            pub document: String,
            pub num_edits: u64,
        }

        let state = CustomState {
            document: "Hello, world!".to_string(),
            num_edits: 0,
        };

        // If this compiles, it's okay
        let _input = RunAgentInput::new(
            ThreadId::random(),
            RunId::random(),
            state,
            vec![],
            vec![],
            vec![],
            json!({}),
        );
    }

    #[test]
    fn test_custom_forward_props() {
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
        struct CustomFwdProps {
            pub document: String,
            pub num_edits: u64,
        }

        let fwd_props = CustomFwdProps {
            document: "Hello, world!".to_string(),
            num_edits: 0,
        };

        // If this compiles, it's okay
        let _input = RunAgentInput::new(
            Uuid::new_v4(),
            Uuid::new_v4(),
            json!({}),
            vec![],
            vec![],
            vec![],
            fwd_props,
        );
    }

    #[test]
    fn test_complex_assistant_message_deserialization() {
        let json_str = r#"{
			"role": "assistant",
			"id": "00000000-0000-0000-0000-000000000000",
			"content": "I'll help you with that function.",
			"name": "CodeHelper",
			"toolCalls": [
				{
					"id": "00000000-0000-0000-0000-000000000000",
					"type": "function",
					"function": {
						"name": "write_function",
						"arguments": "{\"language\":\"rust\",\"name\":\"example\"}"
					}
				}
			]
		}"#;

        let msg: Message = serde_json::from_str(json_str).unwrap();
        match msg {
            Message::Assistant {
                id,
                content,
                name,
                tool_calls,
                ..
            } => {
                assert_eq!(id.to_string(), "00000000-0000-0000-0000-000000000000");
                assert_eq!(
                    content,
                    Some("I'll help you with that function.".to_string())
                );
                assert_eq!(name, Some("CodeHelper".to_string()));
                assert!(tool_calls.is_some());
                let calls = tool_calls.unwrap();
                assert_eq!(calls.len(), 1);
                assert_eq!(calls[0].function.name, "write_function");
            }
            _ => panic!("Wrong message type"),
        }
    }

    #[test]
    fn test_complex_message_array_deserialization() {
        let json_str = r#"[
			{
				"role": "user",
				"id": "00000000-0000-0000-0000-000000000000",
				"content": "Hello!",
				"name": "Alice"
			},
			{
				"role": "assistant",
				"id": "00000000-0000-0000-0000-000000000000",
				"content": "Hi Alice!",
				"name": "Assistant"
			},
			{
				"role": "tool",
				"id": "00000000-0000-0000-0000-000000000000",
				"content": "Function result",
				"toolCallId": "00000000-0000-0000-0000-000000000000"
			}
		]"#;

        let messages: Vec<Message> = serde_json::from_str(json_str).unwrap();
        assert_eq!(messages.len(), 3);

        match &messages[0] {
            Message::User {
                id, content, name, ..
            } => {
                assert_eq!(id.to_string(), "00000000-0000-0000-0000-000000000000");
                assert_eq!(content, "Hello!");
                assert_eq!(*name, Some("Alice".to_string()));
            }
            _ => panic!("Wrong message type"),
        }
    }

    #[test]
    fn test_activity_and_reasoning_messages() {
        let activity_id = MessageId::random();
        let reasoning_id = MessageId::random();
        let json_value = json!([
            {
                "role": "activity",
                "id": activity_id,
                "activityType": "progress",
                "content": {"pct": 10}
            },
            {
                "role": "reasoning",
                "id": reasoning_id,
                "content": "step 1",
                "encryptedValue": "enc"
            }
        ]);

        let messages: Vec<Message> = serde_json::from_value(json_value).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role(), Role::Activity);
        assert_eq!(messages[1].role(), Role::Reasoning);

        match &messages[0] {
            Message::Activity {
                activity_type,
                content,
                ..
            } => {
                assert_eq!(activity_type, "progress");
                assert_eq!(content["pct"], 10);
            }
            _ => panic!("Wrong message type"),
        }
    }

    #[test]
    fn test_complex_run_agent_input_deserialization() {
        let json_str = r#"{
			"threadId": "00000000-0000-0000-0000-000000000000",
			"runId": "00000000-0000-0000-0000-000000000000",
			"state": {"counter": 42},
			"messages": [
				{
					"role": "user",
					"id": "00000000-0000-0000-0000-000000000000",
					"content": "Hello"
				}
			],
			"tools": [
				{
					"name": "calculator",
					"description": "Performs calculations",
					"parameters": {
						"type": "object",
						"properties": {
							"operation": {"type": "string"}
						}
					}
				}
			],
			"context": [
				{
					"description": "Current time",
					"value": "2024-02-14T12:00:00Z"
				}
			],
			"forwardedProps": {"settings": {"debug": true}}
		}"#;

        let input: RunAgentInput = serde_json::from_str(json_str).unwrap();
        assert_eq!(input.messages.len(), 1);
        assert_eq!(input.tools.len(), 1);
        assert_eq!(input.context.len(), 1);
    }

    #[test]
    fn test_complex_run_agent_input_deserialization_custom_state() {
        #[derive(Debug, Deserialize, Serialize)]
        struct CustomState {
            counter: u32,
        }

        #[derive(Debug, Deserialize, Serialize)]
        struct OtherState {
            document: String,
        }

        let json_str = r#"{
			"threadId": "00000000-0000-0000-0000-000000000000",
			"runId": "00000000-0000-0000-0000-000000000000",
			"state": {"counter": 42},
			"messages": [
				{
					"role": "user",
					"id": "00000000-0000-0000-0000-000000000000",
					"content": "Hello"
				}
			],
			"tools": [
				{
					"name": "calculator",
					"description": "Performs calculations",
					"parameters": {
						"type": "object",
						"properties": {
							"operation": {"type": "string"}
						}
					}
				}
			],
			"context": [
				{
					"description": "Current time",
					"value": "2024-02-14T12:00:00Z"
				}
			],
			"forwardedProps": {"settings": {"debug": true}}
		}"#;

        let input: RunAgentInput<CustomState> = serde_json::from_str(json_str).unwrap();
        assert_eq!(input.messages.len(), 1);
        assert_eq!(input.tools.len(), 1);
        assert_eq!(input.context.len(), 1);

        let wrong_input: serde_json::Result<RunAgentInput<OtherState>> =
            serde_json::from_str(json_str);
        assert!(wrong_input.is_err())
    }

    #[test]
    fn test_run_agent_input_parent_and_resume_serialization() {
        let parent_run_id = RunId::random();
        let resume = ResumeEntry {
            interrupt_id: "int1".to_string(),
            status: ResumeStatus::Resolved,
            payload: Some(json!({"answer": 42})),
        };

        let input = RunAgentInput::new(
            ThreadId::random(),
            RunId::random(),
            json!({}),
            vec![],
            vec![],
            vec![],
            json!({}),
        )
        .with_parent_run_id(parent_run_id.clone())
        .with_resume(vec![resume]);

        let payload = serde_json::to_value(&input).unwrap();
        assert_eq!(payload["parentRunId"], parent_run_id.to_string());
        assert_eq!(payload["resume"][0]["interruptId"], "int1");
        assert_eq!(payload["resume"][0]["status"], "resolved");

        let round_trip: RunAgentInput = serde_json::from_value(payload).unwrap();
        assert_eq!(round_trip.parent_run_id, Some(parent_run_id));
        assert_eq!(round_trip.resume.unwrap()[0].status, ResumeStatus::Resolved);
    }

    #[test]
    fn test_new_event_shapes_serialization() {
        let message_id = MessageId::random();
        let text_event: Event = Event::TextMessageStart(TextMessageStartEvent {
            base: base_event(),
            message_id: message_id.clone(),
            role: Role::Assistant,
            name: Some("research-agent".to_string()),
        });
        let payload = serde_json::to_value(&text_event).unwrap();
        assert_eq!(payload["type"], "TEXT_MESSAGE_START");
        assert_eq!(payload["messageId"], message_id.to_string());
        assert_eq!(payload["name"], "research-agent");

        let activity_event: Event = Event::ActivitySnapshot(ActivitySnapshotEvent {
            base: base_event(),
            message_id: message_id.clone(),
            activity_type: "progress".to_string(),
            content: json!({"pct": 20}),
            replace: true,
        });
        let payload = serde_json::to_value(&activity_event).unwrap();
        assert_eq!(payload["type"], "ACTIVITY_SNAPSHOT");
        assert_eq!(payload["activityType"], "progress");
        assert_eq!(payload["content"]["pct"], 20);

        let reasoning_event: Event = Event::ReasoningMessageContent(ReasoningMessageContentEvent {
            base: base_event(),
            message_id: message_id.clone(),
            delta: "thinking".to_string(),
        });
        let payload = serde_json::to_value(&reasoning_event).unwrap();
        assert_eq!(payload["type"], "REASONING_MESSAGE_CONTENT");
        assert_eq!(payload["delta"], "thinking");
    }

    #[test]
    fn test_run_finished_outcome_serialization() {
        let interrupt = Interrupt::new("int1", "input_required");
        let event: Event = Event::RunFinished(RunFinishedEvent {
            base: base_event(),
            thread_id: ThreadId::random(),
            run_id: RunId::random(),
            result: None,
            outcome: Some(RunFinishedOutcome::Interrupt {
                interrupts: vec![interrupt],
            }),
        });

        let payload = serde_json::to_value(&event).unwrap();
        assert_eq!(payload["type"], "RUN_FINISHED");
        assert_eq!(payload["outcome"]["type"], "interrupt");
        assert_eq!(payload["outcome"]["interrupts"][0]["id"], "int1");

        let round_trip: Event = serde_json::from_value(payload).unwrap();
        assert_eq!(round_trip.event_type(), EventType::RunFinished);
    }

    #[test]
    fn test_activity_delta_and_reasoning_encrypted_events_deserialize() {
        let message_id = MessageId::random();
        let delta_payload = json!({
            "type": "ACTIVITY_DELTA",
            "messageId": message_id,
            "activityType": "progress",
            "patch": [{"op": "replace", "path": "/pct", "value": 50}]
        });
        let event: Event = serde_json::from_value(delta_payload).unwrap();
        match event {
            Event::ActivityDelta(ActivityDeltaEvent { patch, .. }) => {
                assert_eq!(patch[0]["op"], "replace");
            }
            _ => panic!("Wrong event type"),
        }

        let encrypted_payload = json!({
            "type": "REASONING_ENCRYPTED_VALUE",
            "subtype": "tool-call",
            "entityId": "call_123",
            "encryptedValue": "enc"
        });
        let event: Event = serde_json::from_value(encrypted_payload).unwrap();
        match event {
            Event::ReasoningEncryptedValue(ReasoningEncryptedValueEvent {
                subtype,
                entity_id,
                encrypted_value,
                ..
            }) => {
                assert_eq!(subtype, ReasoningEncryptedValueSubtype::ToolCall);
                assert_eq!(entity_id, "call_123");
                assert_eq!(encrypted_value, "enc");
            }
            _ => panic!("Wrong event type"),
        }
    }
}
