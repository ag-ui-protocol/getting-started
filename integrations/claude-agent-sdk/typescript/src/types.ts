/**
 * Type definitions for AG-UI Claude SDK integration.
 *
 * Only defines types specific to this adapter.
 * For SDK types, import directly from @anthropic-ai/claude-agent-sdk or @anthropic-ai/sdk.
 */

import type { AgentConfig } from "@ag-ui/client";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type {
  RunStartedEvent,
  RunFinishedEvent,
  RunErrorEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ReasoningStartEvent,
  ReasoningMessageStartEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageEndEvent,
  ReasoningEndEvent,
  ReasoningEncryptedValueEvent,
  StateSnapshotEvent,
  MessagesSnapshotEvent,
  CustomEvent,
} from "@ag-ui/core";

/**
 * Configuration for ClaudeAgentAdapter.
 * Combines AG-UI AgentConfig with Claude SDK Options.
 *
 * AgentConfig provides: agentId (maps to Python's "name"), description
 * Options provides: model, systemPrompt, mcpServers, allowedTools, etc.
 *
 * The adapter is a thin protocol translator -- it does not manage the SDK
 * client lifecycle or API keys. Set ANTHROPIC_API_KEY via environment variable
 * or pass it directly when creating the query stream.
 *
 * @example
 * ```typescript
 * const config: ClaudeAgentAdapterConfig = {
 *   agentId: "my_agent",
 *   description: "A helpful assistant",
 *   model: "claude-haiku-4-5",
 *   systemPrompt: "You are helpful",
 *   permissionMode: "acceptEdits",
 *   allowedTools: ["Read", "Write"],
 * };
 * ```
 */
export type ClaudeAgentAdapterConfig = AgentConfig & Options & {
  /** Maximum number of idle sessions to keep. Default: 1000 */
  maxSessions?: number;
  /** TTL in ms for idle sessions. Default: 30 minutes */
  sessionTtlMs?: number;
  /** Timeout in ms for query() calls. Default: undefined (no timeout) */
  queryTimeoutMs?: number;
};

/**
 * The extra attribution this adapter rides on every event. Not protocol
 * fields: the tolerant validators keep unknown keys, and the strip-and-warn
 * enforcement stage owns dropping them — declared here so the decoration is a
 * type, not a cast.
 *
 * "Owns dropping them" is not free, but not on every event either. Enforcement
 * validates each event against its own schema in `EVENT_SCHEMA_BY_TYPE`, and
 * `RunStartedEventSchema` and `RunFinishedEventSchema` both DECLARE `threadId`
 * and `runId` as required — so on those events the attribution is recognised
 * and kept. It is only on an event whose schema does not declare them —
 * `RUN_ERROR` chief among the ones this adapter emits — that `threadId` and
 * `runId` are unrecognised material a consumer running enforcement strips,
 * warning once per stripped path, per such event.
 */
type AdapterAttribution = {
  threadId?: string;
  runId?: string;
};

/**
 * Union of all AG-UI event types this adapter can emit, each carrying the
 * adapter's attribution fields.
 */
export type ProcessedEvent = AdapterAttribution &
  (
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent
  | ReasoningStartEvent
  | ReasoningMessageStartEvent
  | ReasoningMessageContentEvent
  | ReasoningMessageEndEvent
  | ReasoningEndEvent
  | ReasoningEncryptedValueEvent
  | StateSnapshotEvent
  | MessagesSnapshotEvent
  | CustomEvent);
