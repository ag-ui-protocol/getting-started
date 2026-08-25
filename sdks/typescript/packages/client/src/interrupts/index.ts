import type {
  Interrupt,
  Metadata,
  ResumeEntry,
  RunFinishedEvent,
  RunFinishedOutcome,
} from "@ag-ui/core";

export function getRunOutcome(event: RunFinishedEvent): RunFinishedOutcome | undefined {
  return event.outcome;
}

export function isInterruptExpired(interrupt: Interrupt, now: Date = new Date()): boolean {
  if (interrupt.expiresAt === undefined) return false;
  return new Date(interrupt.expiresAt) <= now;
}

type ResumeResponse =
  | { status: "resolved"; payload?: unknown; metadata?: Metadata }
  | { status: "cancelled"; metadata?: Metadata };

export function buildResumeArray(
  interrupts: Interrupt[],
  responses: Record<string, ResumeResponse>,
): ResumeEntry[] {
  const openIds = new Set(interrupts.map((i) => i.id));
  const responseIds = new Set(Object.keys(responses));

  const missing = [...openIds].filter((id) => !responseIds.has(id));
  if (missing.length > 0) {
    throw new Error(`buildResumeArray: missing responses for open interrupts: ${missing.join(", ")}`);
  }

  const unknown = [...responseIds].filter((id) => !openIds.has(id));
  if (unknown.length > 0) {
    throw new Error(`buildResumeArray: responses reference unknown interrupt ids: ${unknown.join(", ")}`);
  }

  return interrupts.map((i) => {
    const r = responses[i.id];
    const entry: ResumeEntry = { interruptId: i.id, status: r.status };
    if (r.status === "resolved" && r.payload !== undefined) entry.payload = r.payload;
    if (r.metadata !== undefined) entry.metadata = r.metadata;
    return entry;
  });
}
