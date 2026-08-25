import { spawnSync } from "node:child_process";

/**
 * Recording configuration resolved from the environment. Recording is opt-in:
 * set AIMOCK_RECORD=true (or 1) to proxy unmatched LLM calls to a real model
 * and capture them as fixtures. See docs/cross-language-testing.md for the workflow.
 */
export interface ResolvedRecordConfig {
  /** Upstream OpenAI-compatible base URL (joined with /v1/chat/completions). */
  upstream: string;
  /** API key / bearer token the C# server presents; forwarded to the upstream. */
  apiKey: string;
  /** Model / Azure deployment id the C# server requests. */
  modelId: string;
}

function isTruthy(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

/** Cognitive Services scope used when minting an AAD token via the Azure CLI. */
const COGNITIVE_SERVICES_SCOPE = "https://cognitiveservices.azure.com";

/**
 * Mint an Entra ID (AAD) access token for Azure OpenAI using the Azure CLI.
 * Mirrors the .NET integration tests, which authenticate with
 * DefaultAzureCredential (az login). Throws with a clear message if az is
 * missing or the caller is not logged in.
 */
function fetchAzureAccessToken(): string {
  const result = spawnSync(
    "az",
    [
      "account",
      "get-access-token",
      "--resource",
      COGNITIVE_SERVICES_SCOPE,
      "--query",
      "accessToken",
      "-o",
      "tsv",
    ],
    { encoding: "utf8", shell: process.platform === "win32" },
  );
  if (result.status !== 0) {
    throw new Error(
      "Recording requires an Azure AD token but `az account get-access-token` failed. " +
        "Run `az login`, or set OPENAI_API_KEY to a token/key explicitly.\n" +
        (result.stderr ?? ""),
    );
  }
  const token = result.stdout.trim();
  if (!token) {
    throw new Error("`az account get-access-token` returned an empty token.");
  }
  return token;
}

/**
 * Resolve recording configuration from the environment, or return null when
 * recording is disabled. Supported variables:
 *  - AIMOCK_RECORD=true|1            enable recording
 *  - AIMOCK_RECORD_UPSTREAM=<url>    explicit upstream base (overrides Azure derivation)
 *  - AZURE_OPENAI_ENDPOINT=<url>     Azure resource endpoint; upstream becomes <endpoint>/openai
 *  - OPENAI_API_KEY=<key|token>      explicit credential; otherwise an AAD token is minted via az
 *  - OPENAI_CHAT_MODEL_ID=<id>       model/deployment (default gpt-5-mini in record mode)
 */
export function resolveRecordConfig(): ResolvedRecordConfig | null {
  if (!isTruthy(process.env.AIMOCK_RECORD)) {
    return null;
  }

  const explicitUpstream = process.env.AIMOCK_RECORD_UPSTREAM;
  const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
  let upstream = explicitUpstream;
  if (!upstream && azureEndpoint) {
    upstream = `${azureEndpoint.replace(/\/+$/, "")}/openai`;
  }
  if (!upstream) {
    throw new Error(
      "Recording is enabled but no upstream is configured. Set AIMOCK_RECORD_UPSTREAM " +
        "to an OpenAI-compatible base URL, or AZURE_OPENAI_ENDPOINT to an Azure resource endpoint.",
    );
  }

  const apiKey = process.env.OPENAI_API_KEY || fetchAzureAccessToken();
  const modelId = process.env.OPENAI_CHAT_MODEL_ID || "gpt-5-mini";

  return { upstream, apiKey, modelId };
}
