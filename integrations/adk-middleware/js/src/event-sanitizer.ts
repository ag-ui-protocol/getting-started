import type { Event as AdkEvent } from "@google/adk";

import { REQUEST_CREDENTIAL_FUNCTION_CALL_NAME } from "./adk-compat";
import { publicAuthConfig } from "./auth-sanitizer";
import { AG_UI_INTERNAL_STATE_KEYS, isAdkSpecialStateKey } from "./constants";
import { clone, isRecord, setOwn } from "./value-utils";

function publicAuthConfigMap(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }
  const output: Record<string, unknown> = Object.create(null);
  for (const [key, authConfig] of Object.entries(value)) {
    const safe = publicAuthConfig(authConfig);
    if (safe) {
      setOwn(output, key, safe);
    }
  }
  return output;
}

/** Browser-safe projection used by AG-UI RAW and rawEvent payloads. */
export function publicAdkEvent(event: AdkEvent): AdkEvent {
  const output = clone(event);

  for (const part of output.content?.parts ?? []) {
    const call = part.functionCall;
    if (
      call?.name === REQUEST_CREDENTIAL_FUNCTION_CALL_NAME &&
      isRecord(call.args)
    ) {
      for (const key of ["authConfig", "auth_config"] as const) {
        if (key in call.args) {
          call.args[key] = publicAuthConfig(call.args[key]) ?? {};
        }
      }
    }

    const response = part.functionResponse;
    if (
      response?.name === REQUEST_CREDENTIAL_FUNCTION_CALL_NAME &&
      isRecord(response.response)
    ) {
      response.response = publicAuthConfig(response.response) ?? {};
    }
  }

  if (output.actions?.requestedAuthConfigs) {
    output.actions.requestedAuthConfigs = publicAuthConfigMap(
      output.actions.requestedAuthConfigs,
    ) as typeof output.actions.requestedAuthConfigs;
  }

  if (output.actions?.stateDelta) {
    const publicStateDelta: Record<string, unknown> = Object.create(null);
    for (const [key, value] of Object.entries(output.actions.stateDelta)) {
      if (AG_UI_INTERNAL_STATE_KEYS.has(key) || isAdkSpecialStateKey(key)) {
        continue;
      }
      setOwn(publicStateDelta, key, clone(value));
    }
    output.actions.stateDelta = publicStateDelta;
  }

  return output;
}
