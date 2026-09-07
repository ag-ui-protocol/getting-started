import {
  AbstractAgent,
  type RunAgentInput,
  type BaseEvent,
  type Message,
  type ToolMessage,
  type Tool,
  EventType,
  type RunStartedEvent,
  type RunFinishedEvent,
  type RunErrorEvent,
  type TextMessageStartEvent,
  type TextMessageContentEvent,
  type TextMessageEndEvent,
  type ToolCallStartEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type ToolCallResultEvent,
  type StepStartedEvent,
  type StepFinishedEvent,
  type MessagesSnapshotEvent,
  type RawEvent,
} from "@ag-ui/client";
import { Observable } from "rxjs";

const IAM_TOKEN_URL = "https://iam.cloud.ibm.com/identity/token";
const FETCH_TIMEOUT_MS = 120_000;
const MAX_BUFFER_SIZE = 1024 * 1024; // 1MB

export interface WatsonxAgentConfig {
  region: string;
  instanceId: string;
  agentId: string;
  apiKey?: string;
  bearerToken?: string;
  /**
   * Optional persistence for the mapping of AG-UI threadId to the
   * watsonx-managed thread_id. Defaults to an in-memory Map, which is
   * sufficient when the agent instance lives as long as the conversation.
   * Provide a custom store (e.g. backed by a database) when agent
   * instances are created per-request on a server.
   */
  threadIdStore?: WatsonxThreadIdStore;
}

export interface WatsonxThreadIdStore {
  get(threadId: string): string | undefined | Promise<string | undefined>;
  set(threadId: string, watsonxThreadId: string): unknown | Promise<unknown>;
}

export class WatsonxAgent extends AbstractAgent {
  private region: string;
  private instanceId: string;
  private watsonxAgentId: string;
  private apiKey?: string;
  private cachedToken?: string;
  private tokenExpiresAt = 0;
  private tokenRefreshPromise?: Promise<string>;
  private activeAbortController?: AbortController;
  private stepInProgress = false;
  private threadIdStore: WatsonxThreadIdStore;

  constructor(config: WatsonxAgentConfig) {
    super({ agentId: config.agentId });
    if (!config.apiKey && !config.bearerToken) {
      throw new Error("WatsonxAgent requires either apiKey or bearerToken");
    }
    this.region = config.region;
    this.instanceId = config.instanceId;
    this.watsonxAgentId = config.agentId;
    this.apiKey = config.apiKey;
    this.threadIdStore = config.threadIdStore ?? new Map<string, string>();
    this.cachedToken = config.bearerToken;
    if (config.bearerToken) {
      this.tokenExpiresAt = Date.now() + 55 * 60 * 1000;
    }
  }

  private get baseUrl(): string {
    return `https://api.${this.region}.watson-orchestrate.cloud.ibm.com/instances/${this.instanceId}`;
  }

  private async getToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.tokenExpiresAt) {
      return this.cachedToken;
    }

    if (!this.apiKey) {
      throw new Error(
        "watsonx: bearer token expired and no apiKey provided for refresh",
      );
    }

    if (!this.tokenRefreshPromise) {
      this.tokenRefreshPromise = this.refreshToken().finally(() => {
        this.tokenRefreshPromise = undefined;
      });
    }
    return this.tokenRefreshPromise;
  }

  private async refreshToken(): Promise<string> {
    const response = await fetch(IAM_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn:ibm:params:oauth:grant-type:apikey&apikey=${encodeURIComponent(this.apiKey!)}`,
    });

    if (!response.ok) {
      throw new Error(
        `watsonx IAM token exchange failed: HTTP ${response.status}`,
      );
    }

    const data = await response.json();
    if (!data.access_token || typeof data.access_token !== "string") {
      throw new Error("watsonx IAM response missing access_token");
    }
    if (!data.expiration || typeof data.expiration !== "number") {
      throw new Error("watsonx IAM response missing expiration");
    }
    const token: string = data.access_token;
    this.cachedToken = token;
    this.tokenExpiresAt = data.expiration * 1000 - 60_000;
    return token;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const abortController = new AbortController();
      this.activeAbortController = abortController;
      this.stream(input, subscriber, abortController.signal)
        .then(() => subscriber.complete())
        .catch((err) => {
          if (this.stepInProgress) {
            subscriber.next({
              type: EventType.STEP_FINISHED,
              stepName: "watsonx-orchestrate",
            } as StepFinishedEvent);
            this.stepInProgress = false;
          }
          const message =
            err instanceof Error
              ? `watsonx request failed: ${err.message.slice(0, 200)}`
              : "watsonx request failed";
          const errorEvent: RunErrorEvent = {
            type: EventType.RUN_ERROR,
            message,
            code: "WATSONX_ERROR",
          };
          subscriber.next(errorEvent);
          subscriber.complete();
        })
        .finally(() => {
          this.activeAbortController = undefined;
        });

      return () => abortController.abort();
    });
  }

  private async stream(
    input: RunAgentInput,
    subscriber: import("rxjs").Subscriber<BaseEvent>,
    signal: AbortSignal,
  ): Promise<void> {
    const { threadId, runId, messages } = input;

    const runStarted: RunStartedEvent = {
      type: EventType.RUN_STARTED,
      threadId,
      runId,
    };
    subscriber.next(runStarted);

    // Emit TOOL_CALL_RESULT for any tool messages in the input,
    // mirroring langgraph's pattern of surfacing tool results the client sent.
    for (const msg of messages) {
      if (msg.role === "tool") {
        const toolMsg = msg as ToolMessage;
        const toolResult: ToolCallResultEvent = {
          type: EventType.TOOL_CALL_RESULT,
          messageId: toolMsg.id,
          toolCallId: toolMsg.toolCallId,
          content: toolMsg.content,
          role: "tool",
        };
        subscriber.next(toolResult);
      }
    }

    // watsonx orchestrate manages conversation state server-side, keyed by a
    // thread_id it issues in the SSE stream. It ignores client-invented IDs
    // (creating a fresh thread instead) and only acts on the last user
    // message in the payload. So: reuse the watsonx thread_id captured from
    // a previous run of this AG-UI thread, and when continuing, send only
    // the messages since the last user message.
    const watsonxThreadId = await this.threadIdStore.get(threadId);
    const watsonxMessages = this.mapMessages(
      watsonxThreadId ? messagesSinceLastUser(messages) : messages,
    );

    const token = await this.getToken();

    const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const combinedSignal = AbortSignal.any([signal, timeoutSignal]);

    const { messages: _, stream: _s, tools: _t, ...safeProps } =
      (input.forwardedProps ?? {}) as Record<string, unknown>;
    const requestBody: Record<string, unknown> = {
      ...safeProps,
      messages: watsonxMessages,
      stream: true,
    };

    if (input.tools && input.tools.length > 0) {
      requestBody.tools = input.tools.map((t: Tool) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description || "",
          parameters: t.parameters ?? {},
        },
      }));
    }

    const stepName = "watsonx-orchestrate";
    const stepStarted: StepStartedEvent = {
      type: EventType.STEP_STARTED,
      stepName,
    };
    subscriber.next(stepStarted);
    this.stepInProgress = true;

    // On the first turn the header is omitted so watsonx creates the thread;
    // its thread_id is captured from the stream and reused on later turns.
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    if (watsonxThreadId) {
      headers["X-IBM-THREAD-ID"] = watsonxThreadId;
    }

    const response = await fetch(
      `${this.baseUrl}/v1/orchestrate/${this.watsonxAgentId}/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: combinedSignal,
      },
    );

    if (!response.ok || !response.body) {
      throw new Error(`watsonx returned HTTP ${response.status}`);
    }

    const reader = response.body
      .pipeThrough(new TextDecoderStream())
      .getReader();

    let msgId: string | null = null;
    let msgStarted = false;
    let accumulatedContent = "";
    let capturedThreadId: string | null = null;
    const activeToolCalls = new Map<
      number,
      { id: string; name: string; ended: boolean }
    >();
    let buffer = "";

    const state = {
      get msgId() {
        return msgId;
      },
      set msgId(v: string | null) {
        msgId = v;
      },
      get msgStarted() {
        return msgStarted;
      },
      set msgStarted(v: boolean) {
        msgStarted = v;
      },
      get accumulatedContent() {
        return accumulatedContent;
      },
      set accumulatedContent(v: string) {
        accumulatedContent = v;
      },
      get watsonxThreadId() {
        return capturedThreadId;
      },
      set watsonxThreadId(v: string | null) {
        capturedThreadId = v;
      },
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += value;
        if (buffer.length > MAX_BUFFER_SIZE) {
          throw new Error("watsonx SSE buffer exceeded 1MB — aborting");
        }
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          this.processSSELine(line, subscriber, activeToolCalls, state);
        }
      }

      // Process remaining buffer after stream ends
      if (buffer.trim().startsWith("data:")) {
        const trimmed = buffer.trim();
        const data = trimmed.startsWith("data: ")
          ? trimmed.slice(6).trim()
          : trimmed.slice(5).trim();
        if (data && data !== "[DONE]") {
          try {
            this.processSSELine(trimmed, subscriber, activeToolCalls, state);
          } catch (e) {
            if (!(e instanceof SyntaxError)) throw e;
          }
        }
      }
    } finally {
      reader.releaseLock();
      // Persist the watsonx-issued thread_id even if the stream errored
      // mid-way, so the next turn continues the same server-side thread.
      if (capturedThreadId && capturedThreadId !== watsonxThreadId) {
        await this.threadIdStore.set(threadId, capturedThreadId);
      }
    }

    for (const [, tc] of activeToolCalls) {
      if (!tc.ended) {
        const toolEnd: ToolCallEndEvent = {
          type: EventType.TOOL_CALL_END,
          toolCallId: tc.id,
        };
        subscriber.next(toolEnd);
      }
    }

    if (msgStarted && msgId) {
      const msgEnd: TextMessageEndEvent = {
        type: EventType.TEXT_MESSAGE_END,
        messageId: msgId,
      };
      subscriber.next(msgEnd);
    }

    // Emit STEP_FINISHED now that streaming is complete.
    const stepFinished: StepFinishedEvent = {
      type: EventType.STEP_FINISHED,
      stepName,
    };
    subscriber.next(stepFinished);
    this.stepInProgress = false;

    // Emit MESSAGES_SNAPSHOT with the full conversation: input messages
    // plus the assistant's response (if any text was generated).
    const snapshotMessages: Message[] = [...messages];
    if (accumulatedContent && msgId) {
      snapshotMessages.push({
        id: msgId,
        role: "assistant",
        content: accumulatedContent,
      });
    }
    const messagesSnapshot: MessagesSnapshotEvent = {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: snapshotMessages,
    };
    subscriber.next(messagesSnapshot);

    const runFinished: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId,
      runId,
    };
    subscriber.next(runFinished);
  }

  private mapMessages(messages: Message[]): Record<string, unknown>[] {
    return messages.map((m) => {
      const base: Record<string, unknown> = {
        role: m.role,
        content:
          typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      };
      if ("toolCallId" in m && m.toolCallId) {
        base.tool_call_id = m.toolCallId;
      }
      if ("toolCalls" in m && m.toolCalls) {
        base.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments || "",
          },
        }));
      }
      return base;
    });
  }

  private processSSELine(
    line: string,
    subscriber: import("rxjs").Subscriber<BaseEvent>,
    activeToolCalls: Map<number, { id: string; name: string; ended: boolean }>,
    state: {
      msgId: string | null;
      msgStarted: boolean;
      accumulatedContent: string;
      watsonxThreadId: string | null;
    },
  ): void {
    // Handle both "data: " and "data:" (without trailing space)
    if (!line.startsWith("data:")) return;
    const data = line.startsWith("data: ")
      ? line.slice(6).trim()
      : line.slice(5).trim();
    if (data === "[DONE]") return;

    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }

    // Emit a RAW event for every parsed SSE chunk, giving consumers
    // access to platform-specific data for debugging.
    const rawEvent: RawEvent = {
      type: EventType.RAW,
      event: chunk,
      source: "watsonx",
    };
    subscriber.next(rawEvent);

    // Chunks carry the watsonx-managed thread_id (also on chunks that have
    // no choices, so this must run before the early return below).
    if (typeof chunk.thread_id === "string" && chunk.thread_id) {
      state.watsonxThreadId = chunk.thread_id;
    }

    const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    if (!choice) return;

    const delta = choice.delta as Record<string, unknown> | undefined;
    if (!delta) return;

    if (delta.tool_calls) {
      const toolCalls = delta.tool_calls as Array<Record<string, unknown>>;
      for (const tc of toolCalls) {
        const idx = (tc.index as number) ?? 0;
        const fn = tc.function as Record<string, string> | undefined;

        if (tc.id && fn?.name) {
          activeToolCalls.set(idx, {
            id: tc.id as string,
            name: fn.name,
            ended: false,
          });
          const toolStart: ToolCallStartEvent = {
            type: EventType.TOOL_CALL_START,
            toolCallId: tc.id as string,
            toolCallName: fn.name,
          };
          subscriber.next(toolStart);
        }

        if (fn?.arguments != null && fn.arguments !== "") {
          const active = activeToolCalls.get(idx);
          if (active) {
            const toolArgs: ToolCallArgsEvent = {
              type: EventType.TOOL_CALL_ARGS,
              toolCallId: active.id,
              delta: fn.arguments,
            };
            subscriber.next(toolArgs);
          }
        }
      }
      // Don't return early — let the finish_reason check below run
      // in case the same chunk also carries finish_reason: "tool_calls"
    }

    if (delta.content != null && delta.content !== "") {
      if (!state.msgStarted) {
        state.msgId = crypto.randomUUID();
        const msgStart: TextMessageStartEvent = {
          type: EventType.TEXT_MESSAGE_START,
          messageId: state.msgId,
          role: "assistant",
        };
        subscriber.next(msgStart);
        state.msgStarted = true;
      }
      state.accumulatedContent += delta.content as string;
      const msgContent: TextMessageContentEvent = {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: state.msgId!,
        delta: delta.content as string,
      };
      subscriber.next(msgContent);
    }

    const finishReason = (choice as Record<string, unknown>).finish_reason;
    if (finishReason === "stop" || finishReason === "tool_calls") {
      // Close open tool calls for "tool_calls" finish reason
      if (finishReason === "tool_calls") {
        for (const [, tc] of activeToolCalls) {
          if (!tc.ended) {
            const toolEnd: ToolCallEndEvent = {
              type: EventType.TOOL_CALL_END,
              toolCallId: tc.id,
            };
            subscriber.next(toolEnd);
            tc.ended = true;
          }
        }
        activeToolCalls.clear();
      }
      // Close open text message for "stop" finish reason
      if (finishReason === "stop" && state.msgStarted && state.msgId) {
        const msgEnd: TextMessageEndEvent = {
          type: EventType.TEXT_MESSAGE_END,
          messageId: state.msgId,
        };
        subscriber.next(msgEnd);
        state.msgStarted = false;
      }
    }
  }

  override abortRun(): void {
    this.activeAbortController?.abort();
    this.activeAbortController = undefined;
  }

  clone(): WatsonxAgent {
    // Use AbstractAgent.clone() to copy base state (messages, state,
    // description, subscribers, middlewares, pendingInterrupts, etc.)
    const cloned = super.clone() as WatsonxAgent;
    // Overlay watsonx-specific fields
    cloned.region = this.region;
    cloned.instanceId = this.instanceId;
    cloned.watsonxAgentId = this.watsonxAgentId;
    cloned.apiKey = this.apiKey;
    cloned.cachedToken = this.cachedToken;
    cloned.tokenExpiresAt = this.tokenExpiresAt;
    cloned.stepInProgress = false;
    // Share the store so the clone continues existing watsonx threads.
    cloned.threadIdStore = this.threadIdStore;
    return cloned;
  }
}

/**
 * When continuing a watsonx-managed thread, only the messages from the last
 * user message onward are new to the server (earlier context lives in the
 * thread). This keeps trailing assistant/tool messages so tool results still
 * reach watsonx.
 */
function messagesSinceLastUser(messages: Message[]): Message[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return messages.slice(i);
    }
  }
  return messages;
}
