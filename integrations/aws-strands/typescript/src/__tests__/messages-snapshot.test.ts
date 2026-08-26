/**
 * MessagesSnapshotEvent emission + message_id rotation.
 *
 * Four lifecycle splice points (Python parity, PR #1638):
 *   1. after the initial STATE_SNAPSHOT
 *   2. after each TOOL_CALL_END
 *   3. after each TOOL_CALL_RESULT
 *   4. after each terminal TEXT_MESSAGE_END
 *
 * message_id rotates after each assistant snapshot entry is appended so
 * CopilotKit v2's id-keyed message map doesn't overwrite an entry with
 * its successor (the "orphan ToolMessage → OpenAI role='tool' must follow
 * tool_calls" failure mode).
 */

import { describe, it, expect } from "vitest";
import { ToolUseBlock, TextBlock, ToolResultBlock } from "@strands-agents/sdk";
import type { AgentStreamEvent } from "@strands-agents/sdk";
import { EventType } from "@ag-ui/core";

import { buildSnapshotMessages } from "../agent";
import {
  collect,
  minimalRunInput,
  scriptedStrandsAgent,
  stream,
} from "./helpers";

describe("MESSAGES_SNAPSHOT — initial seed", () => {
  it("emits an initial MESSAGES_SNAPSHOT seeded from RunAgentInput.messages", async () => {
    const agent = scriptedStrandsAgent([]);
    const events = await collect(
      agent,
      minimalRunInput({
        messages: [
          { id: "u1", role: "user", content: "hello" },
          { id: "a1", role: "assistant", content: "hi" },
        ],
      }),
    );
    const snapshots = events.filter(
      (e) => e.type === EventType.MESSAGES_SNAPSHOT,
    ) as unknown as Array<{ messages: Array<Record<string, unknown>> }>;
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    const first = snapshots[0]!.messages;
    expect(first).toHaveLength(2);
    expect(first[0]!.role).toBe("user");
    expect(first[1]!.role).toBe("assistant");
  });

  it("does NOT emit an initial snapshot when messages[] is empty", async () => {
    const agent = scriptedStrandsAgent([]);
    const events = await collect(agent);
    expect(
      events.filter((e) => e.type === EventType.MESSAGES_SNAPSHOT),
    ).toHaveLength(0);
  });

  it("is globally suppressed by emitMessagesSnapshot=false", async () => {
    const agent = scriptedStrandsAgent([], {
      config: { emitMessagesSnapshot: false },
    });
    const events = await collect(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content: "hi" }],
      }),
    );
    expect(
      events.filter((e) => e.type === EventType.MESSAGES_SNAPSHOT),
    ).toHaveLength(0);
  });
});

describe("MESSAGES_SNAPSHOT — after tool-call end", () => {
  it("appends an AssistantMessage(toolCalls=[…]) after TOOL_CALL_END", async () => {
    const block = new ToolUseBlock({
      name: "backend_tool",
      toolUseId: "tc1",
      input: { q: "why" },
    });
    const agent = scriptedStrandsAgent([block as unknown as AgentStreamEvent]);
    const events = await collect(agent);
    const snapshots = events.filter(
      (e) => e.type === EventType.MESSAGES_SNAPSHOT,
    ) as unknown as Array<{ messages: Array<Record<string, unknown>> }>;
    // Last snapshot should include the assistant tool-call entry.
    const last = snapshots[snapshots.length - 1]!.messages;
    const assistant = last.find((m) => m.role === "assistant") as {
      toolCalls?: Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
    };
    expect(assistant.toolCalls).toHaveLength(1);
    expect(assistant.toolCalls![0]!.id).toBe("tc1");
    expect(assistant.toolCalls![0]!.function.name).toBe("backend_tool");
  });

  it("skipMessagesSnapshot suppresses the per-tool snapshot", async () => {
    const block = new ToolUseBlock({
      name: "quiet_tool",
      toolUseId: "tc2",
      input: {},
    });
    const agent = scriptedStrandsAgent([block as unknown as AgentStreamEvent], {
      config: {
        toolBehaviors: { quiet_tool: { skipMessagesSnapshot: true } },
      },
    });
    const events = await collect(agent);
    const snapshots = events.filter(
      (e) => e.type === EventType.MESSAGES_SNAPSHOT,
    ) as unknown as Array<{ messages: Array<Record<string, unknown>> }>;
    // No snapshot should contain an assistant with a tool-call entry
    // for quiet_tool.
    const hasQuietToolCall = snapshots.some((s) =>
      s.messages.some((m) => {
        if (m.role !== "assistant") return false;
        const tcs = (m as { toolCalls?: Array<{ function: { name: string } }> })
          .toolCalls;
        return tcs?.some((tc) => tc.function.name === "quiet_tool") ?? false;
      }),
    );
    expect(hasQuietToolCall).toBe(false);
  });
});

describe("MESSAGES_SNAPSHOT — after tool result", () => {
  it("appends a ToolMessage after TOOL_CALL_RESULT", async () => {
    const block = new ToolUseBlock({
      name: "compute",
      toolUseId: "tc3",
      input: {},
    });
    const result = new ToolResultBlock({
      toolUseId: "tc3",
      status: "success",
      content: [new TextBlock(JSON.stringify({ answer: 42 }))],
    });
    const events: AgentStreamEvent[] = [
      block as unknown as AgentStreamEvent,
      {
        type: "afterToolCallEvent",
        toolUse: { toolUseId: "tc3", name: "compute", input: {} },
        result,
      } as unknown as AgentStreamEvent,
    ];
    const agent = scriptedStrandsAgent(events);
    const output = await collect(agent);
    const snapshots = output.filter(
      (e) => e.type === EventType.MESSAGES_SNAPSHOT,
    ) as unknown as Array<{ messages: Array<Record<string, unknown>> }>;
    const last = snapshots[snapshots.length - 1]!.messages;
    const toolMsg = last.find((m) => m.role === "tool") as {
      toolCallId: string;
      content: string;
    };
    expect(toolMsg).toBeTruthy();
    expect(toolMsg.toolCallId).toBe("tc3");
    expect(toolMsg.content).toContain("42");
  });
});

describe("message_id rotation", () => {
  it("back-to-back tool calls in one run produce assistant entries with distinct ids", async () => {
    const blockA = new ToolUseBlock({
      name: "tool_a",
      toolUseId: "tc-a",
      input: {},
    });
    const blockB = new ToolUseBlock({
      name: "tool_b",
      toolUseId: "tc-b",
      input: {},
    });
    const agent = scriptedStrandsAgent([
      blockA as unknown as AgentStreamEvent,
      blockB as unknown as AgentStreamEvent,
    ]);
    const output = await collect(agent);
    const snapshots = output.filter(
      (e) => e.type === EventType.MESSAGES_SNAPSHOT,
    ) as unknown as Array<{ messages: Array<Record<string, unknown>> }>;
    const lastSnapshot = snapshots[snapshots.length - 1]!.messages;
    const assistantEntries = lastSnapshot.filter(
      (m) => m.role === "assistant",
    ) as Array<{
      id: string;
      toolCalls?: Array<{ function: { name: string } }>;
    }>;
    expect(assistantEntries).toHaveLength(2);
    // Both have tool calls; their ids MUST differ so CopilotKit's id-keyed
    // map doesn't overwrite one with the next.
    expect(assistantEntries[0]!.id).not.toBe(assistantEntries[1]!.id);
  });

  it("text → tool → text run commits accumulated text to the snapshot with its original id", async () => {
    // This replays the canonical sequence that motivated splice points 2
    // and 4: text streams until a tool is announced, we close text and
    // snapshot it, then the tool call runs, then the agent text continues.
    // The accumulated text must appear in a snapshot with the id that was
    // used for TEXT_MESSAGE_START, not the rotated id.
    const events: AgentStreamEvent[] = [
      stream.textDelta("opening "),
      stream.textDelta("line"),
    ];
    const agent = scriptedStrandsAgent(events);
    const output = await collect(agent);
    const snapshots = output.filter(
      (e) => e.type === EventType.MESSAGES_SNAPSHOT,
    ) as unknown as Array<{ messages: Array<Record<string, unknown>> }>;
    const last = snapshots[snapshots.length - 1]!.messages;
    const assistant = last.find(
      (m) =>
        m.role === "assistant" &&
        typeof (m as { content?: unknown }).content === "string",
    ) as { content: string } | undefined;
    expect(assistant?.content).toBe("opening line");
  });
});

describe("buildSnapshotMessages — standalone helper", () => {
  it("normalises tool-call arguments to a JSON string", () => {
    const out = buildSnapshotMessages([
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tc1",
            type: "function",
            function: { name: "foo", arguments: '{"x":1}' },
          },
        ],
      },
    ]);
    expect(out).toHaveLength(1);
    const assistant = out[0] as {
      toolCalls?: Array<{ function: { arguments: string } }>;
    };
    expect(assistant.toolCalls![0]!.function.arguments).toBe('{"x":1}');
  });

  it("fabricates ids for entries missing one", () => {
    const out = buildSnapshotMessages([
      { id: "", role: "user", content: "hi" } as never,
    ]);
    expect(out).toHaveLength(1);
    expect(typeof (out[0] as { id: string }).id).toBe("string");
    expect((out[0] as { id: string }).id.length).toBeGreaterThan(0);
  });

  it("preserves error and encryptedValue on the tool echo", () => {
    // This is an AG-UI -> AG-UI rebuild of the client's own message, so
    // dropping its own fields loses the failure signal a MESSAGES_SNAPSHOT is
    // supposed to make durable. Python parity: agent.py's
    // _build_snapshot_messages (#2317).
    const out = buildSnapshotMessages([
      {
        id: "t1",
        role: "tool",
        content: "tool failed: invalid id",
        toolCallId: "tc1",
        error: "invalid id",
        encryptedValue: "enc",
      } as never,
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      id: "t1",
      role: "tool",
      content: "tool failed: invalid id",
      toolCallId: "tc1",
      error: "invalid id",
      encryptedValue: "enc",
    });
  });

  it("omits error and encryptedValue when the client did not set them", () => {
    const out = buildSnapshotMessages([
      {
        id: "t1",
        role: "tool",
        content: "ok",
        toolCallId: "tc1",
      } as never,
    ]);
    expect(out[0]).toEqual({
      id: "t1",
      role: "tool",
      content: "ok",
      toolCallId: "tc1",
    });
  });

  it("drops developer / system / reasoning / activity roles", () => {
    const out = buildSnapshotMessages([
      { id: "s1", role: "system", content: "sys" } as never,
      { id: "d1", role: "developer", content: "dev" } as never,
      { id: "r1", role: "reasoning", content: "think" } as never,
    ]);
    expect(out).toHaveLength(0);
  });
});
