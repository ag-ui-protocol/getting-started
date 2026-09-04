import { Middleware } from "./middleware";
import { AbstractAgent } from "@/agent";
import type { RunAgentInput, BaseEvent } from "@ag-ui/core";
import type { Observable } from "rxjs";

type InputMessage = RunAgentInput["messages"][number];

function suppressed(): boolean {
  return (
    typeof process !== "undefined" &&
    typeof process.env !== "undefined" &&
    Boolean(process.env.SUPPRESS_TRANSFORMATION_WARNINGS)
  );
}

function warnDroppedParts(dropped: string[]): void {
  if (suppressed()) return;
  console.warn(
    `[ag-ui][compat] Flattening message content for a <=0.0.39 peer DROPS non-text parts (${dropped.join(", ")}). The peer cannot receive them; upgrade it to keep media content. See the repo-root DEPRECATIONS.md.`,
  );
}

function warnMalformedTextPart(count: number): void {
  if (suppressed()) return;
  console.warn(
    `[ag-ui][compat] Not flattening message content for a <=0.0.39 peer: ${count} content part(s) claim type "text" but carry a malformed 'text' value. That is a defect in the message, not media the peer cannot represent, and a downgrade must not repair it — the content is passed on unchanged so the outgoing enforcement boundary reports it. See the repo-root DEPRECATIONS.md.`,
  );
}

function sanitizeMessageContent(message: InputMessage): InputMessage {
  const rawContent = (message as { content?: unknown }).content;

  if (Array.isArray(rawContent)) {
    // Two questions, deliberately separate. "Does this part CLAIM to be text?"
    // decides whether it is media the peer cannot represent; "is its `text`
    // actually a string?" decides whether it is well formed. Answering only
    // the second conflated the two, so a text part with `text: 42` was
    // flattened away AND announced as a dropped media part.
    const isTextPart = (part: unknown): part is { type: "text"; text?: unknown } =>
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      (part as { type: unknown }).type === "text";
    const isText = (part: unknown): part is { type: "text"; text: string } =>
      isTextPart(part) && typeof (part as { text?: unknown }).text === "string";

    // "A downgrade MUST NOT repair a malformed value on the way past"
    // (/spec/draft/basic/versioning). A malformed text part is a defect in the
    // message; dropping it and flattening what is left produced acceptable
    // content out of unacceptable input, which is exactly the repair that
    // rule forbids. Hand the message on untouched instead — the outgoing
    // enforcement boundary rejects it fatally, the same as when no shim is
    // installed.
    const malformedTextParts = rawContent.filter((part) => isTextPart(part) && !isText(part));
    if (malformedTextParts.length > 0) {
      warnMalformedTextPart(malformedTextParts.length);
      return message;
    }

    // Losing content must never be silent: an image, audio, video, document
    // or binary part cannot survive the flattening a 0.0.39 peer requires.
    // Every part reaching here is either well-formed text or genuinely not
    // text, so this census now says only what it means.
    const dropped = rawContent
      .filter((part) => !isText(part))
      .map((part) =>
        typeof part === "object" && part !== null && "type" in part
          ? String((part as { type: unknown }).type)
          : typeof part,
      );
    if (dropped.length > 0) {
      warnDroppedParts(dropped);
    }

    const concatenatedContent = rawContent
      .filter(isText)
      .map((part) => part.text)
      .join("");

    return {
      ...message,
      content: concatenatedContent,
    } as InputMessage;
  }

  if (typeof rawContent === "string") {
    return message;
  }

  // ABSENT content is the one value a downgrade may supply for: "an empty
  // string where content is now absent" is named as permitted reshaping by
  // the versioning rules, because the older schema requires the field.
  if (rawContent === undefined) {
    return {
      ...message,
      content: "",
    } as InputMessage;
  }

  // Anything else — null, a number, an object — is a known field holding a
  // value the schema rejects, and repairing it to "" hid a defect that is
  // fatal the moment the same message is sent to a modern peer. Untouched, so
  // the outgoing enforcement boundary reports it.
  return message;
}

/**
 * Middleware placeholder that maintains compatibility with AG-UI 0.0.39 flows.
 * Currently it simply forwards all events to the next middleware/agent.
 */
export class BackwardCompatibility_0_0_39 extends Middleware {
  override run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    const { parentRunId: _parentRunId, ...rest } = input;
    const sanitizedInput: RunAgentInput = {
      ...rest,
      messages: rest.messages.map(sanitizeMessageContent),
    } as RunAgentInput;

    return this.runNext(sanitizedInput, next);
  }
}
