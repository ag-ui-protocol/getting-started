defmodule AgUiDemo.Scenarios do
  @moduledoc """
  Demo scenarios that generate AG-UI event streams.

  Each scenario demonstrates a different aspect of the AG-UI protocol.
  """

  @doc """
  Returns a list of events for the given scenario.
  """
  def get(scenario, opts \\ [])

  def get("text_streaming", opts) do
    thread_id = Keyword.get(opts, :thread_id, "demo-thread")
    run_id = Keyword.get(opts, :run_id, uuid4())
    delay = Keyword.get(opts, :delay, 50)

    words =
      String.split(
        "Hello! I'm an AI assistant powered by AG-UI. I can help you with various tasks. This is a demonstration of real-time text streaming.",
        " "
      )

    base_events = [
      %{type: "RUN_STARTED", threadId: thread_id, runId: run_id},
      %{type: "TEXT_MESSAGE_START", messageId: "msg-1", role: "assistant"}
    ]

    content_events =
      Enum.map(words, fn word ->
        %{type: "TEXT_MESSAGE_CONTENT", messageId: "msg-1", delta: word <> " "}
      end)

    end_events = [
      %{type: "TEXT_MESSAGE_END", messageId: "msg-1"},
      %{type: "RUN_FINISHED", threadId: thread_id, runId: run_id}
    ]

    {base_events ++ content_events ++ end_events, delay}
  end

  def get("tool_call", opts) do
    thread_id = Keyword.get(opts, :thread_id, "demo-thread")
    run_id = Keyword.get(opts, :run_id, uuid4())
    delay = Keyword.get(opts, :delay, 100)

    events = [
      %{type: "RUN_STARTED", threadId: thread_id, runId: run_id},
      %{type: "TEXT_MESSAGE_START", messageId: "msg-1", role: "assistant"},
      %{
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "msg-1",
        delta: "Let me search for that information..."
      },
      %{type: "TEXT_MESSAGE_END", messageId: "msg-1"},
      %{
        type: "TOOL_CALL_START",
        toolCallId: "tc-1",
        toolCallName: "search",
        parentMessageId: "msg-1"
      },
      %{type: "TOOL_CALL_ARGS", toolCallId: "tc-1", delta: "{\"query\":"},
      %{type: "TOOL_CALL_ARGS", toolCallId: "tc-1", delta: " \"AG-UI protocol\""},
      %{type: "TOOL_CALL_ARGS", toolCallId: "tc-1", delta: "}"},
      %{type: "TOOL_CALL_END", toolCallId: "tc-1"},
      %{
        type: "TOOL_CALL_RESULT",
        messageId: "tool-1",
        toolCallId: "tc-1",
        content:
          Jason.encode!(%{
            results: [
              %{title: "AG-UI Protocol", url: "https://docs.ag-ui.com"},
              %{title: "Getting Started", url: "https://docs.ag-ui.com/getting-started"}
            ]
          }),
        role: "tool"
      },
      %{type: "TEXT_MESSAGE_START", messageId: "msg-2", role: "assistant"},
      %{
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "msg-2",
        delta: "I found some results about the AG-UI protocol. "
      },
      %{
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "msg-2",
        delta: "It's an open protocol for agent-user interaction!"
      },
      %{type: "TEXT_MESSAGE_END", messageId: "msg-2"},
      %{type: "RUN_FINISHED", threadId: thread_id, runId: run_id}
    ]

    {events, delay}
  end

  def get("state_sync", opts) do
    thread_id = Keyword.get(opts, :thread_id, "demo-thread")
    run_id = Keyword.get(opts, :run_id, uuid4())
    delay = Keyword.get(opts, :delay, 200)

    events = [
      %{type: "RUN_STARTED", threadId: thread_id, runId: run_id},
      %{type: "STATE_SNAPSHOT", snapshot: %{counter: 0, items: []}},
      %{type: "TEXT_MESSAGE_START", messageId: "msg-1", role: "assistant"},
      %{type: "TEXT_MESSAGE_CONTENT", messageId: "msg-1", delta: "Initializing state... "},
      %{type: "TEXT_MESSAGE_END", messageId: "msg-1"},
      %{type: "STATE_DELTA", delta: [%{op: "replace", path: "/counter", value: 1}]},
      %{type: "STATE_DELTA", delta: [%{op: "add", path: "/items/-", value: "first"}]},
      %{type: "TEXT_MESSAGE_START", messageId: "msg-2", role: "assistant"},
      %{type: "TEXT_MESSAGE_CONTENT", messageId: "msg-2", delta: "Adding items... "},
      %{type: "TEXT_MESSAGE_END", messageId: "msg-2"},
      %{type: "STATE_DELTA", delta: [%{op: "replace", path: "/counter", value: 2}]},
      %{type: "STATE_DELTA", delta: [%{op: "add", path: "/items/-", value: "second"}]},
      %{type: "STATE_DELTA", delta: [%{op: "replace", path: "/counter", value: 3}]},
      %{type: "STATE_DELTA", delta: [%{op: "add", path: "/items/-", value: "third"}]},
      %{type: "TEXT_MESSAGE_START", messageId: "msg-3", role: "assistant"},
      %{
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "msg-3",
        delta: "State sync complete! Counter: 3, Items: [first, second, third]"
      },
      %{type: "TEXT_MESSAGE_END", messageId: "msg-3"},
      %{type: "RUN_FINISHED", threadId: thread_id, runId: run_id}
    ]

    {events, delay}
  end

  def get("steps", opts) do
    thread_id = Keyword.get(opts, :thread_id, "demo-thread")
    run_id = Keyword.get(opts, :run_id, uuid4())
    delay = Keyword.get(opts, :delay, 300)

    events = [
      %{type: "RUN_STARTED", threadId: thread_id, runId: run_id},
      %{type: "STEP_STARTED", stepName: "analyzing"},
      %{type: "TEXT_MESSAGE_START", messageId: "msg-1", role: "assistant"},
      %{type: "TEXT_MESSAGE_CONTENT", messageId: "msg-1", delta: "Analyzing your request..."},
      %{type: "TEXT_MESSAGE_END", messageId: "msg-1"},
      %{type: "STEP_FINISHED", stepName: "analyzing"},
      %{type: "STEP_STARTED", stepName: "processing"},
      %{type: "TEXT_MESSAGE_START", messageId: "msg-2", role: "assistant"},
      %{type: "TEXT_MESSAGE_CONTENT", messageId: "msg-2", delta: "Processing data..."},
      %{type: "TEXT_MESSAGE_END", messageId: "msg-2"},
      %{type: "STEP_FINISHED", stepName: "processing"},
      %{type: "STEP_STARTED", stepName: "generating"},
      %{type: "TEXT_MESSAGE_START", messageId: "msg-3", role: "assistant"},
      %{type: "TEXT_MESSAGE_CONTENT", messageId: "msg-3", delta: "Generating response..."},
      %{type: "TEXT_MESSAGE_END", messageId: "msg-3"},
      %{type: "STEP_FINISHED", stepName: "generating"},
      %{type: "TEXT_MESSAGE_START", messageId: "msg-4", role: "assistant"},
      %{
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "msg-4",
        delta: "All steps completed successfully!"
      },
      %{type: "TEXT_MESSAGE_END", messageId: "msg-4"},
      %{type: "RUN_FINISHED", threadId: thread_id, runId: run_id}
    ]

    {events, delay}
  end

  def get("thinking", opts) do
    thread_id = Keyword.get(opts, :thread_id, "demo-thread")
    run_id = Keyword.get(opts, :run_id, uuid4())
    delay = Keyword.get(opts, :delay, 100)

    events = [
      %{type: "RUN_STARTED", threadId: thread_id, runId: run_id},
      %{type: "THINKING_START"},
      %{type: "THINKING_TEXT_MESSAGE_START"},
      %{type: "THINKING_TEXT_MESSAGE_CONTENT", delta: "Let me think about this... "},
      %{type: "THINKING_TEXT_MESSAGE_CONTENT", delta: "I need to consider multiple factors. "},
      %{type: "THINKING_TEXT_MESSAGE_CONTENT", delta: "The best approach would be..."},
      %{type: "THINKING_TEXT_MESSAGE_END"},
      %{type: "THINKING_END"},
      %{type: "TEXT_MESSAGE_START", messageId: "msg-1", role: "assistant"},
      %{type: "TEXT_MESSAGE_CONTENT", messageId: "msg-1", delta: "After careful consideration, "},
      %{type: "TEXT_MESSAGE_CONTENT", messageId: "msg-1", delta: "here's my answer: "},
      %{type: "TEXT_MESSAGE_CONTENT", messageId: "msg-1", delta: "The AG-UI protocol is great!"},
      %{type: "TEXT_MESSAGE_END", messageId: "msg-1"},
      %{type: "RUN_FINISHED", threadId: thread_id, runId: run_id}
    ]

    {events, delay}
  end

  def get("error", opts) do
    thread_id = Keyword.get(opts, :thread_id, "demo-thread")
    run_id = Keyword.get(opts, :run_id, uuid4())
    delay = Keyword.get(opts, :delay, 100)

    events = [
      %{type: "RUN_STARTED", threadId: thread_id, runId: run_id},
      %{type: "TEXT_MESSAGE_START", messageId: "msg-1", role: "assistant"},
      %{type: "TEXT_MESSAGE_CONTENT", messageId: "msg-1", delta: "Starting operation... "},
      %{type: "TEXT_MESSAGE_END", messageId: "msg-1"},
      %{type: "RUN_ERROR", message: "Simulated error: Something went wrong during processing!"}
    ]

    {events, delay}
  end

  def get("chunk_mode", opts) do
    thread_id = Keyword.get(opts, :thread_id, "demo-thread")
    run_id = Keyword.get(opts, :run_id, uuid4())
    delay = Keyword.get(opts, :delay, 50)

    # Use TEXT_MESSAGE_CHUNK which should be normalized to START/CONTENT/END
    events = [
      %{type: "RUN_STARTED", threadId: thread_id, runId: run_id},
      %{type: "TEXT_MESSAGE_CHUNK", messageId: "msg-1", role: "assistant", delta: "This "},
      %{type: "TEXT_MESSAGE_CHUNK", messageId: "msg-1", delta: "message "},
      %{type: "TEXT_MESSAGE_CHUNK", messageId: "msg-1", delta: "uses "},
      %{type: "TEXT_MESSAGE_CHUNK", messageId: "msg-1", delta: "chunk "},
      %{type: "TEXT_MESSAGE_CHUNK", messageId: "msg-1", delta: "events "},
      %{type: "TEXT_MESSAGE_CHUNK", messageId: "msg-1", delta: "for "},
      %{type: "TEXT_MESSAGE_CHUNK", messageId: "msg-1", delta: "streaming!"},
      %{type: "RUN_FINISHED", threadId: thread_id, runId: run_id}
    ]

    {events, delay}
  end

  def get("tool_chunk", opts) do
    thread_id = Keyword.get(opts, :thread_id, "demo-thread")
    run_id = Keyword.get(opts, :run_id, uuid4())
    delay = Keyword.get(opts, :delay, 80)

    events = [
      %{type: "RUN_STARTED", threadId: thread_id, runId: run_id},
      %{type: "TEXT_MESSAGE_START", messageId: "msg-1", role: "assistant"},
      %{
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "msg-1",
        delta: "Calling a tool via chunked args..."
      },
      %{type: "TEXT_MESSAGE_END", messageId: "msg-1"},
      %{type: "TOOL_CALL_CHUNK", toolCallId: "tc-1", toolCallName: "search", delta: "{\"q\":"},
      %{type: "TOOL_CALL_CHUNK", toolCallId: nil, delta: " \"AG-UI\""},
      %{type: "TOOL_CALL_CHUNK", toolCallId: nil, delta: "}"},
      %{type: "RUN_FINISHED", threadId: thread_id, runId: run_id}
    ]

    {events, delay}
  end

  def get("multiple_runs", opts) do
    thread_id = Keyword.get(opts, :thread_id, "demo-thread")
    delay = Keyword.get(opts, :delay, 100)

    run_id_1 = uuid4()
    run_id_2 = uuid4()

    events = [
      # First run
      %{type: "RUN_STARTED", threadId: thread_id, runId: run_id_1},
      %{type: "TEXT_MESSAGE_START", messageId: "msg-1", role: "assistant"},
      %{type: "TEXT_MESSAGE_CONTENT", messageId: "msg-1", delta: "This is run 1. "},
      %{type: "TEXT_MESSAGE_CONTENT", messageId: "msg-1", delta: "Messages will accumulate."},
      %{type: "TEXT_MESSAGE_END", messageId: "msg-1"},
      %{type: "RUN_FINISHED", threadId: thread_id, runId: run_id_1},
      # Second run (messages accumulate)
      %{type: "RUN_STARTED", threadId: thread_id, runId: run_id_2},
      %{type: "TEXT_MESSAGE_START", messageId: "msg-2", role: "assistant"},
      %{type: "TEXT_MESSAGE_CONTENT", messageId: "msg-2", delta: "This is run 2. "},
      %{
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "msg-2",
        delta: "Both messages are now visible!"
      },
      %{type: "TEXT_MESSAGE_END", messageId: "msg-2"},
      %{type: "RUN_FINISHED", threadId: thread_id, runId: run_id_2}
    ]

    {events, delay}
  end

  def get("activity", opts) do
    thread_id = Keyword.get(opts, :thread_id, "demo-thread")
    run_id = Keyword.get(opts, :run_id, uuid4())
    delay = Keyword.get(opts, :delay, 120)

    events = [
      %{type: "RUN_STARTED", threadId: thread_id, runId: run_id},
      %{
        type: "ACTIVITY_SNAPSHOT",
        messageId: "act-1",
        activityType: "search_results",
        content: %{results: [%{title: "AG-UI", url: "https://docs.ag-ui.com"}]},
        replace: true
      },
      %{
        type: "ACTIVITY_DELTA",
        messageId: "act-1",
        activityType: "search_results",
        patch: [
          %{
            op: "add",
            path: "/results/-",
            value: %{title: "Specs", url: "https://docs.ag-ui.com/sdk"}
          }
        ]
      },
      %{type: "RUN_FINISHED", threadId: thread_id, runId: run_id}
    ]

    {events, delay}
  end

  def get("messages_snapshot", opts) do
    thread_id = Keyword.get(opts, :thread_id, "demo-thread")
    run_id = Keyword.get(opts, :run_id, uuid4())
    delay = Keyword.get(opts, :delay, 80)

    events = [
      %{type: "RUN_STARTED", threadId: thread_id, runId: run_id},
      %{
        type: "MESSAGES_SNAPSHOT",
        messages: [
          %{id: "u-1", role: "user", content: "Hello"},
          %{id: "a-1", role: "assistant", content: "Hi! This transcript was replaced."}
        ]
      },
      %{type: "RUN_FINISHED", threadId: thread_id, runId: run_id}
    ]

    {events, delay}
  end

  def get("state_any", opts) do
    thread_id = Keyword.get(opts, :thread_id, "demo-thread")
    run_id = Keyword.get(opts, :run_id, uuid4())
    delay = Keyword.get(opts, :delay, 80)

    events = [
      %{type: "RUN_STARTED", threadId: thread_id, runId: run_id},
      %{type: "STATE_SNAPSHOT", snapshot: ["alpha", "beta"]},
      %{type: "TEXT_MESSAGE_START", messageId: "msg-1", role: "assistant"},
      %{
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "msg-1",
        delta: "State snapshot can be any JSON value."
      },
      %{type: "TEXT_MESSAGE_END", messageId: "msg-1"},
      %{type: "RUN_FINISHED", threadId: thread_id, runId: run_id}
    ]

    {events, delay}
  end

  def get("parent_run", opts) do
    thread_id = Keyword.get(opts, :thread_id, "demo-thread")
    run_id = Keyword.get(opts, :run_id, uuid4())
    parent_run_id = Keyword.get(opts, :parent_run_id, uuid4())
    delay = Keyword.get(opts, :delay, 80)

    events = [
      %{type: "RUN_STARTED", threadId: thread_id, runId: run_id, parentRunId: parent_run_id},
      %{type: "TEXT_MESSAGE_START", messageId: "msg-1", role: "assistant"},
      %{type: "TEXT_MESSAGE_CONTENT", messageId: "msg-1", delta: "This run has a parentRunId."},
      %{type: "TEXT_MESSAGE_END", messageId: "msg-1"},
      %{type: "RUN_FINISHED", threadId: thread_id, runId: run_id}
    ]

    {events, delay}
  end

  def get("raw_custom", opts) do
    thread_id = Keyword.get(opts, :thread_id, "demo-thread")
    run_id = Keyword.get(opts, :run_id, uuid4())
    delay = Keyword.get(opts, :delay, 80)

    events = [
      %{type: "RUN_STARTED", threadId: thread_id, runId: run_id},
      %{type: "RAW", data: %{"note" => "raw passthrough"}},
      %{type: "CUSTOM", name: "demo_event", value: %{"ok" => true}},
      %{type: "RUN_FINISHED", threadId: thread_id, runId: run_id}
    ]

    {events, delay}
  end

  @doc """
  Returns a list of available scenario names.
  """
  def list do
    [
      {"text_streaming", "Basic Text Streaming", "Simple assistant message streaming"},
      {"tool_call", "Tool Call Lifecycle", "Tool call with streaming args and result"},
      {"state_sync", "State Synchronization", "STATE_SNAPSHOT and STATE_DELTA demo"},
      {"steps", "Steps Timeline", "STEP_STARTED/STEP_FINISHED visualization"},
      {"thinking", "Thinking Mode", "THINKING_* events demonstration"},
      {"error", "Error Handling", "RUN_ERROR display"},
      {"chunk_mode", "Chunk Normalization", "TEXT_MESSAGE_CHUNK auto-expansion"},
      {"tool_chunk", "Tool Chunk Normalization", "TOOL_CALL_CHUNK auto-expansion"},
      {"activity", "Activity Messages", "ACTIVITY_SNAPSHOT and ACTIVITY_DELTA demo"},
      {"messages_snapshot", "Messages Snapshot", "MESSAGES_SNAPSHOT replaces transcript"},
      {"state_any", "State Any", "STATE_SNAPSHOT with non-map data"},
      {"parent_run", "Parent Run", "RUN_STARTED with parentRunId"},
      {"raw_custom", "Raw & Custom", "RAW and CUSTOM passthrough events"},
      {"multiple_runs", "Multiple Runs", "Sequential runs in same session"}
    ]
  end

  # Generate a UUID v4
  defp uuid4 do
    <<u0::48, _::4, u1::12, _::2, u2::62>> = :crypto.strong_rand_bytes(16)

    <<u0::48, 4::4, u1::12, 2::2, u2::62>>
    |> Base.encode16(case: :lower)
    |> String.replace(~r/(.{8})(.{4})(.{4})(.{4})(.{12})/, "\\1-\\2-\\3-\\4-\\5")
  end
end
