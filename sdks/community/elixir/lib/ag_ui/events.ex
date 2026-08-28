defmodule AgUI.Events do
  @moduledoc """
  AG-UI Protocol event types and decoder.

  This module provides a unified decoder for all 26 AG-UI event types,
  dispatching to the appropriate struct based on the "type" field.

  ## Event Categories

  ### Lifecycle Events
  - `RunStarted` - A run has started
  - `RunFinished` - A run has completed successfully
  - `RunError` - A run encountered an error
  - `StepStarted` - A step within a run has started
  - `StepFinished` - A step within a run has completed

  ### Text Message Events
  - `TextMessageStart` - Start of a text message stream
  - `TextMessageContent` - Text content chunk
  - `TextMessageEnd` - End of a text message stream
  - `TextMessageChunk` - Convenience chunk (expands to start/content/end)

  ### Tool Call Events
  - `ToolCallStart` - Start of a tool call
  - `ToolCallArgs` - Tool call arguments chunk
  - `ToolCallEnd` - End of a tool call
  - `ToolCallResult` - Result of a tool execution
  - `ToolCallChunk` - Convenience chunk (expands to start/args/end)

  ### State Management Events
  - `StateSnapshot` - Complete state snapshot
  - `StateDelta` - JSON Patch delta for state
  - `MessagesSnapshot` - Complete messages snapshot
  - `ActivitySnapshot` - Activity message for UI rendering
  - `ActivityDelta` - JSON Patch delta for activity content

  ### Thinking Events
  - `ThinkingStart` - Agent started thinking
  - `ThinkingEnd` - Agent finished thinking
  - `ThinkingTextMessageStart` - Start of thinking text
  - `ThinkingTextMessageContent` - Thinking text chunk
  - `ThinkingTextMessageEnd` - End of thinking text

  ### Special Events
  - `Raw` - Passthrough raw provider data
  - `Custom` - Application-specific custom event

  ## Usage

      {:ok, event} = AgUI.Events.decode(%{"type" => "RUN_STARTED", "threadId" => "t1", "runId" => "r1"})
      event.type  # => :run_started

  """

  alias AgUI.Events.{
    # Lifecycle
    RunStarted,
    RunFinished,
    RunError,
    StepStarted,
    StepFinished,
    # Text message
    TextMessageStart,
    TextMessageContent,
    TextMessageEnd,
    TextMessageChunk,
    # Tool call
    ToolCallStart,
    ToolCallArgs,
    ToolCallEnd,
    ToolCallResult,
    ToolCallChunk,
    # State
    StateSnapshot,
    StateDelta,
    MessagesSnapshot,
    ActivitySnapshot,
    ActivityDelta,
    # Thinking
    ThinkingStart,
    ThinkingEnd,
    ThinkingTextMessageStart,
    ThinkingTextMessageContent,
    ThinkingTextMessageEnd,
    # Special
    Raw,
    Custom
  }

  @type event_type ::
          :run_started
          | :run_finished
          | :run_error
          | :step_started
          | :step_finished
          | :text_message_start
          | :text_message_content
          | :text_message_end
          | :text_message_chunk
          | :tool_call_start
          | :tool_call_args
          | :tool_call_end
          | :tool_call_result
          | :tool_call_chunk
          | :state_snapshot
          | :state_delta
          | :messages_snapshot
          | :activity_snapshot
          | :activity_delta
          | :thinking_start
          | :thinking_end
          | :thinking_text_message_start
          | :thinking_text_message_content
          | :thinking_text_message_end
          | :raw
          | :custom

  @type t ::
          RunStarted.t()
          | RunFinished.t()
          | RunError.t()
          | StepStarted.t()
          | StepFinished.t()
          | TextMessageStart.t()
          | TextMessageContent.t()
          | TextMessageEnd.t()
          | TextMessageChunk.t()
          | ToolCallStart.t()
          | ToolCallArgs.t()
          | ToolCallEnd.t()
          | ToolCallResult.t()
          | ToolCallChunk.t()
          | StateSnapshot.t()
          | StateDelta.t()
          | MessagesSnapshot.t()
          | ActivitySnapshot.t()
          | ActivityDelta.t()
          | ThinkingStart.t()
          | ThinkingEnd.t()
          | ThinkingTextMessageStart.t()
          | ThinkingTextMessageContent.t()
          | ThinkingTextMessageEnd.t()
          | Raw.t()
          | Custom.t()

  @event_modules %{
    # Lifecycle
    "RUN_STARTED" => RunStarted,
    "RUN_FINISHED" => RunFinished,
    "RUN_ERROR" => RunError,
    "STEP_STARTED" => StepStarted,
    "STEP_FINISHED" => StepFinished,
    # Text message
    "TEXT_MESSAGE_START" => TextMessageStart,
    "TEXT_MESSAGE_CONTENT" => TextMessageContent,
    "TEXT_MESSAGE_END" => TextMessageEnd,
    "TEXT_MESSAGE_CHUNK" => TextMessageChunk,
    # Tool call
    "TOOL_CALL_START" => ToolCallStart,
    "TOOL_CALL_ARGS" => ToolCallArgs,
    "TOOL_CALL_END" => ToolCallEnd,
    "TOOL_CALL_RESULT" => ToolCallResult,
    "TOOL_CALL_CHUNK" => ToolCallChunk,
    # State
    "STATE_SNAPSHOT" => StateSnapshot,
    "STATE_DELTA" => StateDelta,
    "MESSAGES_SNAPSHOT" => MessagesSnapshot,
    "ACTIVITY_SNAPSHOT" => ActivitySnapshot,
    "ACTIVITY_DELTA" => ActivityDelta,
    # Thinking
    "THINKING_START" => ThinkingStart,
    "THINKING_END" => ThinkingEnd,
    "THINKING_TEXT_MESSAGE_START" => ThinkingTextMessageStart,
    "THINKING_TEXT_MESSAGE_CONTENT" => ThinkingTextMessageContent,
    "THINKING_TEXT_MESSAGE_END" => ThinkingTextMessageEnd,
    # Special
    "RAW" => Raw,
    "CUSTOM" => Custom
  }

  @type_to_wire %{
    run_started: "RUN_STARTED",
    run_finished: "RUN_FINISHED",
    run_error: "RUN_ERROR",
    step_started: "STEP_STARTED",
    step_finished: "STEP_FINISHED",
    text_message_start: "TEXT_MESSAGE_START",
    text_message_content: "TEXT_MESSAGE_CONTENT",
    text_message_end: "TEXT_MESSAGE_END",
    text_message_chunk: "TEXT_MESSAGE_CHUNK",
    tool_call_start: "TOOL_CALL_START",
    tool_call_args: "TOOL_CALL_ARGS",
    tool_call_end: "TOOL_CALL_END",
    tool_call_result: "TOOL_CALL_RESULT",
    tool_call_chunk: "TOOL_CALL_CHUNK",
    state_snapshot: "STATE_SNAPSHOT",
    state_delta: "STATE_DELTA",
    messages_snapshot: "MESSAGES_SNAPSHOT",
    activity_snapshot: "ACTIVITY_SNAPSHOT",
    activity_delta: "ACTIVITY_DELTA",
    thinking_start: "THINKING_START",
    thinking_end: "THINKING_END",
    thinking_text_message_start: "THINKING_TEXT_MESSAGE_START",
    thinking_text_message_content: "THINKING_TEXT_MESSAGE_CONTENT",
    thinking_text_message_end: "THINKING_TEXT_MESSAGE_END",
    raw: "RAW",
    custom: "CUSTOM"
  }

  @doc """
  Decodes a wire format map into the appropriate event struct.

  ## Examples

      iex> AgUI.Events.decode(%{"type" => "RUN_STARTED", "threadId" => "t1", "runId" => "r1"})
      {:ok, %AgUI.Events.RunStarted{type: :run_started, thread_id: "t1", run_id: "r1"}}

      iex> AgUI.Events.decode(%{"type" => "UNKNOWN"})
      {:error, {:unknown_event_type, "UNKNOWN"}}

  """
  @spec decode(map()) :: {:ok, t()} | {:error, term()}
  def decode(%{"type" => type} = map) when is_binary(type) do
    case Map.get(@event_modules, type) do
      nil -> {:error, {:unknown_event_type, type}}
      module -> module.from_map(map)
    end
  end

  def decode(%{} = _map) do
    {:error, :missing_type}
  end

  def decode(_) do
    {:error, :invalid_input}
  end

  @doc """
  Decodes a wire format map into the appropriate event struct, raising on error.

  ## Examples

      iex> AgUI.Events.decode!(%{"type" => "RUN_FINISHED", "threadId" => "t1", "runId" => "r1"})
      %AgUI.Events.RunFinished{type: :run_finished, thread_id: "t1", run_id: "r1"}

  """
  @spec decode!(map()) :: t()
  def decode!(map) do
    case decode(map) do
      {:ok, event} -> event
      {:error, reason} -> raise ArgumentError, "Failed to decode event: #{inspect(reason)}"
    end
  end

  @doc """
  Encodes an event struct to wire format map.

  ## Examples

      iex> event = %AgUI.Events.RunStarted{thread_id: "t1", run_id: "r1"}
      iex> AgUI.Events.encode(event)
      %{"type" => "RUN_STARTED", "threadId" => "t1", "runId" => "r1"}

  """
  @spec encode(t()) :: map()
  def encode(%RunStarted{} = event), do: RunStarted.to_map(event)
  def encode(%RunFinished{} = event), do: RunFinished.to_map(event)
  def encode(%RunError{} = event), do: RunError.to_map(event)
  def encode(%StepStarted{} = event), do: StepStarted.to_map(event)
  def encode(%StepFinished{} = event), do: StepFinished.to_map(event)
  def encode(%TextMessageStart{} = event), do: TextMessageStart.to_map(event)
  def encode(%TextMessageContent{} = event), do: TextMessageContent.to_map(event)
  def encode(%TextMessageEnd{} = event), do: TextMessageEnd.to_map(event)
  def encode(%TextMessageChunk{} = event), do: TextMessageChunk.to_map(event)
  def encode(%ToolCallStart{} = event), do: ToolCallStart.to_map(event)
  def encode(%ToolCallArgs{} = event), do: ToolCallArgs.to_map(event)
  def encode(%ToolCallEnd{} = event), do: ToolCallEnd.to_map(event)
  def encode(%ToolCallResult{} = event), do: ToolCallResult.to_map(event)
  def encode(%ToolCallChunk{} = event), do: ToolCallChunk.to_map(event)
  def encode(%StateSnapshot{} = event), do: StateSnapshot.to_map(event)
  def encode(%StateDelta{} = event), do: StateDelta.to_map(event)
  def encode(%MessagesSnapshot{} = event), do: MessagesSnapshot.to_map(event)
  def encode(%ActivitySnapshot{} = event), do: ActivitySnapshot.to_map(event)
  def encode(%ActivityDelta{} = event), do: ActivityDelta.to_map(event)
  def encode(%ThinkingStart{} = event), do: ThinkingStart.to_map(event)
  def encode(%ThinkingEnd{} = event), do: ThinkingEnd.to_map(event)
  def encode(%ThinkingTextMessageStart{} = event), do: ThinkingTextMessageStart.to_map(event)
  def encode(%ThinkingTextMessageContent{} = event), do: ThinkingTextMessageContent.to_map(event)
  def encode(%ThinkingTextMessageEnd{} = event), do: ThinkingTextMessageEnd.to_map(event)
  def encode(%Raw{} = event), do: Raw.to_map(event)
  def encode(%Custom{} = event), do: Custom.to_map(event)

  @doc """
  Converts an event type atom to wire format string.

  ## Examples

      iex> AgUI.Events.type_to_wire(:run_started)
      "RUN_STARTED"

  """
  @spec type_to_wire(event_type()) :: String.t()
  def type_to_wire(type) when is_atom(type) do
    Map.fetch!(@type_to_wire, type)
  end

  @doc """
  Converts a wire format type string to event type atom.

  ## Examples

      iex> AgUI.Events.type_from_wire("RUN_STARTED")
      {:ok, :run_started}

      iex> AgUI.Events.type_from_wire("UNKNOWN")
      {:error, {:unknown_event_type, "UNKNOWN"}}

  """
  @spec type_from_wire(String.t()) :: {:ok, event_type()} | {:error, term()}
  def type_from_wire(wire_type) when is_binary(wire_type) do
    case Map.get(@event_modules, wire_type) do
      nil -> {:error, {:unknown_event_type, wire_type}}
      module -> {:ok, module.__struct__().type}
    end
  end

  @doc """
  Returns a list of all supported event type strings.
  """
  @spec event_types() :: [String.t()]
  def event_types do
    Map.keys(@event_modules)
  end

  @doc """
  Checks if a wire type string is a valid event type.
  """
  @spec valid_type?(String.t()) :: boolean()
  def valid_type?(wire_type) when is_binary(wire_type) do
    Map.has_key?(@event_modules, wire_type)
  end
end
