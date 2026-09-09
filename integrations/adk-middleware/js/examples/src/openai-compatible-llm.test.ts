import type { LlmRequest } from "@google/adk";
import { FinishReason } from "@google/genai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenAICompatibleLlm } from "./openai-compatible-llm";

function request(overrides: Record<string, unknown> = {}): LlmRequest {
  return {
    model: "local-model",
    contents: [{ role: "user", parts: [{ text: "Hello" }] }],
    config: {},
    ...overrides,
  } as unknown as LlmRequest;
}

async function generate(llm: OpenAICompatibleLlm, input: LlmRequest) {
  const iterator = llm.generateContentAsync(input);
  const first = await iterator.next();
  return first.value;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAICompatibleLlm", () => {
  it("maps generation config, finish reason, model, and usage", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "served-model",
          choices: [
            { finish_reason: "length", message: { content: "Answer" } },
          ],
          usage: {
            prompt_tokens: 2,
            completion_tokens: 3,
            total_tokens: 5,
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const llm = new OpenAICompatibleLlm({
      model: "local-model",
      baseUrl: "http://127.0.0.1:8080/v1/",
    });

    const result = await generate(
      llm,
      request({
        config: {
          temperature: 0.2,
          maxOutputTokens: 64,
          topP: 0.8,
          stopSequences: ["STOP"],
          seed: 7,
          responseMimeType: "application/json",
        },
      }),
    );

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "local-model",
      temperature: 0.2,
      max_tokens: 64,
      top_p: 0.8,
      stop: ["STOP"],
      seed: 7,
      response_format: { type: "json_object" },
      stream: false,
    });
    expect(result).toMatchObject({
      content: { role: "model", parts: [{ text: "Answer" }] },
      finishReason: FinishReason.MAX_TOKENS,
      modelVersion: "served-model",
      usageMetadata: {
        promptTokenCount: 2,
        candidatesTokenCount: 3,
        totalTokenCount: 5,
      },
    });
  });

  it("reports a useful HTTP error when the endpoint returns non-JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("upstream unavailable", {
          status: 503,
          statusText: "Service Unavailable",
        }),
      ),
    );
    const llm = new OpenAICompatibleLlm({
      model: "local-model",
      baseUrl: "http://127.0.0.1:8080/v1",
    });

    await expect(generate(llm, request())).rejects.toThrow(
      "HTTP 503: upstream unavailable",
    );
  });

  it("rejects media instead of silently dropping it", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const llm = new OpenAICompatibleLlm({
      model: "local-model",
      baseUrl: "http://127.0.0.1:8080/v1",
    });

    await expect(
      generate(
        llm,
        request({
          contents: [
            {
              role: "user",
              parts: [
                { inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } },
              ],
            },
          ],
        }),
      ),
    ).rejects.toThrow("supports text and function tools only");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
