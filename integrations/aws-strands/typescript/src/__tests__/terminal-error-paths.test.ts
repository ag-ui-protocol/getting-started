/**
 * One direct test per terminal RUN_ERROR this bridge can emit.
 *
 * Each test drives the real `StrandsAgent` (or the real Express endpoint) to
 * the failure and asserts the frame a client actually receives, code and
 * message both, against `error-codes.json`. That is the same shape the CrewAI
 * bridge's terminal paths take in `ag_ui_crewai/endpoint.py`: one arm per
 * failure mode, each with its own code and its own sentence.
 *
 * The message assertion goes through `expectContractError`, so the text is
 * compared to the shared table rather than to a copy of it. A code the table
 * marks shared is therefore matched against the same string on both sides,
 * which is what makes the two bridges agree without either suite reading the
 * other's source.
 *
 * Codes whose only realistic driver is a full frontend-tool or mixed-checkpoint
 * run are covered where that driver already lives, with the same assertion:
 * `frontend-tool-restart.test.ts` and `continuation-decision.test.ts`
 * (`FRONTEND_TOOL_IDENTITY_ERROR`, `INTERRUPT_SESSION_REQUIRED`,
 * `INTERRUPT_SESSION_CAPABILITY_ERROR`, `INTERRUPT_RECONCILIATION_ERROR`).
 */
import { describe, it, expect } from "vitest";
import express from "express";
import type { AddressInfo } from "net";
import {
  EventType,
  type BaseEvent,
  type Interrupt as AguiInterrupt,
  type RunAgentInput,
} from "@ag-ui/core";
import type { Agent, AgentStreamEvent } from "@strands-agents/sdk";

import { StrandsAgent } from "../agent";
import { addStrandsExpressEndpoint } from "../endpoint";
import {
  collect,
  minimalRunInput,
  modelTurn,
  realStrandsAgent,
  scriptedAgent,
  scriptedStrandsAgent,
} from "./helpers";
import { FORCE_STOP_FALLBACK, expectContractError } from "./error-code-table";

const THREAD = "thread-1";

/** The run's single RUN_ERROR, which must also be how the run ended. */
function terminalError(events: BaseEvent[]): BaseEvent {
  const errors = events.filter((e) => e.type === EventType.RUN_ERROR);
  expect(errors.map(() => EventType.RUN_ERROR)).toHaveLength(1);
  expect(events.map((e) => e.type)).not.toContain(EventType.RUN_FINISHED);
  return errors[0];
}

/** A `StrandsAgent` with no per-thread agent cached, so the build path runs. */
function uncachedAgent(
  config: ConstructorParameters<typeof StrandsAgent>[0]["config"],
): StrandsAgent {
  return new StrandsAgent({
    agent: scriptedAgent([]),
    name: "terminal-path-agent",
    config,
  });
}

function throwingStream(
  error: unknown,
): Partial<Agent> & Record<string, unknown> {
  return {
    stream: async function* () {
      throw error;
    } as unknown as Agent["stream"],
  };
}

describe("terminal error paths", () => {
  describe("lifecycle refusals", () => {
    it("refuses an overlapping run with THREAD_BUSY", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const stub = scriptedAgent([], {
        stream: async function* () {
          await gate;
        } as unknown as Agent["stream"],
      });
      const agent = new StrandsAgent({ agent: stub, name: "t" });
      (
        agent as unknown as { _agentsByThread: Map<string, unknown> }
      )._agentsByThread.set(THREAD, stub);

      const held = collect(agent, minimalRunInput({ runId: "run-held" }));
      // Let the held run reach the stream before the collision is attempted.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const refused = await collect(
        agent,
        minimalRunInput({ runId: "run-second" }),
      );
      release();
      await held;

      const error = terminalError(refused);
      expectContractError(error, "THREAD_BUSY");
      expect((error as { message?: string }).message).toContain(
        `thread "${THREAD}"`,
      );
    });

    it("reports a sessionManagerProvider that threw as SESSION_MANAGER_ERROR", async () => {
      const agent = uncachedAgent({
        sessionManagerProvider: () => {
          throw new Error("no credentials");
        },
      });

      const events = await collect(agent, minimalRunInput());

      expectContractError(terminalError(events), "SESSION_MANAGER_ERROR");
    });

    it("names the option that returned the wrong thing in SESSION_MANAGER_INVALID_TYPE", async () => {
      const agent = uncachedAgent({
        sessionManagerProvider: () => ({}) as never,
      });

      const events = await collect(agent, minimalRunInput());

      const error = terminalError(events);
      expectContractError(error, "SESSION_MANAGER_INVALID_TYPE");
      expect((error as { message?: string }).message).toContain(
        "sessionManagerProvider",
      );
    });

    it("reports a threadAgentConfig hook that threw as THREAD_AGENT_CONFIG_ERROR", async () => {
      const agent = uncachedAgent({
        threadAgentConfig: () => {
          throw new Error("bad config");
        },
      });

      const events = await collect(agent, minimalRunInput());

      expectContractError(terminalError(events), "THREAD_AGENT_CONFIG_ERROR");
    });

    it("reports a seed this bridge cannot build as SEED_BUILD_ERROR", async () => {
      // The seed is built from the client's own messages, which nothing
      // validates. A message whose content cannot even be read is the
      // cheapest thing the converter can trip over.
      const hostile = { id: "a1", role: "assistant" } as Record<
        string,
        unknown
      >;
      Object.defineProperty(hostile, "content", {
        enumerable: true,
        get() {
          throw new Error("content is not readable");
        },
      });
      const agent = uncachedAgent(undefined);

      const events = await collect(
        agent,
        minimalRunInput({
          messages: [
            hostile as never,
            { id: "u1", role: "user", content: "hi" } as never,
          ],
        }),
      );

      expectContractError(terminalError(events), "SEED_BUILD_ERROR");
    });
  });

  describe("interrupt preflight", () => {
    function parked(agent: StrandsAgent, recorded: AguiInterrupt[]): void {
      const internals = agent as unknown as {
        _pendingInterruptsByThread: Map<string, Map<string, AguiInterrupt>>;
        _agentsByThread: Map<string, unknown>;
      };
      internals._pendingInterruptsByThread.set(
        THREAD,
        new Map(recorded.map((i) => [i.id, i])),
      );
      const stub = internals._agentsByThread.get(THREAD)!;
      (stub as { _interruptState?: unknown })._interruptState = {
        activated: recorded.length > 0,
        interrupts: Object.fromEntries(
          recorded.map((i) => [i.id, { id: i.id, name: "need_input" }]),
        ),
      };
    }

    function open(id: string, extra: Partial<AguiInterrupt> = {}) {
      return { id, reason: "confirm", ...extra } as AguiInterrupt;
    }

    function resumeInput(
      entries: Array<{
        interruptId: string;
        status: string;
        payload?: unknown;
      }>,
    ): RunAgentInput {
      return minimalRunInput({ resume: entries } as Partial<RunAgentInput>);
    }

    it("refuses a fresh turn against a parked checkpoint with PENDING_INTERRUPTS", async () => {
      const agent = scriptedStrandsAgent([]);
      parked(agent, [open("i1")]);

      const events = await collect(agent, minimalRunInput());

      expectContractError(terminalError(events), "PENDING_INTERRUPTS");
    });

    it("refuses a resume with nothing to resume as UNKNOWN_INTERRUPT_ID", async () => {
      const agent = scriptedStrandsAgent([]);

      const events = await collect(
        agent,
        resumeInput([{ interruptId: "i1", status: "resolved", payload: true }]),
      );

      expectContractError(terminalError(events), "UNKNOWN_INTERRUPT_ID");
    });

    it("names an interrupt it never issued under UNKNOWN_INTERRUPT_ID", async () => {
      const agent = scriptedStrandsAgent([]);
      parked(agent, [open("i1")]);

      const events = await collect(
        agent,
        resumeInput([
          { interruptId: "i1", status: "resolved", payload: true },
          { interruptId: "never-issued", status: "resolved", payload: true },
        ]),
      );

      const error = terminalError(events);
      expectContractError(error, "UNKNOWN_INTERRUPT_ID");
      expect((error as { message?: string }).message).toContain("never-issued");
    });

    it("refuses a batch that leaves an interrupt open with PARTIAL_RESUME", async () => {
      const agent = scriptedStrandsAgent([]);
      parked(agent, [open("i1"), open("i2")]);

      const events = await collect(
        agent,
        resumeInput([{ interruptId: "i1", status: "resolved", payload: true }]),
      );

      const error = terminalError(events);
      expectContractError(error, "PARTIAL_RESUME");
      expect((error as { message?: string }).message).toContain("i2");
    });

    it("refuses a resume past its deadline with INTERRUPT_EXPIRED", async () => {
      const agent = scriptedStrandsAgent([]);
      parked(agent, [open("i1", { expiresAt: "2000-01-01T00:00:00Z" })]);

      const events = await collect(
        agent,
        resumeInput([{ interruptId: "i1", status: "resolved", payload: true }]),
      );

      expectContractError(terminalError(events), "INTERRUPT_EXPIRED");
    });

    it.each([
      ["not an object", "yes"],
      ["missing a required key", {}],
      ["a property of the wrong type", { approved: "true" }],
    ])(
      "refuses a payload that is %s with INVALID_PAYLOAD",
      async (_name, payload) => {
        const agent = scriptedStrandsAgent([]);
        parked(agent, [
          open("i1", {
            responseSchema: {
              type: "object",
              properties: { approved: { type: "boolean" } },
              required: ["approved"],
            },
          } as Partial<AguiInterrupt>),
        ]);

        const events = await collect(
          agent,
          resumeInput([{ interruptId: "i1", status: "resolved", payload }]),
        );

        const error = terminalError(events);
        expectContractError(error, "INVALID_PAYLOAD");
        expect((error as { message?: string }).message).toContain("'i1'");
      },
    );
  });

  describe("failures out of the run loop", () => {
    it("carries the reason the SDK gave under STRANDS_FORCE_STOP", async () => {
      const agent = scriptedStrandsAgent([], {
        stubOverrides: throwingStream(new Error("provider refused")),
      });

      const events = await collect(agent, minimalRunInput());

      const error = terminalError(events);
      expectContractError(error, "STRANDS_FORCE_STOP");
      expect((error as { message?: string }).message).toBe("provider refused");
    });

    it("falls back to the shared sentence when the failure carries no reason", async () => {
      const agent = scriptedStrandsAgent([], {
        stubOverrides: throwingStream(new Error("   ")),
      });

      const events = await collect(agent, minimalRunInput());

      const error = terminalError(events);
      expectContractError(error, "STRANDS_FORCE_STOP");
      expect((error as { message?: string }).message).toBe(FORCE_STOP_FALLBACK);
    });

    it("reports a defect in this adapter's own translation as ADAPTER_BUG", async () => {
      const hostile = {} as AgentStreamEvent;
      Object.defineProperty(hostile, "type", {
        get() {
          throw new TypeError("event kind is not readable");
        },
      });
      const agent = scriptedStrandsAgent([hostile]);

      const events = await collect(agent, minimalRunInput());

      expectContractError(terminalError(events), "ADAPTER_BUG");
    });

    it("reports an orchestrator failure from outside as STRANDS_ERROR", async () => {
      const orchestrator = {
        nodes: [],
        stream: async function* () {
          throw new Error("steps=<1> | max steps reached");
        },
      };
      const agent = new StrandsAgent({
        agent: orchestrator as unknown as Agent,
        name: "orchestrator",
      });

      const events = await collect(agent, minimalRunInput());

      const error = terminalError(events);
      expectContractError(error, "STRANDS_ERROR");
      expect((error as { message?: string }).message).toBe(
        "steps=<1> | max steps reached",
      );
    });
  });

  describe("prompt and continuation failures", () => {
    it("refuses a prompt nothing survives with MEDIA_RESOLUTION_FAILED", async () => {
      const { agent } = realStrandsAgent([modelTurn.text("ok")]);

      const events = await collect(
        agent,
        minimalRunInput({
          threadId: "media-thread",
          messages: [
            {
              id: "u1",
              role: "user",
              content: [
                {
                  type: "binary",
                  mimeType: "image/bmp",
                  data: Buffer.from("BMP").toString("base64"),
                },
              ],
            } as never,
          ],
        }),
      );

      const errors = events.filter((e) => e.type === EventType.RUN_ERROR);
      expect(errors).toHaveLength(1);
      expectContractError(errors[0], "MEDIA_RESOLUTION_FAILED");
    });

    it("names the results it cannot name under CONTINUATION_TOOL_NAME_UNRESOLVED", async () => {
      const agent = scriptedStrandsAgent([]);

      const events = await collect(
        agent,
        minimalRunInput({
          messages: [
            {
              id: "t1",
              role: "tool",
              content: "done",
              toolCallId: "call-xyz",
            } as never,
          ],
          tools: [
            { name: "a_frontend_tool", description: "x", parameters: {} },
          ],
        }),
      );

      const error = terminalError(events);
      expectContractError(error, "CONTINUATION_TOOL_NAME_UNRESOLVED");
      expect((error as { message?: string }).message).toContain("call-xyz");
    });
  });

  describe("transport", () => {
    /** An agent whose one event the SSE encoder cannot serialize. */
    class UnencodableAgent extends StrandsAgent {
      constructor() {
        super({ agent: scriptedAgent([]), name: "unencodable" });
      }
      async *run(): AsyncGenerator<BaseEvent, void, void> {
        yield {
          type: EventType.RUN_STARTED,
          threadId: THREAD,
          runId: "run-1",
          // `JSON.stringify` throws over a BigInt rather than dropping it.
          budget: BigInt(1),
        } as unknown as BaseEvent;
      }
    }

    it("reports an unencodable frame inside a stream already open", async () => {
      const app = express();
      app.use(express.json({ limit: "10mb" }));
      addStrandsExpressEndpoint(app, new UnencodableAgent(), { path: "/" });
      const server = await new Promise<import("http").Server>((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
      });
      const port = (server.address() as AddressInfo).port;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify(minimalRunInput()),
        });
        expect(res.ok).toBe(true);
        const frames = (await res.text())
          .split("\n\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line.replace(/^data:\s*/, "")));
        expectContractError(
          frames[frames.length - 1] as BaseEvent,
          "ENCODING_ERROR",
        );
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve())),
        );
      }
    });
  });
});
