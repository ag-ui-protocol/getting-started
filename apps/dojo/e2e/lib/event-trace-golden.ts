import type { TraceEvent } from "./event-trace-events";

type EventTraceShape = {
  readonly [journeyKey: string]: readonly TraceEvent[];
};

export type EventTraceDestination = {
  sourceUrl: string;
  journeyKey: string;
};

const destinations = new WeakMap<object, EventTraceDestination>();

export function defineEventTrace<const Golden extends EventTraceShape>(
  sourceUrl: string,
  golden: Golden,
): Golden {
  const defined: { [journeyKey: string]: readonly TraceEvent[] } = {};
  for (const [journeyKey, journey] of Object.entries(golden)) {
    const definedJourney = [...journey];
    destinations.set(definedJourney, { sourceUrl, journeyKey });
    defined[journeyKey] = definedJourney;
  }

  return defined as Golden;
}

export function getEventTraceDestination(
  journey: readonly TraceEvent[],
): EventTraceDestination | undefined {
  return destinations.get(journey);
}
