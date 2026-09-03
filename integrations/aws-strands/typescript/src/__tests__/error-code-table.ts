/**
 * The shared `error-codes.json` table, read by this bridge's suites.
 *
 * One table, two runtimes: `../../../error-codes.json` holds the codes and the
 * message text for both bridges, and the Python suite reads the same file
 * through `tests/error_code_table.py`. A terminal-path test drives the real
 * agent or endpoint to a failure and asserts the emitted frame against the
 * entry here, so a code the table marks shared carries the same text on both
 * sides because both sides are matched against this one copy of it.
 *
 * Templates render every interpolated value as `{}`. `matchesTemplate` turns
 * one into a pattern so the literal text around the interpolations is compared
 * character for character, which is what a client matching literally depends
 * on.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";

import { EventType, type BaseEvent } from "@ag-ui/core";

export type Side = "python" | "typescript";

export interface CodeEntry {
  code: string;
  sides: Side[];
  messages: string[];
  sideOnlyMessages?: Partial<Record<Side, string[]>>;
  note?: string;
}

export interface ErrorCodeTable {
  codes: CodeEntry[];
  sharedMessageConstants: Record<string, string>;
}

export const SIDE: Side = "typescript";

export const TABLE_PATH = path.resolve(__dirname, "../../../error-codes.json");

export const TABLE: ErrorCodeTable = JSON.parse(
  readFileSync(TABLE_PATH, "utf8"),
);

export const CODES = new Map<string, CodeEntry>(
  TABLE.codes.map((entry) => [entry.code, entry]),
);

export const FORCE_STOP_FALLBACK: string =
  TABLE.sharedMessageConstants.forceStopFallback;

/** Every message text this side may emit under `code`. */
export function templatesFor(code: string): string[] {
  const entry = CODES.get(code);
  if (!entry) throw new Error(`${code} is not listed in error-codes.json`);
  return [...entry.messages, ...(entry.sideOnlyMessages?.[SIDE] ?? [])];
}

/** Whether `message` is `template` with its `{}` slots filled in. */
export function matchesTemplate(template: string, message: string): boolean {
  const pattern = template
    .split("{}")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\s\\S]*");
  return new RegExp(`^${pattern}$`).test(message);
}

type RunError = BaseEvent & { code?: string; message?: string };

/** Assert a RUN_ERROR carries `code` and text the table allows for this side. */
export function expectContractError(event: BaseEvent, code: string): void {
  const error = event as RunError;
  expect(error.type).toBe(EventType.RUN_ERROR);
  expect(error.code).toBe(code);
  const templates = templatesFor(code);
  const matched = templates.some((template) =>
    matchesTemplate(template, error.message ?? ""),
  );
  expect(
    matched,
    `${code} emitted ${JSON.stringify(error.message)}, which matches none of ` +
      `the message templates recorded for ${SIDE} in error-codes.json: ` +
      JSON.stringify(templates),
  ).toBe(true);
}

/** The RUN_ERRORs in `events`, each pinned to the codes given, in order. */
export function expectContractErrors(
  events: BaseEvent[],
  codes: string[],
): void {
  const errors = events.filter((e) => e.type === EventType.RUN_ERROR);
  expect(errors.map((e) => (e as RunError).code)).toEqual(codes);
  errors.forEach((error, index) => expectContractError(error, codes[index]));
}
