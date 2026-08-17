import { describe, it, expect } from "vitest";
import type { Message } from "@ag-ui/client";
import { convertAGUIMessageToLangChain } from "../messages";

describe("convertAGUIMessageToLangChain — tool messages", () => {
  it("maps a tool result with no error to status 'success'", () => {
    const msg: Message = { id: "t1", role: "tool", content: "42", toolCallId: "tc1" };
    const result = convertAGUIMessageToLangChain(msg) as any;
    expect(result.tool_call_id).toBe("tc1");
    // No error carries no failure signal, so status defaults to "success".
    expect(result.status).toBe("success");
  });

  it("maps a tool error onto LangChain's status flag", () => {
    // A client-reported tool failure must reach the model as an error, not a
    // silent success — AG-UI's ToolMessage.error becomes status: "error".
    const msg: Message = {
      id: "t1",
      role: "tool",
      content: "Tool failed: invalid id",
      toolCallId: "tc1",
      error: "invalid id",
    };
    const result = convertAGUIMessageToLangChain(msg) as any;
    expect(result.status).toBe("error");
  });
});
