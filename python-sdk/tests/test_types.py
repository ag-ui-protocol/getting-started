import unittest
from pydantic import ValidationError
from pydantic import TypeAdapter

from ag_ui.core.types import (
    FunctionCall,
    ToolCall,
    DeveloperMessage,
    SystemMessage,
    AssistantMessage,
    UserMessage,
    ToolMessage,
    Message,
    RunAgentInput
)


class TestBaseTypes(unittest.TestCase):
    """Test suite for base type classes"""

    def test_function_call_creation(self):
        """Test creating a FunctionCall instance"""
        func_call = FunctionCall(name="test_function", arguments="{}")
        self.assertEqual(func_call.name, "test_function")
        self.assertEqual(func_call.arguments, "{}")

    def test_message_serialization(self):
        """Test serialization of a basic message"""
        user_msg = UserMessage(
            id="msg_123",
            content="Hello, world!"
        )
        serialized = user_msg.model_dump(by_alias=True)
        self.assertEqual(serialized["id"], "msg_123")
        self.assertEqual(serialized["role"], "user")
        self.assertEqual(serialized["content"], "Hello, world!")

    def test_tool_call_serialization(self):
        """Test camel case serialization for ConfiguredBaseModel subclasses"""
        tool_call = ToolCall(
            id="call_123",
            function=FunctionCall(name="test_function", arguments="{}")
        )
        serialized = tool_call.model_dump(by_alias=True)
        # Should convert function to camelCase
        self.assertIn("function", serialized)

    def test_tool_message_camel_case(self):
        """Test camel case serialization for ToolMessage"""
        tool_msg = ToolMessage(
            id="tool_123",
            content="Tool result",
            tool_call_id="call_456"
        )
        serialized = tool_msg.model_dump(by_alias=True)
        self.assertIn("toolCallId", serialized)
        self.assertEqual(serialized["toolCallId"], "call_456")

    def test_parse_camel_case_json_tool_message(self):
        """Test parsing JSON with camelCase field names"""
        # JSON data with camelCase field names
        json_data = {
            "id": "tool_789",
            "role": "tool",
            "content": "Result from tool",
            "toolCallId": "call_123"  # camelCase field name
        }

        # Parse the JSON data into a ToolMessage instance
        tool_msg = ToolMessage.model_validate(json_data)

        # Verify fields are correctly set
        self.assertEqual(tool_msg.id, "tool_789")
        self.assertEqual(tool_msg.role, "tool")
        self.assertEqual(tool_msg.content, "Result from tool")
        self.assertEqual(tool_msg.tool_call_id, "call_123")

    def test_parse_camel_case_json_function_call(self):
        """Test parsing function call with camelCase fields"""
        # Create a tool call with nested function call in camelCase
        json_data = {
            "id": "call_abc",
            "type": "function",
            "function": {
                "name": "get_weather",
                "arguments": '{"location":"New York"}'
            }
        }

        # Parse JSON into a ToolCall instance
        tool_call = ToolCall.model_validate(json_data)

        # Verify fields are correctly set
        self.assertEqual(tool_call.id, "call_abc")
        self.assertEqual(tool_call.type, "function")
        self.assertEqual(tool_call.function.name, "get_weather")
        self.assertEqual(tool_call.function.arguments, '{"location":"New York"}')

    def test_developer_message(self):
        """Test creating and serializing a developer message"""
        msg = DeveloperMessage(
            id="dev_123",
            content="Developer note"
        )
        serialized = msg.model_dump(by_alias=True)
        self.assertEqual(serialized["role"], "developer")
        self.assertEqual(serialized["content"], "Developer note")

    def test_system_message(self):
        """Test creating and serializing a system message"""
        msg = SystemMessage(
            id="sys_123",
            content="System instruction"
        )
        serialized = msg.model_dump(by_alias=True)
        self.assertEqual(serialized["role"], "system")
        self.assertEqual(serialized["content"], "System instruction")

    def test_assistant_message(self):
        """Test creating and serializing an assistant message with tool calls"""
        tool_call = ToolCall(
            id="call_456",
            function=FunctionCall(name="get_data", arguments='{"param": "value"}')
        )
        msg = AssistantMessage(
            id="asst_123",
            content="Assistant response",
            tool_calls=[tool_call]
        )
        serialized = msg.model_dump(by_alias=True)
        self.assertEqual(serialized["role"], "assistant")
        self.assertEqual(serialized["content"], "Assistant response")
        self.assertEqual(len(serialized["toolCalls"]), 1)
        self.assertEqual(serialized["toolCalls"][0]["id"], "call_456")

    def test_user_message(self):
        """Test creating and serializing a user message"""
        msg = UserMessage(
            id="user_123",
            content="User query"
        )
        serialized = msg.model_dump(by_alias=True)
        self.assertEqual(serialized["role"], "user")
        self.assertEqual(serialized["content"], "User query")

    def test_message_union_deserialization(self):
        """Test that the Message union correctly deserializes to the appropriate type"""
        # Create type adapter for the union
        message_adapter = TypeAdapter(Message)

        # Test each message type
        message_data = [
            {"id": "dev_123", "role": "developer", "content": "Developer note"},
            {"id": "sys_456", "role": "system", "content": "System instruction"},
            {"id": "asst_789", "role": "assistant", "content": "Assistant response"},
            {"id": "user_101", "role": "user", "content": "User query"},
            {
                "id": "tool_202", 
                "role": "tool", 
                "content": "Tool result", 
                "toolCallId": "call_303"
            }
        ]

        expected_types = [
            DeveloperMessage,
            SystemMessage,
            AssistantMessage,
            UserMessage,
            ToolMessage
        ]

        for data, expected_type in zip(message_data, expected_types):
            msg = message_adapter.validate_python(data)
            self.assertIsInstance(msg, expected_type)
            self.assertEqual(msg.id, data["id"])
            self.assertEqual(msg.role, data["role"])
            self.assertEqual(msg.content, data["content"])

    def test_message_union_with_tool_calls(self):
        """Test the Message union with an assistant message containing tool calls"""
        # Create type adapter for the union
        message_adapter = TypeAdapter(Message)

        data = {
            "id": "asst_123",
            "role": "assistant",
            "content": "I'll help with that",
            "toolCalls": [
                {
                    "id": "call_456",
                    "type": "function",
                    "function": {
                        "name": "search_data",
                        "arguments": '{"query": "python"}'
                    }
                }
            ]
        }

        msg = message_adapter.validate_python(data)
        self.assertIsInstance(msg, AssistantMessage)
        self.assertEqual(len(msg.tool_calls), 1)
        self.assertEqual(msg.tool_calls[0].function.name, "search_data")

    def test_run_agent_input_deserialization(self):
        """Test deserializing RunAgentInput JSON with diverse message types"""
        # Create JSON data for RunAgentInput with diverse messages
        run_agent_input_data = {
            "threadId": "thread_12345",
            "runId": "run_67890",
            "state": {"conversation_state": "active", "custom_data": {"key": "value"}},
            "messages": [
                # System message
                {
                    "id": "sys_001",
                    "role": "system",
                    "content": "You are a helpful assistant."
                },
                # User message
                {
                    "id": "user_001",
                    "role": "user",
                    "content": "Can you help me analyze this data?"
                },
                # Developer message
                {
                    "id": "dev_001",
                    "role": "developer",
                    "content": "The assistant should provide a detailed analysis."
                },
                # Assistant message with tool calls
                {
                    "id": "asst_001",
                    "role": "assistant",
                    "content": "I'll analyze the data for you.",
                    "toolCalls": [
                        {
                            "id": "call_001",
                            "type": "function",
                            "function": {
                                "name": "analyze_data",
                                "arguments": '{"dataset": "sales_2023", "metrics": ["mean", "median"]}' # pylint: disable=line-too-long
                            }
                        }
                    ]
                },
                # Tool message responding to tool call
                {
                    "id": "tool_001",
                    "role": "tool",
                    "content": '{"mean": 42.5, "median": 38.0}',
                    "toolCallId": "call_001"
                },
                # Another user message
                {
                    "id": "user_002",
                    "role": "user",
                    "content": "Can you explain these results?"
                }
            ],
            "tools": [
                {
                    "name": "analyze_data",
                    "description": "Analyze a dataset and return statistics",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "dataset": {"type": "string"},
                            "metrics": {"type": "array", "items": {"type": "string"}}
                        },
                        "required": ["dataset"]
                    }
                },
                {
                    "name": "fetch_data",
                    "description": "Fetch data from a database",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "source": {"type": "string"},
                            "query": {"type": "string"}
                        },
                        "required": ["source", "query"]
                    }
                }
            ],
            "context": [
                {
                    "description": "User preferences",
                    "value": '{"theme": "dark", "language": "English"}'
                },
                {
                    "description": "Environment",
                    "value": "production"
                }
            ],
            "forwardedProps": {
                "api_version": "v1",
                "custom_settings": {"max_tokens": 500}
            }
        }

        # Deserialize using TypeAdapter
        run_agent_input = RunAgentInput.model_validate(run_agent_input_data)

        # Verify basic fields
        self.assertEqual(run_agent_input.thread_id, "thread_12345")
        self.assertEqual(run_agent_input.run_id, "run_67890")
        self.assertEqual(run_agent_input.state["conversation_state"], "active")

        # Verify messages count and types
        self.assertEqual(len(run_agent_input.messages), 6)
        self.assertIsInstance(run_agent_input.messages[0], SystemMessage)
        self.assertIsInstance(run_agent_input.messages[1], UserMessage)
        self.assertIsInstance(run_agent_input.messages[2], DeveloperMessage)
        self.assertIsInstance(run_agent_input.messages[3], AssistantMessage)
        self.assertIsInstance(run_agent_input.messages[4], ToolMessage)
        self.assertIsInstance(run_agent_input.messages[5], UserMessage)

        # Verify specific message content
        self.assertEqual(run_agent_input.messages[0].content, "You are a helpful assistant.")
        self.assertEqual(run_agent_input.messages[1].content, "Can you help me analyze this data?")

        # Verify assistant message with tool call
        assistant_msg = run_agent_input.messages[3]
        self.assertEqual(len(assistant_msg.tool_calls), 1)
        self.assertEqual(assistant_msg.tool_calls[0].function.name, "analyze_data")

        # Verify tool message
        tool_msg = run_agent_input.messages[4]
        self.assertEqual(tool_msg.tool_call_id, "call_001")
        self.assertEqual(tool_msg.content, '{"mean": 42.5, "median": 38.0}')

        # Verify tools
        self.assertEqual(len(run_agent_input.tools), 2)
        self.assertEqual(run_agent_input.tools[0].name, "analyze_data")
        self.assertEqual(run_agent_input.tools[1].name, "fetch_data")

        # Verify context
        self.assertEqual(len(run_agent_input.context), 2)
        self.assertEqual(run_agent_input.context[0].description, "User preferences")
        self.assertEqual(run_agent_input.context[1].value, "production")

        # Verify forwarded props
        self.assertEqual(run_agent_input.forwarded_props["api_version"], "v1")
        self.assertEqual(run_agent_input.forwarded_props["custom_settings"]["max_tokens"], 500)

    def test_validation_errors(self):
        """Test validation errors for various message types"""
        message_adapter = TypeAdapter(Message)

        # Test invalid role value
        invalid_role_data = {
            "id": "msg_123",
            "role": "invalid_role",  # Invalid role
            "content": "Hello"
        }
        with self.assertRaises(ValidationError):
            message_adapter.validate_python(invalid_role_data)

        # Test missing required fields
        missing_id_data = {
            # Missing "id" field
            "role": "user",
            "content": "Hello"
        }
        with self.assertRaises(ValidationError):
            UserMessage.model_validate(missing_id_data)

        # Test extra fields
        extra_field_data = {
            "id": "msg_456",
            "role": "user",
            "content": "Hello",
            "extra_field": "This shouldn't be here"  # Extra field
        }
        with self.assertRaises(ValidationError):
            UserMessage.model_validate(extra_field_data)

        # Test invalid tool_call_id in ToolMessage
        invalid_tool_data = {
            "id": "tool_789",
            "role": "tool",
            "content": "Result",
            # Missing required tool_call_id
        }
        with self.assertRaises(ValidationError):
            ToolMessage.model_validate(invalid_tool_data)

    def test_empty_collections(self):
        """Test RunAgentInput with empty collections"""
        # Create RunAgentInput with empty lists
        empty_collections_data = {
            "threadId": "thread_empty",
            "runId": "run_empty",
            "state": {},
            "messages": [],  # Empty messages
            "tools": [],     # Empty tools
            "context": [],   # Empty context
            "forwardedProps": {}
        }

        # Deserialize and verify
        run_input = RunAgentInput.model_validate(empty_collections_data)
        self.assertEqual(run_input.thread_id, "thread_empty")
        self.assertEqual(run_input.run_id, "run_empty")
        self.assertEqual(len(run_input.messages), 0)
        self.assertEqual(len(run_input.tools), 0)
        self.assertEqual(len(run_input.context), 0)
        self.assertEqual(run_input.forwarded_props, {})

    def test_multiple_tool_calls(self):
        """Test assistant message with multiple tool calls"""
        # Create assistant message with multiple tool calls
        assistant_data = {
            "id": "asst_multi",
            "role": "assistant",
            "content": "I'll perform multiple operations",
            "toolCalls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "get_weather",
                        "arguments": '{"location": "New York"}'
                    }
                },
                {
                    "id": "call_2",
                    "type": "function",
                    "function": {
                        "name": "search_database",
                        "arguments": '{"query": "recent sales"}'
                    }
                },
                {
                    "id": "call_3",
                    "type": "function",
                    "function": {
                        "name": "calculate",
                        "arguments": '{"operation": "sum", "values": [1, 2, 3, 4, 5]}'
                    }
                }
            ]
        }

        # Deserialize and verify
        assistant_msg = AssistantMessage.model_validate(assistant_data)
        self.assertEqual(assistant_msg.id, "asst_multi")
        self.assertEqual(len(assistant_msg.tool_calls), 3)

        # Check each tool call
        self.assertEqual(assistant_msg.tool_calls[0].id, "call_1")
        self.assertEqual(assistant_msg.tool_calls[0].function.name, "get_weather")

        self.assertEqual(assistant_msg.tool_calls[1].id, "call_2")
        self.assertEqual(assistant_msg.tool_calls[1].function.name, "search_database")

        self.assertEqual(assistant_msg.tool_calls[2].id, "call_3")
        self.assertEqual(assistant_msg.tool_calls[2].function.name, "calculate")

    def test_serialization_round_trip(self):
        """Test serializing to JSON and deserializing back to verify data integrity"""
        # Create original instance
        original_data = {
            "threadId": "thread_round_trip",
            "runId": "run_round_trip",
            "state": {"status": "active"},
            "messages": [
                {
                    "id": "sys_rt",
                    "role": "system",
                    "content": "You are a helpful assistant."
                },
                {
                    "id": "user_rt",
                    "role": "user",
                    "content": "Help me with my task."
                },
                {
                    "id": "asst_rt",
                    "role": "assistant",
                    "content": "I'll help you.",
                    "toolCalls": [
                        {
                            "id": "call_rt",
                            "type": "function",
                            "function": {
                                "name": "get_task_info",
                                "arguments": "{}"
                            }
                        }
                    ]
                }
            ],
            "tools": [
                {
                    "name": "get_task_info",
                    "description": "Get task information",
                    "parameters": {
                        "type": "object",
                        "properties": {}
                    }
                }
            ],
            "context": [
                {
                    "description": "Session",
                    "value": "123456"
                }
            ],
            "forwardedProps": {
                "timestamp": 1648214400
            }
        }

        # Deserialize
        original_obj = RunAgentInput.model_validate(original_data)

        # Serialize back to JSON
        serialized_json = original_obj.model_dump_json(by_alias=True)

        # Deserialize again
        deserialized_obj = RunAgentInput.model_validate_json(serialized_json)

        # Verify round trip preserved data
        self.assertEqual(deserialized_obj.thread_id, original_obj.thread_id)
        self.assertEqual(deserialized_obj.run_id, original_obj.run_id)
        self.assertEqual(len(deserialized_obj.messages), len(original_obj.messages))

        # Verify message types are preserved
        self.assertIsInstance(deserialized_obj.messages[0], SystemMessage)
        self.assertIsInstance(deserialized_obj.messages[1], UserMessage)
        self.assertIsInstance(deserialized_obj.messages[2], AssistantMessage)

        # Verify tool calls are preserved
        self.assertEqual(len(deserialized_obj.messages[2].tool_calls), 1)
        self.assertEqual(
            deserialized_obj.messages[2].tool_calls[0].function.name,
            original_obj.messages[2].tool_calls[0].function.name
        )

    def test_content_edge_cases(self):
        """Test edge cases for message content"""

        # Test empty content
        empty_content_data = {
            "id": "msg_empty",
            "role": "user",
            "content": ""  # Empty string
        }
        empty_msg = UserMessage.model_validate(empty_content_data)
        self.assertEqual(empty_msg.content, "")

        # Test null content (for assistant messages)
        null_content_data = {
            "id": "asst_null",
            "role": "assistant",
            "content": None,  # Null content
            "toolCalls": [
                {
                    "id": "call_null",
                    "type": "function",
                    "function": {
                        "name": "get_data",
                        "arguments": "{}"
                    }
                }
            ]
        }
        null_msg = AssistantMessage.model_validate(null_content_data)
        self.assertIsNone(null_msg.content)

        # Test large content (not testing for performance, just functionality)
        large_content = "A" * 10000  # 10K characters
        large_content_data = {
            "id": "msg_large",
            "role": "user",
            "content": large_content
        }
        large_msg = UserMessage.model_validate(large_content_data)
        self.assertEqual(len(large_msg.content), 10000)

        # Test content with special characters
        special_chars = "Special chars: 你好 こんにちは 안녕하세요 👋 🌍 \n\t\"'\\/<>{}[]"
        special_chars_data = {
            "id": "msg_special",
            "role": "user",
            "content": special_chars
        }
        special_msg = UserMessage.model_validate(special_chars_data)
        self.assertEqual(special_msg.content, special_chars)

    def test_name_field_handling(self):
        """Test optional name field in different message types"""
        # Test user message with name
        user_with_name_data = {
            "id": "user_named",
            "role": "user",
            "content": "Hello",
            "name": "John"
        }
        user_msg = UserMessage.model_validate(user_with_name_data)
        self.assertEqual(user_msg.name, "John")

        # Test assistant message with name
        assistant_with_name_data = {
            "id": "asst_named",
            "role": "assistant",
            "content": "Hello",
            "name": "AI Assistant"
        }
        assistant_msg = AssistantMessage.model_validate(assistant_with_name_data)
        self.assertEqual(assistant_msg.name, "AI Assistant")

        # Verify serialization preserves name
        serialized = assistant_msg.model_dump(by_alias=True)
        self.assertEqual(serialized["name"], "AI Assistant")

        # Verify Union type handling with name
        message_adapter = TypeAdapter(Message)
        parsed_msg = message_adapter.validate_python(assistant_with_name_data)
        self.assertEqual(parsed_msg.name, "AI Assistant")

    def test_state_variations(self):
        """Test state with different structures and complex nested objects"""
        # Simple scalar state
        scalar_state_data = {
            "threadId": "thread_scalar",
            "runId": "run_scalar",
            "state": "ACTIVE",  # Scalar state
            "messages": [],
            "tools": [],
            "context": [],
            "forwardedProps": {}
        }
        scalar_input = RunAgentInput.model_validate(scalar_state_data)
        self.assertEqual(scalar_input.state, "ACTIVE")

        # Complex nested state
        complex_state = {
            "session": {
                "id": "sess_123",
                "user": {
                    "id": "user_456",
                    "preferences": {
                        "theme": "dark",
                        "notifications": True,
                        "filters": ["important", "urgent"]
                    }
                },
                "metrics": {
                    "requests": 42,
                    "tokens": {
                        "input": 1024,
                        "output": 2048
                    }
                }
            },
            "timestamp": 1648214400,
            "version": "1.0.0"
        }

        complex_state_data = {
            "threadId": "thread_complex",
            "runId": "run_complex",
            "state": complex_state,
            "messages": [],
            "tools": [],
            "context": [],
            "forwardedProps": {}
        }
        complex_input = RunAgentInput.model_validate(complex_state_data)

        # Verify nested state structure is preserved
        self.assertEqual(complex_input.state["session"]["id"], "sess_123")
        self.assertEqual(complex_input.state["session"]["user"]["id"], "user_456")
        self.assertEqual(complex_input.state["session"]["user"]["preferences"]["theme"], "dark")
        self.assertEqual(complex_input.state["session"]["metrics"]["tokens"]["output"], 2048)
        self.assertEqual(complex_input.state["version"], "1.0.0")

        # Verify serialization round-trip works with complex state
        serialized = complex_input.model_dump(by_alias=True)
        deserialized = RunAgentInput.model_validate(serialized)
        self.assertEqual(
            deserialized.state["session"]["user"]["preferences"]["filters"],
            ["important", "urgent"]
        )


if __name__ == "__main__":
    unittest.main()
