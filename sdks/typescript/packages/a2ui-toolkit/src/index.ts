/**
 * @ag-ui/a2ui-toolkit
 *
 * Framework-agnostic building blocks for A2UI subagent tools. Each per-
 * framework adapter (LangGraph, ADK, Mastra, etc.) composes these helpers
 * with its framework-specific glue (tool decorator, runtime accessor, model
 * binding/invoke). Nothing in this package depends on any agent framework.
 */

import type { A2UIRecoveryConfig, A2UIAttemptRecord } from "./recovery";
import type { A2UIValidationCatalog } from "./validate";

/** Container key the A2UI middleware looks for in tool results. */
export const A2UI_OPERATIONS_KEY = "a2ui_operations";

/** Default catalog id used when the subagent does not specify one. */
export const BASIC_CATALOG_ID = "https://a2ui.org/specification/v0_9/basic_catalog.json";

/** A single A2UI v0.9 server-to-client operation. */
export type A2UIOperation = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Op builders
// ---------------------------------------------------------------------------

export function createSurface(surfaceId: string, catalogId: string): A2UIOperation {
  return {
    version: "v0.9",
    createSurface: { surfaceId, catalogId },
  };
}

export function updateComponents(
  surfaceId: string,
  components: Array<Record<string, unknown>>,
): A2UIOperation {
  return {
    version: "v0.9",
    updateComponents: { surfaceId, components },
  };
}

export function updateDataModel(
  surfaceId: string,
  data: unknown,
  path: string = "/",
): A2UIOperation {
  return {
    version: "v0.9",
    updateDataModel: { surfaceId, path, value: data },
  };
}

// ---------------------------------------------------------------------------
// Action builders (agui.* local-swap functionCalls) — OSS-165 v2
//
// A local swap is authored in-band as a native A2UI `action.functionCall`
// referencing a CopilotKit-registered, framework-agnostic data-write function.
// These builders centralise the `agui.*` name so authoring code never hardcodes
// the wire string.
// ---------------------------------------------------------------------------

/** An A2UI component `action` value carrying a client-side functionCall. */
export type A2UIFunctionCallAction = {
  functionCall: { call: string; args: Record<string, unknown> };
};

/**
 * Build an ``agui.setValue`` local-swap action. On click the renderer writes
 * ``value`` into the surface data model at ``path`` with no agent round-trip.
 * ``value`` may be a literal or a ``{ path }`` binding resolved at click time.
 */
export function setValue(path: string, value: unknown): A2UIFunctionCallAction {
  return { functionCall: { call: "agui.setValue", args: { path, value } } };
}

/**
 * Build an ``agui.toggleValue`` local-swap action. On click the renderer reads
 * the current value at ``path`` and writes its negation (boolean) or toggles it
 * between empty and ``value`` (e.g. a data-bound ``List``), with no agent
 * round-trip. Omit ``value`` for a plain boolean toggle.
 */
export function toggleValue(path: string, value?: unknown): A2UIFunctionCallAction {
  const args: Record<string, unknown> = { path };
  if (value !== undefined) args.value = value;
  return { functionCall: { call: "agui.toggleValue", args } };
}

// ---------------------------------------------------------------------------
// Inner render_a2ui tool definition
// ---------------------------------------------------------------------------

/**
 * JSON schema for the inner ``render_a2ui`` tool. Framework adapters bind
 * this on the subagent's model with ``tool_choice="render_a2ui"`` so the
 * structured-output call produces ``{surfaceId, components, data}``. The
 * catalog id is owned by the factory, not the subagent — the subagent can't
 * invent a catalog the host hasn't registered.
 */
export const RENDER_A2UI_TOOL_DEF = {
  type: "function" as const,
  function: {
    name: "render_a2ui",
    description:
      "Render a dynamic A2UI v0.9 surface. The root component must have id 'root'. " +
      "Use components from the available catalog only.",
    parameters: {
      type: "object",
      properties: {
        surfaceId: {
          type: "string",
          description: "Unique surface identifier.",
        },
        components: {
          type: "array",
          description:
            "A2UI v0.9 component array (flat format). The root component must have id 'root'.",
          items: { type: "object" },
        },
        data: {
          type: "object",
          description:
            "Optional initial data model for the surface (form values, list items, etc.).",
        },
      },
      required: ["surfaceId", "components"],
    },
  },
};

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

/**
 * Build the prompt prefix from AG-UI state context entries + the A2UI
 * component catalog. Framework integrations conventionally extract the
 * catalog into ``state["ag-ui"]["a2ui_schema"]`` and forward other context
 * entries (generation guidelines, design guidelines) under
 * ``state["ag-ui"]["context"]``.
 */
export function buildContextPrompt(state: Record<string, unknown>): string {
  const agUi = (state["ag-ui"] as Record<string, unknown> | undefined) ?? {};
  const parts: string[] = [];

  const contextEntries = (agUi.context as Array<Record<string, unknown>> | undefined) ?? [];
  for (const entry of contextEntries) {
    const desc = entry?.description as string | undefined;
    const value = entry?.value as string | undefined;
    if (desc) {
      parts.push(`## ${desc}\n${value ?? ""}\n`);
    } else if (value) {
      parts.push(`${value}\n`);
    }
  }

  const schema = agUi.a2ui_schema as string | undefined;
  if (schema) {
    parts.push(`## Available Components\n${schema}\n`);
  }

  return parts.join("\n");
}

/**
 * Context-entry description the ``@ag-ui/a2ui-middleware`` stamps onto the A2UI
 * component schema it injects into ``RunAgentInput.context``. Single home for
 * the constant so every framework adapter splits on the same string. MUST stay
 * byte-identical to ``A2UI_SCHEMA_CONTEXT_DESCRIPTION`` in
 * ``@ag-ui/a2ui-middleware`` (this is a wire contract, not prose).
 */
export const A2UI_SCHEMA_CONTEXT_DESCRIPTION =
  "A2UI Component Schema — available components for generating UI surfaces. " +
  "Use these component names and properties when creating A2UI operations.";

/**
 * Split AG-UI context entries into the A2UI component-schema entry and the
 * rest. The schema entry is the one whose ``description`` exactly equals
 * ``A2UI_SCHEMA_CONTEXT_DESCRIPTION``. Returns ``[schemaValue, regularContext]``:
 * adapters route ``schemaValue`` to ``state["ag-ui"]["a2ui_schema"]`` (rendered
 * as ``## Available Components`` by ``buildContextPrompt``) and ``regularContext``
 * to ``state["ag-ui"]["context"]``. Entries are returned unchanged.
 */
export function splitA2UISchemaContext(
  context: Array<Record<string, unknown>> | undefined | null,
): [string | undefined, Array<Record<string, unknown>>] {
  let schemaValue: string | undefined;
  const regular: Array<Record<string, unknown>> = [];
  for (const entry of context ?? []) {
    const description = entry?.description as string | undefined;
    if (description === A2UI_SCHEMA_CONTEXT_DESCRIPTION) {
      schemaValue = entry?.value as string | undefined;
    } else {
      regular.push(entry);
    }
  }
  return [schemaValue, regular];
}

/**
 * Find the frontend-registered A2UI catalog in run ``state``, returning
 * ``[componentSchema, catalogId]`` or ``undefined`` when no catalog is present.
 * Framework-agnostic, so every adapter resolves the catalog the same way.
 * Both delivery shapes live under the canonical ``state["ag-ui"]`` key:
 * - Schema entry: ``state["ag-ui"]["a2ui_schema"]``, a JSON string
 *   ``{"catalogId": ..., "components": [...]}`` (toolkit reads the schema from
 *   state for the prompt itself, so only the id is surfaced here).
 * - Catalog context entry: an ``state["ag-ui"]["context"]`` entry whose
 *   description mentions ``"A2UI catalog"``; the value lists catalogs as
 *   ``"- <catalogId>"`` lines, the first being the custom catalog.
 */
export function resolveA2UICatalog(
  state: Record<string, unknown>,
): [string | undefined, string | undefined] | undefined {
  const agUi = (state["ag-ui"] as Record<string, unknown> | undefined) ?? {};
  const a2uiSchema = agUi.a2ui_schema;
  if (a2uiSchema) {
    let catalogId: string | undefined;
    try {
      const parsed =
        typeof a2uiSchema === "string" ? JSON.parse(a2uiSchema) : a2uiSchema;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        catalogId = (parsed as Record<string, unknown>).catalogId as
          | string
          | undefined;
      }
    } catch {
      // Unparseable schema -> no id (degrade to the configured default).
    }
    return [undefined, catalogId];
  }

  const contextEntries =
    (agUi.context as Array<Record<string, unknown>> | undefined) ?? [];
  for (const entry of contextEntries) {
    const description = (entry?.description as string | undefined) ?? "";
    const value = (entry?.value as string | undefined) ?? "";
    if (!description.includes("A2UI catalog") || !value) continue;
    const match = value.match(/^\s*-\s+(\S+)/m);
    return [value, match ? match[1] : undefined];
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Prior surface lookup (used for intent="update")
// ---------------------------------------------------------------------------

export interface PriorSurface {
  components: Array<Record<string, unknown>>;
  data: unknown;
  catalogId?: string;
}

/**
 * Locate the most recent rendered state for ``surfaceId`` in message history.
 *
 * Walks backwards looking for a tool result whose content is a JSON string
 * containing ``a2ui_operations`` for the given surface. Returns the
 * reconstructed ``{components, data, catalogId}``, or ``undefined`` if no
 * matching surface is found.
 */
export function findPriorSurface(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- published signature; see PrepareA2UIRequestInput.messages
  messages: Array<any>,
  surfaceId: string,
): PriorSurface | undefined {
  // Accumulate the surface's state across the walk, newest-to-oldest. For each
  // field, the FIRST occurrence we see (newest) wins; older messages only fill
  // in fields the more recent ones omitted.
  //
  // Per-message end-state is computed FORWARD because the renderer applies ops
  // in document order. The last op affecting the surface in a message
  // determines that message's contribution — including `deleteSurface`, which
  // wipes the surface. If the NEWEST message to mention the surface ends in
  // delete, the surface is gone and we must return undefined; older
  // create/update ops are stale and would resurrect a surface the renderer no
  // longer shows.
  let components: Array<Record<string, unknown>> | undefined;
  let data: unknown;
  let dataSeen = false;
  let catalogId: string | undefined;
  let matched = false;

  for (let i = messages.length - 1; i >= 0; i--) {
    // Messages cross a wire boundary and arrive in several shapes (AG-UI
    // `type`, LangChain-style `role`), so they are narrowed here rather than
    // constrained at the signature.
    const msg = messages[i] as Record<string, unknown> | undefined;
    if (!msg) continue;
    const role = msg.type ?? msg.role;
    if (role !== "tool" && role !== "ToolMessage") continue;
    const content = msg.content;
    if (typeof content !== "string") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const ops = (parsed as Record<string, unknown>)[A2UI_OPERATIONS_KEY];
    if (!Array.isArray(ops)) continue;

    // Compute this message's END STATE for surfaceId by walking ops forward.
    // `deleteSurface` resets the per-message accumulator; subsequent create /
    // update ops in the same message restore it.
    let msgMentions = false;
    let msgDeleted = false;
    let msgCatalogId: string | undefined;
    let msgComponents: Array<Record<string, unknown>> | undefined;
    let msgData: unknown;
    let msgDataSeen = false;

    for (const op of ops) {
      if (!op || typeof op !== "object") continue;
      const opObj = op as Record<string, unknown>;

      const ds = opObj.deleteSurface as Record<string, unknown> | undefined;
      if (ds && ds.surfaceId === surfaceId) {
        msgMentions = true;
        msgDeleted = true;
        msgCatalogId = undefined;
        msgComponents = undefined;
        msgData = undefined;
        msgDataSeen = false;
        continue;
      }

      const cs = opObj.createSurface as Record<string, unknown> | undefined;
      if (cs && cs.surfaceId === surfaceId) {
        msgMentions = true;
        msgDeleted = false;
        if (typeof cs.catalogId === "string") {
          msgCatalogId = cs.catalogId;
        }
      }
      const uc = opObj.updateComponents as Record<string, unknown> | undefined;
      if (uc && uc.surfaceId === surfaceId) {
        msgMentions = true;
        msgDeleted = false;
        if (Array.isArray(uc.components)) {
          msgComponents = uc.components as Array<Record<string, unknown>>;
        }
      }
      const ud = opObj.updateDataModel as Record<string, unknown> | undefined;
      if (ud && ud.surfaceId === surfaceId) {
        msgMentions = true;
        msgDeleted = false;
        msgData = ud.value;
        msgDataSeen = true;
      }
    }

    if (!msgMentions) continue;

    if (!matched) {
      // First (newest) message to mention the surface — its end state is the
      // authoritative current state.
      if (msgDeleted) return undefined;
      matched = true;
      catalogId = msgCatalogId;
      components = msgComponents;
      data = msgData;
      dataSeen = msgDataSeen;
    } else {
      // Older message: only fill in fields not yet set. A delete here is
      // overridden by the newer creation we already recorded.
      if (msgDeleted) continue;
      if (catalogId === undefined && msgCatalogId !== undefined) catalogId = msgCatalogId;
      if (components === undefined && msgComponents !== undefined) components = msgComponents;
      if (!dataSeen && msgDataSeen) {
        data = msgData;
        dataSeen = true;
      }
    }

    // Early-exit once every field has been populated — nothing older can
    // override what we already have.
    if (matched && components !== undefined && catalogId !== undefined && dataSeen) {
      return { components, data, catalogId };
    }
  }

  if (!matched) return undefined;
  return { components: components ?? [], data, catalogId };
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

export interface EditContext {
  surfaceId: string;
  prior: PriorSurface;
  changes?: string;
}

// ---------------------------------------------------------------------------
// Subagent prompt guidelines (OSS-248)
//
// Re-enables the rich generation + design guidance the legacy
// `copilotkit.a2ui.a2ui_prompt` shipped. The two DEFAULT_* blocks are applied
// automatically (per-field) so subagent output is well-designed out of the box;
// a host overrides either block via `A2UIGuidelines`. Pass an empty string to
// suppress a block entirely.
// ---------------------------------------------------------------------------

/**
 * Default generation guidance (tool-call contract, id/path/data-binding rules).
 * Applied when `A2UIGuidelines.generationGuidelines` is unset (`undefined`).
 * Ported verbatim from the legacy `copilotkit.a2ui` defaults (OSS-248).
 */
export const DEFAULT_GENERATION_GUIDELINES = `\
Generate A2UI v0.9 JSON.

## A2UI Protocol Instructions

A2UI (Agent to UI) is a protocol for rendering rich UI surfaces from agent responses.

CRITICAL: You MUST call the render_a2ui tool with ALL of these arguments:
- surfaceId: A unique ID for the surface (e.g. "product-comparison")
- components: REQUIRED — the A2UI component array. NEVER omit this. Use a List with
  children: { componentId: "card-id", path: "/items" } for repeating cards.
- data: OPTIONAL — a JSON object written to the root of the surface data model.
  Use for pre-filling form values or providing data for path-bound components.
- every component must have the "component" field specifying the component type (e.g. "Text", "Image", "Row", "Column", "List", "Button", etc.)

COMPONENT ID RULES:
- Every component ID must be unique within the surface.
- A component MUST NOT reference itself as child/children. This causes a
  circular dependency error. For example, if a component has id="avatar",
  its child must be a DIFFERENT id (e.g. "avatar-img"), never "avatar".
- The child/children tree must be a DAG — no cycles allowed.

PATH RULES FOR TEMPLATES:
Components inside a repeating List use RELATIVE paths (no leading slash).
The path is resolved relative to each array item automatically.
If List has children: { componentId: "card", path: "/items" } and item has key "name",
use { "path": "name" } (NO leading slash — relative to item).
CRITICAL: Do NOT use "/name" (absolute) inside templates — use "name" (relative).
The List's own path ("/items") uses a leading slash (absolute), but all
components INSIDE the template card use paths WITHOUT leading slash.
Do NOT use "/items/0/name" or "/items/{@key}/name" — just "name".

DATA MODEL:
The "data" key in the tool args is a plain JSON object that initializes the surface
data model. Components bound to paths (e.g. "value": { "path": "/form/name" })
read from and write to this data model. Examples:
  For forms:  "data": { "form": { "name": "Alice", "email": "" } }
  For lists:  "data": { "items": [{"name": "Product A"}, {"name": "Product B"}] }
  For mixed:  "data": { "form": { "query": "" }, "results": [...] }

FORMS AND TWO-WAY DATA BINDING:
To create editable forms, bind input components to data model paths using { "path": "..." }.
The client automatically writes user input back to the data model at the bound path.
CRITICAL: Using a literal value (e.g. "value": "") makes the field READ-ONLY.
You MUST use { "path": "..." } to make inputs editable.

All input components use "value" as the binding property:
- TextField:     "value": { "path": "/form/fieldName" }
- CheckBox:      "value": { "path": "/form/isChecked" }
- Slider:        "value": { "path": "/form/sliderVal" }
- DateTimeInput: "value": { "path": "/form/date" }
- ChoicePicker:  "value": { "path": "/form/choices" }

To retrieve form values when a button is clicked, include "context" with path references
in the button's action. Paths are resolved to their current values at click time:
  "action": { "event": { "name": "submit", "context": { "userName": { "path": "/form/name" } } } }

To pre-fill form values, pass initial data via the "data" tool argument:
  "data": { "form": { "name": "Markus" } }

LOCAL INTERACTIONS (no agent round-trip):
For interactions that only update local surface state — toggling visibility,
switching a value, revealing details — use a client-side "functionCall" action
instead of an "event", so the change applies instantly with no server round-trip:
  - Set a value:    "action": { "functionCall": { "call": "agui.setValue", "args": { "path": "/showDetails", "value": true } } }
  - Toggle a value: "action": { "functionCall": { "call": "agui.toggleValue", "args": { "path": "/showDetails" } } }
"path" is the data-model location to write; components bound to it re-render.
There is no data-bound "visible" flag: to SHOW/HIDE a region, bind a List to a
path and toggle its array between empty and its items (agui.toggleValue with a
"value"). Use an "event" action (NOT functionCall) when the agent must handle the
interaction or when the change requires re-structuring the component tree.

FORM EXAMPLE (editable text field with pre-filled value + submit button):
  "components": [
    { "id": "root", "component": "Card", "child": "form-col" },
    { "id": "form-col", "component": "Column", "children": ["name-field", "submit-row"] },
    { "id": "name-field", "component": "TextField", "label": "Name", "value": { "path": "/form/name" } },
    { "id": "submit-row", "component": "Row", "justify": "end", "children": ["submit-btn"] },
    { "id": "submit-btn", "component": "Button", "child": "btn-text", "variant": "primary",
      "action": { "event": { "name": "submit", "context": { "userName": { "path": "/form/name" } } } } },
    { "id": "btn-text", "component": "Text", "text": "Submit" }
  ],
  "data": { "form": { "name": "Markus" } }`;

/**
 * Default design guidance (visual hierarchy, layout, imagery, action format).
 * Applied when `A2UIGuidelines.designGuidelines` is unset (`undefined`).
 * Ported verbatim from the legacy `copilotkit.a2ui` defaults (OSS-248).
 */
export const DEFAULT_DESIGN_GUIDELINES = `\
Create polished, visually appealing interfaces:
- Always include a title heading (h2) for the surface, outside the List.
  Wrap in a Column: [title, list] as root.
- For card templates, create clear visual hierarchy:
  - h3 for primary text (names, titles)
  - h2 for featured numbers (prices, scores) — makes them stand out
  - caption for secondary info (ratings, categories, metadata)
  - body for descriptions
- Use Divider between logical sections within cards.
- Use Row with justify="spaceBetween" for label-value pairs
  (e.g. "Rating" on left, "4.5/5" on right).
- Include images when relevant (logos, icons, product photos):
  - Use Image component with variant="smallFeature" or "avatar"
  - Prefer company logos for branded products — Google favicons are reliable:
    https://www.google.com/s2/favicons?domain=sony.com&sz=128
    https://www.google.com/s2/favicons?domain=bose.com&sz=128
  - For generic icons: https://placehold.co/128x128/EEE/999?text=🎧
  - Do NOT invent Unsplash photo-IDs — they will 404. Only use real, known URLs.
- Use horizontal List direction for side-by-side comparison cards.
- Keep cards clean — avoid clutter. Whitespace is good.
- Use consistent surfaceIds (lowercase, hyphenated).
- NEVER use the same ID for a component and its child — this creates a
  circular dependency. E.g. if id="avatar", child must NOT be "avatar".
- Both Row and Column support "justify" and "align".
- Add Button for interactivity. Button needs child (Text ID) + action.
  Action MUST use this exact nested format:
    "action": { "event": { "name": "myAction", "context": { "key": "value" } } }
  The "event" key holds an OBJECT with "name" (required) and "context" (optional).
  Do NOT use a flat format like {"event": "name"} — "event" must be an object.
  Use variant="primary" for main action buttons, variant="borderless" for links.
- For forms: wrap fields in a Card with a Column. Place the submit button in a
  Row with justify="end". Every input MUST use path binding on the "value" property
  (e.g. "value": { "path": "/form/name" }) to be editable. The submit button's action
  context MUST reference the same paths to capture the user's input.

Use the SAME surfaceId as the main surface. Match action names to Button action event names.`;

/**
 * Prompt knobs threaded from the host through the adapter into the subagent
 * prompt. The toolkit owns this shape so a new knob is added here (and rendered
 * in `buildSubagentPrompt`) without editing any framework adapter — each adapter
 * forwards this bag verbatim.
 *
 * Per-field semantics (mirrors the legacy `a2ui_prompt` defaults):
 *   - key absent / `undefined` → the built-in `DEFAULT_*` block is used.
 *   - `""` (empty string)      → that block is suppressed (no section emitted).
 *   - any other string         → replaces the default for that block.
 *
 * `compositionGuide` has no default; it is appended only when provided.
 */
export interface A2UIGuidelines {
  generationGuidelines?: string;
  designGuidelines?: string;
  compositionGuide?: string;
}

export interface BuildSubagentPromptInput {
  /** Output of ``buildContextPrompt(state)``. */
  contextPrompt: string;
  /** Generation/design/composition prompt knobs (per-field defaults applied). */
  guidelines?: A2UIGuidelines;
  /** When set, instructs the subagent to edit a prior surface in place. */
  editContext?: EditContext;
}

/**
 * Compose the full system prompt the subagent sees.
 *
 * Section order: generation guidelines → design guidelines → context + catalog
 * (from ``contextPrompt``) → composition guide → edit-existing-surface block.
 * Faithful to the legacy ``a2ui_prompt`` ordering (generation lead, design
 * header, then available components).
 *
 * Generation and design fall back per-field to ``DEFAULT_GENERATION_GUIDELINES``
 * / ``DEFAULT_DESIGN_GUIDELINES`` when unset (``undefined``); an empty string
 * suppresses the block.
 */
export function buildSubagentPrompt(input: BuildSubagentPromptInput): string {
  // Per-field fallback: `undefined` → built-in default; `""` → host explicitly
  // suppressed the block (`??` treats only null/undefined as missing, so an
  // empty string is preserved as the escape hatch).
  const generation = input.guidelines?.generationGuidelines ?? DEFAULT_GENERATION_GUIDELINES;
  const design = input.guidelines?.designGuidelines ?? DEFAULT_DESIGN_GUIDELINES;
  const compositionGuide = input.guidelines?.compositionGuide;

  const parts: string[] = [];
  if (generation) parts.push(generation);
  if (design) parts.push(`## Design Guidelines\n${design}`);
  if (input.contextPrompt) parts.push(input.contextPrompt);
  if (compositionGuide) parts.push(compositionGuide);

  if (input.editContext) {
    const { surfaceId, prior, changes } = input.editContext;
    let editBlock =
      `## Editing an existing surface\n` +
      `You are editing surface '${surfaceId}'. Produce the FULL ` +
      `updated components array and data model — not just a diff. Preserve ` +
      `component ids that the user has not asked to change so the renderer ` +
      `can reconcile them. Reuse the same catalogId.\n\n` +
      `### Previous components\n${JSON.stringify(prior.components, null, 2)}\n\n` +
      `### Previous data\n${JSON.stringify(prior.data, null, 2)}\n`;
    if (changes) {
      editBlock += `\n### Requested changes\n${changes}\n`;
    }
    parts.push(editBlock);
  }

  return parts.filter((p) => p && p.length > 0).join("\n");
}

// ---------------------------------------------------------------------------
// Operations envelope
// ---------------------------------------------------------------------------

export interface AssembleOpsInput {
  /** ``"create"`` to render a new surface, ``"update"`` to modify a prior one. */
  intent: "create" | "update";
  surfaceId: string;
  catalogId: string;
  components: Array<Record<string, unknown>>;
  data?: Record<string, unknown>;
}

/**
 * Produce the final A2UI v0.9 operation list for a render result.
 *
 * ``create`` emits ``[createSurface, updateComponents, updateDataModel?]``.
 * ``update`` skips ``createSurface`` so the frontend reconciles the existing
 * surface in place instead of erroring (per v0.9 spec, ``createSurface`` on
 * an existing id is invalid).
 */
export function assembleOps(input: AssembleOpsInput): A2UIOperation[] {
  const ops: A2UIOperation[] = [];
  if (input.intent !== "update") {
    ops.push(createSurface(input.surfaceId, input.catalogId));
  }
  ops.push(updateComponents(input.surfaceId, input.components));
  if (input.data && Object.keys(input.data).length > 0) {
    ops.push(updateDataModel(input.surfaceId, input.data));
  }
  return ops;
}

/**
 * Wrap a list of A2UI operations as the JSON envelope the A2UI middleware
 * looks for in tool results.
 */
export function wrapAsOperationsEnvelope(ops: A2UIOperation[]): string {
  return JSON.stringify({ [A2UI_OPERATIONS_KEY]: ops });
}

/**
 * Wrap an error as the JSON string a subagent tool returns when it can't
 * produce a surface. Keeps the error shape consistent across frameworks.
 */
export function wrapErrorEnvelope(message: string): string {
  return JSON.stringify({ error: message });
}

// ---------------------------------------------------------------------------
// Subagent-tool defaults (shared so every framework adapter advertises the
// same planner-facing surface and behaviour)
// ---------------------------------------------------------------------------

/** Surface id used when the subagent omits ``surfaceId`` on a create. */
export const DEFAULT_SURFACE_ID = "dynamic-surface";

/** Default name the outer A2UI tool is advertised under to the main planner. */
export const GENERATE_A2UI_TOOL_NAME = "generate_a2ui";

/** Default description shown to the main agent's planner. */
export const GENERATE_A2UI_TOOL_DESCRIPTION =
  "Generate or update a dynamic A2UI surface based on the conversation. " +
  "A secondary LLM designs the UI components and data. " +
  "Use intent='create' (default) when the user requests new visual content " +
  "(cards, forms, lists, dashboards, comparisons, etc.). " +
  "Use intent='update' with target_surface_id to modify a surface you " +
  "previously rendered (e.g. 'change the second card's price', " +
  "'add a Buy button', 'use red instead of blue').";

/** Planner-facing descriptions for the outer tool's three arguments. */
export const GENERATE_A2UI_ARG_DESCRIPTIONS = {
  intent:
    "'create' to render a new surface; 'update' to modify a surface previously rendered in this conversation. Defaults to 'create'.",
  target_surface_id: "Required when intent='update'. The surface id of the prior render to modify.",
  changes: "Optional natural-language description of the changes to apply when intent='update'.",
} as const;

// ---------------------------------------------------------------------------
// Shared A2UI tool-factory params (OSS-248)
//
// One params shape, owned by the toolkit, consumed identically by every
// framework adapter. A framework's factory is always
// `getA2UITools(params: A2UIToolParams<TModel>)` — only the body (tool
// decorator, runtime/state accessor, model bind+invoke) differs per framework.
//
// `model` is the single framework-specific field, so the type is generic over
// it. Adding a new knob = add a field here (+ apply its default in
// `resolveA2UIToolParams`) — NO adapter signature ever changes, and a brand-new
// framework adapter gets the knob for free on day one.
// ---------------------------------------------------------------------------

export interface A2UIToolParams<TModel = unknown> {
  /** Chat model the subagent invokes for structured A2UI output. The one
   *  framework-specific field — typed per framework via the generic. */
  model: TModel;
  /** Generation/design/composition prompt knobs (per-field defaults applied). */
  guidelines?: A2UIGuidelines;
  /** Surface id used when the subagent omits `surfaceId`. */
  defaultSurfaceId?: string;
  /** Catalog id assigned to every new surface this factory creates — the
   *  subagent never picks the catalog. Falls back to the basic v0.9 catalog. */
  defaultCatalogId?: string;
  /** Name advertised to the main agent's planner. */
  toolName?: string;
  /** Description shown to the main agent's planner. */
  toolDescription?: string;
  /** Inline catalog enabling catalog-aware recovery. Pass the SAME catalog the
   *  host gives the middleware so retry decision + paint gate agree. */
  catalog?: A2UIValidationCatalog;
  /** Recovery loop config: attempt cap, retry-UI threshold, debug exposure. */
  recovery?: A2UIRecoveryConfig;
  /** Per-attempt hook for recovery status / dev logs (non-disruptive). */
  onA2UIAttempt?: (record: A2UIAttemptRecord) => void;
}

/** `A2UIToolParams` with every optional field resolved to its effective value.
 *  Returned by `resolveA2UIToolParams` so adapters never re-implement defaults. */
export interface ResolvedA2UIToolParams<TModel = unknown> {
  model: TModel;
  guidelines?: A2UIGuidelines;
  defaultSurfaceId: string;
  defaultCatalogId: string;
  toolName: string;
  toolDescription: string;
  catalog?: A2UIValidationCatalog;
  recovery?: A2UIRecoveryConfig;
  onA2UIAttempt?: (record: A2UIAttemptRecord) => void;
}

/**
 * Normalize an `A2UIToolParams` into a `ResolvedA2UIToolParams`, filling the
 * canonical defaults so each framework adapter stops re-implementing
 * `toolName || DEFAULT` / `catalogId || BASIC` lines.
 *
 * Uses `||` (not `??`) so an accidental empty-string override from a caller
 * falls back to the canonical default rather than advertising a nameless /
 * empty-description tool or emitting a blank surface/catalog id.
 */
export function resolveA2UIToolParams<TModel>(
  params: A2UIToolParams<TModel>,
): ResolvedA2UIToolParams<TModel> {
  return {
    model: params.model,
    guidelines: params.guidelines,
    defaultSurfaceId: params.defaultSurfaceId || DEFAULT_SURFACE_ID,
    defaultCatalogId: params.defaultCatalogId || BASIC_CATALOG_ID,
    toolName: params.toolName || GENERATE_A2UI_TOOL_NAME,
    toolDescription: params.toolDescription || GENERATE_A2UI_TOOL_DESCRIPTION,
    catalog: params.catalog,
    recovery: params.recovery,
    onA2UIAttempt: params.onA2UIAttempt,
  };
}

// ---------------------------------------------------------------------------
// High-level orchestration
//
// These two functions hold the entire create/update decision + prompt prep +
// result-assembly logic so every framework adapter is reduced to pure glue
// (tool decorator, state access, model bind+invoke, tool-call read).
// ---------------------------------------------------------------------------

export interface PrepareA2UIRequestInput {
  /** Raw ``intent`` arg from the planner (defaults to ``"create"``). */
  intent?: string;
  /** Raw ``target_surface_id`` arg from the planner. */
  targetSurfaceId?: string;
  /** Raw ``changes`` arg from the planner. */
  changes?: string;
  /** Conversation history with the current (unbalanced) tool call stripped. */
  // DEFERRED (PNI-272): stays `any` because this is published API. Narrowing it
  // to `unknown` compiles for callers that construct this, but breaks any
  // consumer that reads a message back off it — a deliberate API decision, not a
  // lint repair.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: Array<any>;
  /** The agent's run state (read for context + catalog via buildContextPrompt). */
  state: Record<string, unknown>;
  /**
   * Generation/design/composition prompt knobs, forwarded verbatim to
   * ``buildSubagentPrompt``. The toolkit owns the shape so adapters never need
   * editing when a knob is added.
   */
  guidelines?: A2UIGuidelines;
}

export interface PreparedA2UIRequest {
  /** System prompt to feed the subagent. Empty string when ``error`` is set. */
  prompt: string;
  /** Whether this is an in-place edit of a prior surface. */
  isUpdate: boolean;
  /** The reconstructed prior surface, when editing. */
  prior?: PriorSurface;
  /** Set when the request is invalid (e.g. update with no matching surface). */
  error?: string;
}

/**
 * Resolve the create/update decision, locate any prior surface, and build the
 * subagent system prompt. Returns ``error`` instead of a prompt when the
 * request is invalid (update referencing a surface not in history).
 */
export function prepareA2UIRequest(input: PrepareA2UIRequestInput): PreparedA2UIRequest {
  const intent = input.intent ?? "create";
  const isUpdate = intent === "update" && Boolean(input.targetSurfaceId);

  const prior = isUpdate ? findPriorSurface(input.messages, input.targetSurfaceId!) : undefined;

  if (isUpdate && !prior) {
    return {
      prompt: "",
      isUpdate,
      error:
        `intent='update' requested target_surface_id='${input.targetSurfaceId}' ` +
        `but no prior render of that surface was found in conversation history`,
    };
  }

  const prompt = buildSubagentPrompt({
    contextPrompt: buildContextPrompt(input.state),
    guidelines: input.guidelines,
    editContext: prior
      ? { surfaceId: input.targetSurfaceId!, prior, changes: input.changes }
      : undefined,
  });

  return { prompt, isUpdate, prior };
}

export interface BuildA2UIEnvelopeInput {
  /** The subagent's ``render_a2ui`` structured-output args. */
  args: Record<string, unknown>;
  /** From ``prepareA2UIRequest``. */
  isUpdate: boolean;
  /** The planner's ``target_surface_id`` (used as the surface id on update). */
  targetSurfaceId?: string;
  /** The prior surface from ``prepareA2UIRequest`` (supplies the catalog id on update). */
  prior?: PriorSurface;
  /** Surface id used when the subagent omits one on create. */
  defaultSurfaceId?: string;
  /** Catalog id used when there's no prior surface to inherit one from. */
  defaultCatalogId?: string;
}

/**
 * Turn the subagent's structured output into the final operations envelope.
 *
 * Catalog ownership stays with the host: the subagent never picks a catalog,
 * so the id comes from the prior surface (update) or the configured default
 * (create) — never from the model's args.
 */
export function buildA2UIEnvelope(input: BuildA2UIEnvelopeInput): string {
  // Treat empty-string defaults as unset. `??` alone would propagate "" into
  // the emitted createSurface / updateComponents ops and surface as
  // "Catalog not found: " / a blank surface id at render time — hiding the
  // real cause (host misconfiguration). The middleware streaming path uses
  // the same guard for symmetry.
  const safeDefaultSurfaceId =
    input.defaultSurfaceId && input.defaultSurfaceId.length > 0
      ? input.defaultSurfaceId
      : DEFAULT_SURFACE_ID;
  const safeDefaultCatalogId =
    input.defaultCatalogId && input.defaultCatalogId.length > 0
      ? input.defaultCatalogId
      : BASIC_CATALOG_ID;

  // Narrow ``args.surfaceId`` to a non-empty string before using it — the
  // model's output is untrusted and could send a number / object / null.
  const argSurfaceId =
    typeof input.args.surfaceId === "string" && input.args.surfaceId.length > 0
      ? input.args.surfaceId
      : "";
  const surfaceId = input.isUpdate
    ? input.targetSurfaceId || safeDefaultSurfaceId
    : argSurfaceId || safeDefaultSurfaceId;

  const catalogId = input.prior?.catalogId || safeDefaultCatalogId;

  const rawComponents = input.args.components;
  const components: Array<Record<string, unknown>> = Array.isArray(rawComponents)
    ? (rawComponents as Array<Record<string, unknown>>)
    : [];
  const rawData = input.args.data;
  const data: Record<string, unknown> =
    rawData && typeof rawData === "object" && !Array.isArray(rawData)
      ? (rawData as Record<string, unknown>)
      : {};

  const ops = assembleOps({
    intent: input.isUpdate ? "update" : "create",
    surfaceId,
    catalogId,
    components,
    data,
  });

  return wrapAsOperationsEnvelope(ops);
}

// ---------------------------------------------------------------------------
// Error-recovery loop (OSS-162) — semantic validation + validate→retry loop,
// shared so the middleware (paint gate) and adapters (retry driver) agree.
// ---------------------------------------------------------------------------
export * from "./validate";
export * from "./recovery";
