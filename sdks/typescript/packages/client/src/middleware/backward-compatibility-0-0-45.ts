import { Middleware } from "./middleware";
import { AbstractAgent } from "@/agent";
import type { RunAgentInput, BaseEvent } from "@ag-ui/core";
import { EventType } from "@ag-ui/core";
import type { Observable } from "rxjs";
import { map } from "rxjs/operators";
import { randomUUID } from "@/utils";

// Event type strings for THINKING events (deprecated)
const THINKING_START = "THINKING_START";
const THINKING_END = "THINKING_END";
const THINKING_TEXT_MESSAGE_START = "THINKING_TEXT_MESSAGE_START";
const THINKING_TEXT_MESSAGE_CONTENT = "THINKING_TEXT_MESSAGE_CONTENT";
const THINKING_TEXT_MESSAGE_END = "THINKING_TEXT_MESSAGE_END";

/**
 * Middleware that maps deprecated THINKING events to the new REASONING events.
 *
 * This ensures backward compatibility for agents that still emit legacy THINKING
 * events (THINKING_START, THINKING_END, THINKING_TEXT_MESSAGE_START, etc.)
 * by transforming them into the corresponding REASONING events.
 *
 * Event mapping:
 * - THINKING_START → REASONING_START
 * - THINKING_TEXT_MESSAGE_START → REASONING_MESSAGE_START
 * - THINKING_TEXT_MESSAGE_CONTENT → REASONING_MESSAGE_CONTENT
 * - THINKING_TEXT_MESSAGE_END → REASONING_MESSAGE_END
 * - THINKING_END → REASONING_END
 *
 */
export class BackwardCompatibility_0_0_45 extends Middleware {
  private currentReasoningId: string | null = null;
  private currentMessageId: string | null = null;

  private warnAboutTransformation(from: string, to: string) {
    if (
      typeof process !== "undefined" &&
      typeof process.env !== "undefined" &&
      process.env.SUPPRESS_TRANSFORMATION_WARNINGS
    )
      return;
    console.warn(
      `AG-UI is converting ${from} to ${to}. To remove this warning, upgrade your AG-UI integration package (e.g. @ag-ui/langgraph). To surpress it, set SUPPRESS_TRANSFORMATION_WARNINGS=true in your .env file.`,
    );
  }
  override run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    // Reset state for each run
    this.currentReasoningId = null;
    this.currentMessageId = null;

    return this.runNext(input, next).pipe(map((event) => this.transformEvent(event)));
  }

  private transformEvent(event: BaseEvent): BaseEvent {
    const eventType = event.type as string;

    switch (eventType) {
      case THINKING_START: {
        this.currentReasoningId = randomUUID();
        const { title, ...rest } = event as BaseEvent & { title?: string };
        this.warnAboutTransformation(THINKING_START, EventType.REASONING_START);
        return {
          ...rest,
          type: EventType.REASONING_START,
          messageId: this.currentReasoningId,
        };
      }

      case THINKING_TEXT_MESSAGE_START: {
        this.currentMessageId = randomUUID();
        this.warnAboutTransformation(
          THINKING_TEXT_MESSAGE_START,
          EventType.REASONING_MESSAGE_START,
        );
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
        this.warnAboutTransformation(
          THINKING_TEXT_MESSAGE_CONTENT,
          EventType.REASONING_MESSAGE_CONTENT,
        );
        return {
          ...rest,
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: this.currentMessageId ?? randomUUID(),
          delta,
        };
      }

      case THINKING_TEXT_MESSAGE_END: {
        const messageId = this.currentMessageId ?? randomUUID();
        this.warnAboutTransformation(THINKING_TEXT_MESSAGE_END, EventType.REASONING_MESSAGE_END);
        return {
          ...event,
          type: EventType.REASONING_MESSAGE_END,
          messageId,
        };
      }

      case THINKING_END: {
        const reasoningId = this.currentReasoningId ?? randomUUID();
        this.warnAboutTransformation(THINKING_END, EventType.REASONING_END);
        return {
          ...event,
          type: EventType.REASONING_END,
          messageId: reasoningId,
        };
      }

      default:
        return event;
    }
  }
}
