defmodule AgUI.Client.HttpAgent do
  @moduledoc """
  HTTP client for AG-UI agent endpoints.

  Connects to agent endpoints via HTTP POST with SSE streaming response.
  This is the primary client for consuming AG-UI protocol events.

  ## Usage

      # Create an agent client
      agent = AgUI.Client.HttpAgent.new(url: "https://api.example.com/agent")

      # Create run input
      input = AgUI.Types.RunAgentInput.new("thread-1", "run-1",
        messages: [%AgUI.Types.Message.User{id: "1", role: :user, content: "Hello"}]
      )

      # Stream events
      {:ok, stream} = AgUI.Client.HttpAgent.stream(agent, input)
      Enum.each(stream, fn event ->
        IO.inspect(event)
      end)

  ## Options

  - `:url` - Required. The agent endpoint URL
  - `:headers` - Additional HTTP headers to send
  - `:timeout` - Request timeout in milliseconds (default: 60_000)

  """

  alias AgUI.Types.RunAgentInput
  alias AgUI.Transport.SSE
  alias AgUI.Events
  alias AgUI.Client.RunResult
  alias AgUI.Session
  alias AgUI.Reducer

  @type t :: %__MODULE__{
          url: String.t(),
          headers: [{String.t(), String.t()}],
          timeout: non_neg_integer()
        }

  defstruct [:url, headers: [], timeout: 60_000]

  @doc """
  Creates a new HTTP agent client.

  ## Options

  - `:url` - Required. The agent endpoint URL
  - `:headers` - Additional HTTP headers (default: [])
  - `:timeout` - Request timeout in milliseconds (default: 60_000)

  ## Examples

      iex> agent = AgUI.Client.HttpAgent.new(url: "https://api.example.com/agent")
      %AgUI.Client.HttpAgent{url: "https://api.example.com/agent"}

      iex> agent = AgUI.Client.HttpAgent.new(
      ...>   url: "https://api.example.com/agent",
      ...>   headers: [{"authorization", "Bearer token"}],
      ...>   timeout: 120_000
      ...> )

  """
  @spec new(keyword()) :: t()
  def new(opts) do
    %__MODULE__{
      url: Keyword.fetch!(opts, :url),
      headers: Keyword.get(opts, :headers, []),
      timeout: Keyword.get(opts, :timeout, 60_000)
    }
  end

  @doc """
  Streams raw SSE events from the agent.

  Returns `{:ok, stream}` where stream is an enumerable of raw SSE event maps,
  or `{:error, reason}` if the connection fails.

  For decoded AG-UI events, use `stream/2` instead.

  ## Options

  - `:last_event_id` - Value for the `Last-Event-ID` header (SSE resume)
  - `:accept` - Override Accept header (default: "text/event-stream")

  ## Examples

      {:ok, stream} = AgUI.Client.HttpAgent.stream_raw(agent, input)
      Enum.each(stream, fn sse_event ->
        IO.puts(sse_event.data)
      end)

  """
  @spec stream_raw(t(), RunAgentInput.t()) :: {:ok, Enumerable.t()} | {:error, term()}
  def stream_raw(%__MODULE__{} = agent, %RunAgentInput{} = input) do
    stream_raw(agent, input, [])
  end

  @spec stream_raw(t(), RunAgentInput.t(), keyword()) :: {:ok, Enumerable.t()} | {:error, term()}
  def stream_raw(%__MODULE__{} = agent, %RunAgentInput{} = input, opts) do
    last_event_id = Keyword.get(opts, :last_event_id)
    accept = Keyword.get(opts, :accept, "text/event-stream")
    body = RunAgentInput.to_map(input) |> Jason.encode!()

    headers =
      [
        {"content-type", "application/json"},
        {"accept", accept}
      ]
      |> maybe_add_last_event_id(last_event_id)
      |> Kernel.++(agent.headers)

    req =
      Req.new(
        url: agent.url,
        method: :post,
        body: body,
        headers: headers,
        receive_timeout: agent.timeout,
        into: :self
      )

    case Req.request(req) do
      {:ok, %Req.Response{status: status, body: %Req.Response.Async{}} = resp}
      when status in 200..299 ->
        case ensure_sse_content_type(resp) do
          :ok ->
            {:ok, build_sse_stream(resp)}

          {:error, reason} ->
            Req.cancel_async_response(resp)
            {:error, reason}
        end

      {:ok, %Req.Response{status: status, body: %Req.Response.Async{}} = resp} ->
        # Cancel the async stream before returning error
        Req.cancel_async_response(resp)
        {:error, {:http_error, status, nil}}

      {:ok, %Req.Response{status: status} = resp} when status in 200..299 ->
        case ensure_sse_content_type(resp) do
          :ok -> {:error, {:unexpected_body, resp.body}}
          {:error, reason} -> {:error, reason}
        end

      {:ok, %Req.Response{status: status, body: body}} ->
        {:error, {:http_error, status, body}}

      {:error, %Req.TransportError{reason: reason}} ->
        {:error, {:transport_error, reason}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  @doc """
  Streams decoded AG-UI events from the agent.

  Returns `{:ok, stream}` where stream is an enumerable of decoded AG-UI event structs,
  or `{:error, reason}` if the connection fails.

  Unknown or malformed events are silently skipped.

  ## Options

  - `:last_event_id` - Value for the `Last-Event-ID` header (SSE resume)

  ## Examples

      {:ok, stream} = AgUI.Client.HttpAgent.stream(agent, input)
      Enum.each(stream, fn event ->
        case event do
          %AgUI.Events.TextMessageContent{delta: delta} ->
            IO.write(delta)
          %AgUI.Events.RunFinished{} ->
            IO.puts("\\nDone!")
          _ ->
            :ok
        end
      end)

  """
  @spec stream(t(), RunAgentInput.t()) :: {:ok, Enumerable.t()} | {:error, term()}
  def stream(%__MODULE__{} = agent, %RunAgentInput{} = input) do
    stream(agent, input, [])
  end

  @spec stream(t(), RunAgentInput.t(), keyword()) :: {:ok, Enumerable.t()} | {:error, term()}
  def stream(%__MODULE__{} = agent, %RunAgentInput{} = input, opts) do
    case stream_raw(agent, input, opts) do
      {:ok, sse_stream} ->
        event_stream =
          sse_stream
          |> Stream.flat_map(&decode_sse_event/1)

        {:ok, event_stream}

      error ->
        error
    end
  end

  @doc """
  Streams canonical AG-UI events from the agent.

  This is similar to `stream/2` but expands any chunk events (TEXT_MESSAGE_CHUNK,
  TOOL_CALL_CHUNK) into their canonical start/content/end triads using
  `AgUI.Normalize.expand_stream/1`.

  This is the recommended function for UI rendering, as it provides a consistent
  event structure.

  ## Options

  - `:last_event_id` - Value for the `Last-Event-ID` header (SSE resume)
  - `:on_error` - `:raise` (default) or `:run_error`

  ## Examples

      {:ok, stream} = AgUI.Client.HttpAgent.stream_canonical(agent, input)
      Enum.each(stream, fn event ->
        case event do
          %AgUI.Events.TextMessageStart{} -> IO.puts("Message started")
          %AgUI.Events.TextMessageContent{delta: delta} -> IO.write(delta)
          %AgUI.Events.TextMessageEnd{} -> IO.puts("")
          _ -> :ok
        end
      end)

  """
  @spec stream_canonical(t(), RunAgentInput.t()) :: {:ok, Enumerable.t()} | {:error, term()}
  def stream_canonical(%__MODULE__{} = agent, %RunAgentInput{} = input) do
    stream_canonical(agent, input, [])
  end

  @spec stream_canonical(t(), RunAgentInput.t(), keyword()) ::
          {:ok, Enumerable.t()} | {:error, term()}
  def stream_canonical(%__MODULE__{} = agent, %RunAgentInput{} = input, opts) do
    on_error = Keyword.get(opts, :on_error, :raise)

    case stream(agent, input, opts) do
      {:ok, event_stream} ->
        canonical_stream =
          case on_error do
            :run_error -> AgUI.Normalize.expand_stream_safe(event_stream)
            _ -> AgUI.Normalize.expand_stream(event_stream)
          end

        {:ok, canonical_stream}

      error ->
        error
    end
  end

  @doc """
  Streams decoded AG-UI events, raising on connection error.

  ## Examples

      stream = AgUI.Client.HttpAgent.stream!(agent, input)
      Enum.each(stream, fn event -> ... end)

  """
  @spec stream!(t(), RunAgentInput.t()) :: Enumerable.t()
  def stream!(%__MODULE__{} = agent, %RunAgentInput{} = input) do
    case stream(agent, input) do
      {:ok, stream} -> stream
      {:error, reason} -> raise "Failed to connect to agent: #{inspect(reason)}"
    end
  end

  @doc """
  Collects all events from a run into a list.

  This is a convenience function that consumes the entire stream.
  For large streams, prefer using `stream/2` directly.

  ## Examples

      {:ok, events} = AgUI.Client.HttpAgent.run(agent, input)
      Enum.each(events, &IO.inspect/1)

  """
  @spec run(t(), RunAgentInput.t()) :: {:ok, [Events.t()]} | {:error, term()}
  def run(%__MODULE__{} = agent, %RunAgentInput{} = input) do
    case stream(agent, input) do
      {:ok, stream} ->
        events = Enum.to_list(stream)
        {:ok, events}

      error ->
        error
    end
  end

  @doc """
  Runs an agent and returns a high-level result.

  The result includes the final session, and `new_messages` that were added
  during the run (excluding any input messages by ID).

  ## Options

  - `:last_event_id` - Value for the `Last-Event-ID` header (SSE resume)
  - `:on_error` - `:raise` (default) or `:run_error` for chunk normalization
  - `:accept` - Override Accept header (default: "text/event-stream")

  ## Examples

      {:ok, result} = AgUI.Client.HttpAgent.run_agent(agent, input)
      IO.inspect(result.new_messages)
  """
  @spec run_agent(t(), RunAgentInput.t(), keyword()) :: {:ok, RunResult.t()} | {:error, term()}
  def run_agent(%__MODULE__{} = agent, %RunAgentInput{} = input, opts \\ []) do
    initial_session = seed_session(input)
    initial_ids = MapSet.new(Enum.map(input.messages, & &1.id))

    case stream_canonical(agent, input, opts) do
      {:ok, stream} ->
        {session, result} =
          Enum.reduce(stream, {initial_session, nil}, fn event, {session, result} ->
            result =
              case event do
                %Events.RunFinished{result: res} -> res
                _ -> result
              end

            {Reducer.apply(session, event), result}
          end)

        new_messages =
          session.messages
          |> Enum.filter(fn msg -> not MapSet.member?(initial_ids, msg.id) end)

        {:ok, %RunResult{result: result, new_messages: new_messages, session: session}}

      error ->
        error
    end
  end

  @doc """
  Runs an agent and returns a high-level result, raising on error.

  ## Examples

      result = AgUI.Client.HttpAgent.run_agent!(agent, input)
      IO.inspect(result.new_messages)
  """
  @spec run_agent!(t(), RunAgentInput.t(), keyword()) :: RunResult.t()
  def run_agent!(%__MODULE__{} = agent, %RunAgentInput{} = input, opts \\ []) do
    case run_agent(agent, input, opts) do
      {:ok, result} -> result
      {:error, reason} -> raise "Failed to run agent: #{inspect(reason)}"
    end
  end

  # Build a stream from Req's async response
  defp build_sse_stream(%Req.Response{body: %Req.Response.Async{} = async}) do
    ref = async.ref

    Stream.resource(
      fn -> {ref, SSE.new()} end,
      fn
        {ref, :done} ->
          {:halt, {ref, :done}}

        {ref, parser} ->
          receive do
            {^ref, {:data, chunk}} ->
              {events, parser} = SSE.feed(parser, chunk)
              {events, {ref, parser}}

            {^ref, :done} ->
              {final_events, _parser} = SSE.finalize(parser)
              {final_events, {ref, :done}}

            {^ref, {:error, reason}} ->
              throw({:stream_error, reason})
          after
            # Use a long timeout since we're waiting for streaming data
            300_000 ->
              throw(:stream_timeout)
          end
      end,
      fn _ -> :ok end
    )
  end

  # Decode SSE event data as JSON and then as AG-UI event
  defp decode_sse_event(%{data: data}) do
    with {:ok, json} <- Jason.decode(data),
         {:ok, event} <- Events.decode(json) do
      [event]
    else
      _ -> []
    end
  end

  defp maybe_add_last_event_id(headers, nil), do: headers
  defp maybe_add_last_event_id(headers, ""), do: headers

  defp maybe_add_last_event_id(headers, last_event_id) when is_binary(last_event_id) do
    headers ++ [{"last-event-id", last_event_id}]
  end

  defp seed_session(%RunAgentInput{} = input) do
    %Session{
      Session.new(input.thread_id, input.run_id)
      | messages: input.messages,
        state: input.state
    }
  end

  defp ensure_sse_content_type(%Req.Response{headers: headers}) do
    content_type =
      headers
      |> Enum.find_value(fn {k, v} ->
        if String.downcase(k) == "content-type" do
          case v do
            [h | _] -> h
            h when is_binary(h) -> h
            _ -> nil
          end
        else
          nil
        end
      end)

    cond do
      is_nil(content_type) ->
        {:error, :missing_content_type}

      String.contains?(String.downcase(content_type), "text/event-stream") ->
        :ok

      String.contains?(String.downcase(content_type), "application/vnd.ag-ui.event+proto") ->
        {:error, {:unsupported_transport, :proto, content_type}}

      true ->
        {:error, {:unsupported_content_type, content_type}}
    end
  end
end
