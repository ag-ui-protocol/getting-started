import type { Message, RunAgentInput } from "@ag-ui/core";
import {
  createEvent,
  type Event as AdkEvent,
  type Runner,
  type Session,
} from "@google/adk";

import { getPendingUserInputRequests } from "./adk-compat";
import { discoverAgentNames } from "./agent-tree";
import {
  AG_UI_EMITTED_MESSAGE_IDS_METADATA_KEY,
  AG_UI_MESSAGE_ID_METADATA_KEY,
} from "./constants";
import { ADKProtocolError } from "./errors";
import { prepareResume, type PreparedRunInput } from "./interrupt-bridge";
import {
  ADKMessageConversionError,
  convertMessage,
  type AdkContent,
} from "./message-converter";
import { stateDeltaFromInput } from "./state-bridge";

function seenMessageIds(events: readonly AdkEvent[]): Set<string> {
  const seen = new Set<string>();
  for (const event of events) {
    seen.add(event.id);
    seen.add(`${event.id}:reasoning`);
    const metadataId = event.customMetadata?.[AG_UI_MESSAGE_ID_METADATA_KEY];
    if (typeof metadataId === "string") {
      seen.add(metadataId);
    }
    const emittedIds =
      event.customMetadata?.[AG_UI_EMITTED_MESSAGE_IDS_METADATA_KEY];
    if (Array.isArray(emittedIds)) {
      for (const id of emittedIds) {
        if (typeof id === "string") {
          seen.add(id);
        }
      }
    }
    for (const [index, part] of (event.content?.parts ?? []).entries()) {
      if (part.functionResponse) {
        const callId =
          part.functionResponse.id || `${event.id}:result:${index}`;
        seen.add(`${event.id}:${callId}`);
      }
    }
  }
  return seen;
}

export async function getOrCreateSession(
  runner: Runner,
  userId: string,
  input: RunAgentInput,
  signal?: AbortSignal,
): Promise<Session> {
  const existing = await runner.sessionService.getSession({
    appName: runner.appName,
    userId,
    sessionId: input.threadId,
  });
  if (signal?.aborted) {
    throw signal.reason;
  }
  if (existing) {
    return existing;
  }
  const created = await runner.sessionService.createSession({
    appName: runner.appName,
    userId,
    sessionId: input.threadId,
    state: stateDeltaFromInput(input),
  });
  if (signal?.aborted) {
    throw signal.reason;
  }
  return created;
}

export async function prepareRunInput(
  runner: Runner,
  session: Session,
  input: RunAgentInput,
  signal?: AbortSignal,
): Promise<PreparedRunInput> {
  const seen = seenMessageIds(session.events);
  const unseen = input.messages.filter((message) => !seen.has(message.id));
  const resumed = prepareResume(session, input);
  if (resumed && unseen.length > 0) {
    throw new ADKProtocolError(
      "An interrupt resume cannot be combined with unseen AG-UI messages.",
      "RESUME_WITH_NEW_INPUT",
    );
  }
  if (resumed?.kind === "replay") {
    return resumed;
  }
  const pendingRequests = getPendingUserInputRequests(session.events);
  if (!resumed && pendingRequests.length > 0) {
    throw new ADKProtocolError(
      `Thread has pending ADK interrupts: ${pendingRequests
        .map((request) => request.interruptId)
        .join(
          ", ",
        )}. Resume or cancel all pending interrupts before sending new input.`,
      "PENDING_INTERRUPTS",
    );
  }

  const modelAuthor = (runner.agent as { name?: string }).name ?? "model";
  const modelAuthors = discoverAgentNames(runner);
  let current: Message | undefined;
  if (!resumed) {
    current = unseen.at(-1);
    if (!current || (current.role !== "user" && current.role !== "tool")) {
      throw new Error(
        "An ADK run requires a new user/tool message or interrupt resume payload.",
      );
    }
  }

  const preload = resumed ? unseen : unseen.slice(0, -1);
  for (const message of preload) {
    if (signal?.aborted) {
      throw signal.reason;
    }
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
    if (signal?.aborted) {
      throw signal.reason;
    }
  }

  if (resumed) {
    return resumed;
  }
  const converted = convertMessage(
    current!,
    input.messages,
    modelAuthor,
    modelAuthors,
  );
  if (!converted) {
    throw new ADKMessageConversionError(
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
