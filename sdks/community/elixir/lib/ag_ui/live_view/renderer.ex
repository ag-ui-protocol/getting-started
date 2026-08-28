defmodule AgUI.LiveView.Renderer do
  @moduledoc """
  Transforms protocol events into LiveView-friendly UI state.

  This module is pure Elixir with no Phoenix dependencies. It provides
  a state container and reducer optimized for LiveView rendering.

  ## UI State Structure

  The UI state contains:

  - `session` - The underlying `AgUI.Session` with full protocol state
  - `streaming_messages` - Map of message_id => buffer for in-progress text
  - `streaming_tools` - Map of tool_call_id => buffer for in-progress tool calls
  - `run_status` - Current run status (:idle, :running, :finished, {:error, msg})
  - `steps` - List of step structs with status

  ## Usage

      # Initialize UI state
      ui_state = AgUI.LiveView.Renderer.init()

      # Apply events as they arrive
      ui_state = AgUI.LiveView.Renderer.apply(ui_state, event)

      # Use in LiveView assigns
      socket = assign(socket, :agui, ui_state)

  ## In LiveView Templates

      <div :for={msg <- @agui.session.messages}>
        <.message message={msg} />
      </div>

      <div :for={{id, buffer} <- @agui.streaming_messages}>
        <.streaming_text id={id} content={buffer.content} />
      </div>

  """

  alias AgUI.Session
  alias AgUI.Reducer
  alias AgUI.Events

  @typedoc """
  UI state optimized for LiveView rendering.
  """
  @type t :: %__MODULE__{
          session: Session.t(),
          streaming_messages: %{String.t() => streaming_message()},
          streaming_tools: %{String.t() => streaming_tool()},
          run_status: Session.status(),
          steps: [step()],
          last_event_type: atom() | nil,
          event_count: non_neg_integer()
        }

  @typedoc """
  A streaming text message buffer.
  """
  @type streaming_message :: %{
          content: String.t(),
          role: atom()
        }

  @typedoc """
  A streaming tool call buffer.
  """
  @type streaming_tool :: %{
          name: String.t(),
          args: String.t(),
          parent_message_id: String.t() | nil
        }

  @typedoc """
  A step in the run timeline.
  """
  @type step :: %{
          name: String.t(),
          status: :started | :finished
        }

  defstruct session: nil,
            streaming_messages: %{},
            streaming_tools: %{},
            run_status: :idle,
            steps: [],
            last_event_type: nil,
            event_count: 0

  @doc """
  Initializes a new UI state.

  ## Options

  - `:thread_id` - Optional thread ID to initialize the session with
  - `:run_id` - Optional run ID to initialize the session with

  ## Examples

      ui_state = AgUI.LiveView.Renderer.init()
      ui_state = AgUI.LiveView.Renderer.init(thread_id: "thread-123")

  """
  @spec init(keyword()) :: t()
  def init(opts \\ []) do
    thread_id = Keyword.get(opts, :thread_id)
    run_id = Keyword.get(opts, :run_id)

    session =
      case {thread_id, run_id} do
        {nil, nil} -> Session.new()
        {tid, nil} -> Session.new(tid)
        {tid, rid} -> Session.new(tid, rid)
      end

    %__MODULE__{
      session: session,
      streaming_messages: %{},
      streaming_tools: %{},
      run_status: :idle,
      steps: [],
      last_event_type: nil,
      event_count: 0
    }
  end

  @doc """
  Applies an event to the UI state.

  This updates both the underlying session and the UI-specific state
  (streaming buffers, status, etc.).

  ## Examples

      ui_state = AgUI.LiveView.Renderer.apply_event(ui_state, event)

  """
  @spec apply_event(t(), Events.t()) :: t()
  def apply_event(%__MODULE__{} = ui_state, event) do
    # Apply to underlying session
    new_session = Reducer.apply(ui_state.session, event)

    # Update UI state
    ui_state
    |> Map.put(:session, new_session)
    |> Map.put(:streaming_messages, new_session.text_buffers)
    |> Map.put(:streaming_tools, new_session.tool_buffers)
    |> Map.put(:run_status, new_session.status)
    |> Map.put(:steps, new_session.steps)
    |> Map.put(:last_event_type, event.type)
    |> Map.update!(:event_count, &(&1 + 1))
  end

  @doc """
  Applies a list of events to the UI state.

  ## Examples

      ui_state = AgUI.LiveView.Renderer.apply_all(ui_state, events)

  """
  @spec apply_all(t(), [Events.t()]) :: t()
  def apply_all(%__MODULE__{} = ui_state, events) when is_list(events) do
    Enum.reduce(events, ui_state, &apply_event(&2, &1))
  end

  @doc """
  Returns true if the run is currently active.
  """
  @spec running?(t()) :: boolean()
  def running?(%__MODULE__{run_status: :running}), do: true
  def running?(%__MODULE__{}), do: false

  @doc """
  Returns true if the run has finished successfully.
  """
  @spec finished?(t()) :: boolean()
  def finished?(%__MODULE__{run_status: :finished}), do: true
  def finished?(%__MODULE__{}), do: false

  @doc """
  Returns true if the run has failed with an error.
  """
  @spec error?(t()) :: boolean()
  def error?(%__MODULE__{run_status: {:error, _}}), do: true
  def error?(%__MODULE__{}), do: false

  @doc """
  Returns the error message if in error state, nil otherwise.
  """
  @spec error_message(t()) :: String.t() | nil
  def error_message(%__MODULE__{run_status: {:error, msg}}), do: msg
  def error_message(%__MODULE__{}), do: nil

  @doc """
  Returns true if there are any active streaming buffers.
  """
  @spec streaming?(t()) :: boolean()
  def streaming?(%__MODULE__{streaming_messages: msgs, streaming_tools: tools}) do
    map_size(msgs) > 0 or map_size(tools) > 0
  end

  @doc """
  Returns the messages from the session.
  """
  @spec messages(t()) :: [AgUI.Types.Message.t()]
  def messages(%__MODULE__{session: session}), do: session.messages

  @doc """
  Returns the shared state from the session.
  """
  @spec state(t()) :: map()
  def state(%__MODULE__{session: session}), do: session.state

  @doc """
  Returns true if thinking is currently active.
  """
  @spec thinking?(t()) :: boolean()
  def thinking?(%__MODULE__{session: session}), do: Session.thinking?(session)

  @doc """
  Returns the current thinking content.
  """
  @spec thinking_content(t()) :: String.t()
  def thinking_content(%__MODULE__{session: session}), do: Session.thinking_content(session)

  @doc """
  Returns a map suitable for LiveView stream operations.

  This returns a map with stream-friendly data structures:
  - `:messages` - List of messages with IDs for stream inserts
  - `:streaming` - Map of streaming message buffers

  ## Examples

      stream_data = AgUI.LiveView.Renderer.stream_data(ui_state)
      socket = stream(socket, :messages, stream_data.messages)

  """
  @spec stream_data(t()) :: %{messages: list(), streaming: map()}
  def stream_data(%__MODULE__{session: session, streaming_messages: streaming}) do
    %{
      messages: session.messages,
      streaming: streaming
    }
  end

  @doc """
  Resets the UI state for a new run.

  Keeps the thread_id but clears run-specific state.
  """
  @spec reset(t()) :: t()
  def reset(%__MODULE__{session: session}) do
    %__MODULE__{
      session: %{
        session
        | run_id: nil,
          status: :idle,
          steps: [],
          text_buffers: %{},
          tool_buffers: %{}
      },
      streaming_messages: %{},
      streaming_tools: %{},
      run_status: :idle,
      steps: [],
      last_event_type: nil,
      event_count: 0
    }
  end
end
