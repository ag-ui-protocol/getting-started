import { IN_MEMORY_SESSION_STORE_MAX_ENTRIES } from "./constants";
import type { SessionRecord, SessionStore } from "./types";

/**
 * A defensive copy of a record.
 *
 * The store must not hand out a reference to the record it holds: the agent
 * mutates records in place between persists, so an aliased record would make
 * an unpersisted mutation indistinguishable from a persisted one — and a
 * dropped write would only surface against a real out-of-process store.
 */
const copy = (record: SessionRecord): SessionRecord => structuredClone(record);

/**
 * In-memory thread↔session store. Mappings are lost on restart.
 *
 * Bounded: thread ids come from the client, so an unbounded map is a memory
 * leak an untrusted caller controls. Once `maxEntries` is reached the
 * least-recently-used mapping is dropped — which costs that thread its history
 * (the next run starts a fresh session), so a deployment that cannot afford
 * that should supply a persistent store instead.
 */
export class InMemorySessionStore implements SessionStore {
  // Insertion order is the recency order: a read or write re-inserts its key,
  // so the oldest entry is always the first one Map iteration yields.
  private records = new Map<string, SessionRecord>();

  constructor(private readonly maxEntries: number = IN_MEMORY_SESSION_STORE_MAX_ENTRIES) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("maxEntries must be a positive integer");
    }
  }

  get(key: string): SessionRecord | undefined {
    const record = this.records.get(key);
    if (record === undefined) return undefined;
    this.records.delete(key);
    this.records.set(key, record);
    return copy(record);
  }

  set(key: string, record: SessionRecord): void {
    this.records.delete(key);
    this.records.set(key, copy(record));
    while (this.records.size > this.maxEntries) {
      const oldest = this.records.keys().next();
      if (oldest.done) break;
      this.records.delete(oldest.value);
    }
  }

  delete(key: string): void {
    this.records.delete(key);
  }

  /** How many mappings are currently held. */
  get size(): number {
    return this.records.size;
  }
}
