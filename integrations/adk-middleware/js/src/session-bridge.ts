import type { Message, RunAgentInput } from "@ag-ui/core";
import {
  createEvent,
  getPendingUserInputRequests,
  type Event as AdkEvent,
  type Runner,
  type Session,
} from "@google/adk";

import type { AgentTreeIndex } from "./agent-tree";
import {
  ADK_METADATA_KEY,
  AG_UI_MESSAGE_ID_METADATA_KEY,
  AG_UI_RESUME_IDS_METADATA_KEY,
  reasoningMessageId,
  toolResultIds,
} from "./constants";
import { ADKJSProtocolError } from "./errors";
import { prepareResume, type PreparedRunInput } from "./interrupt-bridge";
import { convertMessage } from "./message-converter";
import { runMarkers } from "./run-marker";
import { stateDeltaFromInput } from "./state-bridge";
import { isRecord, throwIfAborted } from "./value-utils";

interface PersistedAdkIdentifiers {
  eventIds: Set<string>;
  streamIds: Set<string>;
}

function streamId(
  invocationId: string,
  author: string | undefined,
  branch: string | undefined,
): string {
  return JSON.stringify([invocationId, author ?? null, branch ?? null]);
}

function persistedAdkIdentifiers(
  events: readonly AdkEvent[],
): PersistedAdkIdentifiers {
  const eventIds = new Set<string>();
  const streamIds = new Set<string>();
  for (const event of events) {
    eventIds.add(event.id);
    if (event.invocationId) {
      streamIds.add(streamId(event.invocationId, event.author, event.branch));
    }
  }
  return { eventIds, streamIds };
}

/**
 * Streamed AG-UI message ids are derived from the first chunk's event id,
 * while ADK persists the final aggregate under a different id; the run marker
 * normally reconciles the two. When a crash or client disconnect prevents
 * that marker from being appended, fall back to the ADK metadata the
 * translator stamped on every emitted message: a message whose originating
 * event or invocation is already persisted in the session must not be
 * replayed into ADK history as new input.
 */
function isPersistedAdkMessage(
  message: Message,
  persisted: PersistedAdkIdentifiers,
): boolean {
  // Only output roles can have been produced by the ADK translator. Never
  // suppress new user input (or other client-owned roles) merely because a
  // caller supplied metadata that resembles an earlier ADK event.
  if (
    message.role !== "assistant" &&
    message.role !== "reasoning" &&
    message.role !== "tool"
  ) {
    return false;
  }
  const metadata = message.metadata?.[ADK_METADATA_KEY];
  if (!isRecord(metadata)) {
    return false;
  }
  const matchingStream =
    typeof metadata.invocationId === "string" &&
    (typeof metadata.author === "string" || metadata.author === undefined) &&
    (typeof metadata.branch === "string" || metadata.branch === undefined) &&
    persisted.streamIds.has(
      streamId(metadata.invocationId, metadata.author, metadata.branch),
    );
  return (
    (typeof metadata.eventId === "string" &&
      persisted.eventIds.has(metadata.eventId)) ||
    matchingStream
  );
}

function seenMessageIds(events: readonly AdkEvent[]): Set<string> {
  const seen = new Set<string>();
  for (const marker of runMarkers(events)) {
    for (const id of marker.emittedMessageIds) {
      seen.add(id);
    }
  }
  for (const event of events) {
    seen.add(event.id);
    seen.add(reasoningMessageId(event.id));
    const metadataId = event.customMetadata?.[AG_UI_MESSAGE_ID_METADATA_KEY];
    if (typeof metadataId === "string") {
      seen.add(metadataId);
    }
    for (const [index, part] of (event.content?.parts ?? []).entries()) {
      if (part.functionResponse) {
        seen.add(
          toolResultIds(event.id, part.functionResponse.id, index).messageId,
        );
      }
    }
  }
  return seen;
}

export async function getOrCreateSession(
  runner: Runner,
  userId: string,
  input: RunAgentInput,
  signal: AbortSignal,
): Promise<Session> {
  const existing = await runner.sessionService.getSession({
    appName: runner.appName,
    userId,
    sessionId: input.threadId,
  });
  throwIfAborted(signal);
  if (existing) {
    return existing;
  }
  const created = await runner.sessionService.createSession({
    appName: runner.appName,
    userId,
    sessionId: input.threadId,
    state: stateDeltaFromInput(input),
  });
  throwIfAborted(signal);
  return created;
}

/**
 * ADK 2.x strips every event carrying an `adk_request_input` call or response
 * from the model's contents, so the function response alone (the run's own
 * user content) leaves the model unaware of the answer. A preceding plain
 * user turn carries it; the function response still settles the pending
 * call. Idempotent: a retry after a crash between this append and the
 * runner's own must not add the answer twice.
 */
async function appendResumeReplyOnce(
  runner: Runner,
  session: Session,
  input: RunAgentInput,
  replyText: string,
  signal: AbortSignal,
): Promise<void> {
  const resumedIds = (input.resume ?? []).map((entry) => entry.interruptId);
  const sortedIds = [...resumedIds].sort();
  const alreadyAppended = session.events.some((event) => {
    const ids = event.customMetadata?.[AG_UI_RESUME_IDS_METADATA_KEY];
    return (
      event.author === "user" &&
      typeof event.invocationId === "string" &&
      event.invocationId.startsWith("ag-ui-resume-reply-") &&
      Array.isArray(ids) &&
      ids.length === sortedIds.length &&
      [...ids].sort().every((id, index) => id === sortedIds[index])
    );
  });
  if (alreadyAppended) {
    return;
  }
  await runner.sessionService.appendEvent({
    session,
    event: createEvent({
      invocationId: `ag-ui-resume-reply-${input.runId}`,
      author: "user",
      content: { role: "user", parts: [{ text: replyText }] },
      customMetadata: { [AG_UI_RESUME_IDS_METADATA_KEY]: resumedIds },
    }),
  });
  throwIfAborted(signal);
}

export async function prepareRunInput(
  runner: Runner,
  session: Session,
  input: RunAgentInput,
  signal: AbortSignal,
  tree: AgentTreeIndex,
): Promise<PreparedRunInput> {
  const seen = seenMessageIds(session.events);
  const persisted = persistedAdkIdentifiers(session.events);
  const unseen = input.messages.filter(
    (message) =>
      !seen.has(message.id) && !isPersistedAdkMessage(message, persisted),
  );
  const resumed = prepareResume(session, input);
  if (resumed && unseen.length > 0) {
    throw new ADKJSProtocolError(
      "An interrupt resume cannot be combined with unseen AG-UI messages.",
      "RESUME_WITH_NEW_INPUT",
    );
  }
  if (resumed?.kind === "replay") {
    return resumed;
  }
  const pendingRequests = getPendingUserInputRequests(session.events);
  if (!resumed && pendingRequests.length > 0) {
    throw new ADKJSProtocolError(
      `Thread has pending ADK interrupts: ${pendingRequests
        .map((request) => request.interruptId)
        .join(
          ", ",
        )}. Resume or cancel all pending interrupts before sending new input.`,
      "PENDING_INTERRUPTS",
    );
  }

  const modelAuthor = tree.rootName ?? "model";
  const modelAuthors = tree.names;
  let current: Message | undefined;
  if (!resumed) {
    current = unseen.at(-1);
    if (!current || (current.role !== "user" && current.role !== "tool")) {
      throw new ADKJSProtocolError(
        "An ADK run requires a new user/tool message or interrupt resume payload.",
        "NO_NEW_INPUT",
      );
    }
  }

  const preload = resumed ? unseen : unseen.slice(0, -1);
  for (const message of preload) {
    throwIfAborted(signal);
    const converted = convertMessage(
      message,
      input.messages,
      modelAuthor,
      modelAuthors,
    );
    if (!converted) {
      continue;
    }
    await runner.sessionService.appendEvent({
      session,
      event: createEvent({
        invocationId: `ag-ui-history-${input.runId}`,
        author: converted.author,
        content: converted.content,
        customMetadata: {
          [AG_UI_MESSAGE_ID_METADATA_KEY]: message.id,
        },
      }),
    });
    throwIfAborted(signal);
  }

  if (resumed) {
    if (resumed.inputReplyText !== undefined) {
      await appendResumeReplyOnce(
        runner,
        session,
        input,
        resumed.inputReplyText,
        signal,
      );
    }
    return resumed;
  }
  const converted = convertMessage(
    current!,
    input.messages,
    modelAuthor,
    modelAuthors,
  );
  if (!converted) {
    throw new ADKJSProtocolError(
      `AG-UI ${current!.role} messages cannot start a Google ADK run.`,
      "UNSUPPORTED_MESSAGE_ROLE",
    );
  }
  return {
    kind: "run",
    content: converted.content,
    customMetadata: {
      [AG_UI_MESSAGE_ID_METADATA_KEY]: current!.id,
    },
  };
}
