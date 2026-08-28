defmodule AgUI.LiveView.Runner do
  @moduledoc """
  GenServer that streams AG-UI events to a LiveView process.

  The Runner manages the connection to an agent endpoint and sends
  events to a LiveView process for rendering. It handles:

  - Starting and managing HTTP streams
  - Normalizing chunk events into canonical events
  - Monitoring the LiveView process for cleanup
  - Graceful cancellation and error handling

  ## Usage

      # In your LiveView mount/3
      def mount(_params, _session, socket) do
        {:ok, assign(socket, :runner, nil, :agui, Renderer.init())}
      end

      # Start a run
      def handle_event("start_run", _params, socket) do
        agent = HttpAgent.new(url: "http://localhost:4000/api/agent")
        input = %RunAgentInput{
          thread_id: "thread-1",
          run_id: UUID.uuid4(),
          messages: [],
          tools: []
        }

        {:ok, runner} = Runner.start_link(
          liveview: self(),
          agent: agent,
          input: input,
          tag: :agui
        )

        {:noreply, assign(socket, :runner, runner)}
      end

      # Handle events from the runner
      def handle_info({:agui, event}, socket) do
        ui_state = Renderer.apply(socket.assigns.agui, event)
        {:noreply, assign(socket, :agui, ui_state)}
      end

      def handle_info({:agui, {:error, reason}}, socket) do
        {:noreply, put_flash(socket, :error, "Agent error: \#{inspect(reason)}")}
      end

      def handle_info({:agui, :done}, socket) do
        {:noreply, assign(socket, :runner, nil)}
      end

      # Abort a run
      def handle_event("abort", _params, socket) do
        if socket.assigns.runner do
          Runner.abort(socket.assigns.runner)
        end
        {:noreply, assign(socket, :runner, nil)}
      end

  """

  use GenServer

  alias AgUI.Client.HttpAgent
  alias AgUI.Types.RunAgentInput

  @typedoc """
  Runner state.
  """
  @type t :: %__MODULE__{
          lv_pid: pid(),
          lv_ref: reference(),
          agent: HttpAgent.t(),
          input: RunAgentInput.t(),
          tag: atom(),
          task: Task.t() | nil,
          normalize?: boolean()
        }

  defstruct [:lv_pid, :lv_ref, :agent, :input, :tag, :task, normalize?: true]

  @doc """
  Starts a runner process linked to the current process.

  ## Options

  - `:liveview` - (required) PID of the LiveView process to send events to
  - `:agent` - (required) `HttpAgent` struct configured with the agent URL
  - `:input` - (required) `RunAgentInput` struct with the run parameters
  - `:tag` - (optional) Atom to tag messages with (default: `:agui`)
  - `:normalize` - (optional) Whether to normalize chunk events (default: `true`)

  ## Returns

  `{:ok, pid}` on success, `{:error, reason}` on failure.

  ## Messages Sent to LiveView

  The runner sends messages to the LiveView process in the format:
  - `{tag, event}` - For each AG-UI event
  - `{tag, {:error, reason}}` - On stream error
  - `{tag, :done}` - When the stream completes

  """
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts)
  end

  @doc """
  Aborts a running agent stream.

  This will terminate the HTTP connection and stop the runner process.
  """
  @spec abort(GenServer.server()) :: :ok
  def abort(runner) do
    GenServer.call(runner, :abort)
  end

  @doc """
  Returns true if the runner is currently streaming events.
  """
  @spec streaming?(GenServer.server()) :: boolean()
  def streaming?(runner) do
    GenServer.call(runner, :streaming?)
  end

  # GenServer Callbacks

  @impl true
  def init(opts) do
    lv_pid = Keyword.fetch!(opts, :liveview)
    agent = Keyword.fetch!(opts, :agent)
    input = Keyword.fetch!(opts, :input)
    tag = Keyword.get(opts, :tag, :agui)
    normalize? = Keyword.get(opts, :normalize, true)

    # Monitor LiveView - stop if it dies
    lv_ref = Process.monitor(lv_pid)

    state = %__MODULE__{
      lv_pid: lv_pid,
      lv_ref: lv_ref,
      agent: agent,
      input: input,
      tag: tag,
      normalize?: normalize?
    }

    # Start streaming immediately
    send(self(), :start_stream)

    {:ok, state}
  end

  @impl true
  def handle_info(:start_stream, state) do
    # Process stream in a task - the HTTP request must happen inside
    # the task because Req uses async messages to the calling process
    task =
      Task.async(fn ->
        stream_and_send(state.agent, state.input, state.lv_pid, state.tag, state.normalize?)
      end)

    {:noreply, %{state | task: task}}
  end

  @impl true
  def handle_info({:DOWN, ref, :process, _pid, _reason}, %{lv_ref: ref} = state) do
    # LiveView died - cleanup
    if state.task do
      Task.shutdown(state.task, :brutal_kill)
    end

    {:stop, :normal, state}
  end

  @impl true
  def handle_info({ref, :ok}, %{task: %Task{ref: ref}} = state) do
    # Task completed successfully
    Process.demonitor(ref, [:flush])
    send(state.lv_pid, {state.tag, :done})
    {:stop, :normal, state}
  end

  @impl true
  def handle_info({ref, {:error, reason}}, %{task: %Task{ref: ref}} = state) do
    # Task completed with error
    Process.demonitor(ref, [:flush])
    send(state.lv_pid, {state.tag, {:error, reason}})
    {:stop, :normal, state}
  end

  @impl true
  def handle_info({:DOWN, ref, :process, _pid, reason}, %{task: %Task{ref: ref}} = state) do
    # Task crashed
    send(state.lv_pid, {state.tag, {:error, {:task_crashed, reason}}})
    {:stop, :normal, state}
  end

  @impl true
  def handle_call(:abort, _from, state) do
    if state.task do
      Task.shutdown(state.task, :brutal_kill)
    end

    send(state.lv_pid, {state.tag, :done})
    {:stop, :normal, :ok, state}
  end

  @impl true
  def handle_call(:streaming?, _from, state) do
    {:reply, state.task != nil, state}
  end

  # Private Functions

  defp stream_and_send(agent, input, lv_pid, tag, normalize?) do
    stream_result =
      if normalize? do
        HttpAgent.stream_canonical(agent, input, on_error: :run_error)
      else
        HttpAgent.stream(agent, input)
      end

    case stream_result do
      {:ok, stream} ->
        consume_stream(stream, lv_pid, tag)

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp consume_stream(stream, lv_pid, tag) do
    try do
      Enum.each(stream, fn event ->
        send(lv_pid, {tag, event})
      end)

      :ok
    rescue
      e ->
        {:error, Exception.message(e)}
    catch
      :exit, reason ->
        {:error, {:exit, reason}}
    end
  end
end
