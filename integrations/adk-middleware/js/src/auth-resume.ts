import type { UserInputRequest } from "@google/adk";
import { ADKJSProtocolError } from "./errors";
import { clone, hasOwn, isRecord } from "./value-utils";

/** Null-prototype output: overlay keys come from the browser. */
function mergeRecords(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(base)) {
    output[key] = clone(value);
  }
  for (const [key, value] of Object.entries(overlay)) {
    const current = output[key];
    output[key] =
      isRecord(current) && isRecord(value)
        ? mergeRecords(current, value)
        : clone(value);
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
    merged.authType = base.authType;
  }

  if (isRecord(base.oauth2) && isRecord(merged.oauth2)) {
    for (const key of SERVER_OWNED_OAUTH_KEYS) {
      if (hasOwn(base.oauth2, key)) {
        merged.oauth2[key] = clone(base.oauth2[key]);
      }
    }
  }
  if (
    isRecord(base.http) &&
    isRecord(merged.http) &&
    typeof base.http.scheme === "string"
  ) {
    merged.http.scheme = base.http.scheme;
  }
  return merged;
}

/** The credential the client answered with, in ADK's `AuthCredential` shape. */
function responseCredentialFor(
  base: Record<string, unknown>,
  payload: unknown,
  interruptId: string,
): Record<string, unknown> {
  const oauthLike =
    base.authType === "oauth2" || base.authType === "openIdConnect";
  if (isRecord(payload)) {
    if (isRecord(payload.exchangedAuthCredential)) {
      return payload.exchangedAuthCredential;
    }
    if (isRecord(payload.rawAuthCredential)) {
      return payload.rawAuthCredential;
    }
    const isCredential =
      typeof payload.authType === "string" ||
      hasOwn(payload, "apiKey") ||
      isRecord(payload.http) ||
      isRecord(payload.oauth2) ||
      isRecord(payload.serviceAccount);
    return !isCredential && oauthLike ? { oauth2: payload } : payload;
  }
  if (
    base.authType === "apiKey" &&
    typeof payload === "string" &&
    payload.length > 0
  ) {
    return { authType: "apiKey", apiKey: payload };
  }
  if (oauthLike && typeof payload === "string") {
    return {
      authType: base.authType,
      oauth2: { authResponseUri: payload },
    };
  }
  throw new ADKJSProtocolError(
    `Credential payload for ADK interrupt ${interruptId} must contain an AuthCredential.`,
    "INVALID_CREDENTIAL_PAYLOAD",
  );
}

/** Rebuild a complete ADK AuthConfig without trusting browser-owned secrets. */
export function credentialResponse(
  request: UserInputRequest,
  payload: unknown,
): Record<string, unknown> {
  if (!isRecord(request.authConfig)) {
    throw new ADKJSProtocolError(
      `ADK credential interrupt ${request.interruptId} has no server-side AuthConfig.`,
      "INVALID_AUTH_CONFIG",
    );
  }
  const authConfig = request.authConfig;
  if (
    typeof authConfig.credentialKey !== "string" ||
    !isRecord(authConfig.authScheme)
  ) {
    throw new ADKJSProtocolError(
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
    throw new ADKJSProtocolError(
      `ADK credential interrupt ${request.interruptId} has no credential template.`,
      "INVALID_AUTH_CONFIG",
    );
  }

  const exchangedAuthCredential = mergeCredential(
    baseCredential,
    responseCredentialFor(baseCredential, payload, request.interruptId),
  );
  // ADK 2.0 binds an OAuth reply to the request that raised it and keeps only
  // `authResponseUri` / `authCode`; a reply carrying neither is dropped with a
  // log line and the waiting tool never resumes. Refuse it here so the client
  // gets a coded RUN_ERROR instead of a silent stall.
  if (
    isRecord(baseCredential.oauth2) &&
    typeof baseCredential.oauth2.authUri === "string"
  ) {
    const oauth2 = isRecord(exchangedAuthCredential.oauth2)
      ? exchangedAuthCredential.oauth2
      : undefined;
    const answered =
      (typeof oauth2?.authResponseUri === "string" &&
        oauth2.authResponseUri.length > 0) ||
      (typeof oauth2?.authCode === "string" && oauth2.authCode.length > 0);
    if (!answered) {
      throw new ADKJSProtocolError(
        `Credential payload for ADK interrupt ${request.interruptId} must carry oauth2.authResponseUri or oauth2.authCode to complete the authorization flow.`,
        "INVALID_CREDENTIAL_PAYLOAD",
      );
    }
  }
  if (
    baseCredential.authType === "apiKey" &&
    (typeof exchangedAuthCredential.apiKey !== "string" ||
      exchangedAuthCredential.apiKey.length === 0)
  ) {
    throw new ADKJSProtocolError(
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
