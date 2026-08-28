defmodule AgUI.ReducerTest do
  use ExUnit.Case, async: true

  alias AgUI.Reducer
  alias AgUI.Session
  alias AgUI.Events
  alias AgUI.Types.Message

  describe "lifecycle events" do
    test "RunStarted initializes session" do
      session = Session.new()

      event = %Events.RunStarted{
        type: :run_started,
        thread_id: "thread-1",
        run_id: "run-1"
      }

      session = Reducer.apply(session, event)

      assert session.thread_id == "thread-1"
      assert session.run_id == "run-1"
      assert session.status == :running
      assert session.steps == []
      assert session.text_buffers == %{}
      assert session.tool_buffers == %{}
    end

    test "RunStarted resets run-specific state but preserves messages" do
      session = %Session{
        thread_id: "thread-1",
        run_id: "run-old",
        status: :finished,
        messages: [%Message.User{id: "1", content: "Hello"}],
        steps: [%{name: "step1", status: :finished}],
        text_buffers: %{"old" => %{content: "x", role: :assistant}}
      }

      event = %Events.RunStarted{
        type: :run_started,
        thread_id: "thread-1",
        run_id: "run-new"
      }

      session = Reducer.apply(session, event)

      assert session.run_id == "run-new"
      assert session.status == :running
      assert session.steps == []
      assert session.text_buffers == %{}
      # Messages are preserved
      assert length(session.messages) == 1
    end

    test "RunFinished sets status to finished" do
      session = %Session{status: :running, thread_id: "t1", run_id: "r1"}

      event = %Events.RunFinished{
        type: :run_finished,
        thread_id: "t1",
        run_id: "r1"
      }

      session = Reducer.apply(session, event)
      assert session.status == :finished
    end

    test "RunFinished clears pending buffers" do
      session = %Session{
        status: :running,
        text_buffers: %{"msg-1" => %{content: "Hello", role: :assistant}}
      }

      event = %Events.RunFinished{type: :run_finished, thread_id: "t1", run_id: "r1"}
      session = Reducer.apply(session, event)

      assert session.text_buffers == %{}
      assert session.messages == []
    end

    test "RunError sets error status" do
      session = %Session{status: :running}

      event = %Events.RunError{
        type: :run_error,
        message: "Something went wrong",
        code: "E001"
      }

      session = Reducer.apply(session, event)
      assert session.status == {:error, "Something went wrong"}
    end

    test "StepStarted adds a new step" do
      session = Session.new()

      event = %Events.StepStarted{
        type: :step_started,
        step_name: "research"
      }

      session = Reducer.apply(session, event)
      assert length(session.steps) == 1
      assert hd(session.steps) == %{name: "research", status: :started}
    end

    test "StepFinished marks step as finished" do
      session = %Session{
        steps: [
          %{name: "research", status: :started},
          %{name: "analyze", status: :started}
        ]
      }

      event = %Events.StepFinished{
        type: :step_finished,
        step_name: "research"
      }

      session = Reducer.apply(session, event)
      research = Enum.find(session.steps, &(&1.name == "research"))
      analyze = Enum.find(session.steps, &(&1.name == "analyze"))

      assert research.status == :finished
      assert analyze.status == :started
    end
  end

  describe "text message events" do
    test "TextMessageStart creates a buffer" do
      session = Session.new()

      event = %Events.TextMessageStart{
        type: :text_message_start,
        message_id: "msg-1",
        role: "assistant"
      }

      session = Reducer.apply(session, event)
      assert Map.has_key?(session.text_buffers, "msg-1")
      assert session.text_buffers["msg-1"].content == ""
      assert session.text_buffers["msg-1"].role == :assistant
      assert [%AgUI.Types.Message.Assistant{id: "msg-1", content: ""}] = session.messages
    end

    test "TextMessageContent appends to buffer" do
      session = %Session{
        text_buffers: %{"msg-1" => %{content: "Hello", role: :assistant}},
        messages: [%AgUI.Types.Message.Assistant{id: "msg-1", content: "Hello"}]
      }

      event = %Events.TextMessageContent{
        type: :text_message_content,
        message_id: "msg-1",
        delta: " world!"
      }

      session = Reducer.apply(session, event)
      assert session.text_buffers["msg-1"].content == "Hello world!"
      assert [%AgUI.Types.Message.Assistant{content: "Hello world!"}] = session.messages
    end

    test "TextMessageContent creates buffer if missing" do
      session = Session.new()

      event = %Events.TextMessageContent{
        type: :text_message_content,
        message_id: "msg-1",
        delta: "Hello"
      }

      session = Reducer.apply(session, event)
      assert session.text_buffers["msg-1"].content == "Hello"
      assert [%AgUI.Types.Message.Assistant{content: "Hello"}] = session.messages
      assert session.text_buffers["msg-1"].role == :assistant
      assert [%AgUI.Types.Message.Assistant{id: "msg-1", content: "Hello"}] = session.messages
    end

    test "TextMessageEnd clears buffer and preserves message" do
      session = %Session{
        text_buffers: %{"msg-1" => %{content: "Hello world!", role: :assistant}},
        messages: [%AgUI.Types.Message.Assistant{id: "msg-1", content: "Hello world!"}]
      }

      event = %Events.TextMessageEnd{
        type: :text_message_end,
        message_id: "msg-1"
      }

      session = Reducer.apply(session, event)
      assert session.text_buffers == %{}

      assert [%AgUI.Types.Message.Assistant{id: "msg-1", content: "Hello world!"}] =
               session.messages
    end

    test "TextMessageEnd is no-op for missing buffer" do
      session = Session.new()

      event = %Events.TextMessageEnd{
        type: :text_message_end,
        message_id: "nonexistent"
      }

      session = Reducer.apply(session, event)
      assert session.messages == []
    end

    test "TextMessageChunk creates buffer and adds content" do
      session = Session.new()

      event = %Events.TextMessageChunk{
        type: :text_message_chunk,
        message_id: "msg-1",
        role: "assistant",
        delta: "Hello"
      }

      session = Reducer.apply(session, event)
      assert session.text_buffers["msg-1"].content == "Hello"

      # Second chunk
      event2 = %Events.TextMessageChunk{
        type: :text_message_chunk,
        message_id: "msg-1",
        delta: " world!"
      }

      session = Reducer.apply(session, event2)
      assert session.text_buffers["msg-1"].content == "Hello world!"
      assert [%AgUI.Types.Message.Assistant{content: "Hello world!"}] = session.messages
    end
  end

  describe "tool call events" do
    test "ToolCallStart creates a buffer" do
      session = Session.new()

      event = %Events.ToolCallStart{
        type: :tool_call_start,
        tool_call_id: "call-1",
        tool_call_name: "get_weather",
        parent_message_id: "msg-1"
      }

      session = Reducer.apply(session, event)
      assert Map.has_key?(session.tool_buffers, "call-1")
      assert session.tool_buffers["call-1"].name == "get_weather"
      assert session.tool_buffers["call-1"].args == ""
      assert session.tool_buffers["call-1"].parent_message_id == "msg-1"
      assert [%Message.Assistant{id: "msg-1", tool_calls: tool_calls}] = session.messages
      assert [%AgUI.Types.ToolCall{id: "call-1"}] = tool_calls
    end

    test "ToolCallArgs appends to buffer" do
      session = %Session{
        tool_buffers: %{
          "call-1" => %{name: "search", args: "{\"q\":", parent_message_id: "msg-1"}
        },
        messages: [
          %Message.Assistant{
            id: "msg-1",
            content: "",
            tool_calls: [
              %AgUI.Types.ToolCall{
                id: "call-1",
                type: :function,
                function: %{name: "search", arguments: "{\"q\":"}
              }
            ]
          }
        ]
      }

      event = %Events.ToolCallArgs{
        type: :tool_call_args,
        tool_call_id: "call-1",
        delta: "\"test\"}"
      }

      session = Reducer.apply(session, event)
      assert session.tool_buffers["call-1"].args == "{\"q\":\"test\"}"
      msg = hd(session.messages)
      assert hd(msg.tool_calls).function.arguments == "{\"q\":\"test\"}"
    end

    test "ToolCallEnd attaches to tool_call_id when no parent" do
      session = %Session{
        tool_buffers: %{
          "call-1" => %{name: "search", args: "{}", parent_message_id: nil}
        }
      }

      event = %Events.ToolCallEnd{
        type: :tool_call_end,
        tool_call_id: "call-1"
      }

      session = Reducer.apply(session, event)
      assert session.tool_buffers == %{}
      assert [%Message.Assistant{id: "call-1", tool_calls: tool_calls}] = session.messages
      assert [%AgUI.Types.ToolCall{id: "call-1"}] = tool_calls
    end

    test "ToolCallEnd attaches to parent message" do
      session = %Session{
        messages: [
          %Message.Assistant{id: "msg-1", content: "Let me search", tool_calls: []}
        ],
        tool_buffers: %{
          "call-1" => %{name: "search", args: "{\"q\": \"test\"}", parent_message_id: "msg-1"}
        }
      }

      event = %Events.ToolCallEnd{
        type: :tool_call_end,
        tool_call_id: "call-1"
      }

      session = Reducer.apply(session, event)
      assert session.tool_buffers == %{}

      msg = hd(session.messages)
      assert length(msg.tool_calls) == 1
      assert hd(msg.tool_calls).id == "call-1"
      assert hd(msg.tool_calls).function.name == "search"
    end

    test "ToolCallResult adds tool message" do
      session = Session.new()

      event = %Events.ToolCallResult{
        type: :tool_call_result,
        message_id: "tool-msg-1",
        tool_call_id: "call-1",
        content: "The weather is sunny"
      }

      session = Reducer.apply(session, event)
      assert length(session.messages) == 1

      msg = hd(session.messages)
      assert msg.role == :tool
      assert msg.content == "The weather is sunny"
      assert msg.tool_call_id == "call-1"
    end

    test "ToolCallChunk creates buffer and adds args" do
      session = Session.new()

      event = %Events.ToolCallChunk{
        type: :tool_call_chunk,
        tool_call_id: "call-1",
        tool_call_name: "search",
        delta: "{\"q\":"
      }

      session = Reducer.apply(session, event)
      assert session.tool_buffers["call-1"].name == "search"
      assert session.tool_buffers["call-1"].args == "{\"q\":"

      # Second chunk
      event2 = %Events.ToolCallChunk{
        type: :tool_call_chunk,
        tool_call_id: "call-1",
        delta: "\"test\"}"
      }

      session = Reducer.apply(session, event2)
      assert session.tool_buffers["call-1"].args == "{\"q\":\"test\"}"
    end
  end

  describe "state management events" do
    test "StateSnapshot replaces state" do
      session = %Session{state: %{"old" => "data"}}

      event = %Events.StateSnapshot{
        type: :state_snapshot,
        snapshot: %{"new" => "state", "counter" => 1}
      }

      session = Reducer.apply(session, event)
      assert session.state == %{"new" => "state", "counter" => 1}
    end

    test "StateDelta applies JSON Patch" do
      session = %Session{state: %{"counter" => 5, "items" => []}}

      event = %Events.StateDelta{
        type: :state_delta,
        delta: [
          %{"op" => "replace", "path" => "/counter", "value" => 6},
          %{"op" => "add", "path" => "/items/-", "value" => "new"}
        ]
      }

      session = Reducer.apply(session, event)
      assert session.state["counter"] == 6
      assert session.state["items"] == ["new"]
    end

    test "StateDelta keeps state on patch failure" do
      session = %Session{state: %{"a" => 1}}

      event = %Events.StateDelta{
        type: :state_delta,
        delta: [%{"op" => "remove", "path" => "/nonexistent"}]
      }

      session = Reducer.apply(session, event)
      assert session.state == %{"a" => 1}
    end

    test "MessagesSnapshot replaces messages" do
      session = %Session{
        messages: [%Message.User{id: "old", content: "Old message"}]
      }

      event = %Events.MessagesSnapshot{
        type: :messages_snapshot,
        messages: [
          %{"id" => "1", "role" => "user", "content" => "Hello"},
          %{"id" => "2", "role" => "assistant", "content" => "Hi!"}
        ]
      }

      session = Reducer.apply(session, event)
      assert length(session.messages) == 2
      assert hd(session.messages).id == "1"
      assert hd(session.messages).content == "Hello"
    end
  end

  describe "activity events" do
    test "ActivitySnapshot creates activity message" do
      session = Session.new()

      event = %Events.ActivitySnapshot{
        type: :activity_snapshot,
        message_id: "activity-1",
        activity_type: "search_results",
        content: %{"results" => []},
        replace: true
      }

      session = Reducer.apply(session, event)
      assert length(session.messages) == 1

      msg = hd(session.messages)
      assert msg.role == :activity
      assert msg.activity_type == "search_results"
      assert msg.content == %{"results" => []}
    end

    test "ActivitySnapshot replaces existing activity with same ID" do
      session = %Session{
        messages: [
          %Message.Activity{
            id: "activity-1",
            activity_type: "search",
            content: %{"status" => "pending"}
          }
        ]
      }

      event = %Events.ActivitySnapshot{
        type: :activity_snapshot,
        message_id: "activity-1",
        activity_type: "search",
        content: %{"status" => "complete", "results" => [1, 2, 3]},
        replace: true
      }

      session = Reducer.apply(session, event)
      assert length(session.messages) == 1

      msg = hd(session.messages)
      assert msg.content["status"] == "complete"
      assert msg.content["results"] == [1, 2, 3]
    end

    test "ActivitySnapshot with replace=false appends" do
      session = %Session{
        messages: [
          %Message.Activity{
            id: "activity-1",
            activity_type: "search",
            content: %{"status" => "pending"}
          }
        ]
      }

      event = %Events.ActivitySnapshot{
        type: :activity_snapshot,
        message_id: "activity-1",
        activity_type: "search",
        content: %{"status" => "complete"},
        replace: false
      }

      session = Reducer.apply(session, event)
      assert length(session.messages) == 2
    end

    test "ActivityDelta applies patch to activity content" do
      session = %Session{
        messages: [
          %Message.Activity{
            id: "activity-1",
            activity_type: "progress",
            content: %{"percent" => 0, "steps" => []}
          }
        ]
      }

      event = %Events.ActivityDelta{
        type: :activity_delta,
        message_id: "activity-1",
        activity_type: "progress",
        patch: [
          %{"op" => "replace", "path" => "/percent", "value" => 50},
          %{"op" => "add", "path" => "/steps/-", "value" => "Step 1 complete"}
        ]
      }

      session = Reducer.apply(session, event)

      msg = hd(session.messages)
      assert msg.content["percent"] == 50
      assert msg.content["steps"] == ["Step 1 complete"]
    end

    test "ActivityDelta keeps content on patch failure" do
      session = %Session{
        messages: [
          %Message.Activity{
            id: "activity-1",
            activity_type: "progress",
            content: %{"percent" => 0}
          }
        ]
      }

      event = %Events.ActivityDelta{
        type: :activity_delta,
        message_id: "activity-1",
        activity_type: "progress",
        patch: [%{"op" => "remove", "path" => "/nonexistent"}]
      }

      session = Reducer.apply(session, event)

      msg = hd(session.messages)
      assert msg.content == %{"percent" => 0}
    end
  end

  describe "thinking events" do
    test "ThinkingStart activates thinking" do
      session = Session.new()

      event = %Events.ThinkingStart{type: :thinking_start}
      session = Reducer.apply(session, event)

      assert session.thinking.active == true
    end

    test "ThinkingEnd deactivates thinking" do
      session = %Session{thinking: %{active: true, content: "..."}}

      event = %Events.ThinkingEnd{type: :thinking_end}
      session = Reducer.apply(session, event)

      assert session.thinking.active == false
    end

    test "ThinkingTextMessageContent appends to thinking content" do
      session = %Session{thinking: %{active: true, content: "Let me"}}

      event = %Events.ThinkingTextMessageContent{
        type: :thinking_text_message_content,
        delta: " think..."
      }

      session = Reducer.apply(session, event)
      assert session.thinking.content == "Let me think..."
    end

    test "ThinkingTextMessageStart is no-op" do
      session = Session.new()

      event = %Events.ThinkingTextMessageStart{
        type: :thinking_text_message_start
      }

      session = Reducer.apply(session, event)
      assert session == Session.new()
    end

    test "ThinkingTextMessageEnd is no-op" do
      session = %Session{thinking: %{active: true, content: "..."}}

      event = %Events.ThinkingTextMessageEnd{
        type: :thinking_text_message_end
      }

      new_session = Reducer.apply(session, event)
      assert new_session.thinking == session.thinking
    end
  end

  describe "special events" do
    test "Raw event is no-op" do
      session = %Session{state: %{"a" => 1}}

      event = %Events.Raw{
        type: :raw,
        event: %{"custom" => "data"}
      }

      new_session = Reducer.apply(session, event)
      assert new_session == session
    end

    test "Custom event is no-op" do
      session = %Session{state: %{"a" => 1}}

      event = %Events.Custom{
        type: :custom,
        name: "my_event",
        value: %{"foo" => "bar"}
      }

      new_session = Reducer.apply(session, event)
      assert new_session == session
    end
  end

  describe "apply_all/2" do
    test "applies multiple events in sequence" do
      session = Session.new()

      events = [
        %Events.RunStarted{type: :run_started, thread_id: "t1", run_id: "r1"},
        %Events.TextMessageStart{
          type: :text_message_start,
          message_id: "msg-1",
          role: "assistant"
        },
        %Events.TextMessageContent{
          type: :text_message_content,
          message_id: "msg-1",
          delta: "Hello"
        },
        %Events.TextMessageContent{
          type: :text_message_content,
          message_id: "msg-1",
          delta: " world!"
        },
        %Events.TextMessageEnd{type: :text_message_end, message_id: "msg-1"},
        %Events.RunFinished{type: :run_finished, thread_id: "t1", run_id: "r1"}
      ]

      session = Reducer.apply_all(session, events)

      assert session.status == :finished
      assert length(session.messages) == 1
      assert hd(session.messages).content == "Hello world!"
    end
  end

  describe "integration scenario: complete run" do
    test "handles a full agent run with messages and tool calls" do
      session = Session.new()

      events = [
        # Run starts
        %Events.RunStarted{type: :run_started, thread_id: "t1", run_id: "r1"},

        # Step: Research
        %Events.StepStarted{type: :step_started, step_name: "research"},

        # Assistant message starts
        %Events.TextMessageStart{
          type: :text_message_start,
          message_id: "msg-1",
          role: "assistant"
        },
        %Events.TextMessageContent{
          type: :text_message_content,
          message_id: "msg-1",
          delta: "I'll search for that."
        },
        %Events.TextMessageEnd{type: :text_message_end, message_id: "msg-1"},

        # Tool call
        %Events.ToolCallStart{
          type: :tool_call_start,
          tool_call_id: "call-1",
          tool_call_name: "search",
          parent_message_id: "msg-1"
        },
        %Events.ToolCallArgs{
          type: :tool_call_args,
          tool_call_id: "call-1",
          delta: "{\"query\": \"test\"}"
        },
        %Events.ToolCallEnd{type: :tool_call_end, tool_call_id: "call-1"},

        # Tool result
        %Events.ToolCallResult{
          type: :tool_call_result,
          message_id: "tool-1",
          tool_call_id: "call-1",
          content: "Found 3 results"
        },

        # Step ends
        %Events.StepFinished{type: :step_finished, step_name: "research"},

        # State update
        %Events.StateDelta{
          type: :state_delta,
          delta: [%{"op" => "add", "path" => "/searchComplete", "value" => true}]
        },

        # Final assistant message
        %Events.TextMessageStart{
          type: :text_message_start,
          message_id: "msg-2",
          role: "assistant"
        },
        %Events.TextMessageContent{
          type: :text_message_content,
          message_id: "msg-2",
          delta: "I found 3 results."
        },
        %Events.TextMessageEnd{type: :text_message_end, message_id: "msg-2"},

        # Run finishes
        %Events.RunFinished{type: :run_finished, thread_id: "t1", run_id: "r1"}
      ]

      session = Reducer.apply_all(session, events)

      assert session.status == :finished
      assert length(session.messages) == 3
      assert length(session.steps) == 1
      assert hd(session.steps).status == :finished

      # Check tool call was attached to first message
      first_msg = Enum.at(session.messages, 0)
      assert length(first_msg.tool_calls) == 1

      # Check state was updated
      assert session.state["searchComplete"] == true
    end
  end
end
