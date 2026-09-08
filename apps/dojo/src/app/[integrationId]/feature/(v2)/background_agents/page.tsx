"use client";
import React from "react";
import "@copilotkit/react-core/v2/styles.css";
import {
  CopilotChat,
  useConfigureSuggestions,
} from "@copilotkit/react-core/v2";
import { CopilotKit } from "@copilotkit/react-core";
import { z } from "zod";

export const dynamic = "force-dynamic";

// Mirrors the `content` shape the AG-UI Mastra bridge emits for the
// "mastra-background-task" activity (see MASTRA_BACKGROUND_TASK_ACTIVITY_TYPE
// in @ag-ui/mastra). The bridge builds the object up incrementally via a
// snapshot + JSON-patch deltas, so every field beyond the identifiers is
// optional at render time.
const backgroundTaskContentSchema = z
  .object({
    taskId: z.string(),
    toolName: z.string().optional(),
    toolCallId: z.string().optional(),
    status: z
      .enum([
        "started",
        "running",
        "suspended",
        "resumed",
        "completed",
        "failed",
        "cancelled",
      ])
      .optional(),
    args: z.record(z.any()).optional(),
    outputs: z.array(z.any()).optional(),
    elapsedMs: z.number().optional(),
    result: z.any().optional(),
    error: z.string().optional(),
    startedAt: z.string().optional(),
    completedAt: z.string().optional(),
  })
  .passthrough();

type BackgroundTaskContent = z.infer<typeof backgroundTaskContentSchema>;

const STATUS_STYLES: Record<
  string,
  { dot: string; text: string; label: string }
> = {
  started: { dot: "bg-sky-400", text: "text-sky-700", label: "Queued" },
  running: { dot: "bg-amber-400", text: "text-amber-700", label: "Running" },
  resumed: { dot: "bg-amber-400", text: "text-amber-700", label: "Running" },
  suspended: {
    dot: "bg-violet-400",
    text: "text-violet-700",
    label: "Suspended",
  },
  completed: {
    dot: "bg-emerald-500",
    text: "text-emerald-700",
    label: "Completed",
  },
  failed: { dot: "bg-rose-500", text: "text-rose-700", label: "Failed" },
  cancelled: { dot: "bg-zinc-400", text: "text-zinc-600", label: "Cancelled" },
};

const ACTIVE = new Set(["started", "running", "resumed", "suspended"]);

function BackgroundTaskCard({ content }: { content: BackgroundTaskContent }) {
  const status = content.status ?? "started";
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.started;
  const isActive = ACTIVE.has(status);
  const result = content.result as
    | { topic?: string; summary?: string; sources?: number }
    | undefined;

  return (
    <div
      data-testid="background-task-card"
      data-status={status}
      className="my-2 rounded-xl border border-slate-200 bg-gradient-to-br from-slate-50 to-white p-4 shadow-sm max-w-xl"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Background Task
          </span>
          <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-mono text-slate-600">
            {content.toolName ?? "task"}
          </code>
        </div>
        <div className={`flex items-center gap-1.5 ${style.text}`}>
          <span
            className={`h-2 w-2 rounded-full ${style.dot} ${
              isActive ? "animate-pulse" : ""
            }`}
          />
          <span
            className="text-xs font-semibold"
            data-testid="background-task-status"
          >
            {style.label}
          </span>
        </div>
      </div>

      {content.args?.topic ? (
        <p className="mt-2 text-sm text-slate-700">
          <span className="text-slate-400">Topic:</span>{" "}
          <span className="font-medium">{String(content.args.topic)}</span>
        </p>
      ) : null}

      {typeof content.elapsedMs === "number" ? (
        <p
          className="mt-1 text-xs text-slate-400"
          data-testid="background-task-elapsed"
        >
          Elapsed {(content.elapsedMs / 1000).toFixed(1)}s
        </p>
      ) : null}

      {isActive ? (
        <>
          <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-slate-100">
            <div className="h-full w-1/3 animate-[shimmer_1.2s_infinite] rounded-full bg-amber-300" />
          </div>
          <p className="mt-2 text-xs text-slate-400">
            Dispatched to the background — the agent keeps responding while this
            runs. Completion is delivered out of band on a later turn.
          </p>
        </>
      ) : null}

      {status === "completed" && result ? (
        <div
          className="mt-3 rounded-lg border border-emerald-100 bg-emerald-50/60 p-3"
          data-testid="background-task-result"
        >
          <p className="text-sm text-emerald-900">{result.summary}</p>
          {typeof result.sources === "number" ? (
            <p className="mt-1 text-xs text-emerald-600">
              {result.sources} sources reviewed
            </p>
          ) : null}
        </div>
      ) : null}

      {status === "failed" && content.error ? (
        <p className="mt-3 rounded-lg border border-rose-100 bg-rose-50 p-3 text-sm text-rose-800">
          {content.error}
        </p>
      ) : null}

      <style>{`@keyframes shimmer { 0% { transform: translateX(-120%);} 100% { transform: translateX(320%);} }`}</style>
    </div>
  );
}

const backgroundTaskRenderer = {
  activityType: "mastra-background-task",
  content: backgroundTaskContentSchema,
  render: ({ content }: { content: BackgroundTaskContent }) => (
    <BackgroundTaskCard content={content} />
  ),
};

function Chat() {
  useConfigureSuggestions({
    suggestions: [
      {
        title: "Research Solana",
        message: "Research the Solana ecosystem for me.",
      },
      {
        title: "Investigate RAG",
        message:
          "Investigate best practices for retrieval-augmented generation.",
      },
    ],
    available: "always",
  });

  return (
    <CopilotChat
      agentId="background_agents"
      className="h-full rounded-2xl max-w-6xl mx-auto"
    />
  );
}

interface PageProps {
  params: Promise<{ integrationId: string }>;
}

export default function Page({ params }: PageProps) {
  const { integrationId } = React.use(params);

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      agent="background_agents"
      renderActivityMessages={[backgroundTaskRenderer]}
    >
      <div className="flex justify-center items-center h-full w-full">
        <div className="h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
          <Chat />
        </div>
      </div>
    </CopilotKit>
  );
}
