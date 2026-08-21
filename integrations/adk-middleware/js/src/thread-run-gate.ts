/** Fail-fast admission gate for one active run per ADK user/thread pair. */
export class ThreadRunGate {
  private readonly activeKeys = new Set<string>();

  tryAcquire(key: string): (() => void) | undefined {
    if (this.activeKeys.has(key)) {
      return undefined;
    }

    this.activeKeys.add(key);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.activeKeys.delete(key);
    };
  }
}
