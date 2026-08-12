import { LLMock, type ChatMessage } from "@copilotkit/aimock";

function textOf(content: ChatMessage["content"] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

export function registerOpenAIAgentsFixtures(mockServer: LLMock): void {
  const hasTool = (
    req: { tools?: { function: { name: string } }[] },
    name: string,
  ) => req.tools?.some((tool) => tool.function.name === name) ?? false;
  const messagesText = (messages: ChatMessage[]) =>
    messages.map((message) => textOf(message.content)).join("\n");
  const systemText = (messages: ChatMessage[]) =>
    messages
      .filter((message) => message.role === "system")
      .map((message) => textOf(message.content))
      .join("\n");

  mockServer.addFixture({
    match: {
      predicate: (req) =>
        hasTool(req, "read_ag_ui_openai_agents_docs") &&
        messagesText(req.messages).includes(
          "test the OpenAI Agents integration",
        ),
    },
    response: {
      toolCalls: [
        {
          name: "read_ag_ui_openai_agents_docs",
          arguments: JSON.stringify({ heading: "Testing" }),
        },
      ],
    },
  });

  mockServer.addFixture({
    match: {
      predicate: (req) =>
        hasTool(req, "issue_refund") &&
        messagesText(req.messages).includes("ORD-1001"),
    },
    response: {
      toolCalls: [
        {
          name: "issue_refund",
          arguments: JSON.stringify({ order_id: "ORD-1001" }),
        },
      ],
    },
  });

  const hasSupervisorTools = (req: {
    tools?: { function: { name: string } }[];
  }) =>
    ["research_topic", "write_prose", "critique_draft"].every((name) =>
      hasTool(req, name),
    );

  mockServer.addFixture({
    match: {
      predicate: (req) =>
        systemText(req.messages).includes("You research a topic") &&
        !hasSupervisorTools(req),
    },
    response: {
      content:
        "AI research facts: symbolic AI began in the 1950s; machine learning later became dominant.",
    },
  });

  mockServer.addFixture({
    match: {
      predicate: (req) =>
        systemText(req.messages).includes("You turn bullet-point facts") &&
        !hasSupervisorTools(req),
    },
    response: {
      content:
        "AI evolved from symbolic systems into modern machine learning and generative models.",
    },
  });

  mockServer.addFixture({
    match: {
      predicate: (req) =>
        systemText(req.messages).includes("You review a draft") &&
        !hasSupervisorTools(req),
    },
    response: {
      content:
        "1. Improve the opening. 2. Connect the historical eras more clearly.",
    },
  });

  mockServer.addFixture({
    match: {
      predicate: (req) => {
        if (!hasSupervisorTools(req)) return false;
        const text = messagesText(req.messages);
        return !text.includes("AI research facts");
      },
    },
    response: {
      toolCalls: [
        {
          name: "research_topic",
          arguments: JSON.stringify({ input: "history of AI" }),
        },
      ],
    },
  });

  mockServer.addFixture({
    match: {
      predicate: (req) => {
        if (!hasSupervisorTools(req)) return false;
        const text = messagesText(req.messages);
        return (
          text.includes("AI research facts") &&
          !text.includes("AI evolved from symbolic systems")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: "write_prose",
          arguments: JSON.stringify({ input: "AI research facts" }),
        },
      ],
    },
  });

  mockServer.addFixture({
    match: {
      predicate: (req) => {
        if (!hasSupervisorTools(req)) return false;
        const text = messagesText(req.messages);
        return (
          text.includes("AI evolved from symbolic systems") &&
          !text.includes("Improve the opening")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: "critique_draft",
          arguments: JSON.stringify({
            input:
              "AI evolved from symbolic systems into modern machine learning and generative models.",
          }),
        },
      ],
    },
  });

  mockServer.addFixture({
    match: {
      predicate: (req) =>
        hasSupervisorTools(req) &&
        messagesText(req.messages).includes("Improve the opening"),
    },
    response: {
      content:
        "Artificial intelligence grew from early symbolic programs into machine learning and today's generative systems.",
    },
  });

  mockServer.addFixture({
    match: {
      predicate: (req) =>
        systemText(req.messages).includes("Always reply in Arabic"),
    },
    response: { content: "مرحبًا! أنا أجيب باللغة العربية." },
  });

  mockServer.addFixture({
    match: {
      predicate: (req) =>
        systemText(req.messages).includes("Always reply in German"),
    },
    response: { content: "Hallo! Ich antworte auf Deutsch." },
  });
}
