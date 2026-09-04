import type { TokenUsage } from "./generated/types";

/** The AG-UI names of the five token counts, in the order an entry lists them. */
const COUNT_KEYS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "reasoningTokens",
  "cachedInputTokens",
] as const;

/**
 * The count keys already warned about, so the diagnostic below fires once per
 * process per key rather than once per event. A provider that hands over a
 * string count hands one over on every call, and a per-call warning would bury
 * the stream it is meant to annotate.
 */
const warnedCountKeys = new Set<string>();

/** What the value WAS, said in a way that points at the provider's bug. */
const describeRejected = (v: unknown): string => {
  if (v === null) return "null";
  if (typeof v === "string") return `${JSON.stringify(v)} (a string)`;
  if (typeof v === "number") return `${String(v)} (a non-finite number)`;
  if (typeof v === "object") return `an object`;
  return `${String(v)} (a ${typeof v})`;
};

/**
 * Accept a value only if it is a real, finite number.
 *
 * Shared by both vendor mappers so they guard identically. Providers do hand
 * over strings, `null`s and `NaN`s in their usage metadata, and a bad value must
 * not reach the wire: consumers validate every incoming event and throw on
 * failure, so one malformed count would fail an otherwise-successful run at its
 * final event — costing the user the answer, not just the token count.
 *
 * Dropping it is right; dropping it in silence is not. The usage this run
 * reports is then simply wrong, with nothing anywhere saying which count went
 * missing or why, so a present-but-unusable value is named once per key.
 *
 * `undefined` and `NaN` are exempt because they are not defects: they are how a
 * provider spells "did not report this count". `undefined` covers both shapes —
 * an absent key in LangChain's `usage_metadata`, an explicit `undefined` in
 * AI-SDK's `LanguageModelUsage` — and AI-SDK uses `NaN` for the same thing,
 * which is why its mapper's docstring says so. Warning on those would fire on
 * ordinary traffic and train the reader to ignore the message.
 *
 * `key` is the AG-UI count name the value was headed for, not the vendor's
 * spelling of it, so one message reads the same whichever mapper produced it.
 */
const num = (v: unknown, key: (typeof COUNT_KEYS)[number]): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const isAbsent = v === undefined || (typeof v === "number" && Number.isNaN(v));
  if (!isAbsent && !warnedCountKeys.has(key)) {
    warnedCountKeys.add(key);
    console.warn(
      `[ag-ui] usage.${key} was ${describeRejected(v)}, not a number — omitted from this run's usage. Reported once per key.`,
    );
  }
  return undefined;
};

/**
 * Read a property from a value of unknown shape, yielding `undefined` for
 * anything that is not an object. Lets the mappers take `unknown` rather than
 * `any` — vendor payloads are untrusted, so every access should be narrowed
 * rather than assumed.
 */
const prop = (v: unknown, key: string): unknown =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>)[key] : undefined;

/**
 * Build a {@link TokenUsage} from already-guarded counts, or `undefined` when no
 * count survived. Returning `undefined` rather than a labels-only entry keeps
 * "the provider reported no usage" distinct from "the provider reported usage",
 * so callers omit the field instead of emitting an entry that claims nothing.
 */
function buildEntry(
  counts: Partial<Record<(typeof COUNT_KEYS)[number], number | undefined>>,
  { provider, model }: { provider?: string; model?: string },
): TokenUsage | undefined {
  if (!COUNT_KEYS.some((key) => counts[key] !== undefined)) return undefined;

  const entry: TokenUsage = {};
  if (provider != null) entry.provider = provider;
  if (model != null) entry.model = model;
  for (const key of COUNT_KEYS) {
    const value = counts[key];
    if (value !== undefined) entry[key] = value;
  }
  return entry;
}

/**
 * Map a LangChain-family `usage_metadata` object into an AG-UI {@link TokenUsage}.
 *
 * LangChain and LangGraph both attach usage as `{ input_tokens, output_tokens,
 * total_tokens, input_token_details: { cache_read }, output_token_details:
 * { reasoning } }`. This maps only those numeric counts plus optional
 * provider/model labels — never prompt/completion content. A count the provider
 * did not return is simply absent from `usage_metadata` and reads as
 * `undefined` here; that is not a defect and draws no warning. Returns
 * `undefined` when no usable count is present, so callers can omit usage rather
 * than report zeros.
 */
export function tokenUsageFromLangChainMetadata(
  usageMetadata: unknown,
  { provider, model }: { provider?: string; model?: string },
): TokenUsage | undefined {
  if (!usageMetadata) return undefined;

  const inputDetails = prop(usageMetadata, "input_token_details");
  const outputDetails = prop(usageMetadata, "output_token_details");

  return buildEntry(
    {
      inputTokens: num(prop(usageMetadata, "input_tokens"), "inputTokens"),
      outputTokens: num(prop(usageMetadata, "output_tokens"), "outputTokens"),
      totalTokens: num(prop(usageMetadata, "total_tokens"), "totalTokens"),
      reasoningTokens: num(prop(outputDetails, "reasoning"), "reasoningTokens"),
      cachedInputTokens: num(prop(inputDetails, "cache_read"), "cachedInputTokens"),
    },
    { provider, model },
  );
}

/**
 * Map an AI-SDK (v5) `LanguageModelUsage` object into an AG-UI {@link TokenUsage}.
 *
 * AI-SDK's keys already match: `inputTokens`, `outputTokens`, `totalTokens`,
 * `reasoningTokens`, `cachedInputTokens`. AI-SDK reports `NaN`/`undefined` for
 * counts a provider didn't return, so only finite numbers are copied. Returns
 * `undefined` when no finite count is present (so callers omit empty usage).
 */
export function tokenUsageFromAiSdkUsage(
  usage: unknown,
  { provider, model }: { provider?: string; model?: string },
): TokenUsage | undefined {
  if (!usage) return undefined;

  return buildEntry(
    {
      inputTokens: num(prop(usage, "inputTokens"), "inputTokens"),
      outputTokens: num(prop(usage, "outputTokens"), "outputTokens"),
      totalTokens: num(prop(usage, "totalTokens"), "totalTokens"),
      reasoningTokens: num(prop(usage, "reasoningTokens"), "reasoningTokens"),
      cachedInputTokens: num(prop(usage, "cachedInputTokens"), "cachedInputTokens"),
    },
    { provider, model },
  );
}

/**
 * Sum per-call {@link TokenUsage} entries into one entry per `(provider, model)`
 * pair. Order follows first appearance. A count field stays `undefined` when no
 * member of the group reported it, so "not reported" stays distinct from zero.
 *
 * Protocol-agnostic: works on any producer's `TokenUsage[]`, so integrations
 * share it rather than reimplementing aggregation.
 */
export function aggregateTokenUsage(entries: TokenUsage[]): TokenUsage[] {
  const grouped = new Map<string, TokenUsage>();

  for (const entry of entries) {
    const key = `${entry.provider ?? ""} ${entry.model ?? ""}`;
    let target = grouped.get(key);
    if (!target) {
      target = { provider: entry.provider, model: entry.model };
      grouped.set(key, target);
    }
    for (const field of COUNT_KEYS) {
      const value = entry[field];
      if (value == null) continue;
      target[field] = (target[field] ?? 0) + value;
    }
  }

  return [...grouped.values()];
}
