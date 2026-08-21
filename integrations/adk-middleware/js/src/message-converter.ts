import type { Message, ToolMessage, UserMessage } from "@ag-ui/core";
import type { Runner } from "@google/adk";

import { isRecord } from "./value-utils";

type RunnerRunParams = Parameters<Runner["runAsync"]>[0];
export type AdkContent = RunnerRunParams["newMessage"];
type AdkPart = NonNullable<AdkContent["parts"]>[number];

export interface ConvertedMessage {
  author: string;
  content: AdkContent;
}

export class ADKMessageConversionError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ADKMessageConversionError";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : { result: value };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseToolArguments(
  value: string,
  toolCallId: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new ADKMessageConversionError(
      `Tool call ${toolCallId} has invalid JSON arguments: ${error instanceof Error ? error.message : String(error)}`,
      "INVALID_TOOL_ARGUMENTS",
    );
  }
  if (!isRecord(parsed)) {
    throw new ADKMessageConversionError(
      `Tool call ${toolCallId} arguments must decode to a JSON object.`,
      "INVALID_TOOL_ARGUMENTS",
    );
  }
  return parsed;
}

function findToolName(
  messages: readonly Message[],
  toolCallId: string,
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") {
      continue;
    }
    const call = message.toolCalls?.find(
      (candidate) => candidate.id === toolCallId,
    );
    if (call) {
      return call.function.name;
    }
  }
  return undefined;
}

function userParts(message: UserMessage): AdkPart[] {
  if (typeof message.content === "string") {
    return [{ text: message.content }];
  }

  return message.content.map((part): AdkPart => {
    if (part.type === "text") {
      return { text: part.text };
    }

    if (part.type === "binary") {
      if (part.data) {
        return { inlineData: { data: part.data, mimeType: part.mimeType } };
      }
      if (part.url) {
        return { fileData: { fileUri: part.url, mimeType: part.mimeType } };
      }
      throw new ADKMessageConversionError(
        `Binary attachment ${part.id ?? "unknown"} has no inline data or URL that Google ADK can consume.`,
        "UNSUPPORTED_BINARY_REFERENCE",
      );
    }

    if (part.source.type === "data") {
      return {
        inlineData: {
          data: part.source.value,
          mimeType: part.source.mimeType,
        },
      };
    }

    return {
      fileData: {
        fileUri: part.source.value,
        ...(part.source.mimeType ? { mimeType: part.source.mimeType } : {}),
      },
    };
  });
}

function toolResponse(message: ToolMessage): Record<string, unknown> {
  const parsed = asRecord(parseJson(message.content));
  return message.error ? { ...parsed, error: message.error } : parsed;
}

function modelMessageAuthor(
  message: Message,
  fallback: string,
  allowedAuthors?: ReadonlySet<string>,
): string {
  const name = "name" in message ? message.name : undefined;
  const author = name || fallback;
  if (name && allowedAuthors && !allowedAuthors.has(name)) {
    throw new ADKMessageConversionError(
      `AG-UI message ${message.id} names unknown Google ADK agent ${name}.`,
      "UNKNOWN_AGENT_AUTHOR",
    );
  }
  return author;
}

/** Convert one AG-UI history/input message into ADK's GenAI content model. */
export function convertMessage(
  message: Message,
  messages: readonly Message[],
  modelAuthor: string,
  allowedModelAuthors?: ReadonlySet<string>,
): ConvertedMessage | undefined {
  switch (message.role) {
    case "user":
      return {
        author: "user",
        content: { role: "user", parts: userParts(message) },
      };

    case "assistant": {
      const parts: AdkPart[] = [];
      if (message.content) {
        parts.push({ text: message.content });
      }
      for (const call of message.toolCalls ?? []) {
        parts.push({
          functionCall: {
            id: call.id,
            name: call.function.name,
            args: parseToolArguments(call.function.arguments, call.id),
          },
          ...(call.encryptedValue
            ? { thoughtSignature: call.encryptedValue }
            : {}),
        });
      }
      return {
        author: modelMessageAuthor(message, modelAuthor, allowedModelAuthors),
        content: { role: "model", parts },
      };
    }

    case "tool": {
      const name = findToolName(messages, message.toolCallId);
      if (!name) {
        throw new Error(
          `Cannot resolve ADK tool name for tool call ${message.toolCallId}.`,
        );
      }
      return {
        author: "user",
        content: {
          role: "user",
          parts: [
            {
              functionResponse: {
                id: message.toolCallId,
                name,
                response: toolResponse(message),
              },
            },
          ],
        },
      };
    }

    case "system":
    case "developer":
      throw new ADKMessageConversionError(
        `Dynamic ${message.role} messages cannot be represented faithfully by Google ADK. Configure instructions on the ADK Agent instead.`,
        "UNSUPPORTED_MESSAGE_ROLE",
      );

    case "reasoning":
      return {
        author: modelMessageAuthor(message, modelAuthor, allowedModelAuthors),
        content: {
          role: "model",
          parts: [
            {
              text: message.content,
              thought: true,
              ...(message.encryptedValue
                ? { thoughtSignature: message.encryptedValue }
                : {}),
            },
          ],
        },
      };

    case "activity":
      // Activity messages describe UI/runtime activity and must not be injected
      // into the model conversation as fabricated assistant text.
      return undefined;
  }
}
