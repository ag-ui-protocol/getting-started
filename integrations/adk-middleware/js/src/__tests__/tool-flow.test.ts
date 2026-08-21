import { EventType } from "@ag-ui/core";
import { verifyEvents } from "@ag-ui/client";
import {
  Agent,
  FunctionTool,
  InMemorySessionService,
  Runner,
} from "@google/adk";
import { from, lastValueFrom, toArray } from "rxjs";
import { describe, expect, it } from "vitest";

import { ADKAgent, AGUIClientToolset } from "../index";
import { DeterministicLlm, collect, runInput } from "./helpers";

describe("ADKAgent tool flow", () => {
  it("executes a real ADK Agent backend-tool loop", async () => {
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
    const bridge = new ADKAgent({
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
    const bridge = new ADKAgent({
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
    await expect(
      lastValueFrom(from(first).pipe(verifyEvents(false), toArray())),
    ).resolves.toHaveLength(first.length);
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
});
