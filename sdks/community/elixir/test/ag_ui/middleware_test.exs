defmodule AgUI.MiddlewareTest do
  use ExUnit.Case, async: true

  alias AgUI.Middleware
  alias AgUI.Types.RunAgentInput
  alias AgUI.Events

  # Test middleware that logs calls
  defmodule TrackingMiddleware do
    @behaviour AgUI.Middleware

    @impl true
    def call(input, next) do
      # Send message to test process
      send(self(), {:middleware_called, input.run_id})
      next.(input)
    end
  end

  # Test middleware that modifies input
  defmodule InputModifyingMiddleware do
    @behaviour AgUI.Middleware

    @impl true
    def call(input, next) do
      modified = %{input | state: Map.put(input.state, "modified", true)}
      next.(modified)
    end
  end

  # Test middleware that transforms events
  defmodule EventTransformingMiddleware do
    @behaviour AgUI.Middleware

    @impl true
    def call(input, next) do
      next.(input)
      |> Stream.map(fn
        %Events.TextMessageContent{} = event ->
          %{event | delta: String.upcase(event.delta)}

        event ->
          event
      end)
    end
  end

  # Test middleware that filters events
  defmodule FilteringMiddleware do
    @behaviour AgUI.Middleware

    @impl true
    def call(input, next) do
      next.(input)
      |> Stream.reject(fn event ->
        event.type == :thinking_start or event.type == :thinking_end
      end)
    end
  end

  # Test middleware that adds events
  defmodule EventAddingMiddleware do
    @behaviour AgUI.Middleware

    @impl true
    def call(input, next) do
      prefix = [%Events.Custom{type: :custom, name: "prefix", value: %{}}]
      suffix = [%Events.Custom{type: :custom, name: "suffix", value: %{}}]

      Stream.concat([prefix, next.(input), suffix])
    end
  end

  describe "chain/2" do
    test "returns final runner when no middlewares" do
      events = [
        %Events.RunStarted{type: :run_started, thread_id: "t1", run_id: "r1"},
        %Events.RunFinished{type: :run_finished, thread_id: "t1", run_id: "r1"}
      ]

      final = fn _input -> events end

      runner = Middleware.chain([], final)
      input = %RunAgentInput{thread_id: "t1", run_id: "r1"}

      assert runner.(input) == events
    end

    test "chains single middleware" do
      events = [
        %Events.RunStarted{type: :run_started, thread_id: "t1", run_id: "r1"}
      ]

      final = fn _input -> events end
      runner = Middleware.chain([TrackingMiddleware], final)

      input = %RunAgentInput{thread_id: "t1", run_id: "test-run"}
      result = runner.(input) |> Enum.to_list()

      assert result == events
      assert_received {:middleware_called, "test-run"}
    end

    test "chains multiple middlewares in insertion order" do
      m1 =
        Middleware.from_function(fn input, next ->
          send(self(), {:m1, :before})
          result = next.(input)
          send(self(), {:m1, :after})
          result
        end)

      m2 =
        Middleware.from_function(fn input, next ->
          send(self(), {:m2, :before})
          result = next.(input)
          send(self(), {:m2, :after})
          result
        end)

      final = fn _input ->
        send(self(), :final)
        []
      end

      runner = Middleware.chain([m1, m2], final)
      input = %RunAgentInput{thread_id: "t1", run_id: "r1"}

      runner.(input) |> Enum.to_list()

      # First middleware wraps second, which wraps final
      assert_received {:m1, :before}
      assert_received {:m2, :before}
      assert_received :final
      assert_received {:m2, :after}
      assert_received {:m1, :after}
    end

    test "middleware can modify input" do
      final = fn input ->
        send(self(), {:input_state, input.state})
        []
      end

      runner = Middleware.chain([InputModifyingMiddleware], final)
      input = %RunAgentInput{thread_id: "t1", run_id: "r1", state: %{"original" => true}}

      runner.(input) |> Enum.to_list()

      assert_received {:input_state, state}
      assert state["original"] == true
      assert state["modified"] == true
    end

    test "middleware can transform events" do
      events = [
        %Events.TextMessageContent{
          type: :text_message_content,
          message_id: "m1",
          delta: "hello"
        }
      ]

      final = fn _input -> events end
      runner = Middleware.chain([EventTransformingMiddleware], final)
      input = %RunAgentInput{thread_id: "t1", run_id: "r1"}

      result = runner.(input) |> Enum.to_list()

      assert [%Events.TextMessageContent{delta: "HELLO"}] = result
    end

    test "middleware can filter events" do
      events = [
        %Events.ThinkingStart{type: :thinking_start},
        %Events.TextMessageContent{type: :text_message_content, message_id: "m1", delta: "hi"},
        %Events.ThinkingEnd{type: :thinking_end}
      ]

      final = fn _input -> events end
      runner = Middleware.chain([FilteringMiddleware], final)
      input = %RunAgentInput{thread_id: "t1", run_id: "r1"}

      result = runner.(input) |> Enum.to_list()

      assert length(result) == 1
      assert [%Events.TextMessageContent{}] = result
    end

    test "middleware can add events" do
      events = [
        %Events.RunStarted{type: :run_started, thread_id: "t1", run_id: "r1"}
      ]

      final = fn _input -> events end
      runner = Middleware.chain([EventAddingMiddleware], final)
      input = %RunAgentInput{thread_id: "t1", run_id: "r1"}

      result = runner.(input) |> Enum.to_list()

      assert length(result) == 3

      assert [
               %Events.Custom{name: "prefix"},
               %Events.RunStarted{},
               %Events.Custom{name: "suffix"}
             ] = result
    end
  end

  describe "from_function/1" do
    test "creates middleware from function" do
      middleware =
        Middleware.from_function(fn input, next ->
          send(self(), {:called_with, input.run_id})
          next.(input)
        end)

      final = fn _input -> [] end
      runner = Middleware.chain([middleware], final)
      input = %RunAgentInput{thread_id: "t1", run_id: "func-test"}

      runner.(input) |> Enum.to_list()

      assert_received {:called_with, "func-test"}
    end

    test "function middleware can transform stream" do
      middleware =
        Middleware.from_function(fn _input, next ->
          next.(%RunAgentInput{thread_id: "t1", run_id: "r1"})
          |> Stream.take(1)
        end)

      events = [
        %Events.RunStarted{type: :run_started, thread_id: "t1", run_id: "r1"},
        %Events.RunFinished{type: :run_finished, thread_id: "t1", run_id: "r1"}
      ]

      final = fn _input -> events end
      runner = Middleware.chain([middleware], final)
      input = %RunAgentInput{thread_id: "t1", run_id: "r1"}

      result = runner.(input) |> Enum.to_list()

      assert length(result) == 1
    end
  end

  describe "apply/2" do
    test "applies single middleware to runner" do
      events = [%Events.RunStarted{type: :run_started, thread_id: "t1", run_id: "r1"}]
      final = fn _input -> events end

      runner = Middleware.apply(TrackingMiddleware, final)
      input = %RunAgentInput{thread_id: "t1", run_id: "apply-test"}

      result = runner.(input) |> Enum.to_list()

      assert result == events
      assert_received {:middleware_called, "apply-test"}
    end
  end

  describe "with_error_handling/1" do
    test "passes through events on success" do
      events = [
        %Events.RunStarted{type: :run_started, thread_id: "t1", run_id: "r1"},
        %Events.RunFinished{type: :run_finished, thread_id: "t1", run_id: "r1"}
      ]

      runner = fn _input -> events end
      safe_runner = Middleware.with_error_handling(runner)

      input = %RunAgentInput{thread_id: "t1", run_id: "r1"}
      result = safe_runner.(input) |> Enum.to_list()

      assert result == events
    end

    test "catches exceptions and emits RUN_ERROR" do
      runner = fn _input -> raise "Something went wrong" end
      safe_runner = Middleware.with_error_handling(runner)

      input = %RunAgentInput{thread_id: "t1", run_id: "r1"}
      result = safe_runner.(input) |> Enum.to_list()

      assert length(result) == 1
      assert [%Events.RunError{message: message}] = result
      assert message =~ "Something went wrong"
    end

    test "catches exits and emits RUN_ERROR" do
      runner = fn _input -> exit(:shutdown) end
      safe_runner = Middleware.with_error_handling(runner)

      input = %RunAgentInput{thread_id: "t1", run_id: "r1"}
      result = safe_runner.(input) |> Enum.to_list()

      assert length(result) == 1
      assert [%Events.RunError{message: message}] = result
      assert message =~ "Process exited"
    end

    test "catches throws and emits RUN_ERROR" do
      runner = fn _input -> throw(:oops) end
      safe_runner = Middleware.with_error_handling(runner)

      input = %RunAgentInput{thread_id: "t1", run_id: "r1"}
      result = safe_runner.(input) |> Enum.to_list()

      assert length(result) == 1
      assert [%Events.RunError{message: message}] = result
      assert message =~ "Uncaught throw"
    end
  end

  describe "middleware composition" do
    test "multiple middlewares compose correctly" do
      # Middleware 1: Track call
      # Middleware 2: Transform text to uppercase
      # Middleware 3: Add prefix event

      events = [
        %Events.TextMessageContent{type: :text_message_content, message_id: "m1", delta: "hello"}
      ]

      final = fn _input -> events end

      runner =
        Middleware.chain(
          [
            TrackingMiddleware,
            EventTransformingMiddleware,
            EventAddingMiddleware
          ],
          final
        )

      input = %RunAgentInput{thread_id: "t1", run_id: "compose-test"}
      result = runner.(input) |> Enum.to_list()

      # EventAddingMiddleware adds prefix and suffix
      # EventTransformingMiddleware uppercases text content
      assert length(result) == 3

      assert [
               %Events.Custom{name: "prefix"},
               %Events.TextMessageContent{delta: "HELLO"},
               %Events.Custom{name: "suffix"}
             ] = result

      assert_received {:middleware_called, "compose-test"}
    end
  end
end
