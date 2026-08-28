defmodule AgUI.LiveView.Helpers do
  @moduledoc """
  Helper functions and macros for integrating AG-UI with Phoenix LiveView.

  This module provides convenience functions for common LiveView integration
  patterns. It works with both Phoenix.LiveView and plain GenServer processes.

  ## Usage in LiveView

      defmodule MyAppWeb.ChatLive do
        use MyAppWeb, :live_view
        import AgUI.LiveView.Helpers

        def mount(_params, _session, socket) do
          {:ok, init_agui(socket)}
        end

        def handle_info(msg, socket) do
          case handle_agui_message(msg, socket) do
            {:ok, socket} -> {:noreply, socket}
            :not_agui -> handle_other_message(msg, socket)
          end
        end
      end

  """

  alias AgUI.LiveView.Renderer
  alias AgUI.LiveView.Runner
  alias AgUI.Client.HttpAgent

  @doc """
  Initializes AG-UI state in a socket.

  Adds the following assigns:
  - `:agui` - The UI state from `AgUI.LiveView.Renderer`
  - `:agui_runner` - The runner PID (nil when not running)

  ## Options

  - `:thread_id` - Optional thread ID to initialize with
  - `:assign_key` - Key to use for UI state (default: `:agui`)
  - `:runner_key` - Key to use for runner PID (default: `:agui_runner`)

  ## Examples

      socket = init_agui(socket)
      socket = init_agui(socket, thread_id: "thread-123")

  """
  @spec init_agui(map(), keyword()) :: map()
  def init_agui(socket, opts \\ []) do
    assign_key = Keyword.get(opts, :assign_key, :agui)
    runner_key = Keyword.get(opts, :runner_key, :agui_runner)

    renderer_opts = Keyword.take(opts, [:thread_id, :run_id])

    socket
    |> put_assign(assign_key, Renderer.init(renderer_opts))
    |> put_assign(runner_key, nil)
  end

  @doc """
  Starts an agent run.

  ## Options

  - `:agent` - (required) `HttpAgent` struct or URL string
  - `:input` - (required) `RunAgentInput` struct
  - `:tag` - Tag for messages (default: `:agui`)
  - `:assign_key` - Key for UI state (default: `:agui`)
  - `:runner_key` - Key for runner PID (default: `:agui_runner`)
  - `:normalize` - Whether to normalize chunks (default: `true`)
  - `:reset` - Whether to reset UI state before starting (default: `true`)

  ## Examples

      socket = start_agui_run(socket,
        agent: HttpAgent.new(url: "http://localhost:4000/api/agent"),
        input: %RunAgentInput{thread_id: "t1", run_id: "r1"}
      )

  """
  @spec start_agui_run(map(), keyword()) :: map()
  def start_agui_run(socket, opts) do
    agent = get_agent(Keyword.fetch!(opts, :agent))
    input = Keyword.fetch!(opts, :input)
    tag = Keyword.get(opts, :tag, :agui)
    assign_key = Keyword.get(opts, :assign_key, :agui)
    runner_key = Keyword.get(opts, :runner_key, :agui_runner)
    normalize? = Keyword.get(opts, :normalize, true)
    reset? = Keyword.get(opts, :reset, true)

    # Reset UI state if requested
    socket =
      if reset? do
        ui_state = get_assign(socket, assign_key)
        put_assign(socket, assign_key, Renderer.reset(ui_state))
      else
        socket
      end

    # Start the runner
    {:ok, runner} =
      Runner.start_link(
        liveview: self(),
        agent: agent,
        input: input,
        tag: tag,
        normalize: normalize?
      )

    put_assign(socket, runner_key, runner)
  end

  @doc """
  Aborts the current agent run.

  ## Options

  - `:runner_key` - Key for runner PID (default: `:agui_runner`)

  """
  @spec abort_agui_run(map(), keyword()) :: map()
  def abort_agui_run(socket, opts \\ []) do
    runner_key = Keyword.get(opts, :runner_key, :agui_runner)
    runner = get_assign(socket, runner_key)

    if runner do
      Runner.abort(runner)
    end

    put_assign(socket, runner_key, nil)
  end

  @doc """
  Handles an AG-UI message in a LiveView.

  Returns `{:ok, socket}` if the message was handled, `:not_agui` otherwise.

  ## Options

  - `:tag` - Expected message tag (default: `:agui`)
  - `:assign_key` - Key for UI state (default: `:agui`)
  - `:runner_key` - Key for runner PID (default: `:agui_runner`)
  - `:on_error` - Function to call on error: `fn socket, reason -> socket end`
  - `:on_done` - Function to call on completion: `fn socket -> socket end`

  ## Examples

      def handle_info(msg, socket) do
        case handle_agui_message(msg, socket) do
          {:ok, socket} -> {:noreply, socket}
          :not_agui -> {:noreply, socket}
        end
      end

  """
  @spec handle_agui_message(term(), map(), keyword()) :: {:ok, map()} | :not_agui
  def handle_agui_message(msg, socket, opts \\ []) do
    tag = Keyword.get(opts, :tag, :agui)
    assign_key = Keyword.get(opts, :assign_key, :agui)
    runner_key = Keyword.get(opts, :runner_key, :agui_runner)
    on_error = Keyword.get(opts, :on_error, fn socket, _reason -> socket end)
    on_done = Keyword.get(opts, :on_done, fn socket -> socket end)

    case msg do
      {^tag, {:error, reason}} ->
        socket =
          socket
          |> put_assign(runner_key, nil)
          |> on_error.(reason)

        {:ok, socket}

      {^tag, :done} ->
        socket =
          socket
          |> put_assign(runner_key, nil)
          |> on_done.()

        {:ok, socket}

      {^tag, event} ->
        ui_state = get_assign(socket, assign_key)
        new_ui_state = Renderer.apply_event(ui_state, event)
        {:ok, put_assign(socket, assign_key, new_ui_state)}

      _ ->
        :not_agui
    end
  end

  @doc """
  Returns true if an agent run is currently active.

  ## Options

  - `:runner_key` - Key for runner PID (default: `:agui_runner`)

  """
  @spec agui_running?(map(), keyword()) :: boolean()
  def agui_running?(socket, opts \\ []) do
    runner_key = Keyword.get(opts, :runner_key, :agui_runner)
    get_assign(socket, runner_key) != nil
  end

  @doc """
  Returns the current UI state.

  ## Options

  - `:assign_key` - Key for UI state (default: `:agui`)

  """
  @spec get_agui_state(map(), keyword()) :: Renderer.t()
  def get_agui_state(socket, opts \\ []) do
    assign_key = Keyword.get(opts, :assign_key, :agui)
    get_assign(socket, assign_key)
  end

  # Private Helpers

  defp get_agent(url) when is_binary(url) do
    HttpAgent.new(url: url)
  end

  defp get_agent(%HttpAgent{} = agent), do: agent

  # Socket-agnostic assign helpers
  # These work with both Phoenix.LiveView.Socket and plain maps

  defp get_assign(%{assigns: assigns}, key) do
    Map.get(assigns, key)
  end

  defp get_assign(map, key) when is_map(map) do
    Map.get(map, key)
  end

  # Use Phoenix.Component.assign for proper LiveView change tracking when available
  if Code.ensure_loaded?(Phoenix.LiveView.Socket) and Code.ensure_loaded?(Phoenix.Component) do
    defp put_assign(%Phoenix.LiveView.Socket{} = socket, key, value) do
      Phoenix.Component.assign(socket, key, value)
    end
  end

  # For testing with mock sockets or structs with assigns field
  defp put_assign(%{__struct__: _struct, assigns: assigns} = socket, key, value) do
    %{socket | assigns: Map.put(assigns, key, value)}
  end

  defp put_assign(%{assigns: assigns} = socket, key, value) do
    %{socket | assigns: Map.put(assigns, key, value)}
  end

  defp put_assign(map, key, value) when is_map(map) do
    Map.put(map, key, value)
  end
end
