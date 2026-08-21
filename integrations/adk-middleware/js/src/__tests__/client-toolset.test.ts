import { describe, expect, it } from "vitest";

import { AGUIClientToolset } from "../index";

describe("AGUIClientToolset", () => {
  it("keeps arbitrary JSON Schema and scopes bindings by user and session", async () => {
    const toolset = new AGUIClientToolset();
    const schema = {
      type: "object",
      $defs: { value: { anyOf: [{ type: "string" }, { type: "number" }] } },
      properties: { value: { $ref: "#/$defs/value" } },
    };
    toolset.bindTools("user-a", "thread-a", [
      {
        name: "client_action",
        description: "Runs in the UI",
        parameters: schema,
      },
    ]);

    const tools = await toolset.getTools({
      userId: "user-a",
      sessionId: "thread-a",
    } as never);
    expect(tools).toHaveLength(1);
    expect(tools[0].isLongRunning).toBe(true);
    expect(tools[0]._getDeclaration()).toMatchObject({
      name: "client_action",
      parametersJsonSchema: schema,
    });
    expect(
      await tools[0].runAsync({ args: { value: 1 }, toolContext: {} as never }),
    ).toBeUndefined();

    await toolset.close();
    expect(
      await toolset.getTools({
        userId: "user-a",
        sessionId: "thread-a",
      } as never),
    ).toHaveLength(1);
    expect(
      await toolset.getTools({
        userId: "user-b",
        sessionId: "thread-a",
      } as never),
    ).toHaveLength(0);
    toolset.unbindTools("user-a", "thread-a");
    expect(
      await toolset.getTools({
        userId: "user-a",
        sessionId: "thread-a",
      } as never),
    ).toHaveLength(0);
  });
});
