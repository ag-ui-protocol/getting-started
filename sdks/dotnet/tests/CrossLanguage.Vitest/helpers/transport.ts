import { HttpAgent } from "@ag-ui/client";
import { AGUI_MEDIA_TYPE } from "@ag-ui/proto";

/**
 * The two wire transports a TS client can negotiate with a C# AG-UI server.
 * Cross-parity scenario suites parameterize over this list so the same
 * assertions run for both protocols (mirrors the .NET integration tests'
 * `TransportFormat {Json, Protobuf}` [Theory]).
 *
 * Note: protobuf only encodes the supported event subset — scenarios that emit
 * `ToolCallResult`, `Reasoning*`, or `Activity*` events are SSE-only and must not
 * be parameterized over `protobuf`.
 */
export const TRANSPORTS = ["sse", "protobuf"] as const;
export type Transport = (typeof TRANSPORTS)[number];

/** The exact response `Content-Type` the server emits for each transport. */
export const TRANSPORT_MEDIA_TYPE: Record<Transport, string> = {
  sse: "text/event-stream",
  protobuf: AGUI_MEDIA_TYPE,
};

type AgentConfig = Omit<ConstructorParameters<typeof HttpAgent>[0], "fetch">;

export interface TransportAgent {
  agent: HttpAgent;
  /** The `Content-Type` the server responded with on the most recent run. */
  lastResponseContentType: () => string | undefined;
}

/**
 * Builds an {@link HttpAgent} that requests the given transport. The default
 * agent hardcodes `Accept: text/event-stream` (set *after* spreading `headers`,
 * so a `headers` option can't override it), and only *decodes* protobuf based on
 * the response `Content-Type`. We opt in via the public `fetch` hook and capture
 * the response `Content-Type` so tests can assert the server actually negotiated
 * the requested transport.
 */
export function createTransportAgent(
  config: AgentConfig,
  transport: Transport,
): TransportAgent {
  let lastContentType: string | undefined;
  const agent = new HttpAgent({
    ...config,
    fetch: async (url, init) => {
      const requestInit = init as RequestInit | undefined;
      const response = await fetch(url as RequestInfo, {
        ...requestInit,
        headers: {
          ...((requestInit?.headers as Record<string, string> | undefined) ?? {}),
          Accept: TRANSPORT_MEDIA_TYPE[transport],
        },
      });
      lastContentType = response.headers.get("content-type") ?? undefined;
      return response;
    },
  });
  return { agent, lastResponseContentType: () => lastContentType };
}
