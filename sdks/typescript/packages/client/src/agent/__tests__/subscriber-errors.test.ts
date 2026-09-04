/**
 * What happens to an exception a subscriber throws.
 *
 * A subscriber must not take the run down with it, so the exception is
 * swallowed and the next subscriber runs. But swallowed is not the same as
 * unobservable: under vitest the catch used to log nothing at all for an
 * ordinary error, and it attributed EVERY TypeError to "mutated frozen inputs"
 * — including the `Cannot read properties of undefined` that a plain bug in a
 * subscriber produces.
 */
import type { AgentSubscriber } from "../subscriber";
import { runSubscribersWithMutation } from "../subscriber";
import type { Message, State } from "@ag-ui/core";

const run = (subscribers: AgentSubscriber[], messages: Message[] = [], state: State = {}) =>
  runSubscribersWithMutation(subscribers, messages, state, (subscriber) =>
    (subscriber as { onRunInitialized?: () => unknown }).onRunInitialized?.() as never,
  );

describe("an exception thrown by a subscriber", () => {
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
        } as AgentSubscriber,
        { onRunInitialized: later } as unknown as AgentSubscriber,
      ]),
    );

    expect(later).toHaveBeenCalled();
    expect(logged).toContain("Subscriber error:");
    expect(logged).toContain("subscriber blew up");
  });

  it("is not blamed on frozen inputs when it is an ordinary TypeError", async () => {
    const logged = await loggedErrorsDuring(() =>
      run([
        {
          onRunInitialized: () => {
            // The everyday bug: nothing to do with the freeze guard.
            const nothing = undefined as unknown as { length: number };
            return nothing.length as never;
          },
        } as unknown as AgentSubscriber,
      ]),
    );

    expect(logged).toContain("Subscriber error:");
    expect(logged).not.toContain("mutate frozen inputs");
  });

  it.each([
    // V8 (Chrome, Node, Edge).
    ["V8", "Cannot assign to read only property 'content' of object '#<Object>'"],
    ["V8", "Cannot add property extra, object is not extensible"],
    ["V8", "Cannot delete property 'content' of #<Object>"],
    // SpiderMonkey (Firefox).
    ["SpiderMonkey", '"content" is read-only'],
    ["SpiderMonkey", "can't define property \"extra\": Object is not extensible"],
    ["SpiderMonkey", 'property "content" is non-configurable and can\'t be deleted'],
    // JavaScriptCore (Safari).
    ["JSC", "Attempted to assign to readonly property."],
    ["JSC", "Attempting to define property on object that is not extensible."],
    ["JSC", "Unable to delete property."],
  ])("recognises the freeze violation %s reports as \"%s\"", async (_engine, message) => {
    // The guard reads the engine's MESSAGE, because a TypeError is all any of
    // them throws. So the table of wordings has to be complete across the
    // engines this library ships to, not just the one it is developed on: a
    // spelling missing from it is a freeze violation reported as an ordinary
    // subscriber error, which is the mis-attribution this guard exists to end,
    // pointing the other way.
    await expect(
      run([
        {
          onRunInitialized: () => {
            throw new TypeError(message);
          },
        } as unknown as AgentSubscriber,
      ]),
    ).rejects.toThrow(message);
  });

  it("does not fire for a subscriber that only READS the frozen inputs", async () => {
    // The control for the test below, and it has to be a real one. Reading a
    // frozen object is legal; only a write is the violation. A subscriber that
    // reads and returns nothing must therefore come back with an EMPTY
    // mutation — no messages, no state, no stopPropagation — rather than
    // merely "something defined", which every possible return value satisfies.
    let read: unknown;
    const mutation = await runSubscribersWithMutation(
      [{} as AgentSubscriber],
      [{ id: "m1", role: "user", content: "hi" } as Message],
      { seeded: true } as State,
      (_subscriber, messages, state) => {
        read = [messages[0].content, (state as { seeded?: boolean }).seeded];
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
        [{} as AgentSubscriber],
        [{ id: "m1", role: "user", content: "hi" } as Message],
        {},
        (_subscriber, messages) => {
          (messages as unknown as Message[])[0].content = "mutated in place";
          return undefined;
        },
      ),
    ).rejects.toThrow(/read[- ]?only/i);
  });
});
