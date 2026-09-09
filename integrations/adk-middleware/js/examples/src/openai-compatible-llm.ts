import {
  BaseLlm,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from "@google/adk";
import { FinishReason } from "@google/genai";

interface OpenAICompatibleLlmConfig {
  model: string;
  baseUrl: string;
  apiKey?: string;
}

interface OpenAIToolCall {
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIChatCompletion {
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      tool_calls?: OpenAIToolCall[];
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string };
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function textFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) {
    return "";
  }
  return parts
    .map((part) => asObject(part)?.text)
    .filter((text): text is string => typeof text === "string")
    .join("");
}

function openAISchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(openAISchema);
  }
  const object = asObject(value);
  if (!object) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(object)
      .filter(([key]) => key !== "propertyOrdering")
      .map(([key, entry]) => [
        key,
        key === "type" && typeof entry === "string"
          ? entry.toLowerCase()
          : openAISchema(entry),
      ]),
  );
}

function openAITools(request: LlmRequest): unknown[] | undefined {
  const config = asObject(request.config);
  const tools = config?.tools;
  if (!Array.isArray(tools)) {
    return undefined;
  }

  const declarations = tools.flatMap((tool) => {
    const functionDeclarations = asObject(tool)?.functionDeclarations;
    return Array.isArray(functionDeclarations) ? functionDeclarations : [];
  });
  const allowed = request.allowedTools
    ? new Set(request.allowedTools)
    : undefined;

  const result = declarations.flatMap((declaration) => {
    const item = asObject(declaration);
    if (!item || typeof item.name !== "string" || !item.name) {
      return [];
    }
    if (allowed && !allowed.has(item.name)) {
      return [];
    }
    return [
      {
        type: "function",
        function: {
          name: item.name,
          ...(typeof item.description === "string"
            ? { description: item.description }
            : {}),
          parameters: openAISchema(item.parameters ?? { type: "object" }),
        },
      },
    ];
  });
  return result.length > 0 ? result : undefined;
}

function openAIMessages(request: LlmRequest): JsonObject[] {
  const messages: JsonObject[] = [];
  const systemInstruction = asObject(request.config)?.systemInstruction;
  const systemText =
    typeof systemInstruction === "string"
      ? systemInstruction
      : textFromParts(asObject(systemInstruction)?.parts);
  if (systemText) {
    messages.push({ role: "system", content: systemText });
  }

  for (const content of request.contents) {
    const contentObject = asObject(content);
    if (!contentObject) {
      continue;
    }
    const parts = Array.isArray(contentObject.parts) ? contentObject.parts : [];
    for (const part of parts) {
      const item = asObject(part);
      if (
        item &&
        (item.inlineData ||
          item.fileData ||
          item.executableCode ||
          item.codeExecutionResult)
      ) {
        throw new Error(
          "The local OpenAI-compatible adapter supports text and function tools only.",
        );
      }
    }
    const text = textFromParts(parts);
    const calls = parts.flatMap((part) => {
      const call = asObject(asObject(part)?.functionCall);
      if (!call || typeof call.name !== "string") {
        return [];
      }
      return [
        {
          id:
            typeof call.id === "string" && call.id
              ? call.id
              : `call_${crypto.randomUUID()}`,
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(asObject(call.args) ?? {}),
          },
        },
      ];
    });

    if (contentObject.role === "model") {
      messages.push({
        role: "assistant",
        content: text || null,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      });
    } else if (text) {
      messages.push({ role: "user", content: text });
    }

    for (const part of parts) {
      const response = asObject(asObject(part)?.functionResponse);
      if (!response || typeof response.name !== "string") {
        continue;
      }
      messages.push({
        role: "tool",
        tool_call_id:
          typeof response.id === "string" && response.id
            ? response.id
            : response.name,
        content: JSON.stringify(response.response ?? {}),
      });
    }
  }
  return messages;
}

function openAIGenerationConfig(request: LlmRequest): JsonObject {
  const config = asObject(request.config);
  if (!config) {
    return {};
  }
  return {
    ...(typeof config.temperature === "number"
      ? { temperature: config.temperature }
      : {}),
    ...(typeof config.maxOutputTokens === "number"
      ? { max_tokens: config.maxOutputTokens }
      : {}),
    ...(typeof config.topP === "number" ? { top_p: config.topP } : {}),
    ...(Array.isArray(config.stopSequences) &&
    config.stopSequences.every((value) => typeof value === "string")
      ? { stop: config.stopSequences }
      : {}),
    ...(typeof config.seed === "number" ? { seed: config.seed } : {}),
    ...(config.responseMimeType === "application/json"
      ? { response_format: { type: "json_object" } }
      : {}),
  };
}

function adkFinishReason(
  reason: string | null | undefined,
): FinishReason | undefined {
  switch (reason) {
    case "stop":
    case "tool_calls":
      return FinishReason.STOP;
    case "length":
      return FinishReason.MAX_TOKENS;
    case "content_filter":
      return FinishReason.SAFETY;
    default:
      return undefined;
  }
}

function parseArguments(call: OpenAIToolCall): JsonObject {
  try {
    return asObject(JSON.parse(call.function.arguments)) ?? {};
  } catch (error) {
    throw new Error(
      `Local model returned invalid JSON arguments for ${call.function.name}.`,
      { cause: error },
    );
  }
}

/** Minimal OpenAI chat-completions bridge for local ADK-JS examples. */
export class OpenAICompatibleLlm extends BaseLlm {
  private readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(config: OpenAICompatibleLlmConfig) {
    super({ model: config.model });
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
  }

  override async *generateContentAsync(
    request: LlmRequest,
    _stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void, void> {
    const tools = openAITools(request);
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      signal: abortSignal,
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: request.model ?? this.model,
        messages: openAIMessages(request),
        stream: false,
        ...openAIGenerationConfig(request),
        ...(tools ? { tools, tool_choice: "auto" } : {}),
      }),
    });
    const responseText = await response.text();
    let body: OpenAIChatCompletion;
    try {
      body = JSON.parse(responseText) as OpenAIChatCompletion;
    } catch (error) {
      const detail = responseText.trim().slice(0, 200);
      if (!response.ok) {
        throw new Error(
          `Local OpenAI-compatible endpoint returned HTTP ${response.status}${detail ? `: ${detail}` : "."}`,
          { cause: error },
        );
      }
      throw new Error(
        "Local OpenAI-compatible endpoint returned invalid JSON.",
        {
          cause: error,
        },
      );
    }
    if (!response.ok) {
      throw new Error(
        body.error?.message ??
          `Local OpenAI-compatible endpoint returned HTTP ${response.status}.`,
      );
    }

    const choice = body.choices?.[0];
    if (!choice?.message) {
      throw new Error("Local model returned no completion choice.");
    }
    const parts: JsonObject[] = [];
    if (choice.message.content) {
      parts.push({ text: choice.message.content });
    }
    for (const call of choice.message.tool_calls ?? []) {
      parts.push({
        functionCall: {
          id: call.id,
          name: call.function.name,
          args: parseArguments(call),
        },
      });
    }
    if (parts.length === 0) {
      throw new Error("Local model returned an empty completion choice.");
    }

    const finishReason = adkFinishReason(choice.finish_reason);

    yield {
      content: { role: "model", parts },
      turnComplete: true,
      modelVersion: body.model ?? this.model,
      ...(finishReason ? { finishReason } : {}),
      ...(body.usage
        ? {
            usageMetadata: {
              promptTokenCount: body.usage.prompt_tokens,
              candidatesTokenCount: body.usage.completion_tokens,
              totalTokenCount: body.usage.total_tokens,
            },
          }
        : {}),
    };
  }

  override async connect(): Promise<BaseLlmConnection> {
    throw new Error(
      "The local OpenAI-compatible adapter does not support ADK live sessions.",
    );
  }
}
