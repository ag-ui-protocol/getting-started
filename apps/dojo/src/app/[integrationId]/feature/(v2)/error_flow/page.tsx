"use client";
import React from "react";
import "@copilotkit/react-core/v2/styles.css";
import {
  CopilotChat,
  useAgent,
  useCopilotKit,
} from "@copilotkit/react-core/v2";
import { CopilotKit } from "@copilotkit/react-core";

interface ErrorFlowProps {
  params: Promise<{
    integrationId: string;
  }>;
}

interface SurfacedRunError {
  message: string;
  code?: string;
  /** Increments per surfaced error so a stale banner is distinguishable from a fresh one. */
  seq: number;
  /** Increments per RUN_STARTED, so the clear-on-new-run behavior is observable. */
  clears: number;
}

const AGENT_ID = "error_flow";

const RunErrorBanner: React.FC = () => {
  // The banner re-renders from its own state, so it opts out of the hook's
  // re-render subscription entirely rather than paying for run-status updates
  // it never reads.
  const { agent } = useAgent({ agentId: AGENT_ID, updates: [] });
  const [error, setError] = React.useState<SurfacedRunError | null>(null);
  // Both counters live outside the banner state: clearing the banner on
  // RUN_STARTED would otherwise take them with it and restart every run at 1.
  const surfacedCount = React.useRef(0);
  const clearedCount = React.useRef(0);

  React.useEffect(() => {
    const subscription = agent.subscribe({
      // Every run starts clean, so the banner always describes the current run.
      onRunStartedEvent: () => {
        clearedCount.current += 1;
        setError(null);
      },
      onRunErrorEvent: ({ event }) => {
        surfacedCount.current += 1;
        setError({
          message: event.message,
          code: event.code,
          seq: surfacedCount.current,
          clears: clearedCount.current,
        });
      },
    });
    return () => subscription.unsubscribe();
  }, [agent]);

  if (!error) {
    return null;
  }

  return (
    <div
      data-testid="run-error"
      data-run-error-seq={error.seq}
      data-run-error-clears={error.clears}
      role="alert"
      className="mb-3 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-700 dark:bg-red-950 dark:text-red-200"
    >
      <div className="font-semibold">Run failed</div>
      {error.code !== undefined ? (
        <div data-testid="run-error-code" className="font-mono text-xs">
          {error.code}
        </div>
      ) : null}
      <div data-testid="run-error-message">{error.message}</div>
    </div>
  );
};

/**
 * Both the banner and `CopilotChat` call `useAgent`, which hands out a
 * PER-HOOK provisional agent until the runtime registers the real one. Mounting
 * them before that leaves them subscribed to two different agent objects, so a
 * run that starts and errors on the chat's agent never reaches the banner. That
 * is precisely the window this demo exists to cover, so both are gated until
 * the shared agent is registered.
 *
 * The gate reopens because `useCopilotKit` re-renders on runtime connection
 * status changes, and the runtime populates its agent map before it announces
 * Connected.
 */
const RunErrorDemo: React.FC = () => {
  const { copilotkit } = useCopilotKit();

  if (!copilotkit.agents?.[AGENT_ID]) {
    return (
      <div
        data-testid="run-error-connecting"
        className="m-auto text-sm text-gray-500 dark:text-gray-400"
      >
        Connecting to the runtime...
      </div>
    );
  }

  return (
    <>
      <RunErrorBanner />
      <CopilotChat
        agentId={AGENT_ID}
        className="flex-1 min-h-0 rounded-2xl max-w-6xl mx-auto w-full"
      />
    </>
  );
};

const ErrorFlowPage: React.FC<ErrorFlowProps> = ({ params }) => {
  const { integrationId } = React.use(params);

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      agent={AGENT_ID}
    >
      <div className="flex justify-center items-center h-full w-full">
        <div className="flex flex-col h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
          <RunErrorDemo />
        </div>
      </div>
    </CopilotKit>
  );
};

export default ErrorFlowPage;
