"use client";

import React from "react";
import { CopilotKit } from "@copilotkit/react-core";
import {
  CopilotChat,
  useConfigureSuggestions,
  useRenderTool,
} from "@copilotkit/react-core/v2";
import "@copilotkit/react-core/v2/styles.css";
import { z } from "zod";

interface AGUIDocsCopilotProps {
  params: Promise<{ integrationId: string }>;
}

const AGUIDocsCopilot: React.FC<AGUIDocsCopilotProps> = ({ params }) => {
  const { integrationId } = React.use(params);

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      agent="ag_ui_docs_copilot"
    >
      <DocsChat />
    </CopilotKit>
  );
};

const DocsChat = () => {
  useRenderTool({
    name: "read_ag_ui_openai_agents_docs",
    agentId: "ag_ui_docs_copilot",
    parameters: z.object({ heading: z.string().optional() }),
    render: ({ status, args, result }: any) => (
      <DocsLookupProgress
        source="AG-UI OpenAI Agents"
        status={status}
        heading={args?.heading}
        result={result}
      />
    ),
  });
  useRenderTool({
    name: "read_ag_ui_protocol_docs",
    agentId: "ag_ui_docs_copilot",
    parameters: z.object({ heading: z.string().optional() }),
    render: ({ status, args, result }: any) => (
      <DocsLookupProgress
        source="AG-UI Protocol"
        status={status}
        heading={args?.heading}
        result={result}
      />
    ),
  });

  useConfigureSuggestions({
    suggestions: [
      {
        title: "Stream an existing agent",
        message:
          "Show me how to transfer an existing OpenAI Agents SDK streaming run to AG-UI. Give the smallest FastAPI endpoint using AGUITranslator.to_openai(), Runner.run_streamed(), AGUITranslator.to_agui(), EventEncoder, and StreamingResponse. Explain only the data flow at each boundary.",
      },
      {
        title: "Map SDK events to AG-UI",
        message:
          "Give me one concise table that maps OpenAI Agents SDK streaming events and items to AG-UI events. Include run lifecycle, text messages, tool calls and results, reasoning, state snapshots, messages snapshots, and errors. Include only mappings supported by this integration.",
      },
      {
        title: "Choose an integration layer",
        message:
          "Compare the three integration APIs: AGUITranslator, OpenAIAgentsAgent, and add_openai_agents_fastapi_endpoint. Give one concise table with what each does, when to choose it, and how much control it keeps over the SDK agent and server.",
      },
    ],
    available: "always",
    consumerAgentId: "ag_ui_docs_copilot",
  });

  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="h-full w-full rounded-lg md:h-8/10 md:w-8/10">
        <CopilotChat
          agentId="ag_ui_docs_copilot"
          className="mx-auto h-full max-w-5xl rounded-2xl"
        />
      </div>
    </div>
  );
};

function DocsLookupProgress({
  source,
  status,
  heading,
  result,
}: {
  source: "AG-UI OpenAI Agents" | "AG-UI Protocol";
  status: "inProgress" | "executing" | "complete";
  heading?: string;
  result?: string;
}) {
  const complete = status === "complete";
  const missed = complete && !!result && result.startsWith("No section matches");

  return (
    <div className="my-2 flex max-w-md items-start gap-2.5 rounded-xl border border-blue-200/70 bg-blue-50/70 px-3.5 py-2.5 text-sm dark:border-blue-400/20 dark:bg-blue-950/30">
      <span
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs ${
          missed
            ? "bg-amber-200 text-amber-900 dark:bg-amber-400/20 dark:text-amber-200"
            : complete
              ? "bg-blue-200 text-blue-900 dark:bg-blue-400/20 dark:text-blue-200"
              : "animate-pulse bg-blue-200/70 text-blue-900 dark:bg-blue-400/10 dark:text-blue-200"
        }`}
      >
        {missed ? "!" : complete ? "✓" : "📖"}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="font-medium text-blue-900 dark:text-blue-100">
            {source} docs
          </span>
          {!complete && (
            <span className="flex gap-0.5" aria-label="Reading section">
              <span className="animate-bounce text-blue-500">•</span>
              <span className="animate-bounce text-blue-500 [animation-delay:120ms]">
                •
              </span>
              <span className="animate-bounce text-blue-500 [animation-delay:240ms]">
                •
              </span>
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-xs text-blue-800/80 dark:text-blue-200/70">
          {heading
            ? `${complete ? "Read" : "Reading"} "${heading}"`
            : complete
              ? "Section read"
              : "Opening the guide"}
        </div>
      </div>
    </div>
  );
}

export default AGUIDocsCopilot;
