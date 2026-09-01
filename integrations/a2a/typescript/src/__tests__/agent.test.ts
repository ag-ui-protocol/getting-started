import type { Message } from "@ag-ui/client";
import { A2AAgent } from "../agent";
import type { MessageSendParams } from "@a2a-js/sdk";

const createMessage = (message: Partial<Message>): Message => message as Message;

type SendMessageResponseSuccess = {
  id: string | number | null;
  jsonrpc: "2.0";
  result: any;
};

type SendMessageResponseError = {
  id: string | number | null;
  jsonrpc: "2.0";
  error: { code: number; message: string };
};

class FakeA2AClient {
  public lastSendParams: MessageSendParams | undefined;

  constructor(
    readonly behaviour: {
      stream?: () => AsyncGenerator<any, void, unknown>;
      send?: () => Promise<SendMessageResponseSuccess | SendMessageResponseError>;
      card?: () => Promise<any>;
    } = {},
  ) {}

  sendMessageStream(params: MessageSendParams) {
    this.lastSendParams = params;
    if (!this.behaviour.stream) {
      throw new Error("Streaming not configured");
    }
    return this.behaviour.stream();
  }

  async sendMessage(params: MessageSendParams) {
    this.lastSendParams = params;
    if (!this.behaviour.send) {
      throw new Error("sendMessage not configured");
    }
    return this.behaviour.send();
  }

  isErrorResponse(response: SendMessageResponseSuccess | SendMessageResponseError): response is SendMessageResponseError {
    return "error" in response && Boolean(response.error);
  }

  async getAgentCard() {
    if (this.behaviour.card) {
      return this.behaviour.card();
    }
    return {
      name: "Test Agent",
      description: "",
      capabilities: {},
    };
  }
}

describe("A2AAgent", () => {
  it("streams responses and records run summary", async () => {
    const fakeClient = new FakeA2AClient({
      stream: async function* () {
        yield {
          kind: "message",
          messageId: "resp-1",
          role: "agent",
          parts: [{ kind: "text", text: "Hello from stream" }],
        };
      },
    });

    const agent = new A2AAgent({
      a2aClient: fakeClient as any,
      initialMessages: [
        createMessage({
          id: "user-1",
          role: "user",
          content: "Hi there",
        }),
      ],
    });

    const result = await agent.runAgent();

    expect(result.result).toBeUndefined();

    expect(result.newMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "assistant" }),
      ]),
    );
  });

  it("falls back to blocking when streaming fails", async () => {
    const fakeClient = new FakeA2AClient({
      stream: async function* () {
        throw new Error("Streaming unsupported");
      },
      send: async () => ({
        id: null,
        jsonrpc: "2.0",
        result: {
          kind: "message",
          messageId: "resp-2",
          role: "agent",
          parts: [{ kind: "text", text: "Blocking response" }],
        },
      }),
    });

    const agent = new A2AAgent({
      a2aClient: fakeClient as any,
      initialMessages: [
        createMessage({ id: "user-1", role: "user", content: "Ping" }),
      ],
    });

    const result = await agent.runAgent();

    expect(result.result).toBeUndefined();
  });

  it("throws when the A2A service reports an error", async () => {
    const fakeClient = new FakeA2AClient({
      stream: async function* () {
        throw new Error("Streaming unsupported");
      },
      send: async () => ({
        id: null,
        jsonrpc: "2.0",
        error: { code: -32000, message: "Agent failure" },
      }),
    });

    const agent = new A2AAgent({
      a2aClient: fakeClient as any,
      initialMessages: [
        createMessage({ id: "user-1", role: "user", content: "Trouble" }),
      ],
    });

    await expect(agent.runAgent()).rejects.toThrow("Agent failure");
  });

  it("passes RunAgentInput.state as metadata['x-agui-state'] in MessageSendParams", async () => {
    const fakeClient = new FakeA2AClient({
      stream: async function* () {
        yield {
          kind: "message",
          messageId: "resp-state",
          role: "agent",
          parts: [{ kind: "text", text: "ok" }],
        };
      },
    });

    const agent = new A2AAgent({ a2aClient: fakeClient as any });

    const state = { host: { route: "/insights" }, selectedInsight: { id: "abc" } };

    await new Promise<void>((resolve, reject) => {
      agent
        .run({
          runId: "run-1",
          threadId: "thread-1",
          messages: [createMessage({ id: "u1", role: "user", content: "hi" })],
          state,
          tools: [],
          context: [],
          forwardedProps: {},
        })
        .subscribe({ complete: resolve, error: reject });
    });

    expect(fakeClient.lastSendParams?.metadata).toEqual(
      expect.objectContaining({ "x-agui-state": state }),
    );
  });

  it("omits metadata when state is empty", async () => {
    const fakeClient = new FakeA2AClient({
      stream: async function* () {
        yield {
          kind: "message",
          messageId: "resp-no-state",
          role: "agent",
          parts: [{ kind: "text", text: "ok" }],
        };
      },
    });

    const agent = new A2AAgent({ a2aClient: fakeClient as any });

    await new Promise<void>((resolve, reject) => {
      agent
        .run({
          runId: "run-2",
          threadId: "thread-2",
          messages: [createMessage({ id: "u2", role: "user", content: "hi" })],
          state: {},
          tools: [],
          context: [],
          forwardedProps: {},
        })
        .subscribe({ complete: resolve, error: reject });
    });

    expect(fakeClient.lastSendParams?.metadata).toBeUndefined();
  });
});
