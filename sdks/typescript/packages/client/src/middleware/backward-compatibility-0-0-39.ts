import { Middleware } from "./middleware";
import { AbstractAgent } from "@/agent";
import type { RunAgentInput, BaseEvent } from "@ag-ui/core";
import type { Observable } from "rxjs";

type InputMessage = RunAgentInput["messages"][number];

function warnDroppedParts(dropped: string[]): void {
  if (
    typeof process !== "undefined" &&
    typeof process.env !== "undefined" &&
    process.env.SUPPRESS_TRANSFORMATION_WARNINGS
  )
    return;
  console.warn(
    `[ag-ui][compat] Flattening message content for a <=0.0.39 peer DROPS non-text parts (${dropped.join(", ")}). The peer cannot receive them; upgrade it to keep media content. See DEPRECATIONS.md.`,
  );
}

function sanitizeMessageContent(message: InputMessage): InputMessage {
  const rawContent = (message as { content?: unknown }).content;

  if (Array.isArray(rawContent)) {
    const isText = (part: unknown): part is { type: "text"; text: string } =>
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      (part as { type: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string";

    // Losing content must never be silent: an image, audio, video, document
    // or binary part cannot survive the flattening a 0.0.39 peer requires.
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

  return {
    ...message,
    content: "",
  } as InputMessage;
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
