import type {
  Message,
  InputContentDataSource,
  InputContentUrlSource,
} from "@ag-ui/core";
import type {
  ModelMessage,
  TextPart,
  ImagePart,
  FilePart,
  ToolCallPart,
} from "ai";

function mediaSourceToUrl(source: InputContentDataSource | InputContentUrlSource): string {
  if (source.type === "data") {
    return `data:${source.mimeType};base64,${source.value}`;
  }
  return source.value;
}

function safeJsonParse(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return {};
  }
}

type UserPart = TextPart | ImagePart | FilePart;

// The user message content union from AG-UI (string | InputContent[]), derived
// from the Message union rather than re-declared here.
type UserContent = Extract<Message, { role: "user" }>["content"];

function toUserContent(content: UserContent): string | UserPart[] {
  if (!content) return "";
  if (typeof content === "string") return content;

  // A non-empty array converts to a parts array, even when every part is
  // text and even for a single part: joining text parts would alter the user's
  // input by introducing separators and losing part boundaries. Text is
  // user-provided and passes through verbatim, with no trimming and no
  // dropping of whitespace-only parts.
  const parts: UserPart[] = [];
  for (const part of content) {
    switch (part.type) {
      case "text":
        parts.push({ type: "text", text: part.text });
        break;
      case "image":
        parts.push({ type: "image", image: mediaSourceToUrl(part.source) });
        break;
      case "audio":
      case "video":
      case "document":
        parts.push({
          type: "file",
          data: mediaSourceToUrl(part.source),
          mediaType: part.source.mimeType ?? "application/octet-stream",
        });
        break;
      case "binary": {
        const source = part.url
          ? part.url
          : part.data && part.mimeType
            ? `data:${part.mimeType};base64,${part.data}`
            : undefined;
        if (!source) {
          console.warn(
            "[convertMessagesToVercelAISDKMessages] Dropping BinaryInputContent: no url or data provided",
          );
          break;
        }
        // Route by mimeType: only image/* becomes an image part; PDFs, audio,
        // video etc. are file parts carrying their real mediaType.
        if (!part.mimeType || part.mimeType.startsWith("image/")) {
          parts.push({ type: "image", image: source });
        } else {
          parts.push({ type: "file", data: source, mediaType: part.mimeType });
        }
        break;
      }
    }
  }
  // Providers reject an empty content array, so an empty turn is encoded as the
  // empty string; no user text is altered here because there is none.
  return parts.length ? parts : "";
}

function lookupToolName(messages: Message[], toolCallId: string): string {
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const tc of msg.toolCalls ?? []) {
        if (tc.id === toolCallId) {
          return tc.function.name;
        }
      }
    }
  }
  return "unknown";
}

// The assistant content parts union from the AI SDK (TextPart | FilePart |
// ReasoningPart | ToolCallPart | ...), without re-declaring the shapes here.
type AssistantParts = Exclude<Extract<ModelMessage, { role: "assistant" }>["content"], string>;

export function convertMessagesToVercelAISDKMessages(messages: Message[]): ModelMessage[] {
  const result: ModelMessage[] = [];
  // AG-UI persists reasoning as standalone messages preceding their assistant
  // message. Buffer them and fold them into that assistant message as AI SDK
  // reasoning parts — for Anthropic extended thinking, the signed thinking
  // block (encryptedValue) must be replayed with the assistant turn or
  // tool-use continuations are rejected.
  let pendingReasoning: AssistantParts = [];

  for (const message of messages) {
    switch (message.role) {
      case "developer":
      case "system":
        pendingReasoning = [];
        result.push({ role: "system", content: message.content });
        break;
      case "user":
        pendingReasoning = [];
        result.push({ role: "user", content: toUserContent(message.content) });
        break;
      case "assistant": {
        const parts: AssistantParts = [...pendingReasoning];
        pendingReasoning = [];
        if (message.content) {
          parts.push({ type: "text", text: message.content });
        }
        for (const tc of message.toolCalls ?? []) {
          parts.push({
            type: "tool-call",
            toolCallId: tc.id,
            toolName: tc.function.name,
            input: safeJsonParse(tc.function.arguments),
          });
        }
        result.push({
          role: "assistant",
          content: parts.length ? parts : "",
        });
        break;
      }
      case "tool":
        pendingReasoning = [];
        result.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: message.toolCallId,
              toolName: lookupToolName(messages, message.toolCallId),
              // Preserve failure signaling: providers map error-text to their
              // native is_error flag, so the model can distinguish a failed
              // or denied call from a tool that returned this text.
              output:
                message.error !== undefined
                  ? { type: "error-text", value: message.content }
                  : { type: "text", value: message.content },
            },
          ],
        });
        break;
      case "activity":
        pendingReasoning = [];
        break;
      case "reasoning":
        pendingReasoning.push({
          type: "reasoning",
          text: message.content ?? "",
          ...(message.encryptedValue
            ? { providerOptions: { anthropic: { signature: message.encryptedValue } } }
            : {}),
        });
        break;
    }
  }

  return result;
}
