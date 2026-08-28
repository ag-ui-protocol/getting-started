#!/usr/bin/env elixir
# AG-UI Protocol Integration Tests
#
# Runs a local test server and client to validate the full protocol flow.
# Similar to the Go SDK's integration tests.
#
# Usage:
#   elixir test_integration.exs

Mix.install([
  {:ag_ui, path: "."},
  {:bandit, "~> 1.5"},
  {:plug, "~> 1.16"}
])

defmodule IntegrationTest.Server do
  @moduledoc """
  Test server that can be configured for different scenarios.
  """

  use Plug.Router
  require Logger

  alias AgUI.Events.{
    RunStarted,
    RunFinished,
    RunError,
    StepStarted,
    StepFinished,
    TextMessageStart,
    TextMessageContent,
    TextMessageEnd,
    TextMessageChunk,
    ToolCallStart,
    ToolCallArgs,
    ToolCallEnd,
    ToolCallChunk,
    ToolCallResult,
    StateSnapshot,
    StateDelta,
    MessagesSnapshot,
    ActivitySnapshot,
    ActivityDelta,
    ThinkingStart,
    ThinkingEnd,
    ThinkingTextMessageStart,
    ThinkingTextMessageContent,
    ThinkingTextMessageEnd,
    Custom,
    Raw
  }

  alias AgUI.Transport.SSE.Writer
  alias AgUI.Types.Message

  plug(:match)
  plug(Plug.Parsers, parsers: [:json], json_decoder: Jason)
  plug(:dispatch)

  # Basic happy path
  post "/agent/basic" do
    conn = Writer.prepare_conn(conn)
    input = conn.body_params
    thread_id = input["threadId"] || "t1"
    run_id = input["runId"] || "r1"

    {:ok, conn} = Writer.write_event(conn, %RunStarted{thread_id: thread_id, run_id: run_id})
    {:ok, conn} = Writer.write_event(conn, %TextMessageStart{message_id: "m1", role: "assistant"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageContent{message_id: "m1", delta: "Hello!"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageEnd{message_id: "m1"})
    {:ok, conn} = Writer.write_event(conn, %RunFinished{thread_id: thread_id, run_id: run_id})
    conn
  end

  # Chunk events (TEXT_MESSAGE_CHUNK / TOOL_CALL_CHUNK)
  post "/agent/chunks" do
    conn = Writer.prepare_conn(conn)
    input = conn.body_params
    thread_id = input["threadId"] || "t1"
    run_id = input["runId"] || "r1"

    {:ok, conn} = Writer.write_event(conn, %RunStarted{thread_id: thread_id, run_id: run_id})

    # Text message chunks
    {:ok, conn} =
      Writer.write_event(conn, %TextMessageChunk{
        message_id: "m1",
        role: "assistant",
        delta: "Hello "
      })

    {:ok, conn} = Writer.write_event(conn, %TextMessageChunk{message_id: "m1", delta: "World!"})

    # Tool call chunks
    {:ok, conn} =
      Writer.write_event(conn, %ToolCallChunk{
        tool_call_id: "tc1",
        tool_call_name: "test_tool",
        delta: "{\"arg\":"
      })

    {:ok, conn} = Writer.write_event(conn, %ToolCallChunk{tool_call_id: "tc1", delta: " 42}"})

    {:ok, conn} = Writer.write_event(conn, %RunFinished{thread_id: thread_id, run_id: run_id})
    conn
  end

  # Tool call flow
  post "/agent/tools" do
    conn = Writer.prepare_conn(conn)
    input = conn.body_params
    thread_id = input["threadId"] || "t1"
    run_id = input["runId"] || "r1"

    {:ok, conn} = Writer.write_event(conn, %RunStarted{thread_id: thread_id, run_id: run_id})

    # Assistant message with tool call
    {:ok, conn} = Writer.write_event(conn, %TextMessageStart{message_id: "m1", role: "assistant"})

    {:ok, conn} =
      Writer.write_event(conn, %TextMessageContent{
        message_id: "m1",
        delta: "I'll check the weather."
      })

    {:ok, conn} = Writer.write_event(conn, %TextMessageEnd{message_id: "m1"})

    # Tool call
    {:ok, conn} =
      Writer.write_event(conn, %ToolCallStart{
        tool_call_id: "tc1",
        tool_call_name: "get_weather",
        parent_message_id: "m1"
      })

    {:ok, conn} =
      Writer.write_event(conn, %ToolCallArgs{
        tool_call_id: "tc1",
        delta: "{\"city\": \"NYC\"}"
      })

    {:ok, conn} = Writer.write_event(conn, %ToolCallEnd{tool_call_id: "tc1"})

    # Tool result
    {:ok, conn} =
      Writer.write_event(conn, %ToolCallResult{
        message_id: "m2",
        tool_call_id: "tc1",
        content: "{\"temp\": 72, \"unit\": \"F\"}",
        role: "tool"
      })

    # Final assistant response
    {:ok, conn} = Writer.write_event(conn, %TextMessageStart{message_id: "m3", role: "assistant"})

    {:ok, conn} =
      Writer.write_event(conn, %TextMessageContent{
        message_id: "m3",
        delta: "It's 72F in NYC."
      })

    {:ok, conn} = Writer.write_event(conn, %TextMessageEnd{message_id: "m3"})

    {:ok, conn} = Writer.write_event(conn, %RunFinished{thread_id: thread_id, run_id: run_id})
    conn
  end

  # State management
  post "/agent/state" do
    conn = Writer.prepare_conn(conn)
    input = conn.body_params
    thread_id = input["threadId"] || "t1"
    run_id = input["runId"] || "r1"

    {:ok, conn} = Writer.write_event(conn, %RunStarted{thread_id: thread_id, run_id: run_id})

    # State snapshot
    {:ok, conn} =
      Writer.write_event(conn, %StateSnapshot{
        snapshot: %{"counter" => 0, "items" => ["a", "b"]}
      })

    # State delta (JSON Patch)
    {:ok, conn} =
      Writer.write_event(conn, %StateDelta{
        delta: [
          %{"op" => "replace", "path" => "/counter", "value" => 1},
          %{"op" => "add", "path" => "/items/-", "value" => "c"}
        ]
      })

    # Another delta
    {:ok, conn} =
      Writer.write_event(conn, %StateDelta{
        delta: [
          %{"op" => "replace", "path" => "/counter", "value" => 2}
        ]
      })

    {:ok, conn} = Writer.write_event(conn, %RunFinished{thread_id: thread_id, run_id: run_id})
    conn
  end

  # Messages snapshot
  post "/agent/messages_snapshot" do
    conn = Writer.prepare_conn(conn)
    input = conn.body_params
    thread_id = input["threadId"] || "t1"
    run_id = input["runId"] || "r1"

    {:ok, conn} = Writer.write_event(conn, %RunStarted{thread_id: thread_id, run_id: run_id})

    {:ok, conn} = Writer.write_event(conn, %TextMessageStart{message_id: "m1", role: "assistant"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageContent{message_id: "m1", delta: "First"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageEnd{message_id: "m1"})

    # Messages snapshot replaces all messages
    {:ok, conn} =
      Writer.write_event(conn, %MessagesSnapshot{
        messages: [
          %{"id" => "snapshot-m1", "role" => "user", "content" => "Hello"},
          %{"id" => "snapshot-m2", "role" => "assistant", "content" => "Hi there!"}
        ]
      })

    {:ok, conn} = Writer.write_event(conn, %RunFinished{thread_id: thread_id, run_id: run_id})
    conn
  end

  # Steps (thinking, tool_use, etc.)
  post "/agent/steps" do
    conn = Writer.prepare_conn(conn)
    input = conn.body_params
    thread_id = input["threadId"] || "t1"
    run_id = input["runId"] || "r1"

    {:ok, conn} = Writer.write_event(conn, %RunStarted{thread_id: thread_id, run_id: run_id})

    {:ok, conn} = Writer.write_event(conn, %StepStarted{step_name: "thinking"})
    Process.sleep(10)
    {:ok, conn} = Writer.write_event(conn, %TextMessageStart{message_id: "m1", role: "assistant"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageContent{message_id: "m1", delta: "Hmm..."})
    {:ok, conn} = Writer.write_event(conn, %TextMessageEnd{message_id: "m1"})
    {:ok, conn} = Writer.write_event(conn, %StepFinished{step_name: "thinking"})

    {:ok, conn} = Writer.write_event(conn, %StepStarted{step_name: "tool_use"})
    {:ok, conn} = Writer.write_event(conn, %StepFinished{step_name: "tool_use"})

    {:ok, conn} = Writer.write_event(conn, %RunFinished{thread_id: thread_id, run_id: run_id})
    conn
  end

  # Error scenario
  post "/agent/error" do
    conn = Writer.prepare_conn(conn)
    input = conn.body_params
    thread_id = input["threadId"] || "t1"
    run_id = input["runId"] || "r1"

    {:ok, conn} = Writer.write_event(conn, %RunStarted{thread_id: thread_id, run_id: run_id})

    {:ok, conn} =
      Writer.write_event(conn, %RunError{
        message: "Something went wrong",
        code: "INTERNAL_ERROR"
      })

    conn
  end

  # Multiple sequential runs
  post "/agent/multi_run" do
    conn = Writer.prepare_conn(conn)
    input = conn.body_params
    thread_id = input["threadId"] || "t1"

    # First run
    {:ok, conn} = Writer.write_event(conn, %RunStarted{thread_id: thread_id, run_id: "run-1"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageStart{message_id: "m1", role: "assistant"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageContent{message_id: "m1", delta: "Run 1"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageEnd{message_id: "m1"})
    {:ok, conn} = Writer.write_event(conn, %RunFinished{thread_id: thread_id, run_id: "run-1"})

    # Second run
    {:ok, conn} =
      Writer.write_event(conn, %RunStarted{
        thread_id: thread_id,
        run_id: "run-2",
        parent_run_id: "run-1"
      })

    {:ok, conn} = Writer.write_event(conn, %TextMessageStart{message_id: "m2", role: "assistant"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageContent{message_id: "m2", delta: "Run 2"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageEnd{message_id: "m2"})
    {:ok, conn} = Writer.write_event(conn, %RunFinished{thread_id: thread_id, run_id: "run-2"})

    conn
  end

  # Custom event
  post "/agent/custom" do
    conn = Writer.prepare_conn(conn)
    input = conn.body_params
    thread_id = input["threadId"] || "t1"
    run_id = input["runId"] || "r1"

    {:ok, conn} = Writer.write_event(conn, %RunStarted{thread_id: thread_id, run_id: run_id})

    {:ok, conn} =
      Writer.write_event(conn, %Custom{
        name: "my_custom_event",
        value: %{"custom_field" => "custom_value", "count" => 42}
      })

    {:ok, conn} = Writer.write_event(conn, %RunFinished{thread_id: thread_id, run_id: run_id})
    conn
  end

  # Concurrent text messages (multiple messages streaming in parallel)
  post "/agent/concurrent_messages" do
    conn = Writer.prepare_conn(conn)
    input = conn.body_params
    thread_id = input["threadId"] || "t1"
    run_id = input["runId"] || "r1"

    {:ok, conn} = Writer.write_event(conn, %RunStarted{thread_id: thread_id, run_id: run_id})

    # Start two messages concurrently
    {:ok, conn} = Writer.write_event(conn, %TextMessageStart{message_id: "m1", role: "assistant"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageStart{message_id: "m2", role: "assistant"})

    # Interleaved content
    {:ok, conn} = Writer.write_event(conn, %TextMessageContent{message_id: "m1", delta: "First "})
    {:ok, conn} = Writer.write_event(conn, %TextMessageContent{message_id: "m2", delta: "Second "})
    {:ok, conn} = Writer.write_event(conn, %TextMessageContent{message_id: "m1", delta: "message"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageContent{message_id: "m2", delta: "message"})

    # End both
    {:ok, conn} = Writer.write_event(conn, %TextMessageEnd{message_id: "m1"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageEnd{message_id: "m2"})

    {:ok, conn} = Writer.write_event(conn, %RunFinished{thread_id: thread_id, run_id: run_id})
    conn
  end

  # Concurrent tool calls (multiple tools streaming in parallel)
  post "/agent/concurrent_tools" do
    conn = Writer.prepare_conn(conn)
    input = conn.body_params
    thread_id = input["threadId"] || "t1"
    run_id = input["runId"] || "r1"

    {:ok, conn} = Writer.write_event(conn, %RunStarted{thread_id: thread_id, run_id: run_id})

    # Start two tool calls
    {:ok, conn} = Writer.write_event(conn, %ToolCallStart{tool_call_id: "tc1", tool_call_name: "tool_a"})
    {:ok, conn} = Writer.write_event(conn, %ToolCallStart{tool_call_id: "tc2", tool_call_name: "tool_b"})

    # Interleaved args
    {:ok, conn} = Writer.write_event(conn, %ToolCallArgs{tool_call_id: "tc1", delta: "{\"x\":"})
    {:ok, conn} = Writer.write_event(conn, %ToolCallArgs{tool_call_id: "tc2", delta: "{\"y\":"})
    {:ok, conn} = Writer.write_event(conn, %ToolCallArgs{tool_call_id: "tc1", delta: " 1}"})
    {:ok, conn} = Writer.write_event(conn, %ToolCallArgs{tool_call_id: "tc2", delta: " 2}"})

    # End both
    {:ok, conn} = Writer.write_event(conn, %ToolCallEnd{tool_call_id: "tc1"})
    {:ok, conn} = Writer.write_event(conn, %ToolCallEnd{tool_call_id: "tc2"})

    # Results
    {:ok, conn} = Writer.write_event(conn, %ToolCallResult{message_id: "m1", tool_call_id: "tc1", content: "result1", role: "tool"})
    {:ok, conn} = Writer.write_event(conn, %ToolCallResult{message_id: "m2", tool_call_id: "tc2", content: "result2", role: "tool"})

    {:ok, conn} = Writer.write_event(conn, %RunFinished{thread_id: thread_id, run_id: run_id})
    conn
  end

  # Activity events (ACTIVITY_SNAPSHOT and ACTIVITY_DELTA)
  post "/agent/activity" do
    conn = Writer.prepare_conn(conn)
    input = conn.body_params
    thread_id = input["threadId"] || "t1"
    run_id = input["runId"] || "r1"

    {:ok, conn} = Writer.write_event(conn, %RunStarted{thread_id: thread_id, run_id: run_id})

    # Activity snapshot (creates activity message)
    {:ok, conn} = Writer.write_event(conn, %ActivitySnapshot{
      message_id: "activity-1",
      activity_type: "search_progress",
      content: %{"query" => "test", "results" => [], "status" => "searching"}
    })

    # Activity delta (updates via JSON Patch)
    {:ok, conn} = Writer.write_event(conn, %ActivityDelta{
      message_id: "activity-1",
      activity_type: "search_progress",
      patch: [
        %{"op" => "replace", "path" => "/status", "value" => "found"},
        %{"op" => "add", "path" => "/results/-", "value" => %{"title" => "Result 1"}}
      ]
    })

    # Another activity with replace flag
    {:ok, conn} = Writer.write_event(conn, %ActivitySnapshot{
      message_id: "activity-2",
      activity_type: "plan",
      content: %{"steps" => ["Step 1", "Step 2"]},
      replace: true
    })

    {:ok, conn} = Writer.write_event(conn, %RunFinished{thread_id: thread_id, run_id: run_id})
    conn
  end

  # Thinking events (extended thinking/reasoning)
  post "/agent/thinking" do
    conn = Writer.prepare_conn(conn)
    input = conn.body_params
    thread_id = input["threadId"] || "t1"
    run_id = input["runId"] || "r1"

    {:ok, conn} = Writer.write_event(conn, %RunStarted{thread_id: thread_id, run_id: run_id})

    # Thinking block
    {:ok, conn} = Writer.write_event(conn, %ThinkingStart{})
    {:ok, conn} = Writer.write_event(conn, %ThinkingTextMessageStart{})
    {:ok, conn} = Writer.write_event(conn, %ThinkingTextMessageContent{delta: "Let me think about this..."})
    {:ok, conn} = Writer.write_event(conn, %ThinkingTextMessageContent{delta: " The answer is 42."})
    {:ok, conn} = Writer.write_event(conn, %ThinkingTextMessageEnd{})
    {:ok, conn} = Writer.write_event(conn, %ThinkingEnd{})

    # Regular response
    {:ok, conn} = Writer.write_event(conn, %TextMessageStart{message_id: "m1", role: "assistant"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageContent{message_id: "m1", delta: "The answer is 42."})
    {:ok, conn} = Writer.write_event(conn, %TextMessageEnd{message_id: "m1"})

    {:ok, conn} = Writer.write_event(conn, %RunFinished{thread_id: thread_id, run_id: run_id})
    conn
  end

  # Raw event (for passthrough/unknown events)
  post "/agent/raw" do
    conn = Writer.prepare_conn(conn)
    input = conn.body_params
    thread_id = input["threadId"] || "t1"
    run_id = input["runId"] || "r1"

    {:ok, conn} = Writer.write_event(conn, %RunStarted{thread_id: thread_id, run_id: run_id})

    {:ok, conn} = Writer.write_event(conn, %Raw{
      event: %{
        "type" => "UNKNOWN_FUTURE_EVENT",
        "data" => %{"foo" => "bar"},
        "timestamp" => System.system_time(:millisecond)
      },
      source: "external_agent"
    })

    {:ok, conn} = Writer.write_event(conn, %RunFinished{thread_id: thread_id, run_id: run_id})
    conn
  end

  # Unicode and special characters
  post "/agent/unicode" do
    conn = Writer.prepare_conn(conn)
    input = conn.body_params
    thread_id = input["threadId"] || "t1"
    run_id = input["runId"] || "r1"

    {:ok, conn} = Writer.write_event(conn, %RunStarted{thread_id: thread_id, run_id: run_id})

    {:ok, conn} = Writer.write_event(conn, %TextMessageStart{message_id: "m1", role: "assistant"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageContent{message_id: "m1", delta: "Hello! 你好! مرحبا! 🎉"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageContent{message_id: "m1", delta: " Special: \n\t\"quotes\" 'apostrophe' \\backslash"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageContent{message_id: "m1", delta: " Emoji: 👨‍👩‍👧‍👦 🇺🇸 ❤️‍🔥"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageEnd{message_id: "m1"})

    {:ok, conn} = Writer.write_event(conn, %RunFinished{thread_id: thread_id, run_id: run_id})
    conn
  end

  # Deeply nested state
  post "/agent/nested_state" do
    conn = Writer.prepare_conn(conn)
    input = conn.body_params
    thread_id = input["threadId"] || "t1"
    run_id = input["runId"] || "r1"

    {:ok, conn} = Writer.write_event(conn, %RunStarted{thread_id: thread_id, run_id: run_id})

    {:ok, conn} = Writer.write_event(conn, %StateSnapshot{
      snapshot: %{
        "level1" => %{
          "level2" => %{
            "level3" => %{
              "deep_value" => "found",
              "deep_array" => [1, 2, %{"nested" => true}]
            }
          }
        },
        "array_of_objects" => [
          %{"id" => 1, "data" => %{"x" => 10}},
          %{"id" => 2, "data" => %{"x" => 20}}
        ]
      }
    })

    # Deep patch
    {:ok, conn} = Writer.write_event(conn, %StateDelta{
      delta: [
        %{"op" => "replace", "path" => "/level1/level2/level3/deep_value", "value" => "updated"},
        %{"op" => "add", "path" => "/level1/level2/level3/deep_array/-", "value" => 4},
        %{"op" => "replace", "path" => "/array_of_objects/0/data/x", "value" => 100}
      ]
    })

    {:ok, conn} = Writer.write_event(conn, %RunFinished{thread_id: thread_id, run_id: run_id})
    conn
  end

  # Interleaved messages and tool calls
  post "/agent/interleaved" do
    conn = Writer.prepare_conn(conn)
    input = conn.body_params
    thread_id = input["threadId"] || "t1"
    run_id = input["runId"] || "r1"

    {:ok, conn} = Writer.write_event(conn, %RunStarted{thread_id: thread_id, run_id: run_id})

    # Start message
    {:ok, conn} = Writer.write_event(conn, %TextMessageStart{message_id: "m1", role: "assistant"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageContent{message_id: "m1", delta: "Let me "})

    # Start tool call while message is open
    {:ok, conn} = Writer.write_event(conn, %ToolCallStart{tool_call_id: "tc1", tool_call_name: "lookup", parent_message_id: "m1"})
    {:ok, conn} = Writer.write_event(conn, %ToolCallArgs{tool_call_id: "tc1", delta: "{}"})

    # Continue message
    {:ok, conn} = Writer.write_event(conn, %TextMessageContent{message_id: "m1", delta: "check that."})

    # End tool call
    {:ok, conn} = Writer.write_event(conn, %ToolCallEnd{tool_call_id: "tc1"})

    # End message
    {:ok, conn} = Writer.write_event(conn, %TextMessageEnd{message_id: "m1"})

    # Tool result
    {:ok, conn} = Writer.write_event(conn, %ToolCallResult{message_id: "m2", tool_call_id: "tc1", content: "done", role: "tool"})

    {:ok, conn} = Writer.write_event(conn, %RunFinished{thread_id: thread_id, run_id: run_id})
    conn
  end

  # Multi-run with state carryover
  post "/agent/multi_run_state" do
    conn = Writer.prepare_conn(conn)
    input = conn.body_params
    thread_id = input["threadId"] || "t1"

    # Run 1: Initialize state
    {:ok, conn} = Writer.write_event(conn, %RunStarted{thread_id: thread_id, run_id: "run-1"})
    {:ok, conn} = Writer.write_event(conn, %StateSnapshot{snapshot: %{"counter" => 1, "history" => ["run1"]}})
    {:ok, conn} = Writer.write_event(conn, %TextMessageStart{message_id: "m1", role: "assistant"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageContent{message_id: "m1", delta: "Run 1 done"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageEnd{message_id: "m1"})
    {:ok, conn} = Writer.write_event(conn, %RunFinished{thread_id: thread_id, run_id: "run-1"})

    # Run 2: Update state (continues from run 1's state)
    {:ok, conn} = Writer.write_event(conn, %RunStarted{thread_id: thread_id, run_id: "run-2", parent_run_id: "run-1"})
    {:ok, conn} = Writer.write_event(conn, %StateDelta{delta: [
      %{"op" => "replace", "path" => "/counter", "value" => 2},
      %{"op" => "add", "path" => "/history/-", "value" => "run2"}
    ]})
    {:ok, conn} = Writer.write_event(conn, %TextMessageStart{message_id: "m2", role: "assistant"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageContent{message_id: "m2", delta: "Run 2 done"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageEnd{message_id: "m2"})
    {:ok, conn} = Writer.write_event(conn, %RunFinished{thread_id: thread_id, run_id: "run-2"})

    # Run 3: More updates
    {:ok, conn} = Writer.write_event(conn, %RunStarted{thread_id: thread_id, run_id: "run-3", parent_run_id: "run-2"})
    {:ok, conn} = Writer.write_event(conn, %StateDelta{delta: [
      %{"op" => "replace", "path" => "/counter", "value" => 3},
      %{"op" => "add", "path" => "/history/-", "value" => "run3"}
    ]})
    {:ok, conn} = Writer.write_event(conn, %RunFinished{thread_id: thread_id, run_id: "run-3"})

    conn
  end

  # Error followed by recovery run
  post "/agent/error_recovery" do
    conn = Writer.prepare_conn(conn)
    input = conn.body_params
    thread_id = input["threadId"] || "t1"

    # Run 1: Errors out
    {:ok, conn} = Writer.write_event(conn, %RunStarted{thread_id: thread_id, run_id: "run-1"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageStart{message_id: "m1", role: "assistant"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageContent{message_id: "m1", delta: "Starting..."})
    {:ok, conn} = Writer.write_event(conn, %TextMessageEnd{message_id: "m1"})
    {:ok, conn} = Writer.write_event(conn, %RunError{message: "Network timeout", code: "TIMEOUT"})

    # Run 2: Recovery
    {:ok, conn} = Writer.write_event(conn, %RunStarted{thread_id: thread_id, run_id: "run-2"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageStart{message_id: "m2", role: "assistant"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageContent{message_id: "m2", delta: "Recovered successfully"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageEnd{message_id: "m2"})
    {:ok, conn} = Writer.write_event(conn, %RunFinished{thread_id: thread_id, run_id: "run-2"})

    conn
  end

  # Empty content edge cases
  post "/agent/empty_content" do
    conn = Writer.prepare_conn(conn)
    input = conn.body_params
    thread_id = input["threadId"] || "t1"
    run_id = input["runId"] || "r1"

    {:ok, conn} = Writer.write_event(conn, %RunStarted{thread_id: thread_id, run_id: run_id})

    # Message with empty string content (valid but edge case)
    {:ok, conn} = Writer.write_event(conn, %TextMessageStart{message_id: "m1", role: "assistant"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageContent{message_id: "m1", delta: ""})
    {:ok, conn} = Writer.write_event(conn, %TextMessageContent{message_id: "m1", delta: "actual content"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageContent{message_id: "m1", delta: ""})
    {:ok, conn} = Writer.write_event(conn, %TextMessageEnd{message_id: "m1"})

    # Empty state snapshot
    {:ok, conn} = Writer.write_event(conn, %StateSnapshot{snapshot: %{}})

    # Empty state delta
    {:ok, conn} = Writer.write_event(conn, %StateDelta{delta: []})

    {:ok, conn} = Writer.write_event(conn, %RunFinished{thread_id: thread_id, run_id: run_id})
    conn
  end

  # Multiple tool calls on same message
  post "/agent/multi_tool_same_message" do
    conn = Writer.prepare_conn(conn)
    input = conn.body_params
    thread_id = input["threadId"] || "t1"
    run_id = input["runId"] || "r1"

    {:ok, conn} = Writer.write_event(conn, %RunStarted{thread_id: thread_id, run_id: run_id})

    # Assistant message with multiple tool calls
    {:ok, conn} = Writer.write_event(conn, %TextMessageStart{message_id: "m1", role: "assistant"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageContent{message_id: "m1", delta: "I'll use multiple tools."})
    {:ok, conn} = Writer.write_event(conn, %TextMessageEnd{message_id: "m1"})

    # Tool 1
    {:ok, conn} = Writer.write_event(conn, %ToolCallStart{tool_call_id: "tc1", tool_call_name: "search", parent_message_id: "m1"})
    {:ok, conn} = Writer.write_event(conn, %ToolCallArgs{tool_call_id: "tc1", delta: "{\"q\":\"a\"}"})
    {:ok, conn} = Writer.write_event(conn, %ToolCallEnd{tool_call_id: "tc1"})

    # Tool 2
    {:ok, conn} = Writer.write_event(conn, %ToolCallStart{tool_call_id: "tc2", tool_call_name: "calculate", parent_message_id: "m1"})
    {:ok, conn} = Writer.write_event(conn, %ToolCallArgs{tool_call_id: "tc2", delta: "{\"expr\":\"1+1\"}"})
    {:ok, conn} = Writer.write_event(conn, %ToolCallEnd{tool_call_id: "tc2"})

    # Tool 3
    {:ok, conn} = Writer.write_event(conn, %ToolCallStart{tool_call_id: "tc3", tool_call_name: "format", parent_message_id: "m1"})
    {:ok, conn} = Writer.write_event(conn, %ToolCallArgs{tool_call_id: "tc3", delta: "{}"})
    {:ok, conn} = Writer.write_event(conn, %ToolCallEnd{tool_call_id: "tc3"})

    # Results
    {:ok, conn} = Writer.write_event(conn, %ToolCallResult{message_id: "r1", tool_call_id: "tc1", content: "found", role: "tool"})
    {:ok, conn} = Writer.write_event(conn, %ToolCallResult{message_id: "r2", tool_call_id: "tc2", content: "2", role: "tool"})
    {:ok, conn} = Writer.write_event(conn, %ToolCallResult{message_id: "r3", tool_call_id: "tc3", content: "formatted", role: "tool"})

    {:ok, conn} = Writer.write_event(conn, %RunFinished{thread_id: thread_id, run_id: run_id})
    conn
  end

  # Long streaming content (stress test)
  post "/agent/long_stream" do
    conn = Writer.prepare_conn(conn)
    input = conn.body_params
    thread_id = input["threadId"] || "t1"
    run_id = input["runId"] || "r1"

    {:ok, conn} = Writer.write_event(conn, %RunStarted{thread_id: thread_id, run_id: run_id})

    {:ok, conn} = Writer.write_event(conn, %TextMessageStart{message_id: "m1", role: "assistant"})

    # Stream 100 chunks
    conn = Enum.reduce(1..100, conn, fn i, acc ->
      {:ok, acc} = Writer.write_event(acc, %TextMessageContent{
        message_id: "m1",
        delta: "Chunk #{i}. "
      })
      acc
    end)

    {:ok, conn} = Writer.write_event(conn, %TextMessageEnd{message_id: "m1"})
    {:ok, conn} = Writer.write_event(conn, %RunFinished{thread_id: thread_id, run_id: run_id})
    conn
  end

  match _ do
    send_resp(conn, 404, "Not found")
  end
end

defmodule IntegrationTest.Runner do
  @moduledoc """
  Runs integration tests against the test server.
  """

  alias AgUI.Client.HttpAgent
  alias AgUI.Types.RunAgentInput
  alias AgUI.Types.Message
  alias AgUI.Verify

  alias AgUI.Events.{
    RunStarted,
    RunFinished,
    RunError,
    TextMessageStart,
    TextMessageContent,
    TextMessageEnd,
    ToolCallStart,
    ToolCallEnd,
    ToolCallResult,
    StateSnapshot,
    StateDelta,
    MessagesSnapshot,
    ActivitySnapshot,
    ActivityDelta,
    ThinkingStart,
    ThinkingEnd,
    Custom,
    Raw
  }

  def run_all(base_url) do
    tests = [
      {"Basic happy path", "/agent/basic", &test_basic/1},
      {"Chunk expansion", "/agent/chunks", &test_chunks/1},
      {"Tool call flow", "/agent/tools", &test_tools/1},
      {"State management", "/agent/state", &test_state/1},
      {"Messages snapshot", "/agent/messages_snapshot", &test_messages_snapshot/1},
      {"Steps", "/agent/steps", &test_steps/1},
      {"Error handling", "/agent/error", &test_error/1},
      {"Multiple runs", "/agent/multi_run", &test_multi_run/1},
      {"Custom events", "/agent/custom", &test_custom/1},
      # New tests
      {"Concurrent messages", "/agent/concurrent_messages", &test_concurrent_messages/1},
      {"Concurrent tools", "/agent/concurrent_tools", &test_concurrent_tools/1},
      {"Activity events", "/agent/activity", &test_activity/1},
      {"Thinking events", "/agent/thinking", &test_thinking/1},
      {"Raw events", "/agent/raw", &test_raw/1},
      {"Unicode content", "/agent/unicode", &test_unicode/1},
      {"Deeply nested state", "/agent/nested_state", &test_nested_state/1},
      {"Interleaved events", "/agent/interleaved", &test_interleaved/1},
      {"Multi-run state carryover", "/agent/multi_run_state", &test_multi_run_state/1},
      {"Error recovery", "/agent/error_recovery", &test_error_recovery/1},
      {"Empty content edge cases", "/agent/empty_content", &test_empty_content/1},
      {"Multiple tools same message", "/agent/multi_tool_same_message", &test_multi_tool_same_message/1},
      {"Long streaming content", "/agent/long_stream", &test_long_stream/1}
    ]

    results =
      Enum.map(tests, fn {name, path, test_fn} ->
        IO.puts("\n--- #{name} ---")
        url = "#{base_url}#{path}"
        agent = HttpAgent.new(url: url, timeout: 10_000)

        result =
          try do
            test_fn.(agent)
          rescue
            e ->
              IO.puts("  EXCEPTION: #{Exception.message(e)}")
              :error
          end

        {name, result}
      end)

    # Summary
    IO.puts("\n" <> String.duplicate("=", 50))
    IO.puts("SUMMARY")
    IO.puts(String.duplicate("=", 50))

    {passed, failed} = Enum.split_with(results, fn {_, r} -> r == :ok end)

    Enum.each(results, fn {name, result} ->
      status = if result == :ok, do: "[PASS]", else: "[FAIL]"
      IO.puts("  #{status} #{name}")
    end)

    IO.puts("")
    IO.puts("Passed: #{length(passed)}/#{length(results)}")

    if length(failed) > 0 do
      IO.puts("Failed: #{length(failed)}")
      System.halt(1)
    else
      IO.puts("\nAll tests passed!")
      :ok
    end
  end

  defp make_input do
    RunAgentInput.new("test-thread", "test-run",
      messages: [
        %Message.User{id: "u1", role: :user, content: "Hello"}
      ]
    )
  end

  defp test_basic(agent) do
    {:ok, stream} = HttpAgent.stream_canonical(agent, make_input())
    events = Enum.to_list(stream)

    assert(length(events) >= 4, "Expected at least 4 events, got #{length(events)}")
    assert(match?(%RunStarted{}, hd(events)), "First event should be RUN_STARTED")
    assert(match?(%RunFinished{}, List.last(events)), "Last event should be RUN_FINISHED")

    text_content = Enum.filter(events, &match?(%TextMessageContent{}, &1))
    assert(length(text_content) > 0, "Should have text content")

    verify_events(events)
  end

  defp test_chunks(agent) do
    {:ok, stream} = HttpAgent.stream_canonical(agent, make_input())
    events = Enum.to_list(stream)

    # After normalization, there should be no chunk events
    chunk_events =
      Enum.filter(events, fn e ->
        e.type in [:text_message_chunk, :tool_call_chunk]
      end)

    assert(length(chunk_events) == 0, "Chunks should be expanded")

    # Should have start/content/end
    assert(Enum.any?(events, &match?(%TextMessageStart{}, &1)), "Should have TEXT_MESSAGE_START")
    assert(Enum.any?(events, &match?(%TextMessageEnd{}, &1)), "Should have TEXT_MESSAGE_END")
    assert(Enum.any?(events, &match?(%ToolCallStart{}, &1)), "Should have TOOL_CALL_START")
    assert(Enum.any?(events, &match?(%ToolCallEnd{}, &1)), "Should have TOOL_CALL_END")

    verify_events(events)
  end

  defp test_tools(agent) do
    {:ok, result} = HttpAgent.run_agent(agent, make_input())

    # Should have tool message
    tool_msgs = Enum.filter(result.new_messages, &match?(%Message.Tool{}, &1))
    assert(length(tool_msgs) > 0, "Should have tool result message")

    # Should have assistant messages with tool calls
    assistant_msgs =
      Enum.filter(result.new_messages, fn m ->
        match?(%Message.Assistant{}, m) and length(m.tool_calls || []) > 0
      end)

    assert(length(assistant_msgs) > 0, "Should have assistant message with tool calls")

    :ok
  end

  defp test_state(agent) do
    {:ok, result} = HttpAgent.run_agent(agent, make_input())

    # State should be updated via snapshot + delta
    assert(result.session.state["counter"] == 2, "Counter should be 2")
    assert(result.session.state["items"] == ["a", "b", "c"], "Items should have 'c' added")

    :ok
  end

  defp test_messages_snapshot(agent) do
    {:ok, result} = HttpAgent.run_agent(agent, make_input())

    # Messages should be replaced by snapshot
    msg_ids = Enum.map(result.session.messages, & &1.id)
    assert("snapshot-m1" in msg_ids, "Should have snapshot message 1")
    assert("snapshot-m2" in msg_ids, "Should have snapshot message 2")

    :ok
  end

  defp test_steps(agent) do
    {:ok, stream} = HttpAgent.stream_canonical(agent, make_input())
    events = Enum.to_list(stream)

    step_started = Enum.filter(events, &match?(%AgUI.Events.StepStarted{}, &1))
    step_finished = Enum.filter(events, &match?(%AgUI.Events.StepFinished{}, &1))

    assert(length(step_started) == 2, "Should have 2 STEP_STARTED events")
    assert(length(step_finished) == 2, "Should have 2 STEP_FINISHED events")

    verify_events(events)
  end

  defp test_error(agent) do
    {:ok, stream} = HttpAgent.stream_canonical(agent, make_input())
    events = Enum.to_list(stream)

    error_events = Enum.filter(events, &match?(%RunError{}, &1))
    assert(length(error_events) == 1, "Should have RUN_ERROR")

    error = hd(error_events)
    assert(error.message == "Something went wrong", "Error message should match")
    assert(error.code == "INTERNAL_ERROR", "Error code should match")

    :ok
  end

  defp test_multi_run(agent) do
    {:ok, stream} = HttpAgent.stream_canonical(agent, make_input())
    events = Enum.to_list(stream)

    run_started = Enum.filter(events, &match?(%RunStarted{}, &1))
    run_finished = Enum.filter(events, &match?(%RunFinished{}, &1))

    assert(length(run_started) == 2, "Should have 2 RUN_STARTED events")
    assert(length(run_finished) == 2, "Should have 2 RUN_FINISHED events")

    # Second run should have parent_run_id
    second_run = Enum.at(run_started, 1)
    assert(second_run.parent_run_id == "run-1", "Second run should reference first")

    verify_events(events)
  end

  defp test_custom(agent) do
    {:ok, stream} = HttpAgent.stream_canonical(agent, make_input())
    events = Enum.to_list(stream)

    custom_events = Enum.filter(events, &match?(%Custom{}, &1))
    assert(length(custom_events) == 1, "Should have CUSTOM event")

    custom = hd(custom_events)
    assert(custom.name == "my_custom_event", "Custom event name should match")
    assert(custom.value["count"] == 42, "Custom event value should match")

    verify_events(events)
  end

  defp test_concurrent_messages(agent) do
    {:ok, stream} = HttpAgent.stream_canonical(agent, make_input())
    events = Enum.to_list(stream)

    text_starts = Enum.filter(events, &match?(%TextMessageStart{}, &1))
    text_ends = Enum.filter(events, &match?(%TextMessageEnd{}, &1))

    assert(length(text_starts) == 2, "Should have 2 TEXT_MESSAGE_START events")
    assert(length(text_ends) == 2, "Should have 2 TEXT_MESSAGE_END events")

    # Verify IDs are different
    ids = Enum.map(text_starts, & &1.message_id)
    assert(length(Enum.uniq(ids)) == 2, "Message IDs should be unique")

    # Verify content was properly assembled for each message
    m1_content = events
      |> Enum.filter(fn e -> match?(%TextMessageContent{message_id: "m1"}, e) end)
      |> Enum.map(& &1.delta)
      |> Enum.join()
    m2_content = events
      |> Enum.filter(fn e -> match?(%TextMessageContent{message_id: "m2"}, e) end)
      |> Enum.map(& &1.delta)
      |> Enum.join()

    assert(m1_content == "First message", "Message 1 content should be correct")
    assert(m2_content == "Second message", "Message 2 content should be correct")

    verify_events(events)
  end

  defp test_concurrent_tools(agent) do
    {:ok, stream} = HttpAgent.stream_canonical(agent, make_input())
    events = Enum.to_list(stream)

    tool_starts = Enum.filter(events, &match?(%ToolCallStart{}, &1))
    tool_ends = Enum.filter(events, &match?(%ToolCallEnd{}, &1))
    tool_results = Enum.filter(events, &match?(%ToolCallResult{}, &1))

    assert(length(tool_starts) == 2, "Should have 2 TOOL_CALL_START events")
    assert(length(tool_ends) == 2, "Should have 2 TOOL_CALL_END events")
    assert(length(tool_results) == 2, "Should have 2 TOOL_CALL_RESULT events")

    # Verify tool names
    tool_names = Enum.map(tool_starts, & &1.tool_call_name) |> Enum.sort()
    assert(tool_names == ["tool_a", "tool_b"], "Tool names should match")

    verify_events(events)
  end

  defp test_activity(agent) do
    {:ok, stream} = HttpAgent.stream_canonical(agent, make_input())
    events = Enum.to_list(stream)

    activity_snapshots = Enum.filter(events, &match?(%ActivitySnapshot{}, &1))
    activity_deltas = Enum.filter(events, &match?(%ActivityDelta{}, &1))

    assert(length(activity_snapshots) == 2, "Should have 2 ACTIVITY_SNAPSHOT events")
    assert(length(activity_deltas) == 1, "Should have 1 ACTIVITY_DELTA event")

    # Check first activity snapshot
    first_snapshot = Enum.at(activity_snapshots, 0)
    assert(first_snapshot.activity_type == "search_progress", "Activity type should match")
    assert(first_snapshot.content["status"] == "searching", "Initial status should be searching")

    # Check activity delta has proper ops
    delta = hd(activity_deltas)
    assert(length(delta.patch) == 2, "Delta should have 2 operations")

    # Check second snapshot has replace flag
    second_snapshot = Enum.at(activity_snapshots, 1)
    assert(second_snapshot.replace == true, "Second snapshot should have replace flag")

    verify_events(events)
  end

  defp test_thinking(agent) do
    {:ok, stream} = HttpAgent.stream_canonical(agent, make_input())
    events = Enum.to_list(stream)

    thinking_starts = Enum.filter(events, &match?(%ThinkingStart{}, &1))
    thinking_ends = Enum.filter(events, &match?(%ThinkingEnd{}, &1))

    assert(length(thinking_starts) == 1, "Should have THINKING_START")
    assert(length(thinking_ends) == 1, "Should have THINKING_END")

    # Should also have regular message after thinking
    text_content = Enum.filter(events, &match?(%TextMessageContent{}, &1))
    assert(length(text_content) > 0, "Should have regular text content after thinking")

    verify_events(events)
  end

  defp test_raw(agent) do
    {:ok, stream} = HttpAgent.stream_canonical(agent, make_input())
    events = Enum.to_list(stream)

    raw_events = Enum.filter(events, &match?(%Raw{}, &1))
    assert(length(raw_events) == 1, "Should have RAW event")

    raw = hd(raw_events)
    assert(raw.source == "external_agent", "Raw event source should match")
    assert(raw.event["type"] == "UNKNOWN_FUTURE_EVENT", "Raw event should preserve original type")

    verify_events(events)
  end

  defp test_unicode(agent) do
    {:ok, stream} = HttpAgent.stream_canonical(agent, make_input())
    events = Enum.to_list(stream)

    text_content = events
      |> Enum.filter(&match?(%TextMessageContent{}, &1))
      |> Enum.map(& &1.delta)
      |> Enum.join()

    # Check various unicode characters are preserved
    assert(String.contains?(text_content, "你好"), "Should contain Chinese")
    assert(String.contains?(text_content, "مرحبا"), "Should contain Arabic")
    assert(String.contains?(text_content, "🎉"), "Should contain emoji")
    assert(String.contains?(text_content, "👨‍👩‍👧‍👦"), "Should contain family emoji (ZWJ sequence)")
    assert(String.contains?(text_content, "quotes"), "Should preserve quotes content")
    assert(String.contains?(text_content, "backslash"), "Should preserve backslash content")

    verify_events(events)
  end

  defp test_nested_state(agent) do
    {:ok, result} = HttpAgent.run_agent(agent, make_input())

    state = result.session.state

    # Check deeply nested value was updated
    deep_value = get_in(state, ["level1", "level2", "level3", "deep_value"])
    assert(deep_value == "updated", "Deep value should be updated")

    # Check array append worked
    deep_array = get_in(state, ["level1", "level2", "level3", "deep_array"])
    assert(4 in deep_array, "4 should be added to deep_array")

    # Check nested array object update
    first_obj_x = get_in(state, ["array_of_objects", Access.at(0), "data", "x"])
    assert(first_obj_x == 100, "Nested array object should be updated")

    :ok
  end

  defp test_interleaved(agent) do
    {:ok, stream} = HttpAgent.stream_canonical(agent, make_input())
    events = Enum.to_list(stream)

    # Should have interleaved events but still valid
    text_starts = Enum.filter(events, &match?(%TextMessageStart{}, &1))
    tool_starts = Enum.filter(events, &match?(%ToolCallStart{}, &1))

    assert(length(text_starts) >= 1, "Should have text message")
    assert(length(tool_starts) >= 1, "Should have tool call")

    # Tool call should reference parent message
    tool_start = hd(tool_starts)
    assert(tool_start.parent_message_id == "m1", "Tool call should reference parent message")

    verify_events(events)
  end

  defp test_multi_run_state(agent) do
    {:ok, result} = HttpAgent.run_agent(agent, make_input())

    state = result.session.state

    # State should have evolved across all 3 runs
    assert(state["counter"] == 3, "Counter should be 3 after 3 runs")
    assert(state["history"] == ["run1", "run2", "run3"], "History should have all runs")

    # Should have messages from runs 1 and 2 (run 3 had no messages)
    msg_count = length(result.session.messages)
    assert(msg_count >= 2, "Should have messages from multiple runs")

    :ok
  end

  defp test_error_recovery(agent) do
    {:ok, stream} = HttpAgent.stream_canonical(agent, make_input())
    events = Enum.to_list(stream)

    run_started = Enum.filter(events, &match?(%RunStarted{}, &1))
    run_errors = Enum.filter(events, &match?(%RunError{}, &1))
    run_finished = Enum.filter(events, &match?(%RunFinished{}, &1))

    assert(length(run_started) == 2, "Should have 2 RUN_STARTED (one failed, one recovered)")
    assert(length(run_errors) == 1, "Should have 1 RUN_ERROR")
    assert(length(run_finished) == 1, "Should have 1 RUN_FINISHED (recovery)")

    # Error should have proper code
    error = hd(run_errors)
    assert(error.code == "TIMEOUT", "Error code should be TIMEOUT")

    verify_events(events)
  end

  defp test_empty_content(agent) do
    {:ok, stream} = HttpAgent.stream_canonical(agent, make_input())
    events = Enum.to_list(stream)

    # Should handle empty deltas gracefully
    text_content = events
      |> Enum.filter(&match?(%TextMessageContent{}, &1))
      |> Enum.map(& &1.delta)
      |> Enum.join()

    assert(String.contains?(text_content, "actual content"), "Should have actual content despite empty deltas")

    # Should have empty state snapshot
    state_snapshots = Enum.filter(events, &match?(%StateSnapshot{}, &1))
    assert(length(state_snapshots) >= 1, "Should have state snapshot")

    # Empty delta should be valid
    state_deltas = Enum.filter(events, &match?(%StateDelta{}, &1))
    assert(length(state_deltas) >= 1, "Should have state delta")

    verify_events(events)
  end

  defp test_multi_tool_same_message(agent) do
    {:ok, result} = HttpAgent.run_agent(agent, make_input())

    # Should have 3 tool results
    tool_msgs = Enum.filter(result.new_messages, &match?(%Message.Tool{}, &1))
    assert(length(tool_msgs) == 3, "Should have 3 tool result messages")

    # Should have assistant message with 3 tool calls
    assistant_msgs = Enum.filter(result.new_messages, fn m ->
      match?(%Message.Assistant{}, m) and length(m.tool_calls || []) > 0
    end)
    assert(length(assistant_msgs) >= 1, "Should have assistant message with tool calls")

    assistant = hd(assistant_msgs)
    assert(length(assistant.tool_calls) == 3, "Assistant message should have 3 tool calls")

    :ok
  end

  defp test_long_stream(agent) do
    {:ok, stream} = HttpAgent.stream_canonical(agent, make_input())
    events = Enum.to_list(stream)

    # Should have 100 content events
    text_content = Enum.filter(events, &match?(%TextMessageContent{}, &1))
    assert(length(text_content) == 100, "Should have 100 TEXT_MESSAGE_CONTENT events")

    # Content should be properly assembled
    full_content = text_content |> Enum.map(& &1.delta) |> Enum.join()
    assert(String.contains?(full_content, "Chunk 1."), "Should have first chunk")
    assert(String.contains?(full_content, "Chunk 100."), "Should have last chunk")

    verify_events(events)
  end

  defp verify_events(events) do
    case Verify.verify_events(events) do
      :ok ->
        IO.puts("  Events verified OK")
        :ok

      {:error, reason} ->
        IO.puts("  VERIFICATION FAILED: #{inspect(reason)}")
        :error
    end
  end

  defp assert(true, _msg), do: :ok

  defp assert(false, msg) do
    IO.puts("  ASSERTION FAILED: #{msg}")
    throw(:assertion_failed)
  end
end

# Main execution
IO.puts("""
============================================
AG-UI Protocol Integration Tests
============================================
""")

port = 4002

# Start test server
{:ok, _} = Bandit.start_link(plug: IntegrationTest.Server, port: port)
IO.puts("Test server started on port #{port}\n")

# Give server time to start
Process.sleep(100)

# Run tests
base_url = "http://localhost:#{port}"
IntegrationTest.Runner.run_all(base_url)
