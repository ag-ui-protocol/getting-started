defmodule AgUI.Middleware.Logger do
  @moduledoc """
  A logging middleware for AG-UI agent runs.

  Logs run lifecycle events and optionally all events at debug level.

  ## Options

  - `:level` - Log level for events (default: `:debug`)
  - `:log_events` - Whether to log individual events (default: `true`)
  - `:metadata` - Additional metadata to include in log entries (default: `[]`)

  ## Example

      # Use with default options
      middlewares = [AgUI.Middleware.Logger]
      runner = AgUI.Middleware.chain(middlewares, final_runner)

      # Or configure options
      AgUI.Middleware.Logger.configure(level: :info, log_events: false)

  """

  @behaviour AgUI.Middleware

  require Logger

  @default_opts [
    level: :debug,
    log_events: true,
    metadata: []
  ]

  @doc """
  Configure the logger middleware options.

  Options are stored in the application environment.
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
    level = Keyword.get(opts, :level, :debug)
    log_events? = Keyword.get(opts, :log_events, true)
    metadata = Keyword.get(opts, :metadata, [])

    run_metadata =
      [
        thread_id: input.thread_id,
        run_id: input.run_id
      ] ++ metadata

    Logger.log(:info, "Starting agent run", run_metadata)

    start_time = System.monotonic_time()

    stream = next.(input)

    stream
    |> Stream.map(fn event ->
      if log_events? do
        event_metadata = run_metadata ++ [event_type: event.type]
        Logger.log(level, "AG-UI event: #{format_event(event)}", event_metadata)
      end

      event
    end)
    |> Stream.transform(nil, fn event, _acc ->
      case event do
        %AgUI.Events.RunFinished{} ->
          elapsed = System.monotonic_time() - start_time
          elapsed_ms = System.convert_time_unit(elapsed, :native, :millisecond)
          Logger.log(:info, "Agent run finished in #{elapsed_ms}ms", run_metadata)
          {[event], :finished}

        %AgUI.Events.RunError{message: msg} ->
          elapsed = System.monotonic_time() - start_time
          elapsed_ms = System.convert_time_unit(elapsed, :native, :millisecond)

          Logger.log(
            :error,
            "Agent run failed after #{elapsed_ms}ms: #{msg}",
            run_metadata
          )

          {[event], :error}

        _ ->
          {[event], nil}
      end
    end)
  end

  defp format_event(%{type: type} = event) do
    case type do
      :run_started -> "RUN_STARTED"
      :run_finished -> "RUN_FINISHED"
      :run_error -> "RUN_ERROR: #{event.message}"
      :text_message_start -> "TEXT_MESSAGE_START (#{event.message_id})"
      :text_message_content -> "TEXT_MESSAGE_CONTENT (#{event.message_id})"
      :text_message_end -> "TEXT_MESSAGE_END (#{event.message_id})"
      :tool_call_start -> "TOOL_CALL_START (#{event.tool_call_id}: #{event.tool_call_name})"
      :tool_call_args -> "TOOL_CALL_ARGS (#{event.tool_call_id})"
      :tool_call_end -> "TOOL_CALL_END (#{event.tool_call_id})"
      :tool_call_result -> "TOOL_CALL_RESULT (#{event.tool_call_id})"
      :state_snapshot -> "STATE_SNAPSHOT"
      :state_delta -> "STATE_DELTA (#{length(event.delta)} ops)"
      :messages_snapshot -> "MESSAGES_SNAPSHOT (#{length(event.messages)} msgs)"
      :activity_snapshot -> "ACTIVITY_SNAPSHOT (#{event.message_id}: #{event.activity_type})"
      :activity_delta -> "ACTIVITY_DELTA (#{event.message_id})"
      :step_started -> "STEP_STARTED (#{event.step_name})"
      :step_finished -> "STEP_FINISHED (#{event.step_name})"
      :thinking_start -> "THINKING_START"
      :thinking_end -> "THINKING_END"
      :thinking_text_message_start -> "THINKING_TEXT_MESSAGE_START"
      :thinking_text_message_content -> "THINKING_TEXT_MESSAGE_CONTENT"
      :thinking_text_message_end -> "THINKING_TEXT_MESSAGE_END"
      :raw -> "RAW"
      :custom -> "CUSTOM (#{event.name})"
      other -> "UNKNOWN (#{other})"
    end
  end
end
