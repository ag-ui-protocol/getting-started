import { Validator, type Schema } from "@cfworker/json-schema";
import type {
  Interrupt,
  Message,
  ResumeEntry,
  RunAgentInput,
  TokenUsage,
} from "@ag-ui/core";
import {
  getPendingUserInputRequests,
  type Session,
  type UserInputRequest,
} from "@google/adk";
import { createHash } from "node:crypto";

import { credentialResponse } from "./auth-resume";
import { publicAuthConfig } from "./auth-sanitizer";
import { AG_UI_RESUME_IDS_METADATA_KEY } from "./constants";
import { ADKJSProtocolError } from "./errors";
import type { AdkContent } from "./message-converter";
import {
  replayArtifact,
  runMarkers,
  type ResumeReplayArtifact,
} from "./run-marker";
import type { SubagentContinuation } from "./subagent-tracker";
import { clone, errorMessage, hasOwn, isRecord } from "./value-utils";

export interface PreparedAdkRun {
  kind: "run";
  content: AdkContent;
  customMetadata: Record<string, unknown>;
  resumeFingerprint?: string;
  /** Sub-agent invocations to re-announce, keyed by resumed interrupt id. */
  continuations?: Map<string, SubagentContinuation>;
  /**
   * The resolved `adk_request_input` answers rendered as user text. ADK 2.x
   * hides the request-input exchange from the model's contents, so without
   * this a plain LlmAgent never sees the answer and asks again.
   */
  inputReplyText?: string;
}

interface PreparedResumeRun extends PreparedAdkRun {
  resumeFingerprint: string;
}

interface PreparedReplay {
  kind: "replay";
  artifact: ResumeReplayArtifact;
}

type PreparedResume = PreparedResumeRun | PreparedReplay;

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
        throw new ADKJSProtocolError(
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
    throw new ADKJSProtocolError(
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

/**
 * A completed resume is replayed only while its run marker is still the
 * newest event on the thread; once anything else ran, replaying its snapshot
 * would rewind the client's conversation.
 */
function completedReplay(
  session: Session,
  fingerprint: string,
): ResumeReplayArtifact | undefined {
  const last = session.events.at(-1);
  const newest = last ? runMarkers([last])[0] : undefined;
  if (newest?.resume?.fingerprint === fingerprint) {
    return replayArtifact(newest.resume.replay);
  }
  if (
    runMarkers(session.events).some(
      (marker) => marker.resume?.fingerprint === fingerprint,
    )
  ) {
    throw new ADKJSProtocolError(
      "This resume already completed and the thread has moved on; it cannot be replayed.",
      "STALE_RESUME",
    );
  }
  return undefined;
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
    throw new ADKJSProtocolError(
      `ADK interrupt ${request.interruptId} has an invalid response schema: ${errorMessage(error)}`,
      "INVALID_RESPONSE_SCHEMA",
    );
  }
  if (!validation.valid) {
    const details = validation.errors
      .slice(0, 3)
      .map((error) => `${error.instanceLocation || "/"}: ${error.error}`)
      .join("; ");
    throw new ADKJSProtocolError(
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
      throw new ADKJSProtocolError(
        "Confirmation payload `confirmed` must be a boolean.",
        "INVALID_PAYLOAD",
      );
    }
    if (approved !== undefined && typeof approved !== "boolean") {
      throw new ADKJSProtocolError(
        "Confirmation payload `approved` must be a boolean.",
        "INVALID_PAYLOAD",
      );
    }
    if (
      typeof confirmed === "boolean" &&
      typeof approved === "boolean" &&
      confirmed !== approved
    ) {
      throw new ADKJSProtocolError(
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
  throw new ADKJSProtocolError(
    "Resolved confirmation payload must be a boolean or contain a boolean `approved` or `confirmed` field.",
    "INVALID_PAYLOAD",
  );
}

function responseForResume(
  request: UserInputRequest,
  entry: ResumeEntry,
): Record<string, unknown> {
  if (request.kind === "confirmation") {
    // Only the decision comes from the browser. ADK re-executes the original
    // tool with this response's hint/payload, so both must stay the trusted
    // values from the pending request, not client-supplied replacements.
    return {
      confirmed: confirmationDecision(entry),
      ...(request.message !== undefined ? { hint: request.message } : {}),
      ...(request.payload !== undefined ? { payload: request.payload } : {}),
    };
  }
  if (request.kind === "credential") {
    if (entry.status === "cancelled") {
      // ADK binds a credential reply to the auth flow and drops anything that
      // is not a credential, so a "cancelled" answer would stall the tool.
      throw new ADKJSProtocolError(
        `Credential interrupt ${request.interruptId} cannot be cancelled; resolve it with a credential.`,
        "UNSUPPORTED_INTERRUPT_CANCELLATION",
      );
    }
    return credentialResponse(request, entry.payload);
  }
  if (entry.status === "cancelled") {
    return { cancelled: true };
  }
  return isRecord(entry.payload) ? entry.payload : { result: entry.payload };
}

/**
 * Sub-agent invocations recorded as suspended when the interrupts now being
 * resumed were raised. Read from the run markers the coordinator appends.
 */
export function continuationsFor(
  session: Session,
  input: RunAgentInput,
): Map<string, SubagentContinuation> {
  const resumed = new Set(
    (input.resume ?? []).map((entry) => entry.interruptId),
  );
  const found = new Map<string, SubagentContinuation>();
  for (const marker of runMarkers(session.events)) {
    for (const [interruptId, continuation] of Object.entries(
      marker.continuations,
    )) {
      if (resumed.has(interruptId)) {
        found.set(interruptId, continuation);
      }
    }
  }
  return found;
}

export function prepareResume(
  session: Session,
  input: RunAgentInput,
): PreparedResume | undefined {
  if (!input.resume?.length) {
    return undefined;
  }
  const fingerprint = resumeFingerprint(input);
  const replay = completedReplay(session, fingerprint);
  if (replay) {
    return { kind: "replay", artifact: replay };
  }

  const pendingRequests = getPendingUserInputRequests(session.events);
  const pending = new Map(
    pendingRequests.map((request) => [request.interruptId, request]),
  );
  const resumedIds = new Set<string>();
  for (const entry of input.resume) {
    if (resumedIds.has(entry.interruptId)) {
      throw new ADKJSProtocolError(
        `Interrupt ${entry.interruptId} appears more than once in resume.`,
        "DUPLICATE_INTERRUPT_ID",
      );
    }
    resumedIds.add(entry.interruptId);
    if (!pending.has(entry.interruptId)) {
      throw new ADKJSProtocolError(
        `No pending ADK interrupt with id ${entry.interruptId}.`,
        "UNKNOWN_INTERRUPT_ID",
      );
    }
  }
  const missing = pendingRequests
    .map((request) => request.interruptId)
    .filter((interruptId) => !resumedIds.has(interruptId));
  if (missing.length > 0) {
    throw new ADKJSProtocolError(
      `Partial resume: missing ADK interrupt IDs ${missing.join(", ")}.`,
      "PARTIAL_RESUME",
    );
  }

  const inputReplies: string[] = [];
  const parts = input.resume.map((entry) => {
    const request = pending.get(entry.interruptId)!;
    validateResumePayload(request, entry);
    const response = responseForResume(request, entry);
    // Only free-form input is echoed as text; confirmations and credentials
    // are consumed by ADK's own processors and must never reach the model.
    if (request.kind === "input") {
      if (entry.status === "cancelled") {
        inputReplies.push(canonicalJson({ cancelled: true }));
      } else if (entry.payload !== undefined) {
        inputReplies.push(
          typeof entry.payload === "string"
            ? entry.payload
            : canonicalJson(entry.payload),
        );
      }
    }
    return {
      functionResponse: {
        id: entry.interruptId,
        name: request.functionCallName,
        response,
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
    },
    resumeFingerprint: fingerprint,
    continuations: continuationsFor(session, input),
    ...(inputReplies.length > 0
      ? { inputReplyText: inputReplies.join("\n") }
      : {}),
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

export function toInterrupt(
  request: UserInputRequest,
  owners?: ReadonlyMap<string, SubagentContinuation>,
): Interrupt {
  const authConfig = publicAuthConfig(request.authConfig);
  const owner = owners?.get(request.interruptId);
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
    ...(owner ? { subagentRunId: owner.subagentRunId } : {}),
    ...(request.message ? { message: request.message } : {}),
    ...(isRecord(request.responseSchema)
      ? { responseSchema: request.responseSchema }
      : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}
