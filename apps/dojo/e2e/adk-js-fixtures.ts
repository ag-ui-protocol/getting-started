/**
 * Deterministic model fixtures for the in-process Google ADK JavaScript Dojo
 * agents. Each predicate is scoped to a phrase unique to that agent's system
 * instruction, so these responses cannot intercept another integration.
 */
import type {
  ChatCompletionRequest,
  ChatMessage,
  LLMock,
} from "@copilotkit/aimock";

const textOf = (content: ChatMessage["content"] | undefined): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text!)
      .join("");
  }
  return "";
};

const systemText = (request: ChatCompletionRequest): string =>
  request.messages
    .filter((message) => message.role === "system")
    .map((message) => textOf(message.content))
    .join("\n");

// The current turn is a tool-result turn only when the conversation ends with
// a tool message. Checking anywhere in history would misroute later user turns
// once a single tool call exists in the transcript.
const isToolResultTurn = (request: ChatCompletionRequest): boolean =>
  request.messages[request.messages.length - 1]?.role === "tool";

const ADK_JS_TOOL_AGENT_INSTRUCTIONS = [
  /weather assistant\. Always call get_weather/i,
  /create haiku with a frontend-provided generate_haiku tool/i,
  /recipe assistant\. The current recipe is/i,
  /schedule meetings with human input/i,
];

export function isADKJSToolResultTurn(request: ChatCompletionRequest): boolean {
  return (
    isToolResultTurn(request) &&
    ADK_JS_TOOL_AGENT_INSTRUCTIONS.some((pattern) =>
      pattern.test(systemText(request)),
    )
  );
}

export function registerADKJSFixtures(mockServer: LLMock): void {
  mockServer.addFixture({
    match: {
      predicate: (request: ChatCompletionRequest) =>
        /concise, helpful assistant/i.test(systemText(request)),
    },
    response: {
      content: "Hello Duaa! How can I assist you today?",
    },
  });

  mockServer.addFixture({
    match: {
      predicate: (request: ChatCompletionRequest) =>
        /weather assistant\. Always call get_weather/i.test(
          systemText(request),
        ) && !isToolResultTurn(request),
    },
    response: {
      toolCalls: [
        {
          id: "call_adk_js_weather",
          name: "get_weather",
          arguments: JSON.stringify({ location: "San Francisco" }),
        },
      ],
    },
  });

  mockServer.addFixture({
    match: {
      predicate: (request: ChatCompletionRequest) =>
        /weather assistant\. Always call get_weather/i.test(
          systemText(request),
        ) && isToolResultTurn(request),
    },
    response: {
      content:
        "San Francisco is partly cloudy with mild temperatures and a light breeze.",
    },
  });

  mockServer.addFixture({
    match: {
      predicate: (request: ChatCompletionRequest) =>
        /create haiku with a frontend-provided generate_haiku tool/i.test(
          systemText(request),
        ) && !isToolResultTurn(request),
    },
    response: {
      toolCalls: [
        {
          id: "call_adk_js_haiku",
          name: "generate_haiku",
          arguments: JSON.stringify({
            japanese: ["勝利の道を", "常に歩み続ける", "勝つ運命よ"],
            english: [
              "On the path of victory",
              "I will always keep walking",
              "Destined to always win",
            ],
            image_name:
              "Mount_Fuji_Lake_Reflection_Cherry_Blossoms_Sakura_Spring.jpg",
            gradient: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
          }),
        },
      ],
    },
  });

  mockServer.addFixture({
    match: {
      predicate: (request: ChatCompletionRequest) =>
        /create haiku with a frontend-provided generate_haiku tool/i.test(
          systemText(request),
        ) && isToolResultTurn(request),
    },
    response: { content: "Your haiku is ready." },
  });

  mockServer.addFixture({
    match: {
      predicate: (request: ChatCompletionRequest) =>
        /recipe assistant\. The current recipe is/i.test(systemText(request)) &&
        !isToolResultTurn(request),
    },
    response: {
      toolCalls: [
        {
          id: "call_adk_js_recipe",
          name: "generate_recipe",
          arguments: JSON.stringify({
            title: "Weeknight Tomato Pasta",
            skill_level: "Beginner",
            cooking_time: "30 min",
            special_preferences: ["Vegetarian"],
            ingredients: [
              { icon: "🍝", name: "Pasta", amount: "400g" },
              { icon: "🍅", name: "Tomatoes", amount: "2 cups" },
              { icon: "🧄", name: "Garlic", amount: "3 cloves" },
            ],
            instructions: [
              "Cook the pasta until al dente.",
              "Simmer the tomatoes and garlic.",
              "Toss the pasta with the sauce and serve.",
            ],
          }),
        },
      ],
    },
  });

  mockServer.addFixture({
    match: {
      predicate: (request: ChatCompletionRequest) =>
        /recipe assistant\. The current recipe is/i.test(systemText(request)) &&
        isToolResultTurn(request),
    },
    response: { content: "Your pasta recipe is ready." },
  });

  // ADK 2.x hides the `adk_request_input` exchange from the model, so the
  // bridge delivers the resumed answer as a second user turn rather than as a
  // tool result. The opening turn is the one with a single user message; the
  // closing turn is either that reply or (for older ADK) a tool-result turn.
  const userTurns = (request: ChatCompletionRequest): number =>
    request.messages.filter((message) => message.role === "user").length;

  mockServer.addFixture({
    match: {
      predicate: (request: ChatCompletionRequest) =>
        /schedule meetings with human input/i.test(systemText(request)) &&
        !isToolResultTurn(request) &&
        userTurns(request) === 1,
    },
    response: {
      toolCalls: [
        {
          id: "call_adk_js_request_input",
          name: "adk_request_input",
          arguments: JSON.stringify({
            message:
              "Choose a time for an intro call with the sales team to discuss pricing.",
          }),
        },
      ],
    },
  });

  mockServer.addFixture({
    match: {
      predicate: (request: ChatCompletionRequest) =>
        /schedule meetings with human input/i.test(systemText(request)) &&
        (isToolResultTurn(request) || userTurns(request) >= 2),
    },
    response: {
      content: "Your intro call with the sales team is scheduled.",
    },
  });
}
