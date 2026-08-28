defmodule AgUI.Middleware.LoggerTest do
  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  alias AgUI.Middleware
  alias AgUI.Middleware.Logger, as: LoggerMiddleware
  alias AgUI.Types.RunAgentInput
  alias AgUI.Events

  setup do
    # Reset config before each test
    LoggerMiddleware.configure([])
    :ok
  end

  describe "configure/1" do
    test "sets configuration options" do
      LoggerMiddleware.configure(level: :info, log_events: false)

      config = LoggerMiddleware.get_config()
      assert config[:level] == :info
      assert config[:log_events] == false
    end
  end

  describe "get_config/0" do
    test "returns default config when not configured" do
      config = LoggerMiddleware.get_config()

      assert config[:level] == :debug
      assert config[:log_events] == true
      assert config[:metadata] == []
    end

    test "merges with defaults" do
      LoggerMiddleware.configure(level: :warn)

      config = LoggerMiddleware.get_config()
      assert config[:level] == :warn
      assert config[:log_events] == true
    end
  end

  describe "call/2" do
    test "logs run start" do
      events = [
        %Events.RunStarted{type: :run_started, thread_id: "t1", run_id: "r1"},
        %Events.RunFinished{type: :run_finished, thread_id: "t1", run_id: "r1"}
      ]

      final = fn _input -> events end
      runner = Middleware.chain([LoggerMiddleware], final)
      input = %RunAgentInput{thread_id: "t1", run_id: "r1"}

      log =
        capture_log(fn ->
          runner.(input) |> Enum.to_list()
        end)

      assert log =~ "Starting agent run"
    end

    test "logs run finished with duration" do
      events = [
        %Events.RunStarted{type: :run_started, thread_id: "t1", run_id: "r1"},
        %Events.RunFinished{type: :run_finished, thread_id: "t1", run_id: "r1"}
      ]

      final = fn _input -> events end
      runner = Middleware.chain([LoggerMiddleware], final)
      input = %RunAgentInput{thread_id: "t1", run_id: "r1"}

      log =
        capture_log(fn ->
          runner.(input) |> Enum.to_list()
        end)

      assert log =~ "Agent run finished"
      assert log =~ "ms"
    end

    test "logs run error" do
      events = [
        %Events.RunStarted{type: :run_started, thread_id: "t1", run_id: "r1"},
        %Events.RunError{type: :run_error, message: "Something failed"}
      ]

      final = fn _input -> events end
      runner = Middleware.chain([LoggerMiddleware], final)
      input = %RunAgentInput{thread_id: "t1", run_id: "r1"}

      log =
        capture_log(fn ->
          runner.(input) |> Enum.to_list()
        end)

      assert log =~ "Agent run failed"
      assert log =~ "Something failed"
    end

    test "logs individual events when log_events is true" do
      LoggerMiddleware.configure(log_events: true)

      events = [
        %Events.RunStarted{type: :run_started, thread_id: "t1", run_id: "r1"},
        %Events.TextMessageStart{type: :text_message_start, message_id: "m1", role: "assistant"},
        %Events.RunFinished{type: :run_finished, thread_id: "t1", run_id: "r1"}
      ]

      final = fn _input -> events end
      runner = Middleware.chain([LoggerMiddleware], final)
      input = %RunAgentInput{thread_id: "t1", run_id: "r1"}

      log =
        capture_log(fn ->
          runner.(input) |> Enum.to_list()
        end)

      assert log =~ "RUN_STARTED"
      assert log =~ "TEXT_MESSAGE_START"
      assert log =~ "RUN_FINISHED"
    end

    test "does not log individual events when log_events is false" do
      LoggerMiddleware.configure(log_events: false)

      events = [
        %Events.RunStarted{type: :run_started, thread_id: "t1", run_id: "r1"},
        %Events.TextMessageContent{type: :text_message_content, message_id: "m1", delta: "hi"},
        %Events.RunFinished{type: :run_finished, thread_id: "t1", run_id: "r1"}
      ]

      final = fn _input -> events end
      runner = Middleware.chain([LoggerMiddleware], final)
      input = %RunAgentInput{thread_id: "t1", run_id: "r1"}

      log =
        capture_log(fn ->
          runner.(input) |> Enum.to_list()
        end)

      # Should log start/finish but not individual events
      assert log =~ "Starting agent run"
      assert log =~ "Agent run finished"
      refute log =~ "TEXT_MESSAGE_CONTENT"
    end

    test "passes through all events unchanged" do
      events = [
        %Events.RunStarted{type: :run_started, thread_id: "t1", run_id: "r1"},
        %Events.TextMessageContent{type: :text_message_content, message_id: "m1", delta: "hello"},
        %Events.RunFinished{type: :run_finished, thread_id: "t1", run_id: "r1"}
      ]

      final = fn _input -> events end
      runner = Middleware.chain([LoggerMiddleware], final)
      input = %RunAgentInput{thread_id: "t1", run_id: "r1"}

      result =
        capture_log(fn ->
          runner.(input) |> Enum.to_list()
        end)
        |> then(fn _ ->
          runner.(input) |> Enum.to_list()
        end)

      assert result == events
    end
  end
end
