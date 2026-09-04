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
 * Returns `obj` unchanged when it has no `subagentRunId`; otherwise returns a shallow
 * copy with the top-level `subagentRunId` key removed. Never mutates the input.
 * Only the top-level key is removed — nested message arrays are handled explicitly
 * by the caller (see `MESSAGES_SNAPSHOT` / `RUN_STARTED.input` handling below).
 */
function stripSubagentRunId<T extends object>(obj: T): T {
  if (obj && typeof obj === "object" && "subagentRunId" in obj) {
    const { subagentRunId: _subagentRunId, ...rest } = obj as T & { subagentRunId?: unknown };
    return rest as T;
  }
  return obj;
}

/** Strips the top-level `subagentRunId` from each message in an array. */
function stripMessages(messages: MessageLike[]): MessageLike[] {
  return messages.map((message) => stripSubagentRunId(message));
}

/**
 * Client middleware that removes subagent-support additions when the REMOTE AGENT is
 * pre-subagent (its `maxProtocolVersion` <= 0.0.57; the shim is auto-inserted by that gate).
 * The old party is the upstream agent, not the downstream consumer (the current client
 * supports subagents).
 *
 *  - client → agent (the run input): strips `subagentRunId` from every top-level message so
 *    a pre-subagent agent never receives attribution it doesn't understand. This is the
 *    load-bearing half — the client's replayed message history can carry `subagentRunId`,
 *    and this is what protects the old agent from it.
 *  - agent → client (the event stream): defensive normalization. A genuinely pre-subagent
 *    agent cannot emit `SUBAGENT_*` events or `subagentRunId`, and any `RUN_STARTED.input`
 *    echo was already sanitized on the way in — so this path guards mixed/proxied
 *    pipelines rather than doing load-bearing translation. It drops
 *    SUBAGENT_STARTED/FINISHED/ERROR events and strips `subagentRunId` from every remaining
 *    event, from MESSAGES_SNAPSHOT messages, and from RUN_STARTED `input` messages.
 *
 * Scope: this removes the protocol-level `subagentRunId` field and the SUBAGENT_* event
 * types only. It does NOT recurse into opaque application payloads (`RAW.event`,
 * `CUSTOM.value`, `STATE_SNAPSHOT.snapshot`, `STATE_DELTA.delta`, activity `content`,
 * etc.). Non-lifecycle events a subagent produced (TEXT_MESSAGE_*, TOOL_CALL_*, ...) are
 * kept with their `subagentRunId` stripped, so they flatten into the parent thread — the
 * intended downgrade, since subagent separation cannot be represented to a consumer with
 * no concept of it.
 *
 * The subagent feature is purely additive, so this shim is a pure removal in both
 * directions; there is no field/event to translate (unlike 0.0.45's THINKING->REASONING).
 *
 * Who this actually fires for: `maxProtocolVersion` defaults to this library's own
 * version, which sits above every era threshold, so the shim is installed only for an
 * agent subclass that OVERRIDES the ceiling to declare an older backend. As of this
 * writing exactly ONE integration in this repository does:
 * `integrations/community/spring-ai/typescript/src/index.ts`, pinned at 0.0.39.
 *
 * An earlier version of this note claimed six, naming llama-index, pydantic-ai, ag2,
 * agno and crew-ai alongside it. That census was wrong, and three of those integrations
 * now carry tests asserting the opposite -- llama-index's `multimodal-passthrough`,
 * and crew-ai's and agno's `no-content-flattening`, each of which fails if the agent
 * starts pinning a ceiling again. Do not trust this paragraph either: it is a snapshot
 * of code that lives outside this package and nothing keeps it honest. Re-check with
 * `grep -rn "maxProtocolVersion\|maxVersion" integrations` before relying on it.
 *
 * Where the shim IS installed, the client → agent strip carries the weight: those
 * backends predate subagents, so a replayed history or a stored thread written by a
 * newer client must not deliver them attribution they cannot interpret. The
 * agent → client strip is the defensive counterpart described above.
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
      messages: (input.messages ?? []).map((message) => stripSubagentRunId(message)),
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
        const stripped = stripSubagentRunId(event);

        // MESSAGES_SNAPSHOT embeds a full message array.
        if (stripped.type === EventType.MESSAGES_SNAPSHOT) {
          const snapshot = stripped as BaseEvent & { messages?: MessageLike[] };
          if (Array.isArray(snapshot.messages)) {
            return { ...snapshot, messages: stripMessages(snapshot.messages) } as BaseEvent;
          }
        }

        // RUN_FINISHED's interrupt outcome attributes each interrupt to the subagent
        // that raised it (Interrupt.subagentRunId) — nested, so the shallow top-level
        // strip above never reaches it. A genuinely pre-subagent agent cannot emit it;
        // like the rest of this direction, this normalizes mixed/proxied pipelines so
        // no fragment of the subagent contract leaks without its lifecycle context.
        if (stripped.type === EventType.RUN_FINISHED) {
          const runFinished = stripped as BaseEvent & {
            outcome?: { type?: string; interrupts?: MessageLike[] };
          };
          if (runFinished.outcome && Array.isArray(runFinished.outcome.interrupts)) {
            return {
              ...runFinished,
              outcome: {
                ...runFinished.outcome,
                interrupts: runFinished.outcome.interrupts.map((interrupt) =>
                  stripSubagentRunId(interrupt),
                ),
              },
            } as BaseEvent;
          }
        }

        // RUN_STARTED may echo the run input, whose messages also carry subagentRunId.
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
