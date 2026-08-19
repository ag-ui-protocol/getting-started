import {
  CopilotRuntime,
  InMemoryAgentRunner,
  createCopilotEndpoint,
} from "@copilotkit/runtime/v2";
import { handle } from "hono/vercel";

type RuntimeAgents = NonNullable<
  ConstructorParameters<typeof CopilotRuntime>[0]["agents"]
>;

const runtime = new CopilotRuntime({
  agents: {
    // The dojo resolves agents per request, so there is no static default.
    default: null as unknown as RuntimeAgents[keyof RuntimeAgents],
  },
  runner: new InMemoryAgentRunner(),
});

const app = createCopilotEndpoint({
  runtime,
  basePath: "/api/copilotkit",
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handler = (handle as any)(app);
export const GET = handler;
export const POST = handler;

