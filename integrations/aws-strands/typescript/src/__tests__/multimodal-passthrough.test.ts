/**
 * Multimodal `RunAgentInput.messages[*].content` must be passed to
 * `agent.stream()` as `ContentBlock[]`, not flattened to a text string.
 *
 * The v1.0 Strands SDK's `InvokeArgs` accepts both `string` and
 * `ContentBlock[]`, matching the Python adapter's behavior.
 */

import { describe, it, expect } from "vitest";
import { EventType, type InputContent } from "@ag-ui/core";
import {
  collect,
  minimalRunInput,
  scriptedAgent,
  strandsAgentOverStub,
} from "./helpers";

function b64(s: string): string {
  return Buffer.from(s).toString("base64");
}

/**
 * Build a stub Strands Agent whose `.stream()` records the arguments it
 * received, alongside whatever history was seeded onto `agent.messages`.
 * History reconciliation (replayHistoryIntoStrands) makes the adapter
 * call `stream(undefined)` and move the payload to `agent.messages`, so
 * tests need to inspect both to see what actually reached the LLM.
 */
function recordingAgent() {
  const calls: { args: unknown; messages: unknown[] }[] = [];
  const stub = scriptedAgent([], {
    messages: [] as never,
    stream: async function* (args: unknown) {
      calls.push({
        args,
        messages: [...(stub as unknown as { messages: unknown[] }).messages],
      });
    } as unknown as import("@strands-agents/sdk").Agent["stream"],
  });
  return { stub, calls };
}

describe("history replay of an attachment that cannot be converted", () => {
  it("does not seed a blank text block", async () => {
    const { stub, calls } = recordingAgent();
    const agent = strandsAgentOverStub(stub);

    const events = await collect(
      agent,
      minimalRunInput({
        threadId: "thread-1",
        messages: [
          {
            id: "u1",
            role: "user",
            // No text alongside it, and the type is one the converter
            // cannot deliver, so the conversion yields nothing.
            content: [
              {
                type: "image",
                source: {
                  type: "data",
                  value: b64("BMP"),
                  mimeType: "image/bmp",
                },
              },
            ],
          } as never,
          { id: "a1", role: "assistant", content: "seen" } as never,
          { id: "u2", role: "user", content: "and now?" } as never,
        ],
      }),
    );

    expect(events.map((e) => e.type)).toContain(EventType.RUN_FINISHED);
    // Without this the assertion below passes vacuously: a run that never
    // reached the model contributes no entries to check.
    expect(calls).toHaveLength(1);
    const seeded = calls[0]!.messages;
    const texts = seeded.flatMap((m) =>
      ((m as { content?: unknown[] }).content ?? []).map(
        (c) => (c as { text?: unknown }).text,
      ),
    );
    // The provider rejects a blank text block and a message with no content
    // at all, so seeding either turns a single dead attachment into a thread
    // that fails on every later run.
    expect(texts).not.toContain("");
    for (const m of seeded as { content?: unknown[] }[]) {
      expect((m.content ?? []).length).toBeGreaterThan(0);
    }
    // And it must still occupy its place. Dropping the turn instead leaves an
    // assistant-first or consecutive-assistant history, which the provider
    // rejects just as surely, so per-message shape alone is not enough.
    const roles = (seeded as { role: string }[]).map((m) => m.role);
    expect(roles[0]).toBe("user");
    for (let i = 1; i < roles.length; i++) {
      expect(roles[i]).not.toBe(roles[i - 1]);
    }
  });
});

describe("replayed turns the provider would refuse", () => {
  it("never seeds a blank text block for an empty assistant turn", async () => {
    const { stub, calls } = recordingAgent();
    const agent = strandsAgentOverStub(stub);

    await collect(
      agent,
      minimalRunInput({
        threadId: "thread-1",
        messages: [
          { id: "u1", role: "user", content: "hello" } as never,
          // Neither text nor tool calls: the replay builder used to seed this
          // as an empty text block, which the provider rejects on its own
          // account just as it rejects an empty user turn.
          { id: "a1", role: "assistant", content: "" } as never,
          { id: "u2", role: "user", content: "again" } as never,
        ],
      }),
    );

    expect(calls).toHaveLength(1);
    const texts = (
      calls[0]!.messages as { content: { text?: string }[] }[]
    ).flatMap((m) => m.content.map((c) => c.text));
    expect(texts).not.toContain("");
  });
});

describe("multimodal pass-through", () => {
  it("passes ContentBlock[] to agent.stream when the message contains an image", async () => {
    const { stub, calls } = recordingAgent();
    const agent = strandsAgentOverStub(stub);
    const content: InputContent[] = [
      { type: "text", text: "what is in this image?" },
      {
        type: "image",
        source: {
          type: "data",
          value: b64("fake-png-bytes"),
          mimeType: "image/png",
        },
      },
    ];
    await collect(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content }],
      }),
    );
    expect(calls).toHaveLength(1);
    // Replay routes multimodal content into agent.messages and calls
    // stream(undefined); the `user` turn's content carries a TextBlock +
    // ImageBlock pair (as Strands class instances after Message.fromMessageData).
    expect(calls[0]!.args).toBeUndefined();
    const replayed = calls[0]!.messages as Array<{
      role: string;
      content: Array<{ type: string }>;
    }>;
    expect(replayed).toHaveLength(1);
    expect(replayed[0]!.role).toBe("user");
    expect(replayed[0]!.content).toHaveLength(2);
    expect(replayed[0]!.content[0]!.type).toBe("textBlock");
    expect(replayed[0]!.content[1]!.type).toBe("imageBlock");
  });

  it("errors when every media block fails and there is no text to fall back to", async () => {
    const { stub, calls } = recordingAgent();
    const agent = strandsAgentOverStub(stub);
    const content: InputContent[] = [
      {
        type: "image",
        source: {
          type: "data",
          value: b64("anything"),
          // image/bmp is not in the allowlist — conversion will skip it.
          mimeType: "image/bmp",
        },
      },
    ];
    const events = await collect(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content }],
      }),
    );
    // No text fallback available — emits MEDIA_RESOLUTION_FAILED error
    // and does not invoke the agent.
    expect(calls).toHaveLength(0);
    const error = events.find((e) => e.type === EventType.RUN_ERROR) as
      | { code: string; message: string }
      | undefined;
    expect(error).toBeTruthy();
    expect(error!.code).toBe("MEDIA_RESOLUTION_FAILED");
  });

  it("falls back to the text alongside a media block that fails conversion", async () => {
    const { stub, calls } = recordingAgent();
    const agent = strandsAgentOverStub(stub);
    const events = await collect(
      agent,
      minimalRunInput({
        messages: [
          {
            id: "u1",
            role: "user",
            content: [
              { type: "text", text: "what is in this?" },
              {
                type: "image",
                source: {
                  type: "data",
                  value: b64("anything"),
                  mimeType: "image/bmp",
                },
              },
            ] as InputContent[],
          },
        ],
      }),
    );

    // The branch the test above is named after: some text survives, so the
    // run proceeds with it rather than refusing.
    expect(events.map((e) => e.type)).toContain(EventType.RUN_FINISHED);
    expect(calls).toHaveLength(1);
    const replayed = (calls[0]!.messages ?? []) as {
      content: { text?: string }[];
    }[];
    const texts = replayed.flatMap((m) => m.content.map((c) => c.text));
    expect(texts).toContain("what is in this?");
  });

  it("preserves ContentBlock[] even when stateContextBuilder is configured", async () => {
    const { stub, calls } = recordingAgent();
    const agent = strandsAgentOverStub(stub);
    // Install a stateContextBuilder that would wrap text prompts. It MUST NOT
    // be applied to multimodal prompts — the image content would be lost.
    (agent as unknown as { config: Record<string, unknown> }).config = {
      stateContextBuilder: (_input: unknown, prompt: string) =>
        `[STATE: wrapped] ${prompt}`,
    };
    const content: InputContent[] = [
      { type: "text", text: "describe the picture" },
      {
        type: "image",
        source: {
          type: "data",
          value: b64("fake-jpeg"),
          mimeType: "image/jpeg",
        },
      },
    ];
    await collect(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content }],
      }),
    );
    // The builder runs on the replay path's last user-text turn, not on
    // a synthetic prompt — so the multimodal content persists as a proper
    // ContentBlock[] on agent.messages[0].content alongside any wrapped
    // text block. Assert the image survives the builder.
    expect(calls[0]!.args).toBeUndefined();
    const replayed = calls[0]!.messages as Array<{
      role: string;
      content: Array<{ type: string }>;
    }>;
    expect(replayed[0]!.content.some((b) => b.type === "imageBlock")).toBe(
      true,
    );
  });

  it("applies stateContextBuilder to plain-text prompts as before", async () => {
    const { stub, calls } = recordingAgent();
    const agent = strandsAgentOverStub(stub);
    (agent as unknown as { config: Record<string, unknown> }).config = {
      stateContextBuilder: (_input: unknown, prompt: string) =>
        `${prompt} [STATE: ok]`,
    };
    await collect(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content: "plain text prompt" }],
      }),
    );
    // Replay routes the prompt into agent.messages[*].content[*].text, with
    // the builder's augmentation applied. The adapter calls stream(undefined).
    expect(calls[0]!.args).toBeUndefined();
    const replayed = calls[0]!.messages as Array<{
      role: string;
      content: Array<{ text?: string }>;
    }>;
    expect(replayed[0]!.content[0]!.text).toBe("plain text prompt [STATE: ok]");
  });
});
