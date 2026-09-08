"use client";
import React from "react";
import "@copilotkit/react-core/v2/styles.css";
import "./style.css";
import {
  CopilotChat,
  useConfigureSuggestions,
} from "@copilotkit/react-core/v2";
import { CopilotKit } from "@copilotkit/react-core";
import { dynamicSchemaCatalog } from "@/a2ui-catalog";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ integrationId: string }>;
}

function Chat() {
  useConfigureSuggestions({
    suggestions: [
      {
        title: "Recover from an error",
        message: "Compare 3 luxury hotels with ratings and prices.",
      },
      {
        title: "Hard failure",
        message: "Compare 3 broken hotels with ratings and prices.",
      },
    ],
    available: "always",
  });

  return (
    <CopilotChat
      agentId="a2ui_recovery"
      className="h-full rounded-2xl max-w-6xl mx-auto"
    />
  );
}

export default function Page({ params }: PageProps) {
  const { integrationId } = React.use(params);

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      agent="a2ui_recovery"
      a2ui={{
        catalog: dynamicSchemaCatalog,
        // aimock attempts are instant, so reveal the "Retrying…" status
        // immediately for the demo (the prod default delays ~2s / 2nd attempt).
        recovery: { showAfterMs: 0, showAfterAttempts: 1 },
      }}
    >
      <div className="flex justify-center items-center h-full w-full">
        <div className="h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
          <Chat />
        </div>
      </div>
    </CopilotKit>
  );
}
