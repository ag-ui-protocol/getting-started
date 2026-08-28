defmodule AgUI.Middleware do
  @moduledoc """
  Middleware for intercepting/transforming agent runs.

  Middleware allows you to wrap the agent execution pipeline to add
  cross-cutting concerns like logging, telemetry, authentication,
  rate limiting, caching, etc.

  ## Behavior

  Middleware follows the "wrap-next" pattern where each middleware:
  1. Receives the input and a `next` function
  2. Can modify the input before calling `next`
  3. Can transform, filter, or augment the resulting event stream
  4. Must return an enumerable of events

  ## Example

      defmodule MyApp.LoggingMiddleware do
        @behaviour AgUI.Middleware
        require Logger

        @impl true
        def call(input, next) do
          Logger.info("Starting run: \#{input.run_id}")
          start_time = System.monotonic_time()

          next.(input)
          |> Stream.each(fn event ->
            Logger.debug("Event: \#{inspect(event.type)}")
          end)
          |> Stream.concat(Stream.resource(
            fn -> nil end,
            fn nil ->
              elapsed = System.monotonic_time() - start_time
              Logger.info("Run completed in \#{System.convert_time_unit(elapsed, :native, :millisecond)}ms")
              {:halt, nil}
            end,
            fn _ -> :ok end
          ))
        end
      end

  ## Chaining Middleware

  Middlewares are chained in insertion order (first middleware wraps the rest):

      middlewares = [AuthMiddleware, LoggingMiddleware, TelemetryMiddleware]
      final_runner = fn input -> HttpAgent.stream(agent, input) end

      runner = AgUI.Middleware.chain(middlewares, final_runner)
      stream = runner.(input)

  ## Filtering tool calls

      middleware = AgUI.Middleware.FilterToolCalls.new(allow: ["weather", "search"])
      runner = AgUI.Middleware.chain([middleware], final_runner)
      runner.(input) |> Enum.to_list()

  """

  alias AgUI.Types.RunAgentInput

  @typedoc """
  The next function in the middleware chain.
  Takes a RunAgentInput and returns an enumerable of events.
  """
  @type next :: (RunAgentInput.t() -> Enumerable.t())

  @typedoc """
  A middleware can be either a module implementing the behaviour,
  or a function wrapper created by `from_function/1`.
  """
  @type middleware :: module() | %__MODULE__.Wrapper{}

  @doc """
  Called to execute the middleware.

  The middleware should:
  1. Optionally modify the input
  2. Call `next.(input)` to continue the chain
  3. Optionally transform the resulting event stream
  4. Return an enumerable of events

  ## Parameters

  - `input` - The run agent input
  - `next` - The next function in the chain

  ## Returns

  An enumerable (typically a Stream) of AG-UI events.
  """
  @callback call(input :: RunAgentInput.t(), next :: next()) :: Enumerable.t()

  # Wrapper struct for function-based middleware
  defmodule Wrapper do
    @moduledoc false
    defstruct [:fun]
  end

  @doc """
  Chains a list of middlewares around a final runner function.

  Middlewares are applied in insertion order, meaning the first middleware
  in the list will be the outermost wrapper.

  Middlewares can be either:
  - Modules implementing the `AgUI.Middleware` behaviour
  - Wrappers created by `from_function/1`

  ## Example

      middlewares = [LoggingMiddleware, TelemetryMiddleware]
      final = fn input -> HttpAgent.stream(agent, input) end

      runner = AgUI.Middleware.chain(middlewares, final)
      stream = runner.(input)

  In this example:
  1. LoggingMiddleware.call receives input and wraps TelemetryMiddleware
  2. TelemetryMiddleware.call receives input and wraps the final runner
  3. The final runner executes the actual agent call

  """
  @spec chain([middleware()], next()) :: next()
  def chain([], final), do: final

  def chain([middleware | rest], final) do
    next = chain(rest, final)

    fn input ->
      call_middleware(middleware, input, next)
    end
  end

  # Call a middleware - handles both modules and wrapper structs
  defp call_middleware(%Wrapper{fun: fun}, input, next) do
    fun.(input, next)
  end

  defp call_middleware(module, input, next) when is_atom(module) do
    module.call(input, next)
  end

  @doc """
  Creates a middleware from a function.

  This is useful for simple, one-off middleware that doesn't need
  to be defined as a separate module.

  ## Example

      logging_middleware = AgUI.Middleware.from_function(fn input, next ->
        IO.puts("Starting run: \#{input.run_id}")
        next.(input)
      end)

      runner = AgUI.Middleware.chain([logging_middleware], final)

  """
  @spec from_function((RunAgentInput.t(), next() -> Enumerable.t())) :: middleware()
  def from_function(fun) when is_function(fun, 2) do
    %Wrapper{fun: fun}
  end

  @doc """
  Applies a single middleware to a runner function.

  This is a convenience function equivalent to `chain([middleware], runner)`.

  ## Example

      runner = AgUI.Middleware.apply(LoggingMiddleware, final_runner)

  """
  @spec apply(middleware(), next()) :: next()
  def apply(middleware, runner) do
    chain([middleware], runner)
  end

  @doc """
  Wraps a runner function to catch and transform errors.

  Returns a runner that catches exceptions and emits a RUN_ERROR event
  instead of crashing.

  ## Example

      safe_runner = AgUI.Middleware.with_error_handling(runner)

  """
  @spec with_error_handling(next()) :: next()
  def with_error_handling(runner) do
    fn input ->
      try do
        runner.(input)
      rescue
        e ->
          Stream.concat([
            [
              %AgUI.Events.RunError{
                type: :run_error,
                message: Exception.message(e),
                timestamp: System.system_time(:millisecond)
              }
            ]
          ])
      catch
        :exit, reason ->
          Stream.concat([
            [
              %AgUI.Events.RunError{
                type: :run_error,
                message: "Process exited: #{inspect(reason)}",
                timestamp: System.system_time(:millisecond)
              }
            ]
          ])

        :throw, value ->
          Stream.concat([
            [
              %AgUI.Events.RunError{
                type: :run_error,
                message: "Uncaught throw: #{inspect(value)}",
                timestamp: System.system_time(:millisecond)
              }
            ]
          ])
      end
    end
  end
end
