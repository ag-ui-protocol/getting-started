import Anthropic from "@anthropic-ai/sdk";
import type { BetaManagedAgentsEventParams } from "@anthropic-ai/sdk/resources/beta/sessions/events";
import type { SessionCreateParams } from "@anthropic-ai/sdk/resources/beta/sessions/sessions";
import { AbstractAgent, EventType } from "@ag-ui/client";
import type { BaseEvent, Message, RunAgentInput, Tool } from "@ag-ui/client";
import { Observable } from "rxjs";
import { BEST_EFFORT_SEND_TIMEOUT_MS, DEFAULT_TURN_TIMEOUT_MS } from "./constants";
import { reportSwallowedFailure } from "./report";
import { InMemorySessionStore } from "./sessions";
import { customToolFrom, normalizeToolName, toolsFingerprint, type CustomToolParams } from "./tools";
import { runTurn, type TurnOutcome } from "./turn";
import type { BackendCustomTool, ManagedAgentsAgentConfig, SessionRecord, SessionStore } from "./types";

type OverrideTools = NonNullable<
  Extract<SessionCreateParams["agent"], { type: "agent_with_overrides" }>["tools"]
>;

/** The text of the given user message (string or multimodal content). */
const userText = (message: Extract<Message, { role: "user" }>): string => {
  if (typeof message.content === "string") return message.content;
  return (message.content ?? [])
    .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
    .join("");
};

/** Whether any user message in the run carries text. */
const hasUserText = (messages: Message[]): boolean =>
  messages.some((message) => message.role === "user" && userText(message).trim().length > 0);

/** A tool message's payload: its content plus any error text. */
const toolResultText = (message: Extract<Message, { role: "tool" }>): string =>
  [message.content, message.error].filter(Boolean).join("\n");

const runError = (message: string, code: string): BaseEvent =>
  ({ type: EventType.RUN_ERROR, message, code }) as BaseEvent;

const ABANDONED_TOOL_TEXT = "The user did not provide a result for this tool call.";

/**
 * The fingerprint stored for a session created without custom tools, i.e. one
 * that runs the managed agent as-is with no override list.
 */
const NO_OVERRIDES_FINGERPRINT = toolsFingerprint([]);

/**
 * The only thing a client is told about a failure this integration did not
 * author. An SDK, session-store or API exception can carry session ids, request
 * paths, backend hostnames or credentials, and the AG-UI client is not
 * necessarily a trusted operator surface — so the cause goes to `onError` and
 * the client gets this plus the machine-readable `code`.
 */
const RUN_FAILED_MESSAGE = "The run failed.";

/**
 * An AG-UI agent backed by Claude Managed Agents. Each AG-UI thread maps to
 * one managed session; each run drives one turn of that session.
 */
export class ManagedAgentsAgent extends AbstractAgent {
  private readonly client: Anthropic;
  private readonly store: SessionStore;
  private readonly backendTools: Map<string, BackendCustomTool>;
  private currentRunAbort: AbortController | null = null;

  // Keyed by session-store identity: the store is the unit of tenancy, so
  // agents (and clones) sharing a store serialize runs per thread, while
  // per-caller stores keep one caller's runs from blocking another's.
  // Keys within a store's set are scoped to this managed agent.
  private static busyThreadsByStore = new WeakMap<SessionStore, Set<string>>();

  private get busyThreads(): Set<string> {
    let set = ManagedAgentsAgent.busyThreadsByStore.get(this.store);
    if (!set) {
      set = new Set<string>();
      ManagedAgentsAgent.busyThreadsByStore.set(this.store, set);
    }
    return set;
  }

  constructor(private config: ManagedAgentsAgentConfig) {
    super(config);
    this.client = config.client ?? new Anthropic();
    this.store = config.sessionStore ?? new InMemorySessionStore();
    this.backendTools = new Map((config.backendTools ?? []).map((tool) => [normalizeToolName(tool.name), tool]));
  }

  /**
   * A copy of this agent that carries its conversation with it.
   *
   * `super.clone()` provides the AbstractAgent half — thread ID, messages,
   * state, subscribers, middleware, debug settings — the way `HttpAgent.clone()`
   * does; constructing a fresh instance instead would silently reset all of it.
   * The client and session store are shared on purpose, so per-run copies see
   * the same thread↔session mappings.
   */
  public clone(): ManagedAgentsAgent {
    const cloned = super.clone() as ManagedAgentsAgent;
    const own = cloned as unknown as {
      config: ManagedAgentsAgentConfig;
      client: Anthropic;
      store: SessionStore;
      backendTools: Map<string, BackendCustomTool>;
      currentRunAbort: AbortController | null;
    };
    // Resolved rather than raw, so a clone of a clone keeps the same client and
    // store instead of constructing new ones from an incomplete config.
    own.config = { ...this.config, client: this.client, sessionStore: this.store };
    own.client = this.client;
    own.store = this.store;
    own.backendTools = this.backendTools;
    // The copy is not mid-run, so it must not be able to abort this one's.
    own.currentRunAbort = null;
    return cloned;
  }

  /**
   * Report a swallowed failure. A broken hook must never break the run: see
   * {@link reportSwallowedFailure}, which absorbs both a synchronous throw and
   * an async hook's rejection.
   *
   * Returns a promise a caller on an async path can await, so an async hook's
   * telemetry is not left racing the end of the run.
   */
  private report(
    operation: string,
    error: unknown,
    ids: { sessionId?: string; threadId?: string } = {},
  ): Promise<void> {
    return reportSwallowedFailure(this.config.onError, operation, error, ids);
  }

  public abortRun() {
    this.currentRunAbort?.abort();
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const disconnect = new AbortController();
      this.currentRunAbort = disconnect;
      const timeoutMs = this.config.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = AbortSignal.any([disconnect.signal, timeout]);

      // A run emits exactly one terminal event. Something failing after the
      // turn already reported an outcome — a session store that rejects the
      // closing write, say — must not append a second RUN_ERROR behind a
      // RUN_ERROR or a RUN_FINISHED. The dropped error still reaches the
      // error hook so it is not lost.
      let terminated = false;
      const emit = (event: BaseEvent) => {
        if (event.type === EventType.RUN_ERROR || event.type === EventType.RUN_FINISHED) {
          if (terminated) {
            if (event.type === EventType.RUN_ERROR) {
              this.report("dropped_terminal_event", new Error(String((event as { message?: unknown }).message ?? "")), {
                threadId: input.threadId,
              });
            }
            return;
          }
          terminated = true;
        }
        subscriber.next(event);
      };

      this.runTurnForInput(input, emit, signal)
        .catch(async (err) => {
          if (disconnect.signal.aborted) {
            // The client went away, so there is nobody to emit to — but the run
            // may have failed for a reason worth knowing about, and this is its
            // only trace. Awaited so an async hook's telemetry is not left
            // racing the run's completion.
            await this.report("run_after_disconnect", err, { threadId: input.threadId });
            return;
          }
          if (timeout.aborted) {
            emit(runError(`The turn exceeded the ${timeoutMs / 1000}s limit and was interrupted.`, "turn_timeout"));
            return;
          }
          // Detail to the hook, not to the client: see RUN_FAILED_MESSAGE.
          await this.report("run_failed", err, { threadId: input.threadId });
          emit(runError(RUN_FAILED_MESSAGE, "run_failed"));
        })
        .finally(() => subscriber.complete());

      return () => {
        disconnect.abort();
        if (this.currentRunAbort === disconnect) this.currentRunAbort = null;
      };
    });
  }

  private async runTurnForInput(
    input: RunAgentInput,
    emit: (event: BaseEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    // RunAgentInput is not validated at runtime; a body without `messages` or
    // `tools` must read as an empty run, not a TypeError.
    input = { ...input, messages: input.messages ?? [], tools: input.tools ?? [] };
    const { threadId, runId } = input;
    let record: SessionRecord | undefined;
    // One key for the session store and the busy-run gate, so a stored session
    // and the gate that serializes access to it can never disagree.
    const key = this.sessionKey(threadId);
    let sessionId: string | undefined;
    emit({ type: EventType.RUN_STARTED, threadId, runId } as BaseEvent);
    if (input.state !== undefined && input.state !== null) {
      emit({ type: EventType.STATE_SNAPSHOT, snapshot: input.state } as BaseEvent);
    }

    // A blank thread id is not a thread: every caller that omitted one would
    // share a single key, and so a single managed session and its history.
    if (typeof threadId !== "string" || threadId.trim().length === 0) {
      emit(runError("This run has no thread id. Every run must carry a non-empty threadId.", "invalid_thread_id"));
      return;
    }

    if (this.busyThreads.has(key)) {
      emit(runError("A run is already in progress on this thread.", "run_in_progress"));
      return;
    }
    // Check for something sendable before touching the API, so a malformed
    // run does not create an orphan session.
    if (!this.hasSendableContent(input.messages)) {
      emit(runError("There is nothing to send: this run has no user message or tool result.", "empty_run"));
      return;
    }
    this.busyThreads.add(key);
    try {
      record = await this.getOrCreateSession(key, threadId, input, emit, signal);
      if (!record) {
        emit(runError("There is nothing to send: a tool result arrived for a thread with no session.", "tool_result_without_session"));
        return;
      }
      // A local the closures below can close over without re-narrowing.
      const session = record;
      sessionId = session.sessionId;
      await this.syncClientTools(session, input.tools, signal);

      const outbound = this.outboundEvents(session, input.messages);
      if (outbound.events.length === 0) {
        emit(runError("There is nothing new to send: no user message or tool result in this run.", "nothing_to_send"));
        return;
      }

      // Some parked tool calls are still unanswered: post what we have and
      // stay parked instead of waiting on a session that will not resume.
      if (outbound.stillParked.length > 0) {
        await this.client.beta.sessions.events.send(session.sessionId, { events: outbound.events }, { signal });
        session.pendingClientToolUseIds = outbound.stillParked;
        session.lastUserMessageId = outbound.lastUserMessageId ?? session.lastUserMessageId;
        await this.store.set(key, record);
        emit({ type: EventType.RUN_FINISHED, threadId, runId } as BaseEvent);
        return;
      }

      const outcome = await runTurn({
        client: this.client,
        sessionId: session.sessionId,
        outbound: outbound.events,
        // Persist each delivery as soon as it lands, so a failure or
        // interruption later in the turn does not re-post it next run: the
        // tool results resume the session even if the follow-ups then fail.
        onResultsSent: async () => {
          session.pendingClientToolUseIds = [];
          await this.store.set(key, session);
        },
        onFollowUpsSent: async () => {
          if (outbound.lastUserMessageId) session.lastUserMessageId = outbound.lastUserMessageId;
          await this.store.set(key, session);
        },
        // Persist a park the moment the call is handed to the UI. A later
        // event can fail the turn before the session confirms the park, and
        // the remote session would then wait on an ID nothing remembers.
        onClientPark: async (toolUseId) => {
          if (session.pendingClientToolUseIds.includes(toolUseId)) return;
          session.pendingClientToolUseIds = [...session.pendingClientToolUseIds, toolUseId];
          await this.store.set(key, session);
        },
        clientTools: new Map((input.tools ?? []).map((tool) => [normalizeToolName(tool.name), tool.name])),
        backendTools: this.backendTools,
        toolConfirmation: this.config.toolConfirmation,
        streamDeltas: this.config.streamDeltas ?? true,
        onError: this.config.onError,
        emit,
        signal,
      });

      await this.recordOutcome(key, session, outcome);
      if (outcome.status !== "errored") {
        emit({ type: EventType.RUN_FINISHED, threadId, runId } as BaseEvent);
      }
    } catch (err) {
      // Interrupt the session while the busy gate is still held, so a user
      // who resends right away is not interrupted by this run's teardown.
      if (signal.aborted && sessionId) {
        const interrupted = await this.client.beta.sessions.events
          .send(sessionId, { events: [{ type: "user.interrupt" }] }, { signal: AbortSignal.timeout(BEST_EFFORT_SEND_TIMEOUT_MS) })
          .then(() => true)
          .catch(async (error: unknown) => {
            await this.report("interrupt", error, { sessionId, threadId });
            return false;
          });
        // A thrown turn never reaches recordOutcome, so reconcile here: the
        // landed interrupt cancelled the wait, and a park recorded during this
        // turn would otherwise be answered against a call that no longer exists.
        if (interrupted && record) await this.forgetParkedCalls(key, record, { sessionId, threadId });
      }
      throw err;
    } finally {
      this.busyThreads.delete(key);
    }
  }

  /**
   * Drop the parked tool calls recorded for this thread, because the session was
   * interrupted and will never answer them. Best-effort: the run is already
   * ending, and a store that refuses the write must not replace the error that
   * got us here.
   */
  private async forgetParkedCalls(
    key: string,
    record: SessionRecord,
    ids: { sessionId?: string; threadId?: string } = {},
  ): Promise<void> {
    if (record.pendingClientToolUseIds.length === 0) return;
    record.pendingClientToolUseIds = [];
    try {
      await this.store.set(key, record);
    } catch (error) {
      await this.report("forget_parked_calls", error, ids);
    }
  }

  /** Whether the run carries a user message with text or a tool result. */
  private hasSendableContent(messages: Message[]): boolean {
    return hasUserText(messages) || messages.some((message) => message.role === "tool");
  }

  /**
   * The key that identifies this thread's state, in the session store and in
   * the busy-run gate alike, so two agents sharing one store neither adopt each
   * other's sessions nor serialize against each other's threads.
   *
   * Every field baked into the remote session at creation is part of the key:
   * none of them can be re-checked or changed on resume, so an agent must never
   * inherit a session created with a different environment, pinned version or
   * vault set. Each is length-prefixed so no two combinations can collide —
   * plain concatenation would let a `managedAgentId` of `support:beta` with
   * thread `t1` and one of `support` with thread `beta:t1` share one record.
   * The thread id is last, so it needs no prefix and may contain anything.
   */
  private sessionKey(threadId: string): string {
    const { managedAgentId, agentVersion, environmentId, vaultIds } = this.config;
    const field = (value: string) => `${value.length}:${value}|`;
    return (
      field(managedAgentId) +
      field(agentVersion === undefined ? "" : String(agentVersion)) +
      field(environmentId) +
      // Sorted: the same vaults in a different order are the same session.
      field([...(vaultIds ?? [])].sort().join(",")) +
      threadId
    );
  }

  /**
   * Reconcile the record with how the turn ended. An errored turn keeps
   * whatever `onClientPark` already persisted: the remote session is still
   * parked on those calls and the next run has to answer them.
   */
  private async recordOutcome(key: string, record: SessionRecord, outcome: TurnOutcome): Promise<void> {
    if (outcome.status === "errored") {
      if (outcome.sessionEnded) await this.store.delete(key);
      // An interrupt that landed cancelled whatever the session was waiting on,
      // so a park recorded during this turn is no longer answerable: posting a
      // result for it next run is rejected as stale and wedges the thread.
      else if (outcome.sessionInterrupted) await this.forgetParkedCalls(key, record);
      return;
    }
    if (outcome.status === "parked") {
      record.pendingClientToolUseIds = outcome.clientToolUseIds;
      await this.store.set(key, record);
      return;
    }
    // The session went idle on end_turn: nothing is awaited any more.
    if (record.pendingClientToolUseIds.length > 0) {
      record.pendingClientToolUseIds = [];
      await this.store.set(key, record);
    }
  }

  /**
   * Work out what to post into the session for this run: results for any
   * tool calls the frontend was asked to run, plus every user message not
   * yet delivered (in order).
   */
  private outboundEvents(
    record: SessionRecord,
    messages: Message[],
  ): { events: BetaManagedAgentsEventParams[]; stillParked: string[]; lastUserMessageId?: string } {
    const toolResult = (toolUseId: string, text: string, isError: boolean): BetaManagedAgentsEventParams => ({
      type: "user.custom_tool_result",
      custom_tool_use_id: toolUseId,
      content: [{ type: "text", text }],
      is_error: isError,
    });

    const answered: BetaManagedAgentsEventParams[] = [];
    const pending = new Set(record.pendingClientToolUseIds);
    for (const message of messages) {
      if (message.role !== "tool" || !pending.has(message.toolCallId)) continue;
      answered.push(toolResult(message.toolCallId, toolResultText(message), Boolean(message.error)));
      pending.delete(message.toolCallId);
    }

    // User messages after the last delivered one; on first contact, just the newest.
    let lastUserMessageId: string | undefined;
    const followUps: BetaManagedAgentsEventParams[] = [];
    const userMessages = messages.filter((message) => message.role === "user");
    const deliveredIndex = userMessages.findIndex((message) => message.id === record.lastUserMessageId);
    const undelivered = deliveredIndex >= 0 ? userMessages.slice(deliveredIndex + 1) : userMessages.slice(-1);
    for (const message of undelivered) {
      const text = userText(message).trim();
      if (!text) continue;
      followUps.push({ type: "user.message", content: [{ type: "text", text }] });
      lastUserMessageId = message.id;
    }

    // The user moved on without answering the tools the frontend was asked
    // to run: fail those calls (in their original order) so the agent can
    // respond to the new message.
    const abandoned: BetaManagedAgentsEventParams[] = [];
    if (lastUserMessageId !== undefined && pending.size > 0) {
      for (const toolUseId of pending) abandoned.push(toolResult(toolUseId, ABANDONED_TOOL_TEXT, true));
      pending.clear();
    }

    return { events: [...abandoned, ...answered, ...followUps], stillParked: [...pending], lastUserMessageId };
  }

  private async getOrCreateSession(
    key: string,
    threadId: string,
    input: RunAgentInput,
    emit: (event: BaseEvent) => void,
    signal: AbortSignal,
  ): Promise<SessionRecord | undefined> {
    const existing = await this.store.get(key);
    if (existing) return existing;

    // A tool result only answers a pending call on an existing session;
    // never create a session to receive one.
    if (!hasUserText(input.messages)) return undefined;

    // The busy-thread gate serializes runs per thread, so creation cannot race.
    const record = await this.createSession(threadId, input.tools ?? [], signal);
    await this.store.set(key, record);
    emit({
      type: EventType.CUSTOM,
      name: "managed_agents.session",
      value: { sessionId: record.sessionId, threadId },
    } as BaseEvent);
    return record;
  }

  /**
   * Create the managed session for a thread. Every API call here takes the run's
   * signal, so `turnTimeoutMs` (and a client disconnect) really do bound the
   * work done while the thread's run gate is held.
   */
  private async createSession(threadId: string, clientTools: Tool[], signal: AbortSignal): Promise<SessionRecord> {
    const { managedAgentId, agentVersion, environmentId } = this.config;
    const customTools = this.customTools(clientTools);
    const title = this.config.sessionTitle?.(threadId) ?? `AG-UI thread ${threadId}`;
    const agentRef = { id: managedAgentId, ...(agentVersion !== undefined && { version: agentVersion }) };

    // An empty custom list means no overrides at all: the session runs the agent
    // as-is, so Console edits to its tools apply without an update from here.
    const registered = customTools.length === 0 ? undefined : await this.mergedTools(customTools, signal);
    const agent: SessionCreateParams["agent"] =
      registered === undefined
        ? { type: "agent", ...agentRef }
        : { type: "agent_with_overrides", ...agentRef, tools: registered };

    const session = await this.client.beta.sessions.create(
      {
        agent,
        environment_id: environmentId,
        title,
        ...(this.config.vaultIds?.length ? { vault_ids: this.config.vaultIds } : {}),
      },
      { signal },
    );
    return {
      sessionId: session.id,
      toolNames: customTools.map((tool) => tool.name),
      toolDefinitionsFingerprint: toolsFingerprint(registered ?? []),
      pendingClientToolUseIds: [],
    };
  }

  /**
   * Frontend tools plus configured backend tools, as custom tool definitions.
   * Keyed by normalized name: on a collision the last definition wins, and
   * a frontend tool always beats a backend tool of the same name, matching
   * dispatch order in the turn loop.
   */
  private customTools(clientTools: Tool[]): CustomToolParams[] {
    const byName = new Map<string, CustomToolParams>();
    for (const tool of this.config.backendTools ?? []) {
      byName.set(normalizeToolName(tool.name), customToolFrom(tool));
    }
    for (const tool of clientTools) {
      const custom = customToolFrom(tool);
      byName.set(custom.name, custom);
    }
    return [...byName.values()];
  }

  /**
   * Keep the session's full replacement tool list aligned with this run.
   *
   * The fingerprint covers the merged list, not just the custom tools: an
   * override session's list is a full replacement frozen at the last update, so
   * editing the agent's own tools in the Console changes what the session should
   * hold while every custom tool stays identical. Comparing custom tools alone
   * declared that a match and left the session on a stale list indefinitely.
   *
   * The cost is re-reading the agent's tools once per run for a session that
   * uses overrides. A session with no custom tools runs the agent as-is, needs
   * no update, and is short-circuited before that read.
   */
  private async syncClientTools(record: SessionRecord, clientTools: Tool[], signal: AbortSignal): Promise<void> {
    const desired = this.customTools(clientTools);
    // A session created without custom tools has no override list to keep in
    // step, and Console edits to the agent reach it on their own.
    if (desired.length === 0 && record.toolDefinitionsFingerprint === NO_OVERRIDES_FINGERPRINT) return;

    // Note this still merges when `desired` is empty but the session does have an
    // override list: it must be replaced with the agent's own tools, not emptied.
    const registered = await this.mergedTools(desired, signal);
    const fingerprint = toolsFingerprint(registered);
    if (record.toolDefinitionsFingerprint === fingerprint) return;

    await this.client.beta.sessions.update(record.sessionId, { agent: { tools: registered } }, { signal });
    record.toolNames = desired.map((tool) => tool.name);
    record.toolDefinitionsFingerprint = fingerprint;
  }

  /**
   * The agent's own tools plus `custom` tools, without duplicate names.
   * Overrides replace the whole list, so the agent's tools are carried
   * along, but a custom tool of the same name wins over the agent's copy.
   */
  private async mergedTools(custom: CustomToolParams[], signal: AbortSignal): Promise<OverrideTools> {
    const names = new Set(custom.map((tool) => tool.name));
    const base = (await this.baseTools(signal)).filter((tool) => tool.type !== "custom" || !names.has(tool.name));
    return [...base, ...custom];
  }

  /** The tools defined on the managed agent itself, fetched fresh so console edits apply. */
  private async baseTools(signal: AbortSignal): Promise<OverrideTools> {
    const agent = await this.client.beta.agents.retrieve(
      this.config.managedAgentId,
      this.config.agentVersion !== undefined ? { version: this.config.agentVersion } : undefined,
      { signal },
    );
    // The read shape is structurally compatible with the params shape.
    return agent.tools as unknown as OverrideTools;
  }
}
