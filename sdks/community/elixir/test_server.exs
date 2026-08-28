#!/usr/bin/env elixir
# AG-UI Protocol Test Server
#
# A simple SSE server that emits AG-UI protocol events for testing.
# Similar to the Go SDK's example server.
#
# Usage:
#   elixir test_server.exs [port]
#
# Default port is 4001

Mix.install([
  {:ag_ui, path: "."},
  {:bandit, "~> 1.5"},
  {:plug, "~> 1.16"}
])

defmodule AgUITestServer do
  @moduledoc """
  A test server that emits AG-UI protocol events over SSE.

  Endpoints:
  - POST /agent - Main agent endpoint (streams SSE events)
  - GET /health - Health check
  """

  use Plug.Router
  require Logger

  alias AgUI.Events.{
    RunStarted,
    RunFinished,
    StepStarted,
    StepFinished,
    TextMessageStart,
    TextMessageContent,
    TextMessageEnd,
    ToolCallStart,
    ToolCallArgs,
    ToolCallEnd,
    ToolCallResult,
    StateSnapshot,
    StateDelta
  }

  alias AgUI.Transport.SSE.Writer

  plug(Plug.Logger)
  plug(:match)
  plug(Plug.Parsers, parsers: [:json], json_decoder: Jason)
  plug(:dispatch)

  get "/health" do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(200, Jason.encode!(%{status: "ok"}))
  end

  get "/" do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(200, Jason.encode!(%{message: "AG-UI Elixir Test Server is running!"}))
  end

  # Support both /agent and /agentic endpoints for Go SDK compatibility
  post "/agentic" do
    handle_agent_request(conn)
  end

  post "/agent" do
    handle_agent_request(conn)
  end

  defp handle_agent_request(conn) do
    Logger.info("Received agent request")

    input = conn.body_params
    thread_id = input["threadId"] || generate_id("thread")
    run_id = input["runId"] || generate_id("run")
    messages = input["messages"] || []

    # Get last user message content
    user_content =
      messages
      |> Enum.filter(fn m -> m["role"] == "user" end)
      |> List.last()
      |> case do
        nil -> "Hello"
        m -> m["content"] || "Hello"
      end

    # Prepare SSE response
    conn = Writer.prepare_conn(conn)

    # Run the streaming sequence
    stream_agent_response(conn, thread_id, run_id, user_content)
  end

  match _ do
    send_resp(conn, 404, "Not found")
  end

  defp stream_agent_response(conn, thread_id, run_id, user_content) do
    message_id = generate_id("msg")
    tool_call_id = generate_id("call")
    tool_result_message_id = generate_id("msg")

    # RUN_STARTED
    {:ok, conn} =
      Writer.write_event(conn, %RunStarted{
        thread_id: thread_id,
        run_id: run_id,
        timestamp: timestamp()
      })

    :timer.sleep(50)

    # STEP_STARTED - "thinking"
    {:ok, conn} =
      Writer.write_event(conn, %StepStarted{
        step_name: "thinking",
        timestamp: timestamp()
      })

    :timer.sleep(50)

    # TEXT_MESSAGE_START
    {:ok, conn} =
      Writer.write_event(conn, %TextMessageStart{
        message_id: message_id,
        role: "assistant",
        timestamp: timestamp()
      })

    # Stream text content in chunks
    response_text = "Hello! I received your message: \"#{user_content}\". Let me help you with that."

    conn =
      response_text
      |> String.graphemes()
      |> Enum.chunk_every(5)
      |> Enum.map(&Enum.join/1)
      |> Enum.reduce(conn, fn chunk, conn ->
        :timer.sleep(20)

        {:ok, conn} =
          Writer.write_event(conn, %TextMessageContent{
            message_id: message_id,
            delta: chunk,
            timestamp: timestamp()
          })

        conn
      end)

    # TEXT_MESSAGE_END
    {:ok, conn} =
      Writer.write_event(conn, %TextMessageEnd{
        message_id: message_id,
        timestamp: timestamp()
      })

    :timer.sleep(50)

    # STEP_FINISHED - "thinking"
    {:ok, conn} =
      Writer.write_event(conn, %StepFinished{
        step_name: "thinking",
        timestamp: timestamp()
      })

    :timer.sleep(50)

    # STEP_STARTED - "tool_use"
    {:ok, conn} =
      Writer.write_event(conn, %StepStarted{
        step_name: "tool_use",
        timestamp: timestamp()
      })

    # TOOL_CALL_START
    {:ok, conn} =
      Writer.write_event(conn, %ToolCallStart{
        tool_call_id: tool_call_id,
        tool_call_name: "get_current_time",
        parent_message_id: message_id,
        timestamp: timestamp()
      })

    :timer.sleep(30)

    # TOOL_CALL_ARGS - stream the args in chunks
    args_json = ~s({"timezone": "UTC"})

    conn =
      args_json
      |> String.graphemes()
      |> Enum.chunk_every(3)
      |> Enum.map(&Enum.join/1)
      |> Enum.reduce(conn, fn chunk, conn ->
        :timer.sleep(10)

        {:ok, conn} =
          Writer.write_event(conn, %ToolCallArgs{
            tool_call_id: tool_call_id,
            delta: chunk,
            timestamp: timestamp()
          })

        conn
      end)

    # TOOL_CALL_END
    {:ok, conn} =
      Writer.write_event(conn, %ToolCallEnd{
        tool_call_id: tool_call_id,
        timestamp: timestamp()
      })

    :timer.sleep(50)

    # TOOL_CALL_RESULT
    current_time = DateTime.utc_now() |> DateTime.to_iso8601()

    {:ok, conn} =
      Writer.write_event(conn, %ToolCallResult{
        message_id: tool_result_message_id,
        tool_call_id: tool_call_id,
        content: ~s({"time": "#{current_time}"}),
        role: "tool",
        timestamp: timestamp()
      })

    :timer.sleep(50)

    # STEP_FINISHED - "tool_use"
    {:ok, conn} =
      Writer.write_event(conn, %StepFinished{
        step_name: "tool_use",
        timestamp: timestamp()
      })

    :timer.sleep(50)

    # STATE_SNAPSHOT
    {:ok, conn} =
      Writer.write_event(conn, %StateSnapshot{
        snapshot: %{
          "conversation_turn" => 1,
          "last_tool_used" => "get_current_time",
          "user_query" => user_content
        },
        timestamp: timestamp()
      })

    :timer.sleep(30)

    # STATE_DELTA (JSON Patch)
    {:ok, conn} =
      Writer.write_event(conn, %StateDelta{
        delta: [
          %{"op" => "replace", "path" => "/conversation_turn", "value" => 2}
        ],
        timestamp: timestamp()
      })

    :timer.sleep(50)

    # RUN_FINISHED
    {:ok, conn} =
      Writer.write_event(conn, %RunFinished{
        thread_id: thread_id,
        run_id: run_id,
        result: %{"status" => "success"},
        timestamp: timestamp()
      })

    conn
  end

  defp generate_id(prefix) do
    suffix =
      :crypto.strong_rand_bytes(8)
      |> Base.encode16(case: :lower)

    "#{prefix}-#{suffix}"
  end

  defp timestamp do
    System.system_time(:millisecond)
  end
end

# Parse command line args
port =
  case System.argv() do
    [port_str | _] ->
      case Integer.parse(port_str) do
        {port, ""} -> port
        _ -> 4001
      end

    [] ->
      4001
  end

IO.puts("""
============================================
AG-UI Protocol Test Server
============================================
Starting on http://localhost:#{port}

Endpoints:
  POST /agent  - Agent endpoint (SSE stream)
  GET  /health - Health check

Example usage with curl:
  curl -X POST http://localhost:#{port}/agent \\
    -H "Content-Type: application/json" \\
    -H "Accept: text/event-stream" \\
    -d '{"threadId":"t1","runId":"r1","messages":[{"role":"user","content":"Hello!"}]}'

Press Ctrl+C to stop.
============================================
""")

# Start the server
{:ok, _} = Bandit.start_link(plug: AgUITestServer, port: port)

# Keep running
Process.sleep(:infinity)
