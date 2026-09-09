import { Middleware } from "./middleware";
import { AbstractAgent } from "@/agent";
import type { RunAgentInput, BaseEvent } from "@ag-ui/core";
import type { Observable } from "rxjs";

type InputMessage = RunAgentInput["messages"][number];

interface LegacyBinaryContent {
  type: "binary";
  mimeType: string;
  id?: string;
  url?: string;
  data?: string;
  filename?: string;
}

interface NewContentPart {
  type: "image" | "audio" | "video" | "document";
  source:
    | { type: "data"; value: string; mimeType: string }
    | { type: "url"; value: string; mimeType: string };
  metadata?: unknown;
}

function mimeTypeToContentType(mimeType: string): "image" | "audio" | "video" | "document" {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
}

export function isLegacyBinaryContent(part: unknown): part is LegacyBinaryContent {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    (part as { type: unknown }).type === "binary" &&
    "mimeType" in part &&
    typeof (part as { mimeType: unknown }).mimeType === "string"
  );
}

export function convertBinaryToNewFormat(
  binary: LegacyBinaryContent,
): NewContentPart | LegacyBinaryContent {
  const contentType = mimeTypeToContentType(binary.mimeType);

  if (binary.data) {
    return {
      type: contentType,
      source: { type: "data", value: binary.data, mimeType: binary.mimeType },
      ...(binary.filename ? { metadata: { filename: binary.filename } } : {}),
    };
  }

  if (binary.url) {
    return {
      type: contentType,
      source: { type: "url", value: binary.url, mimeType: binary.mimeType },
      ...(binary.filename ? { metadata: { filename: binary.filename } } : {}),
    };
  }

  // If only `id` is present, we can't map to the new source format. The part
  // stays in its legacy shape — which the 1.0 contract no longer accepts —
  // so losing it downstream must not be silent.
  if (
    typeof process === "undefined" ||
    typeof process.env === "undefined" ||
    !process.env.SUPPRESS_TRANSFORMATION_WARNINGS
  ) {
    console.warn(
      `[ag-ui][compat] A binary content part carries only an id ('${binary.id ?? ""}') and cannot be converted to a modern media part; a 1.0 peer will not accept it. Provide data or a url. See the repo-root DEPRECATIONS.md.`,
    );
  }
  return binary;
}

export function upgradeMessageContent(message: InputMessage): InputMessage {
  const rawContent = (message as { content?: unknown }).content;

  if (!Array.isArray(rawContent)) {
    return message;
  }

  const upgraded = rawContent.map((part: unknown) => {
    if (isLegacyBinaryContent(part)) {
      return convertBinaryToNewFormat(part);
    }
    return part;
  });

  return { ...message, content: upgraded } as InputMessage;
}

/**
 * Middleware that converts legacy BinaryInputContent entries (type: "binary")
 * to the new dedicated content types (image, audio, video, document) with
 * source discriminator.
 *
 * Old format (v0.0.47 and below):
 *   { type: "binary", mimeType: "image/png", data: "base64..." }
 *
 * New format (v0.0.48+):
 *   { type: "image", source: { type: "data", value: "base64...", mimeType: "image/png" } }
 *
 * Plain string content and TextInputContent pass through unchanged.
 * BinaryInputContent entries that only have `id` (no data/url) are left as-is
 * since they can't be mapped to the new source format.
 */
export class BackwardCompatibility_0_0_47 extends Middleware {
  override run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    const upgradedInput: RunAgentInput = {
      ...input,
      messages: input.messages.map(upgradeMessageContent),
    };

    return this.runNext(upgradedInput, next);
  }
}
