import type { Interrupt as LangGraphInterrupt } from "@langchain/langgraph-sdk";
import type {
  Interrupt as AGUIInterrupt,
  ResumeEntry,
  RunAgentInput,
} from "@ag-ui/core";

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function langGraphInterruptToAGUI(
  lg: LangGraphInterrupt,
): AGUIInterrupt {
  const raw = lg.value;
  const dict = isPlainObject(raw) ? raw : null;

  if (!lg.id) {
    throw new Error(
      "LangGraph Interrupt is missing `id`. The id is required to match a " +
        "resume answer back to the originating step; synthesising an id here " +
        "would silently misroute multi-interrupt resumes. Upgrade to " +
        "@langchain/langgraph-sdk that always populates Interrupt.id.",
    );
  }
  const id = lg.id;
  const reason =
    (dict?.reason as string | undefined) ?? "langgraph:interrupt";

  const message =
    typeof raw === "string"
      ? raw
      : (dict?.message as string | undefined);
  const toolCallId =
    (dict?.toolCallId as string | undefined) ??
    (dict?.tool_call_id as string | undefined);
  const responseSchema =
    (dict?.responseSchema as Record<string, unknown> | undefined) ??
    (dict?.response_schema as Record<string, unknown> | undefined);
  const expiresAt =
    (dict?.expiresAt as string | undefined) ??
    (dict?.expires_at as string | undefined);

  const metadata: Record<string, unknown> = {
    langgraph: {
      raw,
      ns: (lg as { ns?: string[] }).ns,
      resumable: (lg as { resumable?: boolean }).resumable,
      when: (lg as { when?: string }).when,
    },
  };

  return {
    id,
    reason,
    ...(message !== undefined ? { message } : {}),
    ...(toolCallId !== undefined ? { toolCallId } : {}),
    ...(responseSchema !== undefined ? { responseSchema } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    metadata,
  };
}

export function langGraphInterruptsToAGUI(
  list: readonly LangGraphInterrupt[],
): AGUIInterrupt[] {
  return list.map(langGraphInterruptToAGUI);
}

/**
 * Detect whether a run is a *legacy* resume — i.e. the caller is resuming a
 * LangGraph interrupt via the deprecated `forwardedProps.command.resume`
 * channel and has NOT populated the canonical `RunAgentInput.resume[]`.
 *
 * Released clients (e.g. CopilotKit's `useLangGraphInterrupt`) still resume
 * this way. When the integration emits `RUN_FINISHED.outcome=interrupt`
 * (`emitInterruptOutcome` enabled, or `enableLegacyOnInterruptEvent` off — which
 * forces the outcome), `AbstractAgent` records `pendingInterrupts`, and the base
 * `onInitialize` lifecycle would otherwise reject the legacy resume run with
 * "pending interrupt(s) not addressed by resume" — a regression for every such
 * legacy client. See `reconcileLegacyResumeInterrupts`. (With the default
 * config no outcome is emitted, `pendingInterrupts` stays empty, and the bridge
 * is a no-op.)
 */
export function isLegacyCommandResume(input: RunAgentInput): boolean {
  const legacyResume = (input.forwardedProps as Record<string, any> | undefined)
    ?.command?.resume;
  const hasAguiResume =
    Array.isArray(input.resume) && input.resume.length > 0;
  return legacyResume !== undefined && !hasAguiResume;
}

/**
 * Back-compat bridge invoked from `onInitialize` before the base lifecycle
 * runs. When a run is a legacy `command.resume` resume (see
 * `isLegacyCommandResume`), drop the agent's tracked `pendingInterrupts` so the
 * base "uncovered interrupt" guard does not reject it. The legacy resume is
 * carried through `forwardedProps.command.resume` and resolved by
 * `runAgentStream` exactly as it was before structured interrupts existed, so
 * the tracked list is not needed for this run.
 *
 * Note: this intentionally also bypasses the base lifecycle's interrupt-expiry
 * check for legacy resumes — the legacy `command.resume` channel never enforced
 * expiry (the graph resolves the resume itself), so this preserves pre-existing
 * behavior rather than introducing a new gap.
 */
export function reconcileLegacyResumeInterrupts(
  agent: { pendingInterrupts: AGUIInterrupt[] },
  input: RunAgentInput,
): void {
  if (agent.pendingInterrupts.length > 0 && isLegacyCommandResume(input)) {
    agent.pendingInterrupts = [];
  }
}

export const DEFAULT_RESUME_SENTINEL_CANCELLED = "__agui_cancelled__";
export const DEFAULT_RESUME_SENTINEL_MAP = "__agui_resume_map__";

export function buildLgCommandResumeFromAgui(
  entries: readonly ResumeEntry[],
): unknown {
  if (entries.length === 1) {
    const e = entries[0];
    if (e.status === "resolved") return e.payload;
    return { [DEFAULT_RESUME_SENTINEL_CANCELLED]: true, interrupt_id: e.interruptId };
  }
  return {
    [DEFAULT_RESUME_SENTINEL_MAP]: Object.fromEntries(
      entries.map((e) => [
        e.interruptId,
        { status: e.status, payload: e.payload ?? null },
      ]),
    ),
  };
}
