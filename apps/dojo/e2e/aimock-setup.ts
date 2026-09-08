import { LLMock, type ChatMessage } from "@copilotkit/aimock";
import * as path from "node:path";
import { registerA2UIRecoveryFixtures } from "./a2ui-recovery-fixtures";
import { registerA2UIADKFixtures } from "./a2ui-adk-fixtures";
import {
  crewAIA2UIAnswersToolResultTurn,
  registerA2UICrewAIFixtures,
} from "./a2ui-crewai-fixtures";
import { registerInterruptCrewAIFixtures } from "./interrupt-crewai-fixtures";
import { registerMultiAgentStrandsFixtures } from "./multi-agent-strands-fixtures";
import {
  registerStrandsFixtures,
  strandsAnswersToolResultTurn,
} from "./strands-fixtures";
import {
  deepagentsSubagentsAnswersToolResultTurn,
  registerDeepagentsSubagentsFixtures,
} from "./deepagents-subagents-fixtures";

// Configurable so parallel worktrees / runs don't collide on one aimock port.
const MOCK_PORT = Number(process.env.AIMOCK_PORT) || 5555;
const FIXTURES_DIR = path.join(import.meta.dirname, "fixtures", "openai");

let mockServer: LLMock | null = null;

export async function setupLLMock(): Promise<void> {
  console.log("🔧 Starting aimock server...");

  // Small per-chunk latency prevents crew-ai's asyncio event loop from
  // getting congested by zero-latency streaming (real OpenAI has natural
  // network delays between chunks; LLMock needs to simulate this).
  // Default 5ms keeps crew-ai's asyncio loop healthy. Bump via AIMOCK_LATENCY (e.g. 1500)
  // when running the standalone mock (aimock-standalone.ts) for an interactive recording,
  // so the retrying→hard-failure sequence is watchable.
  mockServer = new LLMock({
    port: MOCK_PORT,
    latency: Number(process.env.AIMOCK_LATENCY) || 5,
  });

  // OSS-158 ADK A2UI fixtures (Gemini-shaped, scoped to gemini models). MUST
  // precede the OpenAI LangGraph recovery fixtures so a Gemini request matches
  // here first; gpt-4o requests fall through to the LangGraph fixtures.
  registerA2UIADKFixtures(mockServer);

  // OSS-162 A2UI recovery showcase fixtures (predicate fixtures, must precede
  // the generic loadFixtureFile below).
  registerA2UIRecoveryFixtures(mockServer);

  // CrewAI A2UI fixtures (openai/gpt-5.4, scoped to CrewAI-unique prompts so
  // they never intercept the LangGraph/ADK demos). Predicate fixtures, before
  // the generic loader.
  registerA2UICrewAIFixtures(mockServer);

  // CrewAI interrupt (suspend/resume) fixtures: the extract call before the
  // pause and the confirm call after the resume. Scoped to this flow's own
  // system prompts, before the generic loader.
  registerInterruptCrewAIFixtures(mockServer);

  // AWS Strands multi-agent graph: one fixture per node, each scoped to that
  // node's own system prompt. Predicate fixtures, before the generic loader.
  registerMultiAgentStrandsFixtures(mockServer);
  registerDeepagentsSubagentsFixtures(mockServer);

  // AWS Strands interrupt + predictive-state fixtures. Scoped to those demos'
  // own system prompts, before the generic loader.
  registerStrandsFixtures(mockServer);

  // Extract text from message content — handles both string and array-of-parts
  // (Strands SDK sends content as [{type: "text", text: "..."}])
  const textOf = (content: ChatMessage["content"] | undefined): string => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text!)
        .join("");
    }
    return "";
  };

  // LangGraph HITL: the LangGraph agent registers tool `plan_execution_steps`,
  // not `generate_task_steps`. The JSON fixture returns `generate_task_steps`
  // which CopilotKit's useHumanInTheLoop() handles (wrong UI: Confirm/Reject).
  // LangGraph needs the correct tool name so chatNode routes to processStepsNode,
  // which calls interrupt() and triggers useLangGraphInterrupt() (correct UI:
  // Perform Steps). These predicate fixtures MUST come before loadFixtureFile.
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const hasLangGraphTool = req.tools?.some(
          (t) => t.function.name === "plan_execution_steps",
        );
        return (
          !!hasLangGraphTool &&
          textOf(lastUser?.content).includes("one step with eggs")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: "plan_execution_steps",
          arguments: JSON.stringify({
            steps: [
              { description: "Crack eggs into bowl", status: "enabled" },
              { description: "Preheat oven to 350F", status: "enabled" },
              { description: "Mix and bake for 25 min", status: "enabled" },
            ],
          }),
        },
      ],
    },
  });
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const hasLangGraphTool = req.tools?.some(
          (t) => t.function.name === "plan_execution_steps",
        );
        return (
          !!hasLangGraphTool &&
          textOf(lastUser?.content).includes("Start The Planning")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: "plan_execution_steps",
          arguments: JSON.stringify({
            steps: [
              { description: "Start The Planning", status: "enabled" },
              { description: "Design spacecraft", status: "enabled" },
              { description: "Launch mission", status: "enabled" },
            ],
          }),
        },
      ],
    },
  });

  // Claude Agent SDK HITL: same pattern as LangGraph above. The CLI registers
  // tools as mcp__ag_ui__generate_task_steps. The JSON fixture returns bare
  // generate_task_steps which the TS CLI resolves, but the Python CLI needs the
  // exact MCP-prefixed name. These predicate fixtures fire before the JSON ones.
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const hasClaudeSdkTool = req.tools?.some((t) =>
          t.function.name.endsWith("__generate_task_steps"),
        );
        return (
          !!hasClaudeSdkTool &&
          textOf(lastUser?.content).includes("one step with eggs")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: "mcp__ag_ui__generate_task_steps",
          arguments: JSON.stringify({
            steps: [
              { description: "Crack eggs into bowl", status: "enabled" },
              { description: "Preheat oven to 350F", status: "enabled" },
              { description: "Mix and bake for 25 min", status: "enabled" },
            ],
          }),
        },
      ],
    },
  });
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const hasClaudeSdkTool = req.tools?.some((t) =>
          t.function.name.endsWith("__generate_task_steps"),
        );
        return (
          !!hasClaudeSdkTool &&
          textOf(lastUser?.content).includes("Start The Planning")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: "mcp__ag_ui__generate_task_steps",
          arguments: JSON.stringify({
            steps: [
              { description: "Start The Planning", status: "enabled" },
              { description: "Design spacecraft", status: "enabled" },
              { description: "Launch mission", status: "enabled" },
            ],
          }),
        },
      ],
    },
  });

  // Mastra interrupt demo (mastra-agent-local `interrupt` feature). The agent
  // exposes the suspend-backed `schedule_meeting` tool (unique to this agent),
  // so matching on that tool name targets it precisely. Two turns:
  //   1) no tool result yet -> emit the schedule_meeting tool call. Mastra runs
  //      the tool, which calls suspend(); the bridge emits on_interrupt and the
  //      picker renders.
  //   2) after the user picks a slot, the tool resumes and returns its result
  //      (a tool-role message is now present) -> emit the final confirmation.
  const hasScheduleMeetingTool = (req: {
    tools?: { function: { name: string } }[];
  }) => req.tools?.some((t) => t.function.name === "schedule_meeting") ?? false;
  const hasToolResult = (req: { messages: ChatMessage[] }) =>
    req.messages.some((m) => m.role === "tool");

  mockServer.addFixture({
    match: {
      predicate: (req) => hasScheduleMeetingTool(req) && !hasToolResult(req),
    },
    response: {
      toolCalls: [
        {
          name: "schedule_meeting",
          arguments: JSON.stringify({
            topic: "Intro call with the sales team",
            attendee: "the sales team",
          }),
        },
      ],
    },
  });

  mockServer.addFixture({
    match: {
      predicate: (req) => hasScheduleMeetingTool(req) && hasToolResult(req),
    },
    response: {
      content:
        "Your meeting is scheduled. Let me know if you need anything else!",
    },
  });

  // Load HITL fixtures — they share a "plan to make brownies" substring
  // with agentic-gen-ui fixtures, and first-match-wins. By loading HITL first,
  // "one step with eggs" matches HITL tests before "plan to make brownies"
  // matches the agenticGenUI fixture (which returns the wrong tool name).
  // NOTE: LangGraph and Claude SDK predicate fixtures above take priority
  // over these for requests containing their specific tool names.
  mockServer.loadFixtureFile(path.join(FIXTURES_DIR, "human-in-the-loop.json"));

  // OSS-93 Background Agents: the agent dispatches `run_deep_research` as a
  // Mastra background task. Scoped by that tool name so it never hijacks other
  // demos. Two turns: (1) on the first request (no tool result yet) emit the
  // tool call so the background task starts; (2) once the placeholder tool
  // result is in history, emit a short acknowledgement (the loop re-enters
  // after the immediate ack). The tool execution + background-task lifecycle
  // are real (only the LLM is mocked), so the activity card renders.
  const hasBackgroundResearchTool = (req: {
    tools?: { function: { name: string } }[];
  }) => !!req.tools?.some((t) => t.function.name === "run_deep_research");
  mockServer.addFixture({
    match: {
      predicate: (req) =>
        hasBackgroundResearchTool(req) &&
        !req.messages.some((m) => m.role === "tool"),
    },
    response: {
      toolCalls: [
        {
          name: "run_deep_research",
          arguments: JSON.stringify({ topic: "Solana ecosystem" }),
        },
      ],
    },
  });
  mockServer.addFixture({
    match: {
      predicate: (req) =>
        hasBackgroundResearchTool(req) &&
        req.messages.some((m) => m.role === "tool"),
    },
    response: {
      text: "I've kicked off the research on the Solana ecosystem in the background. You'll get the findings shortly.",
    },
  });

  const sysContent = (msgs: ChatMessage[]) =>
    msgs.find((m) => m.role === "system")?.content ?? "";
  // Case-insensitive check for system prompt content — Python booleans are
  // True/False (capitalized) while JavaScript uses true/false (lowercase).
  const sysIncludes = (msgs: ChatMessage[], substr: string) => {
    const sys =
      typeof sysContent(msgs) === "string" ? (sysContent(msgs) as string) : "";
    return sys.toLowerCase().includes(substr.toLowerCase());
  };
  const supervisorRoute = (nextAgent: string, answer: string) => ({
    response: {
      toolCalls: [
        {
          name: "supervisor_response",
          arguments: JSON.stringify({ answer, next_agent: nextAgent }),
        },
      ],
    },
  });

  // Supervisor: no flights yet → route to flights_agent
  mockServer.addFixture({
    match: {
      predicate: (req) => sysIncludes(req.messages, "Flights found: false"),
    },
    ...supervisorRoute("flights_agent", "Let me find flights for you!"),
  });
  // Supervisor: flights found, no hotels → route to hotels_agent
  mockServer.addFixture({
    match: {
      predicate: (req) =>
        sysIncludes(req.messages, "Flights found: true") &&
        sysIncludes(req.messages, "Hotels found: false"),
    },
    ...supervisorRoute(
      "hotels_agent",
      "Great choice! Now let me find hotels for you.",
    ),
  });
  // Supervisor: flights + hotels done, experiences not yet → route to experiences_agent
  // NOTE: state.experiences has no default (undefined), so hasExperiences is always "true"
  // in the system prompt. We distinguish by checking if the experiences agent's
  // response text is already in the messages.
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const experiencesDone = req.messages.some(
          (m) =>
            m.role === "assistant" &&
            textOf(m.content).includes("wonderful experiences"),
        );
        return (
          sysIncludes(req.messages, "Hotels found: true") && !experiencesDone
        );
      },
    },
    ...supervisorRoute(
      "experiences_agent",
      "Excellent! Now let me find some experiences for you.",
    ),
  });
  // Supervisor: all agents completed → route to complete
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const experiencesDone = req.messages.some(
          (m) =>
            m.role === "assistant" &&
            textOf(m.content).includes("wonderful experiences"),
        );
        return (
          sysIncludes(req.messages, "Hotels found: true") && experiencesDone
        );
      },
    },
    ...supervisorRoute("complete", "Your travel plan is all set!"),
  });
  // Experiences agent's own ChatOpenAI call — returns generic text
  mockServer.addFixture({
    match: {
      predicate: (req) =>
        sysIncludes(req.messages, "You are the experiences agent"),
    },
    response: {
      content:
        "I've found some wonderful experiences for your trip to San Francisco!",
    },
  });

  // Strands agentic gen UI: the Strands agent registers plan_task_steps,
  // not generate_task_steps_generative_ui. Predicate fixtures detect the
  // Strands tool name in the request and return the correct tool call.
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const hasStrandsTool = req.tools?.some(
          (t) => t.function.name === "plan_task_steps",
        );
        return (
          !!hasStrandsTool &&
          textOf(lastUser?.content).includes("plan to make brownies")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: "plan_task_steps",
          arguments: JSON.stringify({
            task: "make brownies",
            context: "",
            steps: [
              { description: "Gather ingredients", status: "pending" },
              {
                description: "Melt butter and mix with cocoa",
                status: "pending",
              },
              { description: "Add eggs and flour", status: "pending" },
              { description: "Bake at 350F for 25 min", status: "pending" },
            ],
          }),
        },
      ],
    },
  });
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const hasStrandsTool = req.tools?.some(
          (t) => t.function.name === "plan_task_steps",
        );
        return (
          !!hasStrandsTool && textOf(lastUser?.content).includes("Go to Mars")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: "plan_task_steps",
          arguments: JSON.stringify({
            task: "Go to Mars",
            context: "",
            steps: [
              { description: "Design spacecraft", status: "pending" },
              { description: "Assemble crew", status: "pending" },
              { description: "Launch from Earth", status: "pending" },
              { description: "Land on Mars", status: "pending" },
            ],
          }),
        },
      ],
    },
  });

  // CrewAI agentic gen UI: the CrewAI flow registers `generate_task_steps`
  // (not `generate_task_steps_generative_ui` like other frameworks). The JSON
  // fixture returns the wrong name for CrewAI. These predicate fixtures detect
  // the CrewAI-specific tool name and return the correct one.
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const hasCrewAITool = req.tools?.some(
          (t) => t.function.name === "generate_task_steps",
        );
        const noStrandsTool = !req.tools?.some(
          (t) => t.function.name === "plan_task_steps",
        );
        return (
          !!hasCrewAITool &&
          noStrandsTool &&
          textOf(lastUser?.content).includes("plan to make brownies")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: "generate_task_steps",
          arguments: JSON.stringify({
            steps: [
              { description: "Gather ingredients", status: "pending" },
              {
                description: "Melt butter and mix with cocoa",
                status: "pending",
              },
              { description: "Add eggs and flour", status: "pending" },
              { description: "Bake at 350F for 25 min", status: "pending" },
            ],
          }),
        },
      ],
    },
  });
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const hasCrewAITool = req.tools?.some(
          (t) => t.function.name === "generate_task_steps",
        );
        const noStrandsTool = !req.tools?.some(
          (t) => t.function.name === "plan_task_steps",
        );
        return (
          !!hasCrewAITool &&
          noStrandsTool &&
          textOf(lastUser?.content).includes("Go to Mars")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: "generate_task_steps",
          arguments: JSON.stringify({
            steps: [
              { description: "Design spacecraft", status: "pending" },
              { description: "Assemble crew", status: "pending" },
              { description: "Launch from Earth", status: "pending" },
              { description: "Land on Mars", status: "pending" },
            ],
          }),
        },
      ],
    },
  });
  // CrewAI agentic gen UI: after simulate_task completes, the flow re-enters
  // chat(). Detect by "Steps executed." tool result in history.
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const hasCrewAITool = req.tools?.some(
          (t) => t.function.name === "generate_task_steps",
        );
        const noStrandsTool = !req.tools?.some(
          (t) => t.function.name === "plan_task_steps",
        );
        const hasToolResult = req.messages.some(
          (m) =>
            m.role === "tool" && textOf(m.content).includes("Steps executed"),
        );
        return !!hasCrewAITool && noStrandsTool && hasToolResult;
      },
    },
    response: {
      content: "All steps completed successfully! Your brownies are ready. 🎉",
    },
  });

  // CrewAI crew_exit: when user says "goodbye crew", return the crew_exit tool
  // call. ChatWithCrewFlow handles this by calling copilotkit_exit() and making
  // a follow-up acompletion with tool_choice="none".
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const hasCrewExitTool = req.tools?.some(
          (t) => t.function.name === "crew_exit",
        );
        const hasCrewExitedResult = req.messages.some(
          (m) => m.role === "tool" && textOf(m.content) === "Crew exited",
        );
        return (
          !!hasCrewExitTool &&
          !hasCrewExitedResult &&
          textOf(lastUser?.content).includes("goodbye crew")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: "crew_exit",
          arguments: "{}",
        },
      ],
    },
  });

  // CrewAI crew_exit follow-up: after crew_exit is processed, the flow calls
  // acompletion again with tool_choice="none" to generate a farewell message.
  // Detect by "Crew exited" tool result in message history.
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const hasCrewExitedResult = req.messages.some(
          (m) => m.role === "tool" && textOf(m.content) === "Crew exited",
        );
        const hasCrewExitTool = req.tools?.some(
          (t) => t.function.name === "crew_exit",
        );
        return !!hasCrewExitTool && hasCrewExitedResult;
      },
    },
    response: {
      content: "Goodbye! The crew has been shut down. Have a great day!",
    },
  });

  // CrewAI crew-RUN path (CPK-7717 defect 2 & 3). Distinct from crew_exit:
  // here the user asks the crew to do real work, so the assistant must call
  // the CREW tool. That tool's function name is the crew name itself
  // ("CrewChatCrew" == CrewChatCrew.name / ChatInputs.crew_name), NOT
  // crew_exit. ChatWithCrewFlow.chat() then runs crew.kickoff() (whose own
  // internal agent LLM call ALSO routes through aimock — see the kickoff
  // fixture below), records the crew output on state (defect 3), and — the
  // P0 fix — issues a follow-up completion with tool_choice="none" so the
  // assistant SPEAKS about the result instead of going silent (defect 2).
  const CREW_CHAT_CREW_TOOL = "CrewChatCrew";
  // The crew's kickoff result string. It becomes both state.outputs (defect 3)
  // and the `tool`-role message content the defect-2 follow-up sees, so the
  // follow-up + generic-catch-all guards below match on this exact value.
  const CREW_RUN_OUTPUT =
    "The crew planned your team offsite: pick a date, book a venue, and send invites.";
  const hasCrewRunTool = (req: { tools?: { function: { name: string } }[] }) =>
    req.tools?.some((t) => t.function.name === CREW_CHAT_CREW_TOOL) ?? false;

  // Turn 1 — primary chat() completion: the assistant calls the crew tool.
  // Gated to the FIRST pass (no tool result yet) so it never re-fires on the
  // defect-2 follow-up (whose request still carries the same last user msg
  // and the crew tool in its tools list).
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        return (
          hasCrewRunTool(req) &&
          !hasToolResult(req) &&
          textOf(lastUser?.content).includes("plan a team offsite")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: CREW_CHAT_CREW_TOOL,
          arguments: JSON.stringify({ user_message: "Plan a team offsite" }),
        },
      ],
    },
  });

  // Backend tool rendering (backend_tool_rendering flow): a "Weather Assistant"
  // crew agent calls the backend get_weather tool, then produces a final text
  // summary. Both the tool-call turn and the final-answer turn hit aimock.
  // Matched on the unique "Weather Assistant" role so they beat the crew_chat
  // "Your personal goal is" catch-all below (first registered wins). The
  // final-answer turn is also excluded from the generic tool-result catch-all
  // further down so this dedicated summary wins over it.
  // Require the CrewAI agent's backstory phrase alongside the role. sysIncludes is
  // case-insensitive and other frameworks (e.g. Mastra) also ship a "weather
  // assistant" backend-tool demo, so matching the role alone would hijack their
  // requests; this phrase is unique to the CrewAI agent's backstory.
  const isWeatherAgentCall = (req: { messages: ChatMessage[] }) =>
    sysIncludes(req.messages, "Weather Assistant") &&
    sysIncludes(req.messages, "look up the weather before you answer");
  const isWeatherAgentToolResultTurn = (req: { messages: ChatMessage[] }) =>
    isWeatherAgentCall(req) && hasToolResult(req);
  const weatherToolCall = (location: string, id: string) => ({
    toolCalls: [
      { name: "get_weather", arguments: JSON.stringify({ location }), id },
    ],
  });

  // Tool-call turn, San Francisco.
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        return (
          isWeatherAgentCall(req) &&
          !hasToolResult(req) &&
          textOf(lastUser?.content).includes("San Francisco")
        );
      },
    },
    response: weatherToolCall("San Francisco", "call_get_weather_sf"),
  });

  // Tool-call turn, New York.
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        return (
          isWeatherAgentCall(req) &&
          !hasToolResult(req) &&
          textOf(lastUser?.content).includes("New York")
        );
      },
    },
    response: weatherToolCall("New York", "call_get_weather_ny"),
  });

  // Final-answer turn: after get_weather returns, the crew agent completes with a
  // short weather summary. One fixture serves both cities (the card data rides
  // the tool result); the city is echoed from the user request for a natural reply.
  mockServer.addFixture({
    match: { predicate: (req) => isWeatherAgentToolResultTurn(req) },
    response: (req) => {
      const lastUser = req.messages.filter((m) => m.role === "user").pop();
      const city = textOf(lastUser?.content).includes("New York")
        ? "New York"
        : "San Francisco";
      return {
        content: `${city}: sunny and 20°C, 50% humidity, wind around 10, feels like 25°C.`,
      };
    },
  });

  // Crew-internal kickoff: crew.kickoff() runs the "General Assistant" agent,
  // whose single LLM call routes here. crewai's no-tools agent requires the
  // EXACT "Thought:/Final Answer:" format or it retries — returning it means
  // the crew resolves in one pass and str(crew_output) == CREW_RUN_OUTPUT.
  // Matched via the role_playing marker "Your personal goal is", which is
  // unique to the agent-execution prompt (absent from the primary chat()
  // system message and from the crew description-generation calls).
  mockServer.addFixture({
    match: {
      predicate: (req) => sysIncludes(req.messages, "Your personal goal is"),
    },
    response: {
      content:
        "Thought: I now can give a great answer\nFinal Answer: " +
        CREW_RUN_OUTPUT,
    },
  });

  // Turn 2 — defect-2 follow-up completion: after the crew tool result lands,
  // chat() re-completes with tool_choice="none" so the assistant produces
  // visible text about the crew result. Matched by the crew tool result in
  // history (last message is the `tool` role carrying CREW_RUN_OUTPUT). Must
  // beat the generic tool-result catch-all below, which is why that catch-all
  // explicitly skips this case (mirroring its crew_exit skip).
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const last = req.messages[req.messages.length - 1];
        return (
          last?.role === "tool" &&
          textOf(last.content) === CREW_RUN_OUTPUT &&
          hasCrewRunTool(req)
        );
      },
    },
    response: {
      content:
        "The crew finished planning your team offsite: pick a date, book a " +
        "venue, and send invites. Anything else?",
    },
  });

  // Shared state: ADK/Strands use generate_recipe (not updateWorkingMemory).
  // The JSON fixture in shared-state.json returns updateWorkingMemory which
  // only works for CopilotKit frameworks (Agno/LangGraph). These predicate
  // fixtures fire first for ADK and Strands (which both register generate_recipe).
  const recipeData = {
    title: "Pasta Aglio e Olio",
    skill_level: "Intermediate",
    special_preferences: [] as string[],
    cooking_time: "45 min",
    ingredients: [
      { icon: "🍝", name: "Pasta", amount: "400g" },
      { icon: "🧂", name: "Salt", amount: "1 tsp" },
      { icon: "🫒", name: "Olive Oil", amount: "4 tbsp" },
      { icon: "🧄", name: "Garlic", amount: "6 cloves" },
      { icon: "🍅", name: "Tomatoes", amount: "2 cups" },
    ],
    instructions: [
      "Boil water and cook pasta until al dente",
      "Slice garlic thinly and sauté in olive oil",
      "Dice tomatoes and add to the pan",
      "Season with salt to taste",
      "Toss pasta with the sauce and serve",
    ],
    changes: "",
  };
  // Strands/CrewAI/LangGraph: generate_recipe(recipe: Recipe) — nested {recipe: {...}} args.
  // These frameworks wrap recipe data under a "recipe" key. Discriminate from ADK
  // (flat args) via two signals: (1) tool schema has parameters.properties.recipe
  // (available in OpenAI-format requests), or (2) system prompt contains
  // "helpful recipe assistant" (Strands — whose Gemini SDK omits parameter
  // schemas from functionDeclarations).
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const recipeTool = req.tools?.find(
          (t) => t.function.name === "generate_recipe",
        );
        const hasNestedRecipeParam = !!(
          (recipeTool?.function.parameters as Record<string, unknown>)
            ?.properties as Record<string, unknown>
        )?.recipe;
        return (
          !!recipeTool &&
          (hasNestedRecipeParam ||
            sysIncludes(req.messages, "helpful recipe assistant")) &&
          textOf(lastUser?.content).includes("pasta recipe")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: "generate_recipe",
          arguments: JSON.stringify({ recipe: recipeData }),
        },
      ],
    },
  });
  // ADK: generate_recipe(skill_level, title, ...) — flat argument format.
  // Falls through when neither tool schema nor system prompt indicates nested args.
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const recipeTool = req.tools?.find(
          (t) => t.function.name === "generate_recipe",
        );
        const hasNestedRecipeParam = !!(
          (recipeTool?.function.parameters as Record<string, unknown>)
            ?.properties as Record<string, unknown>
        )?.recipe;
        return (
          !!recipeTool &&
          !hasNestedRecipeParam &&
          !sysIncludes(req.messages, "helpful recipe assistant") &&
          textOf(lastUser?.content).includes("pasta recipe")
        );
      },
    },
    response: {
      toolCalls: [
        { name: "generate_recipe", arguments: JSON.stringify(recipeData) },
      ],
    },
  });

  // Pydantic AI shared state: the agent registers display_recipe,
  // not updateWorkingMemory. The Recipe model differs from ADK/Strands
  // (no title/changes fields, StrEnum values for skill_level/cooking_time).
  // IMPORTANT: pydantic-ai's single_arg_name optimization means a tool with
  // one model-like parameter (e.g. display_recipe(recipe: Recipe)) uses the
  // model's schema directly as the tool JSON schema — so the arguments must
  // be the Recipe fields at the top level, NOT wrapped in {"recipe": {...}}.
  const pydanticRecipeData = {
    skill_level: "Intermediate",
    special_preferences: [] as string[],
    cooking_time: "45 min",
    ingredients: [
      { icon: "🍝", name: "Pasta", amount: "400g" },
      { icon: "🧂", name: "Salt", amount: "1 tsp" },
      { icon: "🫒", name: "Olive Oil", amount: "4 tbsp" },
      { icon: "🧄", name: "Garlic", amount: "6 cloves" },
      { icon: "🍅", name: "Tomatoes", amount: "2 cups" },
    ],
    instructions: [
      "Boil water and cook pasta until al dente",
      "Slice garlic thinly and sauté in olive oil",
      "Dice tomatoes and add to the pan",
      "Season with salt to taste",
      "Toss pasta with the sauce and serve",
    ],
  };
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const hasPydanticTool = req.tools?.some(
          (t) => t.function.name === "display_recipe",
        );
        return (
          !!hasPydanticTool &&
          textOf(lastUser?.content).includes("pasta recipe")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: "display_recipe",
          arguments: JSON.stringify(pydanticRecipeData),
        },
      ],
    },
  });

  // Pydantic AI agentic gen UI: the agent registers create_plan,
  // not generate_task_steps_generative_ui. Predicate fixtures detect the
  // Pydantic AI tool name and return the correct tool call.
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const hasPydanticTool = req.tools?.some(
          (t) => t.function.name === "create_plan",
        );
        return (
          !!hasPydanticTool &&
          textOf(lastUser?.content).includes("plan to make brownies")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: "create_plan",
          arguments: JSON.stringify({
            steps: [
              "Gather ingredients",
              "Melt butter and mix with cocoa",
              "Add eggs and flour",
              "Bake at 350F for 25 min",
            ],
          }),
        },
      ],
    },
  });
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const hasPydanticTool = req.tools?.some(
          (t) => t.function.name === "create_plan",
        );
        return (
          !!hasPydanticTool && textOf(lastUser?.content).includes("Go to Mars")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: "create_plan",
          arguments: JSON.stringify({
            steps: [
              "Design spacecraft",
              "Assemble crew",
              "Launch from Earth",
              "Land on Mars",
            ],
          }),
        },
      ],
    },
  });

  // Langroid agentic gen UI: Langroid embeds tool definitions in the system
  // message text (TOOL: create_plan) instead of using the OpenAI tools array.
  // Detect via system message content since req.tools will be empty.
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const hasLangroidTool = sysIncludes(req.messages, "TOOL: create_plan");
        return (
          !!hasLangroidTool &&
          textOf(lastUser?.content).includes("plan to make brownies")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: "create_plan",
          arguments: JSON.stringify({
            request: "create_plan",
            steps: [
              "Gather ingredients",
              "Melt butter and mix with cocoa",
              "Add eggs and flour",
              "Bake at 350F for 25 min",
            ],
          }),
        },
      ],
    },
  });
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const hasLangroidTool = sysIncludes(req.messages, "TOOL: create_plan");
        return (
          !!hasLangroidTool && textOf(lastUser?.content).includes("Go to Mars")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: "create_plan",
          arguments: JSON.stringify({
            request: "create_plan",
            steps: [
              "Design spacecraft",
              "Assemble crew",
              "Launch from Earth",
              "Land on Mars",
            ],
          }),
        },
      ],
    },
  });

  // Langroid shared state: Langroid embeds generate_recipe in the system message.
  // The recipe arg is nested under "recipe" key like Strands/CrewAI/LangGraph.
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const hasLangroidTool = sysIncludes(
          req.messages,
          "TOOL: generate_recipe",
        );
        return (
          !!hasLangroidTool &&
          textOf(lastUser?.content).includes("pasta recipe")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: "generate_recipe",
          arguments: JSON.stringify({
            request: "generate_recipe",
            recipe: recipeData,
          }),
        },
      ],
    },
  });

  // LlamaIndex agentic gen UI: the agent registers run_task (a backend tool),
  // not generate_task_steps_generative_ui. The run_task tool takes a Task
  // model with steps: list[Step], where each Step has a description string.
  // Arguments are wrapped in {"task": {...}} since llama-index exposes the
  // function parameter name as the top-level key.
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const hasLlamaIndexTool = req.tools?.some(
          (t) => t.function.name === "run_task",
        );
        return (
          !!hasLlamaIndexTool &&
          textOf(lastUser?.content).includes("plan to make brownies")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: "run_task",
          arguments: JSON.stringify({
            task: {
              steps: [
                { description: "Gather ingredients" },
                { description: "Melt butter and mix with cocoa" },
                { description: "Add eggs and flour" },
                { description: "Bake at 350F for 25 min" },
              ],
            },
          }),
        },
      ],
    },
  });
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const hasLlamaIndexTool = req.tools?.some(
          (t) => t.function.name === "run_task",
        );
        return (
          !!hasLlamaIndexTool &&
          textOf(lastUser?.content).includes("Go to Mars")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: "run_task",
          arguments: JSON.stringify({
            task: {
              steps: [
                { description: "Design spacecraft" },
                { description: "Assemble crew" },
                { description: "Launch from Earth" },
                { description: "Land on Mars" },
              ],
            },
          }),
        },
      ],
    },
  });

  // LlamaIndex shared state: the agent registers update_recipe (a frontend
  // tool), not updateWorkingMemory. The Recipe model has skill_level,
  // special_preferences, cooking_time, ingredients, instructions (no title
  // or changes). Arguments are wrapped in {"recipe": {...}}.
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const hasLlamaIndexTool = req.tools?.some(
          (t) => t.function.name === "update_recipe",
        );
        return (
          !!hasLlamaIndexTool &&
          textOf(lastUser?.content).includes("pasta recipe")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: "update_recipe",
          arguments: JSON.stringify({
            recipe: pydanticRecipeData,
          }),
        },
      ],
    },
  });

  // Claude Agent SDK shared state: the adapter registers ag_ui_update_state
  // via an MCP server named "ag_ui", so the CLI sends the tool as
  // mcp__ag_ui__ag_ui_update_state. Match both bare and MCP-prefixed names.
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const hasClaudeSdkTool = req.tools?.some(
          (t) =>
            t.function.name === "ag_ui_update_state" ||
            t.function.name.endsWith("__ag_ui_update_state"),
        );
        return (
          !!hasClaudeSdkTool &&
          textOf(lastUser?.content).includes("pasta recipe")
        );
      },
    },
    response: {
      toolCalls: [
        {
          // Use MCP-prefixed name so the CLI can route it to the right tool.
          // The Python Claude SDK CLI requires exact name matching.
          name: "mcp__ag_ui__ag_ui_update_state",
          arguments: JSON.stringify({ state_updates: { recipe: recipeData } }),
        },
      ],
    },
  });

  // A2UI fixed schema: the agent registers search_flights and search_hotels.
  // These are backend tools — the LLM calls them, the agent executes them
  // server-side, and returns A2UI operations in the tool result. The middleware
  // detects the a2ui_operations JSON in the result and streams it to the frontend.
  // We return a tool call that the agent's tool handler will process.
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const hasFlightTool = req.tools?.some(
          (t) => t.function.name === "search_flights",
        );
        return (
          !!hasFlightTool &&
          textOf(lastUser?.content).toLowerCase().includes("flights")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: "search_flights",
          arguments: JSON.stringify({
            flights: [
              {
                id: "1",
                airline: "United Airlines",
                airlineLogo:
                  "https://www.google.com/s2/favicons?domain=united.com&sz=128",
                flightNumber: "UA 123",
                origin: "SFO",
                destination: "JFK",
                date: "Tue, Apr 8",
                departureTime: "8:00 AM",
                arrivalTime: "4:30 PM",
                duration: "5h 30m",
                status: "On Time",
                statusIcon: "https://placehold.co/12/22c55e/22c55e.png",
                price: "$289",
              },
              {
                id: "2",
                airline: "Delta",
                airlineLogo:
                  "https://www.google.com/s2/favicons?domain=delta.com&sz=128",
                flightNumber: "DL 456",
                origin: "SFO",
                destination: "JFK",
                date: "Tue, Apr 8",
                departureTime: "10:00 AM",
                arrivalTime: "6:45 PM",
                duration: "5h 45m",
                status: "On Time",
                statusIcon: "https://placehold.co/12/22c55e/22c55e.png",
                price: "$315",
              },
            ],
          }),
        },
      ],
    },
  });

  // A2UI fixed schema: hotel search
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const hasHotelTool = req.tools?.some(
          (t) => t.function.name === "search_hotels",
        );
        return (
          !!hasHotelTool &&
          textOf(lastUser?.content).toLowerCase().includes("hotels")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: "search_hotels",
          arguments: JSON.stringify({
            hotels: [
              {
                id: "1",
                name: "The Manhattan Grand",
                location: "Downtown Manhattan",
                rating: 4.5,
                price: "$350",
              },
              {
                id: "2",
                name: "Downtown Boutique Hotel",
                location: "SoHo",
                rating: 4.0,
                price: "$280",
              },
            ],
          }),
        },
      ],
    },
  });

  // A2UI dynamic schema: primary LLM decides to call generate_a2ui.
  // Matches when the request has generate_a2ui in the tools list.
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const hasGenerateTool = req.tools?.some(
          (t) => t.function.name === "generate_a2ui",
        );
        return !!hasGenerateTool;
      },
    },
    response: {
      toolCalls: [
        {
          name: "generate_a2ui",
          arguments: "{}",
        },
      ],
    },
  });

  // A2UI dynamic schema: secondary LLM inside generate_a2ui calls render_a2ui.
  // The agent forces tool_choice="render_a2ui" on the secondary call.
  // Match by detecting render_a2ui in the tools list (the secondary call
  // has render_a2ui as the only tool, unlike the primary which has generate_a2ui).
  //
  // These fixtures use the dynamicSchemaCatalog domain components (HotelCard,
  // ProductCard, TeamMemberCard) with the structural-children + data-binding
  // pattern described in the agent's COMPOSITION_GUIDE.
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const hasRenderTool = req.tools?.some(
          (t) => t.function.name === "render_a2ui",
        );
        const hasGenerateTool = req.tools?.some(
          (t) => t.function.name === "generate_a2ui",
        );
        // Secondary call: has render_a2ui but NOT generate_a2ui
        if (!hasRenderTool || hasGenerateTool) return false;
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        return textOf(lastUser?.content).toLowerCase().includes("hotel");
      },
    },
    response: {
      toolCalls: [
        {
          name: "render_a2ui",
          arguments: JSON.stringify({
            surfaceId: "hotel-comparison",
            catalogId: "https://a2ui.org/demos/dojo/dynamic_catalog.json",
            components: [
              {
                id: "root",
                component: "Row",
                children: { componentId: "card", path: "/items" },
              },
              {
                id: "card",
                component: "HotelCard",
                name: { path: "name" },
                location: { path: "location" },
                rating: { path: "rating" },
                pricePerNight: { path: "pricePerNight" },
                action: {
                  event: { name: "book", context: { name: { path: "name" } } },
                },
              },
            ],
            data: {
              items: [
                {
                  name: "The Ritz",
                  location: "Paris",
                  rating: 4.8,
                  pricePerNight: "$450/night",
                },
                {
                  name: "Holiday Inn",
                  location: "New York",
                  rating: 3.5,
                  pricePerNight: "$180/night",
                },
                {
                  name: "Boutique Loft",
                  location: "London",
                  rating: 4.2,
                  pricePerNight: "$320/night",
                },
              ],
            },
          }),
        },
      ],
    },
  });

  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const hasRenderTool = req.tools?.some(
          (t) => t.function.name === "render_a2ui",
        );
        const hasGenerateTool = req.tools?.some(
          (t) => t.function.name === "generate_a2ui",
        );
        if (!hasRenderTool || hasGenerateTool) return false;
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        return textOf(lastUser?.content).toLowerCase().includes("product");
      },
    },
    response: {
      toolCalls: [
        {
          name: "render_a2ui",
          arguments: JSON.stringify({
            surfaceId: "product-comparison",
            catalogId: "https://a2ui.org/demos/dojo/dynamic_catalog.json",
            components: [
              {
                id: "root",
                component: "Row",
                children: { componentId: "card", path: "/items" },
              },
              {
                id: "card",
                component: "ProductCard",
                name: { path: "name" },
                price: { path: "price" },
                rating: { path: "rating" },
                description: { path: "description" },
                action: {
                  event: {
                    name: "select",
                    context: { name: { path: "name" } },
                  },
                },
              },
            ],
            data: {
              items: [
                {
                  name: "Sony WH-1000XM5",
                  price: "$349",
                  rating: 4.7,
                  description: "Industry-leading noise cancellation",
                },
                {
                  name: "AirPods Max",
                  price: "$549",
                  rating: 4.5,
                  description: "Premium Apple ecosystem integration",
                },
                {
                  name: "Bose QC Ultra",
                  price: "$429",
                  rating: 4.6,
                  description: "Comfortable with spatial audio",
                },
              ],
            },
          }),
        },
      ],
    },
  });

  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const hasRenderTool = req.tools?.some(
          (t) => t.function.name === "render_a2ui",
        );
        const hasGenerateTool = req.tools?.some(
          (t) => t.function.name === "generate_a2ui",
        );
        if (!hasRenderTool || hasGenerateTool) return false;
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        return textOf(lastUser?.content).toLowerCase().includes("team");
      },
    },
    response: {
      toolCalls: [
        {
          name: "render_a2ui",
          arguments: JSON.stringify({
            surfaceId: "team-roster",
            catalogId: "https://a2ui.org/demos/dojo/dynamic_catalog.json",
            components: [
              {
                id: "root",
                component: "Row",
                children: { componentId: "card", path: "/items" },
              },
              {
                id: "card",
                component: "TeamMemberCard",
                name: { path: "name" },
                role: { path: "role" },
                department: { path: "department" },
                email: { path: "email" },
                action: {
                  event: {
                    name: "contact",
                    context: { name: { path: "name" } },
                  },
                },
              },
            ],
            data: {
              items: [
                {
                  name: "Alice Chen",
                  role: "Engineering Lead",
                  department: "Engineering",
                  email: "alice@example.com",
                },
                {
                  name: "Bob Martinez",
                  role: "Product Designer",
                  department: "Design",
                  email: "bob@example.com",
                },
                {
                  name: "Carol Davis",
                  role: "Backend Engineer",
                  department: "Engineering",
                  email: "carol@example.com",
                },
                {
                  name: "Dan Wilson",
                  role: "DevOps Engineer",
                  department: "Infrastructure",
                  email: "dan@example.com",
                },
              ],
            },
          }),
        },
      ],
    },
  });

  // Load all fixture JSON files from the fixtures directory.
  // HITL fixtures loaded above take priority (first-match-wins).
  // Multimodal image verification: only answer with the marker the LlamaIndex
  // multimodal spec asserts on when the LLM request actually carries an
  // image_url content part. The generic agentic-chat-multimodal.json fixture
  // below matches on prompt text alone, so a client that silently flattens
  // parts lists to text (e.g. a maxVersion<=0.0.39 compat pin) would still
  // get an image-themed reply and the e2e would pass vacuously. With this
  // predicate, a stripped image falls through to the JSON fixture, whose
  // response lacks the marker, and the spec fails — making the test
  // meaningful. Registered before loadFixtureDir (first match wins).
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const hasImagePart = req.messages.some(
          (m) =>
            Array.isArray(m.content) &&
            m.content.some(
              (p) =>
                (p as { type?: string }).type === "image_url" &&
                !!(p as { image_url?: { url?: string } }).image_url?.url,
            ),
        );
        // "llamaindex-mm-check" scopes this fixture to the LlamaIndex suite:
        // other integrations' multimodal specs send similar prompts with
        // image_url parts, and without a unique token this fixture would
        // intercept them (first match wins).
        return (
          hasImagePart &&
          textOf(lastUser?.content).toLowerCase().includes("llamaindex-mm-check")
        );
      },
    },
    response: {
      content:
        "multimodal-image-verified: I received the uploaded image and can see its visual content. Happy to describe specific details.",
    },
  });

  mockServer.loadFixtureDir(FIXTURES_DIR);

  // Programmatic catch-all: when the last message is a tool result,
  // return a generic text acknowledgment. This must be added AFTER
  // fixture files so it appears last in the fixture list — but
  // fixture-file entries only match on userMessage (substring), and
  // a follow-up request after a tool call still has the same last
  // user message, so we need this predicate to fire FIRST.
  // Insert at position 0 so it's checked before file-based fixtures.
  // Prepend so it matches before substring-based fixtures on follow-up requests
  mockServer.prependFixture({
    match: {
      predicate: (req) => {
        const last = req.messages[req.messages.length - 1];
        if (last?.role !== "tool") return false;
        // Don't match CrewAI crew_exit follow-up — it has a dedicated fixture
        const hasCrewExitTool = req.tools?.some(
          (t) => t.function.name === "crew_exit",
        );
        if (hasCrewExitTool && textOf(last.content) === "Crew exited")
          return false;
        // Don't match the CrewAI crew-RUN follow-up (defect 2) — it has a
        // dedicated fixture keyed on the crew output string.
        if (hasCrewRunTool(req) && textOf(last.content) === CREW_RUN_OUTPUT)
          return false;
        // Don't match the backend weather tool-result turn; a dedicated
        // Weather-Assistant summary fixture answers it.
        if (isWeatherAgentToolResultTurn(req)) return false;
        // Don't match a CrewAI A2UI turn that a2ui-crewai-fixtures.ts answers
        // itself (a surface-action click, or the closing turn over a render
        // result): a generic acknowledgment would mask the reply under test.
        // The predicate is scoped to that file's own prompts, so every other
        // integration's A2UI demo keeps this fallback.
        if (crewAIA2UIAnswersToolResultTurn(req)) return false;
        // Don't match the AWS Strands interrupt / predictive-state tool-result
        // turns: a generic acknowledgment would mask whether the booking was
        // confirmed or refused, and whether the document edit was re-proposed.
        // Scoped to those demos' own system prompts.
        if (strandsAnswersToolResultTurn(req)) return false;
        // Don't match the deepagents_subagents demo's own tool-result turns:
        // the subagent's post-approval answer and the supervisor's relay. A
        // generic acknowledgment here would make the approve and reject
        // branches read identically, which is exactly what that spec asserts
        // differs. Scoped to this demo's system prompts.
        if (deepagentsSubagentsAnswersToolResultTurn(req)) return false;
        return true;
      },
    },
    response: { content: "Done! I've completed that for you." },
  });

  // Universal catch-all: matches any request that wasn't handled above.
  // Appended LAST so specific fixtures always take priority.
  //
  // The diagnostic lives in the RESPONSE FACTORY, not in the predicate. Since
  // aimock 1.34.0 the matcher no longer returns on first match — it evaluates
  // every candidate's `match.predicate` and only then selects a winner, so a
  // side effect inside a predicate fires on every single request. A response
  // factory runs only when this fixture is the one actually served, i.e. only
  // on a genuine fixture miss, which is what this log is for.
  mockServer.addFixture({
    // endpoint: "chat" is load-bearing. A *function* response skips aimock's
    // per-endpoint response-shape gate, so an unscoped catch-all becomes
    // eligible for image/speech/transcription/video requests it could never
    // match before, turning their honest 404 into a mis-attributed 500.
    match: {
      endpoint: "chat",
      predicate: () => true,
    },
    response: (req) => {
      const lastUser = req.messages.filter((m) => m.role === "user").pop();
      const userText = lastUser ? textOf(lastUser.content) : "(no user msg)";
      const toolNames =
        req.tools?.map((t) => t.function.name).join(",") || "(no tools)";
      const contentType = lastUser ? typeof lastUser.content : "N/A";
      const contentSample = lastUser
        ? JSON.stringify(lastUser.content).slice(0, 120)
        : "N/A";
      console.error(
        `[aimock CATCH-ALL] model=${req.model} lastUser="${userText.slice(0, 80)}" tools=[${toolNames}] msgs=${req.messages.length} contentType=${contentType} content=${contentSample}`,
      );
      return { content: "I understand. How can I help you with that?" };
    },
  });

  // Log fixture counts for debugging
  const allFixtures = mockServer.getFixtures();
  const predicateCount = allFixtures.filter((f) => f.match.predicate).length;
  const userMsgCount = allFixtures.filter((f) => f.match.userMessage).length;
  console.log(
    `   Fixture stats: ${allFixtures.length} total, ${predicateCount} predicate, ${userMsgCount} userMessage`,
  );
  // Log the userMessage fixtures to verify they loaded
  allFixtures.forEach((f, i) => {
    if (f.match.userMessage) {
      console.log(
        `     [${i}] userMessage: "${String(f.match.userMessage).slice(0, 50)}"`,
      );
    }
  });

  const url = await mockServer.start();
  console.log(`✅ aimock server running at ${url}`);
  console.log(`   Fixtures loaded from: ${FIXTURES_DIR}`);

  // Export the URL for child processes to use
  process.env.LLMOCK_URL = `${url}/v1`;
}

export async function teardownLLMock(): Promise<void> {
  if (mockServer) {
    console.log("🧹 Stopping aimock server...");
    await mockServer.stop();
    mockServer = null;
    console.log("✅ aimock server stopped");
  }
}

export function getMockServer(): LLMock | null {
  return mockServer;
}
