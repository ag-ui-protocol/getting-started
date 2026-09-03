import { BaseEvent, EventType, RunAgentInput } from "@ag-ui/core";
import { EventSchema, RunAgentInputSchema } from "@ag-ui/core/schemas";
import { z } from "zod/v4";
import { Observable, of, EMPTY } from "rxjs";
import { mergeMap } from "rxjs/operators";
import { type DebugLoggerInput, resolveDebugLogger } from "@/debug-logger";
import { literalValue, stripUnknown } from "./strip";

/**
 * An event whose `type` the protocol does not know.
 *
 * Between the transport and enforcement, the stream can carry these — that is
 * the point of running enforcement AFTER middleware, so a translator for a
 * deprecated event stays reachable once the event leaves the schema. A
 * middleware that wants to handle one deliberately checks with
 * {@link isRecognizedEvent}; whatever nothing handles is dropped, with a
 * warning, at the enforcement stage. The loose type never survives past
 * verification: subscribers and application code only ever see known events.
 */
export type UnrecognizedEvent = {
  type: string;
  [key: string]: unknown;
};

const KNOWN_EVENT_TYPES = new Set<string>(Object.values(EventType));

/** Narrows an event back to the known set at the enforcement boundary. */
export function isRecognizedEvent(event: BaseEvent | UnrecognizedEvent): event is BaseEvent {
  return KNOWN_EVENT_TYPES.has(event.type as string);
}

// type discriminator -> that event's generated schema, for targeted stripping.
const EVENT_SCHEMA_BY_TYPE = new Map<string, z.ZodType>(
  (EventSchema.options as z.ZodType[]).map((option) => {
    const shape = (option as unknown as { shape: Record<string, z.ZodType> }).shape;
    return [String(literalValue(shape.type)), option];
  }),
);

const suppressed = (): boolean =>
  typeof process !== "undefined" &&
  typeof process.env !== "undefined" &&
  Boolean(process.env.SUPPRESS_TRANSFORMATION_WARNINGS);

function warnDeviation(message: string): void {
  if (suppressed()) return;
  console.warn(`[ag-ui][enforce] ${message}`);
}

/**
 * The enforcement stage: sits after the middleware chain (and chunk
 * transformation) on every path — streaming, binary and in-memory alike —
 * and guarantees that nothing unrecognised survives to verification,
 * subscribers or application code.
 *
 * - An event whose type nothing translated is dropped, with a warning.
 * - Unknown properties and unrecognised union members on a known event are
 *   stripped, each with a warning naming its path.
 * - A malformed value on a field the protocol DOES describe stays fatal:
 *   the generated validator throws, and the run errors.
 */
export const enforceEvents =
  (debugLogger?: DebugLoggerInput) =>
  (source$: Observable<BaseEvent>): Observable<BaseEvent> => {
    const log = resolveDebugLogger(debugLogger);
    return source$.pipe(
      mergeMap((event) => {
        if (!isRecognizedEvent(event as BaseEvent | UnrecognizedEvent)) {
          warnDeviation(
            `Dropping unrecognised event '${String(event.type)}': no middleware translated it and the protocol does not describe it.`,
          );
          log?.event("ENFORCE", "Unrecognised event dropped:", event, {
            type: event.type,
          });
          return EMPTY;
        }
        const schema = EVENT_SCHEMA_BY_TYPE.get(event.type as string);
        if (schema === undefined) {
          // Unreachable while EventType and the union are generated from the
          // same schema; guarded so a future drift fails loudly.
          throw new Error(`No validator for recognised event type '${String(event.type)}'`);
        }
        const { value, stripped } = stripUnknown(event, schema);
        for (const path of stripped) {
          warnDeviation(
            `Removed unrecognised material at '${path}' on ${String(event.type)}. Nothing handled it; see DEPRECATIONS.md if it is a retired shape.`,
          );
        }
        // Malformed known fields are fatal, by design.
        return of(schema.parse(value) as BaseEvent);
      }),
    );
  };

/**
 * The outgoing half of the same boundary: checked immediately before
 * transmission. Unknown properties are stripped with a warning; a malformed
 * known field is fatal before a byte leaves the process.
 */
export function enforceOutgoingInput(input: RunAgentInput): RunAgentInput {
  const { value, stripped } = stripUnknown(input, RunAgentInputSchema as unknown as z.ZodType);
  for (const path of stripped) {
    warnDeviation(`Removed unrecognised material at '${path}' from the outgoing input.`);
  }
  return RunAgentInputSchema.parse(value) as RunAgentInput;
}
