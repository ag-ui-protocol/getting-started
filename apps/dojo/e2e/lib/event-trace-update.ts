import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { format } from "prettier";
import type { TraceEvent } from "./event-trace-events";
import { getEventTraceDestination } from "./event-trace-golden";

export type EventTraceUpdateCandidate = {
  lane: string;
  sourceUrl: string;
  journeyKey: string;
  events: readonly TraceEvent[];
};

export type EventTraceUpdate = {
  sourceUrl: string;
  journeys: { readonly [journeyKey: string]: readonly TraceEvent[] };
};

type RenderEventTraceOptions = {
  exportName: string;
  importPath: string;
  reason: string;
  journeys: { readonly [journeyKey: string]: readonly TraceEvent[] };
};

type TraceComparison = {
  sourceUrl: string;
  journeyKey: string;
  leftLane: string;
  leftEvents: readonly TraceEvent[];
  rightLane: string;
  rightEvents: readonly TraceEvent[];
};

const MISSING_VALUE = Symbol("missing event trace value");
const MAX_RENDERED_VALUE_LENGTH = 180;

type Difference = {
  path: readonly (string | number)[];
  left: unknown | typeof MISSING_VALUE;
  right: unknown | typeof MISSING_VALUE;
};

function objectValue(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

function findFirstDifference(
  left: unknown,
  right: unknown,
  path: readonly (string | number)[],
): Difference | undefined {
  if (isDeepStrictEqual(left, right)) return undefined;

  if (Array.isArray(left) && Array.isArray(right)) {
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      if (index >= left.length) {
        return {
          path: [...path, index],
          left: MISSING_VALUE,
          right: right[index],
        };
      }
      if (index >= right.length) {
        return {
          path: [...path, index],
          left: left[index],
          right: MISSING_VALUE,
        };
      }

      const difference = findFirstDifference(left[index], right[index], [
        ...path,
        index,
      ]);
      if (difference) return difference;
    }
  }

  if (
    typeof left === "object" &&
    left !== null &&
    !Array.isArray(left) &&
    typeof right === "object" &&
    right !== null &&
    !Array.isArray(right)
  ) {
    const keys = [
      ...Object.keys(left),
      ...Object.keys(right).filter((key) => !Object.hasOwn(left, key)),
    ];

    for (const key of keys) {
      if (!Object.hasOwn(left, key)) {
        return {
          path: [...path, key],
          left: MISSING_VALUE,
          right: objectValue(right, key),
        };
      }
      if (!Object.hasOwn(right, key)) {
        return {
          path: [...path, key],
          left: objectValue(left, key),
          right: MISSING_VALUE,
        };
      }

      const difference = findFirstDifference(
        objectValue(left, key),
        objectValue(right, key),
        [...path, key],
      );
      if (difference) return difference;
    }
  }

  return { path, left, right };
}

function formatPath(path: readonly (string | number)[]) {
  return path
    .map((segment, index) => {
      if (typeof segment === "number") return `[${segment}]`;
      if (index === 0) return segment;
      return /^[A-Za-z_$][\w$]*$/.test(segment)
        ? `.${segment}`
        : `[${JSON.stringify(segment)}]`;
    })
    .join("");
}

function formatValue(value: unknown | typeof MISSING_VALUE) {
  if (value === MISSING_VALUE) return "<missing>";

  const serialized = JSON.stringify(value);
  const rendered = serialized ?? String(value);
  if (rendered.length <= MAX_RENDERED_VALUE_LENGTH) return rendered;

  const visible = rendered.slice(0, MAX_RENDERED_VALUE_LENGTH);
  return `${visible}… ${rendered.length - visible.length} chars omitted`;
}

function eventTypeCounts(events: readonly TraceEvent[]) {
  const counts = new Map<string, number>();
  for (const event of events) {
    counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  }
  return counts;
}

function formatEventTypeComparison(mismatch: TraceComparison) {
  const leftCounts = eventTypeCounts(mismatch.leftEvents);
  const rightCounts = eventTypeCounts(mismatch.rightEvents);
  const types = [
    ...new Set([...leftCounts.keys(), ...rightCounts.keys()]),
  ].sort((left, right) => left.localeCompare(right));
  const differingTypes = types.filter(
    (type) => (leftCounts.get(type) ?? 0) !== (rightCounts.get(type) ?? 0),
  );

  if (differingTypes.length === 0) {
    const typeWord = types.length === 1 ? "type" : "types";
    return `event type counts: identical across ${types.length} ${typeWord}`;
  }

  return [
    "event type differences:",
    ...differingTypes.map(
      (type) =>
        `    ${type}: ${mismatch.leftLane}=${leftCounts.get(type) ?? 0}, ${mismatch.rightLane}=${rightCounts.get(type) ?? 0}`,
    ),
  ].join("\n");
}

function formatDestination(sourceUrl: string) {
  try {
    const path = fileURLToPath(sourceUrl);
    const testsMarker = `${sep}tests${sep}`;
    const testsIndex = path.lastIndexOf(testsMarker);
    if (testsIndex !== -1) {
      return path
        .slice(testsIndex + 1)
        .split(sep)
        .join("/");
    }
  } catch {
    // Non-file destinations are already the most useful representation.
  }
  return sourceUrl;
}

function firstDifferentEventIndex(
  left: readonly TraceEvent[],
  right: readonly TraceEvent[],
) {
  const commonLength = Math.min(left.length, right.length);
  for (let index = 0; index < commonLength; index += 1) {
    if (!isDeepStrictEqual(left[index], right[index])) return index;
  }
  return commonLength;
}

export class EventTraceAssertionError extends Error {
  constructor(options: {
    actual: readonly TraceEvent[];
    expected: readonly TraceEvent[];
  }) {
    const destination = getEventTraceDestination(options.expected);
    const label = destination
      ? `${formatDestination(destination.sourceUrl)}#${destination.journeyKey}`
      : "<event trace>";
    const mismatch: TraceComparison = {
      sourceUrl: destination?.sourceUrl ?? label,
      journeyKey: destination?.journeyKey ?? "<unknown journey>",
      leftLane: "expected",
      leftEvents: options.expected,
      rightLane: "actual",
      rightEvents: options.actual,
    };
    const eventIndex = firstDifferentEventIndex(
      options.expected,
      options.actual,
    );
    const expectedType = options.expected[eventIndex]?.type ?? "<end>";
    const actualType = options.actual[eventIndex]?.type ?? "<end>";
    const difference = findFirstDifference(options.expected, options.actual, [
      "events",
    ]);

    super(
      [
        `Event trace mismatch: ${label}`,
        `  events: expected=${options.expected.length}, actual=${options.actual.length}`,
        `  ${formatEventTypeComparison(mismatch)}`,
        `  event ${eventIndex}: expected ${expectedType}, actual ${actualType}`,
        `  first difference: ${formatPath(difference?.path ?? ["events"])}`,
        `    expected: ${formatValue(difference?.left)}`,
        `    actual: ${formatValue(difference?.right)}`,
        "  Full traces are attached to the Playwright test result.",
      ].join("\n"),
    );
    this.name = "EventTraceAssertionError";
  }
}

export function assertEventTraceMatches(
  actual: readonly TraceEvent[],
  expected: readonly TraceEvent[],
) {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new EventTraceAssertionError({ actual, expected });
  }
}

export function createEventTraceUpdateCandidate(options: {
  lane: string;
  expected: readonly TraceEvent[];
  actual: readonly TraceEvent[];
}): EventTraceUpdateCandidate {
  const destination = getEventTraceDestination(options.expected);
  if (!destination) {
    throw new Error(
      "Update mode requires a journey created by defineEventTrace",
    );
  }

  return {
    lane: options.lane,
    sourceUrl: destination.sourceUrl,
    journeyKey: destination.journeyKey,
    events: options.actual,
  };
}

export async function writeEventTraceUpdateCandidate(options: {
  stagingDirectory: string;
  testId: string;
  candidate: EventTraceUpdateCandidate;
}) {
  if (!/^[A-Za-z0-9_-]+$/.test(options.candidate.lane)) {
    throw new Error(
      `Invalid Event trace update lane: ${options.candidate.lane}`,
    );
  }

  const laneDirectory = join(options.stagingDirectory, options.candidate.lane);
  await mkdir(laneDirectory, { recursive: true });

  const digest = createHash("sha256")
    .update(options.candidate.sourceUrl)
    .update("\0")
    .update(options.candidate.journeyKey)
    .update("\0")
    .update(options.testId)
    .digest("hex");

  await writeFile(
    join(laneDirectory, `${digest}.json`),
    `${JSON.stringify(options.candidate, null, 2)}\n`,
    "utf8",
  );
}

export function planEventTraceUpdates(
  candidates: readonly EventTraceUpdateCandidate[],
): EventTraceUpdate[] {
  const byDestination = new Map<string, EventTraceUpdateCandidate>();

  for (const candidate of candidates) {
    const destination = `${candidate.sourceUrl}\0${candidate.journeyKey}`;
    const existing = byDestination.get(destination);
    if (existing) {
      throw new Error(
        `Duplicate Event trace candidates for ${candidate.sourceUrl}#${candidate.journeyKey}: ${existing.lane} and ${candidate.lane}`,
      );
    }
    byDestination.set(destination, candidate);
  }

  const bySource = new Map<
    string,
    { [journeyKey: string]: readonly TraceEvent[] }
  >();

  const orderedCandidates = [...byDestination.values()].sort((left, right) => {
    return (
      left.sourceUrl.localeCompare(right.sourceUrl) ||
      left.journeyKey.localeCompare(right.journeyKey)
    );
  });

  for (const candidate of orderedCandidates) {
    const journeys = bySource.get(candidate.sourceUrl) ?? {};
    journeys[candidate.journeyKey] = candidate.events;
    bySource.set(candidate.sourceUrl, journeys);
  }

  return [...bySource.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sourceUrl, journeys]) => ({
      sourceUrl,
      journeys: Object.fromEntries(
        Object.entries(journeys).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    }));
}

export function summarizeEventTraceDiff(
  previous: { readonly [journeyKey: string]: readonly TraceEvent[] },
  next: { readonly [journeyKey: string]: readonly TraceEvent[] },
) {
  const summaries: string[] = [];
  const journeyKeys = new Set([...Object.keys(previous), ...Object.keys(next)]);

  for (const journeyKey of [...journeyKeys].sort()) {
    const previousEvents = previous[journeyKey];
    const nextEvents = next[journeyKey];
    if (!previousEvents) {
      summaries.push(`${journeyKey}: added ${nextEvents?.length ?? 0} events`);
      continue;
    }
    if (!nextEvents) {
      summaries.push(`${journeyKey}: removed ${previousEvents.length} events`);
      continue;
    }
    if (isDeepStrictEqual(previousEvents, nextEvents)) continue;

    const difference = findFirstDifference(previousEvents, nextEvents, [
      "events",
    ]);
    summaries.push(
      `${journeyKey}: ${previousEvents.length} -> ${nextEvents.length} events; first difference at ${formatPath(
        difference?.path ?? ["events"],
      )}: ${formatValue(difference?.left)} -> ${formatValue(difference?.right)}`,
    );
  }

  return summaries;
}

function propertyName(key: string) {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
}

type StructuralValue = readonly unknown[] | { readonly [key: string]: unknown };

type SharedStructure = {
  key: string;
  value: StructuralValue;
  count: number;
  size: number;
  descendantKeys: ReadonlySet<string>;
};

const MIN_SHARED_STRUCTURE_SIZE = 80;

function isStructuralValue(value: unknown): value is StructuralValue {
  return typeof value === "object" && value !== null;
}

function structuralKey(value: StructuralValue) {
  return JSON.stringify(value);
}

function collectDescendantKeys(value: StructuralValue) {
  const keys = new Set<string>();

  const visit = (child: unknown) => {
    if (!isStructuralValue(child)) return;
    keys.add(structuralKey(child));
    for (const nested of Array.isArray(child) ? child : Object.values(child)) {
      visit(nested);
    }
  };

  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    visit(child);
  }
  return keys;
}

function findSharedStructures(journeys: {
  readonly [journeyKey: string]: readonly TraceEvent[];
}) {
  const structures = new Map<
    string,
    { value: StructuralValue; count: number }
  >();

  const visit = (value: unknown) => {
    if (!isStructuralValue(value)) return;
    const key = structuralKey(value);
    const existing = structures.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      structures.set(key, { value, count: 1 });
    }

    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      visit(child);
    }
  };

  for (const events of Object.values(journeys)) visit(events);

  const candidates: SharedStructure[] = [...structures.entries()]
    .filter(
      ([key, structure]) =>
        structure.count > 1 &&
        key.length >= MIN_SHARED_STRUCTURE_SIZE &&
        (structure.count - 1) * key.length > MIN_SHARED_STRUCTURE_SIZE,
    )
    .map(([key, structure]) => ({
      key,
      value: structure.value,
      count: structure.count,
      size: key.length,
      descendantKeys: collectDescendantKeys(structure.value),
    }))
    .sort(
      (left, right) =>
        right.size - left.size ||
        right.count - left.count ||
        left.key.localeCompare(right.key),
    );

  const selected: SharedStructure[] = [];
  for (const candidate of candidates) {
    if (selected.some((parent) => parent.descendantKeys.has(candidate.key))) {
      continue;
    }
    selected.push(candidate);
  }
  return selected;
}

function indent(level: number) {
  return "  ".repeat(level);
}

function renderTraceValue(
  value: unknown,
  level: number,
  sharedNames: ReadonlyMap<string, string>,
  inlineKey?: string,
): string {
  if (isStructuralValue(value)) {
    const key = structuralKey(value);
    const sharedName = sharedNames.get(key);
    if (sharedName && key !== inlineKey) return sharedName;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map(
      (item) =>
        `${indent(level + 1)}${renderTraceValue(item, level + 1, sharedNames)}`,
    );
    return `[\n${items.join(",\n")}\n${indent(level)}]`;
  }

  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    const properties = entries.map(
      ([key, child]) =>
        `${indent(level + 1)}${JSON.stringify(key)}: ${renderTraceValue(child, level + 1, sharedNames)}`,
    );
    return `{\n${properties.join(",\n")}\n${indent(level)}}`;
  }

  return JSON.stringify(value) ?? String(value);
}

export async function renderEventTraceModule(options: RenderEventTraceOptions) {
  if (!/^[A-Za-z_$][\w$]*$/.test(options.exportName)) {
    throw new Error(`Invalid Event trace export name: ${options.exportName}`);
  }

  const reason = options.reason.replaceAll(/\s+/g, " ").trim();
  if (!reason) throw new Error("Event trace updates require a reason");

  const sharedStructures = findSharedStructures(options.journeys);
  const sharedNames = new Map(
    sharedStructures.map((structure, index) => [
      structure.key,
      `shared${index + 1}`,
    ]),
  );
  const sharedDeclarations = sharedStructures.map((structure) => {
    const name = sharedNames.get(structure.key);
    return `const ${name} = ${renderTraceValue(
      structure.value,
      0,
      sharedNames,
      structure.key,
    )} as const;`;
  });

  const journeys = Object.entries(options.journeys)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([journeyKey, events]) => {
      return `  ${propertyName(journeyKey)}: ${renderTraceValue(
        events,
        1,
        sharedNames,
      )},`;
    })
    .join("\n");

  const source = [
    `import { defineEventTrace } from ${JSON.stringify(options.importPath)};`,
    "",
    "// Generated by the event trace updater.",
    `// Reason: ${reason}`,
    "// Before accepting changes, verify whether the implementation regressed.",
    ...sharedDeclarations,
    ...(sharedDeclarations.length === 0 ? [] : [""]),
    `export const ${options.exportName} = defineEventTrace(import.meta.url, {`,
    journeys,
    "});",
    "",
  ].join("\n");

  return format(source, { parser: "typescript" });
}
