import { z } from "zod/v4";
import { ToolSchema } from "./generated/schemas";

/** Describes a sub-agent that can be invoked by a parent agent. */
export const SubAgentInfoSchema = z.object({
  /** Unique name or identifier of the sub-agent. */
  name: z.string(),
  /** What this sub-agent specializes in. Helps clients build agent selection UIs. */
  description: z.string().optional(),
});

/**
 * Basic metadata about the agent. Useful for discovery UIs, agent marketplaces,
 * and debugging. Set these when you want clients to display agent information
 * or when multiple agents are available and users need to pick one.
 */
export const IdentityCapabilitiesSchema = z.object({
  /** Human-readable name shown in UIs and agent selectors. */
  name: z.string().optional(),
  /** The framework or platform powering this agent (e.g., "langgraph", "mastra", "crewai"). */
  type: z.string().optional(),
  /** What this agent does — helps users and routing logic decide when to use it. */
  description: z.string().optional(),
  /** Semantic version of the agent (e.g., "1.2.0"). Useful for compatibility checks. */
  version: z.string().optional(),
  /** Organization or team that maintains this agent. */
  provider: z.string().optional(),
  /** URL to the agent's documentation or homepage. */
  documentationUrl: z.string().optional(),
  /** Arbitrary key-value pairs for integration-specific identity info. */
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Declares which transport mechanisms the agent supports. Clients use this
 * to pick the best connection strategy. Only set flags to `true` for transports
 * your agent actually handles — omit or set `false` for unsupported ones.
 */
export const TransportCapabilitiesSchema = z.object({
  /** Set `true` if the agent streams responses via SSE. Most agents enable this. */
  streaming: z.boolean().optional(),
  /** Set `true` if the agent accepts persistent WebSocket connections. */
  websocket: z.boolean().optional(),
  /** Set `true` if the agent supports the AG-UI binary protocol (protobuf over HTTP). */
  httpBinary: z.boolean().optional(),
  /** Set `true` if the agent can send async updates via webhooks after a run finishes. */
  pushNotifications: z.boolean().optional(),
  /** Set `true` if the agent supports resuming interrupted streams via sequence numbers. */
  resumable: z.boolean().optional(),
});

/**
 * Tool calling capabilities. Distinguishes between tools the agent itself provides
 * (listed in `items`) and tools the client passes at runtime via `RunAgentInput.tools`.
 * Enable this when your agent can call functions, search the web, execute code, etc.
 */
export const ToolsCapabilitiesSchema = z.object({
  /** Set `true` if the agent can make tool calls at all. Set `false` to explicitly
   *  signal tool calling is disabled even if items are present. */
  supported: z.boolean().optional(),
  /** The tools this agent provides on its own (full JSON Schema definitions).
   *  These are distinct from client-provided tools passed in `RunAgentInput.tools`. */
  items: z.array(ToolSchema).optional(),
  /** Set `true` if the agent can invoke multiple tools concurrently within a single step. */
  parallelCalls: z.boolean().optional(),
  /** Set `true` if the agent accepts and uses tools provided by the client at runtime. */
  clientProvided: z.boolean().optional(),
});

/**
 * Output format support. Enable `structuredOutput` when your agent can return
 * responses conforming to a JSON schema, which is useful for programmatic consumption.
 */
export const OutputCapabilitiesSchema = z.object({
  /** Set `true` if the agent can produce structured JSON output matching a provided schema. */
  structuredOutput: z.boolean().optional(),
  /** MIME types the agent can produce (e.g., `["text/plain", "application/json"]`).
   *  Omit if the agent only produces plain text. */
  supportedMimeTypes: z.array(z.string()).optional(),
});

/**
 * State and memory management capabilities. These tell the client how the agent
 * handles shared state and whether conversation context persists across runs.
 */
export const StateCapabilitiesSchema = z.object({
  /** Set `true` if the agent emits `STATE_SNAPSHOT` events (full state replacement). */
  snapshots: z.boolean().optional(),
  /** Set `true` if the agent emits `STATE_DELTA` events (JSON Patch incremental updates). */
  deltas: z.boolean().optional(),
  /** Set `true` if the agent has long-term memory beyond the current thread
   *  (e.g., vector store, knowledge base, or cross-session recall). */
  memory: z.boolean().optional(),
  /** Set `true` if state is preserved across multiple runs within the same thread.
   *  When `false`, state resets on each run. */
  persistentState: z.boolean().optional(),
});

/**
 * Multi-agent coordination capabilities. Enable these when your agent can
 * orchestrate or hand off work to other agents.
 */
export const MultiAgentCapabilitiesSchema = z.object({
  /** Set `true` if the agent participates in any form of multi-agent coordination. */
  supported: z.boolean().optional(),
  /** Set `true` if the agent can delegate subtasks to other agents while retaining control. */
  delegation: z.boolean().optional(),
  /** Set `true` if the agent can transfer the conversation entirely to another agent. */
  handoffs: z.boolean().optional(),
  /** List of sub-agents this agent can invoke. Helps clients build agent selection UIs. */
  subAgents: z.array(SubAgentInfoSchema).optional(),
});

/**
 * Reasoning and thinking capabilities. Enable these when your agent exposes its
 * internal thought process (e.g., chain-of-thought, extended thinking).
 */
export const ReasoningCapabilitiesSchema = z.object({
  /** Set `true` if the agent produces reasoning/thinking tokens visible to the client. */
  supported: z.boolean().optional(),
  /** Set `true` if reasoning tokens are streamed incrementally (vs. returned all at once). */
  streaming: z.boolean().optional(),
  /** Set `true` if reasoning content is encrypted (zero-data-retention mode).
   *  Clients should expect opaque `encryptedValue` fields instead of readable content. */
  encrypted: z.boolean().optional(),
});

/**
 * Modalities the agent can accept as input. Clients use this to show/hide
 * file upload buttons, audio recorders, image pickers, etc.
 */
export const MultimodalInputCapabilitiesSchema = z.object({
  /** Set `true` if the agent can process image inputs (e.g., screenshots, photos). */
  image: z.boolean().optional(),
  /** Set `true` if the agent can process audio inputs (speech, recordings). */
  audio: z.boolean().optional(),
  /** Set `true` if the agent can process video inputs. */
  video: z.boolean().optional(),
  /** Set `true` if the agent can process PDF documents. */
  pdf: z.boolean().optional(),
  /** Set `true` if the agent can process arbitrary file uploads. */
  file: z.boolean().optional(),
});

/**
 * Modalities the agent can produce as output. Clients use this to anticipate
 * rich content in the agent's response.
 */
export const MultimodalOutputCapabilitiesSchema = z.object({
  /** Set `true` if the agent can generate images as part of its response. */
  image: z.boolean().optional(),
  /** Set `true` if the agent can produce audio output (text-to-speech, audio files). */
  audio: z.boolean().optional(),
});

/**
 * Multimodal input and output support. Organized into `input` and `output`
 * sub-objects so clients can independently query what the agent accepts
 * versus what it produces.
 */
export const MultimodalCapabilitiesSchema = z.object({
  /** Modalities the agent can accept as input (images, audio, video, PDFs, files). */
  input: MultimodalInputCapabilitiesSchema.optional(),
  /** Modalities the agent can produce as output (images, audio). */
  output: MultimodalOutputCapabilitiesSchema.optional(),
});

/**
 * Execution control and limits. Declare these so clients can set expectations
 * about how long or how many steps an agent run might take.
 */
export const ExecutionCapabilitiesSchema = z.object({
  /** Set `true` if the agent can execute code (e.g., Python, JavaScript) during a run. */
  codeExecution: z.boolean().optional(),
  /** Set `true` if code execution happens in a sandboxed/isolated environment.
   *  Only meaningful when `codeExecution` is `true`. */
  sandboxed: z.boolean().optional(),
  /** Maximum number of tool-call/reasoning iterations the agent will perform per run.
   *  Helps clients display progress or set timeout expectations. */
  maxIterations: z.number().optional(),
  /** Maximum wall-clock time (in milliseconds) the agent will run before timing out. */
  maxExecutionTime: z.number().optional(),
});

/**
 * Human-in-the-loop interaction support. Enable these when your agent can pause
 * execution to request human input, approval, or feedback before continuing.
 */
export const HumanInTheLoopCapabilitiesSchema = z.object({
  /** Set `true` if the agent supports any form of human-in-the-loop interaction. */
  supported: z.boolean().optional(),
  /** Set `true` if the agent can pause and request explicit approval before
   *  performing sensitive actions (e.g., sending emails, deleting data). */
  approvals: z.boolean().optional(),
  /** Set `true` if the agent allows humans to intervene and modify its plan mid-execution. */
  interventions: z.boolean().optional(),
  /** Set `true` if the agent can incorporate user feedback (thumbs up/down, corrections)
   *  to improve its behavior within the current session. */
  feedback: z.boolean().optional(),
  /** Set `true` if the agent participates in the AG-UI interrupt protocol
   *  (emits RUN_FINISHED with outcome={ type: "interrupt", interrupts: [...] },
   *  accepts resume[]). */
  interrupts: z.boolean().optional(),
  /** Set `true` if tool-call interrupts accept editedArgs in the resume payload.
   *  Only meaningful when interrupts is true. */
  approveWithEdits: z.boolean().optional(),
});

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
export const AgentCapabilitiesSchema = z.object({
  /** Agent identity and metadata. */
  identity: IdentityCapabilitiesSchema.optional(),
  /** Supported transport mechanisms (SSE, WebSocket, binary, etc.). */
  transport: TransportCapabilitiesSchema.optional(),
  /** Tools the agent provides and tool calling configuration. */
  tools: ToolsCapabilitiesSchema.optional(),
  /** Output format support (structured output, MIME types). */
  output: OutputCapabilitiesSchema.optional(),
  /** State and memory management (snapshots, deltas, persistence). */
  state: StateCapabilitiesSchema.optional(),
  /** Multi-agent coordination (delegation, handoffs, sub-agents). */
  multiAgent: MultiAgentCapabilitiesSchema.optional(),
  /** Reasoning and thinking support (chain-of-thought, encrypted thinking). */
  reasoning: ReasoningCapabilitiesSchema.optional(),
  /** Multimodal input/output support (images, audio, video, files). */
  multimodal: MultimodalCapabilitiesSchema.optional(),
  /** Execution control and limits (code execution, timeouts, iteration caps). */
  execution: ExecutionCapabilitiesSchema.optional(),
  /** Human-in-the-loop support (approvals, interventions, feedback). */
  humanInTheLoop: HumanInTheLoopCapabilitiesSchema.optional(),
  /** Integration-specific capabilities not covered by the standard categories. */
  custom: z.record(z.string(), z.unknown()).optional(),
});

/** Describes a sub-agent that can be invoked by a parent agent. */
export type SubAgentInfo = z.infer<typeof SubAgentInfoSchema>;
/** Agent identity and metadata for discovery UIs, marketplaces, and debugging. */
export type IdentityCapabilities = z.infer<typeof IdentityCapabilitiesSchema>;
/** Supported transport mechanisms (SSE, WebSocket, binary protocol, push notifications). */
export type TransportCapabilities = z.infer<typeof TransportCapabilitiesSchema>;
/** Tool calling support and agent-provided tool definitions. */
export type ToolsCapabilities = z.infer<typeof ToolsCapabilitiesSchema>;
/** Output format support (structured output, MIME types). */
export type OutputCapabilities = z.infer<typeof OutputCapabilitiesSchema>;
/** State and memory management (snapshots, deltas, persistence, long-term memory). */
export type StateCapabilities = z.infer<typeof StateCapabilitiesSchema>;
/** Multi-agent coordination (delegation, handoffs, sub-agent orchestration). */
export type MultiAgentCapabilities = z.infer<typeof MultiAgentCapabilitiesSchema>;
/** Reasoning and thinking visibility (streaming, encrypted chain-of-thought). */
export type ReasoningCapabilities = z.infer<typeof ReasoningCapabilitiesSchema>;
/** Modalities the agent can accept as input (images, audio, video, PDFs, files). */
export type MultimodalInputCapabilities = z.infer<typeof MultimodalInputCapabilitiesSchema>;
/** Modalities the agent can produce as output (images, audio). */
export type MultimodalOutputCapabilities = z.infer<typeof MultimodalOutputCapabilitiesSchema>;
/** Multimodal input/output support (images, audio, video, PDFs, file uploads). */
export type MultimodalCapabilities = z.infer<typeof MultimodalCapabilitiesSchema>;
/** Execution control and limits (code execution, sandboxing, iteration caps, timeouts). */
export type ExecutionCapabilities = z.infer<typeof ExecutionCapabilitiesSchema>;
/** Human-in-the-loop interaction support (approvals, interventions, feedback). */
export type HumanInTheLoopCapabilities = z.infer<typeof HumanInTheLoopCapabilitiesSchema>;
/** A typed, categorized snapshot of an agent's current capabilities. Returned by `getCapabilities()`. */
export type AgentCapabilities = z.infer<typeof AgentCapabilitiesSchema>;
