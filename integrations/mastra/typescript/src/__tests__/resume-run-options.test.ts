import { describe, it, expect, vi, afterEach } from "vitest";
import { EventType } from "@ag-ui/client";
import { Agent } from "@mastra/core/agent";
import { MockMemory } from "@mastra/core/memory";
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import { GENERATE_A2UI_TOOL_NAME } from "@ag-ui/a2ui-toolkit";
import { MastraAgent } from "../mastra";
import { makeInput, collectEvents } from "./helpers";

// ---------------------------------------------------------------------------
// #2667: the resumed run has to be offered the same tools and run options as
// the initial run. `run()` used to build `resumeOptions` from `toolCallId` /
// `runId` / `memory` / `requestContext` alone, so `clientTools` (the frontend
// tools from `RunAgentInput.tools`), the auto-injected A2UI `toolsets` and
// `untilIdle` were all dropped on resume. An agent that answers exclusively
// through frontend tools then ended the resumed run with nothing on the wire.
//
// The model stand-in below is what makes that observable: it can only call a
// tool it was actually OFFERED, exactly like a real model. A resume that drops
// `clientTools` therefore yields no tool call and no text.
// ---------------------------------------------------------------------------

const FRONTEND_TOOL = {
  name: "show_expense_card",
  description: "Renders the expense decision card in the UI",
  parameters: {
    type: "object",
    properties: { amount: { type: "number" } },
    required: ["amount"],
  },
};

/** Chunk names the stand-in "model" emits for the resumed turn. */
function resumedTurnChunks(opts: any): any[] {
  const offered = Object.keys(opts?.clientTools ?? {});
  const chunks: any[] = [];
  if (offered.includes(FRONTEND_TOOL.name)) {
    chunks.push({
      type: "tool-call",
      payload: {
        toolCallId: "tc-2",
        toolName: FRONTEND_TOOL.name,
        args: { amount: 250 },
      },
    });
  }
  chunks.push({ type: "finish", payload: {} });
  return chunks;
}

function resumeInput(
  forwardedExtras: Record<string, unknown> = {},
  tools: any[] = [FRONTEND_TOOL],
) {
  return makeInput({
    tools: tools as any,
    messages: [{ id: "1", role: "user", content: "Approve it" }] as any,
    forwardedProps: {
      command: {
        resume: { approved: true },
        interruptEvent: { toolCallId: "tc-1", runId: "mastra-run-1" },
      },
      ...forwardedExtras,
    },
  });
}

/**
 * A real `@mastra/core` Agent (real `listTools`, real `model`, real option
 * surface) with only `resumeStream` stubbed, since driving a genuine suspended
 * snapshot needs a configured storage backend. The stub replays whatever the
 * stand-in model would produce for the options it was handed.
 */
function realLocalAgent() {
  return new Agent({
    id: "resume-agent",
    name: "resume-agent",
    instructions: "Answer only by calling frontend tools.",
    model: new MastraLanguageModelV2Mock({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        request: { body: {} },
        response: undefined,
      }),
    }) as any,
    memory: new MockMemory() as any,
  });
}

function stubLocalResume(agent: Agent) {
  const calls: Array<{ resumeData: unknown; opts: any }> = [];
  vi.spyOn(agent, "resumeStream").mockImplementation((async (
    resumeData: any,
    opts: any,
  ) => {
    calls.push({ resumeData, opts });
    const chunks = resumedTurnChunks(opts);
    return {
      fullStream: (async function* () {
        for (const chunk of chunks) yield chunk;
      })(),
    };
  }) as any);
  return calls;
}

/** Remote analogue: @mastra/client-js replays the resumed run via callbacks. */
function remoteAgentWithResume() {
  const calls: Array<{ resumeData: unknown; opts: any }> = [];
  const agent = {
    async stream() {
      return { processDataStream: async () => {} };
    },
    async resumeStream(resumeData: any, opts: any) {
      calls.push({ resumeData, opts });
      const chunks = resumedTurnChunks(opts);
      return {
        processDataStream: async ({
          onChunk,
        }: {
          onChunk: (chunk: any) => Promise<void>;
        }) => {
          for (const chunk of chunks) await onChunk(chunk);
        },
      };
    },
  };
  return { agent, calls };
}

function wrap(agent: unknown, config: Record<string, unknown> = {}) {
  return new MastraAgent({
    agentId: "resume-agent",
    agent: agent as any,
    resourceId: "resource-1",
    ...config,
  } as any);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resume run options (#2667)", () => {
  describe("local agent", () => {
    it("still produces output when the agent answers only through frontend tools", async () => {
      const agent = realLocalAgent();
      stubLocalResume(agent);

      const events = await collectEvents(wrap(agent), resumeInput());

      const toolCallStarts = events.filter(
        (e) => e.type === EventType.TOOL_CALL_START,
      );
      expect(toolCallStarts).toHaveLength(1);
      expect((toolCallStarts[0] as any).toolCallName).toBe(FRONTEND_TOOL.name);
      expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
    });

    it("offers the frontend tools to resumeStream as clientTools", async () => {
      const agent = realLocalAgent();
      const calls = stubLocalResume(agent);

      await collectEvents(wrap(agent), resumeInput());

      expect(calls).toHaveLength(1);
      expect(calls[0].opts.clientTools).toEqual({
        [FRONTEND_TOOL.name]: {
          id: FRONTEND_TOOL.name,
          description: FRONTEND_TOOL.description,
          inputSchema: FRONTEND_TOOL.parameters,
        },
      });
      // The resume keys the suspended snapshot — unchanged by this fix.
      expect(calls[0].opts.toolCallId).toBe("tc-1");
      expect(calls[0].opts.runId).toBe("mastra-run-1");
    });

    it("forwards untilIdle on resume when the bridge is configured with it", async () => {
      const agent = realLocalAgent();
      const calls = stubLocalResume(agent);

      await collectEvents(
        wrap(agent, { untilIdle: { maxIdleMs: 1234 } }),
        resumeInput(),
      );

      expect(calls[0].opts.untilIdle).toEqual({ maxIdleMs: 1234 });
    });

    it("omits untilIdle on resume when the bridge is not configured with it", async () => {
      const agent = realLocalAgent();
      const calls = stubLocalResume(agent);

      await collectEvents(wrap(agent), resumeInput());

      expect("untilIdle" in calls[0].opts).toBe(false);
    });

    it("forwards the auto-injected A2UI toolset on resume", async () => {
      const agent = realLocalAgent();
      const calls = stubLocalResume(agent);

      await collectEvents(
        wrap(agent),
        resumeInput({ injectA2UITool: true }, []),
      );

      const toolsets = calls[0].opts.toolsets as
        | Record<string, Record<string, unknown>>
        | undefined;
      expect(toolsets?.a2ui?.[GENERATE_A2UI_TOOL_NAME]).toBeDefined();
    });

    it("omits toolsets on resume when A2UI is not injected", async () => {
      const agent = realLocalAgent();
      const calls = stubLocalResume(agent);

      await collectEvents(wrap(agent), resumeInput());

      expect("toolsets" in calls[0].opts).toBe(false);
    });
  });

  describe("remote agent", () => {
    it("still produces output when the agent answers only through frontend tools", async () => {
      const { agent } = remoteAgentWithResume();

      const events = await collectEvents(wrap(agent), resumeInput());

      const toolCallStarts = events.filter(
        (e) => e.type === EventType.TOOL_CALL_START,
      );
      expect(toolCallStarts).toHaveLength(1);
      expect((toolCallStarts[0] as any).toolCallName).toBe(FRONTEND_TOOL.name);
      expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
    });

    it("offers the frontend tools to the remote resumeStream as clientTools", async () => {
      const { agent, calls } = remoteAgentWithResume();

      await collectEvents(wrap(agent), resumeInput());

      expect(calls).toHaveLength(1);
      expect(calls[0].opts.clientTools).toEqual({
        [FRONTEND_TOOL.name]: {
          id: FRONTEND_TOOL.name,
          description: FRONTEND_TOOL.description,
          inputSchema: FRONTEND_TOOL.parameters,
        },
      });
    });

    it("does not send untilIdle or an A2UI toolset to a remote resume", async () => {
      // Mirrors the remote INITIAL stream path: `untilIdle` is local-only and
      // the A2UI toolset carries in-process `execute`s that cannot cross the
      // wire, so neither belongs on a remote resume.
      const { agent, calls } = remoteAgentWithResume();

      await collectEvents(
        wrap(agent, { untilIdle: true }),
        resumeInput({ injectA2UITool: true }),
      );

      expect("untilIdle" in calls[0].opts).toBe(false);
      expect("toolsets" in calls[0].opts).toBe(false);
    });

    it("does not attempt A2UI planning against a remote agent", async () => {
      // @mastra/client-js's Agent resource has no `listTools`, so planning
      // against it would only ever throw into the best-effort warn — noise on
      // every remote resume.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { agent } = remoteAgentWithResume();

      await collectEvents(wrap(agent), resumeInput({ injectA2UITool: true }));

      expect(
        warn.mock.calls.filter((args) =>
          String(args[0]).includes("A2UI auto-injection skipped"),
        ),
      ).toHaveLength(0);
    });
  });
});
