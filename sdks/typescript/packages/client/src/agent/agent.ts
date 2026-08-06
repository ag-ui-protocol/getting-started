import { defaultApplyEvents } from "@/apply/default";
import {
  Message,
  State,
  RunAgentInput,
  BaseEvent,
  ToolCall,
  AssistantMessage,
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
import { compareVersions } from "compare-versions";
import { catchError, map, tap } from "rxjs/operators";
import { finalize } from "rxjs/operators";
import { takeUntil } from "rxjs/operators";
import { pipe, Observable, from, of, EMPTY, Subject, defer } from "rxjs";
import { verifyEvents } from "@/verify";
import { convertToLegacyEvents } from "@/legacy/convert";
import { LegacyRuntimeProtocolEvent } from "@/legacy/types";
import { lastValueFrom } from "rxjs";
import { transformChunks } from "@/chunks";
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

export interface RunAgentResult {
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
  // Emits to immediately detach from the active run (stop processing its stream)
  private activeRunDetach$?: Subject<void>;
  private activeRunCompletionPromise?: Promise<void>;

  get maxVersion() {
    return packageJson.version;
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
      this._debugLogger = value
        ? createDebugLogger(resolveAgentDebugConfig(true))
        : undefined;
    } else {
      this._debugLogger = value;
    }
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

    if (compareVersions(this.maxVersion, "0.0.39") <= 0) {
      this.middlewares.unshift(new BackwardCompatibility_0_0_39());
    }

    // Auto-insert BackwardCompatibility_0_0_45 for backward compatibility
    // with legacy THINKING events (deprecated, will be removed in 1.0.0)
    if (compareVersions(this.maxVersion, "0.0.45") <= 0) {
      this.middlewares.unshift(new BackwardCompatibility_0_0_45());
    }

    // Auto-insert BackwardCompatibility_0_0_47 for backward compatibility
    // with legacy BinaryInputContent (maps to dedicated image/audio/video/document types)
    if (compareVersions(this.maxVersion, "0.0.47") <= 0) {
      this.middlewares.unshift(new BackwardCompatibility_0_0_47());
    }

    // Auto-insert BackwardCompatibility_0_0_57 for backward compatibility with
    // pre-subagent agents: strips subagentId and drops SUBAGENT_* lifecycle events.
    if (compareVersions(this.maxVersion, "0.0.57") <= 0) {
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

      let result: any = undefined;
      const currentMessageIds = new Set(this.messages.map((message) => message.id));

      const subscribers: AgentSubscriber[] = [
        {
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

      // Per-run detachment signal + completion promise
      this.activeRunDetach$ = new Subject<void>();
      let resolveActiveRunCompletion: (() => void) | undefined;
      this.activeRunCompletionPromise = new Promise<void>((resolve) => {
        resolveActiveRunCompletion = resolve;
      });

      const pipeline = pipe(
        () => {
          // Build middleware chain using reduceRight so middlewares can intercept runs.
          if (this.middlewares.length === 0) {
            return this.run(input);
          }

          const chainedAgent = this.middlewares.reduceRight(
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
        transformChunks(this.debugLogger),
        verifyEvents(this.debugLogger),
        // Stop processing immediately when this run is detached
        (source$) => source$.pipe(takeUntil(this.activeRunDetach$!)),
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
          resolveActiveRunCompletion?.();
          resolveActiveRunCompletion = undefined;
          this.activeRunCompletionPromise = undefined;
          this.activeRunDetach$ = undefined;
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
      let result: any = undefined;
      const currentMessageIds = new Set(this.messages.map((message) => message.id));

      const subscribers: AgentSubscriber[] = [
        {
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

      // Per-run detachment signal + completion promise
      this.activeRunDetach$ = new Subject<void>();
      let resolveActiveRunCompletion: (() => void) | undefined;
      this.activeRunCompletionPromise = new Promise<void>((resolve) => {
        resolveActiveRunCompletion = resolve;
      });

      const pipeline = pipe(
        () => defer(() => this.connect(input)),
        transformChunks(this.debugLogger),
        verifyEvents(this.debugLogger),
        // Stop processing immediately when this run is detached
        (source$) => source$.pipe(takeUntil(this.activeRunDetach$!)),
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
          resolveActiveRunCompletion?.();
          resolveActiveRunCompletion = undefined;
          this.activeRunCompletionPromise = undefined;
          this.activeRunDetach$ = undefined;
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
    if (!this.activeRunDetach$) {
      return;
    }
    const completion = this.activeRunCompletionPromise ?? Promise.resolve();
    this.activeRunDetach$.next();
    this.activeRunDetach$?.complete();
    await completion;
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
        if (event.state) {
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
    const messagesWithoutActivity = clonedMessages.filter((message) => message.role !== "activity");

    return {
      threadId: this.threadId,
      runId: parameters?.runId || uuidv4(),
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
      const uncovered = this.pendingInterrupts
        .map((i) => i.id)
        .filter((id) => !resumeIds.has(id));
      if (uncovered.length > 0) {
        throw new AGUIError(
          `Thread has ${uncovered.length} pending interrupt(s) not addressed by resume: ${uncovered.join(", ")}`,
        );
      }
      for (const i of this.pendingInterrupts) {
        if (isInterruptExpired(i)) {
          throw new AGUIError(`Interrupt ${i.id} expired at ${i.expiresAt}`);
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
        input.messages = onRunInitializedMutation.messages;
        subscribers.forEach((subscriber) => {
          subscriber.onMessagesChanged?.({
            messages: this.messages,
            state: this.state,
            agent: this,
            input,
          });
        });
      }
      if (onRunInitializedMutation.state) {
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
      if (this.middlewares.length === 0) {
        return this.run(input);
      }

      const chainedAgent = this.middlewares.reduceRight(
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
