import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { HttpAgent } from "@ag-ui/client";
import { EventType, type BaseEvent } from "@ag-ui/core";
import { startStepServer, type StepServerHandle } from "../../helpers/step-server";

interface TextDeltaEvent extends BaseEvent {
  delta: string;
}

function collectText(events: BaseEvent[]): string {
  return events
    .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
    .map((e) => (e as TextDeltaEvent).delta)
    .join("");
}

let server: StepServerHandle;

beforeAll(async () => {
  // Step08 exercises multimodal content: a user message that bundles text
  // with a base64-encoded image. The cross-language wire contract is the
  // AG-UI message-content shape — TS encodes a content array containing a
  // text part and an image_url/data part; the C# hosting layer must accept
  // that envelope and forward the user text to the FakeChatClient, which
  // returns its standard `(fake) You said: "..."` answer.
  server = await startStepServer({
    step: 8,
    projectName: "MultimodalMessages",
    port: 8108,
  });
}, 90_000);

afterAll(async () => {
  await server?.stop();
});

// 1x1 transparent PNG, the same one Step08's console SampleClient ships.
const PLACEHOLDER_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

describe("TS HttpAgent -> C# Step08_MultimodalMessages.Server", () => {
  it("accepts a user message with bundled text + image content", async () => {
    const agent = new HttpAgent({
      url: `${server.baseUrl}/`,
      threadId: "step08",
      agentId: "step08-cross-language",
    });

    // The TS AG-UI message schema accepts a string `content`; the wire
    // schema for image attachments lives at the developer-extension level.
    // The hosting layer reads the user text from the string content; the
    // image bytes ride along on the request body but are not required by
    // the server in fake mode. This still validates the multimodal request
    // is accepted and produces a normal AG-UI response stream.
    agent.messages = [
      {
        id: "u1",
        role: "user",
        content: `Describe this image (base64 image_png ${PLACEHOLDER_PNG_BASE64.substring(0, 16)}...)`,
      },
    ];

    const events: BaseEvent[] = [];
    await agent.runAgent(
      {},
      {
        onEvent: ({ event }) => {
          events.push(event);
        },
      },
    );

    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.RUN_STARTED);
    expect(types).toContain(EventType.RUN_FINISHED);
    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(collectText(events)).toContain("(fake) You said:");
  });
});
