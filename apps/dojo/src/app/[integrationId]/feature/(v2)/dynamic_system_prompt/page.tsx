"use client";
import React, { useState } from "react";
import "@copilotkit/react-core/v2/styles.css";
import { CopilotChat, useAgentContext } from "@copilotkit/react-core/v2";
import { CopilotKit } from "@copilotkit/react-core";

interface DynamicSystemPromptProps {
  params: Promise<{
    integrationId: string;
  }>;
}

type Language = "English" | "Arabic" | "German";

const LANGUAGES: { value: Language; label: string; flag: string }[] = [
  { value: "English", label: "English", flag: "🇬🇧" },
  { value: "Arabic", label: "Arabic", flag: "🇸🇦" },
  { value: "German", label: "German", flag: "🇩🇪" },
];

const DynamicSystemPrompt: React.FC<DynamicSystemPromptProps> = ({ params }) => {
  const { integrationId } = React.use(params);

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      agent="dynamic_system_prompt"
    >
      <DynamicSystemPromptView />
    </CopilotKit>
  );
};

const DynamicSystemPromptView = () => {
  const [language, setLanguage] = useState<Language>("English");

  // The only thing this demo sends: one context item the agent's
  // instructions callable reads on every turn to pick the reply language.
  // No tool, no state — just the AG-UI context channel.
  useAgentContext({
    description: "Reply language",
    value: language,
  });

  return (
    <div className="flex h-full w-full">
      <div className="hidden md:flex w-64 shrink-0 flex-col border-r border-black/10 dark:border-white/10 p-4">
        <h3 className="text-sm font-semibold mb-3">Reply language</h3>
        <div className="flex flex-col gap-2">
          {LANGUAGES.map(({ value, label, flag }) => (
            <button
              key={value}
              onClick={() => setLanguage(value)}
              className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm text-left transition-colors ${
                language === value
                  ? "border-blue-400 bg-blue-50 dark:bg-blue-950/40"
                  : "border-black/10 dark:border-white/10"
              }`}
            >
              <span>{flag}</span>
              <span>{label}</span>
            </button>
          ))}
        </div>
        <p className="mt-4 text-xs text-black/50 dark:text-white/50">
          Switching language updates the AG-UI context sent with the next
          message — the agent&apos;s system prompt is rebuilt every turn to
          match.
        </p>
      </div>

      <div className="flex-1 flex justify-center items-center h-full w-full">
        <div className="h-full w-full md:w-9/10 md:h-8/10 rounded-lg">
          <CopilotChat
            agentId="dynamic_system_prompt"
            className="h-full rounded-2xl max-w-4xl mx-auto"
          />
        </div>
      </div>
    </div>
  );
};

export default DynamicSystemPrompt;
