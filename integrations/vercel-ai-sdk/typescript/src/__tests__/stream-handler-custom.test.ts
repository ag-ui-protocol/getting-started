import { describe, expect, it, vi } from "vitest";
import { EventType, type CustomEvent } from "@ag-ui/client";
import type { TypedToolCall, ToolSet } from "ai";
import { collectEvents, eventsOfType, fromParts } from "./helpers";

// The handler forwards an approval part's `toolCall` through untouched, and
// the assertions below pin the exact object that lands on CUSTOM.value — so
// the fixture stays a deliberately minimal stub (no `type`, no `input`)
// rather than a full v7 TypedToolCall, and casts once here to say so.
const stubToolCall = (toolCallId: string, toolName: string): TypedToolCall<ToolSet> =>
  ({ toolCallId, toolName }) as unknown as TypedToolCall<ToolSet>;

describe("StreamHandler — v7 approval & custom parts", () => {
  it("maps a tool-approval-request part to a CUSTOM event", async () => {
    const events = await collectEvents(
      fromParts([
        {
          type: "tool-approval-request",
          approvalId: "ap-1",
          toolCall: stubToolCall("tc-1", "get_weather"),
        },
      ]),
    );

    const custom = eventsOfType<CustomEvent>(events, EventType.CUSTOM);
    expect(custom).toHaveLength(1);
    expect(custom[0].name).toBe("tool_approval_request");
    expect(custom[0].value).toMatchObject({ approvalId: "ap-1" });
  });

  it("maps a tool-approval-response part to a CUSTOM event with the outcome", async () => {
    const events = await collectEvents(
      fromParts([
        {
          type: "tool-approval-response",
          approvalId: "ap-1",
          toolCall: stubToolCall("tc-1", "get_weather"),
          approved: false,
          reason: "user denied",
        },
      ]),
    );

    const custom = eventsOfType<CustomEvent>(events, EventType.CUSTOM);
    expect(custom).toHaveLength(1);
    expect(custom[0].name).toBe("tool_approval_response");
    expect(custom[0].value).toMatchObject({
      approvalId: "ap-1",
      approved: false,
      reason: "user denied",
    });
  });

  it("passes a provider custom part through as a CUSTOM event", async () => {
    const events = await collectEvents(
      fromParts([
        {
          type: "custom",
          kind: "acme.telemetry",
          providerMetadata: { acme: { id: 7 } },
        },
      ]),
    );

    const custom = eventsOfType<CustomEvent>(events, EventType.CUSTOM);
    expect(custom).toHaveLength(1);
    expect(custom[0].name).toBe("acme.telemetry");
    expect(custom[0].value).toEqual({ acme: { id: 7 } });
  });

  it("omits reason from a tool-approval-response when the part has none", async () => {
    const events = await collectEvents(
      fromParts([
        {
          type: "tool-approval-response",
          approvalId: "ap-2",
          toolCall: stubToolCall("tc-2", "get_weather"),
          approved: true,
        },
      ]),
    );

    const custom = eventsOfType<CustomEvent>(events, EventType.CUSTOM);
    expect(custom).toHaveLength(1);
    expect(custom[0].value).toEqual({
      approvalId: "ap-2",
      toolCall: { toolCallId: "tc-2", toolName: "get_weather" },
      approved: true,
    });
    expect(custom[0].value).not.toHaveProperty("reason");
  });

  it("skips reasoning-file without emitting a CUSTOM event or a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const events = await collectEvents(
        fromParts([
          {
            type: "reasoning-file",
            file: { mediaType: "text/plain", base64: "", uint8Array: new Uint8Array() },
          },
        ]),
      );
      expect(eventsOfType(events, EventType.CUSTOM)).toHaveLength(0);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
