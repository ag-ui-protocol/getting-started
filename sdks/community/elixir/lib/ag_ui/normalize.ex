defmodule AgUI.Normalize do
  @moduledoc """
  Expands chunk events into canonical start/content/end triads.

  Matches TypeScript `transformChunks` behavior exactly.

  ## Overview

  AG-UI supports two "convenience" chunk event types that combine the lifecycle
  events into a single event:

  - `TEXT_MESSAGE_CHUNK` → `TEXT_MESSAGE_START` + `TEXT_MESSAGE_CONTENT` + `TEXT_MESSAGE_END`
  - `TOOL_CALL_CHUNK` → `TOOL_CALL_START` + `TOOL_CALL_ARGS` + `TOOL_CALL_END`

  This module expands these chunk events into their canonical form, making it
  easier for downstream consumers to handle a consistent event structure.

  ## Passthrough Events

  The following events do NOT close pending streams and pass through unchanged:
  - `RAW`
  - `ACTIVITY_SNAPSHOT`
  - `ACTIVITY_DELTA`

  All other events close any pending text message or tool call streams before
  being emitted.

  ## Usage

      # Expand a single event (stateful)
      {events, pending} = AgUI.Normalize.expand(event, pending)

      # Expand a stream of events
      canonical_stream = AgUI.Normalize.expand_stream(event_stream)

      # Finalize any pending streams
      final_events = AgUI.Normalize.finalize(pending)

  """

  alias AgUI.Events
  alias AgUI.Types

  @type pending :: %{
          text: %{String.t() => %{role: String.t(), started: boolean()}},
          tool: %{
            String.t() => %{
              name: String.t(),
              parent_message_id: String.t() | nil,
              started: boolean()
            }
          },
          current_text_id: String.t() | nil,
          current_tool_id: String.t() | nil
        }

  # Events that do NOT close pending streams
  @passthrough_types [:raw, :activity_snapshot, :activity_delta]

  @doc """
  Creates a new pending state for tracking chunk expansion.
  """
  @spec new() :: pending()
  def new do
    %{
      text: %{},
      tool: %{},
      current_text_id: nil,
      current_tool_id: nil
    }
  end

  @doc """
  Expands a stream of events, converting chunk events to canonical form.

  Returns a stream of canonical events where all TEXT_MESSAGE_CHUNK and
  TOOL_CALL_CHUNK events are expanded into their start/content/end triads.
  """
  @spec expand_stream(Enumerable.t()) :: Enumerable.t()
  def expand_stream(stream) do
    Stream.transform(
      stream,
      fn -> new() end,
      fn event, pending ->
        {events, new_pending} = expand(event, pending)
        {events, new_pending}
      end,
      fn pending ->
        final_events = finalize(pending)
        {final_events, nil}
      end,
      fn _ -> :ok end
    )
  end

  @doc """
  Expands a stream of events like `expand_stream/1`, but converts malformed
  chunk errors into a single RUN_ERROR event and halts the stream.
  """
  @spec expand_stream_safe(Enumerable.t()) :: Enumerable.t()
  def expand_stream_safe(stream) do
    Stream.transform(
      stream,
      fn -> {:ok, new()} end,
      fn
        _event, {:halt, pending} ->
          {[], {:halt, pending}}

        event, {:ok, pending} ->
          try do
            {events, new_pending} = expand(event, pending)
            {events, {:ok, new_pending}}
          rescue
            e ->
              error = %Events.RunError{
                type: :run_error,
                message: Exception.format(:error, e, __STACKTRACE__),
                timestamp: System.system_time(:millisecond)
              }

              {[error], {:halt, pending}}
          catch
            kind, reason ->
              error = %Events.RunError{
                type: :run_error,
                message: Exception.format(kind, reason, __STACKTRACE__),
                timestamp: System.system_time(:millisecond)
              }

              {[error], {:halt, pending}}
          end
      end,
      fn
        {:ok, pending} -> {finalize(pending), nil}
        {:halt, _pending} -> {[], nil}
      end,
      fn _ -> :ok end
    )
  end

  @doc """
  Expands a single event, returning emitted events and updated pending state.

  ## Parameters

  - `event` - The event to process
  - `pending` - The current pending state tracking active streams

  ## Returns

  A tuple of `{events_to_emit, new_pending}`.
  """
  @spec expand(Events.t(), pending()) :: {[Events.t()], pending()}

  # TEXT_MESSAGE_CHUNK expansion
  def expand(%Events.TextMessageChunk{} = chunk, pending) do
    message_id =
      cond do
        chunk.message_id -> chunk.message_id
        pending.current_text_id -> pending.current_text_id
        true -> nil
      end

    if is_nil(message_id) do
      raise ArgumentError, "TEXT_MESSAGE_CHUNK missing required messageId"
    end

    role =
      case chunk.role do
        r when is_atom(r) ->
          try do
            Types.Message.role_to_wire(r)
          rescue
            _ -> r
          end

        r ->
          r
      end

    if role && role not in ["developer", "system", "user", "assistant"] do
      raise ArgumentError, "TEXT_MESSAGE_CHUNK has invalid role #{inspect(chunk.role)}"
    end

    # First, close any pending tool call when switching to text
    {tool_close_events, pending} =
      if pending.current_tool_id do
        close_tool_call(pending.current_tool_id, pending)
      else
        {[], pending}
      end

    # Check if we need to close current text stream (different ID)
    {text_close_events, pending} =
      if pending.current_text_id && pending.current_text_id != message_id do
        close_text_message(pending.current_text_id, pending)
      else
        {[], pending}
      end

    # Check if this is a new message (not yet started)
    {start_events, pending} =
      if not Map.has_key?(pending.text, message_id) do
        role = chunk.role || "assistant"

        start_event = %Events.TextMessageStart{
          type: :text_message_start,
          message_id: message_id,
          role: role,
          timestamp: chunk.timestamp,
          raw_event: chunk.raw_event
        }

        new_pending =
          pending
          |> put_in([:text, message_id], %{role: role, started: true})
          |> Map.put(:current_text_id, message_id)

        {[start_event], new_pending}
      else
        {[], %{pending | current_text_id: message_id}}
      end

    # Emit content if delta is present
    content_events =
      if chunk.delta && chunk.delta != "" do
        [
          %Events.TextMessageContent{
            type: :text_message_content,
            message_id: message_id,
            delta: chunk.delta,
            timestamp: chunk.timestamp,
            raw_event: chunk.raw_event
          }
        ]
      else
        []
      end

    {tool_close_events ++ text_close_events ++ start_events ++ content_events, pending}
  end

  # TOOL_CALL_CHUNK expansion
  def expand(%Events.ToolCallChunk{} = chunk, pending) do
    tool_call_id =
      cond do
        chunk.tool_call_id -> chunk.tool_call_id
        pending.current_tool_id -> pending.current_tool_id
        true -> nil
      end

    if is_nil(tool_call_id) do
      raise ArgumentError, "TOOL_CALL_CHUNK missing required toolCallId"
    end

    # First, close any pending text message when switching to tool
    {text_close_events, pending} =
      if pending.current_text_id do
        close_text_message(pending.current_text_id, pending)
      else
        {[], pending}
      end

    # Check if we need to close current tool stream (different ID)
    {tool_close_events, pending} =
      if pending.current_tool_id && pending.current_tool_id != tool_call_id do
        close_tool_call(pending.current_tool_id, pending)
      else
        {[], pending}
      end

    # Check if this is a new tool call (not yet started)
    {start_events, pending} =
      if not Map.has_key?(pending.tool, tool_call_id) do
        # First chunk must have tool_call_name
        if is_nil(chunk.tool_call_name) do
          raise ArgumentError, "TOOL_CALL_CHUNK missing required toolCallName for new tool call"
        else
          start_event = %Events.ToolCallStart{
            type: :tool_call_start,
            tool_call_id: tool_call_id,
            tool_call_name: chunk.tool_call_name,
            parent_message_id: chunk.parent_message_id,
            timestamp: chunk.timestamp,
            raw_event: chunk.raw_event
          }

          new_pending =
            pending
            |> put_in([:tool, tool_call_id], %{
              name: chunk.tool_call_name,
              parent_message_id: chunk.parent_message_id,
              started: true
            })
            |> Map.put(:current_tool_id, tool_call_id)

          {[start_event], new_pending}
        end
      else
        {[], %{pending | current_tool_id: tool_call_id}}
      end

    # Emit args if delta is present and we didn't skip
    args_events =
      if chunk.delta && chunk.delta != "" do
        [
          %Events.ToolCallArgs{
            type: :tool_call_args,
            tool_call_id: tool_call_id,
            delta: chunk.delta,
            timestamp: chunk.timestamp,
            raw_event: chunk.raw_event
          }
        ]
      else
        []
      end

    {text_close_events ++ tool_close_events ++ start_events ++ args_events, pending}
  end

  # Passthrough events - don't close pending streams
  def expand(%{type: type} = event, pending) when type in @passthrough_types do
    {[event], pending}
  end

  # All other events close pending streams first
  def expand(event, pending) do
    close_events = close_all_pending(pending)
    new_pending = new()
    {close_events ++ [event], new_pending}
  end

  @doc """
  Finalizes any pending streams, emitting END events for unclosed streams.

  Call this when the event source completes to ensure no streams are left open.
  """
  @spec finalize(pending()) :: [Events.t()]
  def finalize(pending) do
    close_all_pending(pending)
  end

  # Close a specific text message stream
  defp close_text_message(message_id, pending) do
    if Map.has_key?(pending.text, message_id) do
      end_event = %Events.TextMessageEnd{
        type: :text_message_end,
        message_id: message_id
      }

      new_pending =
        pending
        |> update_in([:text], &Map.delete(&1, message_id))
        |> Map.put(:current_text_id, nil)

      {[end_event], new_pending}
    else
      {[], pending}
    end
  end

  # Close a specific tool call stream
  defp close_tool_call(tool_call_id, pending) do
    if Map.has_key?(pending.tool, tool_call_id) do
      end_event = %Events.ToolCallEnd{
        type: :tool_call_end,
        tool_call_id: tool_call_id
      }

      new_pending =
        pending
        |> update_in([:tool], &Map.delete(&1, tool_call_id))
        |> Map.put(:current_tool_id, nil)

      {[end_event], new_pending}
    else
      {[], pending}
    end
  end

  # Close all pending streams
  defp close_all_pending(pending) do
    text_ends =
      Enum.map(pending.text, fn {message_id, _} ->
        %Events.TextMessageEnd{
          type: :text_message_end,
          message_id: message_id
        }
      end)

    tool_ends =
      Enum.map(pending.tool, fn {tool_call_id, _} ->
        %Events.ToolCallEnd{
          type: :tool_call_end,
          tool_call_id: tool_call_id
        }
      end)

    text_ends ++ tool_ends
  end
end
