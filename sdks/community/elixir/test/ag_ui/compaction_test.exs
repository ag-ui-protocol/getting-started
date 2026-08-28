defmodule AgUI.CompactionTest do
  use ExUnit.Case, async: true

  alias AgUI.Compaction
  alias AgUI.Events

  describe "compact_events/1 - text messages" do
    test "merges multiple TEXT_MESSAGE_CONTENT events" do
      events = [
        %Events.TextMessageStart{type: :text_message_start, message_id: "m1", role: "assistant"},
        %Events.TextMessageContent{
          type: :text_message_content,
          message_id: "m1",
          delta: "Hello "
        },
        %Events.TextMessageContent{type: :text_message_content, message_id: "m1", delta: "world"},
        %Events.TextMessageContent{type: :text_message_content, message_id: "m1", delta: "!"},
        %Events.TextMessageEnd{type: :text_message_end, message_id: "m1"}
      ]

      compacted = Compaction.compact_events(events)

      assert length(compacted) == 3
      assert %Events.TextMessageStart{message_id: "m1"} = Enum.at(compacted, 0)

      assert %Events.TextMessageContent{message_id: "m1", delta: "Hello world!"} =
               Enum.at(compacted, 1)

      assert %Events.TextMessageEnd{message_id: "m1"} = Enum.at(compacted, 2)
    end

    test "preserves single TEXT_MESSAGE_CONTENT" do
      events = [
        %Events.TextMessageStart{type: :text_message_start, message_id: "m1", role: "assistant"},
        %Events.TextMessageContent{type: :text_message_content, message_id: "m1", delta: "Hello"},
        %Events.TextMessageEnd{type: :text_message_end, message_id: "m1"}
      ]

      compacted = Compaction.compact_events(events)

      assert length(compacted) == 3
      assert %Events.TextMessageContent{delta: "Hello"} = Enum.at(compacted, 1)
    end

    test "handles empty deltas in concatenation" do
      events = [
        %Events.TextMessageStart{type: :text_message_start, message_id: "m1", role: "assistant"},
        %Events.TextMessageContent{type: :text_message_content, message_id: "m1", delta: ""},
        %Events.TextMessageContent{type: :text_message_content, message_id: "m1", delta: "Hello"},
        %Events.TextMessageContent{type: :text_message_content, message_id: "m1", delta: ""},
        %Events.TextMessageEnd{type: :text_message_end, message_id: "m1"}
      ]

      compacted = Compaction.compact_events(events)

      assert length(compacted) == 3
      assert %Events.TextMessageContent{delta: "Hello"} = Enum.at(compacted, 1)
    end

    test "handles START without CONTENT" do
      events = [
        %Events.TextMessageStart{type: :text_message_start, message_id: "m1", role: "assistant"},
        %Events.TextMessageEnd{type: :text_message_end, message_id: "m1"}
      ]

      compacted = Compaction.compact_events(events)

      assert length(compacted) == 2
      assert %Events.TextMessageStart{} = Enum.at(compacted, 0)
      assert %Events.TextMessageEnd{} = Enum.at(compacted, 1)
    end

    test "reorders interleaved events to after END" do
      events = [
        %Events.TextMessageStart{type: :text_message_start, message_id: "m1", role: "assistant"},
        %Events.TextMessageContent{
          type: :text_message_content,
          message_id: "m1",
          delta: "Processing"
        },
        %Events.Custom{type: :custom, name: "log", value: "step 1"},
        %Events.TextMessageContent{type: :text_message_content, message_id: "m1", delta: "..."},
        %Events.Custom{type: :custom, name: "log", value: "step 2"},
        %Events.TextMessageEnd{type: :text_message_end, message_id: "m1"}
      ]

      compacted = Compaction.compact_events(events)

      # Order: START, CONTENT (merged), END, CUSTOM, CUSTOM
      assert length(compacted) == 5
      assert %Events.TextMessageStart{} = Enum.at(compacted, 0)
      assert %Events.TextMessageContent{delta: "Processing..."} = Enum.at(compacted, 1)
      assert %Events.TextMessageEnd{} = Enum.at(compacted, 2)
      assert %Events.Custom{value: "step 1"} = Enum.at(compacted, 3)
      assert %Events.Custom{value: "step 2"} = Enum.at(compacted, 4)
    end

    test "handles incomplete text message stream" do
      events = [
        %Events.TextMessageStart{type: :text_message_start, message_id: "m1", role: "assistant"},
        %Events.TextMessageContent{type: :text_message_content, message_id: "m1", delta: "Hello"},
        %Events.TextMessageContent{type: :text_message_content, message_id: "m1", delta: " world"}
        # No END
      ]

      compacted = Compaction.compact_events(events)

      # Should still compact, no END emitted
      assert length(compacted) == 2
      assert %Events.TextMessageStart{} = Enum.at(compacted, 0)
      assert %Events.TextMessageContent{delta: "Hello world"} = Enum.at(compacted, 1)
    end

    test "handles orphan CONTENT without START" do
      events = [
        %Events.TextMessageContent{type: :text_message_content, message_id: "m1", delta: "Hello"},
        %Events.TextMessageEnd{type: :text_message_end, message_id: "m1"}
      ]

      compacted = Compaction.compact_events(events)

      # Pass through unchanged
      assert length(compacted) == 2
    end

    test "handles orphan END without START" do
      events = [
        %Events.TextMessageEnd{type: :text_message_end, message_id: "m1"}
      ]

      compacted = Compaction.compact_events(events)

      assert compacted == events
    end
  end

  describe "compact_events/1 - tool calls" do
    test "merges multiple TOOL_CALL_ARGS events" do
      events = [
        %Events.ToolCallStart{
          type: :tool_call_start,
          tool_call_id: "call-1",
          tool_call_name: "search"
        },
        %Events.ToolCallArgs{
          type: :tool_call_args,
          tool_call_id: "call-1",
          delta: ~s({"query": ")
        },
        %Events.ToolCallArgs{type: :tool_call_args, tool_call_id: "call-1", delta: "weather"},
        %Events.ToolCallArgs{type: :tool_call_args, tool_call_id: "call-1", delta: ~s( today"})},
        %Events.ToolCallEnd{type: :tool_call_end, tool_call_id: "call-1"}
      ]

      compacted = Compaction.compact_events(events)

      assert length(compacted) == 3
      assert %Events.ToolCallStart{tool_call_id: "call-1"} = Enum.at(compacted, 0)
      assert %Events.ToolCallArgs{delta: ~s({"query": "weather today"})} = Enum.at(compacted, 1)
      assert %Events.ToolCallEnd{tool_call_id: "call-1"} = Enum.at(compacted, 2)
    end

    test "preserves single TOOL_CALL_ARGS" do
      events = [
        %Events.ToolCallStart{
          type: :tool_call_start,
          tool_call_id: "call-1",
          tool_call_name: "test"
        },
        %Events.ToolCallArgs{type: :tool_call_args, tool_call_id: "call-1", delta: "{}"},
        %Events.ToolCallEnd{type: :tool_call_end, tool_call_id: "call-1"}
      ]

      compacted = Compaction.compact_events(events)

      assert length(compacted) == 3
      assert %Events.ToolCallArgs{delta: "{}"} = Enum.at(compacted, 1)
    end

    test "handles START without ARGS" do
      events = [
        %Events.ToolCallStart{
          type: :tool_call_start,
          tool_call_id: "call-1",
          tool_call_name: "ping"
        },
        %Events.ToolCallEnd{type: :tool_call_end, tool_call_id: "call-1"}
      ]

      compacted = Compaction.compact_events(events)

      assert length(compacted) == 2
    end

    test "reorders interleaved events to after END" do
      events = [
        %Events.ToolCallStart{
          type: :tool_call_start,
          tool_call_id: "call-1",
          tool_call_name: "search"
        },
        %Events.ToolCallArgs{type: :tool_call_args, tool_call_id: "call-1", delta: "{"},
        %Events.StateSnapshot{type: :state_snapshot, snapshot: %{"loading" => true}},
        %Events.ToolCallArgs{type: :tool_call_args, tool_call_id: "call-1", delta: "}"},
        %Events.ToolCallEnd{type: :tool_call_end, tool_call_id: "call-1"}
      ]

      compacted = Compaction.compact_events(events)

      assert length(compacted) == 4
      assert %Events.ToolCallStart{} = Enum.at(compacted, 0)
      assert %Events.ToolCallArgs{delta: "{}"} = Enum.at(compacted, 1)
      assert %Events.ToolCallEnd{} = Enum.at(compacted, 2)
      assert %Events.StateSnapshot{} = Enum.at(compacted, 3)
    end

    test "handles incomplete tool call stream" do
      events = [
        %Events.ToolCallStart{
          type: :tool_call_start,
          tool_call_id: "call-1",
          tool_call_name: "test"
        },
        %Events.ToolCallArgs{type: :tool_call_args, tool_call_id: "call-1", delta: "{"}
        # No END
      ]

      compacted = Compaction.compact_events(events)

      assert length(compacted) == 2
      assert %Events.ToolCallStart{} = Enum.at(compacted, 0)
      assert %Events.ToolCallArgs{delta: "{"} = Enum.at(compacted, 1)
    end
  end

  describe "compact_events/1 - mixed streams" do
    test "compacts text and tool call streams" do
      events = [
        %Events.TextMessageStart{type: :text_message_start, message_id: "m1", role: "assistant"},
        %Events.TextMessageContent{
          type: :text_message_content,
          message_id: "m1",
          delta: "Let me "
        },
        %Events.TextMessageContent{
          type: :text_message_content,
          message_id: "m1",
          delta: "search"
        },
        %Events.TextMessageEnd{type: :text_message_end, message_id: "m1"},
        %Events.ToolCallStart{
          type: :tool_call_start,
          tool_call_id: "call-1",
          tool_call_name: "search"
        },
        %Events.ToolCallArgs{type: :tool_call_args, tool_call_id: "call-1", delta: ~s({"q": )},
        %Events.ToolCallArgs{type: :tool_call_args, tool_call_id: "call-1", delta: ~s("test"})},
        %Events.ToolCallEnd{type: :tool_call_end, tool_call_id: "call-1"}
      ]

      compacted = Compaction.compact_events(events)

      assert length(compacted) == 6

      # Text message compacted
      assert %Events.TextMessageStart{} = Enum.at(compacted, 0)
      assert %Events.TextMessageContent{delta: "Let me search"} = Enum.at(compacted, 1)
      assert %Events.TextMessageEnd{} = Enum.at(compacted, 2)

      # Tool call compacted
      assert %Events.ToolCallStart{} = Enum.at(compacted, 3)
      assert %Events.ToolCallArgs{delta: ~s({"q": "test"})} = Enum.at(compacted, 4)
      assert %Events.ToolCallEnd{} = Enum.at(compacted, 5)
    end

    test "preserves non-streaming events" do
      events = [
        %Events.RunStarted{type: :run_started, thread_id: "t1", run_id: "r1"},
        %Events.TextMessageStart{type: :text_message_start, message_id: "m1", role: "assistant"},
        %Events.TextMessageContent{type: :text_message_content, message_id: "m1", delta: "Hello"},
        %Events.TextMessageEnd{type: :text_message_end, message_id: "m1"},
        %Events.RunFinished{type: :run_finished, thread_id: "t1", run_id: "r1"}
      ]

      compacted = Compaction.compact_events(events)

      assert length(compacted) == 5
      assert %Events.RunStarted{} = Enum.at(compacted, 0)
      assert %Events.TextMessageStart{} = Enum.at(compacted, 1)
      assert %Events.TextMessageContent{} = Enum.at(compacted, 2)
      assert %Events.TextMessageEnd{} = Enum.at(compacted, 3)
      assert %Events.RunFinished{} = Enum.at(compacted, 4)
    end

    test "handles complex interleaving" do
      events = [
        %Events.RunStarted{type: :run_started, thread_id: "t1", run_id: "r1"},
        %Events.TextMessageStart{type: :text_message_start, message_id: "m1", role: "assistant"},
        %Events.TextMessageContent{type: :text_message_content, message_id: "m1", delta: "Hi"},
        %Events.StepStarted{type: :step_started, step_name: "think"},
        %Events.TextMessageContent{type: :text_message_content, message_id: "m1", delta: "!"},
        %Events.StepFinished{type: :step_finished, step_name: "think"},
        %Events.TextMessageEnd{type: :text_message_end, message_id: "m1"},
        %Events.RunFinished{type: :run_finished, thread_id: "t1", run_id: "r1"}
      ]

      compacted = Compaction.compact_events(events)

      # Expected: RUN_STARTED, TEXT_START, TEXT_CONTENT(merged), TEXT_END, STEP_STARTED, STEP_FINISHED, RUN_FINISHED
      assert length(compacted) == 7
      assert %Events.RunStarted{} = Enum.at(compacted, 0)
      assert %Events.TextMessageStart{} = Enum.at(compacted, 1)
      assert %Events.TextMessageContent{delta: "Hi!"} = Enum.at(compacted, 2)
      assert %Events.TextMessageEnd{} = Enum.at(compacted, 3)
      assert %Events.StepStarted{} = Enum.at(compacted, 4)
      assert %Events.StepFinished{} = Enum.at(compacted, 5)
      assert %Events.RunFinished{} = Enum.at(compacted, 6)
    end
  end

  describe "compact_events/1 - edge cases" do
    test "handles empty event list" do
      assert Compaction.compact_events([]) == []
    end

    test "handles single event" do
      events = [%Events.RunStarted{type: :run_started, thread_id: "t1", run_id: "r1"}]
      assert Compaction.compact_events(events) == events
    end

    test "preserves timestamp from first content event" do
      events = [
        %Events.TextMessageStart{type: :text_message_start, message_id: "m1", role: "assistant"},
        %Events.TextMessageContent{
          type: :text_message_content,
          message_id: "m1",
          delta: "A",
          timestamp: 1000
        },
        %Events.TextMessageContent{
          type: :text_message_content,
          message_id: "m1",
          delta: "B",
          timestamp: 2000
        },
        %Events.TextMessageEnd{type: :text_message_end, message_id: "m1"}
      ]

      compacted = Compaction.compact_events(events)

      assert %Events.TextMessageContent{timestamp: 1000} = Enum.at(compacted, 1)
    end

    test "handles multiple separate text streams" do
      events = [
        %Events.TextMessageStart{type: :text_message_start, message_id: "m1", role: "assistant"},
        %Events.TextMessageContent{type: :text_message_content, message_id: "m1", delta: "A"},
        %Events.TextMessageContent{type: :text_message_content, message_id: "m1", delta: "B"},
        %Events.TextMessageEnd{type: :text_message_end, message_id: "m1"},
        %Events.TextMessageStart{type: :text_message_start, message_id: "m2", role: "assistant"},
        %Events.TextMessageContent{type: :text_message_content, message_id: "m2", delta: "C"},
        %Events.TextMessageContent{type: :text_message_content, message_id: "m2", delta: "D"},
        %Events.TextMessageEnd{type: :text_message_end, message_id: "m2"}
      ]

      compacted = Compaction.compact_events(events)

      assert length(compacted) == 6
      assert %Events.TextMessageContent{message_id: "m1", delta: "AB"} = Enum.at(compacted, 1)
      assert %Events.TextMessageContent{message_id: "m2", delta: "CD"} = Enum.at(compacted, 4)
    end

    test "does NOT collapse state deltas into snapshots" do
      events = [
        %Events.StateSnapshot{type: :state_snapshot, snapshot: %{"a" => 1}},
        %Events.StateDelta{
          type: :state_delta,
          delta: [%{"op" => "replace", "path" => "/a", "value" => 2}]
        },
        %Events.StateDelta{
          type: :state_delta,
          delta: [%{"op" => "replace", "path" => "/a", "value" => 3}]
        }
      ]

      compacted = Compaction.compact_events(events)

      # All events preserved unchanged
      assert length(compacted) == 3
      assert %Events.StateSnapshot{} = Enum.at(compacted, 0)
      assert %Events.StateDelta{} = Enum.at(compacted, 1)
      assert %Events.StateDelta{} = Enum.at(compacted, 2)
    end
  end

  describe "compact_events/1 - real world scenarios" do
    test "chat with tool use" do
      events = [
        %Events.RunStarted{type: :run_started, thread_id: "t1", run_id: "r1"},
        %Events.TextMessageStart{type: :text_message_start, message_id: "m1", role: "assistant"},
        %Events.TextMessageContent{
          type: :text_message_content,
          message_id: "m1",
          delta: "I'll search "
        },
        %Events.TextMessageContent{
          type: :text_message_content,
          message_id: "m1",
          delta: "for that."
        },
        %Events.TextMessageEnd{type: :text_message_end, message_id: "m1"},
        %Events.ToolCallStart{
          type: :tool_call_start,
          tool_call_id: "c1",
          tool_call_name: "web_search",
          parent_message_id: "m1"
        },
        %Events.ToolCallArgs{type: :tool_call_args, tool_call_id: "c1", delta: ~s({"query": ")},
        %Events.ToolCallArgs{type: :tool_call_args, tool_call_id: "c1", delta: "elixir"},
        %Events.ToolCallArgs{type: :tool_call_args, tool_call_id: "c1", delta: ~s("})},
        %Events.ToolCallEnd{type: :tool_call_end, tool_call_id: "c1"},
        %Events.ToolCallResult{
          type: :tool_call_result,
          message_id: "t1",
          tool_call_id: "c1",
          content: "Elixir is a functional language..."
        },
        %Events.TextMessageStart{type: :text_message_start, message_id: "m2", role: "assistant"},
        %Events.TextMessageContent{
          type: :text_message_content,
          message_id: "m2",
          delta: "Based on"
        },
        %Events.TextMessageContent{
          type: :text_message_content,
          message_id: "m2",
          delta: " the results..."
        },
        %Events.TextMessageEnd{type: :text_message_end, message_id: "m2"},
        %Events.RunFinished{type: :run_finished, thread_id: "t1", run_id: "r1"}
      ]

      compacted = Compaction.compact_events(events)

      # Should be: RUN_STARTED, TEXT(m1) x 3, TOOL x 3, TOOL_RESULT, TEXT(m2) x 3, RUN_FINISHED
      assert length(compacted) == 12

      # First message compacted
      assert %Events.TextMessageContent{delta: "I'll search for that."} = Enum.at(compacted, 2)

      # Tool call compacted
      assert %Events.ToolCallArgs{delta: ~s({"query": "elixir"})} = Enum.at(compacted, 5)

      # Second message compacted
      assert %Events.TextMessageContent{delta: "Based on the results..."} = Enum.at(compacted, 9)
    end
  end
end
