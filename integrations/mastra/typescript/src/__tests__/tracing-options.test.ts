import { describe, it, expect } from "vitest";
import { EventType } from "@ag-ui/client";
import type { RunFinishedEvent } from "@ag-ui/client";
import {
  FakeLocalAgent,
  FakeRemoteAgent,
  makeInput,
  collectEvents,
} from "./helpers";
import { MastraAgent } from "../mastra";
import { getLocalAgents } from "../utils";

// A minimal clean stream: one text chunk then finish, so the run reaches
// RUN_FINISHED (which carries the execution traceId on `result` when exposed).
function textChunks() {
  return [
    { type: "text-delta", payload: { text: "Hello" } },
    { type: "finish", payload: {} },
  ];
}

function runFinished(events: { type: string }[]): RunFinishedEvent | undefined {
  return events.find(
    (e): e is RunFinishedEvent => e.type === EventType.RUN_FINISHED,
  );
}

// Drives the resume path exactly the way interrupt-bridge.test.ts does: a
// resolved resume command carried on forwardedProps.command, which run()
// normalizes and dispatches to resumeStream.
function makeResumeInput(
  interruptEvent: Record<string, any>,
  resumeData: unknown = { approved: true },
) {
  return makeInput({
    forwardedProps: {
      command: {
        resume: resumeData,
        interruptEvent: JSON.stringify(interruptEvent),
      },
    },
  });
}

describe("tracingOptions passthrough (inbound)", () => {
  it("forwards tracingOptions into local agent.stream()", async () => {
    const fake = new FakeLocalAgent({ streamChunks: textChunks() });
    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fake as any,
      resourceId: "resource-1",
      tracingOptions: { traceId: "trace-abc", metadata: { source: "ui" } },
    });

    await collectEvents(agent, makeInput());

    expect(fake.lastStreamOpts?.tracingOptions).toEqual({
      traceId: "trace-abc",
      metadata: { source: "ui" },
    });
  });

  it("forwards tracingOptions into remote agent.stream()", async () => {
    const fake = new FakeRemoteAgent({ streamChunks: textChunks() });
    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fake as any,
      resourceId: "resource-1",
      tracingOptions: { traceId: "trace-remote" },
    });

    await collectEvents(agent, makeInput());

    expect(fake.lastStreamOpts?.tracingOptions).toEqual({
      traceId: "trace-remote",
    });
  });

  it("omits tracingOptions when not configured", async () => {
    const fake = new FakeLocalAgent({ streamChunks: textChunks() });
    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fake as any,
      resourceId: "resource-1",
    });

    await collectEvents(agent, makeInput());

    expect(fake.lastStreamOpts).toBeTruthy();
    expect("tracingOptions" in fake.lastStreamOpts).toBe(false);
  });

  it("omits tracingOptions when not configured (remote path)", async () => {
    const fake = new FakeRemoteAgent({ streamChunks: textChunks() });
    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fake as any,
      resourceId: "resource-1",
    });

    await collectEvents(agent, makeInput());

    expect(fake.lastStreamOpts).toBeTruthy();
    expect("tracingOptions" in fake.lastStreamOpts).toBe(false);
  });

  it("forwards tracingOptions into resumeStream()'s options on the resume path", async () => {
    // Resume is driven the same way interrupt-bridge.test.ts does: a resolved
    // command on forwardedProps.command. resumeChunks makes resumeStream return
    // a valid fullStream so the run reaches RUN_FINISHED.
    const fake = new FakeLocalAgent({
      streamChunks: [],
      resumeChunks: [{ type: "text-delta", payload: { text: "Approved." } }],
    });
    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fake as any,
      resourceId: "resource-1",
      tracingOptions: { traceId: "resume-trace", metadata: { source: "ui" } },
    });

    await collectEvents(
      agent,
      makeResumeInput({
        type: "mastra_suspend",
        toolCallId: "tc-1",
        runId: "run-1",
      }),
    );

    expect(fake.lastResumeOpts).toBeTruthy();
    expect(fake.lastResumeOpts.tracingOptions).toEqual({
      traceId: "resume-trace",
      metadata: { source: "ui" },
    });
  });
});

describe("execution traceId surfacing (outbound)", () => {
  it("surfaces traceId on RUN_FINISHED.result (local)", async () => {
    const fake = new FakeLocalAgent({
      streamChunks: textChunks(),
      traceId: "exec-trace-1",
    });
    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fake as any,
      resourceId: "resource-1",
    });

    const events = await collectEvents(agent, makeInput());

    const finished = runFinished(events);
    expect(finished?.result).toEqual({ traceId: "exec-trace-1" });
  });

  it("surfaces traceId on RUN_FINISHED.result (remote)", async () => {
    const fake = new FakeRemoteAgent({
      streamChunks: textChunks(),
      traceId: "exec-trace-remote",
    });
    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fake as any,
      resourceId: "resource-1",
    });

    const events = await collectEvents(agent, makeInput());

    const finished = runFinished(events);
    expect(finished?.result).toEqual({ traceId: "exec-trace-remote" });
  });

  it("awaits a Promise-valued traceId", async () => {
    const fake = new FakeLocalAgent({
      streamChunks: textChunks(),
      traceId: Promise.resolve("async-trace"),
    });
    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fake as any,
      resourceId: "resource-1",
    });

    const events = await collectEvents(agent, makeInput());

    const finished = runFinished(events);
    expect(finished?.result).toEqual({ traceId: "async-trace" });
  });

  it("leaves RUN_FINISHED.result unset when the response exposes no traceId", async () => {
    const fake = new FakeLocalAgent({ streamChunks: textChunks() });
    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fake as any,
      resourceId: "resource-1",
    });

    const events = await collectEvents(agent, makeInput());

    const finished = runFinished(events);
    expect(finished).toBeTruthy();
    expect(finished?.result).toBeUndefined();
  });

  it("round-trips an injected inbound traceId onto RUN_FINISHED.result", async () => {
    // Documented round-trip: a client injects a self-chosen traceId via
    // tracingOptions, the execution anchors under it, and the same id is
    // surfaced back on RUN_FINISHED.result so the client can correlate.
    const roundTripId = "client-chosen-trace";
    const fake = new FakeLocalAgent({
      streamChunks: textChunks(),
      traceId: roundTripId,
    });
    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fake as any,
      resourceId: "resource-1",
      tracingOptions: { traceId: roundTripId },
    });

    const events = await collectEvents(agent, makeInput());

    // Injected inbound…
    expect(fake.lastStreamOpts?.tracingOptions).toEqual({
      traceId: roundTripId,
    });
    // …and the same id surfaced back out.
    const finished = runFinished(events);
    expect(finished?.result).toEqual({ traceId: roundTripId });
  });

  it("leaves RUN_FINISHED.result unset when the response traceId is an empty string", async () => {
    // resolveTraceId guards with `length > 0`, so "" must not surface a result.
    const fake = new FakeLocalAgent({
      streamChunks: textChunks(),
      traceId: "",
    });
    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fake as any,
      resourceId: "resource-1",
    });

    const events = await collectEvents(agent, makeInput());

    const finished = runFinished(events);
    expect(finished).toBeTruthy();
    expect(finished?.result).toBeUndefined();
  });

  it("completes with RUN_FINISHED (result unset) when the traceId Promise rejects", async () => {
    // resolveTraceId swallows a rejecting traceId read so it never blocks
    // RUN_FINISHED. Pre-attach a no-op catch so the rejection we hand in is
    // never flagged as unhandled by the test runner (resolveTraceId awaits the
    // SAME promise, so awaiting a handled rejection still throws inside its
    // try/catch as intended).
    const rejecting = Promise.reject(new Error("boom"));
    rejecting.catch(() => {});
    const fake = new FakeLocalAgent({
      streamChunks: textChunks(),
      traceId: rejecting as unknown as Promise<string>,
    });
    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fake as any,
      resourceId: "resource-1",
    });

    const events = await collectEvents(agent, makeInput());

    const finished = runFinished(events);
    expect(finished).toBeTruthy();
    expect(finished?.result).toBeUndefined();
  });
});

describe("getLocalAgents forwards tracingOptions", () => {
  it("threads tracingOptions onto each constructed agent", async () => {
    const fake = new FakeLocalAgent({ streamChunks: textChunks() });
    const mastra = {
      listAgents: () => ({ "test-agent": fake }),
    } as any;

    const agents = getLocalAgents({
      mastra,
      resourceId: "resource-1",
      tracingOptions: { traceId: "cfg-trace" },
    });

    const agent = agents["test-agent"] as MastraAgent;
    expect(agent.tracingOptions).toEqual({ traceId: "cfg-trace" });

    await collectEvents(agent, makeInput());
    expect(fake.lastStreamOpts?.tracingOptions).toEqual({
      traceId: "cfg-trace",
    });
  });
});
