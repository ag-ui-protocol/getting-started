import { describe, expect, it } from "vitest";

import { ThreadRunGate } from "../thread-run-gate";

describe("ThreadRunGate", () => {
  it("rejects an active key and permits it again after release", () => {
    const gate = new ThreadRunGate();
    const release = gate.tryAcquire('["user-1","thread-1"]');
    const releaseOther = gate.tryAcquire('["user-1","thread-2"]');

    expect(release).toBeTypeOf("function");
    expect(gate.tryAcquire('["user-1","thread-1"]')).toBeUndefined();
    expect(releaseOther).toBeTypeOf("function");

    release?.();
    release?.();
    const releaseAgain = gate.tryAcquire('["user-1","thread-1"]');
    expect(releaseAgain).toBeTypeOf("function");
    releaseOther?.();
    releaseAgain?.();
  });
});
