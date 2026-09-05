import { AbstractAgent } from "@ag-ui/client";
import {
  EventType,
  type AGUIEvent,
  type AgentCapabilities,
  type RunAgentInput,
} from "@ag-ui/core";
import { Runner, isIntentMismatchError } from "@google/adk";
import { Observable } from "rxjs";

import { capabilitiesFor } from "./agent-tree";
import type {
  ADKJSAgentConfig,
  ADKJSLogger,
  ADKJSResolvedConfig,
  ADKJSSubagentMode,
  ADKJSUsageProvider,
  ADKJSUserIdResolver,
} from "./config";
import { ADKJSProtocolError } from "./errors";
import { ADKRunCoordinator } from "./run-coordinator";
import { clone, errorMessage } from "./value-utils";

export type {
  ADKJSAgentConfig,
  ADKJSLogger,
  ADKJSSubagentMode,
  ADKJSUsageProvider,
  ADKJSUserIdResolver,
};

/** AG-UI agent backed by a Google ADK JavaScript agent tree. */
export class ADKJSAgent extends AbstractAgent {
  private readonly runtime: ADKJSResolvedConfig;
  /** `[userId, threadId]` keys with a run in flight; one run per thread. */
  private readonly activeThreads = new Set<string>();
  private readonly activeControllers = new Set<AbortController>();

  constructor(config: ADKJSAgentConfig) {
    const {
      runner,
      appName,
      sessionService,
      agent,
      userId,
      runConfig,
      clientToolsets,
      capabilities,
      emitRawEvents,
      usageProvider,
      subagents,
      logger,
      ...agentConfig
    } = config;
    super(agentConfig);
    const buildRoot = typeof agent === "function" ? agent : () => agent!;
    this.runtime = {
      createRunner: runner
        ? () => runner
        : () =>
            new Runner({
              appName: appName!,
              sessionService: sessionService!,
              agent: buildRoot(),
            }),
      root: runner ? runner.agent : buildRoot(),
      userId,
      runConfig,
      clientToolsets,
      capabilities,
      emitRawEvents: emitRawEvents ?? false,
      usageProvider: usageProvider ?? "google",
      subagents: subagents ?? "off",
      logger: logger ?? console,
    };
  }

  /**
   * CopilotKit clones registered agents for every request. Immutable runtime
   * configuration and the active-thread set are shared; cancellation remains
   * request-local.
   */
  override clone(): ADKJSAgent {
    const cloned = super.clone() as ADKJSAgent;
    Object.assign(cloned, {
      runtime: this.runtime,
      activeThreads: this.activeThreads,
      activeControllers: new Set<AbortController>(),
    });
    return cloned;
  }

  override run(input: RunAgentInput): Observable<AGUIEvent> {
    return new Observable<AGUIEvent>((subscriber) => {
      const abortController = new AbortController();
      this.activeControllers.add(abortController);

      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
        ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
      });
      subscriber.next({
        type: EventType.STATE_SNAPSHOT,
        snapshot: clone(input.state ?? {}),
      });

      const coordinator = new ADKRunCoordinator(
        this.runtime,
        this.activeThreads,
      );
      void coordinator
        .execute(input, abortController, (event) => {
          if (!subscriber.closed) {
            subscriber.next(event);
          }
        })
        .then(() => {
          if (!subscriber.closed) {
            subscriber.complete();
          }
        })
        .catch((error: unknown) => {
          const code =
            error instanceof ADKJSProtocolError
              ? error.code
              : isIntentMismatchError(error)
                ? "INTENT_MISMATCH"
                : abortController.signal.aborted
                  ? "ABORTED"
                  : undefined;
          if (subscriber.closed) {
            // Nobody is listening; do not let the failure vanish.
            this.runtime.logger.error("ADK run failed after the client left", {
              threadId: input.threadId,
              runId: input.runId,
              code,
              message: errorMessage(error),
            });
            return;
          }
          const usage = coordinator.getUsage();
          subscriber.next({
            type: EventType.RUN_ERROR,
            message: errorMessage(error),
            code,
            ...(usage ? { usage } : {}),
          });
          subscriber.complete();
        })
        .finally(() => {
          this.activeControllers.delete(abortController);
        });

      // Unsubscribing mid-run aborts ADK; after completion this is a no-op.
      return () => {
        abortController.abort(
          new DOMException("AG-UI run aborted", "AbortError"),
        );
      };
    });
  }

  override abortRun(): void {
    for (const controller of this.activeControllers) {
      controller.abort(new DOMException("AG-UI run aborted", "AbortError"));
    }
  }

  override async getCapabilities(): Promise<AgentCapabilities> {
    return capabilitiesFor(this.runtime);
  }
}
