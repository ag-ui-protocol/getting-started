defmodule AgUI.Client.HttpAgentTest do
  use ExUnit.Case, async: false

  alias AgUI.Client.HttpAgent
  alias AgUI.Types.RunAgentInput
  alias AgUI.Events

  # We'll use a simple Plug-based mock server for testing
  defmodule MockAgentPlug do
    import Plug.Conn

    def init(opts), do: opts

    def call(conn, _opts) do
      conn = fetch_query_params(conn)
      {:ok, body, conn} = read_body(conn)
      {:ok, input} = Jason.decode(body)

      scenario = conn.query_params["scenario"] || "basic"

      case scenario do
        "proto" ->
          conn
          |> put_resp_content_type("application/vnd.ag-ui.event+proto")
          |> send_resp(200, <<0, 1, 2>>)

        _ ->
          conn
          |> put_resp_content_type("text/event-stream")
          |> put_resp_header("cache-control", "no-cache")
          |> send_chunked(200)
          |> stream_scenario(scenario, input)
      end
    end

    defp stream_scenario(conn, "basic", input) do
      events = [
        %{
          "type" => "RUN_STARTED",
          "threadId" => input["threadId"],
          "runId" => input["runId"]
        },
        %{
          "type" => "TEXT_MESSAGE_START",
          "messageId" => "msg-1",
          "role" => "assistant"
        },
        %{
          "type" => "TEXT_MESSAGE_CONTENT",
          "messageId" => "msg-1",
          "delta" => "Hello!"
        },
        %{
          "type" => "TEXT_MESSAGE_END",
          "messageId" => "msg-1"
        },
        %{
          "type" => "RUN_FINISHED",
          "threadId" => input["threadId"],
          "runId" => input["runId"]
        }
      ]

      Enum.reduce_while(events, conn, fn event, conn ->
        data = Jason.encode!(event)

        case chunk(conn, "data: #{data}\n\n") do
          {:ok, conn} -> {:cont, conn}
          {:error, _} -> {:halt, conn}
        end
      end)
    end

    defp stream_scenario(conn, "resume", _input) do
      last_event_id = get_req_header(conn, "last-event-id") |> List.first()

      if is_nil(last_event_id) do
        conn
        |> send_resp(400, "missing last-event-id")
      else
        events = [
          {%{"type" => "RUN_STARTED", "threadId" => "t", "runId" => "r"}, last_event_id}
        ]

        Enum.reduce_while(events, conn, fn {event, id}, conn ->
          data = Jason.encode!(event)

          chunk_data = "id: #{id}\n" <> "data: #{data}\n\n"

          case chunk(conn, chunk_data) do
            {:ok, conn} -> {:cont, conn}
            {:error, _} -> {:halt, conn}
          end
        end)
      end
    end

    defp stream_scenario(conn, "id_propagation", _input) do
      events = [
        {"evt-1", %{"type" => "RUN_STARTED", "threadId" => "t", "runId" => "r"}},
        {nil, %{"type" => "RUN_FINISHED", "threadId" => "t", "runId" => "r"}}
      ]

      Enum.reduce_while(events, conn, fn {id, event}, conn ->
        data = Jason.encode!(event)

        chunk_data =
          case id do
            nil -> "data: #{data}\n\n"
            _ -> "id: #{id}\n" <> "data: #{data}\n\n"
          end

        case chunk(conn, chunk_data) do
          {:ok, conn} -> {:cont, conn}
          {:error, _} -> {:halt, conn}
        end
      end)
    end

    defp stream_scenario(conn, "tool_call", input) do
      events = [
        %{
          "type" => "RUN_STARTED",
          "threadId" => input["threadId"],
          "runId" => input["runId"]
        },
        %{
          "type" => "TOOL_CALL_START",
          "toolCallId" => "call-1",
          "toolCallName" => "get_weather"
        },
        %{
          "type" => "TOOL_CALL_ARGS",
          "toolCallId" => "call-1",
          "delta" => ~s({"location": "SF"})
        },
        %{
          "type" => "TOOL_CALL_END",
          "toolCallId" => "call-1"
        },
        %{
          "type" => "RUN_FINISHED",
          "threadId" => input["threadId"],
          "runId" => input["runId"]
        }
      ]

      Enum.reduce_while(events, conn, fn event, conn ->
        data = Jason.encode!(event)

        case chunk(conn, "data: #{data}\n\n") do
          {:ok, conn} -> {:cont, conn}
          {:error, _} -> {:halt, conn}
        end
      end)
    end

    defp stream_scenario(conn, "bad_chunk", _input) do
      events = [
        %{
          "type" => "TEXT_MESSAGE_CHUNK",
          "delta" => "oops"
        }
      ]

      Enum.reduce_while(events, conn, fn event, conn ->
        data = Jason.encode!(event)

        case chunk(conn, "data: #{data}\n\n") do
          {:ok, conn} -> {:cont, conn}
          {:error, _} -> {:halt, conn}
        end
      end)
    end

    defp stream_scenario(conn, "empty", _input) do
      conn
    end

    defp stream_scenario(conn, "chunks", input) do
      # Uses TEXT_MESSAGE_CHUNK events that need expansion
      events = [
        %{
          "type" => "RUN_STARTED",
          "threadId" => input["threadId"],
          "runId" => input["runId"]
        },
        %{
          "type" => "TEXT_MESSAGE_CHUNK",
          "messageId" => "msg-1",
          "role" => "assistant",
          "delta" => "Hello "
        },
        %{
          "type" => "TEXT_MESSAGE_CHUNK",
          "messageId" => "msg-1",
          "delta" => "world!"
        },
        %{
          "type" => "RUN_FINISHED",
          "threadId" => input["threadId"],
          "runId" => input["runId"]
        }
      ]

      Enum.reduce_while(events, conn, fn event, conn ->
        data = Jason.encode!(event)

        case chunk(conn, "data: #{data}\n\n") do
          {:ok, conn} -> {:cont, conn}
          {:error, _} -> {:halt, conn}
        end
      end)
    end

    defp stream_scenario(conn, "error", _input) do
      events = [
        %{
          "type" => "RUN_ERROR",
          "message" => "Something went wrong",
          "code" => "E001"
        }
      ]

      Enum.reduce_while(events, conn, fn event, conn ->
        data = Jason.encode!(event)

        case chunk(conn, "data: #{data}\n\n") do
          {:ok, conn} -> {:cont, conn}
          {:error, _} -> {:halt, conn}
        end
      end)
    end

    defp stream_scenario(conn, "delayed", input) do
      events = [
        %{
          "type" => "RUN_STARTED",
          "threadId" => input["threadId"],
          "runId" => input["runId"]
        }
      ]

      conn =
        Enum.reduce_while(events, conn, fn event, conn ->
          Process.sleep(10)
          data = Jason.encode!(event)

          case chunk(conn, "data: #{data}\n\n") do
            {:ok, conn} -> {:cont, conn}
            {:error, _} -> {:halt, conn}
          end
        end)

      finish_event = %{
        "type" => "RUN_FINISHED",
        "threadId" => input["threadId"],
        "runId" => input["runId"]
      }

      case chunk(conn, "data: #{Jason.encode!(finish_event)}\n\n") do
        {:ok, conn} -> conn
        {:error, _} -> conn
      end
    end
  end

  setup_all do
    # Start the mock server
    {:ok, _pid} =
      Bandit.start_link(
        plug: MockAgentPlug,
        port: 4111,
        ip: {127, 0, 0, 1}
      )

    :ok
  end

  describe "new/1" do
    test "creates agent with required url" do
      agent = HttpAgent.new(url: "http://localhost:4000/agent")
      assert agent.url == "http://localhost:4000/agent"
      assert agent.headers == []
      assert agent.timeout == 60_000
    end

    test "creates agent with custom headers and timeout" do
      agent =
        HttpAgent.new(
          url: "http://localhost:4000/agent",
          headers: [{"authorization", "Bearer token"}],
          timeout: 120_000
        )

      assert agent.headers == [{"authorization", "Bearer token"}]
      assert agent.timeout == 120_000
    end

    test "raises for missing url" do
      assert_raise KeyError, fn ->
        HttpAgent.new([])
      end
    end
  end

  describe "stream/2" do
    test "streams basic events" do
      agent = HttpAgent.new(url: "http://127.0.0.1:4111/?scenario=basic")
      input = RunAgentInput.new("thread-1", "run-1")

      {:ok, stream} = HttpAgent.stream(agent, input)
      events = Enum.to_list(stream)

      assert length(events) == 5

      assert %Events.RunStarted{thread_id: "thread-1", run_id: "run-1"} = Enum.at(events, 0)
      assert %Events.TextMessageStart{message_id: "msg-1"} = Enum.at(events, 1)
      assert %Events.TextMessageContent{delta: "Hello!"} = Enum.at(events, 2)
      assert %Events.TextMessageEnd{message_id: "msg-1"} = Enum.at(events, 3)
      assert %Events.RunFinished{thread_id: "thread-1", run_id: "run-1"} = Enum.at(events, 4)
    end

    test "streams tool call events" do
      agent = HttpAgent.new(url: "http://127.0.0.1:4111/?scenario=tool_call")
      input = RunAgentInput.new("thread-1", "run-1")

      {:ok, stream} = HttpAgent.stream(agent, input)
      events = Enum.to_list(stream)

      assert length(events) == 5

      assert %Events.ToolCallStart{tool_call_name: "get_weather"} = Enum.at(events, 1)
      assert %Events.ToolCallArgs{delta: ~s({"location": "SF"})} = Enum.at(events, 2)
      assert %Events.ToolCallEnd{tool_call_id: "call-1"} = Enum.at(events, 3)
    end

    test "handles error events" do
      agent = HttpAgent.new(url: "http://127.0.0.1:4111/?scenario=error")
      input = RunAgentInput.new("thread-1", "run-1")

      {:ok, stream} = HttpAgent.stream(agent, input)
      events = Enum.to_list(stream)

      assert length(events) == 1
      assert %Events.RunError{message: "Something went wrong", code: "E001"} = hd(events)
    end

    test "handles empty stream" do
      agent = HttpAgent.new(url: "http://127.0.0.1:4111/?scenario=empty")
      input = RunAgentInput.new("thread-1", "run-1")

      {:ok, stream} = HttpAgent.stream(agent, input)
      events = Enum.to_list(stream)

      assert events == []
    end

    test "handles delayed events" do
      agent = HttpAgent.new(url: "http://127.0.0.1:4111/?scenario=delayed")
      input = RunAgentInput.new("thread-1", "run-1")

      {:ok, stream} = HttpAgent.stream(agent, input)
      events = Enum.to_list(stream)

      assert length(events) == 2
      assert %Events.RunStarted{} = hd(events)
      assert %Events.RunFinished{} = List.last(events)
    end

    test "returns error for connection failure" do
      agent = HttpAgent.new(url: "http://127.0.0.1:59999/nonexistent")
      input = RunAgentInput.new("thread-1", "run-1")

      assert {:error, _reason} = HttpAgent.stream(agent, input)
    end
  end

  describe "stream!/2" do
    test "returns stream on success" do
      agent = HttpAgent.new(url: "http://127.0.0.1:4111/?scenario=basic")
      input = RunAgentInput.new("thread-1", "run-1")

      stream = HttpAgent.stream!(agent, input)
      events = Enum.to_list(stream)

      assert length(events) == 5
    end

    test "raises on connection failure" do
      agent = HttpAgent.new(url: "http://127.0.0.1:59999/nonexistent")
      input = RunAgentInput.new("thread-1", "run-1")

      assert_raise RuntimeError, ~r/Failed to connect/, fn ->
        HttpAgent.stream!(agent, input)
      end
    end
  end

  describe "run/2" do
    test "collects all events" do
      agent = HttpAgent.new(url: "http://127.0.0.1:4111/?scenario=basic")
      input = RunAgentInput.new("thread-1", "run-1")

      {:ok, events} = HttpAgent.run(agent, input)

      assert length(events) == 5
      assert %Events.RunStarted{} = hd(events)
      assert %Events.RunFinished{} = List.last(events)
    end

    test "returns error for connection failure" do
      agent = HttpAgent.new(url: "http://127.0.0.1:59999/nonexistent")
      input = RunAgentInput.new("thread-1", "run-1")

      assert {:error, _reason} = HttpAgent.run(agent, input)
    end
  end

  describe "run_agent/3" do
    test "returns result with new messages and session" do
      agent = HttpAgent.new(url: "http://127.0.0.1:4111/?scenario=basic")

      input =
        RunAgentInput.new("thread-1", "run-1",
          messages: [%AgUI.Types.Message.User{id: "user-1", role: :user, content: "Hi"}]
        )

      {:ok, result} = HttpAgent.run_agent(agent, input)

      assert %AgUI.Client.RunResult{} = result
      assert result.result == nil
      assert result.session.thread_id == "thread-1"
      assert result.session.run_id == "run-1"
      # Excludes input message by ID
      refute Enum.any?(result.new_messages, &(&1.id == "user-1"))
      # Includes assistant message from stream
      assert Enum.any?(result.new_messages, &(&1.id == "msg-1"))
    end
  end

  describe "stream_raw/2" do
    test "returns raw SSE events" do
      agent = HttpAgent.new(url: "http://127.0.0.1:4111/?scenario=basic")
      input = RunAgentInput.new("thread-1", "run-1")

      {:ok, stream} = HttpAgent.stream_raw(agent, input)
      events = Enum.to_list(stream)

      assert length(events) == 5

      # Raw events have :data, :type, :id fields
      assert is_binary(hd(events).data)
      {:ok, parsed} = Jason.decode(hd(events).data)
      assert parsed["type"] == "RUN_STARTED"
    end

    test "returns error for unsupported proto transport" do
      agent = HttpAgent.new(url: "http://127.0.0.1:4111/?scenario=proto")
      input = RunAgentInput.new("thread-1", "run-1")

      assert {:error, {:unsupported_transport, :proto, _}} =
               HttpAgent.stream_raw(agent, input)
    end

    test "propagates SSE id across events" do
      agent = HttpAgent.new(url: "http://127.0.0.1:4111/?scenario=id_propagation")
      input = RunAgentInput.new("thread-1", "run-1")

      {:ok, stream} = HttpAgent.stream_raw(agent, input)
      events = Enum.to_list(stream)

      assert [%{id: "evt-1"}, %{id: "evt-1"}] = events
    end
  end

  describe "Last-Event-ID resume" do
    test "sends last-event-id header and parses id" do
      agent = HttpAgent.new(url: "http://127.0.0.1:4111/?scenario=resume")
      input = RunAgentInput.new("thread-1", "run-1")

      {:ok, stream} = HttpAgent.stream_raw(agent, input, last_event_id: "evt-123")
      events = Enum.to_list(stream)

      assert [%{id: "evt-123"}] = events
    end
  end

  describe "with custom headers" do
    test "sends custom headers with request" do
      # The mock server doesn't validate headers, but we ensure they're set
      agent =
        HttpAgent.new(
          url: "http://127.0.0.1:4111/?scenario=basic",
          headers: [{"x-custom-header", "test-value"}]
        )

      input = RunAgentInput.new("thread-1", "run-1")

      {:ok, events} = HttpAgent.run(agent, input)
      assert length(events) == 5
    end
  end

  describe "stream_canonical/2" do
    test "expands chunk events to canonical form" do
      agent = HttpAgent.new(url: "http://127.0.0.1:4111/?scenario=chunks")
      input = RunAgentInput.new("thread-1", "run-1")

      {:ok, stream} = HttpAgent.stream_canonical(agent, input)
      events = Enum.to_list(stream)

      # Chunks expand to START, CONTENT, CONTENT, END
      # Plus RUN_STARTED closes the pending text at the start, and RUN_FINISHED closes at end
      types = Enum.map(events, & &1.type)

      assert types == [
               :run_started,
               :text_message_start,
               :text_message_content,
               :text_message_content,
               :text_message_end,
               :run_finished
             ]

      # Verify content deltas
      content_events = Enum.filter(events, &(&1.type == :text_message_content))
      assert length(content_events) == 2
      assert Enum.at(content_events, 0).delta == "Hello "
      assert Enum.at(content_events, 1).delta == "world!"
    end

    test "returns error for connection failure" do
      agent = HttpAgent.new(url: "http://127.0.0.1:59999/nonexistent")
      input = RunAgentInput.new("thread-1", "run-1")

      assert {:error, _reason} = HttpAgent.stream_canonical(agent, input)
    end

    test "default on_error raises on malformed chunk" do
      agent = HttpAgent.new(url: "http://127.0.0.1:4111/?scenario=bad_chunk")
      input = RunAgentInput.new("thread-1", "run-1")

      {:ok, stream} = HttpAgent.stream_canonical(agent, input)

      assert_raise ArgumentError, ~r/missing required messageId/, fn ->
        Enum.to_list(stream)
      end
    end

    test "on_error: :run_error emits RunError for malformed chunk" do
      agent = HttpAgent.new(url: "http://127.0.0.1:4111/?scenario=bad_chunk")
      input = RunAgentInput.new("thread-1", "run-1")

      {:ok, stream} = HttpAgent.stream_canonical(agent, input, on_error: :run_error)
      events = Enum.to_list(stream)

      assert [%Events.RunError{message: message}] = events
      assert message =~ "missing required messageId"
    end
  end
end
