import { clone, isRecord } from "./value-utils";

const SAFE_AUTH_SCHEME_KEYS = new Set([
  "type",
  "description",
  "name",
  "in",
  "scheme",
  "bearerFormat",
  "openIdConnectUrl",
  "authorizationEndpoint",
  "tokenEndpoint",
  "userinfoEndpoint",
  "revocationEndpoint",
  "tokenEndpointAuthMethodsSupported",
  "grantTypesSupported",
  "scopes",
  "flows",
]);

const SAFE_FLOW_KEYS = new Set([
  "implicit",
  "password",
  "clientCredentials",
  "authorizationCode",
  "authorizationUrl",
  "tokenUrl",
  "refreshUrl",
  "scopes",
]);

const SAFE_OAUTH_KEYS = new Set([
  "clientId",
  "authUri",
  "nonce",
  "state",
  "redirectUri",
  "expiresAt",
  "expiresIn",
  "audience",
  "tokenEndpointAuthMethod",
]);

function allowList(
  value: unknown,
  keys: ReadonlySet<string>,
  nestedKeys?: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!keys.has(key)) {
      continue;
    }
    if (key === "flows" && nestedKeys && isRecord(item)) {
      const flows: Record<string, unknown> = {};
      for (const [flowName, flow] of Object.entries(item)) {
        if (!nestedKeys.has(flowName) || !isRecord(flow)) {
          continue;
        }
        const safeFlow = allowList(flow, nestedKeys);
        if (safeFlow) {
          flows[flowName] = safeFlow;
        }
      }
      output[key] = flows;
      continue;
    }
    output[key] = clone(item);
  }
  return output;
}

function publicCredential(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const output: Record<string, unknown> = {};
  if (typeof value.authType === "string") {
    output.authType = value.authType;
  }
  if (isRecord(value.oauth2)) {
    output.oauth2 = allowList(value.oauth2, SAFE_OAUTH_KEYS);
  }
  if (isRecord(value.http) && typeof value.http.scheme === "string") {
    output.http = { scheme: value.http.scheme };
  }
  if (isRecord(value.serviceAccount)) {
    const serviceAccount = allowList(
      value.serviceAccount,
      new Set(["scopes", "useDefaultCredential", "useIdToken", "audience"]),
    );
    if (serviceAccount) {
      output.serviceAccount = serviceAccount;
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

/**
 * Produce the browser-visible part of ADK AuthConfig. Credential values,
 * tokens, passwords, private keys, headers, and PKCE verifier material never
 * cross the AG-UI boundary.
 */
export function publicAuthConfig(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const output: Record<string, unknown> = {};
  if (typeof value.credentialKey === "string") {
    output.credentialKey = value.credentialKey;
  }
  const authScheme = allowList(
    value.authScheme,
    SAFE_AUTH_SCHEME_KEYS,
    SAFE_FLOW_KEYS,
  );
  if (authScheme) {
    output.authScheme = authScheme;
  }
  const raw = publicCredential(value.rawAuthCredential);
  if (raw) {
    output.rawAuthCredential = raw;
  }
  const exchanged = publicCredential(value.exchangedAuthCredential);
  if (exchanged) {
    output.exchangedAuthCredential = exchanged;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}
