import {
  EventType,
  type AGUIEvent,
  type RunAgentInput,
  type TokenUsage,
} from "@ag-ui/core";
import {
  StreamingMode,
  createEvent,
  type RunConfig,
  type Runner,
} from "@google/adk";

import {
  getAdkWorkflowEventFields,
  getPendingUserInputRequests,
} from "./adk-compat";
import { discoverClientToolsets } from "./agent-tree";
import type { AGUIClientToolset } from "./client-toolset";
import type { ADKRuntimeConfig } from "./config";
import {
  AG_UI_EMITTED_MESSAGE_IDS_METADATA_KEY,
  AG_UI_RESUME_COMPLETED_METADATA_KEY,
  AG_UI_RESUME_FINGERPRINT_METADATA_KEY,
  AG_UI_RESUME_REPLAY_METADATA_KEY,
} from "./constants";
import { ADKProtocolError } from "./errors";
import { ADKEventTranslator } from "./event-translator";
import { toInterrupt, type ResumeReplayArtifact } from "./interrupt-bridge";
import { MessageSnapshot } from "./message-snapshot";
import { getOrCreateSession, prepareRunInput } from "./session-bridge";
import { SharedRunnerMutex } from "./shared-runner-mutex";
import { stateDeltaFromInput } from "./state-bridge";
import { ThreadRunGate } from "./thread-run-gate";
import { clone } from "./value-utils";

type Emit = (event: AGUIEvent) => void;

/** Coordinates one AG-UI run without owning transport or agent lifecycle. */
export class ADKRunCoordinator {
  private latestUsage?: TokenUsage[];

  constructor(
    private readonly runtime: ADKRuntimeConfig,
    private readonly threadRunGate: ThreadRunGate,
    private readonly sharedRunnerMutex: SharedRunnerMutex,
  ) {}

  getUsage(): TokenUsage[] | undefined {
    return this.latestUsage?.map((entry) => ({ ...entry }));
  }

  async execute(
    input: RunAgentInput,
    abortController: AbortController,
    emit: Emit,
  ): Promise<void> {
    const userId = await this.resolveUserId(input);
    const threadKey = JSON.stringify([userId, input.threadId]);
    const releaseThread = this.threadRunGate.tryAcquire(threadKey);
    if (!releaseThread) {
      throw new ADKProtocolError(
        `Another run is already in progress on thread "${input.threadId}". Wait for RUN_FINISHED before starting a new run on the same thread.`,
        "THREAD_BUSY",
      );
    }

    let releaseSharedRunner: (() => void) | undefined;
    let boundToolsets: readonly AGUIClientToolset[] = [];
    let translator: ADKEventTranslator | undefined;
    this.latestUsage = undefined;

    try {
      if (abortController.signal.aborted) {
        throw abortController.signal.reason;
      }

      if (this.runtime.sharedRunner) {
        releaseSharedRunner = await this.sharedRunnerMutex.acquire(
          abortController.signal,
        );
      }

      const runner =
        this.runtime.sharedRunner ?? (await this.runtime.runnerFactory!(input));
      if (abortController.signal.aborted) {
        throw abortController.signal.reason;
      }
      const session = await getOrCreateSession(
        runner,
        userId,
        input,
        abortController.signal,
      );
      const prepared = await prepareRunInput(
        runner,
        session,
        input,
        abortController.signal,
      );
      const messageSnapshot = new MessageSnapshot(input.messages);
      const emitAndTrack = (event: AGUIEvent): void => {
        messageSnapshot.apply(event);
        emit(event);
      };

      if (prepared.kind === "replay") {
        this.emitReplay(input, prepared.artifact, emitAndTrack);
        return;
      }

      boundToolsets = await this.resolveClientToolsets(runner, input);
      if (abortController.signal.aborted) {
        throw abortController.signal.reason;
      }
      if (input.tools.length > 0 && boundToolsets.length === 0) {
        throw new Error(
          "RunAgentInput contains client tools, but no AGUIClientToolset is configured.",
        );
      }
      for (const toolset of boundToolsets) {
        toolset.bindTools(userId, input.threadId, input.tools);
      }

      translator = new ADKEventTranslator(
        input.state,
        this.runtime.emitRawEvents,
        this.runtime.usageProvider,
      );
      const runConfig = await this.resolveRunConfig(input);
      if (abortController.signal.aborted) {
        throw abortController.signal.reason;
      }
      let result: unknown;
      for await (const event of runner.runAsync({
        userId,
        sessionId: input.threadId,
        newMessage: prepared.content,
        stateDelta: stateDeltaFromInput(input, session),
        runConfig,
        abortSignal: abortController.signal,
        customMetadata: prepared.customMetadata,
      })) {
        const workflow = getAdkWorkflowEventFields(event);
        if (workflow.output !== undefined) {
          result = workflow.output;
        }
        for (const translated of translator.translate(event)) {
          emitAndTrack(translated);
        }
      }

      for (const translated of translator.finish()) {
        emitAndTrack(translated);
      }
      if (abortController.signal.aborted) {
        throw abortController.signal.reason;
      }

      const finalState = translator.getState();
      const finalMessages = messageSnapshot.getMessages();
      const usage = translator.getUsage();
      this.latestUsage = usage;
      emitAndTrack({
        type: EventType.STATE_SNAPSHOT,
        snapshot: finalState,
      });

      const latest = await runner.sessionService.getSession({
        appName: runner.appName,
        userId,
        sessionId: input.threadId,
      });
      if (abortController.signal.aborted) {
        throw abortController.signal.reason;
      }
      const emittedMessageIds = translator.getEmittedMessageIds();
      if (emittedMessageIds.length > 0) {
        await runner.sessionService.appendEvent({
          session: latest ?? session,
          event: createEvent({
            invocationId: `ag-ui-message-ids-${input.runId}`,
            author: "user",
            customMetadata: {
              [AG_UI_EMITTED_MESSAGE_IDS_METADATA_KEY]: emittedMessageIds,
            },
          }),
        });
      }
      const interrupts = latest
        ? getPendingUserInputRequests(latest.events).map(toInterrupt)
        : [];

      if (prepared.resumeFingerprint) {
        const artifact: ResumeReplayArtifact = {
          state: clone(finalState),
          ...(interrupts.length > 0 ? { messages: finalMessages } : {}),
          interrupts: clone(interrupts),
          ...(result !== undefined ? { result: clone(result) } : {}),
          ...(usage ? { usage: clone(usage) } : {}),
        };
        await runner.sessionService.appendEvent({
          session: latest ?? session,
          event: createEvent({
            invocationId: `ag-ui-resume-complete-${input.runId}`,
            author: "user",
            customMetadata: {
              [AG_UI_RESUME_FINGERPRINT_METADATA_KEY]:
                prepared.resumeFingerprint,
              [AG_UI_RESUME_COMPLETED_METADATA_KEY]: true,
              [AG_UI_RESUME_REPLAY_METADATA_KEY]: artifact,
            },
          }),
        });
      }

      if (interrupts.length > 0) {
        emitAndTrack({
          type: EventType.MESSAGES_SNAPSHOT,
          messages: finalMessages,
        });
      }
      emitAndTrack({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
        ...(result !== undefined ? { result } : {}),
        outcome:
          interrupts.length > 0
            ? { type: "interrupt", interrupts }
            : { type: "success" },
        ...(usage ? { usage } : {}),
      });
    } finally {
      this.latestUsage = translator?.getUsage() ?? this.latestUsage;
      try {
        for (const toolset of boundToolsets) {
          toolset.unbindTools(userId, input.threadId);
        }
      } finally {
        try {
          releaseSharedRunner?.();
        } finally {
          releaseThread();
        }
      }
    }
  }

  private emitReplay(
    input: RunAgentInput,
    artifact: ResumeReplayArtifact,
    emit: Emit,
  ): void {
    emit({ type: EventType.STATE_SNAPSHOT, snapshot: clone(artifact.state) });
    if (artifact.messages) {
      emit({
        type: EventType.MESSAGES_SNAPSHOT,
        messages: clone(artifact.messages),
      });
    }
    emit({
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
      ...(artifact.result !== undefined
        ? { result: clone(artifact.result) }
        : {}),
      outcome:
        artifact.interrupts.length > 0
          ? { type: "interrupt", interrupts: clone(artifact.interrupts) }
          : { type: "success" },
      ...(artifact.usage ? { usage: clone(artifact.usage) } : {}),
    });
  }

  private async resolveUserId(input: RunAgentInput): Promise<string> {
    const userId =
      typeof this.runtime.userIdResolver === "function"
        ? await this.runtime.userIdResolver(input)
        : this.runtime.userIdResolver;
    if (!userId) {
      throw new Error("ADK userId must resolve to a non-empty string.");
    }
    return userId;
  }

  private async resolveRunConfig(input: RunAgentInput): Promise<RunConfig> {
    const configured =
      typeof this.runtime.runConfigResolver === "function"
        ? await this.runtime.runConfigResolver(input)
        : this.runtime.runConfigResolver;
    return { streamingMode: StreamingMode.SSE, ...configured };
  }

  private async resolveClientToolsets(
    runner: Runner,
    input: RunAgentInput,
  ): Promise<readonly AGUIClientToolset[]> {
    if (!this.runtime.clientToolsetsResolver) {
      return discoverClientToolsets(runner);
    }
    return typeof this.runtime.clientToolsetsResolver === "function"
      ? await this.runtime.clientToolsetsResolver(runner, input)
      : this.runtime.clientToolsetsResolver;
  }
}
