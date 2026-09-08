/**
 * What happens to an exception a subscriber throws.
 *
 * Development and production log subscriber errors and continue. Tests retain
 * the historical TypeError rejection so callback bugs fail visibly. Other
 * errors are logged, including under vitest, and frozen-input diagnostics are
 * reserved for actual frozen writes.
 */
import type { AgentSubscriber } from "../subscriber";
import { runSubscribersWithMutation } from "../subscriber";
import { HttpAgent } from "../http";
import type { Message, RunAgentInput, State } from "@ag-ui/core";

const run = (subscribers: AgentSubscriber[], messages: Message[] = [], state: State = {}) => {
  const agent = new HttpAgent({ url: "http://localhost/agent", threadId: "t1" });
  const input: RunAgentInput = {
    threadId: agent.threadId,
    runId: "r1",
    messages,
    state,
    tools: [],
    context: [],
  };
  return runSubscribersWithMutation(subscribers, messages, state, (subscriber, messages, state) =>
    subscriber.onRunInitialized?.({ agent, input, messages, state }),
  );
};

describe("an exception thrown by a subscriber", () => {
  afterEach(() => vi.unstubAllEnvs());

  /** Collected rather than read off the spy: mockRestore() also resets calls. */
  async function loggedErrorsDuring(body: () => Promise<unknown>): Promise<string> {
    const lines: string[] = [];
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => lines.push(args.map(String).join(" ")));
    try {
      await body();
    } finally {
      errors.mockRestore();
    }
    return lines.join("\n");
  }

  it("is logged even under vitest, and the run carries on", async () => {
    const later = vi.fn();
    const logged = await loggedErrorsDuring(() =>
      run([
        {
          onRunInitialized: () => {
            throw new Error("subscriber blew up");
          },
        },
        { onRunInitialized: later },
      ]),
    );

    expect(later).toHaveBeenCalled();
    expect(logged).toContain("Subscriber error:");
    expect(logged).toContain("subscriber blew up");
  });

  it.each(["development", "production"])(
    "logs an ordinary TypeError and continues in %s",
    async (mode) => {
      vi.stubEnv("NODE_ENV", mode);
      vi.stubEnv("VITEST_WORKER_ID", "");
      const later = vi.fn();
      const logged = await loggedErrorsDuring(() =>
        run([
          {
            onRunInitialized: () => {
              throw new TypeError("subscriber computation failed");
            },
          },
          { onRunInitialized: later },
        ]),
      );

      expect(logged).toContain("Subscriber error:");
      expect(logged).not.toContain("mutate frozen inputs");
      expect(later).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { name: "NODE_ENV=test", mode: "test", worker: "", payload: "" },
    { name: "VITEST_WORKER_ID", mode: "production", worker: "1", payload: "" },
    {
      name: "a payload above the freeze limit",
      mode: "test",
      worker: "",
      payload: "x".repeat(512 * 1024 + 1),
    },
  ])("rejects an ordinary TypeError with $name", async ({ mode, worker, payload }) => {
    vi.stubEnv("NODE_ENV", mode);
    vi.stubEnv("VITEST_WORKER_ID", worker);
    const error = new TypeError("subscriber computation failed");
    const later = vi.fn();

    await loggedErrorsDuring(async () => {
      await expect(
        run(
          [
            {
              onRunInitialized: () => {
                throw error;
              },
            },
            { onRunInitialized: later },
          ],
          [],
          { payload },
        ),
      ).rejects.toBe(error);
    });
    expect(later).not.toHaveBeenCalled();
  });

  it.each([
    // V8 (Chrome, Node, Edge).
    ["V8", "Cannot assign to read only property 'content' of object '#<Object>'"],
    ["V8", "Cannot add property extra, object is not extensible"],
    ["V8", "Cannot delete property 'content' of #<Object>"],
    // SpiderMonkey (Firefox).
    ["SpiderMonkey", '"content" is read-only'],
    ["SpiderMonkey", 'can\'t define property "extra": Object is not extensible'],
    ["SpiderMonkey", 'property "content" is non-configurable and can\'t be deleted'],
    // JavaScriptCore (Safari).
    ["JSC", "Attempted to assign to readonly property."],
    ["JSC", "Attempting to define property on object that is not extensible."],
    ["JSC", "Unable to delete property."],
  ])('recognises the freeze violation %s reports as "%s"', async (_engine, message) => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST_WORKER_ID", "");
    // The guard reads the engine's MESSAGE, because a TypeError is all any of
    // them throws. So the table of wordings has to be complete across the
    // engines this library ships to, not just the one it is developed on: a
    // spelling missing from it is a freeze violation reported as an ordinary
    // subscriber error, which is the mis-attribution this guard exists to end,
    // pointing the other way.
    const logged = await loggedErrorsDuring(() =>
      run([
        {
          onRunInitialized: () => {
            throw new TypeError(message);
          },
        },
      ]),
    );
    expect(logged).toContain("Subscriber attempted to mutate frozen inputs in-place");
    expect(logged).toContain(message);
  });

  it("does not fire for a subscriber that only READS the frozen inputs", async () => {
    // The control for the test below, and it has to be a real one. Reading a
    // frozen object is legal; only a write is the violation. A subscriber that
    // reads and returns nothing must therefore come back with an EMPTY
    // mutation — no messages, no state, no stopPropagation — rather than
    // merely "something defined", which every possible return value satisfies.
    let read: unknown;
    const mutation = await runSubscribersWithMutation(
      [{}],
      [{ id: "m1", role: "user", content: "hi" }],
      { seeded: true },
      (_subscriber, messages, state) => {
        read = [messages[0].content, state.seeded];
        return undefined;
      },
    );

    expect(read).toEqual(["hi", true]);
    expect(mutation).toEqual({});
  });

  it("still rethrows a genuine frozen-input violation under vitest", async () => {
    // The freeze guard's whole purpose: an in-place write to the shared inputs
    // must fail the test loudly rather than be logged and forgotten.
    //
    // Matched on the MESSAGE, not just `TypeError`. Every ordinary bug in a
    // subscriber — `Cannot read properties of undefined` above being the
    // commonest — is also a TypeError, so a bare class check passes whether
    // the guard fired or the exception simply escaped uncategorised. The
    // engine's read-only wording is what says the guard is the reason.
    await expect(
      runSubscribersWithMutation(
        [{}],
        [{ id: "m1", role: "user", content: "hi" }],
        {},
        (_subscriber, messages) => {
          Object.assign(messages[0], { content: "mutated in place" });
          return undefined;
        },
      ),
    ).rejects.toThrow(/read[- ]?only/i);
  });
});
