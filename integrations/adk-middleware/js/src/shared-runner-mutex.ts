interface Waiter {
  resolve: (release: () => void) => void;
  reject: (reason: unknown) => void;
  signal: AbortSignal;
  onAbort: () => void;
}

/** Abort-aware mutex that protects one shared ADK runner/toolset tree. */
export class SharedRunnerMutex {
  private active = false;
  private readonly waiters: Waiter[] = [];

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) {
      return Promise.reject(signal.reason);
    }
    if (!this.active) {
      this.active = true;
      return Promise.resolve(this.releaseForCurrentHolder());
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) {
            this.waiters.splice(index, 1);
          }
          signal.removeEventListener("abort", waiter.onAbort);
          reject(signal.reason);
        },
      };
      this.waiters.push(waiter);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    });
  }

  private releaseForCurrentHolder(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;

      let next = this.waiters.shift();
      while (next?.signal.aborted) {
        next.signal.removeEventListener("abort", next.onAbort);
        next.reject(next.signal.reason);
        next = this.waiters.shift();
      }
      if (next) {
        next.signal.removeEventListener("abort", next.onAbort);
        next.resolve(this.releaseForCurrentHolder());
        return;
      }

      this.active = false;
    };
  }
}
