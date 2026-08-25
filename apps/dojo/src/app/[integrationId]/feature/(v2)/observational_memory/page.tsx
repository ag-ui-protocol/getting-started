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
// "mastra-observational-memory" activity (see
// MASTRA_OBSERVATIONAL_MEMORY_ACTIVITY_TYPE in @ag-ui/mastra). The bridge builds
// the object up incrementally via a snapshot + JSON-patch deltas, so every
// field beyond the identifiers is optional at render time.
const omContentSchema = z
  .object({
    cycleId: z.string(),
    operationType: z.enum(["observation", "reflection"]).optional(),
    phase: z.enum(["observation", "buffering", "activation"]).optional(),
    status: z.enum(["running", "completed", "failed", "activated"]).optional(),
    threadId: z.string().optional(),
    recordId: z.string().optional(),
    observations: z.string().optional(),
    currentTask: z.string().optional(),
    suggestedResponse: z.string().optional(),
    tokensToObserve: z.number().optional(),
    tokensToBuffer: z.number().optional(),
    tokensObserved: z.number().optional(),
    tokensBuffered: z.number().optional(),
    bufferedTokens: z.number().optional(),
    observationTokens: z.number().optional(),
    tokensActivated: z.number().optional(),
    chunksActivated: z.number().optional(),
    messagesActivated: z.number().optional(),
    generationCount: z.number().optional(),
    triggeredBy: z.enum(["threshold", "ttl", "provider_change"]).optional(),
    durationMs: z.number().optional(),
    startedAt: z.string().optional(),
    completedAt: z.string().optional(),
    error: z.string().optional(),
  })
  .passthrough();

type OmContent = z.infer<typeof omContentSchema>;

const STATUS_STYLES: Record<
  string,
  { dot: string; text: string; label: string }
> = {
  running: { dot: "bg-amber-400", text: "text-amber-700", label: "Working" },
  completed: {
    dot: "bg-emerald-500",
    text: "text-emerald-700",
    label: "Completed",
  },
  activated: {
    dot: "bg-indigo-500",
    text: "text-indigo-700",
    label: "Activated",
  },
  failed: { dot: "bg-rose-500", text: "text-rose-700", label: "Failed" },
};

const PHASE_LABELS: Record<string, string> = {
  observation: "Observing",
  buffering: "Buffering",
  activation: "Activating",
};

function tokens(n?: number): string | null {
  if (typeof n !== "number") return null;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function ObservationalMemoryCard({ content }: { content: OmContent }) {
  const status = content.status ?? "running";
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.running;
  const isActive = status === "running";
  const phaseLabel = content.phase ? PHASE_LABELS[content.phase] : "Memory";
  const op = content.operationType ?? "observation";

  const observedTokens = content.tokensObserved ?? content.tokensToObserve;
  const resultTokens =
    content.observationTokens ?? content.bufferedTokens ?? undefined;
  const compression =
    typeof observedTokens === "number" &&
    typeof resultTokens === "number" &&
    observedTokens > 0
      ? Math.max(0, 1 - resultTokens / observedTokens)
      : undefined;

  return (
    <div
      data-testid="om-activity-card"
      data-phase={content.phase}
      data-status={status}
      className="my-2 rounded-xl border border-slate-200 bg-gradient-to-br from-indigo-50/60 to-white p-4 shadow-sm max-w-xl"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Observational Memory
          </span>
          <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-mono text-slate-600">
            {phaseLabel} · {op}
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
            data-testid="om-activity-status"
          >
            {style.label}
          </span>
        </div>
      </div>

      {content.observations ? (
        <p
          className="mt-2 text-sm text-slate-700"
          data-testid="om-activity-observations"
        >
          {content.observations}
        </p>
      ) : null}

      {content.currentTask ? (
        <p className="mt-2 text-xs text-slate-500">
          <span className="text-slate-400">Task:</span> {content.currentTask}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
        {tokens(observedTokens) ? (
          <span data-testid="om-activity-observed-tokens">
            Observed {tokens(observedTokens)} tok
          </span>
        ) : null}
        {tokens(resultTokens) ? (
          <span>→ {tokens(resultTokens)} tok</span>
        ) : null}
        {typeof compression === "number" ? (
          <span className="font-medium text-indigo-500">
            {(compression * 100).toFixed(0)}% compressed
          </span>
        ) : null}
        {typeof content.messagesActivated === "number" ? (
          <span>{content.messagesActivated} msgs activated</span>
        ) : null}
        {typeof content.durationMs === "number" ? (
          <span>{(content.durationMs / 1000).toFixed(1)}s</span>
        ) : null}
      </div>

      {isActive ? (
        <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-slate-100">
          <div className="h-full w-1/3 animate-[shimmer_1.2s_infinite] rounded-full bg-indigo-300" />
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

const omRenderer = {
  activityType: "mastra-observational-memory",
  content: omContentSchema,
  render: ({ content }: { content: OmContent }) => (
    <ObservationalMemoryCard content={content} />
  ),
};

function Chat() {
  useConfigureSuggestions({
    suggestions: [
      {
        title: "Plan a trip",
        message:
          "I'm planning a two-week trip through Japan in spring. I love food, temples, and trains, and I want to avoid big crowds. Where should I go?",
      },
      {
        title: "Keep chatting",
        message:
          "Tell me more about the food scene there, and remember that I'm vegetarian and don't drink alcohol.",
      },
    ],
    available: "always",
  });

  return (
    <CopilotChat
      agentId="observational_memory"
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
      agent="observational_memory"
      renderActivityMessages={[omRenderer]}
    >
      <div className="flex justify-center items-center h-full w-full">
        <div className="h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
          <Chat />
        </div>
      </div>
    </CopilotKit>
  );
}
