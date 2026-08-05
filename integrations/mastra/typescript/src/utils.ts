import type {
  InputContent,
  InputContentDataSource,
  InputContentUrlSource,
  Message,
} from "@ag-ui/client";
import { AbstractAgent } from "@ag-ui/client";
import { MastraClient } from "@mastra/client-js";
import type { Mastra } from "@mastra/core";
import type { CoreMessage } from "@mastra/core/llm";
import { Agent as LocalMastraAgent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { MastraAgent, MastraTracingOptions } from "./mastra";

/**
 * CoreMessage extended with an optional `id` field.
 * Mastra's `inputToMastraDBMessage` checks `"id" in message` at runtime
 * and preserves it when present, but the upstream AI SDK type doesn't
 * declare the field. This type makes the pass-through explicit.
 * Ref: https://github.com/mastra-ai/mastra/blob/13f46064564fc4aee14aa11878f9352d79f4efc4/packages/core/src/agent/message-list/conversion/input-converter.ts#L79
 */
type CoreMessageWithId = CoreMessage & { id?: string };

/**
 * Coerce an AG-UI message id into the charset the OpenAI Responses API accepts
 * for `input[].id` (`^[A-Za-z0-9_-]+$`). Client-minted ids (e.g. CopilotKit's
 * `msg-…`) can contain characters the Responses API rejects; once such an id is
 * replayed as prior-turn history (turn 2+), the request 400s wholesale
 * (`AI_APICallError: Invalid 'input[N].id'`), which breaks every multi-turn
 * chat on a Responses-API model. AI SDK v5's `openai(model)` defaults to that
 * API, so this hits any Mastra agent using the default provider.
 *
 * The mapping is deterministic and idempotent: an already-valid id is returned
 * unchanged (the common case — Mastra-minted assistant ids are UUIDs, a no-op),
 * and any given id always maps to the same sanitized value. That determinism is
 * load-bearing for Mastra's history dedup (see convertAGUIMessagesToMastra): a
 * message is sanitized identically every time it passes through this converter —
 * both when first stored and when re-sent — so upsert-by-id still matches.
 */
const RESPONSES_API_ID_CHARSET = /^[A-Za-z0-9_-]+$/;
function toModelSafeMessageId(id: string): string {
  return RESPONSES_API_ID_CHARSET.test(id)
    ? id
    : id.replace(/[^A-Za-z0-9_-]/g, "-");
}

function mediaSourceToUrl(
  source: InputContentDataSource | InputContentUrlSource,
): string {
  if (source.type === "data") {
    return `data:${source.mimeType};base64,${source.value}`;
  }
  return source.value;
}

const toMastraTextContent = (content: Message["content"]): string => {
  if (!content) {
    return "";
  }

  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  type TextInput = Extract<InputContent, { type: "text" }>;

  const textParts = content
    .filter((part): part is TextInput => part.type === "text")
    .map((part: TextInput) => part.text.trim())
    .filter(Boolean);

  return textParts.join("\n");
};

const toMastraContent = (content: Message["content"]): string | any[] => {
  if (!content) {
    return "";
  }

  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  // Convert content parts to Mastra format
  const parts: any[] = [];
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
          mimeType: part.source.mimeType ?? "application/octet-stream",
        });
        break;
      case "binary": {
        // Deprecated BinaryInputContent
        const binaryPart = part as Extract<InputContent, { type: "binary" }>;
        if (binaryPart.url) {
          parts.push({ type: "image", image: binaryPart.url });
        } else if (binaryPart.data && binaryPart.mimeType) {
          parts.push({
            type: "image",
            image: `data:${binaryPart.mimeType};base64,${binaryPart.data}`,
          });
        } else {
          console.warn(
            "[toMastraContent] Dropping BinaryInputContent: no url or data provided",
          );
        }
        break;
      }
      default:
        console.warn(
          `[toMastraContent] Unknown content type "${part.type}"; skipping`,
        );
        break;
    }
  }
  return parts;
};

export function convertAGUIMessagesToMastra(
  messages: Message[],
  // Messages to resolve a tool message's toolName against. Defaults to
  // `messages`, but callers that send only a diff (the new turn) must pass the
  // full incoming history here: a tool-result's matching assistant tool-call
  // may have been filtered out of `messages`, and resolving toolName to
  // "unknown" makes Mastra store a broken tool result (the model then re-calls).
  lookupMessages: Message[] = messages,
): CoreMessageWithId[] {
  // Preserve AG-UI message IDs on the CoreMessage objects (see CoreMessageWithId).
  // Mastra's AIV4Adapter.fromCoreMessage reads `id` when present, which enables
  // Mastra's MessageHistory processor to deduplicate re-sent history:
  //   - processInput filters historical messages whose IDs match the input IDs
  //   - storage.saveMessages upserts by ID, so re-sent history won't duplicate
  // The `id` key is omitted when undefined so it doesn't defeat Mastra's
  // `"id" in message` check. Preserved ids are routed through
  // `toModelSafeMessageId` so a client-minted id can't 400 the OpenAI Responses
  // API when it is replayed as `input[].id` on later turns (deterministic, so
  // dedup is unaffected).
  const result: CoreMessageWithId[] = [];

  for (const message of messages) {
    if (message.role === "assistant") {
      const assistantContent = toMastraTextContent(message.content);
      const parts: any[] = [];
      if (assistantContent) {
        parts.push({ type: "text", text: assistantContent });
      }
      for (const toolCall of message.toolCalls ?? []) {
        parts.push({
          type: "tool-call",
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          args: JSON.parse(toolCall.function.arguments),
        });
      }
      result.push({
        ...(message.id !== undefined
          ? { id: toModelSafeMessageId(message.id) }
          : {}),
        role: "assistant",
        content: parts,
      } as CoreMessage);
    } else if (message.role === "user") {
      const userContent = toMastraContent(message.content);
      result.push({
        ...(message.id !== undefined
          ? { id: toModelSafeMessageId(message.id) }
          : {}),
        role: "user",
        content: userContent,
      } as CoreMessage);
    } else if (message.role === "tool") {
      let toolName = "unknown";
      for (const msg of lookupMessages) {
        if (msg.role === "assistant") {
          for (const toolCall of msg.toolCalls ?? []) {
            if (toolCall.id === message.toolCallId) {
              toolName = toolCall.function.name;
              break;
            }
          }
        }
      }
      result.push({
        ...(message.id !== undefined
          ? { id: toModelSafeMessageId(message.id) }
          : {}),
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.toolCallId,
            toolName: toolName,
            result: message.content,
          },
        ],
      } as CoreMessage);
    }
  }

  return result;
}

export interface GetRemoteAgentsOptions {
  mastraClient: MastraClient;
  resourceId: string;
  /**
   * Surface Mastra Observational Memory (OM) background work as AG-UI activity
   * events (activityType `mastra-observational-memory`). `true` enables it for
   * every agent; pass an array of agent ids to enable it only for those.
   * Default OFF. The remote agent must have OM enabled on its Memory server-side
   * — this only controls whether the bridge surfaces the `data-om-*` chunks it
   * streams. See `MastraAgentConfig.observationalMemory`.
   */
  observationalMemory?: boolean | string[];
  /** Mastra tracing options forwarded to each run. See MastraAgentConfig.tracingOptions. */
  tracingOptions?: MastraTracingOptions;
}

export async function getRemoteAgents({
  mastraClient,
  resourceId,
  observationalMemory,
  tracingOptions,
}: GetRemoteAgentsOptions): Promise<Record<string, AbstractAgent>> {
  const agents = await mastraClient.listAgents();

  const wantsObservationalMemory = (agentId: string): boolean =>
    observationalMemory === true ||
    (Array.isArray(observationalMemory) &&
      observationalMemory.includes(agentId));

  return Object.entries(agents).reduce(
    (acc, [agentId]) => {
      const agent = mastraClient.getAgent(agentId);

      acc[agentId] = new MastraAgent({
        agentId,
        agent,
        resourceId,
        // Enables syncing input.state into the remote server's working memory
        // (client -> agent shared state), mirroring the local path.
        remoteClient: mastraClient,
        observationalMemory: wantsObservationalMemory(agentId)
          ? true
          : undefined,
        tracingOptions,
      });

      return acc;
    },
    {} as Record<string, AbstractAgent>,
  );
}

export interface GetLocalAgentsOptions {
  mastra: Mastra;
  resourceId: string;
  requestContext?: RequestContext;
  /**
   * Enable Mastra's `untilIdle` run mode (background-task lifecycle piped into
   * the run's fullStream). `true` enables it for every agent; pass an array of
   * agent ids to enable it only for those. See `MastraAgentConfig.untilIdle`.
   */
  untilIdle?: boolean | string[];
  /**
   * Surface Mastra Observational Memory (OM) background work as AG-UI activity
   * events (activityType `mastra-observational-memory`). `true` enables it for
   * every agent; pass an array of agent ids to enable it only for those.
   * Default OFF. See `MastraAgentConfig.observationalMemory`.
   */
  observationalMemory?: boolean | string[];
  /** Mastra tracing options forwarded to each run. See MastraAgentConfig.tracingOptions. */
  tracingOptions?: MastraTracingOptions;
}

export function getLocalAgents({
  mastra,
  resourceId,
  requestContext,
  untilIdle,
  observationalMemory,
  tracingOptions,
}: GetLocalAgentsOptions): Record<string, AbstractAgent> {
  const agents = mastra.listAgents() || {};

  const wantsUntilIdle = (agentId: string): boolean =>
    untilIdle === true ||
    (Array.isArray(untilIdle) && untilIdle.includes(agentId));

  const wantsObservationalMemory = (agentId: string): boolean =>
    observationalMemory === true ||
    (Array.isArray(observationalMemory) &&
      observationalMemory.includes(agentId));

  const agentAGUI = Object.entries(agents).reduce(
    (acc, [agentId, agent]) => {
      acc[agentId] = new MastraAgent({
        agentId,
        agent,
        resourceId,
        requestContext,
        untilIdle: wantsUntilIdle(agentId) ? true : undefined,
        observationalMemory: wantsObservationalMemory(agentId)
          ? true
          : undefined,
        tracingOptions,
      });
      return acc;
    },
    {} as Record<string, AbstractAgent>,
  );

  return agentAGUI;
}

export interface GetLocalAgentOptions {
  mastra: Mastra;
  agentId: string;
  resourceId: string;
  requestContext?: RequestContext;
  /** Mastra tracing options forwarded to the run. See MastraAgentConfig.tracingOptions. */
  tracingOptions?: MastraTracingOptions;
}

export function getLocalAgent({
  mastra,
  agentId,
  resourceId,
  requestContext,
  tracingOptions,
}: GetLocalAgentOptions) {
  const agent = mastra.getAgent(agentId);
  if (!agent) {
    throw new Error(`Agent ${agentId} not found`);
  }
  return new MastraAgent({
    agentId,
    agent,
    resourceId,
    requestContext,
    tracingOptions,
  }) as AbstractAgent;
}

export interface GetNetworkOptions {
  mastra: Mastra;
  networkId: string;
  resourceId: string;
  requestContext?: RequestContext;
  /** Mastra tracing options forwarded to the run. See MastraAgentConfig.tracingOptions. */
  tracingOptions?: MastraTracingOptions;
}

export function getNetwork({
  mastra,
  networkId,
  resourceId,
  requestContext,
  tracingOptions,
}: GetNetworkOptions) {
  const network = mastra.getAgent(networkId);
  if (!network) {
    throw new Error(`Network ${networkId} not found`);
  }
  return new MastraAgent({
    agentId: network.name!,
    agent: network as unknown as LocalMastraAgent,
    resourceId,
    requestContext,
    tracingOptions,
  }) as AbstractAgent;
}
