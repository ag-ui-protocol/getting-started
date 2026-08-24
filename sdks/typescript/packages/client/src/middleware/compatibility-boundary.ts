import { Middleware } from "./middleware";
import { AbstractAgent } from "@/agent";
import type { RunAgentInput, BaseEvent, Message } from "@ag-ui/core";
import { EventType } from "@ag-ui/core";
import { defer, type Observable } from "rxjs";
import { map } from "rxjs/operators";
import { randomUUID } from "@/utils";
import { upgradeMessageContent } from "./backward-compatibility-0-0-47";

// Deprecated inbound shapes, retired from the 1.0 contract. Each entry here
// has a row in DEPRECATIONS.md with its replacement and expiry date.
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
 * DEPRECATIONS.md:
 * - THINKING_* events -> their REASONING_* equivalents (same state machine
 *   the version-gated BackwardCompatibility_0_0_45 has always used; that
 *   middleware keeps its threshold and behaviour untouched, and whichever of
 *   the two sees a thinking event first converts it — the other then finds
 *   nothing to do).
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
      `[ag-ui][compat] Converting deprecated ${what} to ${replacement}. The old shape leaves the protocol after its shim window — see DEPRECATIONS.md. Set SUPPRESS_TRANSFORMATION_WARNINGS=true to silence.`,
    );
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
        const { title: _title, ...rest } = event as BaseEvent & { title?: string };
        this.warn(THINKING_START, EventType.REASONING_START);
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
          messageId: this.currentMessageId ?? randomUUID(),
          delta,
        };
      }

      case THINKING_TEXT_MESSAGE_END: {
        const messageId = this.currentMessageId ?? randomUUID();
        this.currentMessageId = null;
        this.warn(THINKING_TEXT_MESSAGE_END, EventType.REASONING_MESSAGE_END);
        return {
          ...event,
          type: EventType.REASONING_MESSAGE_END,
          messageId,
        };
      }

      case THINKING_END: {
        const reasoningId = this.currentReasoningId ?? randomUUID();
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
