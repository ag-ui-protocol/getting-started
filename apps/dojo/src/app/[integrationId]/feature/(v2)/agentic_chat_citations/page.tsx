"use client";
import React, { useEffect, useState } from "react";
import "@copilotkit/react-core/v2/styles.css";
import {
  useAgent,
  UseAgentUpdate,
  useConfigureSuggestions,
  CopilotChat,
} from "@copilotkit/react-core/v2";
import { CopilotKit } from "@copilotkit/react-core";

const AGENT_ID = "agentic_chat_citations";

/** The metadata key the AWS Strands adapter attaches citations under. */
const CITATIONS_KEY = "citations";

/**
 * One citation as the AWS Strands adapter puts it on the wire, under the
 * `citations` key of the assistant message's metadata.
 *
 * Mirrors `AguiCitation` in `@ag-ui/aws-strands` rather than importing it: the
 * dojo renders whatever an integration attaches to a message, and typing it
 * here keeps the page honest about the fields it actually reads.
 */
interface Citation {
  title?: string;
  source?: string;
  sourceContent?: { text: string }[];
  location?: { type?: string; url?: string; [field: string]: unknown };
  content?: { text: string }[];
  textOffset: number;
}

interface CitedMessage {
  id: string;
  role: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

interface PageProps {
  params: Promise<{ integrationId: string }>;
}

const AgenticChatCitations: React.FC<PageProps> = ({ params }) => {
  const { integrationId } = React.use(params);

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      agent={AGENT_ID}
    >
      <Chat />
    </CopilotKit>
  );
};

/** The link a citation points at, when it points at anything reachable. */
function citationHref(citation: Citation): string | undefined {
  if (citation.location?.type === "web") {
    const url = citation.location.url;
    if (typeof url === "string" && url) return url;
  }
  return citation.source?.startsWith("http") ? citation.source : undefined;
}

/** A short human label for where the passage sits in its source. */
function citationWhere(citation: Citation): string | undefined {
  const location = citation.location;
  if (!location || typeof location.type !== "string") return undefined;
  if (location.type === "web") {
    return typeof location.domain === "string" ? location.domain : "web";
  }
  const { start, end } = location as { start?: unknown; end?: unknown };
  if (typeof start === "number" && typeof end === "number") {
    const unit = location.type.replace("document", "").toLowerCase();
    return `${unit} ${start}–${end}`;
  }
  return location.type;
}

const SourceList: React.FC<{ citations: Citation[] }> = ({ citations }) => (
  <ol className="space-y-3" data-testid="citation-list">
    {citations.map((citation, index) => {
      const href = citationHref(citation);
      const where = citationWhere(citation);
      const quoted = citation.sourceContent?.[0]?.text;
      return (
        <li
          key={`${citation.textOffset}-${index}`}
          className="rounded-md border border-gray-200 p-3 text-sm dark:border-gray-700"
          data-testid="citation-item"
        >
          <div className="flex items-baseline gap-2">
            <span className="text-xs text-gray-500">[{index + 1}]</span>
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="font-medium underline"
                data-testid="citation-title"
              >
                {citation.title || href}
              </a>
            ) : (
              <span className="font-medium" data-testid="citation-title">
                {citation.title || "Untitled source"}
              </span>
            )}
          </div>
          {quoted && (
            <p
              className="mt-1 border-l-2 border-gray-300 pl-2 italic text-gray-600 dark:text-gray-400"
              data-testid="citation-quote"
            >
              {quoted}
            </p>
          )}
          <p className="mt-1 text-xs text-gray-500">
            {where ? `${where} · ` : ""}
            after {citation.textOffset} characters of the answer
          </p>
        </li>
      );
    })}
  </ol>
);

const Chat = () => {
  const { agent } = useAgent({
    agentId: AGENT_ID,
    updates: [UseAgentUpdate.OnMessagesChanged],
  });

  useConfigureSuggestions({
    suggestions: [
      {
        title: "Ask something citable",
        message: "What is the James Webb Space Telescope observing right now?",
      },
      {
        title: "Ask for a comparison",
        message: "How does HTTP/3 differ from HTTP/2?",
      },
    ],
    available: "always",
  });

  const [byMessage, setByMessage] = useState<Record<string, Citation[]>>({});

  // Citations are attached to the message they annotate, so this keys them by
  // message id rather than joining a second stream back to the answer.
  //
  // Read off the message's own events rather than off `message.metadata`,
  // because the metadata reducer that folds event metadata onto the assembled
  // message first ships in `@ag-ui/client` 0.0.59 and the CopilotKit release
  // this dojo pins resolves 0.0.57. The wire carries it either way: event
  // schemas are passthrough, so the data arrives and only the folding is
  // missing. On a client with the reducer, the same list is readable directly
  // as `message.metadata.citations` and this subscription is unnecessary.
  useEffect(() => {
    const collect = (event: {
      messageId?: string;
      metadata?: Record<string, unknown>;
    }) => {
      const citations = event.metadata?.[CITATIONS_KEY] as
        | Citation[]
        | undefined;
      if (!event.messageId || !citations?.length) return;
      setByMessage((prev) => ({ ...prev, [event.messageId!]: citations }));
    };

    const subscription = agent.subscribe({
      onTextMessageContentEvent: ({ event }) => collect(event),
      onTextMessageEndEvent: ({ event }) => collect(event),
    });
    return () => subscription.unsubscribe();
  }, [agent]);

  const cited = ((agent.messages ?? []) as CitedMessage[])
    .filter((message) => message.role === "assistant")
    .map((message) => ({
      id: message.id,
      content: message.content ?? "",
      // Prefer the assembled message when the client folds metadata onto it,
      // so this page keeps working unchanged once CopilotKit ships a newer
      // client and the subscription above becomes redundant.
      citations: ((message.metadata?.[CITATIONS_KEY] as Citation[]) ??
        byMessage[message.id] ??
        []) as Citation[],
    }))
    .filter((entry) => entry.citations.length > 0);

  return (
    <div className="flex h-full w-full">
      <div className="flex-1 p-4">
        <CopilotChat agentId={AGENT_ID} className="h-full rounded-2xl" />
      </div>

      <aside
        className="w-[380px] shrink-0 overflow-y-auto border-l border-gray-200 p-4 dark:border-gray-700"
        data-testid="citations-panel"
      >
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Sources
        </h2>
        <p className="mb-4 text-xs text-gray-500">
          Attached to the message that used them, not a separate stream.
        </p>

        {cited.length === 0 ? (
          <p className="text-sm text-gray-500" data-testid="citations-empty">
            Ask something the assistant has to look up. Its sources appear here,
            attached to the message that used them.
          </p>
        ) : (
          <div className="space-y-6">
            {cited.map((entry) => (
              <section key={entry.id} data-testid="cited-message">
                <p className="mb-2 line-clamp-2 text-xs text-gray-500">
                  {entry.content.slice(0, 120)}
                  {entry.content.length > 120 ? "…" : ""}
                </p>
                <SourceList citations={entry.citations} />
              </section>
            ))}
          </div>
        )}
      </aside>
    </div>
  );
};

export default AgenticChatCitations;
