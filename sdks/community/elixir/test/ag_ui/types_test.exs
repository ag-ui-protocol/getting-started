defmodule AgUI.TypesTest do
  use ExUnit.Case, async: true

  alias AgUI.Types
  alias AgUI.Types.{Context, Tool, ToolCall, InputContent, Message, RunAgentInput}

  describe "Types helper functions" do
    test "to_snake_atom/1 converts camelCase to snake_case atom" do
      assert Types.to_snake_atom("threadId") == :thread_id
      assert Types.to_snake_atom("parentMessageId") == :parent_message_id
      assert Types.to_snake_atom("id") == :id
    end

    test "to_camel_string/1 converts snake_case atom to camelCase" do
      assert Types.to_camel_string(:thread_id) == "threadId"
      assert Types.to_camel_string(:parent_message_id) == "parentMessageId"
      assert Types.to_camel_string(:id) == "id"
    end

    test "camelize/1 converts snake_case string to camelCase" do
      assert Types.camelize("thread_id") == "threadId"
      assert Types.camelize("parent_message_id") == "parentMessageId"
    end

    test "compact_map/1 removes nil values" do
      assert Types.compact_map(%{"a" => 1, "b" => nil, "c" => 3}) == %{"a" => 1, "c" => 3}
    end

    test "compact_map_deep/1 removes nil values and empty lists" do
      assert Types.compact_map_deep(%{"a" => 1, "b" => nil, "c" => []}) == %{"a" => 1}
    end
  end

  describe "Context" do
    test "from_map/1 parses valid context" do
      map = %{"description" => "User location", "value" => "NYC"}
      assert {:ok, ctx} = Context.from_map(map)
      assert ctx.description == "User location"
      assert ctx.value == "NYC"
    end

    test "from_map/1 returns error for missing fields" do
      assert {:error, :missing_required_fields} = Context.from_map(%{})
      assert {:error, :missing_required_fields} = Context.from_map(%{"description" => "test"})
    end

    test "to_map/1 converts back to wire format" do
      ctx = %Context{description: "Test", value: "Value"}
      assert Context.to_map(ctx) == %{"description" => "Test", "value" => "Value"}
    end

    test "round-trip encoding" do
      original = %{"description" => "Location", "value" => "SF"}
      {:ok, ctx} = Context.from_map(original)
      assert Context.to_map(ctx) == original
    end
  end

  describe "Tool" do
    test "from_map/1 parses valid tool" do
      map = %{
        "name" => "get_weather",
        "description" => "Get weather for a location",
        "parameters" => %{"type" => "object"}
      }

      assert {:ok, tool} = Tool.from_map(map)
      assert tool.name == "get_weather"
      assert tool.description == "Get weather for a location"
      assert tool.parameters == %{"type" => "object"}
    end

    test "from_map/1 defaults parameters to empty map" do
      map = %{"name" => "test", "description" => "A test tool"}
      assert {:ok, tool} = Tool.from_map(map)
      assert tool.parameters == %{}
    end

    test "from_map/1 returns error for missing fields" do
      assert {:error, :missing_required_fields} = Tool.from_map(%{})
      assert {:error, :missing_required_fields} = Tool.from_map(%{"name" => "test"})
    end

    test "round-trip encoding" do
      original = %{
        "name" => "search",
        "description" => "Search the web",
        "parameters" => %{"type" => "object", "properties" => %{}}
      }

      {:ok, tool} = Tool.from_map(original)
      assert Tool.to_map(tool) == original
    end
  end

  describe "ToolCall" do
    test "from_map/1 parses valid tool call" do
      map = %{
        "id" => "call_123",
        "type" => "function",
        "function" => %{
          "name" => "get_weather",
          "arguments" => ~s({"location": "SF"})
        }
      }

      assert {:ok, tc} = ToolCall.from_map(map)
      assert tc.id == "call_123"
      assert tc.type == :function
      assert tc.function.name == "get_weather"
      assert tc.function.arguments == ~s({"location": "SF"})
    end

    test "from_map/1 defaults type to function" do
      map = %{
        "id" => "call_123",
        "function" => %{"name" => "test", "arguments" => "{}"}
      }

      assert {:ok, tc} = ToolCall.from_map(map)
      assert tc.type == :function
    end

    test "parse_arguments/1 parses JSON arguments" do
      tc = %ToolCall{
        id: "1",
        type: :function,
        function: %{name: "test", arguments: ~s({"key": "value"})}
      }

      assert {:ok, %{"key" => "value"}} = ToolCall.parse_arguments(tc)
    end

    test "round-trip encoding" do
      original = %{
        "id" => "call_abc",
        "type" => "function",
        "function" => %{"name" => "search", "arguments" => "{}"}
      }

      {:ok, tc} = ToolCall.from_map(original)
      assert ToolCall.to_map(tc) == original
    end
  end

  describe "InputContent.Text" do
    test "from_map/1 parses text content" do
      map = %{"type" => "text", "text" => "Hello world"}
      assert {:ok, content} = InputContent.from_map(map)
      assert content.type == :text
      assert content.text == "Hello world"
    end

    test "from_map/1 handles legacy format without type" do
      map = %{"text" => "Hello"}
      assert {:ok, content} = InputContent.from_map(map)
      assert content.text == "Hello"
    end
  end

  describe "InputContent.Binary" do
    test "from_map/1 parses binary content with url" do
      map = %{
        "type" => "binary",
        "mimeType" => "image/png",
        "url" => "https://example.com/image.png"
      }

      assert {:ok, content} = InputContent.from_map(map)
      assert content.type == :binary
      assert content.mime_type == "image/png"
      assert content.url == "https://example.com/image.png"
    end

    test "from_map/1 parses binary content with data" do
      map = %{
        "type" => "binary",
        "mimeType" => "image/png",
        "data" => "base64data..."
      }

      assert {:ok, content} = InputContent.from_map(map)
      assert content.data == "base64data..."
    end

    test "from_map/1 parses binary content with id" do
      map = %{
        "type" => "binary",
        "mimeType" => "image/png",
        "id" => "file-123"
      }

      assert {:ok, content} = InputContent.from_map(map)
      assert content.id == "file-123"
    end

    test "from_map/1 includes filename" do
      map = %{
        "type" => "binary",
        "mimeType" => "image/png",
        "url" => "https://example.com/image.png",
        "filename" => "screenshot.png"
      }

      assert {:ok, content} = InputContent.from_map(map)
      assert content.filename == "screenshot.png"
    end

    test "from_map/1 returns error if no payload field" do
      map = %{"type" => "binary", "mimeType" => "image/png"}
      assert {:error, :missing_payload} = InputContent.from_map(map)
    end

    test "to_map/1 removes nil fields" do
      content = %InputContent.Binary{
        type: :binary,
        mime_type: "image/png",
        url: "https://example.com/image.png"
      }

      result = InputContent.to_map(content)

      assert result == %{
               "type" => "binary",
               "mimeType" => "image/png",
               "url" => "https://example.com/image.png"
             }

      refute Map.has_key?(result, "id")
      refute Map.has_key?(result, "data")
      refute Map.has_key?(result, "filename")
    end
  end

  describe "Message" do
    test "from_map/1 dispatches to correct type based on role" do
      assert {:ok, %Message.User{}} =
               Message.from_map(%{"id" => "1", "role" => "user", "content" => "Hi"})

      assert {:ok, %Message.Assistant{}} = Message.from_map(%{"id" => "2", "role" => "assistant"})

      assert {:ok, %Message.System{}} =
               Message.from_map(%{
                 "id" => "3",
                 "role" => "system",
                 "content" => "You are helpful"
               })

      assert {:ok, %Message.Developer{}} =
               Message.from_map(%{
                 "id" => "4",
                 "role" => "developer",
                 "content" => "Instructions"
               })

      assert {:ok, %Message.Tool{}} =
               Message.from_map(%{
                 "id" => "5",
                 "role" => "tool",
                 "content" => "result",
                 "toolCallId" => "call_1"
               })

      assert {:ok, %Message.Activity{}} =
               Message.from_map(%{
                 "id" => "6",
                 "role" => "activity",
                 "activityType" => "search",
                 "content" => %{}
               })
    end

    test "from_map/1 returns error for unknown role" do
      assert {:error, {:unknown_role, "unknown"}} =
               Message.from_map(%{"id" => "1", "role" => "unknown"})
    end

    test "role_from_wire/1 converts string to atom" do
      assert {:ok, :user} = Message.role_from_wire("user")
      assert {:ok, :assistant} = Message.role_from_wire("assistant")
      assert {:error, {:unknown_role, "bad"}} = Message.role_from_wire("bad")
    end

    test "role_to_wire/1 converts atom to string" do
      assert "user" = Message.role_to_wire(:user)
      assert "assistant" = Message.role_to_wire(:assistant)
    end
  end

  describe "Message.User" do
    test "from_map/1 parses string content" do
      map = %{"id" => "1", "role" => "user", "content" => "Hello"}
      assert {:ok, msg} = Message.from_map(map)
      assert msg.content == "Hello"
      assert msg.role == :user
    end

    test "from_map/1 parses multimodal content" do
      map = %{
        "id" => "1",
        "role" => "user",
        "content" => [
          %{"type" => "text", "text" => "Check this image"},
          %{"type" => "binary", "mimeType" => "image/png", "url" => "http://example.com/img.png"}
        ]
      }

      assert {:ok, msg} = Message.from_map(map)
      assert length(msg.content) == 2
      assert %InputContent.Text{text: "Check this image"} = hd(msg.content)
    end
  end

  describe "Message.Assistant" do
    test "from_map/1 parses message with tool calls" do
      map = %{
        "id" => "1",
        "role" => "assistant",
        "content" => "Let me check the weather",
        "toolCalls" => [
          %{
            "id" => "call_1",
            "type" => "function",
            "function" => %{"name" => "get_weather", "arguments" => "{}"}
          }
        ]
      }

      assert {:ok, msg} = Message.from_map(map)
      assert msg.content == "Let me check the weather"
      assert length(msg.tool_calls) == 1
      assert hd(msg.tool_calls).function.name == "get_weather"
    end

    test "from_map/1 handles nil content" do
      map = %{"id" => "1", "role" => "assistant"}
      assert {:ok, msg} = Message.from_map(map)
      assert msg.content == nil
      assert msg.tool_calls == []
    end
  end

  describe "Message.Activity" do
    test "from_map/1 parses activity message" do
      map = %{
        "id" => "1",
        "role" => "activity",
        "activityType" => "search_results",
        "content" => %{"results" => [1, 2, 3]}
      }

      assert {:ok, msg} = Message.from_map(map)
      assert msg.activity_type == "search_results"
      assert msg.content == %{"results" => [1, 2, 3]}
    end
  end

  describe "RunAgentInput" do
    test "from_map/1 parses minimal input" do
      map = %{"threadId" => "t1", "runId" => "r1"}
      assert {:ok, input} = RunAgentInput.from_map(map)
      assert input.thread_id == "t1"
      assert input.run_id == "r1"
      assert input.state == %{}
      assert input.messages == []
      assert input.tools == []
    end

    test "from_map/1 parses full input" do
      map = %{
        "threadId" => "t1",
        "runId" => "r1",
        "parentRunId" => "r0",
        "state" => %{"count" => 0},
        "messages" => [%{"id" => "1", "role" => "user", "content" => "Hi"}],
        "tools" => [%{"name" => "test", "description" => "A test"}],
        "context" => [%{"description" => "loc", "value" => "NYC"}],
        "forwardedProps" => %{"custom" => "data"}
      }

      assert {:ok, input} = RunAgentInput.from_map(map)
      assert input.parent_run_id == "r0"
      assert input.state == %{"count" => 0}
      assert length(input.messages) == 1
      assert length(input.tools) == 1
      assert length(input.context) == 1
      assert input.forwarded_props == %{"custom" => "data"}
    end

    test "from_map/1 returns error for missing required fields" do
      assert {:error, :missing_thread_id} = RunAgentInput.from_map(%{"runId" => "r1"})
      assert {:error, :missing_run_id} = RunAgentInput.from_map(%{"threadId" => "t1"})
    end

    test "from_map/1 returns error for invalid messages type" do
      assert {:error, :invalid_messages} =
               RunAgentInput.from_map(%{
                 "threadId" => "t1",
                 "runId" => "r1",
                 "messages" => "not-a-list"
               })
    end

    test "to_map/1 converts back to wire format" do
      input = RunAgentInput.new("t1", "r1", state: %{"x" => 1})
      result = RunAgentInput.to_map(input)

      assert result["threadId"] == "t1"
      assert result["runId"] == "r1"
      assert result["state"] == %{"x" => 1}
      refute Map.has_key?(result, "parentRunId")
    end

    test "new/3 creates input with options" do
      input = RunAgentInput.new("t1", "r1", parent_run_id: "r0", state: %{"a" => 1})
      assert input.thread_id == "t1"
      assert input.run_id == "r1"
      assert input.parent_run_id == "r0"
      assert input.state == %{"a" => 1}
    end

    test "add_message/2 appends a message" do
      input = RunAgentInput.new("t1", "r1")
      msg = %Message.User{id: "1", role: :user, content: "Hi"}
      input = RunAgentInput.add_message(input, msg)
      assert length(input.messages) == 1
    end

    test "add_tool/2 appends a tool" do
      input = RunAgentInput.new("t1", "r1")
      tool = %Tool{name: "test", description: "Test tool"}
      input = RunAgentInput.add_tool(input, tool)
      assert length(input.tools) == 1
    end

    test "put_state/2 replaces state" do
      input = RunAgentInput.new("t1", "r1", state: %{"a" => 1})
      input = RunAgentInput.put_state(input, %{"b" => 2})
      assert input.state == %{"b" => 2}
    end

    test "merge_state/2 merges into state" do
      input = RunAgentInput.new("t1", "r1", state: %{"a" => 1})
      input = RunAgentInput.merge_state(input, %{"b" => 2})
      assert input.state == %{"a" => 1, "b" => 2}
    end

    test "round-trip encoding" do
      original = %{
        "threadId" => "t1",
        "runId" => "r1",
        "state" => %{},
        "messages" => [],
        "tools" => [],
        "context" => [],
        "forwardedProps" => %{}
      }

      {:ok, input} = RunAgentInput.from_map(original)
      assert RunAgentInput.to_map(input) == original
    end
  end

  describe "Message.User unicode content" do
    test "to_map/from_map preserves unicode text" do
      msg = %Message.User{id: "u1", role: :user, content: "Zażółć 🦊"}
      map = Message.to_map(msg)
      {:ok, parsed} = Message.from_map(map)

      assert %Message.User{content: "Zażółć 🦊"} = parsed
    end
  end
end
