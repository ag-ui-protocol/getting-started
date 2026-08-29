"""
ag-ui-a2ui-toolkit
==================

Framework-agnostic building blocks for A2UI subagent tools. Each per-
framework adapter (LangGraph, ADK, Mastra, …) composes these helpers with its
framework-specific glue (tool decorator, runtime accessor, model binding +
invoke). Nothing in this package depends on any agent framework.
"""

from __future__ import annotations

import json
import re
from typing import Any, Optional, TypedDict


__all__ = [
    "A2UI_OPERATIONS_KEY",
    "BASIC_CATALOG_ID",
    "A2UI_SCHEMA_CONTEXT_DESCRIPTION",
    "split_a2ui_schema_context",
    "resolve_a2ui_catalog",
    "RENDER_A2UI_TOOL_DEF",
    "DEFAULT_SURFACE_ID",
    "GENERATE_A2UI_TOOL_NAME",
    "GENERATE_A2UI_TOOL_DESCRIPTION",
    "GENERATE_A2UI_ARG_DESCRIPTIONS",
    "create_surface",
    "update_components",
    "update_data_model",
    "build_context_prompt",
    "find_prior_surface",
    "build_subagent_prompt",
    "A2UIGuidelines",
    "DEFAULT_GENERATION_GUIDELINES",
    "DEFAULT_DESIGN_GUIDELINES",
    "A2UIToolParams",
    "ResolvedA2UIToolParams",
    "resolve_a2ui_tool_params",
    "assemble_ops",
    "wrap_as_operations_envelope",
    "wrap_error_envelope",
    "prepare_a2ui_request",
    "build_a2ui_envelope",
    "PriorSurface",
    "EditContext",
    "PreparedA2UIRequest",
    # Error-recovery loop (OSS-162)
    "validate_a2ui_components",
    "A2UIValidationError",
    "ValidateA2UIResult",
    "MAX_A2UI_ATTEMPTS",
    "A2UI_RECOVERY_ACTIVITY_TYPE",
    "format_validation_errors",
    "augment_prompt_with_validation_errors",
    "run_a2ui_generation_with_recovery",
]

# Error-recovery loop (OSS-162) — semantic validation + validate→retry loop,
# shared so the middleware (paint gate) and adapters (retry driver) agree.
from .validate import (  # noqa: E402
    validate_a2ui_components,
    A2UIValidationError,
    ValidateA2UIResult,
)
from .recovery import (  # noqa: E402
    MAX_A2UI_ATTEMPTS,
    A2UI_RECOVERY_ACTIVITY_TYPE,
    format_validation_errors,
    augment_prompt_with_validation_errors,
    run_a2ui_generation_with_recovery,
)


A2UI_OPERATIONS_KEY = "a2ui_operations"
"""Container key the A2UI middleware looks for in tool results."""

BASIC_CATALOG_ID = "https://a2ui.org/specification/v0_9/basic_catalog.json"
"""Default catalog id used when the subagent does not specify one."""

A2UI_SCHEMA_CONTEXT_DESCRIPTION = (
    "A2UI Component Schema — available components for generating UI surfaces. "
    "Use these component names and properties when creating A2UI operations."
)
"""Context-entry description the ``@ag-ui/a2ui-middleware`` stamps onto the A2UI
component schema it injects into ``RunAgentInput.context``. Single home for the
constant so every framework adapter splits on the same string. MUST stay
byte-identical to ``A2UI_SCHEMA_CONTEXT_DESCRIPTION`` in
``@ag-ui/a2ui-middleware`` (the TypeScript twin cannot import this Python copy).
``split_a2ui_schema_context`` matches it by exact equality — any drift silently
routes the schema into the generic context block instead of
``## Available Components``."""


# ---------------------------------------------------------------------------
# Op builders
# ---------------------------------------------------------------------------


def create_surface(surface_id: str, catalog_id: str) -> dict[str, Any]:
    return {
        "version": "v0.9",
        "createSurface": {"surfaceId": surface_id, "catalogId": catalog_id},
    }


def update_components(
    surface_id: str, components: list[dict[str, Any]]
) -> dict[str, Any]:
    return {
        "version": "v0.9",
        "updateComponents": {"surfaceId": surface_id, "components": components},
    }


def update_data_model(
    surface_id: str, data: Any, path: str = "/"
) -> dict[str, Any]:
    return {
        "version": "v0.9",
        "updateDataModel": {"surfaceId": surface_id, "path": path, "value": data},
    }


# ---------------------------------------------------------------------------
# Inner render_a2ui tool definition
# ---------------------------------------------------------------------------

RENDER_A2UI_TOOL_DEF: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "render_a2ui",
        "description": (
            "Render a dynamic A2UI v0.9 surface. The root component must have "
            "id 'root'. Use components from the available catalog only."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "surfaceId": {
                    "type": "string",
                    "description": "Unique surface identifier.",
                },
                "components": {
                    "type": "array",
                    "description": (
                        "A2UI v0.9 component array (flat format). The root "
                        "component must have id 'root'."
                    ),
                    "items": {"type": "object"},
                },
                "data": {
                    "type": "object",
                    "description": (
                        "Optional initial data model for the surface (form "
                        "values, list items for data-bound components, etc.)."
                    ),
                },
            },
            "required": ["surfaceId", "components"],
        },
    },
}
"""JSON schema for the inner ``render_a2ui`` tool the subagent is forced to call."""


# ---------------------------------------------------------------------------
# State helpers
# ---------------------------------------------------------------------------


def build_context_prompt(state: dict) -> str:
    """Assemble the prompt prefix from AG-UI state context entries + the A2UI
    component catalog.

    Framework integrations conventionally extract the catalog into
    ``state["ag-ui"]["a2ui_schema"]`` and forward other context entries
    (generation guidelines, design guidelines) under
    ``state["ag-ui"]["context"]``.
    """
    ag_ui = state.get("ag-ui", {}) or {}
    parts: list[str] = []

    for entry in ag_ui.get("context", []) or []:
        if isinstance(entry, dict):
            desc = entry.get("description")
            value = entry.get("value")
        else:
            desc = getattr(entry, "description", None)
            value = getattr(entry, "value", None)
        # Mirror the TS toolkit: a null/None value with a description must NOT
        # leak the literal string "None" into the subagent prompt. f-string
        # interpolation would do that — coerce to "" first.
        value_str = "" if value is None else str(value)
        if desc:
            parts.append(f"## {desc}\n{value_str}\n")
        elif value_str:
            parts.append(f"{value_str}\n")

    a2ui_schema = ag_ui.get("a2ui_schema")
    if a2ui_schema:
        parts.append(f"## Available Components\n{a2ui_schema}\n")

    return "\n".join(parts)


def split_a2ui_schema_context(context: Optional[list]) -> tuple:
    """Split AG-UI context entries into the A2UI component-schema entry and the
    rest. The schema entry is the one whose ``description`` exactly equals
    ``A2UI_SCHEMA_CONTEXT_DESCRIPTION`` (stamped by ``@ag-ui/a2ui-middleware``).

    Returns ``(schema_value, regular_context)``: framework adapters route
    ``schema_value`` to ``state["ag-ui"]["a2ui_schema"]`` (rendered as
    ``## Available Components`` by ``build_context_prompt``) and
    ``regular_context`` to ``state["ag-ui"]["context"]``. ``schema_value`` is
    ``None`` when no schema entry is present. Entries are returned unchanged
    (dicts or objects exposing ``.description``/``.value``) — the same dual
    shape ``build_context_prompt`` already tolerates.
    """
    schema_value = None
    regular_context: list = []
    for entry in context or []:
        if isinstance(entry, dict):
            description = entry.get("description")
            value = entry.get("value")
        else:
            description = getattr(entry, "description", None)
            value = getattr(entry, "value", None)
        if description == A2UI_SCHEMA_CONTEXT_DESCRIPTION:
            schema_value = value
        else:
            regular_context.append(entry)
    return schema_value, regular_context


def resolve_a2ui_catalog(state: dict) -> "Optional[tuple]":
    """Find the frontend-registered A2UI catalog in run ``state``, returning
    ``(component_schema, catalog_id)`` — or ``None`` when no catalog is present
    (so the adapter falls back to its configured default / the basic catalog).

    Framework-agnostic, so every adapter resolves the catalog the same way
    instead of each reimplementing it. Two delivery paths are supported because
    the catalog lands in different places depending on how the agent is served:

    Both live under ``state["ag-ui"]`` — the canonical key every adapter
    populates:

    - **Schema entry** → ``state["ag-ui"]["a2ui_schema"]``, a JSON string
      ``{"catalogId": ..., "components": [...]}`` (routed there from
      ``RunAgentInput.context`` by ``split_a2ui_schema_context``). The toolkit
      reads ``a2ui_schema`` from state for the prompt itself, so only the
      ``catalog_id`` is surfaced here (``component_schema`` is ``None``).
    - **Catalog context entry** → an ``state["ag-ui"]["context"]`` entry whose
      description mentions ``"A2UI catalog"`` (catalog id + component schemas as
      text); the value lists catalogs as ``"- <catalogId>"`` lines, the first
      being the custom catalog the client registered.

    ``component_schema`` becomes the sub-agent ``composition_guide``;
    ``catalog_id`` becomes ``default_catalog_id`` so generated surfaces bind to
    the frontend's catalog (BYOC custom catalogs render their own components,
    not the basic one).
    """
    ag_ui = state.get("ag-ui") or {}
    a2ui_schema = ag_ui.get("a2ui_schema")
    if a2ui_schema:
        catalog_id = None
        try:
            parsed = (
                json.loads(a2ui_schema)
                if isinstance(a2ui_schema, str)
                else a2ui_schema
            )
            if isinstance(parsed, dict):
                catalog_id = parsed.get("catalogId")
        except (TypeError, ValueError):
            pass
        return None, catalog_id

    context = ag_ui.get("context") or []
    for entry in context:
        if not isinstance(entry, dict):
            continue
        description = entry.get("description") or ""
        value = entry.get("value") or ""
        if "A2UI catalog" not in description or not value:
            continue
        match = re.search(r"(?m)^\s*-\s+(\S+)", value)
        catalog_id = match.group(1) if match else None
        return value, catalog_id

    return None


# ---------------------------------------------------------------------------
# Prior surface lookup (used for intent="update")
# ---------------------------------------------------------------------------


class PriorSurface(TypedDict, total=False):
    components: list[dict[str, Any]]
    data: Any
    catalogId: Optional[str]


def _message_role_and_content(msg: Any) -> tuple[Optional[str], Any]:
    """Read a message's role/type and content from either an object or a dict.

    LangChain ToolMessage instances expose ``.type``/``.role``/``.content`` as
    attributes; messages that round-tripped through JSON arrive as plain dicts.
    Either shape needs to work — the prior-surface walker must not silently skip
    dict-shaped history.
    """
    if isinstance(msg, dict):
        role = msg.get("type") or msg.get("role")
        return role, msg.get("content")
    return (
        getattr(msg, "type", None) or getattr(msg, "role", None),
        getattr(msg, "content", None),
    )


def find_prior_surface(
    messages: list[Any], surface_id: str
) -> Optional[PriorSurface]:
    """Locate the most recent rendered state for ``surface_id`` in message history.

    Walks backwards over tool messages whose content is a JSON string containing
    ``a2ui_operations`` for the given surface, accumulating the most recent
    value of each field (``components``, ``data``, ``catalogId``) across the
    walk. A late-turn message that only emits ``updateDataModel`` no longer
    blanks the components / catalogId established by an earlier turn — the
    function returns the surface's *latest known state*, not just what the most
    recent matching message happened to carry.

    Accepts both object-shaped and dict-shaped messages.

    Returns the reconstructed ``{"components": [...], "data": ..., "catalogId": ...}``
    or ``None`` if no matching surface is found anywhere in history.
    """
    # Per-message end-state is computed FORWARD because the renderer applies
    # ops in document order. The last op affecting the surface in a message
    # determines that message's contribution — including ``deleteSurface``,
    # which wipes the surface. If the NEWEST message to mention the surface
    # ends in delete, return ``None``: older create/update ops are stale and
    # would resurrect a surface the renderer no longer shows.
    components: Optional[list[dict[str, Any]]] = None
    data: Any = None
    data_seen = False
    catalog_id: Optional[str] = None
    matched = False

    for msg in reversed(messages):
        role, content = _message_role_and_content(msg)
        if role not in ("tool", "ToolMessage"):
            continue
        if not isinstance(content, str):
            continue
        try:
            parsed = json.loads(content)
        except (ValueError, TypeError):
            continue
        if not isinstance(parsed, dict):
            continue
        ops = parsed.get(A2UI_OPERATIONS_KEY)
        if not isinstance(ops, list):
            continue

        # Compute this message's end state for surface_id by walking ops
        # forward. ``deleteSurface`` resets the per-message accumulator;
        # subsequent create / update ops in the same message restore it.
        msg_mentions = False
        msg_deleted = False
        msg_catalog_id: Optional[str] = None
        msg_components: Optional[list[dict[str, Any]]] = None
        msg_data: Any = None
        msg_data_seen = False

        for op in ops:
            if not isinstance(op, dict):
                continue
            if "deleteSurface" in op:
                ds = op["deleteSurface"]
                if isinstance(ds, dict) and ds.get("surfaceId") == surface_id:
                    msg_mentions = True
                    msg_deleted = True
                    msg_catalog_id = None
                    msg_components = None
                    msg_data = None
                    msg_data_seen = False
                    continue
            if "createSurface" in op:
                cs = op["createSurface"]
                if isinstance(cs, dict) and cs.get("surfaceId") == surface_id:
                    msg_mentions = True
                    msg_deleted = False
                    if isinstance(cs.get("catalogId"), str):
                        msg_catalog_id = cs["catalogId"]
            if "updateComponents" in op:
                uc = op["updateComponents"]
                if isinstance(uc, dict) and uc.get("surfaceId") == surface_id:
                    msg_mentions = True
                    msg_deleted = False
                    if isinstance(uc.get("components"), list):
                        msg_components = uc["components"]
            if "updateDataModel" in op:
                ud = op["updateDataModel"]
                if isinstance(ud, dict) and ud.get("surfaceId") == surface_id:
                    msg_mentions = True
                    msg_deleted = False
                    msg_data = ud.get("value")
                    msg_data_seen = True

        if not msg_mentions:
            continue

        if not matched:
            # Newest message that mentions the surface — its end state is
            # authoritative.
            if msg_deleted:
                return None
            matched = True
            catalog_id = msg_catalog_id
            components = msg_components
            data = msg_data
            data_seen = msg_data_seen
        else:
            # Older message: fill in only the fields not yet set. A delete
            # here is overridden by the newer state already recorded.
            if msg_deleted:
                continue
            if catalog_id is None and msg_catalog_id is not None:
                catalog_id = msg_catalog_id
            if components is None and msg_components is not None:
                components = msg_components
            if not data_seen and msg_data_seen:
                data = msg_data
                data_seen = True

        # Early-exit once every field is populated — nothing older can override.
        if matched and components is not None and catalog_id is not None and data_seen:
            return {"components": components, "data": data, "catalogId": catalog_id}

    if not matched:
        return None
    return {
        "components": components or [],
        "data": data,
        "catalogId": catalog_id,
    }


# ---------------------------------------------------------------------------
# Prompt assembly
# ---------------------------------------------------------------------------


class EditContext(TypedDict, total=False):
    surfaceId: str
    prior: PriorSurface
    changes: Optional[str]


# ---------------------------------------------------------------------------
# Subagent prompt guidelines (OSS-248)
#
# Re-enables the rich generation + design guidance the legacy
# ``copilotkit.a2ui.a2ui_prompt`` shipped. The two DEFAULT_* blocks are applied
# automatically (per-field) so subagent output is well-designed out of the box;
# a host overrides either block via ``A2UIGuidelines``. Pass an empty string to
# suppress a block entirely.
# ---------------------------------------------------------------------------

DEFAULT_GENERATION_GUIDELINES = """\
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
  "data": { "form": { "name": "Markus" } }"""
"""Default generation guidance (tool-call contract, id/path/data-binding rules).

Applied when ``A2UIGuidelines["generation_guidelines"]`` is unset (``None``).
Ported verbatim from the legacy ``copilotkit.a2ui`` defaults (OSS-248)."""

DEFAULT_DESIGN_GUIDELINES = """\
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

Use the SAME surfaceId as the main surface. Match action names to Button action event names."""
"""Default design guidance (visual hierarchy, layout, imagery, action format).

Applied when ``A2UIGuidelines["design_guidelines"]`` is unset (``None``).
Ported verbatim from the legacy ``copilotkit.a2ui`` defaults (OSS-248)."""


class A2UIGuidelines(TypedDict, total=False):
    """Prompt knobs threaded from the host through the adapter into the subagent
    prompt. The toolkit owns this shape so a new knob is added here (and rendered
    in ``build_subagent_prompt``) without editing any framework adapter — each
    adapter forwards this bag verbatim.

    Per-field semantics (mirrors the legacy ``a2ui_prompt`` defaults):
      - key absent / ``None``  → the built-in ``DEFAULT_*`` block is used.
      - ``""`` (empty string)  → that block is suppressed (no section emitted).
      - any other string       → replaces the default for that block.

    ``composition_guide`` has no default; it is appended only when provided.
    """

    generation_guidelines: Optional[str]
    design_guidelines: Optional[str]
    composition_guide: Optional[str]


def build_subagent_prompt(
    *,
    context_prompt: str,
    guidelines: Optional[A2UIGuidelines] = None,
    edit_context: Optional[EditContext] = None,
) -> str:
    """Compose the full subagent system prompt.

    Section order: generation guidelines → design guidelines → context (catalog)
    → composition guide → edit block. Faithful to the legacy ``a2ui_prompt``
    ordering (generation lead, design header, then available components).

    Args:
        context_prompt: Output of ``build_context_prompt(state)``.
        guidelines: Generation/design/composition prompt knobs. Generation and
            design fall back per-field to ``DEFAULT_GENERATION_GUIDELINES`` /
            ``DEFAULT_DESIGN_GUIDELINES`` when unset; an empty string suppresses
            the block.
        edit_context: When set, instructs the subagent to edit a prior surface
            in place (used by ``intent="update"``).
    """
    guidelines = guidelines or {}

    # Per-field fallback: ``None`` (or absent) → built-in default; ``""`` → the
    # host explicitly suppressed the block. ``.get()`` returns ``None`` for an
    # absent key, so both unset paths collapse to the default.
    generation = guidelines.get("generation_guidelines")
    if generation is None:
        generation = DEFAULT_GENERATION_GUIDELINES
    design = guidelines.get("design_guidelines")
    if design is None:
        design = DEFAULT_DESIGN_GUIDELINES
    composition_guide = guidelines.get("composition_guide")

    parts: list[str] = []
    if generation:
        parts.append(generation)
    if design:
        parts.append(f"## Design Guidelines\n{design}")
    if context_prompt:
        parts.append(context_prompt)
    if composition_guide:
        parts.append(composition_guide)

    if edit_context:
        surface_id = edit_context.get("surfaceId")
        prior = edit_context.get("prior") or {}
        changes = edit_context.get("changes")
        edit_block = (
            "## Editing an existing surface\n"
            f"You are editing surface '{surface_id}'. Produce the FULL "
            f"updated components array and data model — not just a diff. "
            f"Preserve component ids that the user has not asked to change so "
            f"the renderer can reconcile them. Reuse the same catalogId.\n\n"
            f"### Previous components\n"
            f"{json.dumps(prior.get('components', []), indent=2)}\n\n"
            f"### Previous data\n"
            f"{json.dumps(prior.get('data'), indent=2)}\n"
        )
        if changes:
            edit_block += f"\n### Requested changes\n{changes}\n"
        parts.append(edit_block)

    return "\n".join(p for p in parts if p)


# ---------------------------------------------------------------------------
# Operations envelope
# ---------------------------------------------------------------------------


def assemble_ops(
    *,
    intent: str,
    surface_id: str,
    catalog_id: str,
    components: list[dict[str, Any]],
    data: Optional[dict[str, Any]] = None,
) -> list[dict[str, Any]]:
    """Produce the final A2UI v0.9 operation list for a render result.

    ``intent="create"`` emits ``[createSurface, updateComponents, updateDataModel?]``.
    Any other intent (e.g. ``"update"``) skips ``createSurface`` so the
    frontend reconciles the existing surface in place rather than erroring
    (per v0.9 spec, ``createSurface`` on an existing id is invalid).
    """
    ops: list[dict[str, Any]] = []
    if intent != "update":
        ops.append(create_surface(surface_id, catalog_id))
    ops.append(update_components(surface_id, components))
    if data:
        ops.append(update_data_model(surface_id, data))
    return ops


def wrap_as_operations_envelope(ops: list[dict[str, Any]]) -> str:
    """Wrap a list of A2UI operations as the JSON envelope the A2UI middleware
    looks for in tool results."""
    return json.dumps({A2UI_OPERATIONS_KEY: ops})


def wrap_error_envelope(message: str) -> str:
    """Wrap an error as the JSON string a subagent tool returns when it can't
    produce a surface. Keeps the error shape consistent across frameworks."""
    return json.dumps({"error": message})


# ---------------------------------------------------------------------------
# Subagent-tool defaults (shared so every framework adapter advertises the
# same planner-facing surface and behaviour)
# ---------------------------------------------------------------------------

DEFAULT_SURFACE_ID = "dynamic-surface"
"""Surface id used when the subagent omits ``surfaceId`` on a create."""

GENERATE_A2UI_TOOL_NAME = "generate_a2ui"
"""Default name the outer A2UI tool is advertised under to the main planner."""

GENERATE_A2UI_TOOL_DESCRIPTION = (
    "Generate or update a dynamic A2UI surface based on the conversation. "
    "A secondary LLM designs the UI components and data. "
    "Use intent='create' (default) when the user requests new visual content "
    "(cards, forms, lists, dashboards, comparisons, etc.). "
    "Use intent='update' with target_surface_id to modify a surface you "
    "previously rendered (e.g. 'change the second card's price', "
    "'add a Buy button', 'use red instead of blue')."
)
"""Default description shown to the main agent's planner."""

GENERATE_A2UI_ARG_DESCRIPTIONS: dict[str, str] = {
    "intent": (
        "'create' to render a new surface; 'update' to modify a surface "
        "previously rendered in this conversation. Defaults to 'create'."
    ),
    "target_surface_id": (
        "Required when intent='update'. The surface id of the prior render to modify."
    ),
    "changes": (
        "Optional natural-language description of the changes to apply when intent='update'."
    ),
}
"""Planner-facing descriptions for the outer tool's three arguments."""


# ---------------------------------------------------------------------------
# Shared A2UI tool-factory params (OSS-248)
#
# One params shape, owned by the toolkit, consumed identically by every
# framework adapter. A framework's factory is always
# ``get_a2ui_tools(params: A2UIToolParams)`` — only the body (tool decorator,
# runtime/state accessor, model bind+invoke) differs per framework.
#
# ``model`` is the single framework-specific field (typed ``Any`` here so the
# toolkit stays framework-agnostic). Adding a new knob = add a field here (+ its
# default in ``resolve_a2ui_tool_params``) — NO adapter signature ever changes,
# and a brand-new framework adapter gets the knob for free on day one.
# ---------------------------------------------------------------------------


class A2UIToolParams(TypedDict, total=False):
    """Shared input shape for every framework's ``get_a2ui_tools`` factory."""

    model: Any  # required in practice; framework-specific chat model
    guidelines: Optional[A2UIGuidelines]
    default_surface_id: Optional[str]
    default_catalog_id: Optional[str]
    tool_name: Optional[str]
    tool_description: Optional[str]
    catalog: Optional[dict]
    recovery: Optional[dict]
    on_a2ui_attempt: Optional[Any]
    # ``tool_choice`` the render subagent binds the inner ``render_a2ui`` tool
    # with. Defaults to forcing that tool by name (``"render_a2ui"``) so the
    # subagent is guaranteed to emit a structured surface. Override to
    # ``"auto"`` for reasoning/"thinking-mode" models (e.g. Alibaba DashScope
    # ``qwen*`` with thinking enabled) that reject a forced/object ``tool_choice``
    # (reasoning-model thinking mode). Adapters that honor a runtime fallback only reach for this
    # when a caller wants to pin the behavior explicitly.
    tool_choice: Optional[Any]


class ResolvedA2UIToolParams(TypedDict):
    """``A2UIToolParams`` with every optional knob resolved to its effective
    value — returned by ``resolve_a2ui_tool_params`` so adapters never
    re-implement defaults."""

    model: Any
    guidelines: Optional[A2UIGuidelines]
    default_surface_id: str
    default_catalog_id: str
    tool_name: str
    tool_description: str
    catalog: Optional[dict]
    recovery: Optional[dict]
    on_a2ui_attempt: Optional[Any]
    tool_choice: Any


def resolve_a2ui_tool_params(params: A2UIToolParams) -> ResolvedA2UIToolParams:
    """Normalize ``A2UIToolParams`` into ``ResolvedA2UIToolParams``, filling the
    canonical defaults so each framework adapter stops re-implementing
    ``tool_name or DEFAULT`` / ``catalog_id or BASIC`` lines.

    Uses ``or`` (not ``is None``) so an accidental empty-string override falls
    back to the canonical default rather than advertising a nameless tool or
    emitting a blank surface/catalog id.
    """
    return {
        "model": params.get("model"),
        "guidelines": params.get("guidelines"),
        "default_surface_id": params.get("default_surface_id") or DEFAULT_SURFACE_ID,
        "default_catalog_id": params.get("default_catalog_id") or BASIC_CATALOG_ID,
        "tool_name": params.get("tool_name") or GENERATE_A2UI_TOOL_NAME,
        "tool_description": params.get("tool_description")
        or GENERATE_A2UI_TOOL_DESCRIPTION,
        "catalog": params.get("catalog"),
        "recovery": params.get("recovery"),
        "on_a2ui_attempt": params.get("on_a2ui_attempt"),
        # Forced-render by default; ``or`` (not ``is None``) so an empty-string
        # override falls back to the forced default rather than binding a blank
        # (invalid) tool choice.
        "tool_choice": params.get("tool_choice") or RENDER_A2UI_TOOL_DEF["function"]["name"],
    }


# ---------------------------------------------------------------------------
# High-level orchestration
#
# These two functions hold the entire create/update decision + prompt prep +
# result-assembly logic so every framework adapter is reduced to pure glue
# (tool decorator, state access, model bind+invoke, tool-call read).
# ---------------------------------------------------------------------------


class PreparedA2UIRequest(TypedDict, total=False):
    prompt: str
    is_update: bool
    prior: Optional[PriorSurface]
    error: Optional[str]


def prepare_a2ui_request(
    *,
    intent: Optional[str],
    target_surface_id: Optional[str],
    changes: Optional[str],
    messages: list[Any],
    state: dict,
    guidelines: Optional[A2UIGuidelines] = None,
) -> PreparedA2UIRequest:
    """Resolve the create/update decision, locate any prior surface, and build
    the subagent system prompt.

    ``guidelines`` is forwarded verbatim to ``build_subagent_prompt`` — the
    toolkit owns the shape so adapters never need editing when a knob is added.

    Returns a dict with ``error`` set (and no ``prompt``) when the request is
    invalid — an ``update`` referencing a surface not found in history.
    """
    resolved_intent = intent or "create"
    is_update = resolved_intent == "update" and bool(target_surface_id)

    # is_update being True already narrows target_surface_id to non-empty str;
    # assert it explicitly so a type checker sees the same narrowing the runtime
    # condition guarantees, without resorting to a blanket type: ignore.
    if is_update:
        assert target_surface_id is not None
        prior = find_prior_surface(messages, target_surface_id)
    else:
        prior = None

    if is_update and prior is None:
        # Match TS shape: omit ``prior`` from the error branch so presence
        # checks like ``"prior" in prep`` distinguish success from failure.
        return {
            "prompt": "",
            "is_update": is_update,
            "error": (
                f"intent='update' requested target_surface_id="
                f"'{target_surface_id}' but no prior render of that surface "
                f"was found in conversation history"
            ),
        }

    prompt = build_subagent_prompt(
        context_prompt=build_context_prompt(state),
        guidelines=guidelines,
        edit_context=(
            {"surfaceId": target_surface_id, "prior": prior, "changes": changes}
            if prior is not None
            else None
        ),
    )

    # Omit ``error`` on success so ``"error" in prep`` is a meaningful presence
    # check (matches the TS counterpart which only returns the key on failure).
    return {"prompt": prompt, "is_update": is_update, "prior": prior}


def build_a2ui_envelope(
    *,
    args: dict[str, Any],
    is_update: bool,
    target_surface_id: Optional[str],
    prior: Optional[PriorSurface],
    default_surface_id: str = DEFAULT_SURFACE_ID,
    default_catalog_id: str = BASIC_CATALOG_ID,
) -> str:
    """Turn the subagent's structured output into the final operations envelope.

    Catalog ownership stays with the host: the subagent never picks a catalog,
    so the id comes from the prior surface (update) or the configured default
    (create) — never from the model's args.
    """
    # Treat empty-string defaults as unset (mirror the TS guard). Without this,
    # a misconfigured host passing ``""`` for default_surface_id /
    # default_catalog_id would propagate the empty string into the emitted ops
    # and surface as "Catalog not found: " / blank surface ids at render time,
    # hiding the real cause.
    safe_default_surface_id = default_surface_id or DEFAULT_SURFACE_ID
    safe_default_catalog_id = default_catalog_id or BASIC_CATALOG_ID

    # Narrow args["surfaceId"] to a non-empty STRING — the model is untrusted
    # and may return ``null``, a number, a list, or an empty string. Without
    # this, those values propagate into ``createSurface.surfaceId`` and the
    # renderer either crashes or silently mounts to an unreachable surface
    # id. Mirrors the TS narrow (``typeof === "string" && length > 0``).
    raw_arg_surface_id = args.get("surfaceId")
    arg_surface_id = (
        raw_arg_surface_id
        if isinstance(raw_arg_surface_id, str) and len(raw_arg_surface_id) > 0
        else ""
    )
    if is_update:
        surface_id = target_surface_id or safe_default_surface_id
    else:
        surface_id = arg_surface_id or safe_default_surface_id
    catalog_id = (prior or {}).get("catalogId") or safe_default_catalog_id
    # Narrow to the documented shapes — the model's args are untrusted.
    raw_components = args.get("components")
    components = raw_components if isinstance(raw_components, list) else []
    raw_data = args.get("data")
    data = raw_data if isinstance(raw_data, dict) else {}

    ops = assemble_ops(
        intent="update" if is_update else "create",
        surface_id=surface_id,
        catalog_id=catalog_id,
        components=components,
        data=data,
    )

    return wrap_as_operations_envelope(ops)
