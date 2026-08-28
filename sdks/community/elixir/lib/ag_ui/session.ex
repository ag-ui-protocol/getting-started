defmodule AgUI.Session do
  @moduledoc """
  Protocol-level session state container.

  A Session represents the complete state of an AG-UI interaction, including:

  - Thread and run identification
  - Run lifecycle status
  - Conversation messages
  - Shared state (for STATE_SNAPSHOT/STATE_DELTA)
  - Step progress tracking
  - Streaming buffers for text and tool calls
  - Thinking state (recorded but not rendered by default)

  ## Usage

  Sessions are typically created with `new/0` and updated by applying events
  through `AgUI.Reducer.apply/2`:

      session = AgUI.Session.new()
      session = AgUI.Reducer.apply(session, run_started_event)
      session = AgUI.Reducer.apply(session, text_message_start_event)
      # ... apply more events ...

  ## Multiple Sequential Runs

  AG-UI supports multiple sequential runs in a single session. Each new
  `RUN_STARTED` event resets run-specific state (steps, buffers) while
  preserving accumulated messages and state.

  """

  alias AgUI.Types.Message

  @type status :: :idle | :running | :finished | {:error, String.t()}

  @type text_buffer :: %{
          content: String.t(),
          role: atom()
        }

  @type tool_buffer :: %{
          name: String.t(),
          args: String.t(),
          parent_message_id: String.t() | nil
        }

  @type step :: %{
          name: String.t(),
          status: :started | :finished
        }

  @type thinking_state :: %{
          active: boolean(),
          content: String.t()
        }

  @type t :: %__MODULE__{
          thread_id: String.t() | nil,
          run_id: String.t() | nil,
          status: status(),
          messages: [Message.t()],
          state: term(),
          steps: [step()],
          text_buffers: %{String.t() => text_buffer()},
          tool_buffers: %{String.t() => tool_buffer()},
          thinking: thinking_state()
        }

  defstruct thread_id: nil,
            run_id: nil,
            status: :idle,
            messages: [],
            state: %{},
            steps: [],
            text_buffers: %{},
            tool_buffers: %{},
            thinking: %{active: false, content: ""}

  @doc """
  Creates a new empty session.

  ## Examples

      iex> session = AgUI.Session.new()
      iex> session.status
      :idle

  """
  @spec new() :: t()
  def new do
    %__MODULE__{}
  end

  @doc """
  Creates a new session with the given thread ID.

  ## Examples

      iex> session = AgUI.Session.new("thread-123")
      iex> session.thread_id
      "thread-123"

  """
  @spec new(String.t()) :: t()
  def new(thread_id) when is_binary(thread_id) do
    %__MODULE__{thread_id: thread_id}
  end

  @doc """
  Creates a new session with the given thread ID and run ID.

  ## Examples

      iex> session = AgUI.Session.new("thread-123", "run-456")
      iex> session.run_id
      "run-456"

  """
  @spec new(String.t(), String.t()) :: t()
  def new(thread_id, run_id) when is_binary(thread_id) and is_binary(run_id) do
    %__MODULE__{thread_id: thread_id, run_id: run_id}
  end

  @doc """
  Returns whether the session is currently running.
  """
  @spec running?(t()) :: boolean()
  def running?(%__MODULE__{status: :running}), do: true
  def running?(%__MODULE__{}), do: false

  @doc """
  Returns whether the session has finished successfully.
  """
  @spec finished?(t()) :: boolean()
  def finished?(%__MODULE__{status: :finished}), do: true
  def finished?(%__MODULE__{}), do: false

  @doc """
  Returns whether the session has encountered an error.
  """
  @spec error?(t()) :: boolean()
  def error?(%__MODULE__{status: {:error, _}}), do: true
  def error?(%__MODULE__{}), do: false

  @doc """
  Returns the error message if the session is in an error state.
  """
  @spec error_message(t()) :: String.t() | nil
  def error_message(%__MODULE__{status: {:error, message}}), do: message
  def error_message(%__MODULE__{}), do: nil

  @doc """
  Returns whether there are any active streaming buffers.
  """
  @spec streaming?(t()) :: boolean()
  def streaming?(%__MODULE__{text_buffers: text, tool_buffers: tool}) do
    map_size(text) > 0 or map_size(tool) > 0
  end

  @doc """
  Returns the current streaming text content for a message ID, if any.
  """
  @spec streaming_text(t(), String.t()) :: String.t() | nil
  def streaming_text(%__MODULE__{text_buffers: buffers}, message_id) do
    case Map.get(buffers, message_id) do
      %{content: content} -> content
      nil -> nil
    end
  end

  @doc """
  Returns the current streaming tool arguments for a tool call ID, if any.
  """
  @spec streaming_tool_args(t(), String.t()) :: String.t() | nil
  def streaming_tool_args(%__MODULE__{tool_buffers: buffers}, tool_call_id) do
    case Map.get(buffers, tool_call_id) do
      %{args: args} -> args
      nil -> nil
    end
  end

  @doc """
  Returns the messages of a specific role.
  """
  @spec messages_by_role(t(), atom()) :: [Message.t()]
  def messages_by_role(%__MODULE__{messages: messages}, role) when is_atom(role) do
    Enum.filter(messages, fn msg -> msg.role == role end)
  end

  @doc """
  Returns the last message in the session, if any.
  """
  @spec last_message(t()) :: Message.t() | nil
  def last_message(%__MODULE__{messages: []}), do: nil
  def last_message(%__MODULE__{messages: messages}), do: List.last(messages)

  @doc """
  Returns a message by ID, if it exists.
  """
  @spec get_message(t(), String.t()) :: Message.t() | nil
  def get_message(%__MODULE__{messages: messages}, id) do
    Enum.find(messages, fn msg -> msg.id == id end)
  end

  @doc """
  Returns a step by name, if it exists.
  """
  @spec get_step(t(), String.t()) :: step() | nil
  def get_step(%__MODULE__{steps: steps}, name) do
    Enum.find(steps, fn step -> step.name == name end)
  end

  @doc """
  Returns whether thinking mode is currently active.
  """
  @spec thinking?(t()) :: boolean()
  def thinking?(%__MODULE__{thinking: %{active: active}}), do: active

  @doc """
  Returns the accumulated thinking content.
  """
  @spec thinking_content(t()) :: String.t()
  def thinking_content(%__MODULE__{thinking: %{content: content}}), do: content
end
