"use client";
import React, { useState } from "react";
import "@copilotkit/react-core/v2/styles.css";
import "./style.css";
import {
  useAgent,
  UseAgentUpdate,
  useFrontendTool,
  useConfigureSuggestions,
  CopilotChat,
} from "@copilotkit/react-core/v2";
import { z } from "zod";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CopilotKit } from "@copilotkit/react-core";

interface AgenticChatProps {
  params: Promise<{
    integrationId: string;
  }>;
}

const AgenticChat: React.FC<AgenticChatProps> = ({ params }) => {
  const { integrationId } = React.use(params);

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      agent="agentic_chat_reasoning"
    >
      <Chat />
    </CopilotKit>
  );
};

interface AgentState {
  model: string;
}

const Chat = () => {
  const [background, setBackground] = useState<string>("--copilot-kit-background-color");
  const { agent } = useAgent({
    agentId: "agentic_chat_reasoning",
    updates: [UseAgentUpdate.OnStateChanged],
  });

  const agentState = agent.state as AgentState | undefined;

  // Initialize model if not set
  const selectedModel = agentState?.model || "OpenAI";

  const handleModelChange = (model: string) => {
    agent.setState({ model });
  };

  useConfigureSuggestions({
    suggestions: [
      {
        title: "Change background",
        message: "Change the background to something new.",
      },
      {
        title: "Generate sonnet",
        message: "Write a short sonnet about AI.",
      },
    ],
    available: "always",
  });

  useFrontendTool({
    agentId: "agentic_chat_reasoning",
    name: "change_background",
    description:
      "Change the background color of the chat. Can be anything that the CSS background attribute accepts. Regular colors, linear of radial gradients etc.",
     parameters: z.object({
      background: z.string().describe("The background. Prefer gradients."),
    })  ,
    handler: async ({ background }: { background: string }) => {
      setBackground(background);
      return {
        status: "success",
        message: `Background changed to ${background}`,
      };
    },
  });

  return (
    <div className="flex flex-col h-full w-full" style={{ background }}>
      {/* Reasoning Model Dropdown */}
      <div className="h-[65px] border-b border-gray-200 dark:border-gray-700">
        <div className="h-full flex items-center justify-center">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Reasoning Model:
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="w-[140px] justify-between">
                  {selectedModel}
                  <ChevronDown className="h-4 w-4 opacity-50" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-[140px]">
                <DropdownMenuLabel>Select Model</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => handleModelChange("OpenAI")}>
                  OpenAI
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleModelChange("Anthropic")}>
                  Anthropic
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleModelChange("Gemini")}>
                  Gemini
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {/* Chat Container */}
      <div className="flex-1 flex justify-center items-center p-4">
        <div className="w-8/10 h-full rounded-lg">
          <CopilotChat
            agentId="agentic_chat_reasoning"
            className="h-full rounded-2xl"
          />
        </div>
      </div>
    </div>
  );
};

export default AgenticChat;
