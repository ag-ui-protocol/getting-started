defmodule AgUI.Transport.SSE do
  @moduledoc """
  Server-Sent Events (SSE) parser.

  Implements the SSE protocol as defined in the WHATWG HTML Living Standard.
  Handles CRLF/LF line endings, multi-line data, event type, id, and retry fields.

  ## Usage

      # Create a new parser state
      parser = AgUI.Transport.SSE.new()

      # Feed chunks of data and get parsed events
      {events, parser} = AgUI.Transport.SSE.feed(parser, chunk)

      # Stream events from an enumerable of chunks
      stream = AgUI.Transport.SSE.stream_events(chunk_enum)

  ## Event Structure

  Each parsed event is a map with these keys:
  - `:data` - The event data (multiple data lines joined with newlines)
  - `:type` - The event type (defaults to "message")
  - `:id` - The event ID (nil if not specified)
  - `:retry` - Retry timeout in milliseconds (nil if not specified)

  """

  defmodule Parser do
    @moduledoc """
    Incremental parser state for SSE streams.
    """

    @type t :: %__MODULE__{
            buffer: String.t(),
            event_type: String.t() | nil,
            data_lines: [String.t()],
            last_event_id: String.t() | nil,
            retry: non_neg_integer() | nil
          }

    defstruct buffer: "",
              event_type: nil,
              data_lines: [],
              last_event_id: nil,
              retry: nil
  end

  @type event :: %{
          data: String.t(),
          type: String.t(),
          id: String.t() | nil,
          retry: non_neg_integer() | nil
        }

  @doc """
  Creates a new parser state.
  """
  @spec new() :: Parser.t()
  def new, do: %Parser{}

  @doc """
  Returns the last event ID from the parser state.

  This can be used for reconnection with the `Last-Event-ID` header.
  """
  @spec last_event_id(Parser.t()) :: String.t() | nil
  def last_event_id(%Parser{last_event_id: id}), do: id

  @doc """
  Feeds a chunk of data to the parser and returns parsed events.

  Returns a tuple of `{events, updated_parser}` where events is a list
  of parsed SSE events and updated_parser contains any incomplete data
  buffered for the next chunk.

  ## Examples

      iex> parser = AgUI.Transport.SSE.new()
      iex> {events, _parser} = AgUI.Transport.SSE.feed(parser, "data: hello\\n\\n")
      iex> hd(events).data
      "hello"

  """
  @spec feed(Parser.t(), String.t()) :: {[event()], Parser.t()}
  def feed(%Parser{} = parser, chunk) when is_binary(chunk) do
    buffer = parser.buffer <> chunk
    {lines, remaining} = split_lines(buffer)

    {events, parser} =
      Enum.reduce(lines, {[], parser}, fn line, {events, p} ->
        {new_events, new_parser} = parse_line(line, p)
        {events ++ new_events, new_parser}
      end)

    {events, %{parser | buffer: remaining}}
  end

  @doc """
  Finalizes the parser, returning any pending events.

  Call this when the stream ends to flush any remaining buffered data.
  """
  @spec finalize(Parser.t()) :: {[event()], Parser.t()}
  def finalize(%Parser{} = parser) do
    if parser.buffer != "" or parser.data_lines != [] do
      {events, parser} =
        case parser.buffer do
          "" -> {[], parser}
          buffer -> parse_line(buffer, parser)
        end

      {final_events, parser} = dispatch_event(parser)
      {events ++ final_events, %{parser | buffer: ""}}
    else
      {[], parser}
    end
  end

  @doc """
  Creates a stream of SSE events from an enumerable of chunks.

  ## Options

  - `:parser` - Initial parser state (defaults to a new parser)

  ## Examples

      chunk_stream
      |> AgUI.Transport.SSE.stream_events()
      |> Enum.each(fn event -> IO.puts(event.data) end)

  """
  @spec stream_events(Enumerable.t(), keyword()) :: Enumerable.t()
  def stream_events(enum, opts \\ []) do
    parser = Keyword.get(opts, :parser, new())

    Stream.transform(
      enum,
      fn -> parser end,
      fn chunk, parser ->
        {events, parser} = feed(parser, chunk)
        {events, parser}
      end,
      fn parser ->
        {events, _parser} = finalize(parser)
        {events, nil}
      end,
      fn _ -> :ok end
    )
  end

  @doc """
  Decodes all events from a complete SSE body string.

  ## Examples

      iex> events = AgUI.Transport.SSE.decode_events("data: event1\\n\\ndata: event2\\n\\n")
      iex> Enum.map(events, & &1.data)
      ["event1", "event2"]

  """
  @spec decode_events(String.t()) :: [event()]
  def decode_events(body) when is_binary(body) do
    {events, parser} = feed(new(), body)
    {final_events, _} = finalize(parser)
    events ++ final_events
  end

  defp split_lines(buffer) do
    do_split_lines(buffer, [])
  end

  defp do_split_lines(buffer, acc) do
    case :binary.match(buffer, "\n") do
      {idx, 1} ->
        line = :binary.part(buffer, 0, idx)
        rest = :binary.part(buffer, idx + 1, byte_size(buffer) - idx - 1)

        line =
          case line do
            <<>> ->
              line

            _ ->
              if :binary.last(line) == ?\r do
                :binary.part(line, 0, byte_size(line) - 1)
              else
                line
              end
          end

        do_split_lines(rest, [line | acc])

      :nomatch ->
        {Enum.reverse(acc), buffer}
    end
  end

  # Parse a single line according to SSE spec
  defp parse_line(<<>>, parser) do
    dispatch_event(parser)
  end

  defp parse_line(<<?:, _rest::binary>>, parser) do
    {[], parser}
  end

  defp parse_line(line, parser) do
    case :binary.match(line, ":") do
      {idx, 1} ->
        field = :binary.part(line, 0, idx)
        value = :binary.part(line, idx + 1, byte_size(line) - idx - 1)
        value = remove_leading_space(value)
        {[], process_field(field, value, parser)}

      :nomatch ->
        {[], process_field(line, "", parser)}
    end
  end

  defp remove_leading_space(<<" ", rest::binary>>), do: rest
  defp remove_leading_space(value), do: value

  defp process_field("event", value, parser) do
    %{parser | event_type: value}
  end

  defp process_field("data", value, parser) do
    %{parser | data_lines: parser.data_lines ++ [value]}
  end

  defp process_field("id", value, parser) do
    if :binary.match(value, <<0>>) != :nomatch do
      parser
    else
      %{parser | last_event_id: value}
    end
  end

  defp process_field("retry", value, parser) do
    case Integer.parse(value) do
      {ms, ""} when ms >= 0 ->
        %{parser | retry: ms}

      _ ->
        parser
    end
  end

  defp process_field(_field, _value, parser) do
    parser
  end

  # Dispatch a complete event and reset event-specific state
  defp dispatch_event(parser) do
    if parser.data_lines == [] do
      {[], reset_event_state(parser)}
    else
      event = %{
        data: Enum.join(parser.data_lines, "\n"),
        type: parser.event_type || "message",
        id: parser.last_event_id,
        retry: parser.retry
      }

      {[event], reset_event_state(parser)}
    end
  end

  defp reset_event_state(parser) do
    %{parser | event_type: nil, data_lines: [], retry: nil}
  end
end
