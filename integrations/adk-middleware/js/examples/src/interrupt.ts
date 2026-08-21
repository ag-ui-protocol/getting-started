import { requestInputTool } from "@google/adk";

import { createDojoAgent } from "./factory";

export function createInterruptAgent() {
  return createDojoAgent({
    name: "adk_js_interrupt",
    instruction: `You schedule meetings with human input.
When the user asks to book or schedule a meeting and has not supplied an exact
time, call adk_request_input exactly once. Its message must clearly state the
meeting topic and attendee and ask the user to select a time. After the tool is
resumed, confirm the chosen_time and chosen_label. If the response says
cancelled, acknowledge cancellation.`,
    createTools: () => [requestInputTool],
  });
}
