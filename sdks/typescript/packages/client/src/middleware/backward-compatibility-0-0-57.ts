import { Middleware } from "./middleware";
import { AbstractAgent } from "@/agent";
import type { RunAgentInput, BaseEvent } from "@ag-ui/core";
import { EventType } from "@ag-ui/core";
import type { Observable } from "rxjs";
import { filter, map, tap } from "rxjs/operators";

// Subagent lifecycle event types (introduced after 0.0.57). Referenced as string
// literals so this shim keeps compiling even if the enum members are ever removed.
const SUBAGENT_STARTED = "SUBAGENT_STARTED";
const SUBAGENT_FINISHED = "SUBAGENT_FINISHED";
const SUBAGENT_ERROR = "SUBAGENT_ERROR";

type MessageLike = Record<string, unknown>;

/**
 * Returns `obj` unchanged when it has no `subagentId`; otherwise returns a shallow
 * copy with the top-level `subagentId` key removed. Never mutates the input.
 * Only the top-level key is removed — nested message arrays are handled explicitly
 * by the caller (see `MESSAGES_SNAPSHOT` / `RUN_STARTED.input` handling below).
 */
function stripSubagentId<T extends object>(obj: T): T {
  if (obj && typeof obj === "object" && "subagentId" in obj) {
    const { subagentId: _subagentId, ...rest } = obj as T & { subagentId?: unknown };
    return rest as T;
  }
  return obj;
}

/** Strips the top-level `subagentId` from each message in an array. */
function stripMessages(messages: MessageLike[]): MessageLike[] {
  return messages.map((message) => stripSubagentId(message));
}

/**
 * Client middleware that removes subagent-support additions when the REMOTE AGENT is
 * pre-subagent (its `maxVersion` <= 0.0.57; the shim is auto-inserted by that gate).
 * The old party is the upstream agent, not the downstream consumer (the current client
 * supports subagents).
 *
 *  - input (client -> old agent): strips `subagentId` from every top-level message so a
 *    pre-subagent agent never receives attribution it doesn't understand. This is the
 *    substantive path — the client's replayed message history can carry `subagentId`.
 *  - output (old agent -> client): defensive normalization. A genuinely pre-subagent
 *    agent cannot emit `SUBAGENT_*` events or `subagentId`, and any `RUN_STARTED.input`
 *    echo was already sanitized on the way in — so this path guards mixed/proxied
 *    pipelines rather than doing load-bearing translation. It drops
 *    SUBAGENT_STARTED/FINISHED/ERROR events and strips `subagentId` from every remaining
 *    event, from MESSAGES_SNAPSHOT messages, and from RUN_STARTED `input` messages.
 *
 * Scope: this removes the protocol-level `subagentId` field and the SUBAGENT_* event
 * types only. It does NOT recurse into opaque application payloads (`RAW.event`,
 * `CUSTOM.value`, `STATE_SNAPSHOT.snapshot`, `STATE_DELTA.delta`, activity `content`,
 * etc.). Non-lifecycle events a subagent produced (TEXT_MESSAGE_*, TOOL_CALL_*, ...) are
 * kept with their `subagentId` stripped, so they flatten into the parent thread — the
 * intended downgrade, since subagent separation cannot be represented to a consumer with
 * no concept of it.
 *
 * The subagent feature is purely additive, so this shim is a pure removal in both
 * directions; there is no field/event to translate (unlike 0.0.45's THINKING->REASONING).
 */
export class BackwardCompatibility_0_0_57 extends Middleware {
  private warnDroppedLifecycleEvent(eventType: string) {
    if (
      typeof process !== "undefined" &&
      typeof process.env !== "undefined" &&
      process.env.SUPPRESS_TRANSFORMATION_WARNINGS
    )
      return;
    console.warn(
      `AG-UI is dropping ${eventType} because the target agent predates subagent support. ` +
        `To remove this warning, upgrade your AG-UI integration package. To suppress it, set ` +
        `SUPPRESS_TRANSFORMATION_WARNINGS=true in your .env file.`,
    );
  }

  override run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    const sanitizedInput: RunAgentInput = {
      ...input,
      messages: (input.messages ?? []).map((message) => stripSubagentId(message)),
    } as RunAgentInput;

    return this.runNext(sanitizedInput, next).pipe(
      tap((event) => {
        const type = event.type as string;
        if (type === SUBAGENT_STARTED || type === SUBAGENT_FINISHED || type === SUBAGENT_ERROR) {
          this.warnDroppedLifecycleEvent(type);
        }
      }),
      filter((event) => {
        const type = event.type as string;
        return type !== SUBAGENT_STARTED && type !== SUBAGENT_FINISHED && type !== SUBAGENT_ERROR;
      }),
      map((event) => {
        const stripped = stripSubagentId(event);

        // MESSAGES_SNAPSHOT embeds a full message array.
        if (stripped.type === EventType.MESSAGES_SNAPSHOT) {
          const snapshot = stripped as BaseEvent & { messages?: MessageLike[] };
          if (Array.isArray(snapshot.messages)) {
            return { ...snapshot, messages: stripMessages(snapshot.messages) } as BaseEvent;
          }
        }

        // RUN_STARTED may echo the run input, whose messages also carry subagentId.
        if (stripped.type === EventType.RUN_STARTED) {
          const runStarted = stripped as BaseEvent & { input?: { messages?: MessageLike[] } };
          if (runStarted.input && Array.isArray(runStarted.input.messages)) {
            return {
              ...runStarted,
              input: { ...runStarted.input, messages: stripMessages(runStarted.input.messages) },
            } as BaseEvent;
          }
        }

        return stripped;
      }),
    );
  }
}
