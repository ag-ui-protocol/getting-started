/**
 * PNI-219 — recorded baseline for the SpringAiAgent 0.0.39 version ceiling.
 *
 * `SpringAiAgent` pins `maxVersion` to "0.0.39", which is at or below all
 * three backward-compat thresholds in `AbstractAgent`'s constructor, so
 * every one of the shims is active on this path:
 *
 *   ≤ 0.0.39  flattens structured message content, coerces absent content
 *             to "", strips `parentRunId`
 *   ≤ 0.0.45  rewrites legacy THINKING_* response events to REASONING_*
 *   ≤ 0.0.47  converts legacy BinaryInputContent to typed content parts
 *
 * Spring AI's paired backend lives outside this repo (see
 * sdks/community/java/ag-ui/server/README.md — the Spring adapter and Spring
 * AI integration ship from a separate `ag-ui-spring` repository), so no test
 * here can prove the backend tolerates the un-shimmed wire format. What these
 * tests CAN do is record exactly what the ceiling changes, so that removing it
 * produces a reviewable diff instead of a silent behavior change.
 *
 * The assertions below therefore describe behavior that the ceiling CAUSES.
 * When PNI-219's real-backend run justifies removing the pin, these
 * assertions must be inverted in the same commit — a green suite after the
 * pin is deleted would mean the suite had stopped watching anything.
 * See README.md ("Validating the protocol version ceiling") for the run.
 */
import { describe, it, expect, vi } from "vitest";
import {
  EventType,
  type InputContent,
  type Message,
  type RunAgentInput,
} from "@ag-ui/core";
import type { BaseEvent } from "@ag-ui/core";
import { SpringAiAgent } from "../index";

/** A response script the fake backend replays, minus the run envelope. */
type ResponseEvent = Record<string, unknown>;

const multimodalContent: InputContent[] = [
  { type: "text", text: "what is in " },
  {
    type: "image",
    source: { type: "data", value: "ZmFrZS1wbmc=", mimeType: "image/png" },
  },
  { type: "text", text: "this image?" },
];

/**
 * Drive one real run through the middleware chain against a fake Spring
 * backend, capturing both what left the client and what reached the app.
 */
async function runSpringAgent(options: {
  messages: Message[];
  responseEvents?: ResponseEvent[];
}) {
  const requests: RunAgentInput[] = [];
  const observed: BaseEvent[] = [];

  const agent = new SpringAiAgent({
    url: "http://spring-ai.invalid/agentic_chat/agui",
    initialMessages: options.messages,
    fetch: async (_url, requestInit) => {
      if (typeof requestInit.body !== "string") {
        throw new Error("expected a JSON string request body");
      }
      const input = JSON.parse(requestInit.body) as RunAgentInput;
      requests.push(input);

      const body = [
        {
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        },
        ...(options.responseEvents ?? []),
        {
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join("");

      return new Response(body, {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });

  await agent.runAgent(undefined, {
    onEvent: ({ event }) => {
      observed.push(event);
    },
  });

  return { requests, observed };
}

/** The single user message that reached the backend, as sent on the wire. */
function sentUserMessage(requests: RunAgentInput[]) {
  expect(requests).toHaveLength(1);
  const message = requests[0]!.messages.find(
    (candidate) => candidate.role === "user",
  );
  if (message?.role !== "user") {
    throw new Error("expected a user message to reach the backend");
  }
  return message;
}

describe("SpringAiAgent 0.0.39 ceiling — recorded baseline", () => {
  it("pins maxVersion to 0.0.39, activating all three compat shims", () => {
    const agent = new SpringAiAgent({ url: "http://spring-ai.invalid/agui" });
    expect(agent.maxVersion).toBe("0.0.39");
  });

  it("flattens structured content parts to text, dropping the image", async () => {
    const { requests } = await runSpringAgent({
      messages: [{ id: "u1", role: "user", content: multimodalContent }],
    });

    // The image part is discarded and the text parts are concatenated: this is
    // why the ceiling makes multimodal input impossible on this path.
    expect(sentUserMessage(requests).content).toBe("what is in this image?");
  });

  it("coerces an assistant message with no content to an empty string", async () => {
    const { requests } = await runSpringAgent({
      messages: [
        { id: "u1", role: "user", content: "call the tool" },
        {
          id: "a1",
          role: "assistant",
          toolCalls: [
            {
              id: "tc1",
              type: "function",
              function: { name: "get_weather", arguments: "{}" },
            },
          ],
        },
        { id: "t1", role: "tool", content: "sunny", toolCallId: "tc1" },
      ],
    });

    const assistant = requests[0]!.messages.find(
      (message) => message.role === "assistant",
    );
    if (assistant?.role !== "assistant") {
      throw new Error("expected the assistant message to reach the backend");
    }
    expect(assistant.content).toBe("");
  });

  it("rewrites legacy THINKING_* response events into REASONING_*", async () => {
    // The shim warns once per rewritten event. Silencing it keeps the output
    // readable and lets the test assert the deprecation warning is what fires.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { observed } = await runSpringAgent({
      messages: [{ id: "u1", role: "user", content: "think about it" }],
      responseEvents: [
        { type: "THINKING_START", title: "Thinking" },
        { type: "THINKING_TEXT_MESSAGE_START" },
        { type: "THINKING_TEXT_MESSAGE_CONTENT", delta: "hmm" },
        { type: "THINKING_TEXT_MESSAGE_END" },
        { type: "THINKING_END" },
      ],
    });

    // A Spring backend still emitting legacy THINKING events depends on this
    // rewrite; removing the ceiling stops it, so the run below must confirm
    // the backend emits REASONING_* natively.
    const types = observed.map((event) => event.type);
    expect(types).toContain(EventType.REASONING_START);
    expect(types).toContain(EventType.REASONING_MESSAGE_CONTENT);
    expect(types).toContain(EventType.REASONING_END);
    expect(types).not.toContain("THINKING_START");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("SpringAiAgent behavior independent of the ceiling", () => {
  it("passes plain string content through untouched", async () => {
    const { requests } = await runSpringAgent({
      messages: [{ id: "u1", role: "user", content: "Hi, I am duaa" }],
    });

    // The one Dojo lane covered by e2e today (agentic_chat) is plain text, so
    // it reads identically with and without the ceiling — which is exactly why
    // a green agentic_chat run is not evidence for removing the pin.
    expect(sentUserMessage(requests).content).toBe("Hi, I am duaa");
  });
});
