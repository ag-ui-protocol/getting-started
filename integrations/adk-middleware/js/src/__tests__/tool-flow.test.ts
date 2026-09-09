import { EventType } from "@ag-ui/core";
import {
  Agent,
  FunctionTool,
  InMemorySessionService,
  Runner,
} from "@google/adk";
import { describe, expect, it } from "vitest";

import { ADKJSAgent, AGUIClientToolset } from "../index";
import { DeterministicLlm, collect, runInput, verified } from "./helpers";

describe("ADKJSAgent tool flow", () => {
  it("streams the tool call, its result, and the final answer of a real ADK tool loop", async () => {
    let receivedArgs: unknown;
    const model = new DeterministicLlm([
      {
        content: {
          role: "model",
          parts: [
            {
              functionCall: {
                id: "backend-call-1",
                name: "add_numbers",
                args: { left: 2, right: 3 },
              },
            },
          ],
        },
      },
      {
        content: {
          role: "model",
          parts: [{ text: "The result is 5." }],
        },
      },
    ]);
    const tool = new FunctionTool({
      name: "add_numbers",
      description: "Add two numbers",
      execute: (input) => {
        receivedArgs = input;
        return { result: 5 };
      },
    });
    const bridge = new ADKJSAgent({
      runner: new Runner({
        appName: "test-app",
        sessionService: new InMemorySessionService(),
        agent: new Agent({ name: "real_agent", model, tools: [tool] }),
      }),
      userId: "user-1",
    });

    const events = await collect(bridge.clone(), runInput());

    expect(receivedArgs).toEqual({ left: 2, right: 3 });
    expect(model.callCount).toBe(2);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: EventType.TOOL_CALL_START,
          toolCallId: "backend-call-1",
          toolCallName: "add_numbers",
        }),
        expect.objectContaining({
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: "backend-call-1",
          content: '{"result":5}',
        }),
        expect.objectContaining({
          type: EventType.TEXT_MESSAGE_CONTENT,
          delta: "The result is 5.",
        }),
      ]),
    );
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success" },
    });
  });

  it("continues a real ADK Agent after a frontend tool result", async () => {
    const clientTools = new AGUIClientToolset();
    const model = new DeterministicLlm([
      {
        content: {
          role: "model",
          parts: [
            {
              functionCall: {
                id: "frontend-call-1",
                name: "client_action",
                args: { value: 7 },
              },
            },
          ],
        },
      },
      {
        content: {
          role: "model",
          parts: [{ text: "The frontend accepted the action." }],
        },
      },
    ]);
    const bridge = new ADKJSAgent({
      runner: new Runner({
        appName: "test-app",
        sessionService: new InMemorySessionService(),
        agent: new Agent({
          name: "real_agent",
          model,
          tools: [clientTools],
        }),
      }),
      userId: "user-1",
    });
    const firstMessage = {
      id: "user-1",
      role: "user" as const,
      content: "Run the frontend action",
    };
    const first = await collect(
      bridge.clone(),
      runInput({
        messages: [firstMessage],
        tools: [
          {
            name: "client_action",
            description: "Runs in the browser",
            parameters: {
              type: "object",
              properties: { value: { type: "number" } },
              required: ["value"],
            },
          },
        ],
      }),
    );
    const start = first.find(
      (event) =>
        event.type === EventType.TOOL_CALL_START &&
        event.toolCallId === "frontend-call-1",
    );
    expect(start).toMatchObject({
      type: EventType.TOOL_CALL_START,
      toolCallName: "client_action",
    });
    await verified(first);
    if (!start || start.type !== EventType.TOOL_CALL_START) {
      throw new Error("Expected frontend TOOL_CALL_START.");
    }
    if (typeof start.parentMessageId !== "string") {
      throw new Error("Expected frontend tool call to have a parent message.");
    }

    const second = await collect(
      bridge.clone(),
      runInput({
        runId: "run-2",
        messages: [
          firstMessage,
          {
            id: start.parentMessageId,
            role: "assistant",
            toolCalls: [
              {
                id: "frontend-call-1",
                type: "function",
                function: {
                  name: "client_action",
                  arguments: '{"value":7}',
                },
              },
            ],
          },
          {
            id: "frontend-result-1",
            role: "tool",
            toolCallId: "frontend-call-1",
            content: '{"accepted":true}',
          },
        ],
        tools: [
          {
            name: "client_action",
            description: "Runs in the browser",
            parameters: { type: "object" },
          },
        ],
      }),
    );

    expect(model.callCount).toBe(2);
    expect(second).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: EventType.TEXT_MESSAGE_CONTENT,
          delta: "The frontend accepted the action.",
        }),
      ]),
    );
    expect(second.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success" },
    });
  });

  it("attaches a frontend toolset to the root agent once and binds it per run", async () => {
    // Parity with the other integrations: an agent that declares no
    // AGUIClientToolset still receives the frontend's tools.
    const callClientAction = {
      content: {
        role: "model" as const,
        parts: [
          { functionCall: { name: "client_action", args: { value: 7 } } },
        ],
      },
    };
    const model = new DeterministicLlm([callClientAction, callClientAction]);
    const agent = new Agent({ name: "plain_agent", model, tools: [] });
    const bridge = new ADKJSAgent({
      runner: new Runner({
        appName: "test-app",
        sessionService: new InMemorySessionService(),
        agent,
      }),
      userId: "user-1",
    });
    const tools = [
      {
        name: "client_action",
        description: "Runs in the browser",
        parameters: {
          type: "object",
          properties: { value: { type: "number" } },
        },
      },
    ];

    for (const runId of ["run-1", "run-2"]) {
      const events = await collect(
        bridge.clone(),
        runInput({
          runId,
          messages: [{ id: `user-${runId}`, role: "user", content: "Run it" }],
          tools,
        }),
      );
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: EventType.TOOL_CALL_START,
            toolCallName: "client_action",
          }),
        ]),
      );
      expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
    }
    const attached = (agent as unknown as { tools: unknown[] }).tools.filter(
      (tool) => tool instanceof AGUIClientToolset,
    );
    expect(attached).toHaveLength(1);
  });
});
