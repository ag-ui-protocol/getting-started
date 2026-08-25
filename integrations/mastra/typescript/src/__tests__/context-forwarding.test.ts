import { describe, it, expect } from "vitest";
import type { Context } from "@ag-ui/client";
import { MastraAgent } from "../mastra";
import {
  FakeLocalAgent,
  FakeRemoteAgent,
  makeInput,
  collectEvents,
} from "./helpers";

// input.context must be forwarded onto the RequestContext under "ag-ui",
// reachable by tools, on the initial run and after resume (local + remote).
// These read the context back through the same requestContext.get("ag-ui")
// channel a tool uses, so they prove reachability rather than plumbing.

const CONTEXT_A: Context[] = [{ description: "tier", value: "premium" }];
const CONTEXT_B: Context[] = [{ description: "tier", value: "enterprise" }];

/** Reads the forwarded context back the same way a tool's execute would. */
function readForwardedContext(opts: any): Context[] | undefined {
  const reqCtx = opts?.requestContext;
  if (!reqCtx || typeof reqCtx.get !== "function") return undefined;
  return reqCtx.get("ag-ui")?.context;
}

function makeLocal(opts: { streamChunks?: any[]; resumeChunks?: any[] } = {}) {
  const fake = new FakeLocalAgent(opts);
  const agent = new MastraAgent({
    agentId: "test-agent",
    agent: fake as any,
    resourceId: "resource-1",
  });
  return { agent, fake };
}

function makeRemote(opts: { streamChunks?: any[]; resumeChunks?: any[] } = {}) {
  const fake = new FakeRemoteAgent(opts);
  const agent = new MastraAgent({
    agentId: "test-agent",
    agent: fake as any,
    resourceId: "resource-1",
  });
  return { agent, fake };
}

/** Legacy resume command (forwardedProps.command), as CopilotKit < 1.61.2 sends. */
function legacyResumeInput(context: Context[]) {
  return makeInput({
    context,
    forwardedProps: {
      command: {
        resume: { approved: true },
        interruptEvent: JSON.stringify({
          type: "mastra_suspend",
          toolCallId: "tc-1",
          runId: "mastra-run-xyz",
        }),
      },
    },
  });
}

/** Standard resume channel (RunAgentInput.resume), as CopilotKit >= 1.61.2 sends. */
function standardResumeInput(context: Context[]) {
  return makeInput({
    context,
    resume: [
      {
        interruptId: "mastra-run-xyz::tc-1",
        status: "resolved",
        payload: { approved: true },
      },
    ],
  } as any);
}

describe("context forwarding: initial run", () => {
  it("forwards input.context onto requestContext for a local agent", async () => {
    const { agent, fake } = makeLocal({
      streamChunks: [{ type: "text-delta", payload: { text: "hi" } }],
    });

    await collectEvents(agent, makeInput({ context: CONTEXT_A }));

    expect(readForwardedContext(fake.lastStreamOpts)).toEqual(CONTEXT_A);
  });

  it("forwards input.context onto requestContext for a remote agent", async () => {
    const { agent, fake } = makeRemote({
      streamChunks: [{ type: "text-delta", payload: { text: "hi" } }],
    });

    await collectEvents(agent, makeInput({ context: CONTEXT_A }));

    expect(readForwardedContext(fake.lastStreamOpts)).toEqual(CONTEXT_A);
  });

  it("forwards an empty context as []", async () => {
    const { agent, fake } = makeLocal({
      streamChunks: [{ type: "text-delta", payload: { text: "hi" } }],
    });

    await collectEvents(agent, makeInput({ context: [] }));

    expect(readForwardedContext(fake.lastStreamOpts)).toEqual([]);
  });
});

describe("context forwarding: resume re-sets context", () => {
  it("forwards the resume request's context on a local legacy-channel resume", async () => {
    const { agent, fake } = makeLocal({
      resumeChunks: [{ type: "text-delta", payload: { text: "approved" } }],
    });

    await collectEvents(agent, legacyResumeInput(CONTEXT_B));

    expect(readForwardedContext(fake.lastResumeOpts)).toEqual(CONTEXT_B);
  });

  it("forwards the resume request's context on a local standard-channel resume", async () => {
    const { agent, fake } = makeLocal({
      resumeChunks: [{ type: "text-delta", payload: { text: "approved" } }],
    });

    await collectEvents(agent, standardResumeInput(CONTEXT_B));

    expect(readForwardedContext(fake.lastResumeOpts)).toEqual(CONTEXT_B);
  });

  it("forwards the resume request's context on a remote resume", async () => {
    const { agent, fake } = makeRemote({
      resumeChunks: [{ type: "text-delta", payload: { text: "approved" } }],
    });

    await collectEvents(agent, legacyResumeInput(CONTEXT_B));

    expect(fake.resumeCalls).toHaveLength(1);
    expect(readForwardedContext(fake.resumeCalls[0].opts)).toEqual(CONTEXT_B);
  });
});

describe("context forwarding: resume does not reuse a stale context", () => {
  // Reuse one agent instance (shared requestContext) across an initial run then
  // a resume, asserting the resume sees the fresh context, not the prior turn's.

  it("local resume overwrites the prior run's context (does not drop the new one)", async () => {
    const fake = new FakeLocalAgent({
      streamChunks: [{ type: "text-delta", payload: { text: "first" } }],
      resumeChunks: [{ type: "text-delta", payload: { text: "resumed" } }],
    });
    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fake as any,
      resourceId: "resource-1",
    });

    // Initial run sets context A on the shared requestContext.
    await collectEvents(agent, makeInput({ context: CONTEXT_A }));
    expect(readForwardedContext(fake.lastStreamOpts)).toEqual(CONTEXT_A);

    // Resume carries a DIFFERENT context B — it must be re-set, not dropped.
    await collectEvents(agent, legacyResumeInput(CONTEXT_B));
    expect(readForwardedContext(fake.lastResumeOpts)).toEqual(CONTEXT_B);
  });

  it("remote resume overwrites the prior run's context (does not drop the new one)", async () => {
    const fake = new FakeRemoteAgent({
      streamChunks: [{ type: "text-delta", payload: { text: "first" } }],
      resumeChunks: [{ type: "text-delta", payload: { text: "resumed" } }],
    });
    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fake as any,
      resourceId: "resource-1",
    });

    await collectEvents(agent, makeInput({ context: CONTEXT_A }));
    expect(readForwardedContext(fake.lastStreamOpts)).toEqual(CONTEXT_A);

    await collectEvents(agent, legacyResumeInput(CONTEXT_B));
    expect(fake.resumeCalls).toHaveLength(1);
    expect(readForwardedContext(fake.resumeCalls[0].opts)).toEqual(CONTEXT_B);
  });
});
