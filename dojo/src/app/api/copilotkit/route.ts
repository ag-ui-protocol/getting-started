import { CustomAgent } from "@/custom-agent";

import {
  CopilotRuntime,
  ExperimentalEmptyAdapter,
  copilotRuntimeNextJSAppRouterEndpoint,
} from "@copilotkit/runtime";

import { NextRequest } from "next/server";

const agenticChatAgent = new CustomAgent();
const agentiveGenerativeUIAgent = new CustomAgent();
const humanInTheLoopAgent = new CustomAgent();
const predictiveStateUpdatesAgent = new CustomAgent();
const sharedStateAgent = new CustomAgent();
const toolBasedGenerativeUIAgent = new CustomAgent();
const weatherAnimationsAgent = new CustomAgent();

const runtime = new CopilotRuntime({
  agents: {
    agenticChatAgent,
    agentiveGenerativeUIAgent,
    humanInTheLoopAgent,
    predictiveStateUpdatesAgent,
    sharedStateAgent,
    toolBasedGenerativeUIAgent,
    weatherAnimationsAgent,
  },
});

export const POST = async (req: NextRequest) => {
  const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
    runtime,
    serviceAdapter: new ExperimentalEmptyAdapter(),
    endpoint: "/api/copilotkit",
  });

  return handleRequest(req);
};
