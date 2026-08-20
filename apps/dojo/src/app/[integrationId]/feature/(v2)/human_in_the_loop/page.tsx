"use client";
import React, { useState, useEffect } from "react";
import "@copilotkit/react-core/v2/styles.css";
import { 
  useHumanInTheLoop,
  useConfigureSuggestions,
  CopilotChat,
  CopilotChatConfigurationProvider,
} from "@copilotkit/react-core/v2";
import { CopilotKit,
useLangGraphInterrupt } from "@copilotkit/react-core";
import { z } from "zod";
import { useTheme } from "next-themes";

interface HumanInTheLoopProps {
  params: Promise<{
    integrationId: string;
  }>;
}

const HumanInTheLoop: React.FC<HumanInTheLoopProps> = ({ params }) => {
  const { integrationId } = React.use(params);

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      agent="human_in_the_loop"
    >
      <Chat integrationId={integrationId} />
    </CopilotKit>
  );
};

interface Step {
  description: string;
  status: "disabled" | "enabled" | "executing";
}

// Shared UI Components
const StepContainer = ({ theme, children }: { theme?: string; children: React.ReactNode }) => (
  <div data-testid="select-steps" className="flex">
    <div
      className={`relative rounded-xl w-[600px] p-6 shadow-lg backdrop-blur-sm ${
        theme === "dark"
          ? "bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white border border-slate-700/50 shadow-2xl"
          : "bg-gradient-to-br from-white via-gray-50 to-white text-gray-800 border border-gray-200/80"
      }`}
    >
      {children}
    </div>
  </div>
);

const StepHeader = ({
  theme,
  enabledCount,
  totalCount,
  status,
  showStatus = false,
}: {
  theme?: string;
  enabledCount: number;
  totalCount: number;
  status?: string;
  showStatus?: boolean;
}) => (
  <div className="mb-5">
    <div className="flex items-center justify-between mb-3">
      <h2 className="text-xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
        Select Steps
      </h2>
      <div className="flex items-center gap-3">
        <div className={`text-sm ${theme === "dark" ? "text-slate-400" : "text-gray-500"}`}>
          {enabledCount}/{totalCount} Selected
        </div>
        {showStatus && (
          <div
            className={`text-xs px-2 py-1 rounded-full font-medium ${
              status === "executing"
                ? theme === "dark"
                  ? "bg-blue-900/30 text-blue-300 border border-blue-500/30"
                  : "bg-blue-50 text-blue-600 border border-blue-200"
                : theme === "dark"
                  ? "bg-slate-700 text-slate-300"
                  : "bg-gray-100 text-gray-600"
            }`}
          >
            {status === "executing" ? "Ready" : "Waiting"}
          </div>
        )}
      </div>
    </div>

    <div
      className={`relative h-2 rounded-full overflow-hidden ${theme === "dark" ? "bg-slate-700" : "bg-gray-200"}`}
    >
      <div
        className="absolute top-0 left-0 h-full bg-gradient-to-r from-blue-500 to-purple-500 rounded-full transition-all duration-500 ease-out"
        style={{ width: `${totalCount > 0 ? (enabledCount / totalCount) * 100 : 0}%` }}
      />
    </div>
  </div>
);

const StepItem = ({
  step,
  theme,
  status,
  onToggle,
  disabled = false,
}: {
  step: { description: string; status: string };
  theme?: string;
  status?: string;
  onToggle: () => void;
  disabled?: boolean;
}) => (
  <div
    className={`flex items-center p-3 rounded-lg transition-all duration-300 ${
      step.status === "enabled"
        ? theme === "dark"
          ? "bg-gradient-to-r from-blue-900/20 to-purple-900/10 border border-blue-500/30"
          : "bg-gradient-to-r from-blue-50 to-purple-50 border border-blue-200/60"
        : theme === "dark"
          ? "bg-slate-800/30 border border-slate-600/30"
          : "bg-gray-50/50 border border-gray-200/40"
    }`}
  >
    <label data-testid="step-item" className="flex items-center cursor-pointer w-full">
      <div className="relative">
        <input
          type="checkbox"
          checked={step.status === "enabled"}
          onChange={onToggle}
          className="sr-only"
          disabled={disabled}
        />
        <div
          className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-all duration-200 ${
            step.status === "enabled"
              ? "bg-gradient-to-br from-blue-500 to-purple-600 border-blue-500"
              : theme === "dark"
                ? "border-slate-400 bg-slate-700"
                : "border-gray-300 bg-white"
          } ${disabled ? "opacity-60" : ""}`}
        >
          {step.status === "enabled" && (
            <svg
              className="w-3 h-3 text-white"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={3}
                d="M5 13l4 4L19 7"
              />
            </svg>
          )}
        </div>
      </div>
      <span
        data-testid="step-text"
        className={`ml-3 font-medium transition-all duration-300 ${
          step.status !== "enabled" && status != "inProgress"
            ? `line-through ${theme === "dark" ? "text-slate-500" : "text-gray-400"}`
            : theme === "dark"
              ? "text-white"
              : "text-gray-800"
        } ${disabled ? "opacity-60" : ""}`}
      >
        {step.description}
      </span>
    </label>
  </div>
);

const ActionButton = ({
  variant,
  theme,
  disabled,
  onClick,
  children,
}: {
  variant: "primary" | "secondary" | "success" | "danger";
  theme?: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) => {
  const baseClasses = "px-6 py-3 rounded-lg font-semibold transition-all duration-200";
  const enabledClasses = "hover:scale-105 shadow-md hover:shadow-lg";
  const disabledClasses = "opacity-50 cursor-not-allowed";

  const variantClasses = {
    primary:
      "bg-gradient-to-r from-purple-500 to-purple-700 hover:from-purple-600 hover:to-purple-800 text-white shadow-lg hover:shadow-xl",
    secondary:
      theme === "dark"
        ? "bg-slate-700 hover:bg-slate-600 text-white border border-slate-600 hover:border-slate-500"
        : "bg-gray-100 hover:bg-gray-200 text-gray-800 border border-gray-300 hover:border-gray-400",
    success:
      "bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 text-white shadow-lg hover:shadow-xl",
    danger:
      "bg-gradient-to-r from-red-500 to-red-600 hover:from-red-600 hover:to-red-700 text-white shadow-lg hover:shadow-xl",
  };

  return (
    <button
      className={`${baseClasses} ${disabled ? disabledClasses : enabledClasses} ${
        disabled && variant === "secondary"
          ? "bg-gray-200 text-gray-500"
          : disabled && variant === "success"
            ? "bg-gray-400"
            : variantClasses[variant]
      }`}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
};

const DecorativeElements = ({
  theme,
  variant = "default",
}: {
  theme?: string;
  variant?: "default" | "success" | "danger";
}) => (
  <>
    <div
      className={`absolute top-3 right-3 w-16 h-16 rounded-full blur-xl ${
        variant === "success"
          ? theme === "dark"
            ? "bg-gradient-to-br from-green-500/10 to-emerald-500/10"
            : "bg-gradient-to-br from-green-200/30 to-emerald-200/30"
          : variant === "danger"
            ? theme === "dark"
              ? "bg-gradient-to-br from-red-500/10 to-pink-500/10"
              : "bg-gradient-to-br from-red-200/30 to-pink-200/30"
            : theme === "dark"
              ? "bg-gradient-to-br from-blue-500/10 to-purple-500/10"
              : "bg-gradient-to-br from-blue-200/30 to-purple-200/30"
      }`}
    />
    <div
      className={`absolute bottom-3 left-3 w-12 h-12 rounded-full blur-xl ${
        variant === "default"
          ? theme === "dark"
            ? "bg-gradient-to-br from-purple-500/10 to-pink-500/10"
            : "bg-gradient-to-br from-purple-200/30 to-pink-200/30"
          : "opacity-50"
      }`}
    />
  </>
);
const InterruptHumanInTheLoop: React.FC<{
  event: { value: { steps: Step[] } };
  resolve: (value: string) => void;
}> = ({ event, resolve }) => {
  const { theme } = useTheme();

  // Parse and initialize steps data
  let initialSteps: Step[] = [];
  if (event.value && event.value.steps && Array.isArray(event.value.steps)) {
    initialSteps = event.value.steps.map((step: Step | string) => ({
      description: typeof step === "string" ? step : step.description || "",
      status: typeof step === "object" && step.status ? step.status : "enabled",
    }));
  }

  const [localSteps, setLocalSteps] = useState<Step[]>(initialSteps);
  const enabledCount = localSteps.filter((step) => step.status === "enabled").length;

  const handleStepToggle = (index: number) => {
    setLocalSteps((prevSteps) =>
      prevSteps.map((step, i) =>
        i === index
          ? { ...step, status: step.status === "enabled" ? "disabled" : "enabled" }
          : step,
      ),
    );
  };

  const handlePerformSteps = () => {
    const selectedSteps = localSteps
      .filter((step) => step.status === "enabled")
      .map((step) => step.description);
    resolve("The user selected the following steps: " + selectedSteps.join(", "));
  };

  return (
    <StepContainer theme={theme}>
      <StepHeader theme={theme} enabledCount={enabledCount} totalCount={localSteps.length} />

      <div className="space-y-3 mb-6">
        {localSteps.map((step, index) => (
          <StepItem
            key={index}
            step={step}
            theme={theme}
            onToggle={() => handleStepToggle(index)}
          />
        ))}
      </div>

      <div className="flex justify-center">
        <ActionButton variant="primary" theme={theme} onClick={handlePerformSteps}>
          <span className="text-lg">✨</span>
          Perform Steps
          <span
            className={`ml-1 px-2 py-1 rounded-full text-xs font-bold ${
              theme === "dark" ? "bg-purple-800/50" : "bg-purple-600/20"
            }`}
          >
            {enabledCount}
          </span>
        </ActionButton>
      </div>

      <DecorativeElements theme={theme} />
    </StepContainer>
  );
};

const Chat = ({ integrationId }: { integrationId: string }) => {
  return (
    <CopilotChatConfigurationProvider agentId="human_in_the_loop">
      <ChatContent />
    </CopilotChatConfigurationProvider>
  );
};

const ChatContent = () => {
  useConfigureSuggestions({
    suggestions: [
      { title: "Simple plan", message: "Please plan a trip to mars in 5 steps." },
      { title: "Complex plan", message: "Please plan a pasta dish in 10 steps." },
    ],
    available: "always",
  });

  // Langgraph uses it's own hook to handle human-in-the-loop interactions via langgraph interrupts,
  // This hook won't do anything for other integrations.
  useLangGraphInterrupt({
    
    render: ({ event, resolve }) => <InterruptHumanInTheLoop event={event} resolve={resolve} />,
  });
  useHumanInTheLoop<{ steps: Step[] }>({
    agentId: "human_in_the_loop",
    name: "generate_task_steps",
    description: "Generates a list of steps for the user to perform",
     parameters: z.object({
      steps: z.array(
        z.object({
          description: z.string(),
          status: z.enum(["enabled", "disabled", "executing"]),
        }),
      ),
    })  ,
    // Note: In v1, `available` was used to disable this for langgraph integrations.
    // In v2, availability is handled at the agent/backend level.
    render: ({ args, respond, status }) => {
      return <StepsFeedback args={args} respond={respond} status={status} />;
    },
  });

  return (
    <div className="flex justify-center items-center h-full w-full">
      <div className="h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
        <CopilotChat
          agentId="human_in_the_loop"
          className="h-full rounded-2xl max-w-6xl mx-auto"
        />
      </div>
    </div>
  );
};

interface StepsFeedbackProps {
  args: { steps?: Step[] };
  respond?: (result: unknown) => Promise<void>;
  status: string;
}

const StepsFeedback = ({ args, respond, status }: StepsFeedbackProps) => {
  const { theme } = useTheme();
  const [localSteps, setLocalSteps] = useState<Step[]>([]);
  const [accepted, setAccepted] = useState<boolean | null>(null);

  // NOTE (PNI-272): kept as an effect. Snapshotting during render would
  // populate `localSteps` before the first commit, which is a behaviour change.
  useEffect(() => {
    if (status === "executing" && localSteps.length === 0 && Array.isArray(args?.steps) && args.steps.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLocalSteps(args.steps);
    }
  }, [status, args?.steps, localSteps]);

  if (!Array.isArray(args?.steps) || args.steps.length === 0) {
    return <></>;
  }

  const steps = Array.isArray(localSteps) && localSteps.length > 0 ? localSteps : args.steps;
  const enabledCount = steps.filter((step: Step) => step.status === "enabled").length;

  const handleStepToggle = (index: number) => {
    setLocalSteps((prevSteps) =>
      prevSteps.map((step, i) =>
        i === index
          ? { ...step, status: step.status === "enabled" ? "disabled" : "enabled" }
          : step,
      ),
    );
  };

  const handleReject = () => {
    if (respond) {
      setAccepted(false);
      respond({ accepted: false });
    }
  };

  const handleConfirm = () => {
    if (respond) {
      const confirmedSteps = localSteps.filter((step) => step.status === "enabled");
      setAccepted(true);
      respond({ accepted: true, steps: confirmedSteps });
    }
  };

  return (
    <StepContainer theme={theme}>
      <StepHeader
        theme={theme}
        enabledCount={enabledCount}
        totalCount={steps.length}
        status={status}
        showStatus={true}
      />

      <div className="space-y-3 mb-6">
        {steps.map((step: Step, index: number) => (
          <StepItem
            key={index}
            step={step}
            theme={theme}
            status={status}
            onToggle={() => handleStepToggle(index)}
            disabled={status !== "executing"}
          />
        ))}
      </div>

      {/* Action Buttons - Different logic from InterruptHumanInTheLoop */}
      {accepted === null && (
        <div className="flex justify-center gap-4">
          <ActionButton
            variant="secondary"
            theme={theme}
            disabled={status !== "executing"}
            onClick={handleReject}
          >
            <span className="mr-2">✗</span>
            Reject
          </ActionButton>
          <ActionButton
            variant="success"
            theme={theme}
            disabled={status !== "executing"}
            onClick={handleConfirm}
          >
            <span className="mr-2">✓</span>
            Confirm
            <span
              className={`ml-2 px-2 py-1 rounded-full text-xs font-bold ${
                theme === "dark" ? "bg-green-800/50" : "bg-green-600/20"
              }`}
            >
              {enabledCount}
            </span>
          </ActionButton>
        </div>
      )}

      {/* Result State - Unique to StepsFeedback */}
      {accepted !== null && (
        <div className="flex justify-center">
          <div
            className={`px-6 py-3 rounded-lg font-semibold flex items-center gap-2 ${
              accepted
                ? theme === "dark"
                  ? "bg-green-900/30 text-green-300 border border-green-500/30"
                  : "bg-green-50 text-green-700 border border-green-200"
                : theme === "dark"
                  ? "bg-red-900/30 text-red-300 border border-red-500/30"
                  : "bg-red-50 text-red-700 border border-red-200"
            }`}
          >
            <span className="text-lg">{accepted ? "✓" : "✗"}</span>
            {accepted ? "Accepted" : "Rejected"}
          </div>
        </div>
      )}

      <DecorativeElements
        theme={theme}
        variant={accepted === true ? "success" : accepted === false ? "danger" : "default"}
      />
    </StepContainer>
  );
};

export default HumanInTheLoop;
