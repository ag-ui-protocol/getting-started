import type { Interrupt, Message, TokenUsage } from "@ag-ui/core";
import { createEvent, type Event as AdkEvent } from "@google/adk";

import { AG_UI_RUN_KEY } from "./constants";
import { ADKJSProtocolError } from "./errors";
import type { SubagentContinuation } from "./subagent-tracker";
import { clone, hasOwn, isRecord } from "./value-utils";

/** What a completed resume replays on an identical retry (streams cannot be replayed). */
export interface ResumeReplayArtifact {
  state: unknown;
  messages: Message[];
  interrupts: Interrupt[];
  result?: unknown;
  usage?: TokenUsage[];
}

/**
 * The bridge's bookkeeping for one AG-UI run, stored once per run as the
 * `customMetadata` of an `ag-ui-run-<runId>` user event in the ADK session.
 * Everything the next run needs to know about this one lives here.
 */
export interface RunMarker {
  runId: string;
  /** AG-UI message ids this run streamed; ADK persists aggregates under other ids. */
  emittedMessageIds: string[];
  /** Sub-agent invocations left suspended on the interrupts this run raised. */
  continuations?: Record<string, SubagentContinuation>;
  /** Set when the run answered a resume, so an identical retry replays instead of re-running. */
  resume?: { fingerprint: string; replay: ResumeReplayArtifact };
}

/** A marker read back from the session; the replay is validated only when used. */
interface StoredRunMarker {
  runId: string;
  emittedMessageIds: string[];
  continuations: Record<string, SubagentContinuation>;
  resume?: { fingerprint: string; replay: unknown };
}

export function createRunMarkerEvent(marker: RunMarker): AdkEvent {
  return createEvent({
    invocationId: `ag-ui-run-${marker.runId}`,
    author: "user",
    customMetadata: { [AG_UI_RUN_KEY]: marker },
  });
}

function isContinuation(value: unknown): value is SubagentContinuation {
  return (
    isRecord(value) &&
    typeof value.subagentRunId === "string" &&
    typeof value.name === "string"
  );
}

export function runMarkers(events: readonly AdkEvent[]): StoredRunMarker[] {
  const markers: StoredRunMarker[] = [];
  for (const event of events) {
    const stored = event.customMetadata?.[AG_UI_RUN_KEY];
    if (
      !isRecord(stored) ||
      typeof stored.runId !== "string" ||
      !Array.isArray(stored.emittedMessageIds)
    ) {
      continue;
    }
    const continuations: Record<string, SubagentContinuation> = {};
    if (isRecord(stored.continuations)) {
      for (const [interruptId, value] of Object.entries(stored.continuations)) {
        if (isContinuation(value)) {
          continuations[interruptId] = clone(value);
        }
      }
    }
    markers.push({
      runId: stored.runId,
      emittedMessageIds: stored.emittedMessageIds.filter(
        (id): id is string => typeof id === "string",
      ),
      continuations,
      ...(isRecord(stored.resume) &&
      typeof stored.resume.fingerprint === "string"
        ? {
            resume: {
              fingerprint: stored.resume.fingerprint,
              replay: stored.resume.replay,
            },
          }
        : {}),
    });
  }
  return markers;
}

/** Validate a stored replay before trusting it as the run's whole output. */
export function replayArtifact(stored: unknown): ResumeReplayArtifact {
  if (
    isRecord(stored) &&
    hasOwn(stored, "state") &&
    Array.isArray(stored.interrupts) &&
    Array.isArray(stored.messages)
  ) {
    return {
      state: clone(stored.state),
      messages: clone(stored.messages as Message[]),
      interrupts: clone(stored.interrupts as Interrupt[]),
      ...(hasOwn(stored, "result") ? { result: clone(stored.result) } : {}),
      ...(Array.isArray(stored.usage)
        ? { usage: clone(stored.usage as TokenUsage[]) }
        : {}),
    };
  }
  throw new ADKJSProtocolError(
    "Completed ADK resume marker has no valid replay artifact.",
    "INVALID_REPLAY_ARTIFACT",
  );
}
