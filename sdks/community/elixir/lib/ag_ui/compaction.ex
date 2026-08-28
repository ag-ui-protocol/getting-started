defmodule AgUI.Compaction do
  @moduledoc """
  Stream compaction for persistence and replay.

  Matches TypeScript `compactEvents` behavior exactly.

  ## Overview

  Compaction consolidates streaming events while preserving non-streaming events
  through reordering. This is useful for:

  - Reducing event log size for persistence
  - Faster replay of event history
  - Cleaner event streams for debugging

  ## Compaction Rules

  ### Text Messages

  Multiple `TEXT_MESSAGE_CONTENT` events are merged into a single event with
  concatenated deltas:

      [START, CONTENT("Hello "), CONTENT("world"), END]
      →
      [START, CONTENT("Hello world"), END]

  ### Tool Calls

  Multiple `TOOL_CALL_ARGS` events are merged into a single event:

      [START, ARGS('{"a": '), ARGS('10}'), END]
      →
      [START, ARGS('{"a": 10}'), END]

  ### Interleaved Events

  Non-streaming events that appear between START and END are reordered to
  appear after the END:

      [START, CONTENT, CUSTOM, CONTENT, END]
      →
      [START, CONTENT(merged), END, CUSTOM]

  ## Important Notes

  - State deltas are NOT collapsed into snapshots
  - Empty deltas are still included in concatenation
  - Incomplete streams (missing END) are still flushed

  ## Usage

      compacted = AgUI.Compaction.compact_events(events)

  """

  alias AgUI.Events

  @text_message_types [:text_message_start, :text_message_content, :text_message_end]
  @tool_call_types [:tool_call_start, :tool_call_args, :tool_call_end]

  @doc """
  Compacts a list of events by merging streaming deltas and reordering interleaved events.

  ## Parameters

  - `events` - List of AG-UI events to compact

  ## Returns

  A compacted list of events where:
  - TEXT_MESSAGE_CONTENT events are merged
  - TOOL_CALL_ARGS events are merged
  - Interleaved events are reordered to after stream END

  ## Examples

      iex> events = [
      ...>   %AgUI.Events.TextMessageStart{message_id: "m1", role: "assistant"},
      ...>   %AgUI.Events.TextMessageContent{message_id: "m1", delta: "Hello "},
      ...>   %AgUI.Events.TextMessageContent{message_id: "m1", delta: "world"},
      ...>   %AgUI.Events.TextMessageEnd{message_id: "m1"}
      ...> ]
      iex> AgUI.Compaction.compact_events(events)
      [
        %AgUI.Events.TextMessageStart{message_id: "m1", role: "assistant"},
        %AgUI.Events.TextMessageContent{message_id: "m1", delta: "Hello world"},
        %AgUI.Events.TextMessageEnd{message_id: "m1"}
      ]

  """
  @spec compact_events([Events.t()]) :: [Events.t()]
  def compact_events(events) when is_list(events) do
    events
    |> compact_text_messages()
    |> compact_tool_calls()
  end

  # Compact text message events
  defp compact_text_messages(events) do
    # State: {result, pending_messages, interleaved}
    # pending_messages: %{message_id => %{start: event, contents: [event], end: event | nil}}
    initial_state = {[], %{}, []}

    {result, pending, interleaved} =
      Enum.reduce(events, initial_state, fn event, {result, pending, interleaved} ->
        cond do
          is_text_message_event?(event) ->
            handle_text_message_event(event, result, pending, interleaved)

          map_size(pending) > 0 ->
            # Non-text event during text message stream - buffer it
            {result, pending, interleaved ++ [event]}

          true ->
            # No active text message stream
            {result ++ [event], pending, interleaved}
        end
      end)

    # Flush any remaining pending messages
    flush_pending_text_messages(result, pending, interleaved)
  end

  defp is_text_message_event?(%{type: type}) when type in @text_message_types, do: true
  defp is_text_message_event?(_), do: false

  defp handle_text_message_event(event, result, pending, interleaved) do
    message_id = event.message_id

    case event.type do
      :text_message_start ->
        # Start a new pending message
        new_pending =
          Map.put(pending, message_id, %{
            start: event,
            contents: [],
            end_event: nil
          })

        {result, new_pending, interleaved}

      :text_message_content ->
        # Add content to pending message
        if Map.has_key?(pending, message_id) do
          new_pending =
            update_in(pending, [message_id, :contents], fn contents ->
              contents ++ [event]
            end)

          {result, new_pending, interleaved}
        else
          # No pending start - pass through
          {result ++ [event], pending, interleaved}
        end

      :text_message_end ->
        # Complete and flush the message
        if Map.has_key?(pending, message_id) do
          pending_msg = Map.get(pending, message_id)
          flushed = flush_text_message(pending_msg, event)
          new_pending = Map.delete(pending, message_id)

          # If no more pending messages, also flush interleaved
          if map_size(new_pending) == 0 do
            {result ++ flushed ++ interleaved, new_pending, []}
          else
            {result ++ flushed, new_pending, interleaved}
          end
        else
          # No pending start - pass through
          {result ++ [event], pending, interleaved}
        end
    end
  end

  defp flush_text_message(pending_msg, end_event) do
    %{start: start, contents: contents} = pending_msg

    # Merge all content deltas
    merged_delta = Enum.map_join(contents, "", & &1.delta)

    # Only include content event if there was at least one content event
    content_events =
      if length(contents) > 0 do
        # Use timestamp from first content event
        first_content = hd(contents)

        [
          %Events.TextMessageContent{
            type: :text_message_content,
            message_id: start.message_id,
            delta: merged_delta,
            timestamp: first_content.timestamp,
            raw_event: first_content.raw_event
          }
        ]
      else
        []
      end

    [start] ++ content_events ++ [end_event]
  end

  defp flush_pending_text_messages(result, pending, interleaved) do
    if map_size(pending) == 0 do
      result ++ interleaved
    else
      # Flush all pending messages (incomplete - no END)
      flushed =
        Enum.flat_map(pending, fn {_message_id, pending_msg} ->
          flush_incomplete_text_message(pending_msg)
        end)

      result ++ flushed ++ interleaved
    end
  end

  defp flush_incomplete_text_message(pending_msg) do
    %{start: start, contents: contents} = pending_msg

    # Merge all content deltas
    merged_delta = Enum.map_join(contents, "", & &1.delta)

    content_events =
      if length(contents) > 0 do
        first_content = hd(contents)

        [
          %Events.TextMessageContent{
            type: :text_message_content,
            message_id: start.message_id,
            delta: merged_delta,
            timestamp: first_content.timestamp,
            raw_event: first_content.raw_event
          }
        ]
      else
        []
      end

    # No END event for incomplete streams
    [start] ++ content_events
  end

  # Compact tool call events
  defp compact_tool_calls(events) do
    initial_state = {[], %{}, []}

    {result, pending, interleaved} =
      Enum.reduce(events, initial_state, fn event, {result, pending, interleaved} ->
        cond do
          is_tool_call_event?(event) ->
            handle_tool_call_event(event, result, pending, interleaved)

          map_size(pending) > 0 ->
            # Non-tool event during tool call stream - buffer it
            {result, pending, interleaved ++ [event]}

          true ->
            # No active tool call stream
            {result ++ [event], pending, interleaved}
        end
      end)

    # Flush any remaining pending tool calls
    flush_pending_tool_calls(result, pending, interleaved)
  end

  defp is_tool_call_event?(%{type: type}) when type in @tool_call_types, do: true
  defp is_tool_call_event?(_), do: false

  defp handle_tool_call_event(event, result, pending, interleaved) do
    tool_call_id = event.tool_call_id

    case event.type do
      :tool_call_start ->
        # Start a new pending tool call
        new_pending =
          Map.put(pending, tool_call_id, %{
            start: event,
            args: [],
            end_event: nil
          })

        {result, new_pending, interleaved}

      :tool_call_args ->
        # Add args to pending tool call
        if Map.has_key?(pending, tool_call_id) do
          new_pending =
            update_in(pending, [tool_call_id, :args], fn args ->
              args ++ [event]
            end)

          {result, new_pending, interleaved}
        else
          # No pending start - pass through
          {result ++ [event], pending, interleaved}
        end

      :tool_call_end ->
        # Complete and flush the tool call
        if Map.has_key?(pending, tool_call_id) do
          pending_call = Map.get(pending, tool_call_id)
          flushed = flush_tool_call(pending_call, event)
          new_pending = Map.delete(pending, tool_call_id)

          # If no more pending tool calls, also flush interleaved
          if map_size(new_pending) == 0 do
            {result ++ flushed ++ interleaved, new_pending, []}
          else
            {result ++ flushed, new_pending, interleaved}
          end
        else
          # No pending start - pass through
          {result ++ [event], pending, interleaved}
        end
    end
  end

  defp flush_tool_call(pending_call, end_event) do
    %{start: start, args: args} = pending_call

    # Merge all args deltas
    merged_delta = Enum.map_join(args, "", & &1.delta)

    # Only include args event if there was at least one args event
    args_events =
      if length(args) > 0 do
        first_args = hd(args)

        [
          %Events.ToolCallArgs{
            type: :tool_call_args,
            tool_call_id: start.tool_call_id,
            delta: merged_delta,
            timestamp: first_args.timestamp,
            raw_event: first_args.raw_event
          }
        ]
      else
        []
      end

    [start] ++ args_events ++ [end_event]
  end

  defp flush_pending_tool_calls(result, pending, interleaved) do
    if map_size(pending) == 0 do
      result ++ interleaved
    else
      # Flush all pending tool calls (incomplete - no END)
      flushed =
        Enum.flat_map(pending, fn {_tool_call_id, pending_call} ->
          flush_incomplete_tool_call(pending_call)
        end)

      result ++ flushed ++ interleaved
    end
  end

  defp flush_incomplete_tool_call(pending_call) do
    %{start: start, args: args} = pending_call

    # Merge all args deltas
    merged_delta = Enum.map_join(args, "", & &1.delta)

    args_events =
      if length(args) > 0 do
        first_args = hd(args)

        [
          %Events.ToolCallArgs{
            type: :tool_call_args,
            tool_call_id: start.tool_call_id,
            delta: merged_delta,
            timestamp: first_args.timestamp,
            raw_event: first_args.raw_event
          }
        ]
      else
        []
      end

    # No END event for incomplete streams
    [start] ++ args_events
  end
end
