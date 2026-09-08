import type { Message, Tool } from "@ag-ui/client";
import { A2AAgent } from "../agent";
import type { MessageSendParams } from "@a2a-js/sdk";

/**
 * A2AAgent bridges AG-UI messages to an A2A server, but the A2A protocol has no
 * field for client-side tool definitions — `Message` carries only `parts` and
 * an untyped `metadata` bag. So `RunAgentInput.tools` cannot be forwarded, and
 * an A2A server never learns that the frontend registered any tools.
 *
 * That is a silent failure today: the tool is registered correctly, the run
 * succeeds, and the tool is simply never called. Reported as
 * CopilotKit/CopilotKit#3242, where the ADK server logged
 * "Initialized ClientProxyToolset with 0 tools" against the A2A path and
 * "with 1 tools" against the plain AG-UI HTTP path.
 *
 * The supported way to combine frontend tools with A2A agents is
 * A2AMiddlewareAgent, which keeps the caller's tools on an orchestration agent
 * and reaches A2A agents through its own send_message_to_a2a_agent tool. These
 * tests pin the warning that points people there.
 */

const createMessage = (message: Partial<Message>): Message =>
  message as Message;

const createTool = (name: string): Tool =>
  ({
    name,
    description: `${name} description`,
    parameters: { type: "object", properties: {} },
  }) as Tool;

class StubA2AClient {
  sendMessageStream(_params: MessageSendParams) {
    return (async function* () {
      yield {
        kind: "message",
        messageId: "resp-1",
        role: "agent",
        parts: [{ kind: "text", text: "ack" }],
      };
    })();
  }

  async sendMessage(_params: MessageSendParams) {
    return { id: null, jsonrpc: "2.0" as const, result: {} };
  }

  isErrorResponse(_response: unknown): boolean {
    return false;
  }

  async getAgentCard() {
    return { name: "Stub Agent", description: "", capabilities: {} };
  }
}

function createAgent() {
  return new A2AAgent({
    a2aClient: new StubA2AClient() as any,
    initialMessages: [
      createMessage({ id: "user-1", role: "user", content: "Hi" }),
    ],
  });
}

describe("A2AAgent frontend tool warning (CopilotKit#3242)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("warns that frontend tools are not forwarded, naming them and the alternative", async () => {
    const agent = createAgent();

    await agent.runAgent({ tools: [createTool("sayHello")] });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = String(warnSpy.mock.calls[0]?.[0]);
    expect(message).toContain("A2AAgent");
    // Names the dropped tool, so the warning is actionable in a busy app.
    expect(message).toContain("sayHello");
    // Points at the supported path rather than just reporting a limitation.
    expect(message).toContain("A2AMiddlewareAgent");
  });

  it("stays silent when the caller registered no frontend tools", async () => {
    const agent = createAgent();

    await agent.runAgent();

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("stays silent when tools is an empty array", async () => {
    const agent = createAgent();

    await agent.runAgent({ tools: [] });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warns only once per agent, so a long conversation is not spammed", async () => {
    const agent = createAgent();
    const tools = [createTool("sayHello")];

    await agent.runAgent({ tools });
    await agent.runAgent({ tools });
    await agent.runAgent({ tools });

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
