/**
 * Tests for the resume-skips-regeneration fix.
 *
 * The bug: prepareStream's regeneration detection
 *   (stateNonSystemCount > inputNonSystemCount)
 * runs BEFORE the command.resume check. On the 2nd interrupt-resume cycle,
 * the LangGraph thread state has accumulated tool/AI messages from the first
 * interrupt while the frontend's input.messages hasn't — triggering the
 * regeneration path, which ignores command.resume and restarts the graph
 * fresh. The graph never re-hits interrupt(), no CUSTOM/on_interrupt event
 * is emitted, and the frontend's useInterrupt never sees the second interrupt.
 *
 * The fix: skip regeneration detection when forwardedProps.command.resume is
 * set. A resume is explicitly NOT a regeneration.
 *
 * NOTE: Same constraint as interrupt-handling.test.ts — LangGraphAgent can't
 * be instantiated in isolation (requires @ag-ui/client protoc). We test the
 * decision logic directly. This MUST stay in sync with agent.ts ~line 455:
 *   if (!forwardedProps?.command?.resume && stateNonSystemCount > inputNonSystemCount)
 */

import { describe, it, expect } from "vitest";

interface LangGraphPlatformMessage {
  id: string;
  type: string;
  content?: string;
}

interface AgUiMessage {
  id: string;
  role: string;
  content?: string;
}

/**
 * Mirrors the regeneration decision logic from agent.ts prepareStream.
 * Returns true when the adapter WOULD enter the regeneration path.
 * Updated to consider both forwardedProps.command.resume AND input.resume.
 */
function shouldRegenerate(params: {
  agentStateMessages: LangGraphPlatformMessage[];
  inputMessages: AgUiMessage[];
  commandResume: unknown;
  aguiResume?: unknown[];
}): boolean {
  const { agentStateMessages, inputMessages, commandResume, aguiResume } = params;

  const stateNonSystemCount = agentStateMessages.filter(
    (m) => m.type !== "system",
  ).length;
  const inputNonSystemCount = inputMessages.filter(
    (m) => m.role !== "system",
  ).length;

  // Must match agent.ts:
  //   const hasResume = aguiResume !== undefined || legacyResume !== undefined;
  //   if (!hasResume && stateNonSystemCount > inputNonSystemCount)
  const hasResume = aguiResume !== undefined && aguiResume.length > 0
    ? true
    : !!commandResume;
  return !hasResume && stateNonSystemCount > inputNonSystemCount;
}

describe("Resume skips regeneration detection", () => {
  // Simulate 2nd interrupt-resume: thread state has 5 messages (user + ai + tool_call
  // + tool_result + ai), frontend only sent 2 (user + ai from first round).
  const threadStateMessages: LangGraphPlatformMessage[] = [
    { id: "1", type: "human", content: "Schedule a meeting" },
    { id: "2", type: "ai", content: "Sure, let me check calendars" },
    { id: "3", type: "tool", content: '{"available": ["3pm","4pm"]}' },
    { id: "4", type: "ai", content: "Pick a time" },
    { id: "5", type: "human", content: "3pm please" },
  ];

  const frontendMessages: AgUiMessage[] = [
    { id: "1", role: "user", content: "Schedule a meeting" },
    { id: "5", role: "user", content: "3pm please" },
  ];

  it("should NOT regenerate when command.resume is set (the bug fix)", () => {
    expect(
      shouldRegenerate({
        agentStateMessages: threadStateMessages,
        inputMessages: frontendMessages,
        commandResume: { action: "pick_time", value: "3pm" },
      }),
    ).toBe(false);
  });

  it("should NOT regenerate when command.resume is a string", () => {
    expect(
      shouldRegenerate({
        agentStateMessages: threadStateMessages,
        inputMessages: frontendMessages,
        commandResume: '{"action":"pick_time","value":"3pm"}',
      }),
    ).toBe(false);
  });

  it("SHOULD regenerate when command.resume is NOT set and state has more messages", () => {
    expect(
      shouldRegenerate({
        agentStateMessages: threadStateMessages,
        inputMessages: frontendMessages,
        commandResume: undefined,
      }),
    ).toBe(true);
  });

  it("SHOULD regenerate when command.resume is null and state has more messages", () => {
    expect(
      shouldRegenerate({
        agentStateMessages: threadStateMessages,
        inputMessages: frontendMessages,
        commandResume: null,
      }),
    ).toBe(true);
  });

  it("should NOT regenerate when message counts are equal (regardless of resume)", () => {
    const equalMessages: LangGraphPlatformMessage[] = [
      { id: "1", type: "human", content: "Hello" },
    ];
    const equalInput: AgUiMessage[] = [
      { id: "1", role: "user", content: "Hello" },
    ];

    expect(
      shouldRegenerate({
        agentStateMessages: equalMessages,
        inputMessages: equalInput,
        commandResume: undefined,
      }),
    ).toBe(false);
  });

  it("should NOT regenerate when input has MORE messages than state", () => {
    const smallState: LangGraphPlatformMessage[] = [
      { id: "1", type: "human", content: "Hello" },
    ];
    const bigInput: AgUiMessage[] = [
      { id: "1", role: "user", content: "Hello" },
      { id: "2", role: "assistant", content: "Hi there" },
      { id: "3", role: "user", content: "How are you?" },
    ];

    expect(
      shouldRegenerate({
        agentStateMessages: smallState,
        inputMessages: bigInput,
        commandResume: undefined,
      }),
    ).toBe(false);
  });

  it("should filter system messages from both sides", () => {
    // 3 state messages but 1 is system → 2 non-system
    const stateWithSystem: LangGraphPlatformMessage[] = [
      { id: "sys", type: "system", content: "Context injection" },
      { id: "1", type: "human", content: "Hello" },
      { id: "2", type: "ai", content: "Hi" },
    ];
    // 2 input messages but 1 is system → 1 non-system
    // stateNonSystemCount (2) > inputNonSystemCount (1) → would regenerate
    const inputWithSystem: AgUiMessage[] = [
      { id: "sys", role: "system", content: "System prompt" },
      { id: "1", role: "user", content: "Hello" },
    ];

    // Without resume: regenerates
    expect(
      shouldRegenerate({
        agentStateMessages: stateWithSystem,
        inputMessages: inputWithSystem,
        commandResume: undefined,
      }),
    ).toBe(true);

    // With resume: skips regeneration
    expect(
      shouldRegenerate({
        agentStateMessages: stateWithSystem,
        inputMessages: inputWithSystem,
        commandResume: "some_value",
      }),
    ).toBe(false);
  });

  it("should handle empty resume object as truthy (command.resume = {})", () => {
    // An empty object is truthy in JS — if the graph sends resume: {}, it's still a resume
    expect(
      shouldRegenerate({
        agentStateMessages: threadStateMessages,
        inputMessages: frontendMessages,
        commandResume: {},
      }),
    ).toBe(false);
  });

  it("should handle resume = false as falsy (edge case)", () => {
    // command.resume = false is falsy — should allow regeneration
    expect(
      shouldRegenerate({
        agentStateMessages: threadStateMessages,
        inputMessages: frontendMessages,
        commandResume: false,
      }),
    ).toBe(true);
  });

  it("should handle resume = 0 as falsy (edge case)", () => {
    // command.resume = 0 is falsy — should allow regeneration
    expect(
      shouldRegenerate({
        agentStateMessages: threadStateMessages,
        inputMessages: frontendMessages,
        commandResume: 0,
      }),
    ).toBe(true);
  });
});

describe("Resume skips regeneration detection — input.resume path", () => {
  const threadStateMessages: LangGraphPlatformMessage[] = [
    { id: "1", type: "human", content: "Schedule a meeting" },
    { id: "2", type: "ai", content: "Sure, let me check calendars" },
    { id: "3", type: "tool", content: '{"available": ["3pm","4pm"]}' },
    { id: "4", type: "ai", content: "Pick a time" },
    { id: "5", type: "human", content: "3pm please" },
  ];

  const frontendMessages: AgUiMessage[] = [
    { id: "1", role: "user", content: "Schedule a meeting" },
    { id: "5", role: "user", content: "3pm please" },
  ];

  it("should NOT regenerate when input.resume is set (AG-UI standard)", () => {
    expect(
      shouldRegenerate({
        agentStateMessages: threadStateMessages,
        inputMessages: frontendMessages,
        commandResume: undefined,
        aguiResume: [{ interruptId: "i1", status: "resolved", payload: { approved: true } }],
      }),
    ).toBe(false);
  });

  it("should NOT regenerate when both input.resume and command.resume are set", () => {
    expect(
      shouldRegenerate({
        agentStateMessages: threadStateMessages,
        inputMessages: frontendMessages,
        commandResume: "legacy_value",
        aguiResume: [{ interruptId: "i1", status: "resolved", payload: true }],
      }),
    ).toBe(false);
  });

  it("SHOULD regenerate when input.resume is empty array (treated as absent)", () => {
    expect(
      shouldRegenerate({
        agentStateMessages: threadStateMessages,
        inputMessages: frontendMessages,
        commandResume: undefined,
        aguiResume: [],
      }),
    ).toBe(true);
  });

  it("SHOULD regenerate when input.resume is undefined and command.resume is not set", () => {
    expect(
      shouldRegenerate({
        agentStateMessages: threadStateMessages,
        inputMessages: frontendMessages,
        commandResume: undefined,
        aguiResume: undefined,
      }),
    ).toBe(true);
  });
});
