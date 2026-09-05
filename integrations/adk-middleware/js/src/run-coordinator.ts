import {
  EventType,
  type AGUIEvent,
  type Interrupt,
  type RunAgentInput,
  type TokenUsage,
} from "@ag-ui/core";
import {
  StreamingMode,
  getPendingUserInputRequests,
  isWorkflow,
  type RunConfig,
  type Runner,
  type Session,
} from "@google/adk";

import {
  discoverClientToolsets,
  indexAgentTree,
  type AgentTreeIndex,
} from "./agent-tree";
import { AGUIClientToolset } from "./client-toolset";
import type { ADKJSResolvedConfig } from "./config";
import { ADKJSProtocolError } from "./errors";
import { ADKEventTranslator } from "./event-translator";
import { toInterrupt, type PreparedAdkRun } from "./interrupt-bridge";
import { MessageSnapshot } from "./message-snapshot";
import {
  createRunMarkerEvent,
  type ResumeReplayArtifact,
  type RunMarker,
} from "./run-marker";
import { getOrCreateSession, prepareRunInput } from "./session-bridge";
import { stateDeltaFromInput } from "./state-bridge";
import type { SubagentContinuation } from "./subagent-tracker";
import { clone, isRecord, throwIfAborted } from "./value-utils";

type Emit = (event: AGUIEvent) => void;

/** One run, resolved and ready to stream. */
interface ActiveRun {
  input: RunAgentInput;
  signal: AbortSignal;
  emit: Emit;
  runner: Runner;
  session: Session;
  userId: string;
  prepared: PreparedAdkRun;
  translator: ADKEventTranslator;
  messageSnapshot: MessageSnapshot;
}

/** What a run ends with, whether it ran or replayed. */
interface RunOutcome {
  result?: unknown;
  interrupts: Interrupt[];
  usage?: TokenUsage[];
}

function runFinishedEvent(
  input: RunAgentInput,
  outcome: RunOutcome,
): AGUIEvent {
  return {
    type: EventType.RUN_FINISHED,
    threadId: input.threadId,
    runId: input.runId,
    ...(outcome.result !== undefined ? { result: outcome.result } : {}),
    outcome:
      outcome.interrupts.length > 0
        ? { type: "interrupt", interrupts: outcome.interrupts }
        : { type: "success" },
    ...(outcome.usage ? { usage: outcome.usage } : {}),
  };
}

/**
 * Coordinates one AG-UI run: prepare (gate, runner, session, input, tools),
 * stream (ADK events → AG-UI events), finalize (snapshot, run marker,
 * interrupts, RUN_FINISHED). Transport and RUN_STARTED/RUN_ERROR belong to
 * `ADKJSAgent`.
 */
export class ADKRunCoordinator {
  private latestUsage?: TokenUsage[];

  constructor(
    private readonly runtime: ADKJSResolvedConfig,
    /** Shared across clones: `[userId, threadId]` keys with a run in flight. */
    private readonly activeThreads: Set<string>,
  ) {}

  /** Usage collected so far; `RUN_ERROR` reports it after a failed run. */
  getUsage(): TokenUsage[] | undefined {
    return this.latestUsage;
  }

  async execute(
    input: RunAgentInput,
    abortController: AbortController,
    emit: Emit,
  ): Promise<void> {
    const signal = abortController.signal;
    const userId = await this.resolveUserId(input);
    const threadKey = JSON.stringify([userId, input.threadId]);
    if (this.activeThreads.has(threadKey)) {
      throw new ADKJSProtocolError(
        `Another run is already in progress on thread "${input.threadId}". Wait for RUN_FINISHED before starting a new run on the same thread.`,
        "THREAD_BUSY",
      );
    }
    this.activeThreads.add(threadKey);

    const messageSnapshot = new MessageSnapshot(input.messages);
    const emitAndTrack = (event: AGUIEvent): void => {
      messageSnapshot.apply(event);
      emit(event);
    };
    let boundToolsets: readonly AGUIClientToolset[] = [];
    let translator: ADKEventTranslator | undefined;

    try {
      throwIfAborted(signal);
      const runner = this.runtime.createRunner();
      const tree = indexAgentTree(runner.agent);
      const session = await getOrCreateSession(runner, userId, input, signal);
      const prepared = await prepareRunInput(
        runner,
        session,
        input,
        signal,
        tree,
      );
      if (prepared.kind === "replay") {
        this.replay(input, prepared.artifact, emitAndTrack);
        return;
      }
      boundToolsets = this.bindClientToolsets(runner, userId, input);
      throwIfAborted(signal);

      translator = this.createTranslator(tree, prepared, input);
      const run: ActiveRun = {
        input,
        signal,
        emit: emitAndTrack,
        runner,
        session,
        userId,
        prepared,
        translator,
        messageSnapshot,
      };
      const runConfig = this.resolveRunConfig();
      throwIfAborted(signal);

      const owners = await this.stream(run, runConfig);
      await this.finalize(run, owners);
    } finally {
      this.latestUsage = translator?.getUsage();
      try {
        for (const toolset of boundToolsets) {
          toolset.unbindTools(userId, input.threadId);
        }
      } finally {
        this.activeThreads.delete(threadKey);
      }
    }
  }

  /**
   * Drive ADK and translate every event, then close whatever is still open.
   * Returns the sub-agents left suspended on interrupts.
   */
  private async stream(
    run: ActiveRun,
    runConfig: RunConfig,
  ): Promise<ReadonlyMap<string, SubagentContinuation>> {
    const { translator, emit, signal } = run;
    try {
      for await (const event of run.runner.runAsync({
        userId: run.userId,
        sessionId: run.session.id,
        newMessage: run.prepared.content,
        stateDelta: stateDeltaFromInput(run.input, run.session),
        runConfig,
        abortSignal: signal,
        customMetadata: run.prepared.customMetadata,
      })) {
        for (const translated of translator.translate(event)) {
          emit(translated);
        }
      }
    } catch (error) {
      // A failed workflow node ends its sub-agent invocation before the run
      // itself errors; RUN_ERROR needs no other closes.
      for (const translated of translator.drainErrorEvents()) {
        emit(translated);
      }
      throw error;
    }
    // ADK returns silently on abort; an interrupted run must not close its
    // sub-agents as succeeded.
    throwIfAborted(signal);
    const finished = translator.finish();
    for (const translated of finished.events) {
      emit(translated);
    }
    return finished.interruptOwners;
  }

  /** Final state, the run marker, pending interrupts, and RUN_FINISHED. */
  private async finalize(
    run: ActiveRun,
    owners: ReadonlyMap<string, SubagentContinuation>,
  ): Promise<void> {
    const { translator, input, signal, emit } = run;
    const state = translator.getState();
    const result = translator.getResult();
    const usage = translator.getUsage();
    emit({ type: EventType.STATE_SNAPSHOT, snapshot: state });

    const latest = await run.runner.sessionService.getSession({
      appName: run.runner.appName,
      userId: run.userId,
      sessionId: run.session.id,
    });
    throwIfAborted(signal);
    const session = latest ?? run.session;

    const pending = getPendingUserInputRequests(session.events);
    const continuations: RunMarker["continuations"] = {};
    for (const request of pending) {
      const owner = owners.get(request.interruptId);
      if (owner) {
        continuations[request.interruptId] = owner;
      }
    }
    const interrupts = pending.map((request) =>
      toInterrupt(
        request,
        this.runtime.subagents === "attributed" ? owners : undefined,
      ),
    );
    const messages = run.messageSnapshot.getMessages();

    const marker: RunMarker = {
      runId: input.runId,
      emittedMessageIds: translator.getEmittedMessageIds(),
      ...(Object.keys(continuations).length > 0 ? { continuations } : {}),
      ...(run.prepared.resumeFingerprint
        ? {
            resume: {
              fingerprint: run.prepared.resumeFingerprint,
              replay: {
                state: clone(state),
                messages,
                interrupts: clone(interrupts),
                ...(result !== undefined ? { result: clone(result) } : {}),
                ...(usage ? { usage: clone(usage) } : {}),
              },
            },
          }
        : {}),
    };
    if (
      marker.emittedMessageIds.length > 0 ||
      marker.continuations ||
      marker.resume
    ) {
      await run.runner.sessionService.appendEvent({
        session,
        event: createRunMarkerEvent(marker),
      });
    }

    if (interrupts.length > 0) {
      emit({ type: EventType.MESSAGES_SNAPSHOT, messages });
    }
    emit(runFinishedEvent(input, { result, interrupts, usage }));
  }

  /** An identical retry of a completed resume replays its recorded outcome. */
  private replay(
    input: RunAgentInput,
    artifact: ResumeReplayArtifact,
    emit: Emit,
  ): void {
    emit({ type: EventType.STATE_SNAPSHOT, snapshot: artifact.state });
    emit({ type: EventType.MESSAGES_SNAPSHOT, messages: artifact.messages });
    emit(runFinishedEvent(input, artifact));
  }

  private createTranslator(
    tree: AgentTreeIndex,
    prepared: PreparedAdkRun,
    input: RunAgentInput,
  ): ADKEventTranslator {
    return new ADKEventTranslator(
      input.state ?? {},
      this.runtime.emitRawEvents,
      this.runtime.usageProvider,
      {
        tree,
        continuations: prepared.continuations,
        answeredInterruptIds: new Set(
          (input.resume ?? []).map((entry) => entry.interruptId),
        ),
        mode: this.runtime.subagents,
      },
    );
  }

  /**
   * Frontend tools reach ADK through an `AGUIClientToolset`. One placed on
   * an agent (or supplied via `clientToolsets`) is used as is; otherwise the
   * bridge attaches its own to the root LlmAgent, once per runner instance.
   */
  private bindClientToolsets(
    runner: Runner,
    userId: string,
    input: RunAgentInput,
  ): readonly AGUIClientToolset[] {
    const placed = discoverClientToolsets(runner);
    const explicit = this.runtime.clientToolsets;
    if (explicit?.some((toolset) => !placed.includes(toolset))) {
      throw new ADKJSProtocolError(
        "Every entry in clientToolsets must be placed in the tools of an agent in the tree, or ADK never calls it.",
        "CLIENT_TOOLSET_NOT_PLACED",
      );
    }
    let toolsets: readonly AGUIClientToolset[] = explicit ?? placed;
    if (toolsets.length === 0 && input.tools.length > 0) {
      toolsets = [attachClientToolset(runner)];
    }
    for (const toolset of toolsets) {
      toolset.bindTools(userId, input.threadId, input.tools);
    }
    return toolsets;
  }

  private async resolveUserId(input: RunAgentInput): Promise<string> {
    const userId =
      typeof this.runtime.userId === "function"
        ? await this.runtime.userId(input)
        : this.runtime.userId;
    if (!userId) {
      throw new ADKJSProtocolError(
        "ADK userId must resolve to a non-empty string.",
        "INVALID_USER_ID",
      );
    }
    return userId;
  }

  private resolveRunConfig(): RunConfig {
    const runConfig = {
      streamingMode: StreamingMode.SSE,
      ...this.runtime.runConfig,
    };
    if (runConfig.streamingMode === StreamingMode.BIDI) {
      // ADK 2.0 rejects BIDI inside runAsync; fail with a coded protocol error
      // before the run starts instead of surfacing an anonymous throw.
      throw new ADKJSProtocolError(
        "StreamingMode.BIDI is not supported by the AG-UI bridge; use StreamingMode.SSE.",
        "STREAMING_MODE_UNSUPPORTED",
      );
    }
    return runConfig;
  }
}

function attachClientToolset(runner: Runner): AGUIClientToolset {
  const root: unknown = runner.agent;
  if (!isRecord(root) || isWorkflow(root) || !Array.isArray(root.tools)) {
    throw new ADKJSProtocolError(
      "The run carries frontend tools, but the ADK root has no tools list (a Workflow root). Place an AGUIClientToolset on the agent that should receive them.",
      "CLIENT_TOOLS_UNSUPPORTED",
    );
  }
  const toolset = new AGUIClientToolset();
  (root.tools as unknown[]).push(toolset);
  return toolset;
}
