import { Middleware } from "./middleware";
import { AbstractAgent } from "@/agent";
import type { RunAgentInput, BaseEvent, Message } from "@ag-ui/core";
import { EventType } from "@ag-ui/core";
import { defer, type Observable } from "rxjs";
import { map } from "rxjs/operators";
import { randomUUID } from "@/utils";
import { upgradeMessageContent } from "./backward-compatibility-0-0-47";

// Deprecated inbound shapes, retired from the 1.0 contract. Each entry here
// has a row in the repo-root DEPRECATIONS.md — not this package's own
// DEPRECATIONS.md, which tracks a different set under a different schema —
// with its replacement and expiry date.
const THINKING_START = "THINKING_START";
const THINKING_END = "THINKING_END";
const THINKING_TEXT_MESSAGE_START = "THINKING_TEXT_MESSAGE_START";
const THINKING_TEXT_MESSAGE_CONTENT = "THINKING_TEXT_MESSAGE_CONTENT";
const THINKING_TEXT_MESSAGE_END = "THINKING_TEXT_MESSAGE_END";

/**
 * The always-on inbound half of the pre-1.0 compatibility boundary.
 *
 * With enforcement running AFTER middleware (PNI-205), anything nobody
 * translates is stripped with a warning. This middleware is the translator:
 * it upgrades every retired-but-understood inbound shape into its 1.0
 * equivalent, so no data an old peer sends is lost. It is deliberately NOT
 * version-gated — a legacy-shaped event arriving is itself the proof the
 * peer is old, and on a modern stream every branch below is a no-op. (The
 * outbound direction stays version-gated in the 0.0.39/0.0.47 middlewares,
 * because what to SEND must be decided before the server has said anything.)
 *
 * Inbound conversions, each warned once per occurrence with a pointer to
 * the repo-root DEPRECATIONS.md:
 * - THINKING_* events -> their REASONING_* equivalents. The version-gated
 *   BackwardCompatibility_0_0_45 runs the same state machine and keeps its
 *   0.0.45 threshold, but it is not untouched: its synthesized
 *   REASONING_MESSAGE_START now says `role: "reasoning"` where it used to say
 *   "assistant", the same correction made here, because enforcement moved
 *   behind the middleware chain and made the invalid role fatal. In practice
 *   only this translation runs: THIS middleware is appended innermost, so it
 *   sees every thinking event first and the shim always finds nothing to do
 *   (see the corpus README's "A shim with no fixture").
 * - Legacy binary content parts inside inbound messages (MESSAGES_SNAPSHOT,
 *   RUN_STARTED input) -> the modern media parts.
 * - The three legacy nulls -> absent: parentMessageId on TOOL_CALL_START and
 *   TOOL_CALL_CHUNK, and RUN_FINISHED.outcome.
 */
export class CompatibilityBoundary extends Middleware {
  private currentReasoningId: string | null = null;
  private currentMessageId: string | null = null;

  private warn(what: string, replacement: string) {
    if (
      typeof process !== "undefined" &&
      typeof process.env !== "undefined" &&
      process.env.SUPPRESS_TRANSFORMATION_WARNINGS
    )
      return;
    console.warn(
      `[ag-ui][compat] Converting deprecated ${what} to ${replacement}. The old shape leaves the protocol after its shim window — see the repo-root DEPRECATIONS.md. Set SUPPRESS_TRANSFORMATION_WARNINGS=true to silence.`,
    );
  }

  /**
   * A THINKING_* continuation names nothing: the id it belongs to lives in
   * this middleware's state, put there by the matching opener. When no opener
   * preceded it, there is no id to reuse and one is MINTED — which turns a
   * producer's "content with no start" into a REASONING_* event naming an id
   * nothing ever opened. Verification rejects that a few stages later, with a
   * message about an id no producer ever wrote, so the mint is announced here:
   * without this line the rejection is untraceable to its cause.
   */
  private mintedContinuationId(from: string, established: string | null): string {
    if (established !== null) return established;
    const minted = randomUUID();
    this.warnAside(
      `Minting a messageId ('${minted}') for ${from}: no THINKING opener preceded it, so there was no id to continue. The id is this client's invention, not the producer's, and verification will reject the translated event for naming something nothing opened.`,
    );
    return minted;
  }

  /**
   * A conversion side effect the caller has to be told about in its own
   * sentence: something lost, or something invented. Separate from `warn`,
   * which only announces that a retired shape was translated — a reader who
   * saw only that would have no way to know the translation was not
   * information-preserving.
   */
  private warnAside(sentence: string) {
    if (
      typeof process !== "undefined" &&
      typeof process.env !== "undefined" &&
      process.env.SUPPRESS_TRANSFORMATION_WARNINGS
    )
      return;
    console.warn(`[ag-ui][compat] ${sentence} Set SUPPRESS_TRANSFORMATION_WARNINGS=true to silence.`);
  }

  override run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    this.currentReasoningId = null;
    this.currentMessageId = null;
    // Deliberately next.run rather than runNext: runNext transforms chunks
    // before this middleware could see them, and the boundary must read the
    // RAW stream — a legacy null on a TOOL_CALL_CHUNK has to be converted
    // before chunk expansion discards or propagates it. The pipeline's own
    // chunk transformation still runs after the whole middleware chain.
    return next.run(input).pipe(map((event) => this.transformEvent(event)));
  }

  private transformEvent(event: BaseEvent): BaseEvent {
    switch (event.type as string) {
      case THINKING_START: {
        this.currentReasoningId = randomUUID();
        const { title, ...rest } = event as BaseEvent & { title?: string };
        this.warn(THINKING_START, EventType.REASONING_START);
        // REASONING_START has no `title`, so the span's label is dropped here
        // and nothing downstream can recover it. Named separately from the
        // conversion notice above because it is a LOSS, not a translation, and
        // the versioning rules require a lossy downgrade to say what went.
        if (title !== undefined) {
          this.warnAside(
            `Dropping ${THINKING_START}.title ${JSON.stringify(title)}: ${EventType.REASONING_START} has no title field, so the span's label cannot be carried and nothing downstream can recover it.`,
          );
        }
        return {
          ...rest,
          type: EventType.REASONING_START,
          messageId: this.currentReasoningId,
        };
      }

      case THINKING_TEXT_MESSAGE_START: {
        this.currentMessageId = randomUUID();
        this.warn(THINKING_TEXT_MESSAGE_START, EventType.REASONING_MESSAGE_START);
        return {
          ...event,
          type: EventType.REASONING_MESSAGE_START,
          messageId: this.currentMessageId,
          // The schema pins this role to "reasoning"; the translation used to
          // say "assistant", which nothing validated until enforcement moved
          // behind the middleware chain and made the invalid output fatal.
          role: "reasoning" as const,
        };
      }

      case THINKING_TEXT_MESSAGE_CONTENT: {
        const { delta, ...rest } = event as BaseEvent & { delta: string };
        this.warn(THINKING_TEXT_MESSAGE_CONTENT, EventType.REASONING_MESSAGE_CONTENT);
        return {
          ...rest,
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: this.mintedContinuationId(THINKING_TEXT_MESSAGE_CONTENT, this.currentMessageId),
          delta,
        };
      }

      case THINKING_TEXT_MESSAGE_END: {
        const messageId = this.mintedContinuationId(
          THINKING_TEXT_MESSAGE_END,
          this.currentMessageId,
        );
        this.currentMessageId = null;
        this.warn(THINKING_TEXT_MESSAGE_END, EventType.REASONING_MESSAGE_END);
        return {
          ...event,
          type: EventType.REASONING_MESSAGE_END,
          messageId,
        };
      }

      case THINKING_END: {
        const reasoningId = this.mintedContinuationId(THINKING_END, this.currentReasoningId);
        this.currentReasoningId = null;
        this.warn(THINKING_END, EventType.REASONING_END);
        return {
          ...event,
          type: EventType.REASONING_END,
          messageId: reasoningId,
        };
      }

      case EventType.TOOL_CALL_START:
      case EventType.TOOL_CALL_CHUNK: {
        const record = event as BaseEvent & { parentMessageId?: string | null };
        if (record.parentMessageId === null) {
          this.warn(`${event.type}.parentMessageId: null`, "an absent field");
          const { parentMessageId: _null, ...rest } = record;
          return rest as BaseEvent;
        }
        return event;
      }

      case EventType.RUN_FINISHED: {
        const record = event as BaseEvent & { outcome?: unknown };
        if (record.outcome === null) {
          this.warn("RUN_FINISHED.outcome: null", "an absent field");
          const { outcome: _null, ...rest } = record;
          return rest as BaseEvent;
        }
        return event;
      }

      case EventType.MESSAGES_SNAPSHOT: {
        const record = event as BaseEvent & { messages?: Message[] };
        if (!Array.isArray(record.messages)) return event;
        return {
          ...record,
          messages: record.messages.map((message) => this.upgradeInboundMessage(message)),
        };
      }

      case EventType.RUN_STARTED: {
        const record = event as BaseEvent & { input?: { messages?: Message[] } };
        if (!record.input || !Array.isArray(record.input.messages)) return event;
        return {
          ...record,
          input: {
            ...record.input,
            messages: record.input.messages.map((message) => this.upgradeInboundMessage(message)),
          },
        };
      }

      default:
        return event;
    }
  }

  private upgradeInboundMessage(message: Message): Message {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return message;
    const hasLegacyBinary = content.some(
      (part) =>
        typeof part === "object" && part !== null && (part as { type?: unknown }).type === "binary",
    );
    if (!hasLegacyBinary) return message;
    this.warn("binary input content", "the modern media content parts");
    return upgradeMessageContent(message as never) as Message;
  }
}

/**
 * The boundary as a plain stream operator, for pipelines that have no
 * middleware chain to install it into (the connect/subscribe flow). A fresh
 * instance per subscription keeps the translation state per stream.
 */
export const compatibilityBoundaryOperator =
  () =>
  (source$: Observable<BaseEvent>): Observable<BaseEvent> =>
    defer(() => {
      const boundary = new CompatibilityBoundary();
      return source$.pipe(map((event) => boundary["transformEvent"](event)));
    });
