import { describe, it, expect } from "vitest";
import type { Message } from "@ag-ui/client";
import { convertMessagesToVercelAISDKMessages } from "../index";

describe("convertMessagesToVercelAISDKMessages — tool results", () => {
  it("sends a successful tool result as a plain text output", () => {
    const messages: Message[] = [
      { id: "t1", role: "tool", content: "42", toolCallId: "tc1" },
    ];
    const result = convertMessagesToVercelAISDKMessages(messages);
    expect((result[0] as any).content[0]).toEqual({
      type: "tool-result",
      toolCallId: "tc1",
      toolName: "unknown",
      output: { type: "text", value: "42" },
    });
  });

  it("carries a tool error onto the AI SDK error output type", () => {
    // A client-reported tool failure must reach the model as an error, not a
    // silent success. AG-UI's ToolMessage.error maps to the v7 `error-text`
    // output, which providers translate to their own error flag (the v4
    // `isError` boolean this replaces).
    const messages: Message[] = [
      {
        id: "t1",
        role: "tool",
        content: "Tool failed: invalid id",
        toolCallId: "tc1",
        error: "invalid id",
      },
    ];
    const result = convertMessagesToVercelAISDKMessages(messages);
    expect((result[0] as any).content[0].output).toEqual({
      type: "error-text",
      value: "Tool failed: invalid id",
    });
  });
});
