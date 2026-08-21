import type { AgentConfig } from "@ag-ui/client";
import type { AgentCapabilities, RunAgentInput } from "@ag-ui/core";
import type { Event, RunConfig, Runner } from "@google/adk";

import type { AGUIClientToolset } from "./client-toolset";

type MaybePromise<T> = T | Promise<T>;

export type ADKUserIdResolver = (input: RunAgentInput) => MaybePromise<string>;

export type ADKRunnerFactory = (input: RunAgentInput) => MaybePromise<Runner>;

export type ADKRunConfigResolver = (
  input: RunAgentInput,
) => MaybePromise<RunConfig | undefined>;

export type ADKClientToolsetsResolver = (
  runner: Runner,
  input: RunAgentInput,
) => MaybePromise<readonly AGUIClientToolset[]>;

export type ADKUsageProviderResolver =
  | string
  | ((event: Event) => string | undefined);

interface ADKAgentBaseConfig extends AgentConfig {
  userId: string | ADKUserIdResolver;
  runConfig?: RunConfig | ADKRunConfigResolver;
  clientToolsets?: readonly AGUIClientToolset[] | ADKClientToolsetsResolver;
  /** Explicit model/application-specific capability declarations. */
  capabilities?: AgentCapabilities;
  /** Emit every raw ADK event in addition to its mapped AG-UI events. */
  emitRawEvents?: boolean;
  /** Token-usage provider label. Defaults to `google`. */
  usageProvider?: ADKUsageProviderResolver;
}

export type ADKAgentConfig = ADKAgentBaseConfig &
  (
    | {
        /** Shared runners are globally serialized because their toolsets are shared. */
        runner: Runner;
        runnerFactory?: never;
      }
    | {
        /**
         * Creates an independent agent/toolset tree per run. The factory should
         * reuse the intended session service if history must persist.
         */
        runnerFactory: ADKRunnerFactory;
        runner?: never;
      }
  );

export interface ADKRuntimeConfig {
  sharedRunner?: Runner;
  runnerFactory?: ADKRunnerFactory;
  userIdResolver: ADKAgentBaseConfig["userId"];
  runConfigResolver: ADKAgentBaseConfig["runConfig"];
  clientToolsetsResolver: ADKAgentBaseConfig["clientToolsets"];
  emitRawEvents: boolean;
  usageProvider: ADKUsageProviderResolver;
  capabilityOverrides: ADKAgentBaseConfig["capabilities"];
}
