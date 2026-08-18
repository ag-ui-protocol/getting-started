import {
  type TraceEvent,
  normalizeEventTrace,
  parseEventTraceSse,
} from "./event-trace-events";

type ObservedStream = {
  url: string;
  body: Promise<string>;
};

type CapturedStream = {
  sequence: number;
  url: string;
  body?: string;
  events?: TraceEvent[];
  error?: Error;
};

type JourneyComparator = (
  actual: readonly TraceEvent[],
  expected: readonly TraceEvent[],
) => void | Promise<void>;

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

export class EventTraceRecorder {
  private readonly settleMs: number;
  private readonly settleTimeoutMs: number;
  private readonly streams: CapturedStream[] = [];
  private readonly active = new Set<Promise<void>>();
  private assertionCount = 0;
  private assertedStreamCount?: number;
  private overlap?: { firstUrl: string; secondUrl: string };

  constructor(options: { settleMs?: number; settleTimeoutMs?: number } = {}) {
    this.settleMs = options.settleMs ?? 100;
    this.settleTimeoutMs = options.settleTimeoutMs ?? 10_000;
  }

  observeStream(stream: ObservedStream) {
    if (this.active.size > 0 && !this.overlap) {
      const firstActive = this.streams.find(
        (candidate) => candidate.body === undefined && !candidate.error,
      );
      this.overlap = {
        firstUrl: firstActive?.url ?? "unknown stream",
        secondUrl: stream.url,
      };
    }

    const captured: CapturedStream = {
      sequence: this.streams.length,
      url: stream.url,
    };
    this.streams.push(captured);

    const completion = stream.body
      .then((body) => {
        captured.body = body;
        captured.events = parseEventTraceSse(body);
      })
      .catch((error: unknown) => {
        captured.error = toError(error);
      })
      .finally(() => {
        this.active.delete(completion);
      });

    this.active.add(completion);
  }

  async settle() {
    const deadline = Date.now() + this.settleTimeoutMs;
    let observedCount: number;

    do {
      observedCount = this.streams.length;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          `AG-UI response bodies did not settle within ${this.settleTimeoutMs}ms`,
        );
      }

      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(this.active),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () =>
                reject(
                  new Error(
                    `AG-UI response bodies did not settle within ${this.settleTimeoutMs}ms`,
                  ),
                ),
              remainingMs,
            );
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }

      if (this.settleMs > 0) {
        const settleDelayMs = Math.min(
          this.settleMs,
          Math.max(0, deadline - Date.now()),
        );
        await new Promise((resolve) => setTimeout(resolve, settleDelayMs));
      } else {
        await Promise.resolve();
      }
    } while (this.active.size > 0 || this.streams.length !== observedCount);
  }

  private readJourney() {
    if (this.overlap) {
      throw new Error(
        `Overlapping AG-UI streams are not supported: ${this.overlap.firstUrl} and ${this.overlap.secondUrl}`,
      );
    }

    const failedStream = this.streams.find((stream) => stream.error);
    if (failedStream?.error) throw failedStream.error;

    return normalizeEventTrace(
      this.streams
        .toSorted((left, right) => left.sequence - right.sequence)
        .flatMap((stream) => stream.events ?? []),
    );
  }

  getArtifacts() {
    const rawStreams = this.streams.map((stream) => {
      if (stream.body !== undefined) {
        return {
          sequence: stream.sequence,
          url: stream.url,
          body: stream.body,
        };
      }

      return {
        sequence: stream.sequence,
        url: stream.url,
        error: stream.error?.message ?? "Response body is still pending",
      };
    });

    try {
      return {
        rawStreams,
        normalizedJourney: this.readJourney(),
      };
    } catch (error) {
      return {
        rawStreams,
        normalizedJourney: undefined,
        captureError: toError(error).message,
      };
    }
  }

  async expectJourney(
    expected: readonly TraceEvent[],
    compare: JourneyComparator,
  ) {
    this.assertionCount += 1;
    if (this.assertionCount > 1) {
      throw new Error("Only one AG-UI journey assertion is allowed per test");
    }

    await this.settle();
    const actual = this.readJourney();

    if (actual.length === 0) {
      throw new Error("AG-UI journey assertion captured no non-RAW events");
    }

    await compare(actual, expected);
    this.assertedStreamCount = this.streams.length;
  }

  async finalize(options: { testAlreadyFailed: boolean }) {
    if (options.testAlreadyFailed) return;
    await this.settle();

    const actual = this.readJourney();
    if (this.assertedStreamCount !== undefined) {
      const lateEvents = this.streams
        .slice(this.assertedStreamCount)
        .flatMap((stream) => stream.events ?? []);
      if (lateEvents.length > 0) {
        throw new Error("Test emitted AG-UI events after expectJourney");
      }
    }

    if (actual.length > 0 && this.assertionCount === 0) {
      throw new Error(
        "Test emitted AG-UI events but never called expectJourney",
      );
    }
  }
}
