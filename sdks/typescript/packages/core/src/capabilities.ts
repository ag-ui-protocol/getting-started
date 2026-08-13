// Canonical agent capability declarations. This is the authoritative
// capabilities-surface module of @ag-ui/core.

import type { Tool } from "./types";

/** Describes a sub-agent that can be invoked by a parent agent. */
export interface SubAgentInfo {
  /** Unique name or identifier of the sub-agent. */
  name: string;
  /** What this sub-agent specializes in. Helps clients build agent selection UIs. */
  description?: string;
}

/**
 * Basic metadata about the agent. Useful for discovery UIs, agent marketplaces,
 * and debugging. Set these when you want clients to display agent information
 * or when multiple agents are available and users need to pick one.
 */
export interface IdentityCapabilities {
  /** Human-readable name shown in UIs and agent selectors. */
  name?: string;
  /** The framework or platform powering this agent (e.g., "langgraph", "mastra", "crewai"). */
  type?: string;
  /** What this agent does — helps users and routing logic decide when to use it. */
  description?: string;
  /** Semantic version of the agent (e.g., "1.2.0"). Useful for compatibility checks. */
  version?: string;
  /** Organization or team that maintains this agent. */
  provider?: string;
  /** URL to the agent's documentation or homepage. */
  documentationUrl?: string;
  /** Arbitrary key-value pairs for integration-specific identity info. */
  metadata?: Record<string, unknown>;
}

/**
 * Declares which transport mechanisms the agent supports. Clients use this
 * to pick the best connection strategy. Only set flags to `true` for transports
 * your agent actually handles — omit or set `false` for unsupported ones.
 */
export interface TransportCapabilities {
  /** Set `true` if the agent streams responses via SSE. Most agents enable this. */
  streaming?: boolean;
  /** Set `true` if the agent accepts persistent WebSocket connections. */
  websocket?: boolean;
  /** Set `true` if the agent supports the AG-UI binary protocol (protobuf over HTTP). */
  httpBinary?: boolean;
  /** Set `true` if the agent can send async updates via webhooks after a run finishes. */
  pushNotifications?: boolean;
  /** Set `true` if the agent supports resuming interrupted streams via sequence numbers. */
  resumable?: boolean;
}

/**
 * Tool calling capabilities. Distinguishes between tools the agent itself provides
 * (listed in `items`) and tools the client passes at runtime via `RunAgentInput.tools`.
 * Enable this when your agent can call functions, search the web, execute code, etc.
 */
export interface ToolsCapabilities {
  /** Set `true` if the agent can make tool calls at all. Set `false` to explicitly
   *  signal tool calling is disabled even if items are present. */
  supported?: boolean;
  /** The tools this agent provides on its own (full JSON Schema definitions).
   *  These are distinct from client-provided tools passed in `RunAgentInput.tools`. */
  items?: Tool[];
  /** Set `true` if the agent can invoke multiple tools concurrently within a single step. */
  parallelCalls?: boolean;
  /** Set `true` if the agent accepts and uses tools provided by the client at runtime. */
  clientProvided?: boolean;
}

/**
 * Output format support. Enable `structuredOutput` when your agent can return
 * responses conforming to a JSON schema, which is useful for programmatic consumption.
 */
export interface OutputCapabilities {
  /** Set `true` if the agent can produce structured JSON output matching a provided schema. */
  structuredOutput?: boolean;
  /** MIME types the agent can produce (e.g., `["text/plain", "application/json"]`).
   *  Omit if the agent only produces plain text. */
  supportedMimeTypes?: string[];
}

/**
 * State and memory management capabilities. These tell the client how the agent
 * handles shared state and whether conversation context persists across runs.
 */
export interface StateCapabilities {
  /** Set `true` if the agent emits `STATE_SNAPSHOT` events (full state replacement). */
  snapshots?: boolean;
  /** Set `true` if the agent emits `STATE_DELTA` events (JSON Patch incremental updates). */
  deltas?: boolean;
  /** Set `true` if the agent has long-term memory beyond the current thread
   *  (e.g., vector store, knowledge base, or cross-session recall). */
  memory?: boolean;
  /** Set `true` if state is preserved across multiple runs within the same thread.
   *  When `false`, state resets on each run. */
  persistentState?: boolean;
}

/**
 * Multi-agent coordination capabilities. Enable these when your agent can
 * orchestrate or hand off work to other agents.
 */
export interface MultiAgentCapabilities {
  /** Set `true` if the agent participates in any form of multi-agent coordination. */
  supported?: boolean;
  /** Set `true` if the agent can delegate subtasks to other agents while retaining control. */
  delegation?: boolean;
  /** Set `true` if the agent can transfer the conversation entirely to another agent. */
  handoffs?: boolean;
  /** List of sub-agents this agent can invoke. Helps clients build agent selection UIs. */
  subAgents?: SubAgentInfo[];
}

/**
 * Reasoning and thinking capabilities. Enable these when your agent exposes its
 * internal thought process (e.g., chain-of-thought, extended thinking).
 */
export interface ReasoningCapabilities {
  /** Set `true` if the agent produces reasoning/thinking tokens visible to the client. */
  supported?: boolean;
  /** Set `true` if reasoning tokens are streamed incrementally (vs. returned all at once). */
  streaming?: boolean;
  /** Set `true` if reasoning content is encrypted (zero-data-retention mode).
   *  Clients should expect opaque `encryptedValue` fields instead of readable content. */
  encrypted?: boolean;
}

/**
 * Modalities the agent can accept as input. Clients use this to show/hide
 * file upload buttons, audio recorders, image pickers, etc.
 */
export interface MultimodalInputCapabilities {
  /** Set `true` if the agent can process image inputs (e.g., screenshots, photos). */
  image?: boolean;
  /** Set `true` if the agent can process audio inputs (speech, recordings). */
  audio?: boolean;
  /** Set `true` if the agent can process video inputs. */
  video?: boolean;
  /** Set `true` if the agent can process PDF documents. */
  pdf?: boolean;
  /** Set `true` if the agent can process arbitrary file uploads. */
  file?: boolean;
}

/**
 * Modalities the agent can produce as output. Clients use this to anticipate
 * rich content in the agent's response.
 */
export interface MultimodalOutputCapabilities {
  /** Set `true` if the agent can generate images as part of its response. */
  image?: boolean;
  /** Set `true` if the agent can produce audio output (text-to-speech, audio files). */
  audio?: boolean;
}

/**
 * Multimodal input and output support. Organized into `input` and `output`
 * sub-objects so clients can independently query what the agent accepts
 * versus what it produces.
 */
export interface MultimodalCapabilities {
  /** Modalities the agent can accept as input (images, audio, video, PDFs, files). */
  input?: MultimodalInputCapabilities;
  /** Modalities the agent can produce as output (images, audio). */
  output?: MultimodalOutputCapabilities;
}

/**
 * Execution control and limits. Declare these so clients can set expectations
 * about how long or how many steps an agent run might take.
 */
export interface ExecutionCapabilities {
  /** Set `true` if the agent can execute code (e.g., Python, JavaScript) during a run. */
  codeExecution?: boolean;
  /** Set `true` if code execution happens in a sandboxed/isolated environment.
   *  Only meaningful when `codeExecution` is `true`. */
  sandboxed?: boolean;
  /** Maximum number of tool-call/reasoning iterations the agent will perform per run.
   *  Helps clients display progress or set timeout expectations. */
  maxIterations?: number;
  /** Maximum wall-clock time (in milliseconds) the agent will run before timing out. */
  maxExecutionTime?: number;
}

/**
 * Human-in-the-loop interaction support. Enable these when your agent can pause
 * execution to request human input, approval, or feedback before continuing.
 */
export interface HumanInTheLoopCapabilities {
  /** Set `true` if the agent supports any form of human-in-the-loop interaction. */
  supported?: boolean;
  /** Set `true` if the agent can pause and request explicit approval before
   *  performing sensitive actions (e.g., sending emails, deleting data). */
  approvals?: boolean;
  /** Set `true` if the agent allows humans to intervene and modify its plan mid-execution. */
  interventions?: boolean;
  /** Set `true` if the agent can incorporate user feedback (thumbs up/down, corrections)
   *  to improve its behavior within the current session. */
  feedback?: boolean;
  /** Set `true` if the agent participates in the AG-UI interrupt protocol
   *  (emits RUN_FINISHED with outcome={ type: "interrupt", interrupts: [...] },
   *  accepts resume[]). */
  interrupts?: boolean;
  /** Set `true` if tool-call interrupts accept editedArgs in the resume payload.
   *  Only meaningful when interrupts is true. */
  approveWithEdits?: boolean;
}

/**
 * A typed, categorized snapshot of an agent's current capabilities.
 * Returned by `getCapabilities()` on `AbstractAgent`.
 *
 * All fields are optional — agents only declare what they support.
 * Omitted fields mean the capability is not declared (unknown), not that
 * it's unsupported.
 *
 * The `custom` field is an escape hatch for integration-specific capabilities
 * that don't fit into the standard categories.
 */
export interface AgentCapabilities {
  /** Agent identity and metadata. */
  identity?: IdentityCapabilities;
  /** Supported transport mechanisms (SSE, WebSocket, binary, etc.). */
  transport?: TransportCapabilities;
  /** Tools the agent provides and tool calling configuration. */
  tools?: ToolsCapabilities;
  /** Output format support (structured output, MIME types). */
  output?: OutputCapabilities;
  /** State and memory management (snapshots, deltas, persistence). */
  state?: StateCapabilities;
  /** Multi-agent coordination (delegation, handoffs, sub-agents). */
  multiAgent?: MultiAgentCapabilities;
  /** Reasoning and thinking support (chain-of-thought, encrypted thinking). */
  reasoning?: ReasoningCapabilities;
  /** Multimodal input/output support (images, audio, video, files). */
  multimodal?: MultimodalCapabilities;
  /** Execution control and limits (code execution, timeouts, iteration caps). */
  execution?: ExecutionCapabilities;
  /** Human-in-the-loop support (approvals, interventions, feedback). */
  humanInTheLoop?: HumanInTheLoopCapabilities;
  /** Integration-specific capabilities not covered by the standard categories. */
  custom?: Record<string, unknown>;
}
