"use client";

import { CopilotKit } from "@copilotkit/react-core";
import {
  CopilotChat,
  useConfigureSuggestions,
} from "@copilotkit/react-core/v2";

function Assistant() {
  useConfigureSuggestions({
    suggestions: [
      {
        title: "What can you do?",
        message:
          "Introduce yourself and explain how AG-UI connects you to this page.",
      },
      {
        title: "How does this work?",
        message: "Explain how Google ADK, AG-UI, and this page work together.",
      },
    ],
    available: "always",
  });

  return <CopilotChat className="chat" />;
}

export default function Home() {
  return (
    <CopilotKit runtimeUrl="/api/copilotkit" agent="assistant">
      <main>
        <header>
          <h1>Google ADK JavaScript + AG-UI</h1>
          <p>A native ADK runner, streamed to the browser through AG-UI.</p>
        </header>
        <Assistant />
      </main>
    </CopilotKit>
  );
}
