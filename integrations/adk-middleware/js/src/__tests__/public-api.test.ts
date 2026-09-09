import { describe, expect, it } from "vitest";

import * as api from "../index";

describe("public API", () => {
  it("exports exactly the agent, the toolset, the coded error, and the state keys", () => {
    expect(Object.keys(api).sort()).toEqual([
      "ADKJSAgent",
      "ADKJSProtocolError",
      "AGUIClientTool",
      "AGUIClientToolset",
      "AG_UI_CONTEXT_KEY",
      "AG_UI_FORWARDED_PROPS_KEY",
      "AG_UI_MESSAGE_ID_METADATA_KEY",
      "AG_UI_STATE_KEY",
    ]);
    const error = new api.ADKJSProtocolError("busy", "THREAD_BUSY");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("THREAD_BUSY");
  });
});
