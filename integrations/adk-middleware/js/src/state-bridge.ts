import type { RunAgentInput } from "@ag-ui/core";
import type { Session } from "@google/adk";

import {
  AG_UI_CONTEXT_KEY,
  AG_UI_FORWARDED_PROPS_KEY,
  AG_UI_INTERNAL_STATE_KEYS,
  AG_UI_STATE_KEY,
  AG_UI_STATE_KEYS_KEY,
  isAdkSpecialStateKey,
} from "./constants";
import { ADKJSProtocolError } from "./errors";
import { clone, isRecord } from "./value-utils";

function validatePublicStateKey(key: string): void {
  if (AG_UI_INTERNAL_STATE_KEYS.has(key)) {
    throw new ADKJSProtocolError(
      `AG-UI state key ${key} is reserved by @ag-ui/adk-js.`,
      "RESERVED_STATE_KEY",
    );
  }
  if (isAdkSpecialStateKey(key)) {
    throw new ADKJSProtocolError(
      `AG-UI state key ${key} uses a reserved Google ADK app:, user:, or temp: scope.`,
      "RESERVED_STATE_SCOPE",
    );
  }
}

function publicKeys(state: Record<string, unknown>): string[] {
  const manifest = state[AG_UI_STATE_KEYS_KEY];
  if (
    Array.isArray(manifest) &&
    manifest.every((key): key is string => typeof key === "string")
  ) {
    return manifest;
  }
  // A session without a manifest may have been created by the application or
  // by an older integration. Its ordinary keys are not automatically owned by
  // AG-UI, so adopting them here would let the first client snapshot erase
  // backend-only state that it has never seen.
  return [];
}

/**
 * Convert the authoritative AG-UI snapshot into an ADK delta. ADK has no
 * deletion operation, so keys removed by the UI are persisted as null
 * tombstones and tracked by a private manifest instead of retaining stale
 * values.
 */
export function stateDeltaFromInput(
  input: RunAgentInput,
  session?: Session,
): Record<string, unknown> {
  const delta: Record<string, unknown> = Object.create(null);
  const previousKeys = session ? publicKeys(session.state) : [];
  const nextKeys: string[] = [];

  if (isRecord(input.state)) {
    for (const [key, value] of Object.entries(input.state)) {
      validatePublicStateKey(key);
      nextKeys.push(key);
      delta[key] = clone(value);
    }
    if (session && AG_UI_STATE_KEY in session.state) {
      delta[AG_UI_STATE_KEY] = null;
    }
  } else {
    delta[AG_UI_STATE_KEY] = clone(input.state);
  }

  const nextKeySet = new Set(nextKeys);
  for (const key of previousKeys) {
    if (!nextKeySet.has(key)) {
      delta[key] = null;
    }
  }

  delta[AG_UI_STATE_KEYS_KEY] = nextKeys;
  delta[AG_UI_CONTEXT_KEY] = clone(input.context);
  delta[AG_UI_FORWARDED_PROPS_KEY] = clone(input.forwardedProps);
  return delta;
}
