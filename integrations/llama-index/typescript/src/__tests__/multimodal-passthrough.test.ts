/**
 * Multimodal `RunAgentInput.messages[*].content` must be POSTed to the
 * LlamaIndex AG-UI server as the original parts array, not flattened to a
 * text string.
 *
 * LlamaIndexAgent used to pin `maxVersion = "0.0.39"`, which auto-inserted
 * a compat middleware that flattened parts lists to concatenated text —
 * silently dropping every image before the request left the client. These
 * tests guard against that pin (or an equivalent flattening step) coming
 * back.
 */

import { describe, it, expect } from "vitest";
import type { InputContent } from "@ag-ui/core";
import { LlamaIndexAgent } from "../index";

/** Build an SSE Response for the events runAgent needs to complete. */
function sseResponse(events: object[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/**
 * Create an agent whose fetch records the outgoing request body and answers
 * with a minimal successful run (RUN_STARTED → RUN_FINISHED for the runId
 * the client generated).
 */
function recordingAgent() {
  const bodies: string[] = [];
  const agent = new LlamaIndexAgent({ url: "http://server.test/agent/run" });
  agent.fetch = async (_url, init) => {
    const body = String(init?.body);
    bodies.push(body);
    const input = JSON.parse(body) as { threadId: string; runId: string };
    return sseResponse([
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
    ]);
  };
  return { agent, bodies };
}

describe("multimodal pass-through", () => {
  it("POSTs parts-array content intact when the message contains an image", async () => {
    const { agent, bodies } = recordingAgent();
    const content: InputContent[] = [
      { type: "text", text: "what do you see in this image?" },
      {
        type: "image",
        source: {
          type: "data",
          // base64 of "fake-png-bytes"
          value: "ZmFrZS1wbmctYnl0ZXM=",
          mimeType: "image/png",
        },
      },
    ];
    agent.messages = [{ id: "u1", role: "user", content }];

    await agent.runAgent({});

    expect(bodies).toHaveLength(1);
    const sent = JSON.parse(bodies[0]!) as {
      messages: { role: string; content: unknown }[];
    };
    const sentContent = sent.messages[0]!.content;
    // The parts array must survive verbatim — not be concatenated into a string.
    expect(Array.isArray(sentContent)).toBe(true);
    expect(sentContent).toEqual(content);
  });

  it("keeps plain string content as a string", async () => {
    const { agent, bodies } = recordingAgent();
    agent.messages = [{ id: "u1", role: "user", content: "plain text prompt" }];

    await agent.runAgent({});

    const sent = JSON.parse(bodies[0]!) as {
      messages: { role: string; content: unknown }[];
    };
    expect(sent.messages[0]!.content).toBe("plain text prompt");
  });
});
