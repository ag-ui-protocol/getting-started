import { EventType, type AGUIEvent } from "@ag-ui/core";
import { isNodeErrorEvent, type Event as AdkEvent } from "@google/adk";

import type { AgentTreeIndex } from "./agent-tree";
import type { ADKJSSubagentMode } from "./config";
import { isRecord } from "./value-utils";

/** Identity retained while a sub-agent waits for an interrupt response. */
export interface SubagentContinuation {
  subagentRunId: string;
  name: string;
  path?: string;
  branch?: string;
  toolCallId?: string;
  parentSubagentRunId?: string;
  parentToolCallId?: string;
  parentMessageId?: string;
}

export interface SubagentTrackerOptions {
  /** The root's events are the parent agent and stay untagged. */
  tree: AgentTreeIndex;
  /** Continuations keyed by the interrupt id being resumed in this run. */
  continuations?: ReadonlyMap<string, SubagentContinuation>;
  /** Interrupt ids answered by this run's resume payload. */
  answeredInterruptIds?: ReadonlySet<string>;
  mode: ADKJSSubagentMode;
  /** Closes the translator's open text/reasoning for an invocation key. */
  closeStream: (key: string) => AGUIEvent[];
}

interface Invocation {
  id: string;
  name: string;
  key: string;
  /** Its last event was partial: a sibling or ancestor event is interleaving,
   *  not ending it (concurrent workflow nodes may share a branch). */
  streaming?: boolean;
  path: string[];
  branch: string[];
  parentId?: string;
  parentToolCallId?: string;
  parentMessageId?: string;
  result?: unknown;
  openedAt: number;
  toolCallId?: string;
}

interface EventScope {
  key: string;
  path: string[];
  branch: string[];
  author: string;
}

interface BegunEvent {
  /** Lifecycle events to emit before anything derived from the ADK event. */
  events: AGUIEvent[];
  /** The invocation key, or null for the parent agent / unknown authors. */
  key: string | null;
  /** `subagentRunId` to stamp on events derived from this ADK event. */
  tag?: string;
}

type CloseOutcome =
  | { type: "success" }
  | { type: "suspended"; interruptIds?: string[] }
  | { type: "error"; message: string; code?: string };

function segments(value: string | undefined): string[] {
  return value ? value.split(".") : [];
}

function sameSegments(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((segment, index) => segment === right[index])
  );
}

function isStrictPrefix(prefix: string[], full: string[]): boolean {
  return (
    prefix.length < full.length &&
    prefix.every((segment, index) => segment === full[index])
  );
}

/** One key per (workflow node path, ADK branch, author); used for streams too. */
export function invocationKey(event: AdkEvent): string {
  return JSON.stringify([
    event.nodeInfo?.path ?? null,
    event.branch ?? null,
    event.author ?? null,
  ]);
}

/**
 * Derives AG-UI subagent lifecycle from the structure of an ADK event stream.
 *
 * ADK has no explicit "sub-agent started/finished" signal: a transfer keeps the
 * branch and changes only the author, a ParallelAgent sub-branches per child,
 * and a workflow node stamps `nodeInfo.path`. ADK runs one branch sequentially,
 * so an invocation ends when a different author appears on its branch or when
 * an ancestor branch/path resumes. Everything still open is closed at the end
 * of the run, which is where a suspended invocation reports its interrupts.
 */
export class SubagentTracker {
  private readonly open = new Map<string, Invocation>();
  private readonly ordinal = new Map<string, number>();
  private readonly lastIdByAgent = new Map<string, string>();
  private readonly raised = new Map<string, Invocation | null>();
  private readonly answered: Set<string>;
  private readonly continuations: Map<string, SubagentContinuation>;
  /** The assistant message that carried each tool call, for spawn links. */
  private readonly callMessages = new Map<string, string>();
  private readonly errorQueue: AGUIEvent[] = [];
  /** Every invocation closed in this run, by id (parent links for finish()). */
  private readonly closed = new Map<string, Invocation>();
  private readonly suspendedIds = new Set<string>();
  private readonly owners = new Map<string, SubagentContinuation>();
  private pendingTransfer?: {
    source?: string;
    target: string;
    toolCallId: string;
    messageId: string;
  };
  /** Non-tool invocations closed since the last one opened: the `from` side
   *  of the next handoff (all fan-in siblings, never a failed node). */
  private closedSinceOpen: Invocation[] = [];
  private sequence = 0;
  private invocationId?: string;

  constructor(private readonly options: SubagentTrackerOptions) {
    this.answered = new Set(options.answeredInterruptIds ?? []);
    this.continuations = new Map(options.continuations ?? []);
  }

  private get attributed(): boolean {
    return this.options.mode === "attributed";
  }

  /** STEP_* and MultiAgentHandoff: pre-subagent event types, safe for any client. */
  private get pipelineEvents(): boolean {
    return this.options.mode !== "off";
  }

  private tagOf(invocation: Invocation | undefined): string | undefined {
    return this.attributed ? invocation?.id : undefined;
  }

  private tagFields(invocation: Invocation | undefined): {
    subagentRunId?: string;
  } {
    const tag = this.tagOf(invocation);
    return tag ? { subagentRunId: tag } : {};
  }

  /** The scope of an event whose author the bridge recognizes, else null. */
  scopeOf(event: AdkEvent): EventScope | null {
    const author = event.author;
    if (!author || author === "user") {
      return null;
    }
    const path = segments(event.nodeInfo?.path);
    if (
      author !== this.options.tree.rootName &&
      !this.options.tree.names.has(author) &&
      path.length === 0
    ) {
      return null;
    }
    return {
      key: invocationKey(event),
      path,
      branch: segments(event.branch),
      author,
    };
  }

  begin(event: AdkEvent): BegunEvent {
    this.invocationId = event.invocationId;
    const scope = this.scopeOf(event);
    if (!scope) {
      return { events: [], key: null };
    }
    const events: AGUIEvent[] = [];
    for (const part of event.content?.parts ?? []) {
      const toolCallId = part.functionResponse?.id;
      if (!toolCallId || this.open.has(`tool:${toolCallId}`)) continue;
      const continuation = this.takeContinuation(
        (c) => c.toolCallId === toolCallId,
      );
      if (continuation) {
        events.push(
          ...this.openTool(
            continuation.name,
            toolCallId,
            continuation.parentMessageId,
            undefined,
            continuation,
          ),
        );
      }
    }
    // Ascent: an ancestor branch/path resumed, so its descendants finished.
    // Sibling: a different author on the same branch means the previous
    // author's segment ended (a node's own children are not siblings).
    for (const invocation of this.openDeepestFirst()) {
      if (invocation.toolCallId || invocation.streaming) continue;
      const descendant =
        isStrictPrefix(scope.branch, invocation.branch) ||
        (sameSegments(scope.branch, invocation.branch) &&
          isStrictPrefix(scope.path, invocation.path));
      const sibling =
        invocation.key !== scope.key &&
        sameSegments(invocation.branch, scope.branch) &&
        !isStrictPrefix(invocation.path, scope.path) &&
        !isStrictPrefix(scope.path, invocation.path);
      if (descendant || sibling) {
        events.push(...this.close(invocation, { type: "success" }));
      }
    }
    if (scope.author === this.options.tree.rootName) {
      return { events, key: null };
    }
    let invocation = this.open.get(scope.key);
    if (!invocation) {
      invocation = this.openInvocation(scope, events);
    }
    invocation.streaming = Boolean(event.partial);
    return { events, key: scope.key, tag: this.tagOf(invocation) };
  }

  private openInvocation(scope: EventScope, events: AGUIEvent[]): Invocation {
    const continuation = this.takeContinuation(
      (c) =>
        !c.toolCallId &&
        c.name === scope.author &&
        (c.path === undefined || c.path === scope.path.join(".")) &&
        (c.branch === undefined || c.branch === scope.branch.join(".")),
    );
    const ordinal = (this.ordinal.get(scope.key) ?? 0) + 1;
    this.ordinal.set(scope.key, ordinal);
    const spawn =
      this.pendingTransfer?.target === scope.author
        ? this.pendingTransfer
        : undefined;
    if (spawn) {
      this.pendingTransfer = undefined;
    }
    // A completed ancestor from an earlier run is not part of this run's tree.
    const parentId = this.resolveParent(scope);
    const invocation: Invocation = {
      id:
        continuation?.subagentRunId ??
        `adk:${this.invocationId ?? "run"}:${scope.path.join(".") || "-"}:${scope.branch.join(".") || "-"}:${scope.author}#${ordinal}`,
      name: scope.author,
      key: scope.key,
      path: scope.path,
      branch: scope.branch,
      ...(parentId ? { parentId } : {}),
      ...(spawn
        ? {
            parentToolCallId: spawn.toolCallId,
            parentMessageId: spawn.messageId,
          }
        : continuation?.parentToolCallId
          ? {
              parentToolCallId: continuation.parentToolCallId,
              ...(continuation.parentMessageId
                ? { parentMessageId: continuation.parentMessageId }
                : {}),
            }
          : {}),
      openedAt: this.sequence++,
    };
    this.open.set(scope.key, invocation);
    this.lastIdByAgent.set(scope.author, invocation.id);

    const handoffFrom = spawn?.source
      ? [spawn.source]
      : this.closedSinceOpen
          .filter((closed) => closed.parentId === invocation.parentId)
          .sort((left, right) => left.openedAt - right.openedAt)
          .map((closed) => closed.name);
    this.closedSinceOpen = [];
    events.push(...this.openEvents(invocation, handoffFrom));
    return invocation;
  }

  private openEvents(
    invocation: Invocation,
    handoffFrom: string[],
  ): AGUIEvent[] {
    const events: AGUIEvent[] = [];
    if (this.attributed) {
      const description = this.options.tree.description.get(invocation.name);
      events.push({
        type: EventType.SUBAGENT_STARTED,
        subagentRunId: invocation.id,
        name: invocation.name,
        ...(description ? { description } : {}),
        ...(invocation.parentId
          ? { parentSubagentRunId: invocation.parentId }
          : {}),
        ...(invocation.parentToolCallId
          ? { parentToolCallId: invocation.parentToolCallId }
          : {}),
        ...(invocation.parentMessageId
          ? { parentMessageId: invocation.parentMessageId }
          : {}),
      });
    }
    if (this.pipelineEvents) {
      events.push({
        type: EventType.STEP_STARTED,
        stepName: `agent:${invocation.name}`,
        ...this.tagFields(invocation),
      });
    }
    if (this.pipelineEvents && handoffFrom.length > 0) {
      events.push({
        type: EventType.CUSTOM,
        name: "MultiAgentHandoff",
        value: { from_nodes: handoffFrom, to_nodes: [invocation.name] },
      });
    }
    return events;
  }

  private takeContinuation(
    matches: (continuation: SubagentContinuation) => boolean,
  ): SubagentContinuation | undefined {
    const found = [...this.continuations.values()].find(matches);
    if (found) {
      // Several interrupts can belong to the same paused invocation.
      for (const [id, continuation] of this.continuations) {
        if (continuation.subagentRunId === found.subagentRunId) {
          this.continuations.delete(id);
        }
      }
    }
    return found;
  }

  private resolveParent(scope: EventScope): string | undefined {
    // Containers (Sequential/Parallel/Loop) never author events, so walk the
    // static tree until an ancestor that has run in this run is found; a
    // closed ancestor is still a valid parent link.
    let ancestor = this.options.tree.parent.get(scope.author);
    while (ancestor !== undefined) {
      const id = this.lastIdByAgent.get(ancestor);
      if (id && ancestor !== this.options.tree.rootName) {
        return id;
      }
      ancestor = this.options.tree.parent.get(ancestor);
    }
    // Workflow nesting: the open invocation with the longest strict path prefix.
    let best: Invocation | undefined;
    for (const invocation of this.open.values()) {
      if (
        sameSegments(invocation.branch, scope.branch) &&
        isStrictPrefix(invocation.path, scope.path) &&
        (!best || invocation.path.length > best.path.length)
      ) {
        best = invocation;
      }
    }
    return best?.id;
  }

  private openDeepestFirst(): Invocation[] {
    return [...this.open.values()].sort(
      (left, right) =>
        right.path.length +
          right.branch.length -
          (left.path.length + left.branch.length) ||
        right.openedAt - left.openedAt,
    );
  }

  /** Interrupts this invocation raised that nobody has answered. */
  private ownedPending(invocation: Invocation): string[] {
    return [...this.raised]
      .filter(
        ([interruptId, owner]) =>
          owner?.id === invocation.id && !this.answered.has(interruptId),
      )
      .map(([interruptId]) => interruptId);
  }

  private close(invocation: Invocation, requested: CloseOutcome): AGUIEvent[] {
    const events = invocation.toolCallId
      ? []
      : this.options.closeStream(invocation.key);
    this.open.delete(invocation.key);
    this.closed.set(invocation.id, invocation);
    if (!invocation.toolCallId && requested.type !== "error") {
      this.closedSinceOpen.push(invocation);
    }
    // A segment that ended with its interrupt still pending is paused, not
    // done — whether it was closed by a sibling, an ancestor, or the run end.
    let outcome = requested;
    if (requested.type === "success") {
      const own = this.ownedPending(invocation);
      const descendantSuspended = [...this.suspendedIds].some((id) =>
        this.isAncestorOf(invocation, id),
      );
      if (own.length > 0 || descendantSuspended) {
        outcome = { type: "suspended", interruptIds: own };
      }
    }
    if (outcome.type === "suspended") {
      this.suspendedIds.add(invocation.id);
      for (const interruptId of outcome.interruptIds ?? []) {
        this.owners.set(interruptId, this.continuationOf(invocation));
      }
    }
    if (this.pipelineEvents) {
      events.push({
        type: EventType.STEP_FINISHED,
        stepName: `agent:${invocation.name}`,
        ...this.tagFields(invocation),
      });
    }
    if (this.attributed) {
      if (outcome.type === "error") {
        events.push({
          type: EventType.SUBAGENT_ERROR,
          subagentRunId: invocation.id,
          message: outcome.message,
          ...(outcome.code ? { code: outcome.code } : {}),
        });
      } else {
        events.push({
          type: EventType.SUBAGENT_FINISHED,
          subagentRunId: invocation.id,
          ...(invocation.result !== undefined
            ? { result: invocation.result }
            : {}),
          outcome:
            outcome.type === "suspended"
              ? {
                  type: "suspended",
                  ...(outcome.interruptIds?.length
                    ? { interruptIds: outcome.interruptIds }
                    : {}),
                }
              : { type: "success" },
        });
      }
    }
    return events;
  }

  onInternalRequest(
    call: { id?: string; args?: Record<string, unknown> },
    key: string | null,
  ): void {
    if (!call.id) return;
    const originalCall = call.args?.originalFunctionCall;
    const toolCallId = isRecord(originalCall)
      ? originalCall.id
      : call.args?.function_call_id;
    const tool =
      typeof toolCallId === "string"
        ? this.open.get(`tool:${toolCallId}`)
        : undefined;
    this.raised.set(
      call.id,
      tool ?? (key ? this.open.get(key) : undefined) ?? null,
    );
  }

  onFunctionResponse(
    responseId: string | undefined,
    event: AdkEvent,
    toolCallId: string,
    messageId: string,
  ): AGUIEvent[] {
    if (responseId) {
      this.answered.add(responseId);
    }
    const target = event.actions?.transferToAgent;
    if (target) {
      this.pendingTransfer = {
        source: event.author,
        target,
        toolCallId,
        messageId: this.callMessages.get(toolCallId) ?? messageId,
      };
    }
    const invocation = this.open.get(`tool:${toolCallId}`);
    if (!invocation) return [];
    invocation.result = event.content?.parts?.find(
      (part) => part.functionResponse?.id === responseId,
    )?.functionResponse?.response;
    return this.close(invocation, { type: "success" });
  }

  onToolCall(
    name: string,
    toolCallId: string,
    messageId: string,
    key: string | null,
  ): AGUIEvent[] {
    this.callMessages.set(toolCallId, messageId);
    if (!this.options.tree.agentToolNames.has(name)) return [];
    const continuation = this.takeContinuation(
      (c) => c.toolCallId === toolCallId,
    );
    return this.openTool(
      name,
      toolCallId,
      messageId,
      key ? this.open.get(key) : undefined,
      continuation,
    );
  }

  private openTool(
    name: string,
    toolCallId: string,
    messageId: string | undefined,
    parent: Invocation | undefined,
    continuation?: SubagentContinuation,
  ): AGUIEvent[] {
    const invocation: Invocation = {
      id:
        continuation?.subagentRunId ??
        `adk:${this.invocationId ?? "run"}:tool:${toolCallId}`,
      name,
      key: `tool:${toolCallId}`,
      path: parent?.path ?? [],
      branch: parent?.branch ?? [],
      parentId: parent?.id,
      parentToolCallId: toolCallId,
      parentMessageId: messageId,
      toolCallId,
      openedAt: this.sequence++,
    };
    this.open.set(invocation.key, invocation);
    return this.openEvents(invocation, []);
  }

  onOutput(key: string | null, output: unknown): void {
    const invocation = key ? this.open.get(key) : undefined;
    if (invocation) {
      // Every function-call-free model text carries `output`; the last one
      // is the node's result. Never close on it.
      invocation.result = output;
    }
  }

  /** Queue terminals for a node failure; the run itself still errors. */
  onError(event: AdkEvent): void {
    if (!isNodeErrorEvent(event)) {
      return;
    }
    this.invocationId = event.invocationId;
    const scope = this.scopeOf(event);
    if (!scope || scope.author === this.options.tree.rootName) return;
    // Workflow errors may carry the container branch rather than the child's.
    const invocation =
      this.open.get(scope.key) ??
      [...this.open.values()].find(
        (candidate) =>
          !candidate.toolCallId &&
          candidate.name === scope.author &&
          sameSegments(candidate.path, scope.path),
      ) ??
      this.openInvocation(scope, this.errorQueue);
    const outcome: CloseOutcome = {
      type: "error",
      message: event.errorMessage || event.errorCode || "ADK node failed",
      ...(event.errorCode ? { code: event.errorCode } : {}),
    };
    for (const candidate of this.openDeepestFirst()) {
      const descendant =
        isStrictPrefix(invocation.branch, candidate.branch) ||
        (sameSegments(invocation.branch, candidate.branch) &&
          isStrictPrefix(invocation.path, candidate.path));
      if (descendant || candidate.parentId === invocation.id) {
        this.errorQueue.push(...this.close(candidate, outcome));
      }
    }
    this.errorQueue.push(...this.close(invocation, outcome));
  }

  drainErrorEvents(): AGUIEvent[] {
    return this.errorQueue.splice(0);
  }

  /**
   * Closes everything still open before RUN_FINISHED, deepest first. An
   * invocation that raised an interrupt nobody answered is suspended and owns
   * those ids; an ancestor of a suspended invocation is suspended without ids.
   */
  finish(): {
    events: AGUIEvent[];
    interruptOwners: Map<string, SubagentContinuation>;
  } {
    const events: AGUIEvent[] = [];
    for (const invocation of this.openDeepestFirst()) {
      events.push(...this.close(invocation, { type: "success" }));
    }
    return { events, interruptOwners: new Map(this.owners) };
  }

  private isAncestorOf(invocation: Invocation, suspendedId: string): boolean {
    // Suspended descendants were closed first (deepest-first flush); walk the
    // parent chain recorded on each closed invocation.
    let current = this.closed.get(suspendedId);
    while (current) {
      if (current.parentId === invocation.id) {
        return true;
      }
      current = current.parentId
        ? this.closed.get(current.parentId)
        : undefined;
    }
    return false;
  }

  private continuationOf(invocation: Invocation): SubagentContinuation {
    return {
      subagentRunId: invocation.id,
      name: invocation.name,
      ...(invocation.path.length ? { path: invocation.path.join(".") } : {}),
      ...(invocation.branch.length
        ? { branch: invocation.branch.join(".") }
        : {}),
      ...(invocation.toolCallId ? { toolCallId: invocation.toolCallId } : {}),
      ...(invocation.parentId
        ? { parentSubagentRunId: invocation.parentId }
        : {}),
      ...(invocation.parentToolCallId
        ? { parentToolCallId: invocation.parentToolCallId }
        : {}),
      ...(invocation.parentMessageId
        ? { parentMessageId: invocation.parentMessageId }
        : {}),
    };
  }
}
