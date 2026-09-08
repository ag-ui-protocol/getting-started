import {
  Middleware,
  EventType,
  type AbstractAgent,
  type BaseEvent,
  type Message,
  type RunAgentInput,
  type Tool,
  type ToolCall,
  type ToolCallResultEvent,
} from "@ag-ui/client";
import { Observable, type Subscription } from "rxjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
// Type-only: erased at compile time, so it never enters the runtime graph.
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * MCP Client configuration for HTTP (streamable) transport.
 */
export interface MCPClientConfigHTTP {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  serverId?: string;
}

/**
 * MCP Client configuration for SSE transport.
 */
export interface MCPClientConfigSSE {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
  serverId?: string;
}

/**
 * MCP Client configuration — one of the supported transports.
 */
export type MCPClientConfig = MCPClientConfigHTTP | MCPClientConfigSSE;

/**
 * Maximum length of a tool name. Bounded by the strictest mainstream LLM
 * provider constraint (OpenAI function names: `^[a-zA-Z0-9_-]{1,64}$`),
 * which is also why `__` — not `:` or `/` — is used as the delimiter.
 */
export const MAX_TOOL_NAME_LENGTH = 64;

/**
 * The namespace prefix applied to every MCP-sourced tool. Mirrors the
 * Claude Agent SDK convention: `mcp__{server}__{tool}`.
 */
export const MCP_TOOL_NAME_PREFIX = "mcp";

/**
 * Default cap on the number of MCP tool-execution rounds in a single
 * `run()`. Prevents a runaway loop (and unbounded cost) if the model keeps
 * calling MCP tools forever.
 */
export const DEFAULT_MAX_ITERATIONS = 32;

/**
 * Options for {@link MCPMiddleware}.
 */
export interface MCPMiddlewareOptions {
  /**
   * Maximum number of MCP tool-execution rounds before the middleware stops
   * looping and lets the run finish. Defaults to {@link DEFAULT_MAX_ITERATIONS}.
   */
  maxIterations?: number;
}

/**
 * A tool resolved from an MCP server, carrying the metadata needed to map
 * the exposed (prefixed) name back to its origin. The mapping is kept as a
 * descriptor — never reconstructed by string-splitting the exposed name —
 * so server ids or tool names containing `__` can't corrupt the round-trip.
 */
export interface ResolvedMCPTool {
  /** The (prefixed, possibly truncated/deduped) tool exposed to the agent. */
  tool: Tool;
  /** The original tool name as reported by the MCP server. */
  originalName: string;
  /** The server this tool came from. */
  serverConfig: MCPClientConfig;
}

/**
 * Restrict a name segment to characters valid across LLM providers.
 */
function sanitizeSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Build a unique, length-bounded, namespaced tool name.
 *
 * Shape: `mcp__{serverId}__{toolName}` (sanitized), truncated to
 * {@link MAX_TOOL_NAME_LENGTH}. If the truncated name collides with one
 * already in `used`, a `_N` suffix is appended (and the base re-truncated to
 * make room) until unique.
 */
function makeUniqueToolName(
  serverId: string,
  toolName: string,
  used: Set<string>,
): string {
  const base = `${MCP_TOOL_NAME_PREFIX}__${sanitizeSegment(serverId)}__${sanitizeSegment(toolName)}`;
  let candidate = base.slice(0, MAX_TOOL_NAME_LENGTH);
  if (!used.has(candidate)) {
    return candidate;
  }
  for (let i = 1; ; i++) {
    const suffix = `_${i}`;
    candidate = base.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length) + suffix;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

/**
 * Collect assistant tool calls that have no corresponding `role: "tool"`
 * result message — i.e. the still-open tool calls.
 */
function getOpenToolCalls(messages: Message[]): ToolCall[] {
  const allToolCalls: ToolCall[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && "toolCalls" in message && message.toolCalls) {
      allToolCalls.push(...message.toolCalls);
    }
  }
  const resolvedIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool" && "toolCallId" in message) {
      resolvedIds.add(message.toolCallId);
    }
  }
  return allToolCalls.filter((tc) => !resolvedIds.has(tc.id));
}

/**
 * Close an MCP client without letting a `close()` failure escape — a throw
 * here would otherwise clobber the value being returned from the enclosing
 * `try`/`catch` (or abort the listing loop). Best-effort: log and move on.
 */
async function safeClose(client: Client | undefined): Promise<void> {
  if (!client) return;
  try {
    await client.close();
  } catch (error) {
    console.error("[MCPMiddleware] Failed to close MCP client:", error);
  }
}

/**
 * Extract text content from an MCP `callTool` result, falling back to a JSON
 * stringification of the content when it isn't plain text.
 */
function extractTextContent(mcpResult: unknown): string {
  const result = mcpResult as { content?: unknown };
  if (Array.isArray(result.content)) {
    const text = result.content
      .filter(
        (c): c is { type: "text"; text: string } =>
          !!c &&
          typeof c === "object" &&
          (c as { type?: unknown }).type === "text" &&
          typeof (c as { text?: unknown }).text === "string",
      )
      .map((c) => c.text)
      .join("\n");
    return text || JSON.stringify(result.content);
  }
  return JSON.stringify(result.content ?? result);
}

/**
 * One MCP tool as returned by `listTools`, paired with the server it came
 * from. Cached on the middleware instance so we only hit the network once.
 */
interface ListedTool {
  mcpTool: {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  };
  serverConfig: MCPClientConfig;
  serverId: string;
}

/**
 * AG-UI middleware that lists tools from one or more MCP servers, injects
 * them into the agent run (namespaced as `mcp__{server}__{tool}`), and
 * executes the resulting MCP tool calls server-side.
 *
 * Loop, on each agent `RUN_FINISHED`:
 *   - Find open tool calls (assistant calls without a result message).
 *   - Of those, execute the ones that target our injected MCP tools and emit
 *     a `TOOL_CALL_RESULT` for each.
 *   - If no open tool calls remain afterwards, start another run with the new
 *     result messages appended (same threadId, fresh runId).
 *   - If open tool calls still remain (e.g. frontend tools), stop and let the
 *     frontend resolve them.
 *
 * If a run produces no open tool calls targeting our MCP tools, the
 * middleware does not interfere at all — every event is forwarded verbatim.
 */
export class MCPMiddleware extends Middleware {
  private readonly mcpServers: MCPClientConfig[];
  private readonly maxIterations: number;
  /**
   * Lazily-populated cache of the full `listTools` result across every
   * configured server. Populated on the first `run()` and reused for the
   * lifetime of the instance — so listing happens exactly once per
   * middleware instance, no matter how many runs come through.
   */
  private listingPromise: Promise<ListedTool[]> | null = null;

  constructor(
    mcpServers: MCPClientConfig[] = [],
    options: MCPMiddlewareOptions = {},
  ) {
    super();
    this.mcpServers = mcpServers;
    // Clamp to a positive integer — a 0/negative/NaN cap would otherwise
    // trip the runaway guard on the first round and silently disable tool
    // execution entirely.
    const requested = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.maxIterations = Number.isFinite(requested)
      ? Math.max(1, Math.floor(requested))
      : DEFAULT_MAX_ITERATIONS;
  }

  run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    if (this.mcpServers.length === 0) {
      return this.runNext(input, next);
    }

    return new Observable<BaseEvent>((subscriber) => {
      let cancelled = false;
      let activeSub: Subscription | undefined;
      // Number of MCP tool-execution rounds performed so far in this run.
      let toolRounds = 0;

      // Run the agent once; on completion decide whether to execute MCP tool
      // calls and loop. `toolMap` (exposed name -> origin) is built once and
      // reused across iterations.
      //
      // Run-lifecycle policy: from the consumer's perspective, the entire
      // tool-execution loop is presented as a SINGLE run. We forward the
      // first run's `RUN_STARTED` and suppress every subsequent
      // `RUN_STARTED`. We buffer *every* run's `RUN_FINISHED` (each one
      // replacing the prior) and flush only the final one when the loop
      // actually stops. This keeps any downstream consumer (or persistence
      // layer) that treats `RUN_FINISHED` as "the assistant turn is over"
      // from prematurely closing things between iterations.
      //
      // Why we sync `next.messages`: `runNextWithState` uses
      // `defaultApplyEvents`, which seeds its `messages` from
      // `agent.messages` (the downstream agent's persistent state) — NOT
      // from `input.messages`. So passing tool results only via
      // `runInput.messages` makes them visible to the LLM call but
      // INVISIBLE to the next iteration's apply chain, which then sees the
      // assistant tool call as still-open and the model re-emits it. The
      // chained-agent proxy exposes `.messages` as a getter returning the
      // underlying array reference, so mutating it via `.push` is the way
      // to keep both the model and the apply chain in sync.
      const runOnce = (
        runInput: RunAgentInput,
        toolMap: Map<string, ResolvedMCPTool>,
        isContinuation: boolean,
      ): void => {
        let latestMessages: Message[] = runInput.messages;
        let errored = false;
        let bufferedRunFinished: BaseEvent | null = null;

        activeSub = this.runNextWithState(runInput, next).subscribe({
          next: ({ event, messages }) => {
            latestMessages = messages;
            if (event.type === EventType.RUN_ERROR) {
              errored = true;
              subscriber.next(event);
              return;
            }
            if (event.type === EventType.RUN_FINISHED) {
              // Always buffer; only flushed when the loop truly stops.
              bufferedRunFinished = event;
              return;
            }
            if (event.type === EventType.RUN_STARTED && isContinuation) {
              // Hide continuation run boundary — consumer sees one run.
              return;
            }
            subscriber.next(event);
          },
          error: (err) => subscriber.error(err),
          complete: () => {
            // Route any rejection from the async continuation back onto the
            // stream — otherwise it becomes an unhandled rejection and the
            // observable silently never completes.
            onRunComplete(
              runInput,
              latestMessages,
              toolMap,
              errored,
              bufferedRunFinished,
            ).catch((err) => subscriber.error(err));
          },
        });
      };

      const onRunComplete = async (
        runInput: RunAgentInput,
        messages: Message[],
        toolMap: Map<string, ResolvedMCPTool>,
        errored: boolean,
        bufferedRunFinished: BaseEvent | null,
      ): Promise<void> => {
        if (cancelled) return;

        // The run errored — do not execute tools or loop; the RUN_ERROR has
        // already been forwarded. There's no RUN_FINISHED to flush.
        if (errored) {
          subscriber.complete();
          return;
        }

        const openCalls = getOpenToolCalls(messages);
        const ourCalls = openCalls.filter((tc) => toolMap.has(tc.function.name));

        // Nothing for us — flush the buffered RUN_FINISHED untouched and stop.
        if (ourCalls.length === 0) {
          if (bufferedRunFinished) subscriber.next(bufferedRunFinished);
          subscriber.complete();
          return;
        }

        // Runaway guard: flush RUN_FINISHED and stop without executing more.
        if (toolRounds >= this.maxIterations) {
          console.warn(
            `[MCPMiddleware] Reached maxIterations (${this.maxIterations}); ` +
              `leaving ${ourCalls.length} MCP tool call(s) unexecuted.`,
          );
          if (bufferedRunFinished) subscriber.next(bufferedRunFinished);
          subscriber.complete();
          return;
        }
        toolRounds++;

        // Execute our MCP tool calls (in parallel), then emit results in
        // their original order — *before* flushing the held RUN_FINISHED —
        // so the stream stays valid under AG-UI verify.
        const executed = await Promise.all(
          ourCalls.map(async (tc) => {
            const resolved = toolMap.get(tc.function.name)!;
            const content = await this.executeToolCall(resolved, tc);
            return { tc, content };
          }),
        );
        if (cancelled) return;

        const resultMessages: Message[] = [];
        for (const { tc, content } of executed) {
          const messageId = crypto.randomUUID();
          const resultEvent: ToolCallResultEvent = {
            type: EventType.TOOL_CALL_RESULT,
            messageId,
            toolCallId: tc.id,
            content,
            role: "tool",
          };
          subscriber.next(resultEvent);
          resultMessages.push({
            id: messageId,
            role: "tool",
            content,
            toolCallId: tc.id,
          });
        }

        const updatedMessages = [...messages, ...resultMessages];
        const stillOpen = getOpenToolCalls(updatedMessages);

        // Scenario 2: other (e.g. frontend) tool calls are still open — we
        // don't trigger another run. Flush the buffered RUN_FINISHED and
        // hand off to the frontend.
        if (stillOpen.length > 0) {
          if (bufferedRunFinished) subscriber.next(bufferedRunFinished);
          subscriber.complete();
          return;
        }

        // Sync our tool results into the downstream agent's persistent
        // message state so the next iteration's `defaultApplyEvents` (which
        // seeds from `agent.messages`, not `input.messages`) sees the tool
        // calls as resolved instead of re-emitting them.
        next.messages.push(...resultMessages);

        // Scenario 1: everything is resolved — start a continuation run
        // WITHOUT flushing RUN_FINISHED. The continuation's own RUN_STARTED
        // will be suppressed by `runOnce`, and its RUN_FINISHED will be
        // buffered (and only flushed when the loop truly stops). The
        // consumer sees one seamless run.
        runOnce(
          { ...runInput, runId: crypto.randomUUID(), messages: updatedMessages },
          toolMap,
          true,
        );
      };

      // Bootstrap: list tools once, inject, run.
      void (async () => {
        try {
          const resolved = await this.resolveTools(
            new Set(input.tools.map((t) => t.name)),
          );
          if (cancelled) return;
          const toolMap = new Map<string, ResolvedMCPTool>(
            resolved.map((r) => [r.tool.name, r]),
          );
          runOnce(
            { ...input, tools: [...input.tools, ...resolved.map((r) => r.tool)] },
            toolMap,
            false,
          );
        } catch (err) {
          subscriber.error(err);
        }
      })();

      return () => {
        cancelled = true;
        activeSub?.unsubscribe();
      };
    });
  }

  /**
   * Resolve injectable tool descriptors for this run. Listing is cached
   * per-instance (see {@link listingPromise}); only the name resolution
   * (prefix / truncate / dedupe) is recomputed per run, since dedupe needs
   * the current `input.tools` as its seed.
   */
  private async resolveTools(
    existingNames: Set<string>,
  ): Promise<ResolvedMCPTool[]> {
    const listed = await this.listAllTools();
    const used = new Set(existingNames);
    return listed.map((entry) => {
      const name = makeUniqueToolName(entry.serverId, entry.mcpTool.name, used);
      used.add(name);
      return {
        tool: {
          name,
          description: entry.mcpTool.description ?? "",
          parameters: entry.mcpTool.inputSchema ?? {
            type: "object",
            properties: {},
          },
        },
        originalName: entry.mcpTool.name,
        serverConfig: entry.serverConfig,
      };
    });
  }

  /**
   * List tools from every configured server, exactly once per instance. A
   * server that fails to connect or list is logged and skipped — one bad
   * server never blocks the other servers' tools. The failure is part of
   * the cached result, so we don't keep retrying broken servers.
   */
  private listAllTools(): Promise<ListedTool[]> {
    if (this.listingPromise === null) {
      this.listingPromise = this.doListAllTools();
    }
    return this.listingPromise;
  }

  private async doListAllTools(): Promise<ListedTool[]> {
    const listed: ListedTool[] = [];
    let index = 0;
    for (const serverConfig of this.mcpServers) {
      const serverId = serverConfig.serverId ?? `server${index}`;
      index++;

      let client: Client | undefined;
      try {
        client = await this.connect(serverConfig);
        const { tools } = await client.listTools();
        for (const mcpTool of tools) {
          listed.push({ mcpTool, serverConfig, serverId });
        }
      } catch (error) {
        console.error(
          `[MCPMiddleware] Failed to list tools from MCP server ${serverConfig.url}:`,
          error,
        );
      } finally {
        await safeClose(client);
      }
    }
    return listed;
  }

  /**
   * Execute a single MCP tool call against its origin server and return the
   * result as text. Errors are caught and returned as the result content so
   * the agentic loop can react rather than crash.
   */
  private async executeToolCall(
    resolved: ResolvedMCPTool,
    toolCall: ToolCall,
  ): Promise<string> {
    let args: Record<string, unknown> = {};
    try {
      args = toolCall.function.arguments
        ? (JSON.parse(toolCall.function.arguments) as Record<string, unknown>)
        : {};
    } catch {
      // Leave args empty if the model emitted malformed JSON, but surface it
      // — running a tool with no arguments is rarely what the model intended.
      console.warn(
        `[MCPMiddleware] Malformed JSON arguments for ${resolved.originalName}; ` +
          `executing with empty arguments.`,
      );
    }

    let client: Client | undefined;
    try {
      client = await this.connect(resolved.serverConfig);
      const result = await client.callTool({
        name: resolved.originalName,
        arguments: args,
      });
      return extractTextContent(result);
    } catch (error) {
      // The error is returned as the tool result so the agentic loop can
      // react; also log it server-side so an operator has observability
      // (the model-facing string is the only other trace of the failure).
      console.error(
        `[MCPMiddleware] Tool execution failed for ${resolved.originalName}:`,
        error,
      );
      return `Error executing tool ${resolved.originalName}: ${String(error)}`;
    } finally {
      await safeClose(client);
    }
  }

  /**
   * Open a connected MCP client for a server config. If `headers` is set on
   * the config, they're stamped on every outbound request via the
   * transport's `requestInit`. This is the seam the runtime uses to forward
   * per-request auth (e.g. `Authorization: Bearer …`, `X-Cpki-User-Id: …`):
   * the middleware is constructed per request, so static headers in the
   * config are effectively per-request.
   *
   * Caveat: for the SSE transport, `requestInit.headers` only applies to
   * the POST channel — the SSE event stream uses `eventSourceInit`. For
   * streamable HTTP (the typical case) it covers all traffic.
   *
   * The SSE transport is imported lazily so that `eventsource` — which it
   * pulls in transitively, and which only some consumers ever need — stays out
   * of the module graph unless an SSE server is actually configured. Under Bun
   * a static import of it breaks at load time: `eventsource`'s `bun` export
   * condition resolves to its ESM build, so the SDK's CJS `require` gets an
   * async module back and throws.
   */
  private async connect(serverConfig: MCPClientConfig): Promise<Client> {
    const opts = serverConfig.headers
      ? { requestInit: { headers: serverConfig.headers } }
      : undefined;
    let transport: Transport;
    if (serverConfig.type === "sse") {
      const { SSEClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/sse.js"
      );
      transport = new SSEClientTransport(new URL(serverConfig.url), opts);
    } else {
      transport = new StreamableHTTPClientTransport(
        new URL(serverConfig.url),
        opts,
      );
    }
    const client = new Client({
      name: "ag-ui-mcp-middleware",
      version: "0.0.1",
    });
    await client.connect(transport);
    return client;
  }
}
