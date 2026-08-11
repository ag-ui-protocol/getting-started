"use client";
import React from "react";
import "@copilotkit/react-core/v2/styles.css";
import "./style.css";
import {
  useAgent,
  UseAgentUpdate,
  useConfigureSuggestions,
  useInterrupt,
  useSubagent,
  CopilotChat,
  CopilotChatConfigurationProvider,
  CopilotChatAssistantMessage,
  CopilotKitProvider,
} from "@copilotkit/react-core/v2";

const AGENT_ID = "deepagents_subagents";

interface DeepagentsSubagentsProps {
  params: Promise<{
    integrationId: string;
  }>;
}

// `subagentRunId` is an AG-UI message field (see @ag-ui/core) stamped by the
// integration on messages a subagent produced. It isn't part of the CopilotKit
// AssistantMessage type surface yet, so read it off the message via a cast.
function getSubagentRunId(message: unknown): string | undefined {
  return (message as { subagentRunId?: string } | null | undefined)?.subagentRunId;
}

type AssistantMessageProps = React.ComponentProps<
  typeof CopilotChatAssistantMessage
>;
type ChatMessage = NonNullable<AssistantMessageProps["messages"]>[number];

// Join truthy class-name parts (tiny local stand-in for clsx/twMerge; we own
// all the classes here so there are no conflicts to dedupe).
function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

// Standalone collapsible header for a subagent group. This reproduces the look
// of CopilotKit's reasoning-message header — muted text, hover affordance, and
// a chevron that rotates when open — but is owned by this demo rather than
// reusing CopilotChatReasoningMessage.Header. Styling uses the cpk: utility
// classes from the already-imported CopilotKit stylesheet so it matches the
// surrounding chat; the chevron is an inline SVG (no lucide dependency).
function SubagentGroupHeader({
  isOpen,
  label,
  labelStyle,
  onClick,
  title,
  children,
}: {
  isOpen: boolean;
  label: string;
  // Inline style rather than a class: the cpk: utilities come from CopilotKit's
  // PREBUILT stylesheet (the dojo's Tailwind build does not emit that prefix),
  // and it ships no cpk:opacity-* utilities — a class-based dim would silently
  // do nothing.
  labelStyle?: React.CSSProperties;
  onClick: () => void;
  title?: string;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-expanded={isOpen}
      data-testid="subagent-tag"
      className={cx(
        "cpk:inline-flex cpk:items-center cpk:gap-1 cpk:py-1 cpk:text-sm",
        "cpk:text-muted-foreground cpk:transition-colors cpk:select-none",
        "cpk:hover:text-foreground cpk:cursor-pointer",
      )}
    >
      <span className="cpk:font-medium" style={labelStyle}>
        {label}
      </span>
      {children}
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        style={{
          flexShrink: 0,
          transform: isOpen ? "rotate(90deg)" : "rotate(0deg)",
          transition: "transform 200ms",
        }}
      >
        <path d="m9 18 6-6-6-6" />
      </svg>
    </button>
  );
}

// Whether each subagent group is expanded, keyed by `subagentRunId` and held at
// MODULE scope on purpose. The custom-message host memoizes on the group's
// anchor message, so when a snapshot reordering makes a different message the
// subagent's first attributed one, the SubagentGroup remounts — component state
// would silently collapse a group the user just expanded. Keyed by the id, the
// expansion survives that remount. Ids are per-invocation, so entries are never
// reused across subagents; the map is small and lives for the page's lifetime.
const subagentGroupOpen: Record<string, boolean> = {};

// One collapsible group for a SINGLE subagent, rendered in the reasoning style
// via the standalone SubagentGroupHeader (above) plus a custom collapse
// container (below). Collapsed until the user expands it (expansion is
// remembered per subagentRunId — see subagentGroupOpen). A subtle activity dot
// shows while THIS subagent is running — its own lifecycle, read from
// `useSubagent`, which the registry flips to "finished" on the
// SUBAGENT_FINISHED the integration emits when the subagent's `task` delegation
// returns (not when the parent run ends). The body gathers every message
// carrying this subagentRunId from the live agent state, so when several subagents
// run each gets its own independent header/body.
function SubagentGroup({
  subagentRunId,
  agentId,
}: {
  subagentRunId: string;
  agentId: string;
}) {
  // CopilotKit's registry supplies `name`/`description`; it keys subagents by
  // the same per-invocation id the protocol carries. Both sides use
  // `subagentRunId` as of CopilotKit PR #5873, so this is plain shorthand — if
  // it ever needs an explicit mapping again, the two names have diverged.
  const subagent = useSubagent({ subagentRunId, agentId });
  // Live subscription so the group re-renders as the subagent streams more
  // messages/tool calls. The custom-message host memoizes on the anchor
  // message, so without a store subscription of its own the body would freeze
  // at first render.
  const { agent } = useAgent({
    agentId,
    updates: [UseAgentUpdate.OnMessagesChanged],
  });
  const members = React.useMemo(() => {
    // Dedupe by message id: unlike the main list (which runs CopilotKit's
    // deduplicateMessages) this filters raw `agent.messages`, where a repeated
    // id would render the same message twice under duplicate React keys.
    const seen = new Set<string>();
    return (agent.messages as ChatMessage[]).filter((m) => {
      if (m.role !== "assistant" || getSubagentRunId(m) !== subagentRunId) {
        return false;
      }
      if (seen.has(m.id)) {
        return false;
      }
      seen.add(m.id);
      return true;
    });
  }, [agent.messages, subagentRunId]);
  // Three registry-backed states (running / finished / error) plus a fourth:
  // `undefined` means the registry has never heard of this id. That is NOT
  // "running" — the protocol allows attribution with no lifecycle events at
  // all, and prior-turn messages replayed through MESSAGES_SNAPSHOT arrive
  // without their SUBAGENT_STARTED. Render those neutrally (hollow marker,
  // dimmed label) instead of a forever-pulsing dot.
  const isUnregistered = subagent === undefined;
  const running = subagent?.status === "running";
  // Open/closed lives in the module-level registry (see subagentGroupOpen), so
  // reading it into state here just seeds the first render.
  const [isOpen, setIsOpen] = React.useState(
    () => subagentGroupOpen[subagentRunId] ?? false,
  );
  const toggleOpen = React.useCallback(() => {
    setIsOpen((open) => {
      const next = !open;
      subagentGroupOpen[subagentRunId] = next; // write through so a remount keeps it
      return next;
    });
  }, [subagentRunId]);
  const label = subagent?.name ?? subagentRunId; // name, falling back to the id

  return (
    <div className="cpk:my-1" data-testid="subagent-group">
      <SubagentGroupHeader
        isOpen={isOpen}
        label={label}
        labelStyle={isUnregistered ? { opacity: 0.6 } : undefined}
        onClick={toggleOpen}
        title={
          subagent?.description ??
          (isUnregistered
            ? `Subagent ${subagentRunId} (no lifecycle events received)`
            : `Subagent ${subagentRunId}`)
        }
      >
        {isUnregistered ? (
          // Unregistered: a hollow marker, deliberately neither the pulsing
          // "running" dot nor the "finished" checkmark — we simply don't know.
          <span
            className="cpk:inline-flex cpk:items-center cpk:ml-1 cpk:text-muted-foreground"
            style={{ opacity: 0.6 }}
            data-testid="subagent-unregistered"
            aria-label="unregistered"
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: 9999,
                border: "1px solid currentColor",
              }}
            />
          </span>
        ) : running ? (
          <span
            className="cpk:inline-flex cpk:items-center cpk:ml-1"
            data-testid="subagent-activity"
          >
            <span className="cpk:w-1.5 cpk:h-1.5 cpk:rounded-full cpk:bg-muted-foreground cpk:animate-pulse" />
          </span>
        ) : subagent?.status === "error" ? (
          // A subtle error mark when the subagent failed — distinct from the
          // finished checkmark so a failed subagent doesn't read as successful.
          <span
            className="cpk:inline-flex cpk:items-center cpk:ml-1"
            data-testid="subagent-error"
            aria-label="error"
            title={subagent?.error ?? undefined}
            style={{ color: "#dc2626" }}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </span>
        ) : (
          // Subtle checkmark once this subagent has finished (matches the muted
          // reasoning styling; inline SVG so no icon dependency is pulled in).
          <span
            className="cpk:inline-flex cpk:items-center cpk:ml-1 cpk:text-muted-foreground"
            data-testid="subagent-done"
            aria-label="finished"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </span>
        )}
      </SubagentGroupHeader>
      {/*
        Same grid-rows collapse as CopilotChatReasoningMessage.Toggle, but the
        transition duration is 0 while closing so collapsing is immediate — the
        built-in Toggle animates both directions at 200ms, which makes closing
        feel laggy ("plays the animation, then closes"). Opening still animates.
      */}
      <div
        style={{
          display: "grid",
          gridTemplateRows: isOpen ? "1fr" : "0fr",
          transitionProperty: "grid-template-rows",
          transitionTimingFunction: "ease-in-out",
          transitionDuration: isOpen ? "200ms" : "0ms",
        }}
      >
        <div style={{ overflow: "hidden" }}>
          <div className="subagent-group-body">
            {members.map((m) => (
              <CopilotChatAssistantMessage
                key={m.id}
                message={m as AssistantMessageProps["message"]}
                messages={agent.messages as AssistantMessageProps["messages"]}
                isRunning={running}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// Custom-message renderer — CopilotKit's `renderCustomMessages` mechanism. For
// every message the chat asks this component whether to inject anything BEFORE
// or AFTER it in the list. We inject a SubagentGroup exactly once per subagent:
// before that subagent's FIRST message in the thread. So each subagent gets its
// own collapsible header wherever its work begins, and multiple subagents
// produce multiple independent groups. Every other case returns null (nothing
// injected). Placement is the injection point; the group itself gathers all of
// the subagent's messages (see SubagentGroup), so interleaved subagents still
// group cleanly.
function SubagentCustomMessage({
  message,
  position,
  agentId,
}: {
  message: ChatMessage;
  position: "before" | "after";
  agentId: string;
}) {
  const subagentRunId = getSubagentRunId(message);
  const { agent } = useAgent({
    agentId,
    updates: [UseAgentUpdate.OnMessagesChanged],
  });
  if (position !== "before" || !subagentRunId) {
    return null;
  }
  const firstId = (agent.messages as ChatMessage[]).find(
    (m) => getSubagentRunId(m) === subagentRunId,
  )?.id;
  if (firstId !== message.id) {
    return null; // only the subagent's first message anchors its group
  }
  return <SubagentGroup subagentRunId={subagentRunId} agentId={agentId} />;
}

const RENDER_CUSTOM_MESSAGES = [
  { agentId: AGENT_ID, render: SubagentCustomMessage },
] as React.ComponentProps<typeof CopilotKitProvider>["renderCustomMessages"];

// Wildcard tool-call renderer. CopilotKit v2 renders NOTHING for a tool call
// unless a per-tool or wildcard ("*") renderer is registered (unhandled tool
// calls are opt-in). The deepagents subagent calls generic tools (write_todos,
// grep, glob, write_file, task) with no bespoke UI, so register a catch-all that
// shows the tool name, its arguments, and result — this is what makes the
// subagent's tool-call cards appear inside its group.
function ToolCallCard({ name, args, status, result }: {
  name: string;
  args: unknown;
  status: string;
  result?: string;
}) {
  // `task` is the supervisor's delegation tool — the subagent group itself
  // represents that delegation, so don't render a redundant task card.
  if (name === "task") {
    return null;
  }
  const argsStr =
    args && Object.keys(args as object).length > 0
      ? JSON.stringify(args, null, 2)
      : "";
  return (
    <div className="subagent-toolcall" data-testid="subagent-toolcall">
      <div className="subagent-toolcall-head">
        <span className="subagent-toolcall-name">🛠 {name}</span>
        <span className="subagent-toolcall-status">{String(status)}</span>
      </div>
      {argsStr && <pre className="subagent-toolcall-body">{argsStr}</pre>}
      {result ? (
        <pre className="subagent-toolcall-body subagent-toolcall-result">
          {result.length > 600 ? result.slice(0, 600) + "…" : result}
        </pre>
      ) : null}
    </div>
  );
}

const TOOL_CALL_RENDERERS = [
  { name: "*", render: ToolCallCard },
] as React.ComponentProps<typeof CopilotKitProvider>["renderToolCalls"];

// A subagent's own messages are rendered inside their SubagentGroup (via the
// custom-message renderer above), so suppress them from the default inline
// flow. Returning null from the assistant-message slot is the supported way to
// hide a message; non-subagent assistant messages render normally.
function AssistantMessageMaybeHidden(props: AssistantMessageProps) {
  if (getSubagentRunId(props.message)) {
    return null;
  }
  return <CopilotChatAssistantMessage {...props} />;
}

// Stable slot object (module-level) so CopilotChat's slot memoization isn't
// defeated by a fresh reference on every render. The cast satisfies the slot's
// `typeof CopilotChatAssistantMessage` type, which carries static namespace
// members the slot renderer never uses — our wrapper is a valid replacement.
const MESSAGE_VIEW_SLOTS = {
  assistantMessage:
    AssistantMessageMaybeHidden as unknown as typeof CopilotChatAssistantMessage,
};

export default function DeepagentsSubagents({
  params,
}: DeepagentsSubagentsProps) {
  const { integrationId } = React.use(params);

  return (
    <CopilotKitProvider
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      renderToolCalls={TOOL_CALL_RENDERERS}
      renderCustomMessages={RENDER_CUSTOM_MESSAGES}
    >
      <CopilotChatConfigurationProvider agentId={AGENT_ID}>
        <SubagentAttributionDemo />
      </CopilotChatConfigurationProvider>
    </CopilotKitProvider>
  );
}

function SubagentAttributionDemo() {
  useConfigureSuggestions({
    suggestions: [
      {
        title: "Ask (needs approval)",
        message: "Why is the sky blue? Answer in one sentence.",
      },
    ],
    available: "always",
  });

  // HITL: the research subagent pauses via interrupt() before finalizing its
  // answer. The LangGraph integration surfaces that as an `on_interrupt` event;
  // useInterrupt renders this Approve/Reject prompt in the chat and resolve()
  // sends the decision back with Command(resume=...) on the same thread, so the
  // subagent continues from where it paused.
  useInterrupt({
    render: ({ event, resolve }) => {
      // The `on_interrupt` payload arrives as a JSON string (the integration
      // serializes the interrupt value), so parse it back into the object our
      // subagent tool passed to interrupt().
      type ApprovalPayload = { summary?: string; question?: string };
      const isObject = (v: unknown): v is Record<string, unknown> =>
        v !== null && typeof v === "object";

      const raw = event?.value;
      let value: ApprovalPayload = {};
      if (typeof raw === "string") {
        try {
          // JSON.parse succeeding is not enough: "null", "42" and "\"text\""
          // all parse to non-objects, and reading `.question` off them either
          // throws (null) or silently yields undefined. Only an object is a
          // usable payload; anything else is treated as the question text.
          const parsed: unknown = JSON.parse(raw);
          value = isObject(parsed)
            ? (parsed as ApprovalPayload)
            : { question: raw };
        } catch (error) {
          console.warn(
            "[deepagents_subagents] interrupt value is not valid JSON; " +
              "showing it as the question text.",
            { raw, error },
          );
          value = { question: raw };
        }
      } else if (isObject(raw)) {
        // Some interrupt shapes (LangGraph's non-legacy `Interrupt` objects,
        // and `emit_interrupt_outcome`) wrap the tool's payload under `.value`
        // rather than being the payload themselves. Unwrap that when present;
        // otherwise the object IS the payload.
        const inner = raw.value;
        if (isObject(inner)) {
          value = inner as ApprovalPayload;
        } else if (typeof inner === "string") {
          value = { question: inner };
        } else {
          value = raw as ApprovalPayload;
        }
      }
      return (
        <div className="subagent-hitl" data-testid="subagent-hitl">
          <div className="subagent-hitl-title">
            ⏸ {value.question ?? "Approve this action?"}
          </div>
          {value.summary ? (
            <div className="subagent-hitl-summary">{value.summary}</div>
          ) : null}
          <div className="subagent-hitl-actions">
            <button
              type="button"
              className="subagent-hitl-approve"
              data-testid="subagent-hitl-approve"
              onClick={() => resolve({ approved: true })}
            >
              Approve
            </button>
            <button
              type="button"
              className="subagent-hitl-reject"
              data-testid="subagent-hitl-reject"
              onClick={() => resolve({ approved: false })}
            >
              Reject
            </button>
          </div>
        </div>
      );
    },
  });

  return (
    <div className="flex justify-center items-center h-full w-full">
      <div className="h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
        <CopilotChat
          agentId={AGENT_ID}
          className="h-full rounded-2xl max-w-6xl mx-auto"
          messageView={MESSAGE_VIEW_SLOTS}
        />
      </div>
    </div>
  );
}
