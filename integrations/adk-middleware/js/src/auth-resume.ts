import type { UserInputRequest } from "./adk-compat";
import { ADKProtocolError } from "./errors";
import { clone, hasOwn, isRecord, setOwn } from "./value-utils";

function mergeRecords(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(base)) {
    setOwn(output, key, clone(value));
  }
  for (const [key, value] of Object.entries(overlay)) {
    const current = output[key];
    setOwn(
      output,
      key,
      isRecord(current) && isRecord(value)
        ? mergeRecords(current, value)
        : clone(value),
    );
  }
  return output;
}

const SERVER_OWNED_OAUTH_KEYS = [
  "clientId",
  "clientSecret",
  "codeVerifier",
  "state",
  "nonce",
  "redirectUri",
] as const;

function mergeCredential(
  base: Record<string, unknown>,
  response: Record<string, unknown>,
): Record<string, unknown> {
  const merged = mergeRecords(base, response);
  if (typeof base.authType === "string") {
    setOwn(merged, "authType", base.authType);
  }

  if (isRecord(base.oauth2) && isRecord(merged.oauth2)) {
    for (const key of SERVER_OWNED_OAUTH_KEYS) {
      if (hasOwn(base.oauth2, key)) {
        setOwn(merged.oauth2, key, clone(base.oauth2[key]));
      }
    }
  }
  if (
    isRecord(base.http) &&
    isRecord(merged.http) &&
    typeof base.http.scheme === "string"
  ) {
    setOwn(merged.http, "scheme", base.http.scheme);
  }
  return merged;
}

/** Rebuild a complete ADK AuthConfig without trusting browser-owned secrets. */
export function credentialResponse(
  request: UserInputRequest,
  payload: unknown,
): Record<string, unknown> {
  if (!isRecord(request.authConfig)) {
    throw new ADKProtocolError(
      `ADK credential interrupt ${request.interruptId} has no server-side AuthConfig.`,
      "INVALID_AUTH_CONFIG",
    );
  }
  const authConfig = request.authConfig;
  if (
    typeof authConfig.credentialKey !== "string" ||
    !isRecord(authConfig.authScheme)
  ) {
    throw new ADKProtocolError(
      `ADK credential interrupt ${request.interruptId} has an invalid AuthConfig.`,
      "INVALID_AUTH_CONFIG",
    );
  }

  const baseCredential = isRecord(authConfig.exchangedAuthCredential)
    ? authConfig.exchangedAuthCredential
    : isRecord(authConfig.rawAuthCredential)
      ? authConfig.rawAuthCredential
      : undefined;
  if (!baseCredential) {
    throw new ADKProtocolError(
      `ADK credential interrupt ${request.interruptId} has no credential template.`,
      "INVALID_AUTH_CONFIG",
    );
  }

  let responseCredential: Record<string, unknown>;
  if (isRecord(payload)) {
    if (isRecord(payload.exchangedAuthCredential)) {
      responseCredential = payload.exchangedAuthCredential;
    } else if (isRecord(payload.rawAuthCredential)) {
      responseCredential = payload.rawAuthCredential;
    } else if (
      typeof payload.authType === "string" ||
      hasOwn(payload, "apiKey") ||
      isRecord(payload.http) ||
      isRecord(payload.oauth2) ||
      isRecord(payload.serviceAccount)
    ) {
      responseCredential = payload;
    } else if (
      baseCredential.authType === "oauth2" ||
      baseCredential.authType === "openIdConnect"
    ) {
      responseCredential = { oauth2: payload };
    } else {
      responseCredential = payload;
    }
  } else if (
    baseCredential.authType === "apiKey" &&
    typeof payload === "string" &&
    payload.length > 0
  ) {
    responseCredential = { authType: "apiKey", apiKey: payload };
  } else if (
    (baseCredential.authType === "oauth2" ||
      baseCredential.authType === "openIdConnect") &&
    typeof payload === "string"
  ) {
    responseCredential = {
      authType: baseCredential.authType,
      oauth2: { authResponseUri: payload },
    };
  } else {
    throw new ADKProtocolError(
      `Credential payload for ADK interrupt ${request.interruptId} must contain an AuthCredential.`,
      "INVALID_CREDENTIAL_PAYLOAD",
    );
  }

  const exchangedAuthCredential = mergeCredential(
    baseCredential,
    responseCredential,
  );
  if (
    baseCredential.authType === "apiKey" &&
    (typeof exchangedAuthCredential.apiKey !== "string" ||
      exchangedAuthCredential.apiKey.length === 0)
  ) {
    throw new ADKProtocolError(
      `Credential payload for ADK interrupt ${request.interruptId} must contain a non-empty API key.`,
      "INVALID_CREDENTIAL_PAYLOAD",
    );
  }

  return {
    credentialKey: authConfig.credentialKey,
    authScheme: clone(authConfig.authScheme),
    exchangedAuthCredential,
  };
}
