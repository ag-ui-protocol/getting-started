import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Message, State } from "@ag-ui/core";

// Spy on the clone helper so we can COUNT how many full structuredClone_ calls
// runSubscribersWithMutation makes per invocation. This is the cost that, when
// paid on every streamed event over a large messages/state, exhausts the
// renderer heap (V8 fatal: "JavaScript heap out of memory" from structuredClone).
const { cloneSpy } = vi.hoisted(() => ({
  // Defer to the real native structuredClone so cyclic / non-JSON-safe values
  // round-trip correctly (the production `structuredClone_` ultimately calls
  // the native API). We only need the spy to count invocations, not change
  // behavior.
  cloneSpy: vi.fn((obj: any) => (obj === undefined ? undefined : structuredClone(obj))),
}));
vi.mock("@/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils")>();
  return { ...actual, structuredClone_: cloneSpy };
});

import { type AgentSubscriber, runSubscribersWithMutation } from "../subscriber";

describe("runSubscribersWithMutation clone cost", () => {
  beforeEach(() => cloneSpy.mockClear());

  const noopSubscriber: AgentSubscriber = { onEvent: () => undefined };

  const run = (messages: Message[], state: State) =>
    runSubscribersWithMutation([noopSubscriber], messages, state, (s, m, st) =>
      s.onEvent?.({
        messages: m,
        state: st,
        agent: {} as any,
        input: {} as any,
        event: { type: "RUN_STARTED" } as any,
      }),
    );

  it("clones baseline messages+state for SMALL payloads (dev freeze guard active)", async () => {
    await run([{ id: "m", role: "user", content: "hi" }], { counter: 1 });
    // Freeze path: baseline messages + baseline state are cloned.
    expect(cloneSpy).toHaveBeenCalledTimes(2);
  });

  it("makes ZERO clones for a LARGE payload with no mutation (the fix)", async () => {
    const bigArgs = "x".repeat(600_000); // > DEV_FREEZE_CHAR_LIMIT (512K)
    const messages: Message[] = [
      {
        id: "m",
        role: "assistant",
        toolCalls: [{ id: "tc", type: "function", function: { name: "write_file", arguments: bigArgs } }],
      } as unknown as Message,
    ];
    await run(messages, {});
    // Large payload skips the dev clone+freeze; no subscriber mutation ⇒ no clone.
    // Before the fix this was 2 full clones of a ~600KB structure on EVERY event.
    expect(cloneSpy).not.toHaveBeenCalled();
  });

  it("still defensively clones a subscriber's returned mutation on the large path", async () => {
    const bigArgs = "x".repeat(600_000);
    const mutating: AgentSubscriber = {
      onEvent: ({ messages }) => ({ messages: [...messages] as Message[] }),
    };
    const messages: Message[] = [
      {
        id: "m",
        role: "assistant",
        toolCalls: [{ id: "tc", type: "function", function: { name: "write_file", arguments: bigArgs } }],
      } as unknown as Message,
    ];
    const result = await runSubscribersWithMutation([mutating], messages, {}, (s, m, st) =>
      s.onEvent?.({ messages: m, state: st, agent: {} as any, input: {} as any, event: { type: "RUN_STARTED" } as any }),
    );
    // Exactly one clone — the defensive copy of the returned mutation (isolation
    // contract preserved), not a per-event baseline clone.
    expect(cloneSpy).toHaveBeenCalledTimes(1);
    expect(result.messages).toBeDefined();
  });

  it("terminates when state contains a cyclic reference (no infinite loop in payloadExceeds)", async () => {
    // Cyclic state — `State` is typed `any`, so user code is free to put a
    // self-referencing object here. payloadExceeds must not loop forever on it.
    //
    // The DFS scan was the symptom: before the fix, a `for (const key in value)`
    // walk with no visited-set kept re-pushing `cyclicState.self` and either
    // hung (small repro) or blew the stack via RangeError on `Array.push`
    // (large repro). Either way the dev guard never returned.
    const cyclicState: any = { name: "root" };
    cyclicState.self = cyclicState;
    cyclicState.nested = { back: cyclicState };

    // Wrap in a short timeout so a hang surfaces as a clear test failure
    // rather than the suite-level wallclock. With the fix payloadExceeds
    // visits each object at most once and resolves quickly.
    const result = await Promise.race([
      runSubscribersWithMutation([noopSubscriber], [], cyclicState, (s, m, st) =>
        s.onEvent?.({
          messages: m,
          state: st,
          agent: {} as any,
          input: {} as any,
          event: { type: "RUN_STARTED" } as any,
        }),
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("payloadExceeds hung on cyclic state")), 1000),
      ),
    ]);
    expect(result).toBeDefined();
  }, 3000);

  it("does NOT deep-freeze a huge mutation returned by a subscriber when starting from a small payload", async () => {
    // Start small so the dev freeze path is initially active (freezeInputs=true).
    const smallMessages: Message[] = [{ id: "m", role: "user", content: "hi" } as Message];
    const smallState: State = { counter: 1 };

    // Subscriber returns a mutation containing a >512K-char string nested in an
    // object. Naive code would still deep-freeze this on the next loop iteration.
    const bigString = "x".repeat(600_000);
    const hugeNested = { payload: { huge: bigString } };
    const hugeMessages: Message[] = [
      { id: "m2", role: "assistant", content: bigString } as unknown as Message,
    ];
    const growingSubscriber: AgentSubscriber = {
      onEvent: () => ({
        messages: hugeMessages,
        state: hugeNested as unknown as State,
      }),
    };
    // A second subscriber so the freeze path would be re-applied on a 2nd
    // iteration (this is where the cost regression would re-emerge).
    const observerSubscriber: AgentSubscriber = { onEvent: () => undefined };

    const result = await runSubscribersWithMutation(
      [growingSubscriber, observerSubscriber],
      smallMessages,
      smallState,
      (s, m, st) =>
        s.onEvent?.({
          messages: m,
          state: st,
          agent: {} as any,
          input: {} as any,
          event: { type: "RUN_STARTED" } as any,
        }),
    );

    // With the fix, after the growing subscriber's mutation, freezeInputs is
    // re-probed and disabled (the new payload exceeds the limit), so the next
    // subscriber iteration does NOT call deepFreeze on the huge structure, and
    // the final return path does NOT need to clone-to-unfreeze either.
    //
    // Clone budget on the freeze path WITH the fix:
    //   - 2 baseline clones of the SMALL inputs (freeze path is initially on)
    //   - 2 defensive clones of the subscriber's returned mutation
    //   = 4 total. No extra clones on the second iteration or the return path.
    //
    // Pre-fix, deepFreeze on the huge mutation freezes it, then the return
    // path adds 1–2 more structuredClone_ calls to unfreeze — i.e. > 4.
    expect(cloneSpy).toHaveBeenCalledTimes(4);

    // And the returned huge structures must remain unfrozen (callers may
    // mutate; the contract is mutable-out).
    expect(result.state).toBeDefined();
    const resultState = result.state as any;
    expect(Object.isFrozen(resultState)).toBe(false);
    expect(Object.isFrozen(resultState.payload)).toBe(false);
    expect(result.messages).toBeDefined();
    const resultMessages = result.messages as Message[];
    expect(Object.isFrozen(resultMessages)).toBe(false);
    expect(Object.isFrozen(resultMessages[0])).toBe(false);
  });
});
