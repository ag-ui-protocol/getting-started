import { EventType } from "@ag-ui/core";
import { verifyEvents } from "@ag-ui/client";
import {
  InMemorySessionService,
  Runner,
  createEvent,
  type Event as AdkEvent,
} from "@google/adk";
import { from, lastValueFrom, toArray } from "rxjs";
import { describe, expect, it } from "vitest";

import { ADKAgent, getPendingUserInputRequests } from "../index";
import { ScriptedAgent, collect, runInput, textEvent } from "./helpers";

describe("ADK interrupt compatibility", () => {
  it("finds input, credential, and confirmation requests and removes answers", () => {
    const requested = createEvent({
      author: "scripted_agent",
      content: {
        role: "model",
        parts: [
          {
            functionCall: {
              id: "input-1",
              name: "adk_request_input",
              args: {
                message: "Pick one",
                response_schema: { type: "string", enum: ["a", "b"] },
              },
            },
          },
          {
            functionCall: {
              id: "credential-1",
              name: "adk_request_credential",
              args: { auth_config: { type: "apiKey" } },
            },
          },
          {
            functionCall: {
              id: "confirmation-1",
              name: "adk_request_confirmation",
              args: {
                originalFunctionCall: { name: "delete_record" },
                toolConfirmation: { hint: "Proceed?", payload: { id: 7 } },
              },
            },
          },
        ],
      },
    });
    const answered = createEvent({
      author: "user",
      content: {
        role: "user",
        parts: [
          {
            functionResponse: {
              id: "credential-1",
              name: "adk_request_credential",
              response: { token: "secret" },
            },
          },
        ],
      },
    });

    const pending = getPendingUserInputRequests([requested, answered]);
    expect(pending.map((request) => request.kind)).toEqual([
      "input",
      "confirmation",
    ]);
    expect(pending[0]).toMatchObject({
      interruptId: "input-1",
      message: "Pick one",
      responseSchema: { type: "string", enum: ["a", "b"] },
    });
    expect(pending[1]).toMatchObject({
      interruptId: "confirmation-1",
      message: "Proceed?",
      toolName: "delete_record",
      payload: { id: 7 },
    });
  });
});

describe("ADKAgent interrupts and resume", () => {
  it("maps an ADK input request to an interrupt and resumes with a function response", async () => {
    const seenResponses: unknown[] = [];
    const root = new ScriptedAgent((context) => {
      const response = context.userContent?.parts?.[0]?.functionResponse;
      if (response) {
        seenResponses.push(response);
        return [textEvent({ id: "resumed", text: "Thanks" })];
      }
      return [
        createEvent({
          id: "request",
          author: "scripted_agent",
          content: {
            role: "model",
            parts: [
              {
                functionCall: {
                  id: "interrupt-1",
                  name: "adk_request_input",
                  args: { message: "Which region?" },
                },
              },
            ],
          },
          longRunningToolIds: ["interrupt-1"],
        }),
      ];
    });
    const runner = new Runner({
      appName: "test-app",
      agent: root,
      sessionService: new InMemorySessionService(),
    });
    const bridge = new ADKAgent({ runner, userId: "user-1" });

    const first = await collect(bridge, runInput());
    expect(first.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: {
        type: "interrupt",
        interrupts: [
          {
            id: "interrupt-1",
            reason: "input_required",
            message: "Which region?",
          },
        ],
      },
    });
    const messagesSnapshotIndex = first.findIndex(
      (event) => event.type === EventType.MESSAGES_SNAPSHOT,
    );
    expect(messagesSnapshotIndex).toBeGreaterThan(-1);
    expect(messagesSnapshotIndex).toBeLessThan(first.length - 1);
    expect(first[messagesSnapshotIndex]).toMatchObject({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [{ id: "user-1", role: "user", content: "Hello" }],
    });
    expect(first.at(-1)).not.toHaveProperty("outcome.interrupts.0.toolCallId");
    await expect(
      lastValueFrom(from(first).pipe(verifyEvents(false), toArray())),
    ).resolves.toHaveLength(first.length);

    const second = await collect(
      bridge,
      runInput({
        runId: "run-2",
        resume: [
          {
            interruptId: "interrupt-1",
            status: "resolved",
            payload: "eu-west",
          },
        ],
      }),
    );
    expect(seenResponses).toEqual([
      {
        id: "interrupt-1",
        name: "adk_request_input",
        response: { result: "eu-west" },
      },
    ]);
    expect(second.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success" },
    });
  });

  it("rejects partial resumes without executing the ADK agent", async () => {
    let executions = 0;
    const root = new ScriptedAgent(() => {
      executions += 1;
      return [
        createEvent({
          author: "scripted_agent",
          content: {
            role: "model",
            parts: [
              {
                functionCall: {
                  id: "interrupt-a",
                  name: "adk_request_input",
                  args: { message: "First answer?" },
                },
              },
              {
                functionCall: {
                  id: "interrupt-b",
                  name: "adk_request_input",
                  args: { message: "Second answer?" },
                },
              },
            ],
          },
          longRunningToolIds: ["interrupt-a", "interrupt-b"],
        }),
      ];
    });
    const bridge = new ADKAgent({
      runner: new Runner({
        appName: "test-app",
        agent: root,
        sessionService: new InMemorySessionService(),
      }),
      userId: "user-1",
    });

    await collect(bridge.clone(), runInput());
    const events = await collect(
      bridge.clone(),
      runInput({
        runId: "run-2",
        resume: [
          {
            interruptId: "interrupt-a",
            status: "resolved",
            payload: "one",
          },
        ],
      }),
    );

    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "PARTIAL_RESUME",
    });
    expect(executions).toBe(1);
  });

  it("blocks new messages while an interrupt is pending", async () => {
    let executions = 0;
    const bridge = new ADKAgent({
      runner: new Runner({
        appName: "test-app",
        sessionService: new InMemorySessionService(),
        agent: new ScriptedAgent(() => {
          executions += 1;
          return [
            createEvent({
              author: "scripted_agent",
              content: {
                role: "model",
                parts: [
                  {
                    functionCall: {
                      id: "interrupt-1",
                      name: "adk_request_input",
                      args: { message: "Answer first" },
                    },
                  },
                ],
              },
              longRunningToolIds: ["interrupt-1"],
            }),
          ];
        }),
      }),
      userId: "user-1",
    });

    const firstMessage = {
      id: "user-1",
      role: "user" as const,
      content: "Hello",
    };
    await collect(bridge.clone(), runInput({ messages: [firstMessage] }));
    const events = await collect(
      bridge.clone(),
      runInput({
        runId: "run-2",
        messages: [
          firstMessage,
          { id: "user-2", role: "user", content: "Ignore that" },
        ],
      }),
    );

    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "PENDING_INTERRUPTS",
    });
    expect(executions).toBe(1);
  });

  it("rejects a resume combined with an unseen message", async () => {
    let executions = 0;
    const bridge = new ADKAgent({
      runner: new Runner({
        appName: "test-app",
        sessionService: new InMemorySessionService(),
        agent: new ScriptedAgent(() => {
          executions += 1;
          return [
            createEvent({
              author: "scripted_agent",
              content: {
                role: "model",
                parts: [
                  {
                    functionCall: {
                      id: "interrupt-1",
                      name: "adk_request_input",
                      args: { message: "Answer first" },
                    },
                  },
                ],
              },
              longRunningToolIds: ["interrupt-1"],
            }),
          ];
        }),
      }),
      userId: "user-1",
    });
    const firstMessage = {
      id: "user-1",
      role: "user" as const,
      content: "Hello",
    };

    await collect(bridge.clone(), runInput({ messages: [firstMessage] }));
    const events = await collect(
      bridge.clone(),
      runInput({
        runId: "run-2",
        messages: [
          firstMessage,
          { id: "user-2", role: "user", content: "Also do this" },
        ],
        resume: [
          {
            interruptId: "interrupt-1",
            status: "resolved",
            payload: "answer",
          },
        ],
      }),
    );

    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "RESUME_WITH_NEW_INPUT",
    });
    expect(executions).toBe(1);
  });

  it("replays a completed resume idempotently across request clones", async () => {
    let executions = 0;
    const bridge = new ADKAgent({
      runner: new Runner({
        appName: "test-app",
        sessionService: new InMemorySessionService(),
        agent: new ScriptedAgent((context) => {
          executions += 1;
          if (context.userContent?.parts?.[0]?.functionResponse) {
            const answer = textEvent({ id: "resume-answer", text: "Done" });
            answer.actions.stateDelta = { count: 2 };
            answer.usageMetadata = {
              promptTokenCount: 4,
              candidatesTokenCount: 2,
              totalTokenCount: 6,
            };
            (answer as AdkEvent & { output?: unknown }).output = {
              status: "completed",
            };
            return [answer];
          }
          return [
            createEvent({
              author: "scripted_agent",
              content: {
                role: "model",
                parts: [
                  {
                    functionCall: {
                      id: "interrupt-1",
                      name: "adk_request_input",
                      args: { message: "Choose" },
                    },
                  },
                ],
              },
              longRunningToolIds: ["interrupt-1"],
            }),
          ];
        }),
      }),
      userId: "user-1",
    });
    const resume = [
      {
        interruptId: "interrupt-1",
        status: "resolved" as const,
        payload: { choice: "yes" },
      },
    ];

    await collect(bridge.clone(), runInput({ state: { count: 0 } }));
    const completed = await collect(
      bridge.clone(),
      runInput({ runId: "run-2", state: { count: 0 }, resume }),
    );
    const replayed = await collect(
      bridge.clone(),
      runInput({ runId: "run-3", state: { count: 0 }, resume }),
    );

    expect(completed.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success" },
    });
    expect(replayed.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      result: { status: "completed" },
      outcome: { type: "success" },
      usage: [
        {
          provider: "google",
          inputTokens: 4,
          outputTokens: 2,
          totalTokens: 6,
        },
      ],
    });
    expect(
      replayed
        .filter((event) => event.type === EventType.STATE_SNAPSHOT)
        .at(-1),
    ).toEqual({ type: EventType.STATE_SNAPSHOT, snapshot: { count: 2 } });
    expect(
      replayed.find((event) => event.type === EventType.MESSAGES_SNAPSHOT),
    ).toBeUndefined();

    const replayWithNewInput = await collect(
      bridge.clone(),
      runInput({
        runId: "run-4",
        state: { count: 0 },
        messages: [
          { id: "user-1", role: "user", content: "Hello" },
          { id: "new-user-message", role: "user", content: "New work" },
        ],
        resume,
      }),
    );
    expect(replayWithNewInput.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "RESUME_WITH_NEW_INPUT",
    });
    expect(executions).toBe(2);
  });

  it("validates resolved interrupt payloads against the ADK response schema", async () => {
    let executions = 0;
    const bridge = new ADKAgent({
      runner: new Runner({
        appName: "test-app",
        sessionService: new InMemorySessionService(),
        agent: new ScriptedAgent(() => {
          executions += 1;
          return [
            createEvent({
              author: "scripted_agent",
              content: {
                role: "model",
                parts: [
                  {
                    functionCall: {
                      id: "interrupt-1",
                      name: "adk_request_input",
                      args: {
                        message: "Choose a region",
                        response_schema: {
                          type: "object",
                          properties: { region: { type: "string" } },
                          required: ["region"],
                          additionalProperties: false,
                        },
                      },
                    },
                  },
                ],
              },
              longRunningToolIds: ["interrupt-1"],
            }),
          ];
        }),
      }),
      userId: "user-1",
    });

    await collect(bridge.clone(), runInput());
    const events = await collect(
      bridge.clone(),
      runInput({
        runId: "run-2",
        resume: [
          {
            interruptId: "interrupt-1",
            status: "resolved",
            payload: "not-an-object",
          },
        ],
      }),
    );

    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "INVALID_PAYLOAD",
    });
    expect(executions).toBe(1);
  });
});
