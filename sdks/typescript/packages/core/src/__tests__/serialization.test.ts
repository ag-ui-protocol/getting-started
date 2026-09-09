import { omitOptionalNulls } from "../generated/serialization";

describe("protocol optional-null serialization", () => {
  it("preserves arbitrary JSON even when it looks like a protocol object", () => {
    const payload = { type: "RUN_FINISHED", result: null, metadata: null, nested: [null] };
    const input = {
      threadId: "t",
      runId: "r",
      messages: [],
      state: payload,
      forwardedProps: payload,
      tools: [{ name: "x", description: "x", parameters: payload, metadata: { x: null } }],
    };
    expect(omitOptionalNulls(input, "RunAgentInput")).toBe(input);
  });

  it("copies only changed protocol objects, preserving required null and unknown fields", () => {
    const content = [
      { type: "text", text: "hello" },
      {
        type: "image",
        mimeType: "image/png",
        metadata: null,
        source: { type: "url", url: "https://example.com/a.png" },
      },
    ];
    const event = {
      type: "MESSAGES_SNAPSHOT",
      timestamp: null,
      rawEvent: null,
      messages: [{ role: "user", id: "m", content, metadata: { retained: null } }],
      extension: null,
    };
    const result = omitOptionalNulls(event, "Event");
    expect(result).toEqual({
      type: "MESSAGES_SNAPSHOT",
      messages: [
        {
          role: "user",
          id: "m",
          content: [
            content[0],
            {
              type: "image",
              mimeType: "image/png",
              source: content[1].source,
            },
          ],
          metadata: { retained: null },
        },
      ],
      extension: null,
    });
    expect(result.messages[0].content[0]).toBe(content[0]);
    expect(event.messages[0].content[1].metadata).toBeNull();
    expect(omitOptionalNulls({ type: "CUSTOM", name: "x", value: null }, "Event")).toEqual({
      type: "CUSTOM",
      name: "x",
      value: null,
    });
  });

  it("leaves unknown variants and their payloads untouched", () => {
    for (const type of ["FUTURE_EVENT", "constructor", "__proto__"]) {
      const event = { type, optional: null, metadata: null };
      expect(omitOptionalNulls(event, "Event")).toBe(event);
    }
  });
});
