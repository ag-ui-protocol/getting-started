"use client";
import React, { useState } from "react";
import "@copilotkit/react-core/v2/styles.css";
import {
  CopilotChat,
  useAgent,
  useCopilotKit,
  useConfigureSuggestions,
} from "@copilotkit/react-core/v2";
import { CopilotKit } from "@copilotkit/react-core";

interface ApprovalProps {
  params: Promise<{ integrationId: string }>;
}

interface PendingApproval {
  callId: string;
  toolName: string;
  arguments: string;
}

const Approval: React.FC<ApprovalProps> = ({ params }) => {
  const { integrationId } = React.use(params);

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      agent="human_in_the_loop_approval"
    >
      <Chat />
    </CopilotKit>
  );
};

const Chat = () => {
  const { agent } = useAgent({ agentId: "human_in_the_loop_approval" });
  const { copilotkit } = useCopilotKit();
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [resolvedCallId, setResolvedCallId] = useState<string | null>(null);

  useConfigureSuggestions({
    suggestions: [
      { title: "Refund an order", message: "I'd like a refund for ORD-1001." },
      { title: "Refund another order", message: "Please refund ORD-1002." },
      { title: "Unknown order", message: "Can you refund ORD-9999?" },
    ],
    available: "always",
    consumerAgentId: "human_in_the_loop_approval",
  });

  React.useEffect(() => {
    const subscription = agent.subscribe({
      onCustomEvent: ({ event }) => {
        if (event.name !== "approval_request") return;
        // One CustomEvent can carry several pending calls if the model made
        // more than one needs_approval call in a turn; this demo only ever
        // triggers one, so showing the first is enough here.
        const pendingList = event.value as Array<{
          call_id: string;
          tool_name: string;
          arguments: string;
        }>;
        const first = pendingList[0];
        if (!first) return;
        setResolvedCallId(null);
        setPending({
          callId: first.call_id,
          toolName: first.tool_name,
          arguments: first.arguments,
        });
      },
      onRunFinishedEvent: () => setResolvedCallId(null),
      onRunErrorEvent: () => setResolvedCallId(null),
    });
    return () => subscription.unsubscribe();
  }, [agent]);

  const respond = (approve: boolean) => {
    if (!pending) return;
    setResolvedCallId(pending.callId);
    copilotkit.runAgent({
      agent,
      forwardedProps: {
        approval: { call_id: pending.callId, approve },
      },
    });
    setPending(null);
  };

  return (
    <div className="flex flex-col justify-center items-center h-full w-full gap-4">
      {pending && (
        <ApprovalCard
          pending={pending}
          onApprove={() => respond(true)}
          onReject={() => respond(false)}
        />
      )}
      {!pending && resolvedCallId && (
        <div className="text-sm text-muted-foreground">
          Decision sent — waiting for the agent...
        </div>
      )}
      <div className="h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
        <CopilotChat
          agentId="human_in_the_loop_approval"
          className="h-full rounded-2xl max-w-6xl mx-auto"
        />
      </div>
    </div>
  );
};

function ApprovalCard({
  pending,
  onApprove,
  onReject,
}: {
  pending: PendingApproval;
  onApprove: () => void;
  onReject: () => void;
}) {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(pending.arguments);
  } catch {
    // leave args empty — raw string shown below is enough context either way
  }

  return (
    <div
      data-testid="approval-card"
      className="rounded-xl w-[500px] p-6 shadow-lg border border-gray-200/80 bg-white dark:border-white/15 dark:bg-gray-900"
    >
      <h2 className="text-lg font-bold mb-2">Approval needed</h2>
      <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
        The agent wants to call{" "}
        <code className="font-mono">{pending.toolName}</code> with:
      </p>
      <pre className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 text-xs mb-4 overflow-x-auto">
        {JSON.stringify(args, null, 2)}
      </pre>
      <div className="flex justify-center gap-4">
        <button
          type="button"
          data-testid="reject-button"
          onClick={onReject}
          className="px-6 py-2 rounded-lg font-semibold bg-gray-100 hover:bg-gray-200 text-gray-800 border border-gray-300 dark:bg-gray-800 dark:hover:bg-gray-700 dark:text-gray-100 dark:border-gray-600"
        >
          Reject
        </button>
        <button
          type="button"
          data-testid="approve-button"
          onClick={onApprove}
          className="px-6 py-2 rounded-lg font-semibold bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 text-white"
        >
          Approve
        </button>
      </div>
    </div>
  );
}

export default Approval;
