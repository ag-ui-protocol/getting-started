defmodule AgUI.LiveView.RendererTest do
  use ExUnit.Case, async: true

  alias AgUI.LiveView.Renderer
  alias AgUI.Events

  describe "init/1" do
    test "creates default UI state" do
      state = Renderer.init()

      assert %Renderer{} = state
      assert state.session != nil
      assert state.streaming_messages == %{}
      assert state.streaming_tools == %{}
      assert state.run_status == :idle
      assert state.steps == []
      assert state.last_event_type == nil
      assert state.event_count == 0
    end

    test "accepts thread_id option" do
      state = Renderer.init(thread_id: "thread-123")

      assert state.session.thread_id == "thread-123"
    end

    test "accepts run_id option" do
      state = Renderer.init(thread_id: "thread-1", run_id: "run-1")

      assert state.session.thread_id == "thread-1"
      assert state.session.run_id == "run-1"
    end
  end

  describe "apply/2" do
    test "updates run_status on RUN_STARTED" do
      state = Renderer.init()

      event = %Events.RunStarted{
        type: :RUN_STARTED,
        thread_id: "t1",
        run_id: "r1"
      }

      new_state = Renderer.apply_event(state, event)

      assert new_state.run_status == :running
      assert new_state.last_event_type == :RUN_STARTED
      assert new_state.event_count == 1
    end

    test "updates run_status on RUN_FINISHED" do
      state = Renderer.init()

      start_event = %Events.RunStarted{
        type: :RUN_STARTED,
        thread_id: "t1",
        run_id: "r1"
      }

      finish_event = %Events.RunFinished{
        type: :RUN_FINISHED,
        thread_id: "t1",
        run_id: "r1"
      }

      new_state =
        state
        |> Renderer.apply_event(start_event)
        |> Renderer.apply_event(finish_event)

      assert new_state.run_status == :finished
      assert new_state.last_event_type == :RUN_FINISHED
      assert new_state.event_count == 2
    end

    test "updates run_status on RUN_ERROR" do
      state = Renderer.init()

      start_event = %Events.RunStarted{
        type: :RUN_STARTED,
        thread_id: "t1",
        run_id: "r1"
      }

      error_event = %Events.RunError{
        type: :RUN_ERROR,
        message: "Something went wrong"
      }

      new_state =
        state
        |> Renderer.apply_event(start_event)
        |> Renderer.apply_event(error_event)

      assert new_state.run_status == {:error, "Something went wrong"}
    end

    test "tracks streaming messages" do
      state = Renderer.init()

      events = [
        %Events.RunStarted{type: :RUN_STARTED, thread_id: "t1", run_id: "r1"},
        %Events.TextMessageStart{
          type: :TEXT_MESSAGE_START,
          message_id: "msg1",
          role: :assistant
        },
        %Events.TextMessageContent{
          type: :TEXT_MESSAGE_CONTENT,
          message_id: "msg1",
          delta: "Hello"
        },
        %Events.TextMessageContent{
          type: :TEXT_MESSAGE_CONTENT,
          message_id: "msg1",
          delta: " world"
        }
      ]

      new_state = Renderer.apply_all(state, events)

      assert map_size(new_state.streaming_messages) == 1
      assert new_state.streaming_messages["msg1"].content == "Hello world"
      assert new_state.streaming_messages["msg1"].role == :assistant
    end

    test "clears streaming message on TEXT_MESSAGE_END" do
      state = Renderer.init()

      events = [
        %Events.RunStarted{type: :RUN_STARTED, thread_id: "t1", run_id: "r1"},
        %Events.TextMessageStart{
          type: :TEXT_MESSAGE_START,
          message_id: "msg1",
          role: :assistant
        },
        %Events.TextMessageContent{
          type: :TEXT_MESSAGE_CONTENT,
          message_id: "msg1",
          delta: "Hello"
        },
        %Events.TextMessageEnd{
          type: :TEXT_MESSAGE_END,
          message_id: "msg1"
        }
      ]

      new_state = Renderer.apply_all(state, events)

      assert new_state.streaming_messages == %{}
      assert length(new_state.session.messages) == 1
    end

    test "tracks streaming tools" do
      state = Renderer.init()

      events = [
        %Events.RunStarted{type: :RUN_STARTED, thread_id: "t1", run_id: "r1"},
        %Events.ToolCallStart{
          type: :TOOL_CALL_START,
          tool_call_id: "tc1",
          tool_call_name: "search",
          parent_message_id: "msg1"
        },
        %Events.ToolCallArgs{
          type: :TOOL_CALL_ARGS,
          tool_call_id: "tc1",
          delta: "{\"query\":"
        },
        %Events.ToolCallArgs{
          type: :TOOL_CALL_ARGS,
          tool_call_id: "tc1",
          delta: "\"test\"}"
        }
      ]

      new_state = Renderer.apply_all(state, events)

      assert map_size(new_state.streaming_tools) == 1
      assert new_state.streaming_tools["tc1"].name == "search"
      assert new_state.streaming_tools["tc1"].args == "{\"query\":\"test\"}"
    end

    test "tracks steps" do
      state = Renderer.init()

      events = [
        %Events.RunStarted{type: :RUN_STARTED, thread_id: "t1", run_id: "r1"},
        %Events.StepStarted{type: :STEP_STARTED, step_name: "thinking"},
        %Events.StepFinished{type: :STEP_FINISHED, step_name: "thinking"}
      ]

      new_state = Renderer.apply_all(state, events)

      assert length(new_state.steps) == 1
      assert hd(new_state.steps).name == "thinking"
      assert hd(new_state.steps).status == :finished
    end
  end

  describe "apply_all/2" do
    test "applies multiple events in order" do
      state = Renderer.init()

      events = [
        %Events.RunStarted{type: :RUN_STARTED, thread_id: "t1", run_id: "r1"},
        %Events.TextMessageStart{type: :TEXT_MESSAGE_START, message_id: "m1", role: :assistant},
        %Events.TextMessageContent{type: :TEXT_MESSAGE_CONTENT, message_id: "m1", delta: "Hi"},
        %Events.TextMessageEnd{type: :TEXT_MESSAGE_END, message_id: "m1"},
        %Events.RunFinished{type: :RUN_FINISHED, thread_id: "t1", run_id: "r1"}
      ]

      new_state = Renderer.apply_all(state, events)

      assert new_state.event_count == 5
      assert new_state.run_status == :finished
      assert length(new_state.session.messages) == 1
    end
  end

  describe "running?/1" do
    test "returns true when run is active" do
      state = Renderer.init()

      event = %Events.RunStarted{type: :RUN_STARTED, thread_id: "t1", run_id: "r1"}
      state = Renderer.apply_event(state, event)

      assert Renderer.running?(state) == true
    end

    test "returns false when idle" do
      state = Renderer.init()
      assert Renderer.running?(state) == false
    end

    test "returns false when finished" do
      state = Renderer.init()

      events = [
        %Events.RunStarted{type: :RUN_STARTED, thread_id: "t1", run_id: "r1"},
        %Events.RunFinished{type: :RUN_FINISHED, thread_id: "t1", run_id: "r1"}
      ]

      state = Renderer.apply_all(state, events)

      assert Renderer.running?(state) == false
    end
  end

  describe "finished?/1" do
    test "returns true when finished" do
      state = Renderer.init()

      events = [
        %Events.RunStarted{type: :RUN_STARTED, thread_id: "t1", run_id: "r1"},
        %Events.RunFinished{type: :RUN_FINISHED, thread_id: "t1", run_id: "r1"}
      ]

      state = Renderer.apply_all(state, events)

      assert Renderer.finished?(state) == true
    end

    test "returns false when idle" do
      state = Renderer.init()
      assert Renderer.finished?(state) == false
    end
  end

  describe "error?/1 and error_message/1" do
    test "error? returns true when in error state" do
      state = Renderer.init()

      events = [
        %Events.RunStarted{type: :RUN_STARTED, thread_id: "t1", run_id: "r1"},
        %Events.RunError{type: :RUN_ERROR, message: "Failed"}
      ]

      state = Renderer.apply_all(state, events)

      assert Renderer.error?(state) == true
      assert Renderer.error_message(state) == "Failed"
    end

    test "error_message returns nil when not in error state" do
      state = Renderer.init()
      assert Renderer.error_message(state) == nil
    end
  end

  describe "streaming?/1" do
    test "returns true when there are streaming messages" do
      state = Renderer.init()

      events = [
        %Events.RunStarted{type: :RUN_STARTED, thread_id: "t1", run_id: "r1"},
        %Events.TextMessageStart{type: :TEXT_MESSAGE_START, message_id: "m1", role: :assistant}
      ]

      state = Renderer.apply_all(state, events)

      assert Renderer.streaming?(state) == true
    end

    test "returns true when there are streaming tools" do
      state = Renderer.init()

      events = [
        %Events.RunStarted{type: :RUN_STARTED, thread_id: "t1", run_id: "r1"},
        %Events.ToolCallStart{
          type: :TOOL_CALL_START,
          tool_call_id: "tc1",
          tool_call_name: "search"
        }
      ]

      state = Renderer.apply_all(state, events)

      assert Renderer.streaming?(state) == true
    end

    test "returns false when no active streams" do
      state = Renderer.init()
      assert Renderer.streaming?(state) == false
    end
  end

  describe "messages/1" do
    test "returns messages from session" do
      state = Renderer.init()

      events = [
        %Events.RunStarted{type: :RUN_STARTED, thread_id: "t1", run_id: "r1"},
        %Events.TextMessageStart{type: :TEXT_MESSAGE_START, message_id: "m1", role: :assistant},
        %Events.TextMessageContent{type: :TEXT_MESSAGE_CONTENT, message_id: "m1", delta: "Hi"},
        %Events.TextMessageEnd{type: :TEXT_MESSAGE_END, message_id: "m1"}
      ]

      state = Renderer.apply_all(state, events)
      messages = Renderer.messages(state)

      assert length(messages) == 1
      assert hd(messages).content == "Hi"
    end
  end

  describe "state/1" do
    test "returns shared state from session" do
      state = Renderer.init()

      event = %Events.StateSnapshot{
        type: :STATE_SNAPSHOT,
        snapshot: %{"counter" => 42}
      }

      state = Renderer.apply_event(state, event)

      assert Renderer.state(state) == %{"counter" => 42}
    end
  end

  describe "thinking?/1 and thinking_content/1" do
    test "returns true when thinking is active" do
      state = Renderer.init()

      events = [
        %Events.RunStarted{type: :RUN_STARTED, thread_id: "t1", run_id: "r1"},
        %Events.ThinkingStart{type: :THINKING_START},
        %Events.ThinkingTextMessageStart{type: :THINKING_TEXT_MESSAGE_START},
        %Events.ThinkingTextMessageContent{
          type: :THINKING_TEXT_MESSAGE_CONTENT,
          delta: "Let me think..."
        }
      ]

      state = Renderer.apply_all(state, events)

      assert Renderer.thinking?(state) == true
      assert Renderer.thinking_content(state) == "Let me think..."
    end

    test "returns false when not thinking" do
      state = Renderer.init()

      assert Renderer.thinking?(state) == false
      assert Renderer.thinking_content(state) == ""
    end
  end

  describe "stream_data/1" do
    test "returns data suitable for LiveView streams" do
      state = Renderer.init()

      events = [
        %Events.RunStarted{type: :RUN_STARTED, thread_id: "t1", run_id: "r1"},
        %Events.TextMessageStart{type: :TEXT_MESSAGE_START, message_id: "m1", role: :assistant},
        %Events.TextMessageContent{type: :TEXT_MESSAGE_CONTENT, message_id: "m1", delta: "Hi"}
      ]

      state = Renderer.apply_all(state, events)
      data = Renderer.stream_data(state)

      assert is_list(data.messages)
      assert is_map(data.streaming)
    end
  end

  describe "reset/1" do
    test "clears run-specific state but keeps thread_id" do
      state = Renderer.init(thread_id: "thread-123")

      events = [
        %Events.RunStarted{type: :RUN_STARTED, thread_id: "thread-123", run_id: "r1"},
        %Events.TextMessageStart{type: :TEXT_MESSAGE_START, message_id: "m1", role: :assistant},
        %Events.TextMessageContent{type: :TEXT_MESSAGE_CONTENT, message_id: "m1", delta: "Hi"},
        %Events.RunFinished{type: :RUN_FINISHED, thread_id: "thread-123", run_id: "r1"}
      ]

      state = Renderer.apply_all(state, events)
      reset_state = Renderer.reset(state)

      # Thread ID preserved
      assert reset_state.session.thread_id == "thread-123"

      # Run-specific state cleared
      assert reset_state.session.run_id == nil
      assert reset_state.run_status == :idle
      assert reset_state.streaming_messages == %{}
      assert reset_state.streaming_tools == %{}
      assert reset_state.steps == []
      assert reset_state.event_count == 0
    end
  end
end
