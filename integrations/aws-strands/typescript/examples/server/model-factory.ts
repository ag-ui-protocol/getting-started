/**
 * Shared model factory for Strands TypeScript examples.
 *
 * Mirrors `python/examples/server/model_factory.py` field-for-field: same
 * `MODEL_PROVIDER` env-var shape, same defaults, same model IDs. The CI dojo
 * runner injects `OPENAI_BASE_URL=http://localhost:5555/v1` + a mock API key,
 * so the default `openai` provider routes to the aimock server automatically.
 *
 * Reasoning summaries are opt-in via `{ reasoning: true }`. Mirrors the
 * mastra/langgraph TS dojos, where only the `agentic-chat-reasoning` demo
 * configures a reasoning model. Leaving reasoning on by default produces
 * `reasoningBlock` content in assistant turns that the OpenAI Responses API
 * cannot replay across multi-turn conversations, which breaks any demo that
 * triggers a tool-use loop (e.g. `tool-based-generative-ui`).
 *
 * Supported providers: `openai` (default), `anthropic`, `gemini`, `bedrock`.
 */

import type { Model } from "@strands-agents/sdk";

export interface CreateModelOptions {
  /**
   * Request reasoning/thinking content from the provider. Defaults to `false`.
   * Only enable for demos that explicitly render reasoning in the UI — the
   * Responses API drops reasoning blocks across multi-turn conversations.
   */
  reasoning?: boolean;
  /**
   * OpenAI API mode. Defaults to the SDK default (Responses). Pass `"chat"`
   * for demos that need tool-call ARGUMENTS to stream incrementally — the
   * Strands Responses adapter buffers `function_call_arguments.delta` and only
   * emits the complete toolUse at `…arguments.done`, so e.g. A2UI progressive
   * surface painting never streams on the Responses API.
   */
  openaiApi?: "chat" | "responses";
}

export async function createModel(
  options: CreateModelOptions = {},
): Promise<Model> {
  const provider = (process.env.MODEL_PROVIDER ?? "openai").toLowerCase();
  const reasoning = options.reasoning ?? false;

  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY environment variable is required when MODEL_PROVIDER=openai. " +
          "Set it in your .env file or environment.",
      );
    }
    const { OpenAIModel } = await import("@strands-agents/sdk/models/openai");
    // OPENAI_BASE_URL routes through aimock during e2e tests. The default
    // Responses API surfaces fixture `reasoning` content for the
    // `/agentic-chat-reasoning` demo.
    const baseURL = process.env.OPENAI_BASE_URL;
    return new OpenAIModel({
      apiKey,
      modelId: process.env.MODEL_ID ?? "gpt-5.4",
      ...(options.openaiApi ? { api: options.openaiApi } : {}),
      ...(reasoning
        ? { params: { reasoning: { effort: "medium", summary: "auto" } } }
        : {}),
      ...(baseURL ? { clientConfig: { baseURL } } : {}),
    });
  }

  if (provider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY environment variable is required when MODEL_PROVIDER=anthropic. " +
          "Set it in your .env file or environment.",
      );
    }
    const { AnthropicModel } = await import(
      "@strands-agents/sdk/models/anthropic"
    );
    return new AnthropicModel({
      apiKey,
      modelId: process.env.MODEL_ID ?? "claude-sonnet-4-6",
      // Anthropic emits no thinking blocks unless extended thinking is
      // requested, so without this the reasoning demo silently degrades to a
      // plain answer on MODEL_PROVIDER=anthropic.
      ...(reasoning
        ? {
            params: { thinking: { type: "enabled", budget_tokens: 2000 } },
          }
        : {}),
    });
  }

  if (provider === "gemini") {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error(
        "GOOGLE_API_KEY environment variable is required when MODEL_PROVIDER=gemini. " +
          "Set it in your .env file or environment.",
      );
    }
    const { GoogleModel } = await import("@strands-agents/sdk/models/google");
    return new GoogleModel({
      apiKey,
      modelId: process.env.MODEL_ID ?? "gemini-2.5-flash",
    });
  }

  if (provider === "bedrock") {
    const { BedrockModel } = await import("@strands-agents/sdk");
    // Anthropic-on-Bedrock surfaces reasoning via the
    // `additionalModelRequestFields.thinking` block. `temperature` must be 1
    // when thinking is enabled.
    // https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-anthropic-claude-messages-extended-thinking.html
    return new BedrockModel({
      modelId: process.env.MODEL_ID ?? "global.anthropic.claude-sonnet-4-6",
      ...(reasoning
        ? {
            temperature: 1,
            additionalRequestFields: {
              thinking: { type: "enabled", budget_tokens: 2000 },
            },
          }
        : {}),
    });
  }

  throw new Error(
    `Unknown MODEL_PROVIDER: ${provider}. Supported: openai, anthropic, gemini, bedrock`,
  );
}
