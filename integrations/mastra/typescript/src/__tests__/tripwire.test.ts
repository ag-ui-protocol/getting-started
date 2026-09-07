import { vi } from "vitest";
import { EventType, type TextMessageChunkEvent } from "@ag-ui/client";
import { makeLocalMastraAgent, makeInput, collectEvents } from "./helpers";

function joinedText(events: Awaited<ReturnType<typeof collectEvents>>): string {
  return events
    .filter(
      (e): e is TextMessageChunkEvent => e.type === EventType.TEXT_MESSAGE_CHUNK,
    )
    .map((e) => e.delta ?? "")
    .join("");
}

/**
 * A Mastra input/output processor that aborts the run emits a `tripwire`
 * chunk and closes the stream. Without a mapping the client saw
 * RUN_STARTED … RUN_FINISHED with no output at all.
 */
describe("tripwire chunks", () => {
  it("surfaces a blocking tripwire as assistant text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = makeLocalMastraAgent({
      streamChunks: [
        {
          type: "tripwire",
          payload: { reason: "Prompt injection detected", processorId: "guard" },
        },
      ],
    });

    const events = await collectEvents(agent, makeInput());

    expect(joinedText(events)).toBe("Prompt injection detected");
    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("Unrecognized stream chunk type")),
    ).toBe(false);
    warn.mockRestore();
  });

  it("ignores a retry tripwire because Mastra answers again on the same stream", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = makeLocalMastraAgent({
      streamChunks: [
        { type: "text-delta", payload: { text: "first try" } },
        { type: "tripwire", payload: { reason: "Too long", retry: true } },
        { type: "text-delta", payload: { text: "second try" } },
        { type: "finish", payload: { finishReason: "stop" } },
      ],
    });

    const events = await collectEvents(agent, makeInput());

    expect(joinedText(events)).toBe("first trysecond try");
    expect(joinedText(events)).not.toContain("Too long");
    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("Unrecognized stream chunk type")),
    ).toBe(false);
    warn.mockRestore();
  });
});
