import { describe, expect, it } from "vitest";

import { SharedRunnerMutex } from "../shared-runner-mutex";

describe("SharedRunnerMutex", () => {
  it("removes an aborted waiter and remains reusable", async () => {
    const mutex = new SharedRunnerMutex();
    const activeController = new AbortController();
    const release = await mutex.acquire(activeController.signal);
    const queuedController = new AbortController();
    const queued = mutex.acquire(queuedController.signal);

    queuedController.abort(new DOMException("cancelled", "AbortError"));
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    release();

    const nextController = new AbortController();
    const releaseNext = await mutex.acquire(nextController.signal);
    releaseNext();
  });
});
