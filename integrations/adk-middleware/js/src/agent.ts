import { AbstractAgent } from "@ag-ui/client";
import {
  EventType,
  type AGUIEvent,
  type AgentCapabilities,
  type RunAgentInput,
} from "@ag-ui/core";
import { Observable } from "rxjs";

import { capabilitiesFor } from "./agent-tree";
import {
  type ADKAgentConfig,
  type ADKClientToolsetsResolver,
  type ADKRunConfigResolver,
  type ADKRunnerFactory,
  type ADKRuntimeConfig,
  type ADKUsageProviderResolver,
  type ADKUserIdResolver,
} from "./config";
import { ADKProtocolError } from "./errors";
import { ADKEventError } from "./event-translator";
import { ADKMessageConversionError } from "./message-converter";
import { ADKRunCoordinator } from "./run-coordinator";
import { SharedRunnerMutex } from "./shared-runner-mutex";
import { ThreadRunGate } from "./thread-run-gate";
import { clone, errorMessage } from "./value-utils";

export type {
  ADKAgentConfig,
  ADKClientToolsetsResolver,
  ADKRunConfigResolver,
  ADKRunnerFactory,
  ADKUsageProviderResolver,
  ADKUserIdResolver,
};

/** Node.js bridge from a Google ADK JS `Runner` to AG-UI. */
export class ADKAgent extends AbstractAgent {
  private readonly runtime: ADKRuntimeConfig;
  private readonly sharedRunnerMutex = new SharedRunnerMutex();
  private readonly threadRunGate = new ThreadRunGate();
  private readonly activeControllers = new Set<AbortController>();

  constructor(config: ADKAgentConfig) {
    const {
      runner,
      runnerFactory,
      userId,
      runConfig,
      clientToolsets,
      capabilities,
      emitRawEvents,
      usageProvider,
      ...agentConfig
    } = config;
    super(agentConfig);
    this.runtime = {
      sharedRunner: runner,
      runnerFactory,
      userIdResolver: userId,
      runConfigResolver: runConfig,
      clientToolsetsResolver: clientToolsets,
      capabilityOverrides: capabilities,
      emitRawEvents: emitRawEvents ?? false,
      usageProvider: usageProvider ?? "google",
    };
  }

  /**
   * CopilotKit clones registered agents for every request. Immutable runtime
   * configuration and concurrency guards are shared; cancellation remains
   * request-local.
   */
  override clone(): ADKAgent {
    const cloned = super.clone() as ADKAgent;
    Object.assign(cloned, {
      runtime: this.runtime,
      sharedRunnerMutex: this.sharedRunnerMutex,
      threadRunGate: this.threadRunGate,
      activeControllers: new Set<AbortController>(),
    });
    return cloned;
  }

  override run(input: RunAgentInput): Observable<AGUIEvent> {
    return new Observable<AGUIEvent>((subscriber) => {
      const abortController = new AbortController();
      this.activeControllers.add(abortController);
      let settled = false;

      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
        ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
      });
      subscriber.next({
        type: EventType.STATE_SNAPSHOT,
        snapshot: clone(input.state),
      });

      const coordinator = new ADKRunCoordinator(
        this.runtime,
        this.threadRunGate,
        this.sharedRunnerMutex,
      );
      void coordinator
        .execute(input, abortController, (event) => {
          if (!subscriber.closed) {
            subscriber.next(event);
          }
        })
        .then(() => {
          settled = true;
          if (!subscriber.closed) {
            subscriber.complete();
          }
        })
        .catch((error: unknown) => {
          settled = true;
          if (!subscriber.closed) {
            const usage = coordinator.getUsage();
            subscriber.next({
              type: EventType.RUN_ERROR,
              message: errorMessage(error),
              code:
                error instanceof ADKEventError ||
                error instanceof ADKProtocolError ||
                error instanceof ADKMessageConversionError
                  ? error.code
                  : abortController.signal.aborted
                    ? "ABORTED"
                    : undefined,
              ...(usage ? { usage } : {}),
            });
            subscriber.complete();
          }
        })
        .finally(() => {
          this.activeControllers.delete(abortController);
        });

      return () => {
        if (!settled) {
          abortController.abort(
            new DOMException("AG-UI run aborted", "AbortError"),
          );
        }
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
