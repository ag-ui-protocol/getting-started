/**
 * A2UI error-recovery loop (OSS-162).
 *
 * Framework-agnostic: the toolkit cannot bind/invoke a model, so the adapter
 * supplies an `invokeSubagent` closure (its framework-specific model call) and a
 * `buildEnvelope` closure (its prepared create/update context). This module owns
 * the loop: invoke → validate (shared `validateA2UIComponents`) → on failure feed
 * the structured errors back into the prompt and retry, up to `maxAttempts`.
 *
 * The SAME validator gates the middleware's paint decision, so the tool's retry
 * decision and the middleware's suppress decision can never disagree.
 */
import {
  validateA2UIComponents,
  type A2UIValidationCatalog,
  type A2UIValidationError,
} from "./validate";

/** Default attempt cap (initial try + retries). Configurable per call. */
export const MAX_A2UI_ATTEMPTS = 3;

/** Activity type the middleware/client use for the recovery status channel. */
export const A2UI_RECOVERY_ACTIVITY_TYPE = "a2ui_recovery";

/**
 * Developer-configurable recovery surface (Tyler's requirement). The threshold
 * is behavioral, not a hardcoded number: `showRetryUIAfter` lets the host decide
 * when the "Retrying…" status becomes perceptible enough to show.
 */
export interface A2UIRecoveryConfig {
  /** Attempt cap (initial + retries). Default `MAX_A2UI_ATTEMPTS`. */
  maxAttempts?: number;
  /** When the (client-side) "Retrying UI generation…" status may appear. */
  showRetryUIAfter?: { ms?: number; attempts?: number };
  // NOTE: debugExposure is NOT here — how much retry/error detail the renderer
  // surfaces is a presentation concern configured server-side via the
  // A2UIMiddleware's `recovery.debugExposure` (stamped into the a2ui_recovery
  // activity), not on this generation-loop config. (OSS-162)
}

/** One attempt's outcome — surfaced to the adapter via `onAttempt` for status + dev traces. */
export interface A2UIAttemptRecord {
  /** 1-based attempt number. */
  attempt: number;
  ok: boolean;
  errors: A2UIValidationError[];
}

export interface RunA2UIRecoveryInput {
  /** The prepared sub-agent system prompt (output of `prepareA2UIRequest`). */
  basePrompt: string;
  /** Inline catalog for semantic validation; omit for structural-only. */
  catalog?: A2UIValidationCatalog;
  config?: A2UIRecoveryConfig;
  /**
   * Run the sub-agent once with `prompt` (already augmented with prior errors on
   * retries) and return its `render_a2ui` args `{surfaceId, components, data}`,
   * or `null` if the model produced no tool call.
   */
  invokeSubagent: (prompt: string, attempt: number) => Promise<Record<string, unknown> | null>;
  /** Turn validated `render_a2ui` args into the final operations envelope. */
  buildEnvelope: (args: Record<string, unknown>) => string;
  /** Per-attempt callback for emitting recovery status + dev logs. */
  onAttempt?: (record: A2UIAttemptRecord) => void;
}

export interface RunA2UIRecoveryResult {
  /** Either the validated operations envelope, or a structured hard-failure envelope. */
  envelope: string;
  attempts: A2UIAttemptRecord[];
  ok: boolean;
}

/** Render structured errors as a compact, model-readable list. */
export function formatValidationErrors(errors: A2UIValidationError[]): string {
  return errors.map((e) => `- [${e.code}] ${e.path}: ${e.message}`).join("\n");
}

/** Append a fix-it block describing the prior attempt's errors. No-op when there are none. */
export function augmentPromptWithValidationErrors(prompt: string, errors: A2UIValidationError[]): string {
  if (!errors.length) return prompt;
  return (
    `${prompt}\n\n## Previous attempt was invalid — fix these and regenerate:\n` +
    `${formatValidationErrors(errors)}\n`
  );
}

const NO_TOOL_CALL_ERROR: A2UIValidationError = {
  code: "empty_components",
  path: "components",
  message: "Sub-agent did not call render_a2ui",
};

/** Wrap an exhausted-recovery hard failure as the JSON envelope the middleware recognises. */
function wrapRecoveryExhaustedEnvelope(maxAttempts: number, attempts: A2UIAttemptRecord[]): string {
  return JSON.stringify({
    error: `Failed to generate valid A2UI after ${maxAttempts} attempt(s)`,
    code: "a2ui_recovery_exhausted",
    attempts,
  });
}

/**
 * Drive the validate→retry loop. Returns the validated envelope on success, or a
 * structured `a2ui_recovery_exhausted` envelope once the cap is hit. Never retries
 * an attempt whose components validated (the adapter must commit it).
 */
export async function runA2UIGenerationWithRecovery(
  input: RunA2UIRecoveryInput,
): Promise<RunA2UIRecoveryResult> {
  const maxAttempts = input.config?.maxAttempts ?? MAX_A2UI_ATTEMPTS;
  const attempts: A2UIAttemptRecord[] = [];
  let lastErrors: A2UIValidationError[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const prompt = augmentPromptWithValidationErrors(input.basePrompt, lastErrors);
    const args = await input.invokeSubagent(prompt, attempt);

    if (!args) {
      const record: A2UIAttemptRecord = { attempt, ok: false, errors: [NO_TOOL_CALL_ERROR] };
      attempts.push(record);
      input.onAttempt?.(record);
      lastErrors = record.errors;
      continue;
    }

    const components = Array.isArray(args.components) ? (args.components as Array<Record<string, unknown>>) : [];
    const data =
      args.data && typeof args.data === "object" && !Array.isArray(args.data)
        ? (args.data as Record<string, unknown>)
        : {};
    const result = validateA2UIComponents({ components, data, catalog: input.catalog });
    const record: A2UIAttemptRecord = { attempt, ok: result.valid, errors: result.errors };
    attempts.push(record);
    input.onAttempt?.(record);

    if (result.valid) {
      return { envelope: input.buildEnvelope(args), attempts, ok: true };
    }
    lastErrors = result.errors;
  }

  return { envelope: wrapRecoveryExhaustedEnvelope(maxAttempts, attempts), attempts, ok: false };
}
