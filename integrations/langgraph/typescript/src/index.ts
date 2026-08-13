import { HttpAgent } from "@ag-ui/client";
import type { AgentSubscriber, RunAgentInput } from "@ag-ui/client";
import { reconcileLegacyResumeInterrupts } from "./interrupts";

export * from './agent'
export {
  langGraphInterruptToAGUI,
  langGraphInterruptsToAGUI,
  buildLgCommandResumeFromAgui,
  isLegacyCommandResume,
  reconcileLegacyResumeInterrupts,
  DEFAULT_RESUME_SENTINEL_CANCELLED,
  DEFAULT_RESUME_SENTINEL_MAP,
} from './interrupts'
export {
  getA2UITools,
  A2UI_OPERATIONS_KEY,
  BASIC_CATALOG_ID,
  type A2UIToolParams,
  type A2UISubagentModel,
} from './a2ui-tool'
// Re-export the toolkit types consumers need to type the shared params object
// and its callbacks (e.g. `onA2UIAttempt`) without depending on the toolkit
// package directly.
export type {
  A2UIGuidelines,
  A2UIRecoveryConfig,
  A2UIValidationCatalog,
  A2UIAttemptRecord,
} from '@ag-ui/a2ui-toolkit'
// Transformer is intentionally NOT re-exported from the main entry. It
// imports `@langchain/langgraph` (server-only) and would force every
// consumer (e.g. dojo's Next.js bundle) to resolve that dep. Demo agents
// import it from `@ag-ui/langgraph/transformer` instead.
export class LangGraphHttpAgent extends HttpAgent {
  // Mirror LangGraphAgent: keep legacy forwardedProps.command.resume working
  // when an upstream agent emits RUN_FINISHED.outcome=interrupt (which records
  // pendingInterrupts on the base AbstractAgent). Harmless otherwise — with a
  // plain RUN_FINISHED, pendingInterrupts stays empty and the bridge is a no-op.
  protected async onInitialize(
    input: RunAgentInput,
    subscribers: AgentSubscriber[],
  ) {
    reconcileLegacyResumeInterrupts(this, input);
    return super.onInitialize(input, subscribers);
  }
}
