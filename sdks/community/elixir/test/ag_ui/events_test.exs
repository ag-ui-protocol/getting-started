defmodule AgUI.EventsTest do
  use ExUnit.Case, async: true

  alias AgUI.Events

  alias AgUI.Events.{
    RunStarted,
    RunFinished,
    RunError,
    StepStarted,
    StepFinished,
    TextMessageStart,
    TextMessageContent,
    TextMessageEnd,
    TextMessageChunk,
    ToolCallStart,
    ToolCallArgs,
    ToolCallEnd,
    ToolCallResult,
    ToolCallChunk,
    StateSnapshot,
    StateDelta,
    MessagesSnapshot,
    ActivitySnapshot,
    ActivityDelta,
    ThinkingStart,
    ThinkingEnd,
    ThinkingTextMessageStart,
    ThinkingTextMessageContent,
    ThinkingTextMessageEnd,
    Raw,
    Custom
  }

  describe "Events.decode/1" do
    test "returns error for missing type" do
      assert {:error, :missing_type} = Events.decode(%{})
    end

    test "returns error for unknown type" do
      assert {:error, {:unknown_event_type, "UNKNOWN"}} = Events.decode(%{"type" => "UNKNOWN"})
    end

    test "returns error for invalid input" do
      assert {:error, :invalid_input} = Events.decode("not a map")
    end
  end

  describe "Events.decode!/1" do
    test "raises on invalid input" do
      assert_raise ArgumentError, fn ->
        Events.decode!(%{"type" => "UNKNOWN"})
      end
    end
  end

  describe "Events.event_types/0" do
    test "returns all 26 event types" do
      types = Events.event_types()
      assert length(types) == 26
      assert "RUN_STARTED" in types
      assert "THINKING_TEXT_MESSAGE_CONTENT" in types
    end
  end

  describe "Events.valid_type?/1" do
    test "returns true for valid types" do
      assert Events.valid_type?("RUN_STARTED")
      assert Events.valid_type?("CUSTOM")
    end

    test "returns false for invalid types" do
      refute Events.valid_type?("INVALID")
    end
  end

  # Lifecycle Events

  describe "RunStarted" do
    test "from_map/1 parses valid event" do
      map = %{
        "type" => "RUN_STARTED",
        "threadId" => "t1",
        "runId" => "r1",
        "parentRunId" => "r0",
        "timestamp" => 1_234_567_890
      }

      assert {:ok, event} = Events.decode(map)
      assert %RunStarted{} = event
      assert event.type == :run_started
      assert event.thread_id == "t1"
      assert event.run_id == "r1"
      assert event.parent_run_id == "r0"
      assert event.timestamp == 1_234_567_890
    end

    test "from_map/1 returns error for missing required fields" do
      assert {:error, :missing_required_fields} = RunStarted.from_map(%{"type" => "RUN_STARTED"})

      assert {:error, :missing_required_fields} =
               RunStarted.from_map(%{"type" => "RUN_STARTED", "threadId" => "t1"})
    end

    test "round-trip encoding" do
      original = %{
        "type" => "RUN_STARTED",
        "threadId" => "t1",
        "runId" => "r1"
      }

      {:ok, event} = Events.decode(original)
      assert Events.encode(event) == original
    end
  end

  describe "RunFinished" do
    test "from_map/1 parses valid event" do
      map = %{
        "type" => "RUN_FINISHED",
        "threadId" => "t1",
        "runId" => "r1",
        "result" => %{"success" => true}
      }

      assert {:ok, event} = Events.decode(map)
      assert %RunFinished{} = event
      assert event.result == %{"success" => true}
    end

    test "round-trip encoding" do
      original = %{"type" => "RUN_FINISHED", "threadId" => "t1", "runId" => "r1"}
      {:ok, event} = Events.decode(original)
      assert Events.encode(event) == original
    end
  end

  describe "RunError" do
    test "from_map/1 parses valid event" do
      map = %{
        "type" => "RUN_ERROR",
        "message" => "Something went wrong",
        "code" => "E001"
      }

      assert {:ok, event} = Events.decode(map)
      assert %RunError{} = event
      assert event.message == "Something went wrong"
      assert event.code == "E001"
    end

    test "from_map/1 returns error for missing message" do
      assert {:error, :missing_message} = RunError.from_map(%{"type" => "RUN_ERROR"})
    end

    test "round-trip encoding" do
      original = %{"type" => "RUN_ERROR", "message" => "Error", "code" => "E001"}
      {:ok, event} = Events.decode(original)
      assert Events.encode(event) == original
    end
  end

  describe "StepStarted" do
    test "from_map/1 parses valid event" do
      map = %{"type" => "STEP_STARTED", "stepName" => "analyze"}
      assert {:ok, event} = Events.decode(map)
      assert %StepStarted{} = event
      assert event.step_name == "analyze"
    end

    test "from_map/1 returns error for missing step name" do
      assert {:error, :missing_step_name} = StepStarted.from_map(%{"type" => "STEP_STARTED"})
    end

    test "round-trip encoding" do
      original = %{"type" => "STEP_STARTED", "stepName" => "plan"}
      {:ok, event} = Events.decode(original)
      assert Events.encode(event) == original
    end
  end

  describe "StepFinished" do
    test "from_map/1 parses valid event" do
      map = %{"type" => "STEP_FINISHED", "stepName" => "analyze"}
      assert {:ok, event} = Events.decode(map)
      assert %StepFinished{} = event
      assert event.step_name == "analyze"
    end

    test "round-trip encoding" do
      original = %{"type" => "STEP_FINISHED", "stepName" => "plan"}
      {:ok, event} = Events.decode(original)
      assert Events.encode(event) == original
    end
  end

  # Text Message Events

  describe "TextMessageStart" do
    test "from_map/1 parses valid event" do
      map = %{
        "type" => "TEXT_MESSAGE_START",
        "messageId" => "msg-1",
        "role" => "assistant"
      }

      assert {:ok, event} = Events.decode(map)
      assert %TextMessageStart{} = event
      assert event.message_id == "msg-1"
      assert event.role == "assistant"
    end

    test "from_map/1 defaults role to assistant" do
      map = %{"type" => "TEXT_MESSAGE_START", "messageId" => "msg-1"}
      assert {:ok, event} = Events.decode(map)
      assert event.role == "assistant"
    end

    test "from_map/1 rejects tool role" do
      map = %{"type" => "TEXT_MESSAGE_START", "messageId" => "msg-1", "role" => "tool"}
      assert {:error, {:invalid_role, "tool"}} = Events.decode(map)
    end

    test "round-trip encoding" do
      original = %{
        "type" => "TEXT_MESSAGE_START",
        "messageId" => "msg-1",
        "role" => "user"
      }

      {:ok, event} = Events.decode(original)
      assert Events.encode(event) == original
    end
  end

  describe "TextMessageContent" do
    test "from_map/1 parses valid event" do
      map = %{
        "type" => "TEXT_MESSAGE_CONTENT",
        "messageId" => "msg-1",
        "delta" => "Hello, "
      }

      assert {:ok, event} = Events.decode(map)
      assert %TextMessageContent{} = event
      assert event.delta == "Hello, "
    end

    test "from_map/1 returns error for empty delta" do
      assert {:error, :empty_delta} =
               TextMessageContent.from_map(%{
                 "type" => "TEXT_MESSAGE_CONTENT",
                 "messageId" => "msg-1",
                 "delta" => ""
               })
    end

    test "from_map/1 returns error for invalid delta type" do
      assert {:error, :missing_required_fields} =
               TextMessageContent.from_map(%{
                 "type" => "TEXT_MESSAGE_CONTENT",
                 "messageId" => "msg-1",
                 "delta" => 123
               })
    end

    test "from_map/1 returns error for missing fields" do
      assert {:error, :missing_required_fields} =
               TextMessageContent.from_map(%{"type" => "TEXT_MESSAGE_CONTENT"})
    end

    test "round-trip encoding" do
      original = %{
        "type" => "TEXT_MESSAGE_CONTENT",
        "messageId" => "msg-1",
        "delta" => "world"
      }

      {:ok, event} = Events.decode(original)
      assert Events.encode(event) == original
    end

    test "round-trip encoding preserves unicode" do
      delta = "こんにちは 🌍"

      event = %TextMessageContent{message_id: "m1", delta: delta}
      encoded = Events.encode(event)
      json = Jason.encode!(encoded)

      {:ok, decoded} = Jason.decode(json)
      {:ok, parsed} = Events.decode(decoded)

      assert %TextMessageContent{delta: ^delta} = parsed
    end
  end

  describe "TextMessageEnd" do
    test "from_map/1 parses valid event" do
      map = %{"type" => "TEXT_MESSAGE_END", "messageId" => "msg-1"}
      assert {:ok, event} = Events.decode(map)
      assert %TextMessageEnd{} = event
      assert event.message_id == "msg-1"
    end

    test "round-trip encoding" do
      original = %{"type" => "TEXT_MESSAGE_END", "messageId" => "msg-1"}
      {:ok, event} = Events.decode(original)
      assert Events.encode(event) == original
    end
  end

  describe "TextMessageChunk" do
    test "from_map/1 parses valid event with all optional fields" do
      map = %{
        "type" => "TEXT_MESSAGE_CHUNK",
        "messageId" => "msg-1",
        "role" => "assistant",
        "delta" => "Hello"
      }

      assert {:ok, event} = Events.decode(map)
      assert %TextMessageChunk{} = event
      assert event.message_id == "msg-1"
      assert event.role == "assistant"
      assert event.delta == "Hello"
    end

    test "from_map/1 rejects tool role" do
      map = %{
        "type" => "TEXT_MESSAGE_CHUNK",
        "messageId" => "msg-1",
        "role" => "tool",
        "delta" => "Hello"
      }

      assert {:error, {:invalid_role, "tool"}} = Events.decode(map)
    end

    test "from_map/1 parses event with no optional fields" do
      map = %{"type" => "TEXT_MESSAGE_CHUNK"}
      assert {:ok, event} = Events.decode(map)
      assert event.message_id == nil
      assert event.role == nil
      assert event.delta == nil
    end

    test "round-trip encoding" do
      original = %{
        "type" => "TEXT_MESSAGE_CHUNK",
        "messageId" => "msg-1",
        "delta" => "Hi"
      }

      {:ok, event} = Events.decode(original)
      assert Events.encode(event) == original
    end
  end

  # Tool Call Events

  describe "ToolCallStart" do
    test "from_map/1 parses valid event" do
      map = %{
        "type" => "TOOL_CALL_START",
        "toolCallId" => "call-1",
        "toolCallName" => "get_weather",
        "parentMessageId" => "msg-1"
      }

      assert {:ok, event} = Events.decode(map)
      assert %ToolCallStart{} = event
      assert event.tool_call_id == "call-1"
      assert event.tool_call_name == "get_weather"
      assert event.parent_message_id == "msg-1"
    end

    test "from_map/1 returns error for missing fields" do
      assert {:error, :missing_required_fields} =
               ToolCallStart.from_map(%{"type" => "TOOL_CALL_START"})
    end

    test "round-trip encoding" do
      original = %{
        "type" => "TOOL_CALL_START",
        "toolCallId" => "call-1",
        "toolCallName" => "search"
      }

      {:ok, event} = Events.decode(original)
      assert Events.encode(event) == original
    end
  end

  describe "ToolCallArgs" do
    test "from_map/1 parses valid event" do
      map = %{
        "type" => "TOOL_CALL_ARGS",
        "toolCallId" => "call-1",
        "delta" => ~s({"location":)
      }

      assert {:ok, event} = Events.decode(map)
      assert %ToolCallArgs{} = event
      assert event.delta == ~s({"location":)
    end

    test "round-trip encoding" do
      original = %{
        "type" => "TOOL_CALL_ARGS",
        "toolCallId" => "call-1",
        "delta" => ~s("SF"})
      }

      {:ok, event} = Events.decode(original)
      assert Events.encode(event) == original
    end
  end

  describe "ToolCallEnd" do
    test "from_map/1 parses valid event" do
      map = %{"type" => "TOOL_CALL_END", "toolCallId" => "call-1"}
      assert {:ok, event} = Events.decode(map)
      assert %ToolCallEnd{} = event
    end

    test "round-trip encoding" do
      original = %{"type" => "TOOL_CALL_END", "toolCallId" => "call-1"}
      {:ok, event} = Events.decode(original)
      assert Events.encode(event) == original
    end
  end

  describe "ToolCallResult" do
    test "from_map/1 parses valid event" do
      map = %{
        "type" => "TOOL_CALL_RESULT",
        "messageId" => "msg-2",
        "toolCallId" => "call-1",
        "content" => ~s({"temp": 72})
      }

      assert {:ok, event} = Events.decode(map)
      assert %ToolCallResult{} = event
      assert event.message_id == "msg-2"
      assert event.role == "tool"
    end

    test "round-trip encoding" do
      original = %{
        "type" => "TOOL_CALL_RESULT",
        "messageId" => "msg-2",
        "toolCallId" => "call-1",
        "content" => "result",
        "role" => "tool"
      }

      {:ok, event} = Events.decode(original)
      assert Events.encode(event) == original
    end
  end

  describe "ToolCallChunk" do
    test "from_map/1 parses valid event with all optional fields" do
      map = %{
        "type" => "TOOL_CALL_CHUNK",
        "toolCallId" => "call-1",
        "toolCallName" => "search",
        "parentMessageId" => "msg-1",
        "delta" => ~s({"q":)
      }

      assert {:ok, event} = Events.decode(map)
      assert %ToolCallChunk{} = event
    end

    test "from_map/1 parses event with no optional fields" do
      map = %{"type" => "TOOL_CALL_CHUNK"}
      assert {:ok, event} = Events.decode(map)
      assert event.tool_call_id == nil
    end

    test "round-trip encoding" do
      original = %{
        "type" => "TOOL_CALL_CHUNK",
        "toolCallId" => "call-1",
        "delta" => "arg"
      }

      {:ok, event} = Events.decode(original)
      assert Events.encode(event) == original
    end
  end

  # State Events

  describe "StateSnapshot" do
    test "from_map/1 parses valid event" do
      map = %{
        "type" => "STATE_SNAPSHOT",
        "snapshot" => %{"counter" => 5, "items" => []}
      }

      assert {:ok, event} = Events.decode(map)
      assert %StateSnapshot{} = event
      assert event.snapshot == %{"counter" => 5, "items" => []}
    end

    test "from_map/1 accepts non-map snapshots" do
      map = %{"type" => "STATE_SNAPSHOT", "snapshot" => ["a", "b"]}
      assert {:ok, event} = Events.decode(map)
      assert event.snapshot == ["a", "b"]
    end

    test "from_map/1 returns error for missing snapshot" do
      assert {:error, :missing_snapshot} = StateSnapshot.from_map(%{"type" => "STATE_SNAPSHOT"})
    end

    test "round-trip encoding" do
      original = %{"type" => "STATE_SNAPSHOT", "snapshot" => %{"a" => 1}}
      {:ok, event} = Events.decode(original)
      assert Events.encode(event) == original
    end
  end

  describe "StateDelta" do
    test "from_map/1 parses valid event" do
      map = %{
        "type" => "STATE_DELTA",
        "delta" => [%{"op" => "replace", "path" => "/counter", "value" => 6}]
      }

      assert {:ok, event} = Events.decode(map)
      assert %StateDelta{} = event
      assert length(event.delta) == 1
    end

    test "from_map/1 returns error for missing delta" do
      assert {:error, :missing_delta} = StateDelta.from_map(%{"type" => "STATE_DELTA"})
    end

    test "round-trip encoding" do
      original = %{
        "type" => "STATE_DELTA",
        "delta" => [%{"op" => "add", "path" => "/x", "value" => 1}]
      }

      {:ok, event} = Events.decode(original)
      assert Events.encode(event) == original
    end
  end

  describe "MessagesSnapshot" do
    test "from_map/1 parses valid event" do
      map = %{
        "type" => "MESSAGES_SNAPSHOT",
        "messages" => [%{"id" => "1", "role" => "user", "content" => "Hi"}]
      }

      assert {:ok, event} = Events.decode(map)
      assert %MessagesSnapshot{} = event
      assert length(event.messages) == 1
      assert %AgUI.Types.Message.User{content: "Hi"} = hd(event.messages)
    end

    test "round-trip encoding" do
      original = %{"type" => "MESSAGES_SNAPSHOT", "messages" => []}
      {:ok, event} = Events.decode(original)
      assert Events.encode(event) == original
    end
  end

  describe "ActivitySnapshot" do
    test "from_map/1 parses valid event" do
      map = %{
        "type" => "ACTIVITY_SNAPSHOT",
        "messageId" => "msg-1",
        "activityType" => "search_results",
        "content" => %{"results" => [1, 2, 3]},
        "replace" => true
      }

      assert {:ok, event} = Events.decode(map)
      assert %ActivitySnapshot{} = event
      assert event.message_id == "msg-1"
      assert event.activity_type == "search_results"
      assert event.replace == true
    end

    test "from_map/1 defaults replace to true" do
      map = %{
        "type" => "ACTIVITY_SNAPSHOT",
        "messageId" => "msg-1",
        "activityType" => "progress",
        "content" => %{}
      }

      assert {:ok, event} = Events.decode(map)
      assert event.replace == true
    end

    test "round-trip encoding" do
      original = %{
        "type" => "ACTIVITY_SNAPSHOT",
        "messageId" => "msg-1",
        "activityType" => "plan",
        "content" => %{"steps" => []},
        "replace" => true
      }

      {:ok, event} = Events.decode(original)
      assert Events.encode(event) == original
    end
  end

  describe "ActivityDelta" do
    test "from_map/1 parses valid event" do
      map = %{
        "type" => "ACTIVITY_DELTA",
        "messageId" => "msg-1",
        "activityType" => "search_results",
        "patch" => [%{"op" => "add", "path" => "/results/-", "value" => 4}]
      }

      assert {:ok, event} = Events.decode(map)
      assert %ActivityDelta{} = event
      assert event.patch == [%{"op" => "add", "path" => "/results/-", "value" => 4}]
    end

    test "round-trip encoding" do
      original = %{
        "type" => "ACTIVITY_DELTA",
        "messageId" => "msg-1",
        "activityType" => "plan",
        "patch" => [%{"op" => "replace", "path" => "/status", "value" => "done"}]
      }

      {:ok, event} = Events.decode(original)
      assert Events.encode(event) == original
    end
  end

  # Thinking Events

  describe "ThinkingStart" do
    test "from_map/1 parses valid event" do
      map = %{"type" => "THINKING_START", "title" => "Analyzing..."}
      assert {:ok, event} = Events.decode(map)
      assert %ThinkingStart{} = event
      assert event.title == "Analyzing..."
    end

    test "from_map/1 parses event without title" do
      map = %{"type" => "THINKING_START"}
      assert {:ok, event} = Events.decode(map)
      assert event.title == nil
    end

    test "round-trip encoding" do
      original = %{"type" => "THINKING_START", "title" => "Planning"}
      {:ok, event} = Events.decode(original)
      assert Events.encode(event) == original
    end
  end

  describe "ThinkingEnd" do
    test "from_map/1 parses valid event" do
      map = %{"type" => "THINKING_END"}
      assert {:ok, event} = Events.decode(map)
      assert %ThinkingEnd{} = event
    end

    test "round-trip encoding" do
      original = %{"type" => "THINKING_END"}
      {:ok, event} = Events.decode(original)
      assert Events.encode(event) == original
    end
  end

  describe "ThinkingTextMessageStart" do
    test "from_map/1 parses valid event" do
      map = %{"type" => "THINKING_TEXT_MESSAGE_START"}
      assert {:ok, event} = Events.decode(map)
      assert %ThinkingTextMessageStart{} = event
    end

    test "round-trip encoding" do
      original = %{"type" => "THINKING_TEXT_MESSAGE_START"}
      {:ok, event} = Events.decode(original)
      assert Events.encode(event) == original
    end
  end

  describe "ThinkingTextMessageContent" do
    test "from_map/1 parses valid event" do
      map = %{"type" => "THINKING_TEXT_MESSAGE_CONTENT", "delta" => "Let me think..."}
      assert {:ok, event} = Events.decode(map)
      assert %ThinkingTextMessageContent{} = event
      assert event.delta == "Let me think..."
    end

    test "from_map/1 returns error for empty delta" do
      assert {:error, :empty_delta} =
               ThinkingTextMessageContent.from_map(%{
                 "type" => "THINKING_TEXT_MESSAGE_CONTENT",
                 "delta" => ""
               })
    end

    test "from_map/1 returns error for missing delta" do
      assert {:error, :missing_delta} =
               ThinkingTextMessageContent.from_map(%{"type" => "THINKING_TEXT_MESSAGE_CONTENT"})
    end

    test "round-trip encoding" do
      original = %{"type" => "THINKING_TEXT_MESSAGE_CONTENT", "delta" => "reasoning"}
      {:ok, event} = Events.decode(original)
      assert Events.encode(event) == original
    end
  end

  describe "ThinkingTextMessageEnd" do
    test "from_map/1 parses valid event" do
      map = %{"type" => "THINKING_TEXT_MESSAGE_END"}
      assert {:ok, event} = Events.decode(map)
      assert %ThinkingTextMessageEnd{} = event
    end

    test "round-trip encoding" do
      original = %{"type" => "THINKING_TEXT_MESSAGE_END"}
      {:ok, event} = Events.decode(original)
      assert Events.encode(event) == original
    end
  end

  # Special Events

  describe "Raw" do
    test "from_map/1 parses valid event" do
      map = %{
        "type" => "RAW",
        "event" => %{"provider" => "data"},
        "source" => "openai"
      }

      assert {:ok, event} = Events.decode(map)
      assert %Raw{} = event
      assert event.event == %{"provider" => "data"}
      assert event.source == "openai"
    end

    test "from_map/1 returns error for missing event" do
      assert {:error, :missing_event} = Raw.from_map(%{"type" => "RAW"})
    end

    test "round-trip encoding" do
      original = %{"type" => "RAW", "event" => %{"x" => 1}, "source" => "test"}
      {:ok, event} = Events.decode(original)
      assert Events.encode(event) == original
    end
  end

  describe "Custom" do
    test "from_map/1 parses valid event" do
      map = %{
        "type" => "CUSTOM",
        "name" => "my_event",
        "value" => %{"any" => "data"}
      }

      assert {:ok, event} = Events.decode(map)
      assert %Custom{} = event
      assert event.name == "my_event"
      assert event.value == %{"any" => "data"}
    end

    test "from_map/1 returns error for missing fields" do
      assert {:error, :missing_required_fields} = Custom.from_map(%{"type" => "CUSTOM"})
    end

    test "round-trip encoding" do
      original = %{"type" => "CUSTOM", "name" => "test", "value" => 123}
      {:ok, event} = Events.decode(original)
      assert Events.encode(event) == original
    end
  end

  # Type conversion

  describe "type_to_wire/1" do
    test "converts all event types" do
      assert Events.type_to_wire(:run_started) == "RUN_STARTED"
      assert Events.type_to_wire(:text_message_content) == "TEXT_MESSAGE_CONTENT"

      assert Events.type_to_wire(:thinking_text_message_content) ==
               "THINKING_TEXT_MESSAGE_CONTENT"
    end
  end

  describe "type_from_wire/1" do
    test "converts all wire types" do
      assert {:ok, :run_started} = Events.type_from_wire("RUN_STARTED")
      assert {:ok, :text_message_content} = Events.type_from_wire("TEXT_MESSAGE_CONTENT")
      assert {:ok, :custom} = Events.type_from_wire("CUSTOM")
    end

    test "returns error for unknown types" do
      assert {:error, {:unknown_event_type, "UNKNOWN"}} = Events.type_from_wire("UNKNOWN")
    end
  end

  # Event with timestamp

  describe "events with timestamp" do
    test "preserves timestamp in round-trip" do
      original = %{
        "type" => "RUN_STARTED",
        "threadId" => "t1",
        "runId" => "r1",
        "timestamp" => 1_234_567_890
      }

      {:ok, event} = Events.decode(original)
      assert event.timestamp == 1_234_567_890
      assert Events.encode(event) == original
    end
  end

  # Raw event preservation

  describe "raw_event preservation" do
    test "stores original map in raw_event" do
      original = %{
        "type" => "RUN_STARTED",
        "threadId" => "t1",
        "runId" => "r1",
        "extra_field" => "ignored_but_preserved"
      }

      {:ok, event} = Events.decode(original)
      assert event.raw_event == original
      assert event.raw_event["extra_field"] == "ignored_but_preserved"
    end
  end
end
