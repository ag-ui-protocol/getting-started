"use client";
import React, { useCallback, useEffect, useState } from "react";
import "@copilotkit/react-core/v2/styles.css";
import { CopilotChat, useConfigureSuggestions, useRenderTool } from "@copilotkit/react-core/v2";
import { CopilotKit } from "@copilotkit/react-core";
import { Badge } from "@/components/ui/badge";
import { z } from "zod";

interface SubagentsProps {
  params: Promise<{
    integrationId: string;
  }>;
}

type Role = "research" | "writer" | "critic";
type Status = "inProgress" | "executing" | "complete";

const ROLES: { role: Role; label: string; emoji: string }[] = [
  { role: "research", label: "Researcher", emoji: "🔎" },
  { role: "writer", label: "Writer", emoji: "✍️" },
  { role: "critic", label: "Critic", emoji: "🧐" },
];

interface DelegationEntry {
  id: string;
  role: Role;
  status: Status;
  text: string;
}

const Subagents: React.FC<SubagentsProps> = ({ params }) => {
  const { integrationId } = React.use(params);

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      agent="subagents"
    >
      <SubagentsView />
    </CopilotKit>
  );
};

const SubagentsView = () => {
  const [active, setActive] = useState<Record<Role, Status | null>>({
    research: null,
    writer: null,
    critic: null,
  });
  const [log, setLog] = useState<DelegationEntry[]>([]);

  // Called by each DelegationTracker instance as its tool call's status
  // changes. Same shared state feeds both the role chips (who's working
  // right now) and the log (what happened, in order).
  const track = useCallback((entry: DelegationEntry) => {
    setActive((prev) => ({
      ...prev,
      [entry.role]: entry.status === "complete" ? null : entry.status,
    }));
    setLog((prev) => {
      const idx = prev.findIndex((e) => e.id === entry.id);
      if (idx === -1) return [...prev, entry];
      const next = [...prev];
      next[idx] = entry;
      return next;
    });
  }, []);

  useConfigureSuggestions({
    suggestions: [
      {
        title: "History of AI",
        message: "Write a short article about the history of AI",
      },
      {
        title: "History of programming languages",
        message: "Write a short piece about the history of programming languages",
      },
    ],
    available: "always",
    consumerAgentId: "subagents",
  });

  useRenderTool({
    name: "research_topic",
    agentId: "subagents",
    parameters: z.object({ input: z.string().optional() }),
    render: ({ toolCallId, status, args, result }: any) => (
      <DelegationTracker
        role="research"
        toolCallId={toolCallId}
        status={status}
        preview={args?.input}
        result={result}
        onUpdate={track}
      />
    ),
  });

  useRenderTool({
    name: "write_prose",
    agentId: "subagents",
    parameters: z.object({ input: z.string().optional() }),
    render: ({ toolCallId, status, args, result }: any) => (
      <DelegationTracker
        role="writer"
        toolCallId={toolCallId}
        status={status}
        preview={args?.input}
        result={result}
        onUpdate={track}
      />
    ),
  });

  useRenderTool({
    name: "critique_draft",
    agentId: "subagents",
    parameters: z.object({ input: z.string().optional() }),
    render: ({ toolCallId, status, args, result }: any) => (
      <DelegationTracker
        role="critic"
        toolCallId={toolCallId}
        status={status}
        preview={args?.input}
        result={result}
        onUpdate={track}
      />
    ),
  });

  return (
    <div className="flex h-full w-full">
      <div className="hidden md:flex w-72 shrink-0 flex-col border-r border-black/10 dark:border-white/10 p-4 overflow-y-auto">
        <h3 className="text-sm font-semibold mb-3">Supervisor&apos;s team</h3>
        <div className="flex flex-col gap-2 mb-6">
          {ROLES.map(({ role, label, emoji }) => {
            const status = active[role];
            return (
              <div
                key={role}
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
                  status
                    ? "border-blue-400 bg-blue-50 dark:bg-blue-950/40"
                    : "border-black/10 dark:border-white/10"
                }`}
              >
                <span>{emoji}</span>
                <span className="flex-1">{label}</span>
                {status && (
                  <Badge variant="secondary" className="animate-pulse">
                    {status === "executing" ? "working" : "starting"}
                  </Badge>
                )}
              </div>
            );
          })}
        </div>

        <h4 className="text-xs font-semibold text-black/50 dark:text-white/50 mb-2">
          Delegation log
        </h4>
        <div className="flex flex-col gap-2">
          {log.length === 0 && (
            <div className="text-xs text-black/40 dark:text-white/40">No delegations yet.</div>
          )}
          {log.map((entry) => {
            const roleInfo = ROLES.find((r) => r.role === entry.role);
            return (
              <div
                key={entry.id}
                className="rounded-md border border-black/10 dark:border-white/10 p-2 text-xs"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">
                    {roleInfo?.emoji} {roleInfo?.label}
                  </span>
                  <Badge variant={entry.status === "complete" ? "outline" : "secondary"}>
                    {entry.status}
                  </Badge>
                </div>
                {entry.text && (
                  <div className="mt-1 line-clamp-3 text-black/70 dark:text-white/70">
                    {entry.text}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex-1 flex justify-center items-center h-full w-full">
        <div className="h-full w-full md:w-9/10 md:h-8/10 rounded-lg">
          <CopilotChat agentId="subagents" className="h-full rounded-2xl max-w-4xl mx-auto" />
        </div>
      </div>
    </div>
  );
};

// Each tool call renders its own instance of this. `render` is invoked as a
// real component (not a plain function), so effects are legal here — this
// is what reports status upstream into the shared chip/log state on every
// inProgress → executing → complete transition, in addition to rendering
// its own inline card in the chat transcript.
function DelegationTracker({
  role,
  toolCallId,
  status,
  preview,
  result,
  onUpdate,
}: {
  role: Role;
  toolCallId: string;
  status: Status;
  preview?: string;
  result?: string;
  onUpdate: (entry: DelegationEntry) => void;
}) {
  const text = status === "complete" ? (result ?? "") : (preview ?? "");

  useEffect(() => {
    onUpdate({ id: toolCallId, role, status, text });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolCallId, role, status, text]);

  const roleInfo = ROLES.find((r) => r.role === role)!;
  const label =
    status === "complete"
      ? `${roleInfo.label} finished`
      : status === "executing"
        ? `${roleInfo.label} working…`
        : `Calling ${roleInfo.label.toLowerCase()}…`;

  return (
    <div className="text-xs text-black/60 dark:text-white/60 italic">
      {roleInfo.emoji} {label}
    </div>
  );
}

export default Subagents;
