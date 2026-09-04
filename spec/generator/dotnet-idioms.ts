/**
 * The .NET idiom tables both C# emitters read.
 *
 * AGUI.Abstractions decides how a property is DECLARED (nullable or not, under
 * which name) and AGUI.Protobuf's mappers decide how it is CARRIED; the two
 * emitters sit on opposite sides of the same decision, so they have to read the
 * same table. Kept apart, a divergence is invisible: the mapper would stop
 * naming a missing value (RequireProvided) and let the PROTOBUF message's
 * setter — the .NET model property is a plain auto-property that accepts null —
 * raise the bare ArgumentNullException these tables exist to prevent, and
 * generation would still succeed.
 */

/** Field -> .NET property name, where PascalCase is not the property's name. */
export const PROP_NAME: Record<string, string> = {
  "RunAgentInput.forwardedProps": "ForwardedProperties",
};

/**
 * Required wire strings whose .NET property is nullable rather than an empty
 * default, so a field the producer never set stays distinguishable from one set
 * to "". Encoding one that is still null is a mistake worth naming, which the
 * protobuf mapper's RequireProvided does — the setter would otherwise raise a
 * bare ArgumentNullException about "value" — and the client's own
 * RequireProvided reads them the same way.
 *
 * The three subagent events declare their required strings this way; the older
 * events predate the choice and keep the empty default.
 */
export const NULLABLE_REQUIRED_STRINGS = new Set([
  "SubagentStartedEvent.subagentRunId",
  "SubagentStartedEvent.name",
  "SubagentFinishedEvent.subagentRunId",
  "SubagentErrorEvent.subagentRunId",
  "SubagentErrorEvent.message",
]);

/**
 * Required arbitrary-JSON fields whose .NET model property is nullable
 * (JsonElement?) rather than a bare JsonElement.
 */
export const NULLABLE_REQUIRED_ANY = new Set(["CustomEvent.value"]);
