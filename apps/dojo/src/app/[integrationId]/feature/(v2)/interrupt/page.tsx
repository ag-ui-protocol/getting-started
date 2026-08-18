"use client";
import React, { useMemo, useState } from "react";
import "@copilotkit/react-core/v2/styles.css";
import {
  CopilotChat,
  CopilotChatConfigurationProvider,
  useConfigureSuggestions,
  useInterrupt,
} from "@copilotkit/react-core/v2";
import { CopilotKit } from "@copilotkit/react-core";
import { useTheme } from "next-themes";

interface InterruptProps {
  params: Promise<{ integrationId: string }>;
}

// Payload the Mastra `schedule_meeting` tool sends via `suspend(...)`. The
// @ag-ui/mastra bridge wraps it in the on_interrupt CUSTOM event under
// `suspendPayload` (the Mastra contract — it carries `toolName`/`toolCallId`/
// `runId` the LangGraph raw-value shape doesn't). We read `suspendPayload`.
interface SuspendPayload {
  topic?: string;
  attendee?: string;
}

interface TimeSlot {
  iso: string;
  label: string;
}

// Generate a few future slots relative to "now" so the picker is always valid.
function generateSlots(): TimeSlot[] {
  const slots: TimeSlot[] = [];
  const now = new Date();
  for (let day = 1; day <= 2; day++) {
    for (const hour of [10, 14]) {
      const d = new Date(now);
      d.setDate(now.getDate() + day);
      d.setHours(hour, 0, 0, 0);
      slots.push({
        iso: d.toISOString(),
        label: d.toLocaleString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }),
      });
    }
  }
  return slots;
}

const Interrupt: React.FC<InterruptProps> = ({ params }) => {
  const { integrationId } = React.use(params);

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      agent="interrupt"
    >
      <CopilotChatConfigurationProvider agentId="interrupt">
        <ChatContent />
      </CopilotChatConfigurationProvider>
    </CopilotKit>
  );
};

const ChatContent = () => {
  useConfigureSuggestions({
    suggestions: [
      {
        title: "Book a call with sales",
        message: "Book an intro call with the sales team to discuss pricing.",
      },
      {
        title: "Schedule a 1:1 with Alice",
        message: "Schedule a 1:1 with Alice next week to review Q2 goals.",
      },
    ],
    available: "always",
  });

  // Native interrupt handling. The Mastra agent suspends its `schedule_meeting`
  // tool; the bridge emits `on_interrupt`; this renders the picker and
  // `resolve(...)` resumes the suspended tool with the user's choice.
  useInterrupt({
    agentId: "interrupt",
    renderInChat: true,
    render: ({ event, resolve }) => {
      // The adapter JSON-stringifies the interrupt value, so parse it.
      const raw = event.value ?? {};
      const parsed = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
        // Mastra suspends a tool and carries the payload under `suspendPayload`.
        suspendPayload?: SuspendPayload;
        // CrewAI suspends the FLOW, so the value is the AG-UI Interrupt shape and
        // the paused method's output sits under `metadata.crewai.output`.
        metadata?: { crewai?: { output?: SuspendPayload } };
      };

      // Same picker either way: both frameworks pause to ask for a meeting time,
      // and both take the same resume payload back through `resolve(...)`.
      const payload = parsed.suspendPayload ?? parsed.metadata?.crewai?.output ?? {};
      return (
        <TimePickerCard
          topic={payload.topic ?? "a call"}
          attendee={payload.attendee}
          onPick={(slot) =>
            resolve({ chosen_time: slot.iso, chosen_label: slot.label })
          }
          onCancel={() => resolve({ cancelled: true })}
        />
      );
    },
  });

  return (
    <div className="flex justify-center items-center h-full w-full">
      <div className="h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
        <CopilotChat
          agentId="interrupt"
          className="h-full rounded-2xl max-w-6xl mx-auto"
        />
      </div>
    </div>
  );
};

const TimePickerCard: React.FC<{
  topic: string;
  attendee?: string;
  onPick: (slot: TimeSlot) => void;
  onCancel: () => void;
}> = ({ topic, attendee, onPick, onCancel }) => {
  const { theme } = useTheme();
  const slots = useMemo(() => generateSlots(), []);
  const [done, setDone] = useState<TimeSlot | "cancelled" | null>(null);

  const dark = theme === "dark";

  // Once the user picks/cancels, render nothing: `resolve()` resumes the run and
  // this interrupt render unmounts moments later, with the agent's text taking
  // over as the confirmation. Blanking on click (rather than leaving the slots
  // up) gives an instant, clean handoff and prevents a double-pick. We don't
  // show a "Booked" card here — it would only flash before unmounting; the
  // agent's message is the record.
  if (done) {
    return null;
  }

  return (
    <div
      data-testid="interrupt-picker"
      className={`rounded-xl w-[480px] p-6 shadow-lg ${
        dark
          ? "bg-slate-800 text-white border border-slate-700"
          : "bg-white text-gray-800 border border-gray-200"
      }`}
    >
      <h2 className="text-lg font-semibold mb-1">{topic}</h2>
      {attendee ? (
        <p className="text-sm opacity-70 mb-4">with {attendee}</p>
      ) : (
        <div className="mb-4" />
      )}

      <div className="grid grid-cols-2 gap-2">
        {slots.map((slot) => (
          <button
            key={slot.iso}
            type="button"
            data-testid={`interrupt-slot-${slot.iso}`}
            onClick={() => {
              setDone(slot);
              onPick(slot);
            }}
            className={`rounded-lg border px-3 py-3 text-sm font-medium transition-colors ${
              dark
                ? "border-slate-600 hover:border-blue-400 hover:bg-slate-700"
                : "border-gray-200 hover:border-blue-400 hover:bg-blue-50"
            }`}
          >
            {slot.label}
          </button>
        ))}
      </div>

      <button
        type="button"
        data-testid="interrupt-cancel"
        onClick={() => {
          setDone("cancelled");
          onCancel();
        }}
        className={`mt-4 w-full rounded-lg border px-3 py-2 text-xs font-medium uppercase tracking-wide transition-colors ${
          dark
            ? "border-slate-600 hover:bg-slate-700"
            : "border-gray-200 hover:bg-gray-50"
        }`}
      >
        Cancel
      </button>
    </div>
  );
};

export default Interrupt;
