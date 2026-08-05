import {
  Middleware,
  RunAgentInput,
  AbstractAgent,
  BaseEvent,
  Tool,
  EventType,
  Message,
  ToolCall,
  ToolCallResultEvent,
  ActivitySnapshotEvent,
  RunStartedEvent,
  RunFinishedEvent,
} from "@ag-ui/client";
import { Observable, from, switchMap } from "rxjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { randomUUID, createHash } from "crypto";

/**
 * Activity type for MCP Apps events
 */
export const MCPAppsActivityType = "mcp-apps";

/**
 * Proxied MCP request structure from the frontend iframe
 */
export interface ProxiedMCPRequest {
  /** Server hash (MD5 hash of config) */
  serverHash: string;
  /** Server name (optional, for lookup by name) */
  serverId?: string;
  /** The JSON-RPC method to call */
  method: string;
  /** The JSON-RPC params */
  params?: Record<string, unknown>;
}

/**
 * Extract EventWithState type from Middleware.runNextWithState return type
 */
type ExtractObservableType<T> = T extends Observable<infer U> ? U : never;
type RunNextWithStateReturn = ReturnType<Middleware["runNextWithState"]>;
export type EventWithState = ExtractObservableType<RunNextWithStateReturn>;

/**
 * UI Tool with its source server config and resource URI
 */
interface UIToolInfo {
  tool: Tool;
  serverConfig: MCPClientConfig;
  resourceUri: string;
}

/**
 * MCP Client configuration for HTTP transport
 */
export interface MCPClientConfigHTTP {
  type: "http";
  url: string;
  /**
   * Optional HTTP headers sent with every request to the MCP server, e.g. an
   * `Authorization` bearer token for OAuth/header-protected servers.
   */
  headers?: Record<string, string>;
  serverId?: string;
}

/**
 * MCP Client configuration for SSE transport
 */
export interface MCPClientConfigSSE {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
  serverId?: string;
}

/**
 * MCP Client configuration
 */
export type MCPClientConfig = MCPClientConfigHTTP | MCPClientConfigSSE;

/**
 * Generate a stable server hash from config using MD5 hash.
 * This allows the frontend to reference servers without knowing their URLs.
 */
export function getServerHash(config: MCPClientConfig): string {
  const serialized = JSON.stringify({
    type: config.type,
    url: config.url,
    headers: config.headers,
  });
  return createHash("md5").update(serialized).digest("hex");
}

/**
 * Build the MCP client transport for a server config, forwarding any configured
 * headers (e.g. auth) to the underlying HTTP/SSE request. Both transports accept
 * headers via `requestInit`; previously HTTP carried no headers field at all and
 * SSE's headers were never wired through. See #1862.
 */
function buildMCPTransport(config: MCPClientConfig) {
  const options = config.headers
    ? { requestInit: { headers: config.headers } }
    : undefined;
  return config.type === "sse"
    ? new SSEClientTransport(new URL(config.url), options)
    : new StreamableHTTPClientTransport(new URL(config.url), options);
}

/**
 * Configuration for MCPAppsMiddleware
 */
export interface MCPAppsMiddlewareConfig {
  /**
   * List of MCP server configurations
   */
  mcpServers?: MCPClientConfig[];
}

/**
 * Check if a tool has a UI resource attached (per SEP-1865)
 */
function hasUIResource(tool: { _meta?: Record<string, unknown> }): boolean {
  return typeof tool._meta?.["ui/resourceUri"] === "string";
}

/**
 * Extended tool type that includes MCP Apps metadata
 */
export interface MCPAppTool extends Tool {
  /** UI resource URI from SEP-1865 */
  uiResourceUri?: string;
}

/**
 * Convert MCP tool to AG-UI tool format, preserving UI resource info
 */
function convertMCPToolToAGUITool(mcpTool: {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}): Tool {
  const tool: Tool = {
    name: mcpTool.name,
    description: mcpTool.description || "",
    parameters: mcpTool.inputSchema || { type: "object", properties: {} },
  };

  // Store UI resource URI in the description for now
  // TODO: Once AG-UI Tool type supports _meta, use that instead
  const uiResourceUri = mcpTool._meta?.["ui/resourceUri"];
  if (typeof uiResourceUri === "string") {
    tool.description = `${tool.description}\n[UI Resource: ${uiResourceUri}]`;
  }

  return tool;
}

/**
 * MCP Apps middleware - fetches UI-enabled tools from MCP servers.
 */
export class MCPAppsMiddleware extends Middleware {
  private config: MCPAppsMiddlewareConfig;
  /** Map of serverHash -> server config for proxied requests */
  private serverConfigMapByHash: Map<string, MCPClientConfig> = new Map();
  /** Map of serverId -> server config for proxied requests */
  private serverConfigMapById: Map<string, MCPClientConfig> = new Map();

  constructor(config: MCPAppsMiddlewareConfig = {}) {
    super();
    this.config = config;
    // Build server config maps for proxied requests
    for (const serverConfig of config.mcpServers || []) {
      const serverHash = getServerHash(serverConfig);
      this.serverConfigMapByHash.set(serverHash, serverConfig);
      if (serverConfig.serverId) {
        this.serverConfigMapById.set(serverConfig.serverId, serverConfig);
      }
    }
  }

  run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    // Check for proxied MCP request mode
    const proxiedRequest = input.forwardedProps?.__proxiedMCPRequest as
      | ProxiedMCPRequest
      | undefined;
    if (proxiedRequest) {
      return this.handleProxiedMCPRequest(input.runId, proxiedRequest);
    }

    // If no MCP servers configured, pass through using runNextWithState
    if (!this.config.mcpServers?.length) {
      return this.processStream(this.runNextWithState(input, next), new Map());
    }

    // Fetch UI tools from MCP servers and inject them
    return from(this.fetchUITools()).pipe(
      switchMap((uiToolInfos) => {
        // Build map of tool name -> UIToolInfo
        const uiToolsMap = new Map<string, UIToolInfo>();
        for (const info of uiToolInfos) {
          uiToolsMap.set(info.tool.name, info);
        }

        // Merge UI tools with existing input tools
        const enhancedInput: RunAgentInput = {
          ...input,
          tools: [...input.tools, ...uiToolInfos.map((info) => info.tool)],
        };

        // Use runNextWithState to get state with each event
        return this.processStream(
          this.runNextWithState(enhancedInput, next),
          uiToolsMap,
        );
      }),
    );
  }

  /**
   * Handle a proxied MCP request from the frontend iframe.
   * This bypasses the normal agent flow and directly executes the MCP request.
   */
  private handleProxiedMCPRequest(
    runId: string,
    request: ProxiedMCPRequest,
  ): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      // Look up server config - prefer serverId, fallback to serverHash
      let serverConfig: MCPClientConfig | undefined;
      if (request.serverId) {
        serverConfig = this.serverConfigMapById.get(request.serverId);
      }
      if (!serverConfig) {
        serverConfig = this.serverConfigMapByHash.get(request.serverHash);
      }

      // Emit RunStarted
      const runStartedEvent: RunStartedEvent = {
        type: EventType.RUN_STARTED,
        runId,
        threadId: runId,
      };
      subscriber.next(runStartedEvent);

      // Handle unknown server
      if (!serverConfig) {
        const runFinishedEvent: RunFinishedEvent = {
          type: EventType.RUN_FINISHED,
          runId,
          threadId: runId,
          result: {
            error: `Unknown server: ${request.serverId || request.serverHash}`,
          },
        };
        subscriber.next(runFinishedEvent);
        subscriber.complete();
        return;
      }

      // Execute the MCP request
      this.executeMCPRequest(serverConfig, request.method, request.params)
        .then((result) => {
          // Emit RunFinished with the MCP result
          const runFinishedEvent: RunFinishedEvent = {
            type: EventType.RUN_FINISHED,
            runId,
            threadId: runId,
            result,
          };
          subscriber.next(runFinishedEvent);
          subscriber.complete();
        })
        .catch((error) => {
          // Emit RunFinished with error
          const runFinishedEvent: RunFinishedEvent = {
            type: EventType.RUN_FINISHED,
            runId,
            threadId: runId,
            result: { error: String(error) },
          };
          subscriber.next(runFinishedEvent);
          subscriber.complete();
        });
    });
  }

  /**
   * Execute a generic MCP request (tools/call, resources/read, etc.)
   */
  private async executeMCPRequest(
    serverConfig: MCPClientConfig,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    const transport = buildMCPTransport(serverConfig);

    const client = new Client(
      { name: "mcp-apps-middleware", version: "1.0.0" },
      {
        capabilities: {
          extensions: {
            "io.modelcontextprotocol/ui": {
              mimeTypes: ["text/html+mcp"],
            },
          },
        },
      },
    );

    try {
      await client.connect(transport);

      // Per SEP-1865: Forward any method that doesn't start with "ui/"
      // Methods starting with "ui/" are handled by the host, not the MCP server
      switch (method) {
        case "tools/call":
          return await client.callTool(
            params as { name: string; arguments?: Record<string, unknown> },
          );
        case "resources/read":
          return await client.readResource(params as { uri: string });
        case "notifications/message":
          // notifications/message is a one-way notification (no response expected)
          await client.notification({
            method: "notifications/message",
            params,
          });
          return { success: true };
        case "ping":
          return await client.ping();
        default:
          throw new Error(`MCP method not allowed for UI proxy: ${method}`);
      }
    } finally {
      await client.close();
    }
  }

  /**
   * Process the event stream, holding back RunFinished events until either:
   * a) Another event comes -> flush the held RunFinished immediately
   * b) Stream ends -> do special processing, then flush RunFinished and complete
   */
  private processStream(
    source: Observable<EventWithState>,
    uiToolsMap: Map<string, UIToolInfo>,
  ): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      let heldRunFinished: EventWithState | null = null;
      let isProcessing = false;

      const subscription = source.subscribe({
        next: (eventWithState) => {
          const event = eventWithState.event;

          // If we have a held RunFinished and a new event comes, flush it first
          if (heldRunFinished) {
            subscriber.next(heldRunFinished.event);
            heldRunFinished = null;
          }

          // If this is a RunFinished event, hold it back
          if (event.type === EventType.RUN_FINISHED) {
            heldRunFinished = eventWithState;
          } else {
            subscriber.next(event);
          }
        },
        error: (err) => {
          // On error, flush any held event and propagate error
          if (heldRunFinished) {
            subscriber.next(heldRunFinished.event);
            heldRunFinished = null;
          }
          subscriber.error(err);
        },
        complete: async () => {
          // Stream ended - do special processing if we have a held RunFinished
          if (heldRunFinished && !isProcessing) {
            isProcessing = true;

            try {
              // Find tool calls that don't have a corresponding result message
              const pendingToolCalls = this.findPendingToolCalls(
                heldRunFinished.messages,
              );

              // Filter for UI tool calls (tools we injected from MCP servers)
              const pendingUIToolCalls = pendingToolCalls.filter((tc) =>
                uiToolsMap.has(tc.function.name),
              );

              // Execute pending UI tool calls and emit results
              for (const toolCall of pendingUIToolCalls) {
                const toolInfo = uiToolsMap.get(toolCall.function.name)!;
                try {
                  const args = JSON.parse(toolCall.function.arguments || "{}");
                  const mcpResult = await this.executeToolCall(
                    toolInfo.serverConfig,
                    toolCall.function.name,
                    args,
                  );

                  // Emit tool result event
                  const resultEvent: ToolCallResultEvent = {
                    type: EventType.TOOL_CALL_RESULT,
                    messageId: randomUUID(),
                    toolCallId: toolCall.id,
                    content: this.extractTextContent(mcpResult),
                  };
                  subscriber.next(resultEvent);

                  // Emit activity snapshot with MCP result and resourceUri (frontend fetches resource)
                  const activityEvent: ActivitySnapshotEvent = {
                    type: EventType.ACTIVITY_SNAPSHOT,
                    messageId: randomUUID(),
                    activityType: MCPAppsActivityType,
                    content: {
                      result: mcpResult,
                      resourceUri: toolInfo.resourceUri,
                      serverHash: getServerHash(toolInfo.serverConfig),
                      serverId: toolInfo.serverConfig.serverId,
                      toolInput: args,
                    },
                    replace: true,
                  };
                  subscriber.next(activityEvent);
                } catch (error) {
                  console.error(
                    `Failed to execute UI tool call ${toolCall.function.name}:`,
                    error,
                  );
                  // Emit error result
                  const errorResult: ToolCallResultEvent = {
                    type: EventType.TOOL_CALL_RESULT,
                    messageId: randomUUID(),
                    toolCallId: toolCall.id,
                    content: JSON.stringify({ error: String(error) }),
                  };
                  subscriber.next(errorResult);
                }
              }

              subscriber.next(heldRunFinished.event);
            } finally {
              heldRunFinished = null;
              isProcessing = false;
            }
          }
          subscriber.complete();
        },
      });

      return () => subscription.unsubscribe();
    });
  }

  /**
   * Execute a tool call on the MCP server and return the raw result
   */
  private async executeToolCall(
    serverConfig: MCPClientConfig,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const transport = buildMCPTransport(serverConfig);

    const client = new Client(
      { name: "mcp-apps-middleware", version: "1.0.0" },
      {
        capabilities: {
          extensions: {
            "io.modelcontextprotocol/ui": {
              mimeTypes: ["text/html+mcp"],
            },
          },
        },
      },
    );

    try {
      await client.connect(transport);

      const result = await client.callTool({
        name: toolName,
        arguments: args,
      });

      return result;
    } finally {
      await client.close();
    }
  }

  /**
   * Extract text content from MCP result, fallback to JSON stringified content
   */
  private extractTextContent(mcpResult: unknown): string {
    const result = mcpResult as { content?: unknown };
    if (Array.isArray(result.content)) {
      const textContent = result.content
        .filter(
          (c): c is { type: "text"; text: string } =>
            c &&
            typeof c === "object" &&
            c.type === "text" &&
            typeof c.text === "string",
        )
        .map((c) => c.text)
        .join("\n");
      return textContent || JSON.stringify(result.content);
    }
    return JSON.stringify(result.content);
  }

  /**
   * Find tool calls that don't have a corresponding result (role: "tool") message
   */
  private findPendingToolCalls(messages: Message[]): ToolCall[] {
    // Collect all tool calls from assistant messages
    const allToolCalls: ToolCall[] = [];
    for (const message of messages) {
      if (
        message.role === "assistant" &&
        "toolCalls" in message &&
        message.toolCalls
      ) {
        allToolCalls.push(...message.toolCalls);
      }
    }

    // Collect all tool call IDs that have results
    const resolvedToolCallIds = new Set<string>();
    for (const message of messages) {
      if (message.role === "tool" && "toolCallId" in message) {
        resolvedToolCallIds.add(message.toolCallId);
      }
    }

    // Return tool calls that don't have results
    return allToolCalls.filter((tc) => !resolvedToolCallIds.has(tc.id));
  }

  /**
   * Connect to all configured MCP servers and fetch tools with UI resources
   */
  private async fetchUITools(): Promise<UIToolInfo[]> {
    const allUITools: UIToolInfo[] = [];

    for (const serverConfig of this.config.mcpServers || []) {
      try {
        const tools = await this.fetchToolsFromServer(serverConfig);
        allUITools.push(...tools);
      } catch (error) {
        console.error(
          `Failed to fetch tools from MCP server ${serverConfig.url}:`,
          error,
        );
      }
    }

    return allUITools;
  }

  /**
   * Connect to a single MCP server and fetch its UI-enabled tools
   */
  private async fetchToolsFromServer(
    serverConfig: MCPClientConfig,
  ): Promise<UIToolInfo[]> {
    const transport = buildMCPTransport(serverConfig);

    const client = new Client(
      { name: "mcp-apps-middleware", version: "1.0.0" },
      {
        capabilities: {
          // Advertise MCP Apps UI support per SEP-1865
          extensions: {
            "io.modelcontextprotocol/ui": {
              mimeTypes: ["text/html+mcp"],
            },
          },
        },
      },
    );

    try {
      await client.connect(transport);

      // Fetch tools from the server
      const response = await client.listTools();

      // Filter for tools with UI resources and convert to AG-UI format with server config
      const uiTools = response.tools.filter(hasUIResource).map((mcpTool) => ({
        tool: convertMCPToolToAGUITool(mcpTool),
        serverConfig,
        resourceUri: mcpTool._meta!["ui/resourceUri"] as string,
      }));

      return uiTools;
    } finally {
      // Always close the connection
      await client.close();
    }
  }
}
