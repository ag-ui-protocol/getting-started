/** AWS Strands integration for AG-UI. */

export {
  StrandsAgent,
  INTERRUPT_CANCELLED,
  buildSnapshotMessages,
  buildStrandsSeed,
  convertMessagesForStrandsSeed,
} from "./agent";
export type { StrandsAgentOptions } from "./agent";

export {
  createProxyTool,
  syncProxyTools,
  isProxyTool,
} from "./client-proxy-tool";
export type { StrandsToolRegistry } from "./client-proxy-tool";

export { syncTemplateTools, parkedBatchToolNames } from "./template-tools";
export type { TemplateToolSelectionEntry } from "./template-tools";

export { CITATIONS_METADATA_KEY } from "./citations";
export type { AguiCitation, AguiCitationLocation } from "./citations";

export { convertAguiContentToStrands, flattenContentToText } from "./utils";

// The URL fetch policy, so `StrandsAgentConfig.urlFetchPolicy` can actually be
// written by a consumer: the default to spread over, the type of the field and
// the type of its scheme allowlist (without which an override cannot be
// spelled), plus the error class so a caller reading logs or wrapping
// `fetchUrlContent` can identify a refusal.
//
// `UrlFetchUnavailableError` stays off this surface. It is the internal
// counterpart that separates "could not reach a verdict" from "refused", both
// of which the adapter turns into a logged `null` before any caller sees
// either, and the Python package exports no equivalent.
export { DEFAULT_URL_FETCH_POLICY, UrlFetchPolicyError } from "./utils";
export type { UrlFetchPolicy, SchemeAllowlist } from "./utils";

export {
  getA2UITools,
  planA2UIInjection,
  isAutoInjectedA2UITool,
  A2UI_STREAM_KEY,
} from "./a2ui-tool";
export type {
  A2UIToolParams,
  A2UIAttemptRecord,
  A2UIToolGlue,
  A2UIInjectConfig,
  A2UIInjectionPlan,
  A2UIRenderStreamEvent,
  PlanA2UIInjectionInput,
} from "./a2ui-tool";

// Server-side Express transport helpers (`createStrandsApp`,
// `addStrandsExpressEndpoint`, `addPing`, `addCapabilities`,
// `capabilitiesFor`, `DEFAULT_CAPABILITIES`, and associated types) live at
// `@ag-ui/aws-strands/server`. Keeping them off the main entry lets
// client-side bundlers (Next.js, Vite, etc.) trace this package without
// pulling Express / cors into the browser graph.

export type { Logger } from "./logger";

export { buildContextExtras } from "./config";
export type {
  StrandsAgentConfig,
  ToolBehavior,
  ToolCallContext,
  ToolCallContextExtras,
  ToolResultContext,
  ToolStreamEventContext,
  ToolStreamEventHandler,
  PredictStateMapping,
  SessionManagerProvider,
  TemplateToolsProvider,
  ThreadAgentConfigProvider,
  StateContextBuilder,
  StateFromArgs,
  StateFromResult,
  CustomResultHandler,
  ArgsStreamer,
  MaybePromise,
  StatePayload,
} from "./config";

// Thin HttpAgent subclass for AG-UI clients pointing at a Strands endpoint.
import { HttpAgent } from "@ag-ui/client";
export class AWSStrandsAgent extends HttpAgent {}
