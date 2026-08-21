import { Validator, type Schema } from "@cfworker/json-schema";
import type {
  Interrupt,
  Message,
  ResumeEntry,
  RunAgentInput,
  TokenUsage,
} from "@ag-ui/core";
import type { Event as AdkEvent, Session } from "@google/adk";
import { createHash } from "node:crypto";

import {
  getPendingUserInputRequests,
  type UserInputRequest,
} from "./adk-compat";
import { credentialResponse } from "./auth-resume";
import { publicAuthConfig } from "./auth-sanitizer";
import {
  AG_UI_RESUME_COMPLETED_METADATA_KEY,
  AG_UI_RESUME_FINGERPRINT_METADATA_KEY,
  AG_UI_RESUME_IDS_METADATA_KEY,
  AG_UI_RESUME_REPLAY_METADATA_KEY,
} from "./constants";
import { ADKProtocolError } from "./errors";
import type { AdkContent } from "./message-converter";
import { clone, errorMessage, hasOwn, isRecord } from "./value-utils";

export interface ResumeReplayArtifact {
  state: unknown;
  /** Needed only when replaying a run that produced another interrupt. */
  messages?: Message[];
  interrupts: Interrupt[];
  result?: unknown;
  usage?: TokenUsage[];
}

export interface PreparedAdkRun {
  kind: "run";
  content: AdkContent;
  customMetadata: Record<string, unknown>;
  resumeFingerprint?: string;
}

interface PreparedResumeRun extends PreparedAdkRun {
  resumeFingerprint: string;
}

interface PreparedReplay {
  kind: "replay";
  artifact: ResumeReplayArtifact;
}

export type PreparedResume = PreparedResumeRun | PreparedReplay;

export type PreparedRunInput = PreparedAdkRun | PreparedReplay;

function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (current: unknown): unknown => {
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return current;
    }
    if (typeof current === "number") {
      return Number.isFinite(current) ? current : null;
    }
    if (Array.isArray(current)) {
      return current.map((entry) => normalize(entry));
    }
    if (isRecord(current)) {
      if (seen.has(current)) {
        throw new ADKProtocolError(
          "Interrupt resume payload must be JSON serializable.",
          "INVALID_PAYLOAD",
        );
      }
      seen.add(current);
      const output: Record<string, unknown> = {};
      for (const key of Object.keys(current).sort()) {
        if (current[key] !== undefined) {
          output[key] = normalize(current[key]);
        }
      }
      seen.delete(current);
      return output;
    }
    throw new ADKProtocolError(
      "Interrupt resume payload must be JSON serializable.",
      "INVALID_PAYLOAD",
    );
  };
  return JSON.stringify(normalize(value));
}

function resumeFingerprint(input: RunAgentInput): string {
  const entries = (input.resume ?? [])
    .map((entry) => ({
      interruptId: entry.interruptId,
      status: entry.status,
      hasPayload: entry.payload !== undefined,
      payload: entry.payload,
    }))
    .sort((left, right) => left.interruptId.localeCompare(right.interruptId));
  return createHash("sha256").update(canonicalJson(entries)).digest("hex");
}

function completedResume(
  session: Session,
  fingerprint: string,
): AdkEvent | undefined {
  return session.events.find(
    (event) =>
      event.customMetadata?.[AG_UI_RESUME_COMPLETED_METADATA_KEY] === true &&
      event.customMetadata?.[AG_UI_RESUME_FINGERPRINT_METADATA_KEY] ===
        fingerprint,
  );
}

function replayArtifact(event: AdkEvent): ResumeReplayArtifact {
  const stored = event.customMetadata?.[AG_UI_RESUME_REPLAY_METADATA_KEY];
  if (
    isRecord(stored) &&
    hasOwn(stored, "state") &&
    Array.isArray(stored.interrupts) &&
    (stored.interrupts.length === 0 || Array.isArray(stored.messages))
  ) {
    return {
      state: clone(stored.state),
      ...(Array.isArray(stored.messages)
        ? { messages: clone(stored.messages as Message[]) }
        : {}),
      interrupts: clone(stored.interrupts as Interrupt[]),
      ...(hasOwn(stored, "result") ? { result: clone(stored.result) } : {}),
      ...(Array.isArray(stored.usage)
        ? { usage: clone(stored.usage as TokenUsage[]) }
        : {}),
    };
  }
  throw new ADKProtocolError(
    "Completed ADK resume marker has no valid replay artifact.",
    "INVALID_REPLAY_ARTIFACT",
  );
}

function validateResumePayload(
  request: UserInputRequest,
  entry: ResumeEntry,
): void {
  if (entry.status !== "resolved" || !isRecord(request.responseSchema)) {
    return;
  }
  let validation;
  try {
    validation = new Validator(request.responseSchema as Schema).validate(
      entry.payload,
    );
  } catch (error) {
    throw new ADKProtocolError(
      `ADK interrupt ${request.interruptId} has an invalid response schema: ${errorMessage(error)}`,
      "INVALID_RESPONSE_SCHEMA",
    );
  }
  if (!validation.valid) {
    const details = validation.errors
      .slice(0, 3)
      .map((error) => `${error.instanceLocation || "/"}: ${error.error}`)
      .join("; ");
    throw new ADKProtocolError(
      `Invalid payload for ADK interrupt ${request.interruptId}${details ? `: ${details}` : "."}`,
      "INVALID_PAYLOAD",
    );
  }
}

function confirmationDecision(entry: ResumeEntry): boolean {
  if (entry.status === "cancelled") {
    return false;
  }
  if (typeof entry.payload === "boolean") {
    return entry.payload;
  }
  if (isRecord(entry.payload)) {
    const confirmed = entry.payload.confirmed;
    const approved = entry.payload.approved;
    if (confirmed !== undefined && typeof confirmed !== "boolean") {
      throw new ADKProtocolError(
        "Confirmation payload `confirmed` must be a boolean.",
        "INVALID_PAYLOAD",
      );
    }
    if (approved !== undefined && typeof approved !== "boolean") {
      throw new ADKProtocolError(
        "Confirmation payload `approved` must be a boolean.",
        "INVALID_PAYLOAD",
      );
    }
    if (
      typeof confirmed === "boolean" &&
      typeof approved === "boolean" &&
      confirmed !== approved
    ) {
      throw new ADKProtocolError(
        "Confirmation payload contains conflicting decisions.",
        "INVALID_PAYLOAD",
      );
    }
    if (typeof confirmed === "boolean") {
      return confirmed;
    }
    if (typeof approved === "boolean") {
      return approved;
    }
  }
  throw new ADKProtocolError(
    "Resolved confirmation payload must be a boolean or contain a boolean `approved` or `confirmed` field.",
    "INVALID_PAYLOAD",
  );
}

function responseForResume(
  request: UserInputRequest,
  entry: ResumeEntry,
): Record<string, unknown> {
  if (request.kind === "confirmation") {
    const confirmed = confirmationDecision(entry);
    return {
      confirmed,
      ...(isRecord(entry.payload) ? { payload: entry.payload } : {}),
    };
  }
  if (entry.status === "cancelled") {
    throw new ADKProtocolError(
      `Google ADK does not define safe cancellation semantics for ${request.kind} interrupt ${request.interruptId}; resolve it explicitly instead.`,
      "UNSUPPORTED_INTERRUPT_CANCELLATION",
    );
  }
  if (request.kind === "credential") {
    return credentialResponse(request, entry.payload);
  }
  return isRecord(entry.payload) ? entry.payload : { result: entry.payload };
}

export function prepareResume(
  session: Session,
  input: RunAgentInput,
): PreparedResume | undefined {
  if (!input.resume?.length) {
    return undefined;
  }
  const fingerprint = resumeFingerprint(input);
  const completed = completedResume(session, fingerprint);
  if (completed) {
    return {
      kind: "replay",
      artifact: replayArtifact(completed),
    };
  }

  const pendingRequests = getPendingUserInputRequests(session.events);
  const pending = new Map(
    pendingRequests.map((request) => [request.interruptId, request]),
  );
  const resumedIds = new Set<string>();
  for (const entry of input.resume) {
    if (resumedIds.has(entry.interruptId)) {
      throw new ADKProtocolError(
        `Interrupt ${entry.interruptId} appears more than once in resume.`,
        "DUPLICATE_INTERRUPT_ID",
      );
    }
    resumedIds.add(entry.interruptId);
    if (!pending.has(entry.interruptId)) {
      throw new ADKProtocolError(
        `No pending ADK interrupt with id ${entry.interruptId}.`,
        "UNKNOWN_INTERRUPT_ID",
      );
    }
  }
  const missing = pendingRequests
    .map((request) => request.interruptId)
    .filter((interruptId) => !resumedIds.has(interruptId));
  if (missing.length > 0) {
    throw new ADKProtocolError(
      `Partial resume: missing ADK interrupt IDs ${missing.join(", ")}.`,
      "PARTIAL_RESUME",
    );
  }

  const parts = input.resume.map((entry) => {
    const request = pending.get(entry.interruptId)!;
    validateResumePayload(request, entry);
    return {
      functionResponse: {
        id: entry.interruptId,
        name: request.functionCallName,
        response: responseForResume(request, entry),
      },
    };
  });
  return {
    kind: "run",
    content: { role: "user", parts } as AdkContent,
    customMetadata: {
      [AG_UI_RESUME_IDS_METADATA_KEY]: input.resume.map(
        (entry) => entry.interruptId,
      ),
      [AG_UI_RESUME_FINGERPRINT_METADATA_KEY]: fingerprint,
    },
    resumeFingerprint: fingerprint,
  };
}

function reasonFor(request: UserInputRequest): string {
  switch (request.kind) {
    case "input":
      return "input_required";
    case "confirmation":
      return "confirmation";
    case "credential":
      return "google-adk:credential_required";
  }
}

export function toInterrupt(request: UserInputRequest): Interrupt {
  const authConfig = publicAuthConfig(request.authConfig);
  const metadata: Record<string, unknown> = {
    adkFunctionCallName: request.functionCallName,
    ...(request.author ? { author: request.author } : {}),
    ...(request.toolName ? { toolName: request.toolName } : {}),
    ...(request.payload !== undefined ? { payload: request.payload } : {}),
    ...(authConfig ? { authConfig } : {}),
  };
  return {
    id: request.interruptId,
    reason: reasonFor(request),
    ...(request.message ? { message: request.message } : {}),
    ...(isRecord(request.responseSchema)
      ? { responseSchema: request.responseSchema }
      : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}
