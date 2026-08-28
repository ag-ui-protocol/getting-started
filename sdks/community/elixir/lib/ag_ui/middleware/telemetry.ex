defmodule AgUI.Middleware.Telemetry do
  @moduledoc """
  A telemetry middleware for AG-UI agent runs.

  Emits telemetry events for run lifecycle and optionally for individual events.
  This integrates with the standard `:telemetry` library used across the Elixir ecosystem.

  ## Telemetry Events

  The following telemetry events are emitted:

  ### `[:ag_ui, :run, :start]`

  Emitted when a run starts.

  Measurements: `%{system_time: integer}`
  Metadata: `%{thread_id: string, run_id: string, input: RunAgentInput.t()}`

  ### `[:ag_ui, :run, :stop]`

  Emitted when a run completes successfully.

  Measurements: `%{duration: integer}` (in native time units)
  Metadata: `%{thread_id: string, run_id: string, event_count: integer}`

  ### `[:ag_ui, :run, :error]`

  Emitted when a run fails.

  Measurements: `%{duration: integer}` (in native time units)
  Metadata: `%{thread_id: string, run_id: string, message: string, event_count: integer}`

  ### `[:ag_ui, :event, :received]` (optional)

  Emitted for each event when `emit_events: true`.

  Measurements: `%{system_time: integer}`
  Metadata: `%{thread_id: string, run_id: string, event_type: atom, event: struct}`

  ### `[:ag_ui, :stream, :start]`

  Emitted when the event stream starts.

  Measurements: `%{system_time: integer}`
  Metadata: `%{thread_id: string, run_id: string}`

  ### `[:ag_ui, :stream, :stop]`

  Emitted when the event stream stops (normal completion).

  Measurements: `%{duration: integer}` (in native time units)
  Metadata: `%{thread_id: string, run_id: string, event_count: integer}`

  ### `[:ag_ui, :stream, :error]`

  Emitted when a `RUN_ERROR` event is observed.

  Measurements: `%{duration: integer}` (in native time units)
  Metadata: `%{thread_id: string, run_id: string, message: string, event_count: integer}`

  ## Options

  - `:emit_events` - Whether to emit telemetry for individual events (default: `false`)
  - `:prefix` - Custom prefix for telemetry event names (default: `[:ag_ui]`)

  ## Example

      # Attach a handler
      :telemetry.attach_many(
        "my-handler",
        [
          [:ag_ui, :run, :start],
          [:ag_ui, :run, :stop],
          [:ag_ui, :run, :error]
        ],
        &MyHandler.handle_event/4,
        nil
      )

      # Use the middleware
      middlewares = [AgUI.Middleware.Telemetry]
      runner = AgUI.Middleware.chain(middlewares, final_runner)

  """

  @behaviour AgUI.Middleware

  @default_opts [
    emit_events: false,
    prefix: [:ag_ui]
  ]

  @doc """
  Configure the telemetry middleware options.
  """
  @spec configure(keyword()) :: :ok
  def configure(opts) do
    Application.put_env(:ag_ui, __MODULE__, opts)
    :ok
  end

  @doc """
  Get the current configuration options.
  """
  @spec get_config() :: keyword()
  def get_config do
    Application.get_env(:ag_ui, __MODULE__, @default_opts)
    |> Keyword.merge(@default_opts, fn _k, v1, _v2 -> v1 end)
  end

  @impl true
  def call(input, next) do
    opts = get_config()
    emit_events? = Keyword.get(opts, :emit_events, false)
    prefix = Keyword.get(opts, :prefix, [:ag_ui])

    start_time = System.monotonic_time()
    system_time = System.system_time()

    metadata = %{
      thread_id: input.thread_id,
      run_id: input.run_id,
      input: input
    }

    # Emit start event
    execute_telemetry(prefix ++ [:run, :start], %{system_time: system_time}, metadata)

    stream = next.(input)

    stream
    |> Stream.transform(
      fn ->
        execute_telemetry(
          prefix ++ [:stream, :start],
          %{system_time: System.system_time()},
          %{thread_id: input.thread_id, run_id: input.run_id}
        )

        0
      end,
      fn event, count ->
        # Optionally emit per-event telemetry
        if emit_events? do
          event_metadata = %{
            thread_id: input.thread_id,
            run_id: input.run_id,
            event_type: event.type,
            event: event
          }

          execute_telemetry(
            prefix ++ [:event, :received],
            %{system_time: System.system_time()},
            event_metadata
          )
        end

        case event do
          %AgUI.Events.RunFinished{} ->
            duration = System.monotonic_time() - start_time

            stop_metadata = %{
              thread_id: input.thread_id,
              run_id: input.run_id,
              event_count: count + 1
            }

            execute_telemetry(prefix ++ [:run, :stop], %{duration: duration}, stop_metadata)
            {[event], count + 1}

          %AgUI.Events.RunError{message: msg} ->
            duration = System.monotonic_time() - start_time

            error_metadata = %{
              thread_id: input.thread_id,
              run_id: input.run_id,
              message: msg,
              event_count: count + 1
            }

            execute_telemetry(prefix ++ [:run, :error], %{duration: duration}, error_metadata)
            execute_telemetry(prefix ++ [:stream, :error], %{duration: duration}, error_metadata)
            {[event], count + 1}

          _ ->
            {[event], count + 1}
        end
      end,
      fn count ->
        duration = System.monotonic_time() - start_time

        execute_telemetry(
          prefix ++ [:stream, :stop],
          %{duration: duration},
          %{thread_id: input.thread_id, run_id: input.run_id, event_count: count}
        )

        {[], count}
      end,
      fn _ -> :ok end
    )
  end

  # Helper to safely execute telemetry (handles case when :telemetry is not available)
  defp execute_telemetry(event_name, measurements, metadata) do
    if Code.ensure_loaded?(:telemetry) do
      :telemetry.execute(event_name, measurements, metadata)
    end
  rescue
    # If telemetry is not available or fails, silently ignore
    _ -> :ok
  end
end
