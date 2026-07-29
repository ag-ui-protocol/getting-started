import {
  EventType,
  type BaseEvent,
  type RunAgentInput,
  type RunStartedEvent,
  type RunFinishedEvent,
  type RunErrorEvent,
  type TextMessageStartEvent,
  type TextMessageContentEvent,
  type TextMessageEndEvent,
  type ToolCallStartEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type ToolCallResultEvent,
  type CustomEvent,
  type RawEvent,
  type StateSnapshotEvent,
  type StateDeltaEvent,
  type ReasoningMessageStartEvent,
  type ReasoningMessageContentEvent,
  type ReasoningMessageEndEvent,
  type ActivitySnapshotEvent,
} from "@ag-ui/core";

// Mirrors the TS SDK test pattern: instead of subclassing AbstractAgent and
// returning of(...events), we expose a function that turns a RunAgentInput
// into the same canned event array. The HTTP server then writes each event
// through @ag-ui/encoder. This keeps the test code path identical to what
// the TS SDK client itself is tested against — just exposed over HTTP so a
// non-JS client (here, the C# AGUIChatClient) can consume the exact same
// events on the wire.

const runStarted = (input: RunAgentInput): RunStartedEvent => ({
  type: EventType.RUN_STARTED,
  threadId: input.threadId,
  runId: input.runId,
});

const runFinished = (input: RunAgentInput): RunFinishedEvent => ({
  type: EventType.RUN_FINISHED,
  threadId: input.threadId,
  runId: input.runId,
});

function textMessage(messageId: string, content: string, chunkSize = 6): BaseEvent[] {
  const start: TextMessageStartEvent = {
    type: EventType.TEXT_MESSAGE_START,
    messageId,
    role: "assistant",
  };
  const end: TextMessageEndEvent = {
    type: EventType.TEXT_MESSAGE_END,
    messageId,
  };
  // Chunk the content into a handful of deltas so the C# client exercises
  // its streaming aggregation path (single-chunk text would let a buggy
  // client get away without concatenating deltas correctly).
  const chunks = chunkString(content, chunkSize);
  const deltas: TextMessageContentEvent[] = chunks.map((chunk) => ({
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId,
    delta: chunk,
  }));
  return [start, ...deltas, end];
}

function chunkString(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) {
    out.push(s.slice(i, i + size));
  }
  return out.length > 0 ? out : [""];
}

function lastUserMessage(input: RunAgentInput): string {
  const userMessages = (input.messages ?? []).filter((m) => m.role === "user");
  const last = userMessages[userMessages.length - 1];
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  return "";
}

function userMessages(input: RunAgentInput): string[] {
  return (input.messages ?? [])
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : ""));
}

/**
 * Plain text-streaming agent. Mirrors the simplest TS SDK test agent
 * pattern (TextChunkAgent, FullTextAgent in middleware-chained-integration).
 * Also covers multi-turn context: the agent inspects the full message
 * history (not just the last user turn) so the C# client must replay it.
 */
export function agenticChat(input: RunAgentInput): BaseEvent[] {
  const events: BaseEvent[] = [runStarted(input)];
  const userTextOriginal = lastUserMessage(input);
  const userText = userTextOriginal.toLowerCase();
  const history = userMessages(input);

  let reply: string;
  if (userText.includes("duaa")) {
    reply = "Hello duaa! How can I assist you today?";
  } else if (userText.includes("capital of france")) {
    reply = "The capital of France is Paris.";
  } else if (userText.includes("first question")) {
    // Multi-turn: cite the first user message verbatim so the test can
    // assert the server actually saw it.
    reply = `Your first question was: ${history[0]}`;
  } else if (userText.includes("count to ten")) {
    // Long chunked text — broken into many small deltas via chunkSize=2.
    reply = "1 2 3 4 5 6 7 8 9 10";
    events.push(...textMessage(`msg-${input.runId}`, reply, 2));
    events.push(runFinished(input));
    return events;
  } else if (userText.includes("my name is")) {
    // Preserve the user's original capitalisation when echoing the name.
    const idx = userText.indexOf("my name is");
    const tail = userTextOriginal.slice(idx + "my name is".length).trim();
    const name = tail.split(/[\s.!?]/)[0] || "friend";
    reply = `Hello ${name}! Nice to meet you.`;
  } else if (userText.includes("what is my name")) {
    // Walk back through the history to find the introduction (preserving case).
    const introduction = history.find((m) => /my name is/i.test(m));
    let name: string | undefined;
    if (introduction) {
      const idx = introduction.toLowerCase().indexOf("my name is");
      const tail = introduction.slice(idx + "my name is".length).trim();
      name = tail.split(/[\s.!?]/)[0] || undefined;
    }
    reply = name ? `Your name is ${name}!` : "I don't remember your name.";
  } else {
    reply = `Echo: ${userTextOriginal}`;
  }

  events.push(...textMessage(`msg-${input.runId}`, reply));
  events.push(runFinished(input));
  return events;
}

/**
 * Backend-tool-rendering agent. Emits a server-side tool call followed by
 * its result and a final summary message. Mirrors the TS SDK's
 * ToolCallChunkAgent / FullToolCallAgent test pattern.
 */
export function backendToolRendering(input: RunAgentInput): BaseEvent[] {
  const events: BaseEvent[] = [runStarted(input)];
  const userText = lastUserMessage(input).toLowerCase();

  const toolCallId = `tc-${input.runId}`;
  const messageId = `msg-${input.runId}`;
  const location = userText.includes("paris")
    ? "Paris"
    : userText.includes("london")
      ? "London"
      : "San Francisco";

  const toolStart: ToolCallStartEvent = {
    type: EventType.TOOL_CALL_START,
    toolCallId,
    toolCallName: "get_weather",
    parentMessageId: messageId,
  };
  const toolArgs: ToolCallArgsEvent = {
    type: EventType.TOOL_CALL_ARGS,
    toolCallId,
    delta: JSON.stringify({ location }),
  };
  const toolEnd: ToolCallEndEvent = {
    type: EventType.TOOL_CALL_END,
    toolCallId,
  };
  const toolResult: ToolCallResultEvent = {
    type: EventType.TOOL_CALL_RESULT,
    toolCallId,
    messageId: `tool-result-${toolCallId}`,
    role: "tool",
    content: JSON.stringify({
      location,
      temperature: 72,
      conditions: "sunny",
    }),
  };

  events.push(toolStart, toolArgs, toolEnd, toolResult);
  events.push(
    ...textMessage(
      messageId,
      `It is currently 72°F and sunny in ${location}.`,
    ),
  );
  events.push(runFinished(input));
  return events;
}

/**
 * Tool call streamed across many TOOL_CALL_ARGS chunks. Tests that the
 * C# client reassembles the full JSON before surfacing the FunctionCall
 * regardless of how the server chunks the args delta. Also omits the
 * TOOL_CALL_RESULT to model the frontend-tool case: the LLM proposes a
 * tool, the client is expected to execute it, and the server defers.
 */
export function frontendOnlyToolCall(input: RunAgentInput): BaseEvent[] {
  const events: BaseEvent[] = [runStarted(input)];
  const toolCallId = `tc-${input.runId}`;
  const messageId = `msg-${input.runId}`;

  const args = JSON.stringify({
    background: "blue",
    accent: "indigo",
    contrast: "high",
  });

  events.push({
    type: EventType.TOOL_CALL_START,
    toolCallId,
    toolCallName: "change_background",
    parentMessageId: messageId,
  } as ToolCallStartEvent);

  // Chunk the args into 4-character slices. The C# tool-call builder
  // must concatenate them before surfacing the FunctionCallContent.
  for (let i = 0; i < args.length; i += 4) {
    events.push({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId,
      delta: args.slice(i, i + 4),
    } as ToolCallArgsEvent);
  }

  events.push({
    type: EventType.TOOL_CALL_END,
    toolCallId,
  } as ToolCallEndEvent);

  // No TOOL_CALL_RESULT — the client is responsible for executing it.
  events.push(runFinished(input));
  return events;
}

/**
 * Multi-message run: assistant explains intent → invokes a tool → result
 * comes back → assistant summarises. Verifies that AGUIChatClient threads
 * multiple TEXT_MESSAGE_* and TOOL_CALL_* envelopes in one streaming run
 * into a coherent ChatResponse with the right Contents in the right order.
 */
export function multiMessageRun(input: RunAgentInput): BaseEvent[] {
  const events: BaseEvent[] = [runStarted(input)];
  const preMsgId = `msg-pre-${input.runId}`;
  const postMsgId = `msg-post-${input.runId}`;
  const toolCallId = `tc-${input.runId}`;

  events.push(...textMessage(preMsgId, "Let me check that for you."));

  events.push({
    type: EventType.TOOL_CALL_START,
    toolCallId,
    toolCallName: "lookup",
    parentMessageId: preMsgId,
  } as ToolCallStartEvent);
  events.push({
    type: EventType.TOOL_CALL_ARGS,
    toolCallId,
    delta: '{"q":"answer"}',
  } as ToolCallArgsEvent);
  events.push({
    type: EventType.TOOL_CALL_END,
    toolCallId,
  } as ToolCallEndEvent);
  events.push({
    type: EventType.TOOL_CALL_RESULT,
    toolCallId,
    messageId: `tool-result-${toolCallId}`,
    role: "tool",
    content: '{"answer":42}',
  } as ToolCallResultEvent);

  events.push(...textMessage(postMsgId, "The answer is 42."));
  events.push(runFinished(input));
  return events;
}

/**
 * Server emits a CUSTOM event mid-run. The dojo uses these for
 * application-specific signals (e.g. UI hints) that the protocol shouldn't
 * try to interpret. The C# client must pass them through without breaking
 * the run.
 */
export function customEventRun(input: RunAgentInput): BaseEvent[] {
  const events: BaseEvent[] = [runStarted(input)];
  const messageId = `msg-${input.runId}`;

  events.push(...textMessage(messageId, "Hello"));
  events.push({
    type: EventType.CUSTOM,
    name: "ui.notify",
    value: { severity: "info", text: "test-marker" },
  } as CustomEvent);
  events.push(runFinished(input));
  return events;
}

/**
 * Server emits a RAW event carrying a provider-native payload. Same
 * pass-through expectation as CUSTOM, but the typed `event` field is
 * arbitrary.
 */
export function rawEventRun(input: RunAgentInput): BaseEvent[] {
  const events: BaseEvent[] = [runStarted(input)];
  const messageId = `msg-${input.runId}`;

  events.push(...textMessage(messageId, "Hi"));
  events.push({
    type: EventType.RAW,
    event: { kind: "provider.metadata", model: "fake-llm-7b" },
    source: "fake-agent",
  } as RawEvent);
  events.push(runFinished(input));
  return events;
}

/**
 * Server starts the run normally then emits RUN_ERROR. The C# client
 * surfaces this as ErrorContent with the event's message and error code.
 */
export function runErrorScenario(input: RunAgentInput): BaseEvent[] {
  const events: BaseEvent[] = [runStarted(input)];
  events.push({
    type: EventType.RUN_ERROR,
    message: "fake agent: simulated upstream failure",
    code: "FAKE_AGENT_FAILURE",
  } as RunErrorEvent);
  return events;
}

/**
 * HITL flow modelled after the dojo human-in-the-loop spec. First call:
 * the agent emits a tool_call together with an interrupt outcome asking
 * the user to approve the tool invocation. Second call: the agent reads
 * the resume payload (the C# AGUIChatClient maps a ToolApprovalResponseContent
 * back into a resume entry whose payload is the AGUIToolApprovalResumePayload
 * shape: { interruptId, approved, toolCall }) and emits a confirmation.
 */
export function humanInTheLoopRun(input: RunAgentInput): BaseEvent[] {
  const events: BaseEvent[] = [runStarted(input)];
  const hasResume = Array.isArray(input.resume) && input.resume.length > 0;

  if (!hasResume) {
    const toolCallId = "tc-hitl";
    const messageId = `msg-${input.runId}`;

    events.push({
      type: EventType.TOOL_CALL_START,
      toolCallId,
      toolCallName: "delete_files",
      parentMessageId: messageId,
    } as ToolCallStartEvent);
    events.push({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId,
      delta: JSON.stringify({ paths: ["/tmp/cache"] }),
    } as ToolCallArgsEvent);
    events.push({
      type: EventType.TOOL_CALL_END,
      toolCallId,
    } as ToolCallEndEvent);

    events.push({
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
      outcome: {
        type: "interrupt",
        interrupts: [
          {
            id: "interrupt-delete-files",
            reason: "tool_call",
            toolCallId,
            message: "Approve deleting /tmp/cache?",
          },
        ],
      },
    } as unknown as RunFinishedEvent);
    return events;
  }

  // Second call: inspect the resume payload's approved flag.
  const resumeEntry = input.resume![0]!;
  const payload = resumeEntry.payload as { approved?: boolean } | undefined;
  const approved = payload?.approved === true;

  const messageId = `msg-final-${input.runId}`;
  events.push(
    ...textMessage(
      messageId,
      approved ? "Files deleted as requested." : "Skipping deletion.",
    ),
  );
  events.push(runFinished(input));
  return events;
}

/**
 * Emits a STATE_SNAPSHOT followed by several STATE_DELTA JSON Patches
 * mid-run. Mirrors the dojo shared-state flow: an agent both publishes a
 * full state document up front and emits incremental updates as it works.
 * AGUIChatClient should surface both events on each ChatResponseUpdate's
 * RawRepresentation so client code can subscribe to state changes.
 */
export function stateEventsRun(input: RunAgentInput): BaseEvent[] {
  const events: BaseEvent[] = [runStarted(input)];

  events.push({
    type: EventType.STATE_SNAPSHOT,
    snapshot: {
      recipe: { title: "Pasta al Limone", servings: 4, ingredients: [] },
    },
  } as StateSnapshotEvent);

  // Add ingredients one at a time via JSON Patch operations.
  const ingredients = ["spaghetti", "lemon", "parmesan"];
  for (let i = 0; i < ingredients.length; i++) {
    events.push({
      type: EventType.STATE_DELTA,
      delta: [
        {
          op: "add",
          path: `/recipe/ingredients/${i}`,
          value: ingredients[i],
        },
      ],
    } as StateDeltaEvent);
  }

  // The dojo recipe agent always concludes with a short confirmation text.
  events.push(...textMessage(`msg-${input.runId}`, "Recipe ready."));
  events.push(runFinished(input));
  return events;
}

/**
 * Emits REASONING_MESSAGE_START / _CONTENT / _END events before the final
 * assistant text. The C# AGUIChatClient surfaces reasoning content as
 * TextReasoningContent inside the ChatResponseUpdate.Contents, so the test
 * asserts both the reasoning and the answer come through correctly.
 */
export function reasoningRun(input: RunAgentInput): BaseEvent[] {
  const events: BaseEvent[] = [runStarted(input)];
  const reasoningId = `rsn-${input.runId}`;
  const messageId = `msg-${input.runId}`;

  events.push({
    type: EventType.REASONING_MESSAGE_START,
    messageId: reasoningId,
    role: "reasoning",
  } as ReasoningMessageStartEvent);
  events.push({
    type: EventType.REASONING_MESSAGE_CONTENT,
    messageId: reasoningId,
    delta: "Considering the question",
  } as ReasoningMessageContentEvent);
  events.push({
    type: EventType.REASONING_MESSAGE_CONTENT,
    messageId: reasoningId,
    delta: ": 2 + 2 must equal 4.",
  } as ReasoningMessageContentEvent);
  events.push({
    type: EventType.REASONING_MESSAGE_END,
    messageId: reasoningId,
  } as ReasoningMessageEndEvent);

  events.push(...textMessage(messageId, "Four."));
  events.push(runFinished(input));
  return events;
}

/**
 * Emits an ACTIVITY_SNAPSHOT event carrying a structured activity payload
 * (e.g. a plan with steps). The AGUI .NET wire-format work added the
 * AGUIActivityMessage type; this verifies the corresponding event survives
 * a round-trip through the C# client without being mangled.
 */
export function activitySnapshotRun(input: RunAgentInput): BaseEvent[] {
  const events: BaseEvent[] = [runStarted(input)];

  events.push({
    type: EventType.ACTIVITY_SNAPSHOT,
    messageId: `act-${input.runId}`,
    activityType: "PLAN",
    content: {
      steps: [
        { description: "Gather ingredients", status: "completed" },
        { description: "Cook pasta", status: "in_progress" },
        { description: "Serve and enjoy", status: "pending" },
      ],
    },
    replace: true,
  } as ActivitySnapshotEvent);

  events.push(...textMessage(`msg-${input.runId}`, "Plan posted."));
  events.push(runFinished(input));
  return events;
}


export type FakeAgent = (input: RunAgentInput) => BaseEvent[];

