import { defaultApplyEvents } from "@/apply/default";
import {
  Message,
  State,
  RunAgentInput,
  BaseEvent,
  AgentCapabilities,
  Interrupt,
} from "@ag-ui/core";

import {
  AgentConfig,
  AgentDebugConfig,
  RunAgentParameters,
  ResolvedAgentDebugConfig,
  resolveAgentDebugConfig,
} from "./types";
import { DebugLogger, createDebugLogger } from "@/debug-logger";
import { v4 as uuidv4 } from "uuid";
import { structuredClone_ } from "@/utils";
import { compareVersions, validate as validateVersion } from "compare-versions";
import { catchError, map, tap } from "rxjs/operators";
import { finalize } from "rxjs/operators";
import { takeUntil } from "rxjs/operators";
import { pipe, Observable, from, of, EMPTY, Subject, defer } from "rxjs";
import { verifyEvents } from "@/verify";
import { convertToLegacyEvents } from "@/legacy/convert";
import { LegacyRuntimeProtocolEvent } from "@/legacy/types";
import { lastValueFrom } from "rxjs";
import { transformChunks } from "@/chunks";
import { enforceEvents } from "@/enforce";
import {
  CompatibilityBoundary,
  compatibilityBoundaryOperator,
} from "@/middleware/compatibility-boundary";
import { AgentStateMutation, AgentSubscriber, runSubscribersWithMutation } from "./subscriber";
import { AGUIConnectNotImplementedError, AGUIError } from "@ag-ui/core";
import { isInterruptExpired } from "@/interrupts";
import {
  Middleware,
  MiddlewareFunction,
  FunctionMiddleware,
  BackwardCompatibility_0_0_39,
  BackwardCompatibility_0_0_45,
  BackwardCompatibility_0_0_47,
  BackwardCompatibility_0_0_57,
} from "@/middleware";
import packageJson from "../../package.json";

/**
 * The protocol version this client declares on every RunAgentInput it builds.
 *
 * Deliberately the protocol LINE, "1.0", not the generated PROTOCOL_VERSION
 * constant (currently "draft"): the wire names what the client speaks, the
 * constant names which spec revision the models were generated from, and at
 * the 1.0 freeze the two collapse into the same string. Also deliberately
 * comparable: "1.0" works with the compareVersions machinery below, where
 * "draft" never could.
 */
export const WIRE_PROTOCOL_VERSION = "1.0";

/** The maxVersion deprecation warns once per process, not once per call. */
let warnedDeprecatedMaxVersion = false;

/**
 * The producer's RUN_STARTED declaration, judged against what this client
 * speaks. Older or absent is the downgrade signal the versioning rules expect
 * a consumer to notice quietly; NEWER means material this client may be
 * stripping, and that deserves a voice.
 *
 * The grammar is exactly the published one — two numeric components — checked
 * BEFORE any comparison: compareVersions would happily read "1", "1.0.0" or
 * "1.x" as equal to "1.0", and the spec says a value outside the grammar is
 * handled like a newer one, not silently accepted.
 */
export const compareDeclaredProtocol = (
  declared: string,
  spoken: string,
): "newer" | "not-newer" | "uninterpretable" => {
  if (!/^\d+\.\d+$/.test(declared)) return "uninterpretable";
  return compareVersions(declared, spoken) > 0 ? "newer" : "not-newer";
};

const warnOnProducerDeclaration = (event: unknown): void => {
  const declared = (event as { protocolVersion?: string }).protocolVersion;
  if (declared === undefined || declared === WIRE_PROTOCOL_VERSION) return;
  switch (compareDeclaredProtocol(declared, WIRE_PROTOCOL_VERSION)) {
    case "uninterpretable":
      console.warn(
        `[ag-ui] The producer declared protocol version '${declared}', which this client cannot interpret.`,
      );
      return;
    case "newer":
      console.warn(
        `[ag-ui] The producer speaks protocol ${declared}; this client speaks ${WIRE_PROTOCOL_VERSION}. Unrecognised material will be stripped with warnings.`,
      );
      return;
    case "not-newer":
      return;
  }
};

export interface RunAgentResult {
  // DEFERRED (PNI-272): tightening this to `unknown` is a breaking change for
  // consumers of a published package, not a lint repair. Left for a deliberate
  // API decision.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any;
  newMessages: Message[];
}

export abstract class AbstractAgent {
  public agentId?: string;
  public description: string;
  public threadId: string;
  public messages: Message[];
  public state: State;
  private _debug: ResolvedAgentDebugConfig;
  private _debugLogger: DebugLogger | undefined;
  public subscribers: AgentSubscriber[] = [];
  public isRunning: boolean = false;
  /** Interrupts emitted by the most recent run that have not yet been resolved.
   *  Populated when RUN_FINISHED arrives with outcome.type === "interrupt".
   *  Cleared when a subsequent run completes successfully. */
  public pendingInterrupts: Interrupt[] = [];
  private middlewares: Middleware[] = [];
  /**
   * One entry per run currently in flight: the subject that detaches it, and
   * the promise that resolves when its pipeline has finished unwinding.
   *
   * A SET, not a single field. Concurrent runs on one agent are supported (see
   * agent-concurrent.test.ts), and a single slot meant the second run
   * overwrote the first one's handle: `detachActiveRun()` then tore down only
   * the newest run and returned immediately, while the older one kept
   * processing its stream with nothing left that could ever stop it.
   */
  private activeRuns = new Set<{ detach$: Subject<void>; completion: Promise<void> }>();

  /** Breaks the alias cycle for an override that defers to super.maxVersion. */
  private resolvingPeerCeiling = false;

  get maxProtocolVersion(): string {
    // Already resolving: a `maxVersion` override has deferred back to the
    // alias it is standing in for. Both spellings of that deferral land here —
    // `super.maxVersion` reaches the base alias below, and
    // `this.maxProtocolVersion` reaches this getter — so the guard has to be
    // read on BOTH sides or the second spelling recurses until the stack
    // blows. Answering with the default ends the cycle in one hop.
    if (this.resolvingPeerCeiling) {
      return packageJson.version;
    }
    // A subclass that still overrides the deprecated name keeps working: the
    // override is what this getter answers with, so every internal gate that
    // reads maxProtocolVersion sees the pinned value the integration set.
    let proto = Object.getPrototypeOf(this);
    while (proto && proto !== AbstractAgent.prototype) {
      if (Object.getOwnPropertyDescriptor(proto, "maxVersion")) {
        // Save/restore rather than a bare `= false` in `finally`. Today the
        // two are equivalent and provably so: the early return at the top of
        // this getter fires whenever the flag is already set, so this line is
        // only ever reached with it false and `wasResolving` can never be
        // true. It is written this way so that the clearing stays correct if
        // that early return is ever relaxed to allow a nested resolution — the
        // shape a reader would otherwise have to re-derive. What the tests can
        // pin is the property that matters, that the flag does not stay SET
        // (agent-peer-ceiling.test.ts, "clears the guard after a resolution").
        const wasResolving = this.resolvingPeerCeiling;
        this.resolvingPeerCeiling = true;
        try {
          return this.maxVersion;
        } finally {
          this.resolvingPeerCeiling = wasResolving;
        }
      }
      proto = Object.getPrototypeOf(proto);
    }
    return packageJson.version;
  }

  /**
   * @deprecated Use {@link maxProtocolVersion}. Same value, honest name: this
   * is the ceiling the PEER speaks, not which protocol this SDK implements —
   * that is the generated PROTOCOL_VERSION constant. Registered in the client
   * package's DEPRECATIONS.md; removal no earlier than 2.0.
   */
  get maxVersion(): string {
    if (this.resolvingPeerCeiling) {
      // Reached via super.maxVersion from an override maxProtocolVersion is
      // already resolving: answer with the default rather than recursing.
      return packageJson.version;
    }
    if (!warnedDeprecatedMaxVersion) {
      warnedDeprecatedMaxVersion = true;
      console.warn(
        "[ag-ui] AbstractAgent.maxVersion is deprecated — use maxProtocolVersion. Same value; the new name says whose version it is and that it is a ceiling.",
      );
    }
    return this.maxProtocolVersion;
  }

  get debug(): ResolvedAgentDebugConfig {
    return this._debug;
  }

  set debug(value: AgentDebugConfig | ResolvedAgentDebugConfig) {
    this._debug = resolveAgentDebugConfig(value as AgentDebugConfig);
    this._debugLogger = createDebugLogger(this._debug);
  }

  get debugLogger(): DebugLogger | undefined {
    return this._debugLogger;
  }

  set debugLogger(value: DebugLogger | boolean | undefined) {
    if (typeof value === "boolean") {
      this._debugLogger = value ? createDebugLogger(resolveAgentDebugConfig(true)) : undefined;
    } else {
      this._debugLogger = value;
    }
  }

  /**
   * The peer ceiling as the constructor's version gates need it: a string
   * compareVersions can actually read. A subclass getter is the only writer,
   * and it can answer with something unusable — most often `undefined`,
   * because class fields initialise after `super()` returns — so the value is
   * judged here rather than deep inside the comparison.
   */
  private resolvedCeilingDuringConstruction(): string {
    const ceiling: unknown = this.maxProtocolVersion;
    if (typeof ceiling !== "string" || !validateVersion(ceiling)) {
      throw new AGUIError(
        `maxProtocolVersion resolved to ${JSON.stringify(ceiling)} during construction, which is not a version this client can compare. A ceiling read from an instance field is not available yet — return a literal from the getter.`,
      );
    }
    return ceiling;
  }

  constructor({
    agentId,
    description,
    threadId,
    initialMessages,
    initialState,
    debug,
  }: AgentConfig = {}) {
    this.agentId = agentId;
    this.description = description ?? "";
    this.threadId = threadId ?? uuidv4();
    this.messages = structuredClone_(initialMessages ?? []);
    this.state = structuredClone_(initialState ?? {});
    this._debug = resolveAgentDebugConfig(debug);
    this._debugLogger = createDebugLogger(this._debug);

    // Resolved ONCE, and checked before it is compared. A subclass ceiling is
    // read through a getter, and this constructor runs before the subclass's
    // instance fields exist — so `get maxProtocolVersion() { return this.pin }`
    // hands back `undefined` here and compareVersions threw "Invalid argument
    // expected string", which named neither the getter nor the field.
    const peerCeiling = this.resolvedCeilingDuringConstruction();

    if (compareVersions(peerCeiling, "0.0.39") <= 0) {
      this.middlewares.unshift(new BackwardCompatibility_0_0_39());
    }

    // Auto-insert BackwardCompatibility_0_0_45 for backward compatibility with
    // the retired THINKING_* events. Registered in the repo-root
    // DEPRECATIONS.md (not this package's own, which tracks a different set
    // under a different schema) with an expiry of 2027-08-24, not removed in
    // 1.0 — see also the note on
    // CompatibilityBoundary, which translates the same shapes innermost and so
    // usually gets to them first.
    if (compareVersions(peerCeiling, "0.0.45") <= 0) {
      this.middlewares.unshift(new BackwardCompatibility_0_0_45());
    }

    // Auto-insert BackwardCompatibility_0_0_47 for backward compatibility
    // with legacy BinaryInputContent (maps to dedicated image/audio/video/document types)
    if (compareVersions(peerCeiling, "0.0.47") <= 0) {
      this.middlewares.unshift(new BackwardCompatibility_0_0_47());
    }

    // Auto-insert BackwardCompatibility_0_0_57 for backward compatibility with
    // pre-subagent agents: strips subagentRunId and drops SUBAGENT_* lifecycle events.
    if (compareVersions(peerCeiling, "0.0.57") <= 0) {
      this.middlewares.unshift(new BackwardCompatibility_0_0_57());
    }
  }

  public subscribe(subscriber: AgentSubscriber) {
    this.subscribers.push(subscriber);
    return {
      unsubscribe: () => {
        this.subscribers = this.subscribers.filter((s) => s !== subscriber);
      },
    };
  }

  abstract run(input: RunAgentInput): Observable<BaseEvent>;

  /**
   * Returns the agent's current capabilities.
   * Optional — subclasses implement this to advertise what they support.
   */
  getCapabilities?(): Promise<AgentCapabilities>;

  public use(...middlewares: (Middleware | MiddlewareFunction)[]): this {
    const normalizedMiddlewares = middlewares.map((middleware) =>
      typeof middleware === "function" ? new FunctionMiddleware(middleware) : middleware,
    );
    this.middlewares.push(...normalizedMiddlewares);
    return this;
  }

  public async runAgent(
    parameters?: RunAgentParameters,
    subscriber?: AgentSubscriber,
  ): Promise<RunAgentResult> {
    try {
      this.isRunning = true;
      this.agentId = this.agentId ?? uuidv4();
      const input = this.prepareRunAgentInput(parameters);

      this.debugLogger?.lifecycle("LIFECYCLE", "Run started:", {
        agentId: this.agentId,
        threadId: this.threadId,
      });

      let result: unknown = undefined;
      const currentMessageIds = new Set(this.messages.map((message) => message.id));

      const subscribers: AgentSubscriber[] = [
        {
          onRunStartedEvent: ({ event }) => warnOnProducerDeclaration(event),
          onRunFinishedEvent: (params) => {
            if (params.outcome === "success") {
              result = params.result;
            }
          },
        },
        ...this.subscribers,
        subscriber ?? {},
      ];

      await this.onInitialize(input, subscribers);

      // Per-run detachment signal + completion promise. Held in locals as well
      // as in the set, so every stage below closes over THIS run's handle
      // rather than reading whichever run registered last.
      const detach$ = new Subject<void>();
      let resolveActiveRunCompletion: (() => void) | undefined;
      const completion = new Promise<void>((resolve) => {
        resolveActiveRunCompletion = resolve;
      });
      const activeRun = { detach$, completion };
      this.activeRuns.add(activeRun);

      const pipeline = pipe(
        () => {
          // Build middleware chain using reduceRight so middlewares can intercept runs.
          // The always-on inbound compatibility boundary runs innermost —
          // closest to the wire — so every other middleware and the
          // enforcement stage see 1.0-shaped events. Appended per run and
          // never stored, so it is installed exactly once regardless of
          // use() or clone().
          const chainedAgent = [...this.middlewares, new CompatibilityBoundary()].reduceRight(
            (nextAgent: AbstractAgent, middleware) =>
              ({
                run: (i: RunAgentInput) => middleware.run(i, nextAgent),
                get messages() {
                  return nextAgent.messages;
                },
                get state() {
                  return nextAgent.state;
                },
              }) as AbstractAgent,
            this, // Original agent is the final 'next'
          );

          return chainedAgent.run(input);
        },
        // Enforcement BEFORE expansion: a chunk is an event of its own, so it
        // is validated as one like any other, and expansion then only ever
        // reshapes values already known good. Expanding first handed this stage
        // repaired input — a malformed role arrived as "assistant" — so the
        // same defect was fatal when a producer sent it plainly and invisible
        // when it sent it as a chunk. Verification stays after expansion,
        // because what it checks (messages opening and closing, pairing) only
        // exists once the chunk has become a start and a content event.
        enforceEvents(this.debugLogger),
        transformChunks(this.debugLogger),
        verifyEvents(this.debugLogger),
        // Stop processing immediately when this run is detached
        (source$) => source$.pipe(takeUntil(detach$)),
        (source$) => this.apply(input, source$, subscribers),
        (source$) => this.processApplyEvents(input, source$, subscribers),
        catchError((error) => {
          this.debugLogger?.lifecycle("LIFECYCLE", "Run errored:", {
            agentId: this.agentId,
            error: error instanceof Error ? error.message : String(error),
          });
          this.isRunning = false;
          return this.onError(input, error, subscribers);
        }),
        finalize(() => {
          this.debugLogger?.lifecycle("LIFECYCLE", "Run finished:", {
            agentId: this.agentId,
            threadId: this.threadId,
          });
          this.isRunning = false;
          void this.onFinalize(input, subscribers);
          // Only THIS run leaves the set: a run that ends on its own must not
          // disarm detach for a sibling still in flight.
          this.activeRuns.delete(activeRun);
          resolveActiveRunCompletion?.();
          resolveActiveRunCompletion = undefined;
        }),
      );

      await lastValueFrom(pipeline(of(null)));
      const newMessages = structuredClone_(this.messages).filter(
        (message: Message) => !currentMessageIds.has(message.id),
      );
      return { result, newMessages };
    } finally {
      this.isRunning = false;
    }
  }

  // `input` is part of the published signature: renaming it to `_input` changes
  // the emitted .d.ts that consumers see, so the directive goes here instead.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected connect(input: RunAgentInput): Observable<BaseEvent> {
    throw new AGUIConnectNotImplementedError();
  }
  public async connectAgent(
    parameters?: RunAgentParameters,
    subscriber?: AgentSubscriber,
  ): Promise<RunAgentResult> {
    try {
      this.isRunning = true;
      this.agentId = this.agentId ?? uuidv4();
      const input = this.prepareRunAgentInput(parameters);
      let result: unknown = undefined;
      const currentMessageIds = new Set(this.messages.map((message) => message.id));

      const subscribers: AgentSubscriber[] = [
        {
          onRunStartedEvent: ({ event }) => warnOnProducerDeclaration(event),
          onRunFinishedEvent: (params) => {
            if (params.outcome === "success") {
              result = params.result;
            }
          },
        },
        ...this.subscribers,
        subscriber ?? {},
      ];

      await this.onInitialize(input, subscribers);

      // Per-run detachment signal + completion promise. Held in locals as well
      // as in the set, so every stage below closes over THIS run's handle
      // rather than reading whichever run registered last.
      const detach$ = new Subject<void>();
      let resolveActiveRunCompletion: (() => void) | undefined;
      const completion = new Promise<void>((resolve) => {
        resolveActiveRunCompletion = resolve;
      });
      const activeRun = { detach$, completion };
      this.activeRuns.add(activeRun);

      const pipeline = pipe(
        () => defer(() => this.connect(input)),
        // The connect flow has no middleware chain, so the always-on inbound
        // boundary applies as a plain operator here (composed with enforcement:
        // rxjs pipe() runs out of typed arities beyond nine stages).
        (source$: Observable<BaseEvent>) =>
          enforceEvents(this.debugLogger)(compatibilityBoundaryOperator()(source$)),
        transformChunks(this.debugLogger),
        verifyEvents(this.debugLogger),
        // Stop processing immediately when this run is detached
        (source$) => source$.pipe(takeUntil(detach$)),
        (source$) => this.apply(input, source$, subscribers),
        (source$) => this.processApplyEvents(input, source$, subscribers),
        catchError((error) => {
          this.isRunning = false;
          if (!(error instanceof AGUIConnectNotImplementedError)) {
            return this.onError(input, error, subscribers);
          }
          return EMPTY;
        }),
        finalize(() => {
          this.isRunning = false;
          void this.onFinalize(input, subscribers);
          // Only THIS run leaves the set: a run that ends on its own must not
          // disarm detach for a sibling still in flight.
          this.activeRuns.delete(activeRun);
          resolveActiveRunCompletion?.();
          resolveActiveRunCompletion = undefined;
        }),
      );

      // defaultValue prevents EmptyError when catchError returns EMPTY
      // (e.g. ConnectNotImplementedError path)
      await lastValueFrom(pipeline(of(null)), { defaultValue: undefined });
      const newMessages = structuredClone_(this.messages).filter(
        (message: Message) => !currentMessageIds.has(message.id),
      );
      return { result, newMessages };
    } finally {
      this.isRunning = false;
    }
  }

  public abortRun() {}

  public async detachActiveRun(): Promise<void> {
    // Snapshotted first: signalling a run makes it finalize, which removes it
    // from the set, and iterating the live set while it shrinks would skip
    // entries.
    const running = [...this.activeRuns];
    if (running.length === 0) {
      return;
    }
    for (const run of running) {
      run.detach$.next();
      run.detach$.complete();
    }
    await Promise.all(running.map((run) => run.completion));
  }

  protected apply(
    input: RunAgentInput,
    events$: Observable<BaseEvent>,
    subscribers: AgentSubscriber[],
  ): Observable<AgentStateMutation> {
    return defaultApplyEvents(input, events$, this, subscribers, this.debugLogger);
  }

  protected processApplyEvents(
    input: RunAgentInput,
    events$: Observable<AgentStateMutation>,
    subscribers: AgentSubscriber[],
  ): Observable<AgentStateMutation> {
    return events$.pipe(
      tap((event) => {
        if (event.messages) {
          this.messages = event.messages;
          subscribers.forEach((subscriber) => {
            subscriber.onMessagesChanged?.({
              messages: this.messages,
              state: this.state,
              agent: this,
              input,
            });
          });
        }
        // `!== undefined`, not truthiness: State is any JSON value, so a
        // snapshot of `null`, `0`, `""` or `false` is a replacement like any
        // other. The mutation channel only carries `state` when a stage
        // actually set it, so presence is the signal — a truthiness check
        // silently discarded every falsy replacement.
        if (event.state !== undefined) {
          this.state = event.state;
          subscribers.forEach((subscriber) => {
            subscriber.onStateChanged?.({
              state: this.state,
              messages: this.messages,
              agent: this,
              input,
            });
          });
        }
      }),
    );
  }

  protected prepareRunAgentInput(parameters?: RunAgentParameters): RunAgentInput {
    const clonedMessages = structuredClone_(this.messages) as Message[];
    // Egress chokepoint for the no-null rule on attribution (PNI-199 alignment):
    // the verifier and reducer keep event-derived state clean, but messages also
    // enter through the constructor's initialMessages and subscriber mutations,
    // neither of which is schema-checked. A null tag must never be serialized
    // onto the wire — the schemas forbid it, so a receiving agent would reject
    // the whole run. Absent is the only spelling.
    for (const message of clonedMessages) {
      if ((message as { subagentRunId?: string | null }).subagentRunId === null) {
        delete (message as { subagentRunId?: string | null }).subagentRunId;
      }
    }
    const messagesWithoutActivity = clonedMessages.filter((message) => message.role !== "activity");

    return {
      threadId: this.threadId,
      runId: parameters?.runId || uuidv4(),
      // Declared only when the peer's ceiling is not pinned below this
      // client: a downgraded peer predates the field, and an unknown input
      // member is exactly what a strict old parser could reject.
      ...(compareVersions(this.maxProtocolVersion, packageJson.version) >= 0 && {
        protocolVersion: WIRE_PROTOCOL_VERSION,
      }),
      tools: structuredClone_(parameters?.tools ?? []),
      context: structuredClone_(parameters?.context ?? []),
      forwardedProps: structuredClone_(parameters?.forwardedProps ?? {}),
      state: structuredClone_(this.state),
      messages: messagesWithoutActivity,
      ...(parameters?.resume !== undefined ? { resume: structuredClone_(parameters.resume) } : {}),
    };
  }

  protected async onInitialize(input: RunAgentInput, subscribers: AgentSubscriber[]) {
    if (this.pendingInterrupts.length > 0) {
      const resumeIds = new Set((input.resume ?? []).map((r) => r.interruptId));
      const uncovered = this.pendingInterrupts.map((i) => i.id).filter((id) => !resumeIds.has(id));
      if (uncovered.length > 0) {
        throw new AGUIError(
          `Thread has ${uncovered.length} pending interrupt(s) not addressed by resume: ${uncovered.join(", ")}`,
        );
      }
      for (const i of this.pendingInterrupts) {
        if (!isInterruptExpired(i)) continue;
        // Expiry forecloses ANSWERING, not resolving the thread: a cancelled
        // entry is the conforming way past an interrupt nobody answered in
        // time. Throwing on mere presence — which this once did — made an
        // expired interrupt block its thread forever, since coverage is
        // mandatory and no entry could ever satisfy this check.
        const entry = (input.resume ?? []).find((r) => r.interruptId === i.id);
        if (entry?.status !== "cancelled") {
          throw new AGUIError(
            `Interrupt ${i.id} expired at ${i.expiresAt} and can no longer be answered. Cancel it to continue the thread.`,
          );
        }
      }
    }

    const onRunInitializedMutation = await runSubscribersWithMutation(
      subscribers,
      this.messages,
      this.state,
      (subscriber, messages, state) =>
        subscriber.onRunInitialized?.({ messages, state, agent: this, input }),
    );
    if (
      onRunInitializedMutation.messages !== undefined ||
      onRunInitializedMutation.state !== undefined
    ) {
      if (onRunInitializedMutation.messages) {
        this.messages = onRunInitializedMutation.messages;
        // This assignment lands AFTER prepareRunAgentInput sanitized the input,
        // so the no-null rule must be re-applied here — a subscriber mutation is
        // the one writer that can still put a null tag on the wire.
        for (const message of onRunInitializedMutation.messages) {
          if ((message as { subagentRunId?: string | null }).subagentRunId === null) {
            delete (message as { subagentRunId?: string | null }).subagentRunId;
          }
        }
        // The activity filter from prepareRunAgentInput has to be re-applied
        // for the same reason the null-tag sanitisation above does: this
        // assignment lands AFTER that filter ran, and a subscriber replacing
        // the message list is the one writer that can still put an activity
        // message — the consumer's own display state, which no producer owns —
        // onto the wire. The AGENT keeps it; only the input copy is filtered.
        input.messages = onRunInitializedMutation.messages.filter(
          (message) => message.role !== "activity",
        );
        subscribers.forEach((subscriber) => {
          subscriber.onMessagesChanged?.({
            messages: this.messages,
            state: this.state,
            agent: this,
            input,
          });
        });
      }
      // `!== undefined`, as in apply(): a subscriber may legitimately set a
      // falsy state, and the mutation only carries the key when it did.
      if (onRunInitializedMutation.state !== undefined) {
        this.state = onRunInitializedMutation.state;
        input.state = onRunInitializedMutation.state;
        subscribers.forEach((subscriber) => {
          subscriber.onStateChanged?.({
            state: this.state,
            messages: this.messages,
            agent: this,
            input,
          });
        });
      }
    }
  }

  protected onError(input: RunAgentInput, error: Error, subscribers: AgentSubscriber[]) {
    return from(
      runSubscribersWithMutation(
        subscribers,
        this.messages,
        this.state,
        (subscriber, messages, state) =>
          subscriber.onRunFailed?.({ error, messages, state, agent: this, input }),
      ),
    ).pipe(
      map((onRunFailedMutation) => {
        const mutation = onRunFailedMutation as AgentStateMutation;
        if (mutation.messages !== undefined || mutation.state !== undefined) {
          if (mutation.messages !== undefined) {
            this.messages = mutation.messages;
            subscribers.forEach((subscriber) => {
              subscriber.onMessagesChanged?.({
                messages: this.messages,
                state: this.state,
                agent: this,
                input,
              });
            });
          }
          if (mutation.state !== undefined) {
            this.state = mutation.state;
            subscribers.forEach((subscriber) => {
              subscriber.onStateChanged?.({
                state: this.state,
                messages: this.messages,
                agent: this,
                input,
              });
            });
          }
        }

        if (mutation.stopPropagation !== true) {
          // Silently ignore abort errors (e.g. from navigation during active requests).
          // AbortController.abort(reason) can produce:
          //   - A DOMException with name "AbortError"
          //   - The reason value itself as a plain string (e.g. "component unmounted")
          const errStr = String(error);
          const isAbort =
            error.name === "AbortError" ||
            error.message === "Fetch is aborted" ||
            error.message === "signal is aborted without reason" ||
            error.message === "component unmounted" ||
            errStr === "component unmounted";
          if (!isAbort) {
            console.error("Agent execution failed:", error);
            throw error;
          }
        }

        // Return an empty mutation instead of null to prevent EmptyError
        return {} as AgentStateMutation;
      }),
    );
  }

  protected async onFinalize(input: RunAgentInput, subscribers: AgentSubscriber[]) {
    const onRunFinalizedMutation = await runSubscribersWithMutation(
      subscribers,
      this.messages,
      this.state,
      (subscriber, messages, state) =>
        subscriber.onRunFinalized?.({ messages, state, agent: this, input }),
    );

    if (
      onRunFinalizedMutation.messages !== undefined ||
      onRunFinalizedMutation.state !== undefined
    ) {
      if (onRunFinalizedMutation.messages !== undefined) {
        this.messages = onRunFinalizedMutation.messages;
        subscribers.forEach((subscriber) => {
          subscriber.onMessagesChanged?.({
            messages: this.messages,
            state: this.state,
            agent: this,
            input,
          });
        });
      }
      if (onRunFinalizedMutation.state !== undefined) {
        this.state = onRunFinalizedMutation.state;
        subscribers.forEach((subscriber) => {
          subscriber.onStateChanged?.({
            state: this.state,
            messages: this.messages,
            agent: this,
            input,
          });
        });
      }
    }
  }

  public clone() {
    const cloned = Object.create(Object.getPrototypeOf(this));

    cloned.agentId = this.agentId;
    cloned.description = this.description;
    cloned.threadId = this.threadId;
    cloned.messages = structuredClone_(this.messages);
    cloned.state = structuredClone_(this.state);
    cloned._debug = this._debug;
    cloned._debugLogger = this._debugLogger;
    cloned.isRunning = this.isRunning;
    cloned.subscribers = [...this.subscribers];
    cloned.middlewares = [...this.middlewares];
    cloned.pendingInterrupts = structuredClone_(this.pendingInterrupts);
    // Object.create skips class field initializers, so every field this clone
    // needs has to be set here. A clone has no runs in flight of its own — the
    // original's are the original's — so it starts with an empty set rather
    // than a share of the source's.
    cloned.activeRuns = new Set();

    return cloned;
  }

  public addMessage(message: Message) {
    // Add message to the messages array
    this.messages.push(message);

    // Notify subscribers sequentially in the background
    (async () => {
      // Fire onNewMessage sequentially
      for (const subscriber of this.subscribers) {
        await subscriber.onNewMessage?.({
          message,
          messages: this.messages,
          state: this.state,
          agent: this,
        });
      }

      // Fire onNewToolCall if the message is from assistant and contains tool calls
      if (message.role === "assistant" && message.toolCalls) {
        for (const toolCall of message.toolCalls) {
          for (const subscriber of this.subscribers) {
            await subscriber.onNewToolCall?.({
              toolCall,
              messages: this.messages,
              state: this.state,
              agent: this,
            });
          }
        }
      }

      // Fire onMessagesChanged sequentially
      for (const subscriber of this.subscribers) {
        await subscriber.onMessagesChanged?.({
          messages: this.messages,
          state: this.state,
          agent: this,
        });
      }
    })();
  }

  public addMessages(messages: Message[]) {
    // Add all messages to the messages array
    this.messages.push(...messages);

    // Notify subscribers sequentially in the background
    (async () => {
      // Fire onNewMessage and onNewToolCall for each message sequentially
      for (const message of messages) {
        // Fire onNewMessage sequentially
        for (const subscriber of this.subscribers) {
          await subscriber.onNewMessage?.({
            message,
            messages: this.messages,
            state: this.state,
            agent: this,
          });
        }

        // Fire onNewToolCall if the message is from assistant and contains tool calls
        if (message.role === "assistant" && message.toolCalls) {
          for (const toolCall of message.toolCalls) {
            for (const subscriber of this.subscribers) {
              await subscriber.onNewToolCall?.({
                toolCall,
                messages: this.messages,
                state: this.state,
                agent: this,
              });
            }
          }
        }
      }

      // Fire onMessagesChanged once at the end sequentially
      for (const subscriber of this.subscribers) {
        await subscriber.onMessagesChanged?.({
          messages: this.messages,
          state: this.state,
          agent: this,
        });
      }
    })();
  }

  public setMessages(messages: Message[]) {
    // Replace the entire messages array
    this.messages = structuredClone_(messages);

    // Notify subscribers sequentially in the background
    (async () => {
      // Fire onMessagesChanged sequentially
      for (const subscriber of this.subscribers) {
        await subscriber.onMessagesChanged?.({
          messages: this.messages,
          state: this.state,
          agent: this,
        });
      }
    })();
  }

  public setState(state: State) {
    // Replace the entire state
    this.state = structuredClone_(state);

    // Notify subscribers sequentially in the background
    (async () => {
      // Fire onStateChanged sequentially
      for (const subscriber of this.subscribers) {
        await subscriber.onStateChanged?.({
          messages: this.messages,
          state: this.state,
          agent: this,
        });
      }
    })();
  }

  public legacy_to_be_removed_runAgentBridged(
    config?: RunAgentParameters,
  ): Observable<LegacyRuntimeProtocolEvent> {
    this.agentId = this.agentId ?? uuidv4();
    const input = this.prepareRunAgentInput(config);

    // Build middleware chain for legacy bridge
    const runObservable = (() => {
      const chainedAgent = [...this.middlewares, new CompatibilityBoundary()].reduceRight(
        (nextAgent: AbstractAgent, middleware) =>
          ({
            run: (i: RunAgentInput) => middleware.run(i, nextAgent),
            get messages() {
              return nextAgent.messages;
            },
            get state() {
              return nextAgent.state;
            },
          }) as AbstractAgent,
        this,
      );

      return chainedAgent.run(input);
    })();

    return runObservable.pipe(
      enforceEvents(this.debugLogger),
      transformChunks(this.debugLogger),
      verifyEvents(this.debugLogger),
      convertToLegacyEvents(this.threadId, input.runId, this.agentId),
      (events$: Observable<LegacyRuntimeProtocolEvent>) => {
        return events$.pipe(
          map((event) => {
            this.debugLogger?.event("LEGACY", "Event:", event, { type: event.type });
            return event;
          }),
        );
      },
    );
  }
}
