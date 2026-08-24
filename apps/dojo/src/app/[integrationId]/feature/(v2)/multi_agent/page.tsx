"use client";
import React from "react";
import "@copilotkit/react-core/v2/styles.css";
import {
  CopilotChat,
  useAgent,
  useCopilotKit,
} from "@copilotkit/react-core/v2";
import { CopilotKit } from "@copilotkit/react-core";

interface MultiAgentProps {
  params: Promise<{
    integrationId: string;
  }>;
}

const AGENT_ID = "multi_agent";

/**
 * Node ids match the orchestrator graph in both example servers
 * (`multi_agent.py` / `multi-agent.ts`). The adapter reports steps as
 * `<nodeType>:<nodeId>`, so only the id half is compared here.
 */
const NODES = [
  { id: "researcher", label: "Researcher", role: "Gathers the facts" },
  { id: "analyst", label: "Analyst", role: "Draws out what they imply" },
  { id: "writer", label: "Writer", role: "Writes the final answer" },
] as const;

type NodeStatus = "pending" | "active" | "done" | "failed" | "paused";

interface Handoff {
  from: string[];
  to: string[];
  message?: string;
}

function asStringArray(value: unknown): string[] {
  // Payloads arrive off the wire, so a malformed one must not throw inside the
  // event subscriber and take the rest of the run's updates with it.
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

interface Notice {
  kind: "cancel" | "interrupt" | "status";
  nodeId: string;
  detail: string;
}

function nodeIdFromStepName(stepName: string): string {
  // Step names are "<nodeType>:<nodeId>"; the type prefix never contains a
  // colon, so the first one separates the two halves.
  const separator = stepName.indexOf(":");
  return separator === -1 ? stepName : stepName.slice(separator + 1);
}

const STATUS_STYLES: Record<NodeStatus, string> = {
  pending:
    "border-gray-200 bg-white text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400",
  active:
    "border-blue-500 bg-blue-50 text-blue-900 shadow-sm dark:border-blue-400 dark:bg-blue-950 dark:text-blue-100",
  done: "border-green-500 bg-green-50 text-green-900 dark:border-green-500 dark:bg-green-950 dark:text-green-100",
  failed:
    "border-red-500 bg-red-50 text-red-900 dark:border-red-500 dark:bg-red-950 dark:text-red-100",
  paused:
    "border-amber-500 bg-amber-50 text-amber-900 dark:border-amber-500 dark:bg-amber-950 dark:text-amber-100",
};

const STATUS_LABEL: Record<NodeStatus, string> = {
  pending: "Waiting",
  active: "Running",
  done: "Done",
  failed: "Failed",
  paused: "Paused",
};

const Pipeline: React.FC = () => {
  // The pipeline renders from its own state, so it opts out of the hook's
  // re-render subscription and listens to the event stream directly.
  const { agent } = useAgent({ agentId: AGENT_ID, updates: [] });
  const [statuses, setStatuses] = React.useState<Record<string, NodeStatus>>(
    {},
  );
  const [handoffs, setHandoffs] = React.useState<Handoff[]>([]);
  const [notices, setNotices] = React.useState<Notice[]>([]);
  const [runError, setRunError] = React.useState<string | null>(null);
  // Outcomes the run reported for a node. STEP_FINISHED fires for these too,
  // so without this a failed or paused node would settle on a green "Done".
  const outcomes = React.useRef<Map<string, "failed" | "paused">>(new Map());

  React.useEffect(() => {
    // An interrupt is a pause awaiting a human, not a failure, so it settles
    // on its own status rather than being painted red.
    const markOutcome = (nodeId: string, status: "failed" | "paused") => {
      outcomes.current.set(nodeId, status);
      setStatuses((prev) => ({ ...prev, [nodeId]: status }));
    };

    const subscription = agent.subscribe({
      // Every run starts clean so the pipeline always describes the current one.
      onRunStartedEvent: () => {
        outcomes.current.clear();
        setStatuses({});
        setHandoffs([]);
        setNotices([]);
        setRunError(null);
      },
      // Without this a failed run leaves the reason invisible. Node state is
      // not swept here: an adapter that closes its steps before reporting the
      // error has already settled them, so the per-node signal below is what
      // decides Done versus Failed. Any node still running is marked failed
      // for the adapters that leave their steps open.
      onRunErrorEvent: ({ event }) => {
        setRunError(event.message || "The run failed.");
        setStatuses((prev) => {
          const next = { ...prev };
          for (const [nodeId, status] of Object.entries(next)) {
            if (status === "active") next[nodeId] = "failed";
          }
          return next;
        });
      },
      onStepStartedEvent: ({ event }) => {
        const nodeId = nodeIdFromStepName(event.stepName);
        // A node re-entered in the same run (a Swarm hand-back) starts clean,
        // or an earlier failure would force its next success to Failed.
        outcomes.current.delete(nodeId);
        setStatuses((prev) => ({ ...prev, [nodeId]: "active" }));
      },
      onStepFinishedEvent: ({ event }) => {
        const nodeId = nodeIdFromStepName(event.stepName);
        setStatuses((prev) => ({
          ...prev,
          [nodeId]: outcomes.current.get(nodeId) ?? "done",
        }));
      },
      onCustomEvent: ({ event }) => {
        const value = (event.value ?? {}) as Record<string, unknown>;
        if (event.name === "MultiAgentHandoff") {
          setHandoffs((prev) => [
            ...prev,
            {
              from: asStringArray(value.from_nodes),
              to: asStringArray(value.to_nodes),
              message:
                typeof value.message === "string" ? value.message : undefined,
            },
          ]);
          return;
        }
        // Cancel, interrupt and a non-completed node status have no
        // first-class protocol event, so the adapter forwards them as CUSTOM.
        // Surfacing them here is what keeps an interrupted, cancelled or
        // failed node from being silent.
        if (event.name === "MultiAgentNodeCancel") {
          const nodeId = String(value.node_id ?? "unknown");
          markOutcome(nodeId, "failed");
          setNotices((prev) => [
            ...prev,
            {
              kind: "cancel",
              nodeId,
              detail: String(value.message ?? "cancelled"),
            },
          ]);
          return;
        }
        if (event.name === "MultiAgentNodeInterrupt") {
          const nodeId = String(value.node_id ?? "unknown");
          markOutcome(nodeId, "paused");
          const interrupts = Array.isArray(value.interrupts)
            ? (value.interrupts as Array<{ name?: string }>)
            : [];
          setNotices((prev) => [
            ...prev,
            {
              kind: "interrupt",
              nodeId,
              detail:
                interrupts.map((i) => i?.name ?? "interrupt").join(", ") ||
                "interrupt",
            },
          ]);
          return;
        }
        if (event.name === "MultiAgentNodeStatus") {
          const nodeId = String(value.node_id ?? "unknown");
          markOutcome(nodeId, "failed");
          setNotices((prev) => [
            ...prev,
            {
              kind: "status",
              nodeId,
              detail: String(value.status ?? "not completed"),
            },
          ]);
        }
      },
    });
    return () => subscription.unsubscribe();
  }, [agent]);

  return (
    <div className="mb-4 space-y-3">
      {runError ? (
        <div
          data-testid="multi-agent-run-error"
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-700 dark:bg-red-950 dark:text-red-200"
        >
          <div className="font-semibold">Run failed</div>
          <div data-testid="multi-agent-run-error-message">{runError}</div>
        </div>
      ) : null}

      <div
        data-testid="multi-agent-pipeline"
        className="grid grid-cols-1 gap-3 sm:grid-cols-3"
      >
        {NODES.map((node) => {
          const status = statuses[node.id] ?? "pending";
          return (
            <div
              key={node.id}
              data-testid={`multi-agent-node-${node.id}`}
              data-status={status}
              className={`rounded-xl border p-3 transition-colors ${STATUS_STYLES[status]}`}
            >
              <div className="text-sm font-semibold">{node.label}</div>
              <div className="text-xs opacity-80">{node.role}</div>
              <div
                data-testid={`multi-agent-node-${node.id}-status`}
                className="mt-2 text-xs font-mono uppercase tracking-wide"
              >
                {STATUS_LABEL[status]}
              </div>
            </div>
          );
        })}
      </div>

      <div data-testid="multi-agent-handoffs" className="space-y-1">
        {handoffs.map((handoff, index) => (
          <div
            key={index}
            data-testid="multi-agent-handoff"
            // The route is published as data attributes as well as text: any
            // reader that needs the endpoints gets them without parsing prose,
            // which a node id or handoff message could otherwise corrupt.
            data-handoff-from={handoff.from.join(",")}
            data-handoff-to={handoff.to.join(",")}
            className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"
          >
            <span className="font-mono">{handoff.from.join(", ") || "-"}</span>
            <span className="mx-2">{" to "}</span>
            <span className="font-mono">{handoff.to.join(", ") || "-"}</span>
            {handoff.message ? (
              <span className="ml-2 opacity-80">{handoff.message}</span>
            ) : null}
          </div>
        ))}
      </div>

      {notices.length > 0 ? (
        <div className="space-y-1">
          {notices.map((notice, index) => (
            <div
              key={index}
              data-testid="multi-agent-notice"
              data-notice-kind={notice.kind}
              role="status"
              className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
            >
              <span className="font-mono">{notice.nodeId}</span>
              <span className="mx-2">{notice.kind}</span>
              <span className="opacity-80">{notice.detail}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};

/**
 * Both the pipeline and `CopilotChat` call `useAgent`, which hands out a
 * per-hook provisional agent until the runtime registers the real one.
 * Mounting them before that leaves them subscribed to different agent objects,
 * so node events from the chat's run would never reach the pipeline.
 */
const MultiAgentDemo: React.FC = () => {
  const { copilotkit } = useCopilotKit();

  if (!copilotkit.agents?.[AGENT_ID]) {
    return (
      <div
        data-testid="multi-agent-connecting"
        className="m-auto text-sm text-gray-500 dark:text-gray-400"
      >
        Connecting to the runtime...
      </div>
    );
  }

  return (
    <>
      <Pipeline />
      <CopilotChat
        agentId={AGENT_ID}
        className="flex-1 min-h-0 rounded-2xl max-w-6xl mx-auto w-full"
      />
    </>
  );
};

const MultiAgentPage: React.FC<MultiAgentProps> = ({ params }) => {
  const { integrationId } = React.use(params);

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      agent={AGENT_ID}
    >
      <div className="flex justify-center items-center h-full w-full">
        <div className="flex flex-col h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
          <MultiAgentDemo />
        </div>
      </div>
    </CopilotKit>
  );
};

export default MultiAgentPage;
