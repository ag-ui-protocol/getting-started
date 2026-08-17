import { Message as LangGraphMessage } from "@langchain/langgraph-sdk";
import { State, SchemaKeys, LangGraphReasoning } from "./types";
import {
  Message,
  ReasoningMessage,
  ToolCall,
  TextInputContent,
  ImageInputContent,
  AudioInputContent,
  VideoInputContent,
  DocumentInputContent,
  InputContentDataSource,
  InputContentUrlSource,
  InputContent,
} from "@ag-ui/client";

export const DEFAULT_SCHEMA_KEYS = ["messages", "tools"];

export function filterObjectBySchemaKeys(obj: Record<string, any>, schemaKeys: string[]) {
  return Object.fromEntries(Object.entries(obj).filter(([key]) => schemaKeys.includes(key)));
}

export function getStreamPayloadInput({
  mode,
  state,
  schemaKeys,
}: {
  mode: "start" | "continue";
  state: State;
  schemaKeys: SchemaKeys;
}) {
  let input = mode === "start" ? state : null;
  // Do not input keys that are not part of the input schema
  if (input && schemaKeys?.input) {
    input = filterObjectBySchemaKeys(input, [...DEFAULT_SCHEMA_KEYS, ...schemaKeys.input]);
  }

  return input;
}

const MEDIA_CONTENT_TYPES = ["image", "audio", "video", "document"] as const;
type MediaContentType = (typeof MEDIA_CONTENT_TYPES)[number];
type MediaInputContent =
  | ImageInputContent
  | AudioInputContent
  | VideoInputContent
  | DocumentInputContent;
const DEFAULT_MEDIA_CONTENT_TYPE: MediaContentType = "image";

/**
 * Key under a HumanMessage's `response_metadata` that holds the multimodal
 * sidecar. `response_metadata` is the internal checkpoint channel: LangGraph
 * persists it through the checkpoint JSON round-trip, while provider request
 * serializers do not forward it to the model (unlike `additional_kwargs`).
 */
export const AGUI_MULTIMODAL_SIDECAR_KEY = "__agui_multimodal" as const;

/**
 * A provider-valid LangChain content block. Only the legacy `text` and
 * `image_url` shapes are emitted, with no extra keys, so strict
 * OpenAI-compatible providers accept the block unchanged. AG-UI media type and
 * metadata are carried out-of-band in the response_metadata sidecar instead.
 */
type LangchainMultimodalBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/**
 * A loosely-typed view of an incoming LangChain content block, used when
 * reading messages back. LangChain's `image_url` may be a bare string or an
 * object, so both are accepted.
 */
type LangchainContentBlock = {
  type: string;
  text?: string;
  image_url?: { url: string } | string;
};

/**
 * One entry of the aligned multimodal sidecar, indexed 1:1 with the message's
 * content blocks. `null` marks a block that carries no AG-UI media type (text
 * or legacy binary). Otherwise it records the original media type and, when the
 * source block had one, its arbitrary `InputContent.metadata`.
 */
type MultimodalSidecarEntry = null | {
  type: MediaContentType;
  metadata?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMediaContentType(value: unknown): value is MediaContentType {
  switch (value) {
    case "image":
    case "audio":
    case "video":
    case "document":
      return true;
    default:
      return false;
  }
}

function isMediaInputContent(content: InputContent): content is MediaInputContent {
  switch (content.type) {
    case "image":
    case "audio":
    case "video":
    case "document":
      return true;
    case "text":
    case "binary":
      return false;
    default: {
      const exhaustiveCheck: never = content;
      return exhaustiveCheck;
    }
  }
}

function createMediaInputContent(
  type: MediaContentType,
  source: InputContentDataSource | InputContentUrlSource,
  metadata?: unknown,
): MediaInputContent {
  const optionalMetadata = metadata === undefined ? {} : { metadata };

  switch (type) {
    case "image":
      return { type, source, ...optionalMetadata };
    case "audio":
      return { type, source, ...optionalMetadata };
    case "video":
      return { type, source, ...optionalMetadata };
    case "document":
      return { type, source, ...optionalMetadata };
    default: {
      const exhaustiveCheck: never = type;
      return exhaustiveCheck;
    }
  }
}

function mediaSourceToUrl(source: InputContentDataSource | InputContentUrlSource): string | null {
  if (source.type === "data") {
    return `data:${source.mimeType};base64,${source.value}`;
  } else if (source.type === "url") {
    return source.value;
  }
  return null;
}

// Turn an `image_url` string back into an AG-UI content source. `data:` URLs are
// parsed into a data source; everything else is treated as a plain URL.
function imageUrlToSource(imageUrl: string): InputContentDataSource | InputContentUrlSource {
  if (imageUrl.startsWith("data:")) {
    // Format: data:mime_type;base64,data
    const [header, data] = imageUrl.split(",", 2);
    const mimeType = header.includes(":") ? header.split(":")[1].split(";")[0] : "image/png";
    return { type: "data", value: data || "", mimeType };
  }
  return { type: "url", value: imageUrl };
}

/**
 * Validate and normalize the raw multimodal sidecar read from a HumanMessage's
 * `response_metadata`. Returns a sidecar aligned 1:1 with the message content
 * blocks, or `null` when the value is missing or malformed in any way — a wrong
 * length, a non-array, or an entry that is neither `null` nor a record carrying
 * a known media `type`. Returning `null` makes the caller fall back to the
 * legacy behavior instead of misattaching metadata to the wrong block.
 */
function parseMultimodalSidecar(raw: unknown, expectedLength: number): MultimodalSidecarEntry[] | null {
  if (!Array.isArray(raw) || raw.length !== expectedLength) return null;

  const parsed: MultimodalSidecarEntry[] = [];
  for (const entry of raw) {
    if (entry === null) {
      parsed.push(null);
      continue;
    }
    if (!isRecord(entry) || !isMediaContentType(entry.type)) return null;
    const normalized: { type: MediaContentType; metadata?: unknown } = { type: entry.type };
    // Preserve arbitrary metadata verbatim (primitives, arrays, objects). Only
    // copy the key when it was actually present so absent metadata round-trips
    // to `undefined` rather than an explicit `metadata: undefined`.
    if ("metadata" in entry) normalized.metadata = entry.metadata;
    parsed.push(normalized);
  }
  return parsed;
}

/**
 * Convert LangChain's multimodal content to AG-UI format.
 *
 * LangChain only supports `text` and `image_url` content blocks. Each
 * `image_url` block is restored to its original AG-UI media type and metadata
 * using the aligned `sidecar` (indexed by block position). Blocks with no valid
 * sidecar entry fall back to `DEFAULT_MEDIA_CONTENT_TYPE` with no metadata,
 * preserving the legacy behavior for untagged/legacy checkpoints.
 */
function convertLangchainMultimodalToAgui(
  content: Array<LangchainContentBlock>,
  sidecar: MultimodalSidecarEntry[] | null,
): InputContent[] {
  const aguiContent: InputContent[] = [];

  content.forEach((item, index) => {
    if (item.type === "text" && item.text) {
      aguiContent.push({
        type: "text",
        text: item.text,
      });
    } else if (item.type === "image_url") {
      const imageUrl = typeof item.image_url === "string" ? item.image_url : item.image_url?.url;

      // Guard against malformed checkpoint data (e.g. a non-string url); a bad
      // block is skipped rather than crashing imageUrlToSource on `.startsWith`.
      if (typeof imageUrl !== "string" || !imageUrl) return;

      // The sidecar is already validated, so an entry is either null or a record
      // with a known media type. Index alignment guarantees we only read the
      // entry for this exact block.
      const entry = sidecar?.[index] ?? null;
      const restoredType = entry ? entry.type : DEFAULT_MEDIA_CONTENT_TYPE;
      const metadata = entry && "metadata" in entry ? entry.metadata : undefined;

      aguiContent.push(createMediaInputContent(restoredType, imageUrlToSource(imageUrl), metadata));
    }
  });

  return aguiContent;
}

/**
 * Convert AG-UI multimodal content to LangChain's format.
 *
 * Handles the new typed content classes (ImageInputContent, AudioInputContent,
 * VideoInputContent, DocumentInputContent) as well as legacy BinaryInputContent
 * for backwards compatibility. All media types are routed through LangChain's
 * `image_url` format since that is the only media block type LangChain supports.
 *
 * Returns provider-valid content blocks (no extra keys) plus an aligned sidecar
 * that records each media block's original AG-UI type and metadata so the
 * reverse converter can restore them from `response_metadata`.
 */
function convertAguiMultimodalToLangchain(content: InputContent[]): {
  content: LangchainMultimodalBlock[];
  sidecar: MultimodalSidecarEntry[];
} {
  const langchainContent: LangchainMultimodalBlock[] = [];
  const sidecar: MultimodalSidecarEntry[] = [];

  for (const item of content) {
    if (item.type === "text") {
      langchainContent.push({
        type: "text",
        text: item.text,
      });
      sidecar.push(null);
    } else if (isMediaInputContent(item)) {
      // ImageInputContent, AudioInputContent, VideoInputContent, DocumentInputContent
      const url = mediaSourceToUrl(item.source);
      if (url) {
        // The block stays a plain legacy image_url so strict providers accept
        // it; the media type and metadata go into the sidecar instead.
        langchainContent.push({
          type: "image_url",
          image_url: { url },
        });
        const entry: { type: MediaContentType; metadata?: unknown } = { type: item.type };
        if (item.metadata !== undefined) entry.metadata = item.metadata;
        sidecar.push(entry);
      } else {
        console.warn(`[convertAguiMultimodalToLangchain] Dropping ${item.type} content: source could not be converted to URL`);
      }
    } else if (item.type === "binary") {
      // Legacy BinaryInputContent — backwards compatibility. Unchanged: records
      // a null sidecar entry (to keep 1:1 index alignment), so it reads back as
      // the legacy image fallback.
      let url: string;

      // Prioritize url, then data, then id
      if (item.url) {
        url = item.url;
      } else if (item.data) {
        // Construct data URL from base64 data
        url = `data:${item.mimeType};base64,${item.data}`;
      } else if (item.id) {
        // Use id as a reference
        url = item.id;
      } else {
        console.warn("[convertAguiMultimodalToLangchain] Dropping BinaryInputContent: no url, data, or id provided");
        continue;
      }

      langchainContent.push({
        type: "image_url",
        image_url: { url },
      });
      sidecar.push(null);
    }
  }

  return { content: langchainContent, sidecar };
}

// A reasoning content block as it appears on a LangChain assistant message
// (OpenAI Responses `responses/v1` shape). It is not part of the LangGraph SDK's
// typed content union, so it is declared here for narrowing.
interface ReasoningSummaryEntry {
  type?: string;
  text?: string;
}

interface ReasoningContentBlock {
  type: "reasoning";
  id?: string;
  summary?: ReasoningSummaryEntry[];
  encrypted_content?: string;
  // Flat-text shapes emitted by some non-OpenAI providers.
  reasoning?: string;
  text?: string;
}

function isReasoningBlock(block: unknown): block is ReasoningContentBlock {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "reasoning"
  );
}

// Extract the human-readable reasoning text from a reasoning content block.
function reasoningBlockSummaryText(block: ReasoningContentBlock): string {
  if (Array.isArray(block.summary)) {
    const parts = block.summary
      .map((entry) => entry?.text)
      .filter((text): text is string => Boolean(text));
    // Join multi-part summaries with a newline so the parts stay legible
    // instead of being mashed together ("A\nB", not "AB").
    if (parts.length) return parts.join("\n");
  }
  return block.reasoning ?? block.text ?? "";
}

// Turn a LangChain reasoning content block into an AG-UI ReasoningMessage,
// preserving the block id (the provider's `rs_…` handle — under store=true it is
// the only round-trip key) and any encrypted content (needed for store=false).
// Returns null only for a wholly empty block (nothing to render or round-trip).
function reasoningBlockToAguiMessage(
  block: ReasoningContentBlock,
  assistantId: string,
  index = 0,
): ReasoningMessage | null {
  const text = reasoningBlockSummaryText(block);
  const encrypted = block.encrypted_content;
  if (!block.id && !text && !encrypted) return null;
  const message: ReasoningMessage = {
    // Include the block index in the fallback id so multiple id-less reasoning
    // blocks on one message don't collide on the same id.
    id: String(block.id ?? `${assistantId}-reasoning-${index}`),
    role: "reasoning",
    content: text,
  };
  if (encrypted) message.encryptedValue = encrypted;
  return message;
}

// Rebuild the LangChain reasoning content block from an AG-UI ReasoningMessage
// (inverse of reasoningBlockToAguiMessage).
function aguiReasoningMessageToBlock(message: ReasoningMessage): ReasoningContentBlock {
  const block: ReasoningContentBlock = {
    type: "reasoning",
    id: message.id,
    summary: message.content
      ? [{ type: "summary_text", text: message.content }]
      : [],
  };
  if (message.encryptedValue) block.encrypted_content = message.encryptedValue;
  return block;
}

export function langchainMessagesToAgui(messages: LangGraphMessage[]): Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    switch (message.type) {
      case "human": {
        // Handle multimodal content
        let userContent: string | InputContent[];
        if (Array.isArray(message.content)) {
          const blocks = message.content as LangchainContentBlock[];
          const rawSidecar = isRecord(message.response_metadata)
            ? message.response_metadata[AGUI_MULTIMODAL_SIDECAR_KEY]
            : undefined;
          const sidecar = parseMultimodalSidecar(rawSidecar, blocks.length);
          userContent = convertLangchainMultimodalToAgui(blocks, sidecar);
        } else {
          userContent = stringifyIfNeeded(resolveMessageContent(message.content));
        }

        out.push({
          id: message.id!,
          role: "user",
          content: userContent,
        });
        break;
      }
      case "ai": {
        // "generic" messages are treated the same as "ai" — LangGraph
        // emits them for non-chat models that don't set a specific type.
        // Surface reasoning content blocks as standalone ReasoningMessages
        // placed BEFORE the assistant message (matching streaming order), so a
        // client with no persistent checkpoint can round-trip them.
        if (Array.isArray(message.content)) {
          message.content.forEach((block, index) => {
            if (isReasoningBlock(block)) {
              const reasoningMsg = reasoningBlockToAguiMessage(block, message.id!, index);
              if (reasoningMsg) out.push(reasoningMsg);
            }
          });
        }
        const aiContent = resolveMessageContent(message.content);
        out.push({
          id: message.id!,
          role: "assistant",
          content: aiContent ? stringifyIfNeeded(aiContent) : '',
          toolCalls: message.tool_calls?.map((tc) => ({
            id: tc.id!,
            type: "function",
            function: {
              name: tc.name,
              // Default missing args to "{}" (parity with the Python side);
              // JSON.stringify(undefined) would emit an invalid `undefined`.
              arguments: JSON.stringify(tc.args ?? {}),
            },
          })),
        });
        break;
      }
      case "system":
        out.push({
          id: message.id!,
          role: "system",
          content: stringifyIfNeeded(resolveMessageContent(message.content)),
        });
        break;
      case "tool":
        out.push({
          id: message.id!,
          role: "tool",
          content: stringifyIfNeeded(resolveMessageContent(message.content)),
          toolCallId: message.tool_call_id,
          // A LangChain tool result signals failure only through `status`, with no
          // error text. Restore AG-UI's `error` so the failure survives the round
          // trip; the value is a fixed sentinel (#2305) because the original text is
          // not recoverable from the flag alone.
          ...(message.status === "error" ? { error: "error" } : {}),
        });
        break;
      default:
        if ((message as any).type === "generic") {
          // Re-enter the "ai" branch for generic messages
          const aiMsg = message as any;
          if (Array.isArray(aiMsg.content)) {
            aiMsg.content.forEach((block: any, index: number) => {
              if (isReasoningBlock(block)) {
                const reasoningMsg = reasoningBlockToAguiMessage(block, aiMsg.id, index);
                if (reasoningMsg) out.push(reasoningMsg);
              }
            });
          }
          const aiContent = resolveMessageContent(aiMsg.content);
          out.push({
            id: aiMsg.id,
            role: "assistant",
            content: aiContent ? stringifyIfNeeded(aiContent) : '',
            toolCalls: aiMsg.tool_calls?.map((tc: any) => ({
              id: tc.id!,
              type: "function",
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.args ?? {}),
              },
            })),
          });
          break;
        }
        throw new Error("message type returned from LangGraph is not supported.");
    }
  }
  return out;
}

export function aguiMessagesToLangChain(messages: Message[]): LangGraphMessage[] {
  const out: LangGraphMessage[] = [];
  // Reasoning is display-only at the AG-UI layer but lives as a content block ON
  // the assistant AIMessage at the LangChain layer. To round-trip reasoning
  // without loss (so a stateless client can hand the model back its own
  // chain-of-thought), buffer reasoning messages and re-attach them as content
  // blocks on the assistant that follows (matching streaming order). Developer
  // messages stay dropped — they are configured on the agent itself.
  //
  // Reasoning that is NOT immediately followed by an assistant message (trailing,
  // or followed by a user/tool/system message) is intentionally discarded: there
  // is no assistant to attach it to, and re-materializing it as a standalone
  // message causes exponential message duplication and tool-call loops under the
  // add_messages reducer. The snapshot side (langchainMessagesToAgui) only ever
  // emits reasoning immediately before its assistant, so this drop never affects
  // a real round-trip — only hand-crafted / partial inputs.
  let pendingReasoning: ReasoningContentBlock[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "reasoning":
        pendingReasoning.push(aguiReasoningMessageToBlock(message));
        continue;
      case "developer":
        continue;
      case "user": {
        pendingReasoning = [];
        // Handle multimodal content
        let content: string | LangchainMultimodalBlock[];
        let responseMetadata: Record<string, unknown> | undefined;
        if (typeof message.content === "string") {
          content = message.content;
        } else if (Array.isArray(message.content)) {
          const converted = convertAguiMultimodalToLangchain(message.content);
          content = converted.content;
          // Only attach the sidecar when it actually carries media info, so
          // text-only / legacy-binary-only messages stay free of extra metadata.
          if (converted.sidecar.some((entry) => entry !== null)) {
            responseMetadata = { [AGUI_MULTIMODAL_SIDECAR_KEY]: converted.sidecar };
          }
        } else {
          content = String(message.content);
        }

        out.push({
          id: message.id,
          role: message.role,
          content,
          type: "human",
          ...(responseMetadata ? { response_metadata: responseMetadata } : {}),
        } as LangGraphMessage);
        break;
      }
      case "assistant": {
        // Fold any buffered reasoning blocks onto this assistant message.
        let content: string | Array<ReasoningContentBlock | { type: "text"; text: string }>;
        if (pendingReasoning.length) {
          const blocks: Array<ReasoningContentBlock | { type: "text"; text: string }> = [
            ...pendingReasoning,
          ];
          if (message.content) blocks.push({ type: "text", text: message.content });
          content = blocks;
          pendingReasoning = [];
        } else {
          content = message.content ?? "";
        }
        out.push({
          id: message.id,
          type: "ai",
          role: message.role,
          content,
          tool_calls: (message.toolCalls ?? []).map((tc: ToolCall) => ({
            id: tc.id,
            name: tc.function.name,
            // Guard empty/absent arguments (parity with the Python side):
            // JSON.parse("") throws and would abort the whole conversion.
            args: tc.function.arguments ? JSON.parse(tc.function.arguments) : {},
            type: "tool_call",
          })),
        } as LangGraphMessage);
        break;
      }
      case "system":
        pendingReasoning = [];
        out.push({
          id: message.id,
          role: message.role,
          content: message.content,
          type: "system",
        } as LangGraphMessage);
        break;
      case "tool":
        pendingReasoning = [];
        out.push({
          content: message.content,
          role: message.role,
          type: message.role,
          tool_call_id: message.toolCallId,
          id: message.id,
          // Carry the AG-UI failure signal onto LangChain's tool-result status, so a
          // client-reported tool failure is not delivered to the model as a success.
          status: message.error ? "error" : "success",
        } as LangGraphMessage);
        break;
      default:
        console.error(`Message role ${(message as { role: string }).role} is not implemented`);
        throw new Error("message role is not supported.");
    }
  }
  return out;
}

function stringifyIfNeeded(item: any) {
  if (typeof item === "string") return item;
  return JSON.stringify(item);
}

export function resolveReasoningContent(eventData: any): LangGraphReasoning | null {
  const content = eventData.chunk?.content

  if (content && Array.isArray(content) && content.length && content[0]) {
    const block = content[0];

    // Old langchain-anthropic format: { type: "thinking", thinking: "..." }
    if (block.type === 'thinking' && block.thinking) {
      const result: LangGraphReasoning = {
        text: block.thinking,
        type: 'text',
        index: block.index ?? 0,
      }
      // Extract signature if present (Anthropic extended thinking signature)
      if (block.signature) {
        result.signature = block.signature;
      }
      return result;
    }

    // New LangChain standardized format: { type: "reasoning", reasoning: "..." }
    if (block.type === 'reasoning' && block.reasoning) {
      return {
        text: block.reasoning,
        type: 'text',
        index: block.index ?? 0,
      }
    }

    // OpenAI Responses API v1 format: { type: "reasoning", summary: [{ text: "..." }] }
    //
    // The reasoning item's canonical id (OpenAI `rs_…`) only travels on
    // text-less chunks: the `response.output_item.added` chunk ({ id,
    // summary: [] }) and — depending on the langchain-openai version — the
    // `…summary_part.added` chunk ({ id, summary: [{ text: "" }] }). The
    // `…summary_text.delta` chunks carry text but no id. Surface the id
    // carriers (instead of dropping them for having no text) so the streamed
    // reasoning message can adopt the canonical id — the id the snapshot
    // converter emits for the same block; handleReasoningEvent stashes the id
    // without opening a message, so summary-less (store=true) items still
    // render nothing. Only the first summary part takes the id: later parts
    // belong to the same item, and reusing its id would mint two messages
    // with one id.
    if (block.type === 'reasoning' && Array.isArray(block.summary)) {
      if (block.summary.length === 0 && block.id) {
        return { type: 'text', text: '', index: block.index ?? 0, id: String(block.id) };
      }
      const part = block.summary[0];
      if (part && typeof part === 'object' && (part.text || block.id)) {
        const result: LangGraphReasoning = {
          type: 'text',
          text: part.text ?? '',
          index: part.index ?? 0,
        };
        if (block.id && (part.index ?? 0) === 0) {
          result.id = String(block.id);
        }
        return result;
      }
    }

    // Bedrock Converse API format: { type: "reasoning_content", reasoning_content: { type: "text", text: "..." } }
    if (block.type === 'reasoning_content' && block.reasoning_content?.text) {
      return {
        type: 'text',
        text: block.reasoning_content.text,
        index: block.reasoning_content.index ?? 0,
      }
    }
  }

  // OpenAI legacy format via additional_kwargs
  if (eventData.chunk?.additional_kwargs?.reasoning?.summary?.[0]) {
    const data = eventData.chunk.additional_kwargs.reasoning.summary[0]
    if (!data || !data.text) return null
    return {
      type: 'text',
      text: data.text,
      index: data.index ?? 0,
    }
  }

  // DeepSeek-style format: additional_kwargs.reasoning_content (plain string)
  const reasoningContent = eventData.chunk?.additional_kwargs?.reasoning_content
  if (reasoningContent && typeof reasoningContent === 'string') {
    return {
      type: 'text',
      text: reasoningContent,
      index: 0,
    }
  }

  return null
}

/**
 * Resolves encrypted reasoning content from Anthropic responses.
 * This handles:
 * - `signature` fields on thinking blocks (cryptographic verification)
 * - `redacted_thinking` blocks with encrypted `data` (redacted chain-of-thought)
 */
export function resolveEncryptedReasoningContent(eventData: any): string | null {
  const content = eventData.chunk?.content

  if (!content || !Array.isArray(content) || !content.length || !content[0]) {
    return null;
  }

  // Anthropic redacted_thinking block: { type: "redacted_thinking", data: "..." }
  if (content[0].type === 'redacted_thinking' && content[0].data) {
    return content[0].data;
  }

  return null;
}

export function resolveMessageContent(content?: LangGraphMessage['content']): string | null {
  if (!content) return null;

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content) && content.length) {
    const contentText = content.find(c => c.type === 'text')?.text
    return contentText ?? null;
  }

  return null
}
