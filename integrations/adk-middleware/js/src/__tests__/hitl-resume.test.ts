import { EventType } from "@ag-ui/core";
import {
  BaseTool,
  createEvent,
  InMemorySessionService,
  LlmAgent,
  requestInputTool,
  Runner,
  type Event as AdkEvent,
  type RunAsyncToolRequest,
} from "@google/adk";
import { describe, expect, it } from "vitest";

import { ADKJSAgent } from "../index";
import {
  DeterministicLlm,
  ScriptedAgent,
  collect,
  requestInputEvent,
  runInput,
  textEvent,
  verified,
} from "./helpers";

/** A root that raises the same input interrupt on every invocation. */
function interruptingBridge(): {
  bridge: ADKJSAgent;
  executions: () => number;
} {
  let executions = 0;
  const bridge = new ADKJSAgent({
    runner: new Runner({
      appName: "test-app",
      sessionService: new InMemorySessionService(),
      agent: new ScriptedAgent(() => {
        executions += 1;
        return [
          requestInputEvent({ id: "interrupt-1", message: "Answer first" }),
        ];
      }),
    }),
    userId: "user-1",
  });
  return { bridge, executions: () => executions };
}

describe("ADKJSAgent interrupts and resume", () => {
  it("maps an ADK input request to an interrupt and resumes with a function response", async () => {
    const seenResponses: unknown[] = [];
    const root = new ScriptedAgent((context) => {
      const response = context.userContent?.parts?.[0]?.functionResponse;
      if (response) {
        seenResponses.push(response);
        return [textEvent({ id: "resumed", text: "Thanks" })];
      }
      return [
        requestInputEvent({
          eventId: "request",
          id: "interrupt-1",
          message: "Which region?",
        }),
      ];
    });
    const runner = new Runner({
      appName: "test-app",
      agent: root,
      sessionService: new InMemorySessionService(),
    });
    const bridge = new ADKJSAgent({ runner, userId: "user-1" });

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
    await verified(first);

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

  it("re-executes a confirmed tool with ADK's original confirmation context", async () => {
    const model = new DeterministicLlm([
      {
        content: {
          role: "model",
          parts: [
            {
              functionCall: {
                id: "delete-1",
                name: "delete_record",
                args: { id: 7 },
              },
            },
          ],
        },
      },
      { content: { role: "model", parts: [{ text: "Record 7 deleted" }] } },
    ]);

    const seenConfirmations: unknown[] = [];
    let executions = 0;
    // ADK 2.0 binds an approval to the tool it names and refuses it unless the
    // tool answers `checkRequireConfirmation` (a runtime-only request is not
    // enough: the placeholder response is never persisted, so the "dynamic"
    // path cannot match). A tool that wants its own hint and payload raises
    // the gate itself on the first pass and declares that it gates.
    class DeleteRecordTool extends BaseTool {
      constructor() {
        super({
          name: "delete_record",
          description: "Delete a record after user confirmation.",
        });
      }

      // ADK registers only tools that publish a declaration.
      override _getDeclaration() {
        return {
          name: this.name,
          description: this.description,
          parametersJsonSchema: {
            type: "object",
            properties: { id: { type: "number" } },
            required: ["id"],
          },
        };
      }

      override async checkRequireConfirmation(): Promise<boolean> {
        return true;
      }

      override async runAsync({
        toolContext,
      }: RunAsyncToolRequest): Promise<unknown> {
        executions += 1;
        if (!toolContext.toolConfirmation) {
          toolContext.requestConfirmation({
            hint: "Delete record 7?",
            payload: { id: 7 },
          });
          return { pending: true };
        }
        seenConfirmations.push(toolContext.toolConfirmation);
        return { deleted: true };
      }
    }
    const deleteRecord = new DeleteRecordTool();
    const bridge = new ADKJSAgent({
      runner: new Runner({
        appName: "test-app",
        agent: new LlmAgent({
          name: "confirmation_agent",
          model,
          tools: [deleteRecord],
        }),
        sessionService: new InMemorySessionService(),
      }),
      userId: "user-1",
    });

    const first = await collect(bridge.clone(), runInput());
    expect(first.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: {
        type: "interrupt",
        interrupts: [{ reason: "confirmation" }],
      },
    });
    const finished = first.at(-1);
    if (
      !finished ||
      finished.type !== EventType.RUN_FINISHED ||
      finished.outcome?.type !== "interrupt"
    ) {
      throw new Error("Expected the first run to request confirmation.");
    }
    const interruptId = finished.outcome.interrupts[0]?.id;
    if (!interruptId) {
      throw new Error("Expected the confirmation interrupt to have an id.");
    }

    const second = await collect(
      bridge.clone(),
      runInput({
        runId: "run-2",
        resume: [
          {
            interruptId,
            status: "resolved",
            payload: {
              approved: true,
              hint: "attacker hint",
              payload: { id: 999 },
            },
          },
        ],
      }),
    );

    expect(executions).toBe(2);
    expect(seenConfirmations).toEqual([
      expect.objectContaining({
        confirmed: true,
        hint: "Delete record 7?",
        payload: { id: 7 },
      }),
    ]);
    expect(second.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success" },
    });
  });

  it("makes a resumed input reply visible to the model, which ADK 2.x otherwise hides", async () => {
    // ADK 2.x drops every event carrying an adk_request_input call/response
    // from the model's contents, so a plain LlmAgent would re-ask forever.
    const model = new DeterministicLlm([
      {
        content: {
          role: "model",
          parts: [
            {
              functionCall: {
                id: "ask-region",
                name: "adk_request_input",
                args: { message: "Which region?" },
              },
            },
          ],
        },
      },
      {
        content: {
          role: "model",
          parts: [{ text: "Deploying to eu-west-1." }],
        },
      },
    ]);
    const bridge = new ADKJSAgent({
      runner: new Runner({
        appName: "test-app",
        sessionService: new InMemorySessionService(),
        agent: new LlmAgent({
          name: "deployer",
          model,
          tools: [requestInputTool],
        }),
      }),
      userId: "user-1",
    });

    const first = await collect(bridge.clone(), runInput());
    const finished = first.at(-1);
    if (
      finished?.type !== EventType.RUN_FINISHED ||
      finished.outcome?.type !== "interrupt"
    ) {
      throw new Error("Expected the first run to pause on the input request.");
    }
    const second = await collect(
      bridge.clone(),
      runInput({
        runId: "run-2",
        resume: [
          {
            interruptId: finished.outcome.interrupts[0].id,
            status: "resolved",
            payload: { region: "eu-west-1" },
          },
        ],
      }),
    );

    const resumedRequest = model.requests[1];
    const userTexts = (resumedRequest?.contents ?? [])
      .filter((content) => content.role === "user")
      .flatMap((content) => content.parts ?? [])
      .map((part) => part.text)
      .filter((text): text is string => typeof text === "string");
    expect(userTexts).toEqual(["Hello", '{"region":"eu-west-1"}']);
    expect(
      JSON.stringify(resumedRequest?.contents ?? []).includes(
        "adk_request_input",
      ),
    ).toBe(false);
    expect(second).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: EventType.TEXT_MESSAGE_CONTENT,
          delta: "Deploying to eu-west-1.",
        }),
      ]),
    );
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
    const bridge = new ADKJSAgent({
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
    const { bridge, executions } = interruptingBridge();

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
    expect(executions()).toBe(1);
  });

  it("rejects a resume combined with an unseen message", async () => {
    const { bridge, executions } = interruptingBridge();
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
    expect(executions()).toBe(1);
  });

  it("replays a completed resume idempotently across request clones", async () => {
    let executions = 0;
    const bridge = new ADKJSAgent({
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
          return [requestInputEvent({ id: "interrupt-1", message: "Choose" })];
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
    // A replay cannot re-stream messages, so even a successful resume must
    // replay the final message snapshot.
    expect(
      replayed.find((event) => event.type === EventType.MESSAGES_SNAPSHOT),
    ).toMatchObject({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [
        { id: "user-1", role: "user", content: "Hello" },
        { id: "resume-answer", role: "assistant", content: "Done" },
      ],
    });

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
    const bridge = new ADKJSAgent({
      runner: new Runner({
        appName: "test-app",
        sessionService: new InMemorySessionService(),
        agent: new ScriptedAgent(() => {
          executions += 1;
          return [
            requestInputEvent({
              id: "interrupt-1",
              message: "Choose a region",
              responseSchema: {
                type: "object",
                properties: { region: { type: "string" } },
                required: ["region"],
                additionalProperties: false,
              },
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

  it("refuses to replay a completed resume once the thread has moved on", async () => {
    const bridge = new ADKJSAgent({
      runner: new Runner({
        appName: "test-app",
        sessionService: new InMemorySessionService(),
        agent: new ScriptedAgent((context) => {
          const part = context.userContent?.parts?.[0];
          if (part?.functionResponse) {
            return [textEvent({ id: "answer", text: "Done" })];
          }
          return part?.text === "Hello"
            ? [requestInputEvent({ id: "interrupt-1", message: "Choose" })]
            : [textEvent({ id: `reply-${part?.text}`, text: "Again" })];
        }),
      }),
      userId: "user-1",
    });
    const resume = [
      { interruptId: "interrupt-1", status: "resolved" as const, payload: "a" },
    ];

    await collect(bridge.clone(), runInput());
    await collect(bridge.clone(), runInput({ runId: "run-2", resume }));
    const third = await collect(
      bridge.clone(),
      runInput({
        runId: "run-3",
        messages: [
          { id: "user-1", role: "user", content: "Hello" },
          { id: "user-2", role: "user", content: "More" },
        ],
      }),
    );
    expect(third.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success" },
    });

    // Replaying run 2 now would hand the client a snapshot without run 3.
    const stale = await collect(
      bridge.clone(),
      runInput({ runId: "run-4", resume }),
    );
    expect(stale.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "STALE_RESUME",
    });
  });

  it("cancels an input interrupt without leaving the thread blocked", async () => {
    const seenResponses: unknown[] = [];
    const sessionService = new InMemorySessionService();
    const bridge = new ADKJSAgent({
      runner: new Runner({
        appName: "test-app",
        sessionService,
        agent: new ScriptedAgent((context) => {
          const part = context.userContent?.parts?.[0];
          if (part?.functionResponse) {
            seenResponses.push(part.functionResponse.response);
            return [
              textEvent({ id: "after-cancel", text: "Okay, cancelled." }),
            ];
          }
          return part?.text === "Hello"
            ? [requestInputEvent({ id: "interrupt-1", message: "Pick a time" })]
            : [textEvent({ id: "later", text: "Sure" })];
        }),
      }),
      userId: "user-1",
    });

    await collect(bridge.clone(), runInput());
    const cancelled = await collect(
      bridge.clone(),
      runInput({
        runId: "run-2",
        resume: [{ interruptId: "interrupt-1", status: "cancelled" }],
      }),
    );
    expect(cancelled.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success" },
    });
    expect(seenResponses).toEqual([{ cancelled: true }]);
    // ADK hides the request-input exchange from the model, so the
    // cancellation reaches it as the same kind of reply turn as an answer.
    const session = await sessionService.getSession({
      appName: "test-app",
      userId: "user-1",
      sessionId: "thread-1",
    });
    const reply = session?.events.find((event) =>
      event.invocationId?.startsWith("ag-ui-resume-reply-"),
    );
    expect(reply?.content?.parts?.[0]?.text).toBe('{"cancelled":true}');

    const next = await collect(
      bridge.clone(),
      runInput({
        runId: "run-3",
        messages: [
          { id: "user-1", role: "user", content: "Hello" },
          { id: "user-2", role: "user", content: "Something else" },
        ],
      }),
    );
    expect(next.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success" },
    });
  });
});
