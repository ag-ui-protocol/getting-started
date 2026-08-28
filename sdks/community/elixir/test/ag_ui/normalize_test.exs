defmodule AgUI.NormalizeTest do
  use ExUnit.Case, async: true

  alias AgUI.Normalize
  alias AgUI.Events

  describe "new/0" do
    test "creates empty pending state" do
      pending = Normalize.new()
      assert pending.text == %{}
      assert pending.tool == %{}
      assert pending.current_text_id == nil
      assert pending.current_tool_id == nil
    end
  end

  describe "expand/2 - TEXT_MESSAGE_CHUNK" do
    test "first chunk emits START and CONTENT" do
      chunk = %Events.TextMessageChunk{
        type: :text_message_chunk,
        message_id: "msg-1",
        role: "assistant",
        delta: "Hello"
      }

      pending = Normalize.new()
      {events, pending} = Normalize.expand(chunk, pending)

      assert length(events) == 2
      assert %Events.TextMessageStart{message_id: "msg-1", role: "assistant"} = Enum.at(events, 0)
      assert %Events.TextMessageContent{message_id: "msg-1", delta: "Hello"} = Enum.at(events, 1)
      assert Map.has_key?(pending.text, "msg-1")
      assert pending.current_text_id == "msg-1"
    end

    test "subsequent chunks only emit CONTENT" do
      chunk1 = %Events.TextMessageChunk{
        type: :text_message_chunk,
        message_id: "msg-1",
        role: "assistant",
        delta: "Hello "
      }

      chunk2 = %Events.TextMessageChunk{
        type: :text_message_chunk,
        message_id: "msg-1",
        delta: "world"
      }

      pending = Normalize.new()
      {events1, pending} = Normalize.expand(chunk1, pending)
      {events2, _pending} = Normalize.expand(chunk2, pending)

      assert length(events1) == 2
      assert length(events2) == 1
      assert %Events.TextMessageContent{delta: "world"} = hd(events2)
    end

    test "role defaults to assistant if not provided" do
      chunk = %Events.TextMessageChunk{
        type: :text_message_chunk,
        message_id: "msg-1",
        delta: "Hi"
      }

      pending = Normalize.new()
      {events, _pending} = Normalize.expand(chunk, pending)

      assert %Events.TextMessageStart{role: "assistant"} = hd(events)
    end

    test "supports allowed role types" do
      roles = ["developer", "system", "assistant", "user"]

      for role <- roles do
        chunk = %Events.TextMessageChunk{
          type: :text_message_chunk,
          message_id: "msg-#{role}",
          role: role,
          delta: "Test"
        }

        pending = Normalize.new()
        {events, _pending} = Normalize.expand(chunk, pending)

        assert %Events.TextMessageStart{role: ^role} = hd(events)
      end
    end

    test "no CONTENT event if delta is nil" do
      chunk = %Events.TextMessageChunk{
        type: :text_message_chunk,
        message_id: "msg-1",
        role: "assistant",
        delta: nil
      }

      pending = Normalize.new()
      {events, _pending} = Normalize.expand(chunk, pending)

      assert length(events) == 1
      assert %Events.TextMessageStart{} = hd(events)
    end

    test "no CONTENT event if delta is empty string" do
      chunk = %Events.TextMessageChunk{
        type: :text_message_chunk,
        message_id: "msg-1",
        role: "assistant",
        delta: ""
      }

      pending = Normalize.new()
      {events, _pending} = Normalize.expand(chunk, pending)

      assert length(events) == 1
      assert %Events.TextMessageStart{} = hd(events)
    end

    test "switching to different message ID closes current message" do
      chunk1 = %Events.TextMessageChunk{
        type: :text_message_chunk,
        message_id: "msg-1",
        delta: "Hello"
      }

      chunk2 = %Events.TextMessageChunk{
        type: :text_message_chunk,
        message_id: "msg-2",
        delta: "World"
      }

      pending = Normalize.new()
      {_events1, pending} = Normalize.expand(chunk1, pending)
      {events2, pending} = Normalize.expand(chunk2, pending)

      assert length(events2) == 3
      assert %Events.TextMessageEnd{message_id: "msg-1"} = Enum.at(events2, 0)
      assert %Events.TextMessageStart{message_id: "msg-2"} = Enum.at(events2, 1)
      assert %Events.TextMessageContent{message_id: "msg-2"} = Enum.at(events2, 2)

      assert not Map.has_key?(pending.text, "msg-1")
      assert Map.has_key?(pending.text, "msg-2")
    end

    test "returning to same message ID after switch starts new stream" do
      chunk1 = %Events.TextMessageChunk{
        type: :text_message_chunk,
        message_id: "msg-1",
        delta: "First"
      }

      chunk2 = %Events.TextMessageChunk{
        type: :text_message_chunk,
        message_id: "msg-2",
        delta: "Second"
      }

      chunk3 = %Events.TextMessageChunk{
        type: :text_message_chunk,
        message_id: "msg-1",
        delta: "Third"
      }

      pending = Normalize.new()
      {_events1, pending} = Normalize.expand(chunk1, pending)
      {_events2, pending} = Normalize.expand(chunk2, pending)
      {events3, _pending} = Normalize.expand(chunk3, pending)

      # Should close msg-2 and start NEW msg-1 stream
      assert length(events3) == 3
      assert %Events.TextMessageEnd{message_id: "msg-2"} = Enum.at(events3, 0)
      assert %Events.TextMessageStart{message_id: "msg-1"} = Enum.at(events3, 1)
      assert %Events.TextMessageContent{message_id: "msg-1"} = Enum.at(events3, 2)
    end
  end

  describe "expand/2 - TOOL_CALL_CHUNK" do
    test "first chunk emits START and ARGS" do
      chunk = %Events.ToolCallChunk{
        type: :tool_call_chunk,
        tool_call_id: "call-1",
        tool_call_name: "get_weather",
        delta: ~s({"location": "SF"})
      }

      pending = Normalize.new()
      {events, pending} = Normalize.expand(chunk, pending)

      assert length(events) == 2

      assert %Events.ToolCallStart{tool_call_id: "call-1", tool_call_name: "get_weather"} =
               Enum.at(events, 0)

      assert %Events.ToolCallArgs{tool_call_id: "call-1", delta: ~s({"location": "SF"})} =
               Enum.at(events, 1)

      assert Map.has_key?(pending.tool, "call-1")
    end

    test "first chunk preserves parent_message_id" do
      chunk = %Events.ToolCallChunk{
        type: :tool_call_chunk,
        tool_call_id: "call-1",
        tool_call_name: "search",
        parent_message_id: "msg-1",
        delta: "{}"
      }

      pending = Normalize.new()
      {events, _pending} = Normalize.expand(chunk, pending)

      assert %Events.ToolCallStart{parent_message_id: "msg-1"} = hd(events)
    end

    test "subsequent chunks only emit ARGS" do
      chunk1 = %Events.ToolCallChunk{
        type: :tool_call_chunk,
        tool_call_id: "call-1",
        tool_call_name: "get_weather",
        delta: "{"
      }

      chunk2 = %Events.ToolCallChunk{
        type: :tool_call_chunk,
        tool_call_id: "call-1",
        delta: "}"
      }

      pending = Normalize.new()
      {_events1, pending} = Normalize.expand(chunk1, pending)
      {events2, _pending} = Normalize.expand(chunk2, pending)

      assert length(events2) == 1
      assert %Events.ToolCallArgs{delta: "}"} = hd(events2)
    end

    test "first chunk without tool_call_name raises" do
      chunk = %Events.ToolCallChunk{
        type: :tool_call_chunk,
        tool_call_id: "call-1",
        delta: "{}"
      }

      pending = Normalize.new()

      assert_raise ArgumentError, ~r/toolCallName/, fn ->
        Normalize.expand(chunk, pending)
      end
    end

    test "text chunk without message_id raises" do
      chunk = %Events.TextMessageChunk{
        type: :text_message_chunk,
        message_id: nil,
        delta: "Hello"
      }

      pending = Normalize.new()

      assert_raise ArgumentError, ~r/messageId/, fn ->
        Normalize.expand(chunk, pending)
      end
    end

    test "text chunk can omit message_id after start" do
      chunk1 = %Events.TextMessageChunk{
        type: :text_message_chunk,
        message_id: "msg-1",
        role: "assistant",
        delta: "Hello"
      }

      chunk2 = %Events.TextMessageChunk{
        type: :text_message_chunk,
        message_id: nil,
        delta: " world"
      }

      pending = Normalize.new()
      {_events1, pending} = Normalize.expand(chunk1, pending)
      {events2, _pending} = Normalize.expand(chunk2, pending)

      assert [%Events.TextMessageContent{message_id: "msg-1"}] = events2
    end

    test "text chunk with invalid role raises" do
      chunk = %Events.TextMessageChunk{
        type: :text_message_chunk,
        message_id: "msg-1",
        role: "tool",
        delta: "Hello"
      }

      pending = Normalize.new()

      assert_raise ArgumentError, ~r/invalid role/, fn ->
        Normalize.expand(chunk, pending)
      end
    end

    test "safe stream emits RUN_ERROR on invalid chunk" do
      stream = [
        %Events.TextMessageChunk{
          type: :text_message_chunk,
          message_id: nil,
          delta: "Hello"
        }
      ]

      events = stream |> Normalize.expand_stream_safe() |> Enum.to_list()
      assert [%Events.RunError{}] = events
    end

    test "tool chunk without tool_call_id raises" do
      chunk = %Events.ToolCallChunk{
        type: :tool_call_chunk,
        tool_call_id: nil,
        tool_call_name: "test",
        delta: "{}"
      }

      pending = Normalize.new()

      assert_raise ArgumentError, ~r/toolCallId/, fn ->
        Normalize.expand(chunk, pending)
      end
    end

    test "tool chunk can omit tool_call_id after start" do
      chunk1 = %Events.ToolCallChunk{
        type: :tool_call_chunk,
        tool_call_id: "call-1",
        tool_call_name: "search",
        delta: "{"
      }

      chunk2 = %Events.ToolCallChunk{
        type: :tool_call_chunk,
        tool_call_id: nil,
        delta: "}"
      }

      pending = Normalize.new()
      {_events1, pending} = Normalize.expand(chunk1, pending)
      {events2, _pending} = Normalize.expand(chunk2, pending)

      assert [%Events.ToolCallArgs{tool_call_id: "call-1"}] = events2
    end

    test "no ARGS event if delta is nil" do
      chunk = %Events.ToolCallChunk{
        type: :tool_call_chunk,
        tool_call_id: "call-1",
        tool_call_name: "test",
        delta: nil
      }

      pending = Normalize.new()
      {events, _pending} = Normalize.expand(chunk, pending)

      assert length(events) == 1
      assert %Events.ToolCallStart{} = hd(events)
    end

    test "switching to different tool call ID closes current tool call" do
      chunk1 = %Events.ToolCallChunk{
        type: :tool_call_chunk,
        tool_call_id: "call-1",
        tool_call_name: "func1",
        delta: "a"
      }

      chunk2 = %Events.ToolCallChunk{
        type: :tool_call_chunk,
        tool_call_id: "call-2",
        tool_call_name: "func2",
        delta: "b"
      }

      pending = Normalize.new()
      {_events1, pending} = Normalize.expand(chunk1, pending)
      {events2, _pending} = Normalize.expand(chunk2, pending)

      assert length(events2) == 3
      assert %Events.ToolCallEnd{tool_call_id: "call-1"} = Enum.at(events2, 0)
      assert %Events.ToolCallStart{tool_call_id: "call-2"} = Enum.at(events2, 1)
      assert %Events.ToolCallArgs{tool_call_id: "call-2"} = Enum.at(events2, 2)
    end
  end

  describe "expand_stream_safe/1" do
    test "emits RunError and halts on malformed chunk" do
      bad_chunk = %Events.TextMessageChunk{
        type: :text_message_chunk,
        message_id: nil,
        delta: "oops"
      }

      events =
        [bad_chunk, %Events.RunFinished{type: :run_finished, thread_id: "t1", run_id: "r1"}]
        |> Normalize.expand_stream_safe()
        |> Enum.to_list()

      assert [%Events.RunError{message: message}] = events
      assert message =~ "missing required messageId"
    end
  end

  describe "expand/2 - passthrough events" do
    test "RAW events pass through without closing pending streams" do
      chunk = %Events.TextMessageChunk{
        type: :text_message_chunk,
        message_id: "msg-1",
        delta: "Hello"
      }

      raw = %Events.Raw{
        type: :raw,
        event: %{"custom" => "data"}
      }

      pending = Normalize.new()
      {_events1, pending} = Normalize.expand(chunk, pending)
      {events2, pending} = Normalize.expand(raw, pending)

      assert events2 == [raw]
      # Text stream still pending
      assert Map.has_key?(pending.text, "msg-1")
    end

    test "ACTIVITY_SNAPSHOT events pass through without closing pending streams" do
      chunk = %Events.TextMessageChunk{
        type: :text_message_chunk,
        message_id: "msg-1",
        delta: "Hello"
      }

      activity = %Events.ActivitySnapshot{
        type: :activity_snapshot,
        message_id: "act-1",
        activity_type: "progress",
        content: %{"step" => 1}
      }

      pending = Normalize.new()
      {_events1, pending} = Normalize.expand(chunk, pending)
      {events2, pending} = Normalize.expand(activity, pending)

      assert events2 == [activity]
      assert Map.has_key?(pending.text, "msg-1")
    end

    test "ACTIVITY_DELTA events pass through without closing pending streams" do
      chunk = %Events.TextMessageChunk{
        type: :text_message_chunk,
        message_id: "msg-1",
        delta: "Hello"
      }

      delta = %Events.ActivityDelta{
        type: :activity_delta,
        message_id: "act-1",
        activity_type: "progress",
        patch: [%{"op" => "replace", "path" => "/step", "value" => 2}]
      }

      pending = Normalize.new()
      {_events1, pending} = Normalize.expand(chunk, pending)
      {events2, pending} = Normalize.expand(delta, pending)

      assert events2 == [delta]
      assert Map.has_key?(pending.text, "msg-1")
    end
  end

  describe "expand/2 - other events close pending streams" do
    test "RUN_STARTED closes pending text message" do
      chunk = %Events.TextMessageChunk{
        type: :text_message_chunk,
        message_id: "msg-1",
        delta: "Hello"
      }

      run_started = %Events.RunStarted{
        type: :run_started,
        thread_id: "t1",
        run_id: "r1"
      }

      pending = Normalize.new()
      {_events1, pending} = Normalize.expand(chunk, pending)
      {events2, pending} = Normalize.expand(run_started, pending)

      assert length(events2) == 2
      assert %Events.TextMessageEnd{message_id: "msg-1"} = Enum.at(events2, 0)
      assert %Events.RunStarted{} = Enum.at(events2, 1)
      assert pending.text == %{}
    end

    test "TEXT_MESSAGE_START closes pending text message" do
      chunk = %Events.TextMessageChunk{
        type: :text_message_chunk,
        message_id: "msg-1",
        delta: "Hello"
      }

      start = %Events.TextMessageStart{
        type: :text_message_start,
        message_id: "msg-2",
        role: "assistant"
      }

      pending = Normalize.new()
      {_events1, pending} = Normalize.expand(chunk, pending)
      {events2, pending} = Normalize.expand(start, pending)

      assert length(events2) == 2
      assert %Events.TextMessageEnd{message_id: "msg-1"} = Enum.at(events2, 0)
      assert %Events.TextMessageStart{message_id: "msg-2"} = Enum.at(events2, 1)
      assert pending.text == %{}
    end

    test "closes both text and tool streams" do
      text_chunk = %Events.TextMessageChunk{
        type: :text_message_chunk,
        message_id: "msg-1",
        delta: "Hi"
      }

      tool_chunk = %Events.ToolCallChunk{
        type: :tool_call_chunk,
        tool_call_id: "call-1",
        tool_call_name: "test",
        delta: "{}"
      }

      run_finished = %Events.RunFinished{
        type: :run_finished,
        thread_id: "t1",
        run_id: "r1"
      }

      pending = Normalize.new()
      {_events1, pending} = Normalize.expand(text_chunk, pending)
      # Text is now pending, but tool chunk will close it
      {_events2, pending} = Normalize.expand(tool_chunk, pending)
      # Now tool is pending
      {events3, pending} = Normalize.expand(run_finished, pending)

      # Should close tool call
      end_events = Enum.filter(events3, fn e -> e.type == :tool_call_end end)
      assert length(end_events) == 1
      assert pending.text == %{}
      assert pending.tool == %{}
    end
  end

  describe "finalize/1" do
    test "closes pending text message" do
      chunk = %Events.TextMessageChunk{
        type: :text_message_chunk,
        message_id: "msg-1",
        delta: "Hello"
      }

      pending = Normalize.new()
      {_events, pending} = Normalize.expand(chunk, pending)
      final_events = Normalize.finalize(pending)

      assert length(final_events) == 1
      assert %Events.TextMessageEnd{message_id: "msg-1"} = hd(final_events)
    end

    test "closes pending tool call" do
      chunk = %Events.ToolCallChunk{
        type: :tool_call_chunk,
        tool_call_id: "call-1",
        tool_call_name: "test",
        delta: "{}"
      }

      pending = Normalize.new()
      {_events, pending} = Normalize.expand(chunk, pending)
      final_events = Normalize.finalize(pending)

      assert length(final_events) == 1
      assert %Events.ToolCallEnd{tool_call_id: "call-1"} = hd(final_events)
    end

    test "returns empty list if no pending streams" do
      pending = Normalize.new()
      final_events = Normalize.finalize(pending)
      assert final_events == []
    end
  end

  describe "expand_stream/1" do
    test "transforms stream of chunk events" do
      chunks = [
        %Events.TextMessageChunk{
          type: :text_message_chunk,
          message_id: "msg-1",
          delta: "Hello "
        },
        %Events.TextMessageChunk{
          type: :text_message_chunk,
          message_id: "msg-1",
          delta: "world"
        }
      ]

      events = chunks |> Normalize.expand_stream() |> Enum.to_list()

      assert length(events) == 4
      assert %Events.TextMessageStart{message_id: "msg-1"} = Enum.at(events, 0)
      assert %Events.TextMessageContent{delta: "Hello "} = Enum.at(events, 1)
      assert %Events.TextMessageContent{delta: "world"} = Enum.at(events, 2)
      assert %Events.TextMessageEnd{message_id: "msg-1"} = Enum.at(events, 3)
    end

    test "finalizes pending streams at end of stream" do
      chunks = [
        %Events.TextMessageChunk{
          type: :text_message_chunk,
          message_id: "msg-1",
          delta: "Incomplete"
        }
        # No closing event
      ]

      events = chunks |> Normalize.expand_stream() |> Enum.to_list()

      assert length(events) == 3
      assert %Events.TextMessageStart{} = Enum.at(events, 0)
      assert %Events.TextMessageContent{} = Enum.at(events, 1)
      assert %Events.TextMessageEnd{} = Enum.at(events, 2)
    end

    test "passes through non-chunk events" do
      events_input = [
        %Events.RunStarted{type: :run_started, thread_id: "t1", run_id: "r1"},
        %Events.TextMessageChunk{
          type: :text_message_chunk,
          message_id: "msg-1",
          delta: "Hello"
        },
        %Events.RunFinished{type: :run_finished, thread_id: "t1", run_id: "r1"}
      ]

      events = events_input |> Normalize.expand_stream() |> Enum.to_list()

      assert length(events) == 5
      assert %Events.RunStarted{} = Enum.at(events, 0)
      assert %Events.TextMessageStart{} = Enum.at(events, 1)
      assert %Events.TextMessageContent{} = Enum.at(events, 2)
      assert %Events.TextMessageEnd{} = Enum.at(events, 3)
      assert %Events.RunFinished{} = Enum.at(events, 4)
    end

    test "handles interleaved passthrough events" do
      events_input = [
        %Events.TextMessageChunk{
          type: :text_message_chunk,
          message_id: "msg-1",
          delta: "Part 1"
        },
        %Events.ActivitySnapshot{
          type: :activity_snapshot,
          message_id: "act-1",
          activity_type: "progress",
          content: %{}
        },
        %Events.TextMessageChunk{
          type: :text_message_chunk,
          message_id: "msg-1",
          delta: "Part 2"
        }
      ]

      events = events_input |> Normalize.expand_stream() |> Enum.to_list()

      # START, CONTENT("Part 1"), ACTIVITY, CONTENT("Part 2"), END
      assert length(events) == 5
      assert %Events.TextMessageStart{} = Enum.at(events, 0)
      assert %Events.TextMessageContent{delta: "Part 1"} = Enum.at(events, 1)
      assert %Events.ActivitySnapshot{} = Enum.at(events, 2)
      assert %Events.TextMessageContent{delta: "Part 2"} = Enum.at(events, 3)
      # Finalized END
      assert %Events.TextMessageEnd{} = Enum.at(events, 4)
    end
  end

  describe "complex scenarios" do
    test "alternating text and tool chunks" do
      events_input = [
        %Events.TextMessageChunk{
          type: :text_message_chunk,
          message_id: "msg-1",
          delta: "Let me search..."
        },
        %Events.ToolCallChunk{
          type: :tool_call_chunk,
          tool_call_id: "call-1",
          tool_call_name: "search",
          delta: ~s({"q": "test"})
        },
        %Events.TextMessageChunk{
          type: :text_message_chunk,
          message_id: "msg-1",
          delta: "Found results!"
        }
      ]

      events = events_input |> Normalize.expand_stream() |> Enum.to_list()

      types = Enum.map(events, & &1.type)

      assert types == [
               :text_message_start,
               :text_message_content,
               :text_message_end,
               :tool_call_start,
               :tool_call_args,
               :tool_call_end,
               :text_message_start,
               :text_message_content,
               :text_message_end
             ]
    end

    test "multiple messages without interleaving" do
      events_input = [
        %Events.RunStarted{type: :run_started, thread_id: "t1", run_id: "r1"},
        %Events.TextMessageChunk{message_id: "msg-1", delta: "First", type: :text_message_chunk},
        %Events.RunFinished{type: :run_finished, thread_id: "t1", run_id: "r1"},
        %Events.RunStarted{type: :run_started, thread_id: "t1", run_id: "r2"},
        %Events.TextMessageChunk{message_id: "msg-2", delta: "Second", type: :text_message_chunk},
        %Events.RunFinished{type: :run_finished, thread_id: "t1", run_id: "r2"}
      ]

      events = events_input |> Normalize.expand_stream() |> Enum.to_list()

      types = Enum.map(events, & &1.type)

      assert types == [
               :run_started,
               :text_message_start,
               :text_message_content,
               :text_message_end,
               :run_finished,
               :run_started,
               :text_message_start,
               :text_message_content,
               :text_message_end,
               :run_finished
             ]
    end
  end
end
