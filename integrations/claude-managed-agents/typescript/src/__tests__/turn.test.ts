import { EventType } from "@ag-ui/client";
import type { BaseEvent } from "@ag-ui/client";
import { APIError } from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { TOOL_RESULT_MAX_CHARS } from "../constants";
import { runTurn } from "../turn";
import { createFakeClient } from "./fake-client";

const idleEndTurn = { type: "session.status_idle", id: "idle_1", stop_reason: { type: "end_turn" } };

const collect = async (
  streamEvents: unknown[],
  overrides: Partial<Parameters<typeof runTurn>[0]> = {},
  clientOptions: Parameters<typeof createFakeClient>[0] = {},
) => {
  const fake = createFakeClient({ streams: [streamEvents], ...clientOptions });
  const emitted: BaseEvent[] = [];
  const outcome = await runTurn({
    client: fake.client,
    sessionId: "sesn_1",
    outbound: [{ type: "user.message", content: [{ type: "text", text: "hi" }] }],
    clientTools: new Map(),
    backendTools: new Map(),
    toolConfirmation: undefined,
    streamDeltas: true,
    emit: (event) => emitted.push(event),
    signal: new AbortController().signal,
    ...overrides,
  });
  return { emitted, outcome, fake };
};

const types = (events: BaseEvent[]) => events.map((event) => event.type);

// Built from the real SDK error class rather than a stand-in, so the retry
// matcher is exercised against the error the default client actually throws.
const parkedError = () =>
  new APIError(
    400,
    { type: "error", error: { type: "invalid_request_error", message: "session is waiting on responses to events [ctu_1]" } },
    undefined,
    undefined,
  );

describe("runTurn", () => {
  it("streams a text preview, tops it up from the buffered message, and finishes", async () => {
    const { emitted, outcome, fake } = await collect([
      { type: "session.status_running", id: "run_1" },
      { type: "event_start", event: { type: "agent.message", id: "msg_1" } },
      { type: "event_delta", event_id: "msg_1", delta: { type: "content_delta", index: 0, content: { type: "text", text: "Hel" } } },
      { type: "event_delta", event_id: "msg_1", delta: { type: "content_delta", index: 0, content: { type: "text", text: "lo" } } },
      { type: "agent.message", id: "msg_1", content: [{ type: "text", text: "Hello there" }] },
      idleEndTurn,
    ]);

    expect(outcome).toEqual({ status: "finished" });
    expect(fake.sent[0].events).toEqual([{ type: "user.message", content: [{ type: "text", text: "hi" }] }]);
    expect(emitted).toEqual([
      { type: EventType.TEXT_MESSAGE_START, messageId: "msg_1", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg_1", delta: "Hel" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg_1", delta: "lo" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg_1", delta: " there" },
      { type: EventType.TEXT_MESSAGE_END, messageId: "msg_1" },
    ]);
  });

  it("requests previews only when streaming deltas", async () => {
    const on = await collect([idleEndTurn]);
    expect(on.fake.spies.stream.mock.calls[0]![1]).toEqual({ event_deltas: ["agent.message", "agent.thinking"] });

    const off = await collect([idleEndTurn], { streamDeltas: false });
    expect(off.fake.spies.stream.mock.calls[0]![1]).toEqual({});
  });

  it("emits a whole message when there was no preview", async () => {
    const { emitted } = await collect([
      { type: "agent.message", id: "msg_1", content: [{ type: "text", text: "All at once" }] },
      idleEndTurn,
    ]);
    expect(emitted).toEqual([
      { type: EventType.TEXT_MESSAGE_START, messageId: "msg_1", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg_1", delta: "All at once" },
      { type: EventType.TEXT_MESSAGE_END, messageId: "msg_1" },
    ]);
  });

  it("re-emits a corrected message when the preview diverges", async () => {
    const { emitted } = await collect([
      { type: "event_start", event: { type: "agent.message", id: "msg_1" } },
      { type: "event_delta", event_id: "msg_1", delta: { type: "content_delta", index: 0, content: { type: "text", text: "Draft" } } },
      { type: "agent.message", id: "msg_1", content: [{ type: "text", text: "Final" }] },
      idleEndTurn,
    ]);
    expect(emitted).toEqual([
      { type: EventType.TEXT_MESSAGE_START, messageId: "msg_1", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg_1", delta: "Draft" },
      { type: EventType.TEXT_MESSAGE_END, messageId: "msg_1" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "corrected_msg_1", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "corrected_msg_1", delta: "Final" },
      { type: EventType.TEXT_MESSAGE_END, messageId: "corrected_msg_1" },
    ]);
  });

  it("does not emit an empty text delta", async () => {
    const { emitted } = await collect([
      { type: "event_start", event: { type: "agent.message", id: "msg_1" } },
      { type: "event_delta", event_id: "msg_1", delta: { type: "content_delta", index: 0, content: { type: "text", text: "" } } },
      { type: "event_delta", event_id: "msg_1", delta: { type: "content_delta", index: 0, content: { type: "text", text: "Hi" } } },
      { type: "agent.message", id: "msg_1", content: [{ type: "text", text: "Hi" }] },
      // A whole message with no text: start and end only.
      { type: "agent.message", id: "msg_2", content: [] },
      idleEndTurn,
    ]);
    expect(emitted).toEqual([
      { type: EventType.TEXT_MESSAGE_START, messageId: "msg_1", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg_1", delta: "Hi" },
      { type: EventType.TEXT_MESSAGE_END, messageId: "msg_1" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "msg_2", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_END, messageId: "msg_2" },
    ]);
  });

  it("falls back to the buffered message when preview accumulation throws", async () => {
    const { emitted } = await collect([
      { type: "event_start", event: { type: "agent.message", id: "msg_1" } },
      { type: "event_delta", event_id: "msg_1", delta: { type: "content_delta", index: 0, content: { type: "text", text: "Hel" } } },
      // A gapped delta (index 5 with only one block) makes the SDK's accumulator throw.
      { type: "event_delta", event_id: "msg_1", delta: { type: "content_delta", index: 5, content: { type: "text", text: "??" } } },
      { type: "agent.message", id: "msg_1", content: [{ type: "text", text: "Hello world" }] },
      idleEndTurn,
    ]);
    expect(emitted).toEqual([
      { type: EventType.TEXT_MESSAGE_START, messageId: "msg_1", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg_1", delta: "Hel" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg_1", delta: "lo world" },
      { type: EventType.TEXT_MESSAGE_END, messageId: "msg_1" },
    ]);
  });

  it("maps a thinking stretch to reasoning start and end", async () => {
    const { emitted } = await collect([
      { type: "event_start", event: { type: "agent.thinking", id: "think_1" } },
      { type: "agent.thinking", id: "think_1" },
      idleEndTurn,
    ]);
    expect(types(emitted)).toEqual([
      EventType.REASONING_START,
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_END,
      EventType.REASONING_END,
    ]);
  });

  it("maps an unpreviewed thinking event to an empty reasoning pair", async () => {
    const { emitted } = await collect([{ type: "agent.thinking", id: "think_1" }, idleEndTurn]);
    expect(types(emitted)).toEqual([EventType.REASONING_START, EventType.REASONING_END]);
  });

  it("streams built-in tool calls and their results", async () => {
    const { emitted } = await collect([
      { type: "agent.tool_use", id: "tu_1", name: "bash", input: { command: "ls" } },
      { type: "agent.tool_result", id: "tr_1", tool_use_id: "tu_1", content: [{ type: "text", text: "file.txt" }] },
      idleEndTurn,
    ]);
    expect(emitted).toEqual([
      { type: EventType.TOOL_CALL_START, toolCallId: "tu_1", toolCallName: "bash" },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "tu_1", delta: '{"command":"ls"}' },
      { type: EventType.TOOL_CALL_END, toolCallId: "tu_1" },
      { type: EventType.TOOL_CALL_RESULT, messageId: "result_tu_1", toolCallId: "tu_1", content: "file.txt", role: "tool" },
    ]);
  });

  it("truncates a very large tool result", async () => {
    const { emitted } = await collect([
      { type: "agent.tool_use", id: "tu_1", name: "bash", input: {} },
      { type: "agent.tool_result", id: "tr_1", tool_use_id: "tu_1", content: [{ type: "text", text: "x".repeat(TOOL_RESULT_MAX_CHARS + 500) }] },
      idleEndTurn,
    ]);
    const result = emitted.at(-1) as unknown as { content: string };
    expect(result.content).toHaveLength(TOOL_RESULT_MAX_CHARS);
  });

  it("maps MCP tool calls with a server-qualified name", async () => {
    const { emitted } = await collect([
      { type: "agent.mcp_tool_use", id: "mcp_1", name: "search", mcp_server_name: "docs", input: { q: "x" } },
      { type: "agent.mcp_tool_result", id: "mr_1", mcp_tool_use_id: "mcp_1", content: [{ type: "text", text: "found" }] },
      idleEndTurn,
    ]);
    expect(emitted[0]).toEqual({ type: EventType.TOOL_CALL_START, toolCallId: "mcp_1", toolCallName: "docs: search" });
    expect(emitted[3]).toMatchObject({ type: EventType.TOOL_CALL_RESULT, toolCallId: "mcp_1", content: "found" });
  });

  it("flattens mixed tool result content into readable text", async () => {
    const { emitted } = await collect([
      { type: "agent.tool_use", id: "tu_1", name: "search", input: {} },
      {
        type: "agent.tool_result",
        id: "tr_1",
        tool_use_id: "tu_1",
        content: [
          { type: "text", text: "Caf&eacute; &amp; &#39;more&#39; &lt;b&gt;" },
          { type: "search_result", title: "Docs &amp; guides", source: "https://example.com", content: [{ type: "text", text: "body text" }] },
          { type: "image", source: {} },
        ],
      },
      idleEndTurn,
    ]);
    expect(emitted.at(-1)).toEqual({
      type: EventType.TOOL_CALL_RESULT,
      messageId: "result_tu_1",
      toolCallId: "tu_1",
      // The text block is literal tool output and stays verbatim; only the
      // search result, whose body comes from HTML, is decoded.
      content:
        "Caf&eacute; &amp; &#39;more&#39; &lt;b&gt;\n[search result] Docs & guides — https://example.com\nbody text\n[image]",
      role: "tool",
    });
  });

  it("runs a backend tool and posts its result back into the session", async () => {
    const backend = { name: "get_time", description: "", parameters: {}, handler: async () => "noon" };
    const { emitted, fake } = await collect(
      [
        { type: "agent.custom_tool_use", id: "ctu_1", name: "get_time", input: {} },
        { type: "session.status_idle", id: "idle_1", stop_reason: { type: "requires_action", event_ids: ["ctu_1"] } },
        idleEndTurn,
      ],
      { backendTools: new Map([["get_time", backend]]) },
    );
    expect(emitted).toContainEqual({
      type: EventType.TOOL_CALL_RESULT,
      messageId: "result_ctu_1",
      toolCallId: "ctu_1",
      content: "noon",
      role: "tool",
    });
    expect(fake.sent[1].events).toEqual([
      { type: "user.custom_tool_result", custom_tool_use_id: "ctu_1", content: [{ type: "text", text: "noon" }], is_error: false },
    ]);
  });

  it("reports a throwing backend handler as one error result", async () => {
    const backend = {
      name: "get_time",
      description: "",
      parameters: {},
      handler: () => {
        throw new Error("clock offline");
      },
    };
    const { emitted, fake } = await collect(
      [{ type: "agent.custom_tool_use", id: "ctu_1", name: "get_time", input: {} }, idleEndTurn],
      { backendTools: new Map([["get_time", backend]]) },
    );

    expect(fake.sent[1].events).toEqual([
      { type: "user.custom_tool_result", custom_tool_use_id: "ctu_1", content: [{ type: "text", text: "clock offline" }], is_error: true },
    ]);
    const results = emitted.filter((event) => event.type === EventType.TOOL_CALL_RESULT);
    expect(results).toEqual([
      { type: EventType.TOOL_CALL_RESULT, messageId: "result_ctu_1", toolCallId: "ctu_1", content: "clock offline", role: "tool" },
    ]);
  });

  it("never reports a tool result the session did not receive, and interrupts", async () => {
    // Regression: the result is delivered before the UI is told about it. A
    // TOOL_CALL_RESULT the agent never saw would report a success that did not
    // happen, and the session stays parked on the call — so it is interrupted.
    const backend = { name: "get_time", description: "", parameters: {}, handler: async () => "noon" };
    // First send (the user message) succeeds; the result post fails.
    const { emitted, outcome, fake } = await collect(
      [{ type: "agent.custom_tool_use", id: "ctu_1", name: "get_time", input: {} }, idleEndTurn],
      { backendTools: new Map([["get_time", backend]]) },
      { sendResults: [undefined, new Error("send failed")] },
    );

    expect(outcome).toMatchObject({ status: "errored" });
    expect(emitted.filter((event) => event.type === EventType.TOOL_CALL_RESULT)).toHaveLength(0);
    expect(emitted.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "tool_result_delivery_failed",
      message: "The result of tool call ctu_1 could not be delivered to the session.",
    });
    expect(fake.sent.flatMap((send) => send.events)).toContainEqual({ type: "user.interrupt" });
  });

  it("reports its own cause when a tool confirmation cannot be delivered", async () => {
    const { emitted, outcome, fake } = await collect(
      [
        { type: "agent.tool_use", id: "tu_1", name: "bash", input: {}, evaluated_permission: "ask" },
        { type: "session.status_idle", id: "idle_1", stop_reason: { type: "requires_action", event_ids: ["tu_1"] } },
      ],
      { toolConfirmation: "allow" },
      // Send 0 is the user message; send 1 is the confirmation.
      { sendResults: [undefined, new Error("send failed")] },
    );

    expect(outcome).toMatchObject({ status: "errored" });
    expect(emitted.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "tool_confirmation_delivery_failed",
    });
    // The session is parked on the confirmation, so it is interrupted.
    expect(fake.sent.flatMap((send) => send.events)).toContainEqual({ type: "user.interrupt" });
  });

  it("reports a delivery failure for a tool nothing can execute", async () => {
    const { emitted, outcome, fake } = await collect(
      [{ type: "agent.custom_tool_use", id: "ctu_1", name: "mystery", input: {} }, idleEndTurn],
      {},
      { sendResults: [undefined, new Error("send failed")] },
    );

    expect(outcome).toMatchObject({ status: "errored" });
    expect(emitted.filter((event) => event.type === EventType.TOOL_CALL_RESULT)).toHaveLength(0);
    expect(emitted.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: "tool_result_delivery_failed" });
    expect(fake.sent.flatMap((send) => send.events)).toContainEqual({ type: "user.interrupt" });
  });

  it("emits the tool result only after the session accepted it", async () => {
    const backend = { name: "get_time", description: "", parameters: {}, handler: async () => "noon" };
    const order: string[] = [];
    const fake = createFakeClient({
      streams: [[{ type: "agent.custom_tool_use", id: "ctu_1", name: "get_time", input: {} }, idleEndTurn]],
    });
    const originalSend = fake.client.beta.sessions.events.send;
    fake.client.beta.sessions.events.send = (async (sessionId: string, params: { events: { type?: string }[] }) => {
      if (params.events.some((event) => event.type === "user.custom_tool_result")) order.push("sent");
      return originalSend(sessionId, params as never);
    }) as typeof originalSend;

    await runTurn({
      client: fake.client,
      sessionId: "sesn_1",
      outbound: [{ type: "user.message", content: [{ type: "text", text: "hi" }] }],
      clientTools: new Map(),
      backendTools: new Map([["get_time", backend]]),
      toolConfirmation: undefined,
      streamDeltas: true,
      emit: (event) => {
        if (event.type === EventType.TOOL_CALL_RESULT) order.push("emitted");
      },
      signal: new AbortController().signal,
    });

    expect(order).toEqual(["sent", "emitted"]);
  });

  it("posts an error result for a tool nothing can execute", async () => {
    const { fake } = await collect([{ type: "agent.custom_tool_use", id: "ctu_1", name: "mystery", input: {} }, idleEndTurn]);
    expect(fake.sent[1].events).toEqual([
      {
        type: "user.custom_tool_result",
        custom_tool_use_id: "ctu_1",
        content: [{ type: "text", text: 'No handler is registered for tool "mystery".' }],
        is_error: true,
      },
    ]);
  });

  it("records whether the interrupt it sent actually landed", async () => {
    // A landed interrupt cancels whatever the session was waiting on, so the
    // caller has to know: any park from this turn is no longer answerable.
    const idleUnknown = [
      { type: "session.status_idle", id: "idle_1", stop_reason: { type: "requires_action", event_ids: ["mystery_1"] } },
    ];

    const landed = await collect(idleUnknown);
    expect(landed.outcome).toEqual({ status: "errored", sessionInterrupted: true });

    // The interrupt is send #2 (the user message is #1).
    const failed = await collect(idleUnknown, {}, { sendResults: [undefined, new Error("interrupt rejected")] });
    expect(failed.outcome).toEqual({ status: "errored" });
  });

  it("reports an unhandled stop reason instead of reading its absent event ids", async () => {
    // Reading (absent) event_ids used to throw a TypeError here; every port now
    // interrupts the idle session and names the reason.
    const { emitted, outcome, fake } = await collect([
      { type: "session.status_idle", id: "idle_1", stop_reason: { type: "awaiting_martian_input" } },
    ]);

    expect(outcome).toMatchObject({ status: "errored" });
    expect(emitted.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "unknown_stop_reason",
      message: "The session went idle for a reason this integration does not handle: awaiting_martian_input.",
    });
    expect(fake.sent.flatMap((send) => send.events)).toContainEqual({ type: "user.interrupt" });
  });

  it("emits tool arguments as compact, unescaped JSON", async () => {
    // All three ports must agree byte for byte: no \uXXXX escaping of non-ASCII
    // and no HTML escaping of < > &.
    const { emitted } = await collect([
      { type: "agent.tool_use", id: "tu_1", name: "search", input: { q: "café <b>&</b> 日本", n: 1 } },
      idleEndTurn,
    ]);
    const args = emitted.find((event) => event.type === EventType.TOOL_CALL_ARGS) as unknown as { delta: string };
    expect(args.delta).toBe('{"q":"café <b>&</b> 日本","n":1}');
  });

  it("parks the turn when the frontend must execute a tool", async () => {
    const { emitted, outcome, fake } = await collect(
      [
        { type: "agent.custom_tool_use", id: "ctu_1", name: "confirm_purchase", input: { amount: 5 } },
        { type: "session.status_idle", id: "idle_1", stop_reason: { type: "requires_action", event_ids: ["ctu_1"] } },
      ],
      { clientTools: new Map([["confirm_purchase", "confirm_purchase"]]) },
    );
    expect(outcome).toEqual({ status: "parked", clientToolUseIds: ["ctu_1"] });
    expect(fake.sent).toHaveLength(1); // only the user message; no result posted
    expect(types(emitted)).toEqual([EventType.TOOL_CALL_START, EventType.TOOL_CALL_ARGS, EventType.TOOL_CALL_END]);
  });

  it("reports the frontend's original name for a normalized tool", async () => {
    const { emitted, outcome } = await collect(
      [
        { type: "agent.custom_tool_use", id: "ctu_1", name: "search_web", input: {} },
        { type: "session.status_idle", id: "idle_1", stop_reason: { type: "requires_action", event_ids: ["ctu_1"] } },
      ],
      { clientTools: new Map([["search_web", "search web"]]) },
    );
    expect(outcome).toEqual({ status: "parked", clientToolUseIds: ["ctu_1"] });
    expect(emitted[0]).toEqual({ type: EventType.TOOL_CALL_START, toolCallId: "ctu_1", toolCallName: "search web" });
  });

  it("answers a confirmation-gated tool when a policy is configured", async () => {
    const { outcome, fake } = await collect(
      [
        { type: "agent.tool_use", id: "tu_1", name: "bash", input: {}, evaluated_permission: "ask" },
        { type: "session.status_idle", id: "idle_1", stop_reason: { type: "requires_action", event_ids: ["tu_1"] } },
        { type: "agent.tool_result", id: "tr_1", tool_use_id: "tu_1", content: [] },
        idleEndTurn,
      ],
      { toolConfirmation: "allow" },
    );
    expect(outcome).toEqual({ status: "finished" });
    expect(fake.sent[1].events).toEqual([{ type: "user.tool_confirmation", tool_use_id: "tu_1", result: "allow" }]);
  });

  it("fails the run on a confirmation-gated tool with no policy", async () => {
    const { emitted, outcome, fake } = await collect([
      { type: "agent.tool_use", id: "tu_1", name: "bash", input: {}, evaluated_permission: "ask" },
      { type: "session.status_idle", id: "idle_1", stop_reason: { type: "requires_action", event_ids: ["tu_1"] } },
    ]);
    expect(outcome).toMatchObject({ status: "errored" });
    expect(emitted.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: "tool_confirmation_required" });
    expect(fake.sent[1].events).toEqual([{ type: "user.interrupt" }]);
  });

  it("interrupts and errors on a blocking action it cannot answer", async () => {
    const { emitted, outcome, fake } = await collect([
      { type: "session.status_idle", id: "idle_1", stop_reason: { type: "requires_action", event_ids: ["unknown_1"] } },
    ]);
    expect(outcome).toMatchObject({ status: "errored" });
    expect(emitted.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: "unsupported_action" });
    expect(fake.sent[1].events).toEqual([{ type: "user.interrupt" }]);
  });

  it("surfaces a terminal session error with its type as the code", async () => {
    const { emitted, outcome } = await collect([
      { type: "session.error", id: "err_1", error: { type: "billing_error", message: "Out of credits", retry_status: { type: "terminal" } } },
    ]);
    expect(outcome).toMatchObject({ status: "errored" });
    expect(emitted).toEqual([{ type: EventType.RUN_ERROR, message: "Out of credits", code: "billing_error" }]);
  });

  it("falls back to a stock message when a session error carries none", async () => {
    const { emitted } = await collect([
      { type: "session.error", id: "err_1", error: { type: "unknown_error", message: "", retry_status: { type: "terminal" } } },
    ]);
    expect(emitted).toEqual([{ type: EventType.RUN_ERROR, message: "The session reported an error.", code: "unknown_error" }]);
  });

  it("ignores a retrying session error and completes", async () => {
    const { outcome } = await collect([
      { type: "session.error", id: "err_1", error: { type: "model_overloaded_error", message: "busy", retry_status: { type: "retrying" } } },
      { type: "agent.message", id: "msg_1", content: [{ type: "text", text: "ok" }] },
      idleEndTurn,
    ]);
    expect(outcome).toEqual({ status: "finished" });
  });

  it("treats retries_exhausted as an error, not a clean finish", async () => {
    const { emitted, outcome } = await collect([
      { type: "session.status_idle", id: "idle_1", stop_reason: { type: "retries_exhausted" } },
    ]);
    expect(outcome).toMatchObject({ status: "errored" });
    expect(emitted.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: "retries_exhausted" });
  });

  it("reports a terminated session as ended", async () => {
    const { outcome } = await collect([{ type: "session.status_terminated", id: "term_1" }]);
    expect(outcome).toEqual({ status: "errored", sessionEnded: true });
  });

  it("reports a deleted session as ended", async () => {
    const { emitted, outcome } = await collect([{ type: "session.deleted", id: "del_1" }]);
    expect(outcome).toEqual({ status: "errored", sessionEnded: true });
    expect(emitted.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: "session_ended" });
  });

  it("closes a dangling preview when the model request errors without a message", async () => {
    const { emitted } = await collect([
      { type: "event_start", event: { type: "agent.message", id: "msg_1" } },
      { type: "event_delta", event_id: "msg_1", delta: { type: "content_delta", index: 0, content: { type: "text", text: "partia" } } },
      { type: "span.model_request_end", id: "span_1", model_request_start_id: "s_1", is_error: true, model_usage: {} },
      idleEndTurn,
    ]);
    expect(types(emitted)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
    ]);
  });

  it("keeps the top-up when a successful model_request_end arrives before the buffered message", async () => {
    const { emitted } = await collect([
      { type: "event_start", event: { type: "agent.message", id: "msg_1" } },
      { type: "event_delta", event_id: "msg_1", delta: { type: "content_delta", index: 0, content: { type: "text", text: "Hel" } } },
      // The span ends (success) before the buffered agent.message lands.
      { type: "span.model_request_end", id: "span_1", model_request_start_id: "s_1", is_error: false, model_usage: {} },
      { type: "agent.message", id: "msg_1", content: [{ type: "text", text: "Hello there" }] },
      idleEndTurn,
    ]);
    expect(emitted).toEqual([
      { type: EventType.TEXT_MESSAGE_START, messageId: "msg_1", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg_1", delta: "Hel" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg_1", delta: "lo there" },
      { type: EventType.TEXT_MESSAGE_END, messageId: "msg_1" },
    ]);
  });

  it("errors when the stream ends before the turn completes", async () => {
    const { emitted, outcome } = await collect([{ type: "event_start", event: { type: "agent.message", id: "msg_1" } }]);
    expect(outcome).toMatchObject({ status: "errored" });
    // The open message is closed before the error.
    expect(types(emitted)).toEqual([EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_END, EventType.RUN_ERROR]);
    expect(emitted.at(-1)).toMatchObject({ code: "stream_ended" });
  });

  it("retries a follow-up rejected while the session finishes un-parking", async () => {
    const { outcome, fake } = await collect(
      [{ type: "agent.message", id: "msg_1", content: [{ type: "text", text: "ok" }] }, idleEndTurn],
      {
        outbound: [
          { type: "user.custom_tool_result", custom_tool_use_id: "ctu_1", content: [{ type: "text", text: "done" }], is_error: false },
          { type: "user.message", content: [{ type: "text", text: "and then?" }] },
        ],
      },
      // Results post fine; the follow-up 400s twice before the session un-parks.
      { sendResults: [undefined, parkedError(), parkedError()] },
    );

    expect(outcome).toEqual({ status: "finished" });
    expect(fake.spies.send).toHaveBeenCalledTimes(4);
    expect(fake.sent.map((send) => send.events)).toEqual([
      [{ type: "user.custom_tool_result", custom_tool_use_id: "ctu_1", content: [{ type: "text", text: "done" }], is_error: false }],
      [{ type: "user.message", content: [{ type: "text", text: "and then?" }] }],
    ]);
  });
});
