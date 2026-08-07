import type { SessionRecord, SessionStore } from "../types";

/**
 * A stand-in for a real out-of-process session store: every read and write
 * crosses a serialization boundary, so the agent can never observe an
 * unpersisted in-place mutation through a record it handed the store. The
 * write log makes the persistence points of a run directly assertable.
 */
export class RecordingSessionStore implements SessionStore {
  private readonly records = new Map<string, string>();
  /** Every record written, in order, as an independent snapshot. */
  readonly writes: { key: string; record: SessionRecord }[] = [];
  readonly deletes: string[] = [];
  /** When set, `set` rejects with this instead of writing. */
  setError?: Error;

  async get(threadId: string): Promise<SessionRecord | undefined> {
    const stored = this.records.get(threadId);
    return stored === undefined ? undefined : (JSON.parse(stored) as SessionRecord);
  }

  async set(threadId: string, record: SessionRecord): Promise<void> {
    if (this.setError) throw this.setError;
    const snapshot = JSON.stringify(record);
    this.records.set(threadId, snapshot);
    this.writes.push({ key: threadId, record: JSON.parse(snapshot) as SessionRecord });
  }

  async delete(threadId: string): Promise<void> {
    this.records.delete(threadId);
    this.deletes.push(threadId);
  }

  /** The keys currently holding a record. */
  keys(): string[] {
    return [...this.records.keys()];
  }
}
