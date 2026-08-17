import { describe, expect, it } from "vitest";
import { EventType, RunErrorEvent, RunFinishedEvent } from "@ag-ui/core";
import { decode, encode } from "../src/proto";
import { expectRoundTripEquality, roundTrip } from "./test-utils";

describe("token usage — proto round-trip", () => {
  it("round-trips RUN_FINISHED with a single usage entry", () => {
    const event: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: "t-1",
      runId: "r-1",
      usage: [
        {
          provider: "anthropic",
          model: "claude-sonnet-4",
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          reasoningTokens: 20,
          cachedInputTokens: 10,
        },
      ],
    };
    expectRoundTripEquality(event);
  });

  it("round-trips RUN_FINISHED with multiple usage entries (per-model)", () => {
    const event: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: "t-1",
      runId: "r-1",
      usage: [
        { provider: "openai", model: "gpt-4o", inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        { provider: "openai", model: "gpt-4o-mini", inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      ],
    };
    expectRoundTripEquality(event);
  });

  it("round-trips RUN_FINISHED with usage alongside outcome and result", () => {
    const event: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: "t-1",
      runId: "r-1",
      outcome: { type: "success" },
      result: { answer: 42 },
      usage: [{ provider: "anthropic", totalTokens: 7 }],
    };
    expectRoundTripEquality(event);
  });

  it("round-trips RUN_ERROR with partial usage", () => {
    const event: RunErrorEvent = {
      type: EventType.RUN_ERROR,
      message: "boom",
      usage: [{ provider: "anthropic", inputTokens: 100 }],
    };
    expectRoundTripEquality(event);
  });

  it("legacy RUN_FINISHED without usage decodes without a usage key", () => {
    const event: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: "t-1",
      runId: "r-1",
    };
    const decoded = roundTrip(event);
    expect("usage" in decoded).toBe(false);
  });

  it("legacy RUN_ERROR without usage decodes without a usage key", () => {
    const decoded = decode(
      encode({ type: EventType.RUN_ERROR, message: "boom" } as RunErrorEvent),
    );
    expect("usage" in decoded).toBe(false);
  });
});
