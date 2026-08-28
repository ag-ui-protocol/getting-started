defmodule AgUI.LiveViewTest do
  use ExUnit.Case, async: true

  alias AgUI.LiveView
  alias AgUI.Events

  describe "available?/0" do
    test "returns boolean" do
      result = LiveView.available?()
      assert is_boolean(result)
    end
  end

  describe "html_available?/0" do
    test "returns boolean" do
      result = LiveView.html_available?()
      assert is_boolean(result)
    end
  end

  describe "delegated functions" do
    test "init/1 creates UI state" do
      state = LiveView.init()
      assert %AgUI.LiveView.Renderer{} = state
    end

    test "init/1 accepts options" do
      state = LiveView.init(thread_id: "t1")
      assert state.session.thread_id == "t1"
    end

    test "apply/2 updates state" do
      state = LiveView.init()
      event = %Events.RunStarted{type: :RUN_STARTED, thread_id: "t1", run_id: "r1"}

      new_state = LiveView.apply_event(state, event)

      assert new_state.run_status == :running
    end

    test "apply_all/2 applies multiple events" do
      state = LiveView.init()

      events = [
        %Events.RunStarted{type: :RUN_STARTED, thread_id: "t1", run_id: "r1"},
        %Events.RunFinished{type: :RUN_FINISHED, thread_id: "t1", run_id: "r1"}
      ]

      new_state = LiveView.apply_all(state, events)

      assert new_state.run_status == :finished
      assert new_state.event_count == 2
    end

    test "running?/1 checks run status" do
      idle_state = LiveView.init()
      assert LiveView.running?(idle_state) == false

      running_state =
        LiveView.apply_event(idle_state, %Events.RunStarted{
          type: :RUN_STARTED,
          thread_id: "t1",
          run_id: "r1"
        })

      assert LiveView.running?(running_state) == true
    end

    test "finished?/1 checks finished status" do
      state = LiveView.init()
      assert LiveView.finished?(state) == false

      state =
        LiveView.apply_all(state, [
          %Events.RunStarted{type: :RUN_STARTED, thread_id: "t1", run_id: "r1"},
          %Events.RunFinished{type: :RUN_FINISHED, thread_id: "t1", run_id: "r1"}
        ])

      assert LiveView.finished?(state) == true
    end

    test "error?/1 checks error status" do
      state = LiveView.init()
      assert LiveView.error?(state) == false

      state =
        LiveView.apply_all(state, [
          %Events.RunStarted{type: :RUN_STARTED, thread_id: "t1", run_id: "r1"},
          %Events.RunError{type: :RUN_ERROR, message: "Failed"}
        ])

      assert LiveView.error?(state) == true
    end

    test "messages/1 returns session messages" do
      state = LiveView.init()
      assert LiveView.messages(state) == []

      state =
        LiveView.apply_all(state, [
          %Events.RunStarted{type: :RUN_STARTED, thread_id: "t1", run_id: "r1"},
          %Events.TextMessageStart{type: :TEXT_MESSAGE_START, message_id: "m1", role: :assistant},
          %Events.TextMessageContent{type: :TEXT_MESSAGE_CONTENT, message_id: "m1", delta: "Hi"},
          %Events.TextMessageEnd{type: :TEXT_MESSAGE_END, message_id: "m1"}
        ])

      messages = LiveView.messages(state)
      assert length(messages) == 1
    end

    test "state/1 returns shared state" do
      state = LiveView.init()
      assert LiveView.state(state) == %{}

      state =
        LiveView.apply_event(state, %Events.StateSnapshot{
          type: :STATE_SNAPSHOT,
          snapshot: %{"key" => "value"}
        })

      assert LiveView.state(state) == %{"key" => "value"}
    end

    test "reset/1 clears run state" do
      state = LiveView.init(thread_id: "t1")

      state =
        LiveView.apply_all(state, [
          %Events.RunStarted{type: :RUN_STARTED, thread_id: "t1", run_id: "r1"},
          %Events.TextMessageStart{type: :TEXT_MESSAGE_START, message_id: "m1", role: :assistant},
          %Events.TextMessageContent{type: :TEXT_MESSAGE_CONTENT, message_id: "m1", delta: "Hi"}
        ])

      reset_state = LiveView.reset(state)

      assert reset_state.session.thread_id == "t1"
      assert reset_state.session.run_id == nil
      assert reset_state.run_status == :idle
      assert reset_state.streaming_messages == %{}
    end
  end
end
