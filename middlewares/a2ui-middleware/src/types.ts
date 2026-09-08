/**
 * A2UI v0.9 inline catalog schema.
 * Matches the structure defined by the A2UI specification (basic_catalog.json).
 * Components are keyed by name and use standard JSON Schema to describe
 * their properties in the flat wire format.
 */
export interface A2UIInlineCatalogSchema {
  /** Catalog identifier */
  catalogId: string;
  /** Component schemas keyed by component name */
  components: Record<string, Record<string, unknown>>;
}

/**
 * @deprecated Use A2UIInlineCatalogSchema instead.
 * Legacy component schema definition with { name, props } format.
 */
export interface A2UIComponentSchema {
  /** Component name (e.g. "TodoCard", "FlightResult") */
  name: string;
  /** Human-readable description for the AI agent */
  description?: string;
  /** Component props as JSON Schema */
  props?: Record<string, unknown>;
  /** Named slots for child components */
  slots?: string[];
}

/**
 * Configuration for the A2UI Middleware
 */
export interface A2UIMiddlewareConfig {
  /**
   * Component schema — declares which components are available to agents.
   * When provided, the schema is injected as context into RunAgentInput
   * so agents know what components they can generate.
   *
   * Accepts the v0.9 inline catalog format (preferred) or the legacy
   * array format for backwards compatibility.
   */
  schema?: A2UIInlineCatalogSchema | A2UIComponentSchema[];

  /**
   * A2UI generation-lifecycle options (OSS-162). A server-side knob applied to
   * every agent this middleware wraps — Python and TypeScript alike, since the
   * middleware is the single emitter of the generation lifecycle for all of them.
   * Values are stamped onto the `a2ui-surface` activity's pre-paint content
   * (`status: "building" | "retrying" | "failed"`) so the client renderer honors
   * them. The whole lifecycle rides one stable messageId and is replaced in place
   * by the painted surface.
   *
   * - `debugExposure` — how much retry/error detail the renderer surfaces:
   *   `"hidden"` (no expander), `"collapsed"` (expander present, closed), or
   *   `"verbose"` (expander open). When unset, the client default (`"collapsed"`)
   *   applies.
   * - `showProgressTokens` — when `true` (default), the building skeleton carries
   *   a throttled live token estimate of the streamed UI spec. Set `false` for a
   *   countless skeleton (the CSS animation is unaffected either way).
   * - `maxAttempts` — the retry cap shown in the "Retrying… (N/M attempts)" label.
   *   Defaults to the toolkit's `MAX_A2UI_ATTEMPTS`; set it to match the adapter's
   *   recovery cap if you override that.
   */
  recovery?: {
    debugExposure?: "hidden" | "collapsed" | "verbose";
    showProgressTokens?: boolean;
    maxAttempts?: number;
  };

  /**
   * Controls whether the middleware injects an A2UI rendering tool into
   * the agent's tool list.
   *
   * - `true` — injects a tool named `"render_a2ui"` (default name).
   * - `string` — injects the tool with the given custom name.
   * - `false` / omitted — no tool is injected; the middleware relies on
   *   the agent producing A2UI JSON through its own means and will still
   *   detect and render any valid A2UI JSON in the event stream.
   */
  injectA2UITool?: boolean | string;

  /**
   * Tool names the middleware recognizes as A2UI rendering tools.
   * When the middleware sees a TOOL_CALL_START for any of these names,
   * it tracks streaming args to progressively extract components/items
   * and emits a synthetic TOOL_CALL_RESULT at RUN_FINISHED.
   *
   * Defaults to `["render_a2ui"]`.
   */
  a2uiToolNames?: string[];

  /**
   * Catalog id used when the middleware creates a surface from a STREAMED
   * render tool call.
   *
   * The streamed `render_a2ui` args no longer carry a catalogId — catalog
   * choice belongs to the host/factory, not the subagent (the subagent must
   * not be able to invent a catalog the frontend hasn't registered). Since
   * the streaming `createSurface` op is emitted before the factory's final
   * envelope is available, the middleware needs the catalog id up front.
   *
   * Set this to the same catalog id the factory's `defaultCatalogId` uses.
   * When omitted, the middleware falls back to any catalogId present in the
   * streamed args, then to the v0.9 basic catalog.
   */
  defaultCatalogId?: string;

}

/**
 * User action payload sent via forwardedProps.a2uiAction
 */
export interface A2UIUserAction {
  /** Name of the action being performed */
  name?: string;

  /** ID of the surface the action occurred on */
  surfaceId?: string;

  /** ID of the component within the surface */
  sourceComponentId?: string;

  /** Optional context data for the action */
  context?: Record<string, unknown>;

  /** Optional timestamp of the action */
  timestamp?: string;
}

/**
 * Expected structure of forwardedProps for A2UI actions
 */
export interface A2UIForwardedProps {
  a2uiAction?: {
    userAction: A2UIUserAction;
  };
}

/**
 * A2UI message types (v0.9)
 */
export type A2UIMessageType = "createSurface" | "updateComponents" | "updateDataModel" | "deleteSurface";

/**
 * A2UI message structure (v0.9)
 */
export interface A2UIMessage {
  createSurface?: {
    surfaceId: string;
    catalogId: string;
    theme?: Record<string, unknown>;
    attachDataModel?: boolean;
  };
  updateComponents?: {
    surfaceId: string;
    components: Array<Record<string, unknown>>;
  };
  updateDataModel?: {
    surfaceId: string;
    path?: string;
    value?: unknown;
  };
  deleteSurface?: {
    surfaceId: string;
  };
}

