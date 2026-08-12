import { describe, it, expect } from "vitest";
import type { Message } from "@ag-ui/client";
import { convertMessagesToVercelAISDKMessages } from "../index";

describe("convertMessagesToVercelAISDKMessages — tool results", () => {
  it("sets isError false when the tool result has no error", () => {
    const messages: Message[] = [
      { id: "t1", role: "tool", content: "42", toolCallId: "tc1" },
    ];
    const result = convertMessagesToVercelAISDKMessages(messages);
    expect((result[0] as any).content[0]).toEqual({
      type: "tool-result",
      toolCallId: "tc1",
      toolName: "unknown",
      result: "42",
      isError: false,
    });
  });

  it("carries a tool error onto the AI SDK isError flag", () => {
    // A client-reported tool failure must reach the model as an error, not a
    // silent success. AG-UI's ToolMessage.error sets the tool-result isError flag.
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
    expect((result[0] as any).content[0].isError).toBe(true);
  });
});
