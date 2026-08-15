/**
 * Verifies that a custom toolStreamEventHandler suppresses the default
 * STATE_SNAPSHOT behavior and yields custom events instead.
 */

import { describe, it, expect } from "vitest";
import type { AgentStreamEvent } from "@strands-agents/sdk";
import { EventType } from "@ag-ui/core";

import { collect, scriptedStrandsAgent } from "./helpers";

describe("toolStreamEventHandler", () => {
  it("dispatches to custom handler and suppresses default STATE_SNAPSHOT", async () => {
    const script: AgentStreamEvent[] = [
      // Simulate a modelContentBlockStartEvent to set currentToolUse
      {
        type: "modelContentBlockStartEvent",
        start: { type: "toolUseStart", name: "my_tool", toolUseId: "tu-1" },
      } as unknown as AgentStreamEvent,
      // toolStreamEvent that would normally emit STATE_SNAPSHOT
      {
        type: "toolStreamUpdateEvent",
        event: {
          type: "toolStreamEvent",
          data: { state: { should_not_appear: true }, custom: "payload" },
        },
      } as unknown as AgentStreamEvent,
    ];

    const collected: unknown[] = [];
    const agent = scriptedStrandsAgent(script, {
      config: {
        toolBehaviors: {
          my_tool: {
            async *toolStreamEventHandler(ctx) {
              collected.push(ctx);
              yield {
                type: EventType.CUSTOM,
                name: "FromHandler",
                value: ctx.streamData,
              } as any;
            },
          },
        },
      },
    });

    const events = await collect(agent);

    // The handler was called with correct context
    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({
      toolUseId: "tu-1",
      toolName: "my_tool",
      streamData: { state: { should_not_appear: true }, custom: "payload" },
    });

    // Custom event was emitted
    const custom = events.filter((e) => e.type === EventType.CUSTOM);
    expect(custom).toHaveLength(1);

    // Default STATE_SNAPSHOT for {state: ...} was NOT emitted for this tool
    const snapshots = events.filter(
      (e) =>
        e.type === EventType.STATE_SNAPSHOT &&
        (e as any).snapshot?.should_not_appear,
    );
    expect(snapshots).toHaveLength(0);
  });
});
