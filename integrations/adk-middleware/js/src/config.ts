import type { AgentConfig } from "@ag-ui/client";
import type { AgentCapabilities, RunAgentInput } from "@ag-ui/core";
import type {
  BaseSessionService,
  Event,
  RunConfig,
  RunnableRoot,
  Runner,
} from "@google/adk";

import type { AGUIClientToolset } from "./client-toolset";

export type ADKJSUserIdResolver = (
  input: RunAgentInput,
) => string | Promise<string>;

export type ADKJSUsageProvider =
  | string
  | ((event: Event) => string | undefined);

/** Receives failures the AG-UI stream can no longer report. */
export type ADKJSLogger = Pick<Console, "warn" | "error">;

/**
 * How sub-agent work is reported on the AG-UI stream.
 * - `off` (default): one stream, nothing attributed — what every client can consume.
 * - `steps`: adds `STEP_STARTED`/`STEP_FINISHED` (`agent:<name>`) per sub-agent
 *   invocation and a `CUSTOM` `MultiAgentHandoff` on each handoff; pre-subagent
 *   event types, so still safe for older clients.
 * - `attributed`: everything in `steps` plus the AG-UI subagent protocol:
 *   `SUBAGENT_STARTED/FINISHED/ERROR` and `subagentRunId` on every event,
 *   message, and interrupt a sub-agent produces. Needs `@ag-ui/client` > 0.0.57.
 */
export type ADKJSSubagentMode = "off" | "steps" | "attributed";

interface ADKJSAgentBaseConfig extends AgentConfig {
  /** ADK sessions are scoped per user. Resolve it from server-side auth. */
  userId: string | ADKJSUserIdResolver;
  runConfig?: RunConfig;
  /**
   * Frontend tools attach to the root agent automatically. Set this to route
   * them to specific agents (place `new AGUIClientToolset()` in their tools).
   */
  clientToolsets?: readonly AGUIClientToolset[];
  /** Explicit model/application-specific capability declarations. */
  capabilities?: AgentCapabilities;
  /**
   * Attach the redacted ADK event as `rawEvent` to every mapped AG-UI event
   * and emit every ADK event as a `RAW` event. Off by default: the
   * `metadata["google-adk"]` block already carries the ids clients need, and
   * raw events double the payload of large tool results.
   */
  emitRawEvents?: boolean;
  /** Token-usage provider label. Defaults to `google`. */
  usageProvider?: ADKJSUsageProvider;
  /** Sub-agent reporting mode. Defaults to `off`. */
  subagents?: ADKJSSubagentMode;
  /** Where a failure goes once the client has disconnected. Defaults to `console`. */
  logger?: ADKJSLogger;
}

export type ADKJSAgentConfig = ADKJSAgentBaseConfig &
  (
    | {
        /** The ADK app name sessions are stored under. */
        appName: string;
        sessionService: BaseSessionService;
        /**
         * The root agent, or a factory for roots that keep per-run state
         * (an ADK `Workflow`). A fresh `Runner` is built for every run.
         */
        agent: RunnableRoot | (() => RunnableRoot);
        runner?: never;
      }
    | {
        /** Escape hatch: bring a fully configured Runner (plugins, services). */
        runner: Runner;
        appName?: never;
        sessionService?: never;
        agent?: never;
      }
  );

/** `ADKJSAgentConfig` resolved once in the constructor. */
export interface ADKJSResolvedConfig {
  createRunner: () => Runner;
  /** A representative root for capability discovery. */
  root: RunnableRoot;
  userId: string | ADKJSUserIdResolver;
  runConfig?: RunConfig;
  clientToolsets?: readonly AGUIClientToolset[];
  capabilities?: AgentCapabilities;
  emitRawEvents: boolean;
  usageProvider: ADKJSUsageProvider;
  subagents: ADKJSSubagentMode;
  logger: ADKJSLogger;
}
