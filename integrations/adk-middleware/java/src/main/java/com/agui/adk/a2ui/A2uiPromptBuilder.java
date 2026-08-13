package com.agui.adk.a2ui;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Sub-agent prompt assembly — behaviorally identical port of the toolkit's
 * {@code build_context_prompt} + {@code build_subagent_prompt} + {@code prepare_a2ui_request}
 * ({@code ag_ui_a2ui_toolkit/__init__.py}).
 *
 * <p>Section order (faithful to the legacy {@code a2ui_prompt}): generation guidelines → design
 * guidelines → context (catalog) → composition guide → edit block. Generation and design fall back
 * per-field to the ported {@link #DEFAULT_GENERATION_GUIDELINES} /
 * {@link #DEFAULT_DESIGN_GUIDELINES} when unset; an empty string suppresses the block. An
 * {@code update} targeting a surface absent from history yields an error (no prompt).
 */
public final class A2uiPromptBuilder {

    private A2uiPromptBuilder() {
    }

    /** Default generation guidance (tool-call contract, id/path/data-binding rules) — ported verbatim. */
    static final String DEFAULT_GENERATION_GUIDELINES = """
\\
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
  "data": { "form": { "name": "Markus" } }""";

    /** Default design guidance (visual hierarchy, layout, imagery, action format) — ported verbatim. */
    static final String DEFAULT_DESIGN_GUIDELINES = """
\\
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

Use the SAME surfaceId as the main surface. Match action names to Button action event names.""";

    /** Resolved create/update decision: the sub-agent prompt plus the prior surface (update). */
    public record Prepared(String prompt, boolean isUpdate, Map<String, Object> prior, String error) {
    }

    /**
     * Resolves the create/update decision, locates any prior surface, and builds the sub-agent
     * system prompt (port of {@code prepare_a2ui_request}).
     *
     * @param intent          the requested intent (may be null → {@code create})
     * @param targetSurfaceId the target surface id for an update (may be null)
     * @param changes         natural-language update changes (may be null)
     * @param messages        normalized AG-UI message history (A2UI tool results canonicalized)
     * @param state           the {@code {"ag-ui": {context, a2ui_schema?}}} state map
     * @param guidelines      generation/design/composition prompt knobs (may be null)
     * @return {@code Prepared} with {@code error} set (and no prompt) when an update targets an
     *         unknown surface
     */
    public static Prepared prepare(String intent, String targetSurfaceId, String changes,
                                   List<? extends com.agui.community.core.message.Message> messages,
                                   Map<String, Object> state,
                                   Map<String, Object> guidelines) {
        String resolvedIntent = (intent == null || intent.isEmpty()) ? "create" : intent;
        boolean isUpdate = "update".equals(resolvedIntent)
                && targetSurfaceId != null && !targetSurfaceId.isEmpty();

        Map<String, Object> prior = null;
        if (isUpdate) {
            prior = A2uiHistory.findPriorSurface(messages, targetSurfaceId);
        }
        if (isUpdate && prior == null) {
            return new Prepared("", true, null,
                    "intent='update' requested target_surface_id='"
                            + targetSurfaceId
                            + "' but no prior render of that surface was found in conversation history");
        }

        String prompt = buildSubagentPrompt(
                buildContextPrompt(state),
                guidelines,
                prior == null ? null
                        : new EditContext(targetSurfaceId, prior, changes));
        return new Prepared(prompt, isUpdate, prior, null);
    }

    /** Edit context for the prompt's previous-surface block. */
    public record EditContext(String surfaceId, Map<String, Object> prior, String changes) {
    }

    /**
     * Assembles the context prompt prefix from AG-UI state context entries + the A2UI component
     * catalog (port of {@code build_context_prompt}): regular context entries render as
     * {@code "## {description}
{value}
"}, the routed schema renders as
     * {@code "## Available Components
{a2ui_schema}
"}.
     *
     * @param state the {@code {"ag-ui": ...}} state map
     * @return the context prompt section
     */
    @SuppressWarnings("unchecked")
    static String buildContextPrompt(Map<String, Object> state) {
        Map<String, Object> agUi = state == null ? Map.of() : state.get("ag-ui") instanceof Map<?, ?> m
                ? (Map<String, Object>) m : Map.of();
        List<String> parts = new ArrayList<>();

        Object rawContext = agUi.get("context");
        if (rawContext instanceof List<?> context) {
            for (Object entryObj : context) {
                Object description = null;
                Object value = null;
                if (entryObj instanceof Map<?, ?> entry) {
                    description = entry.get("description");
                    value = entry.get("value");
                }
                // Mirror the TS toolkit: a null value with a description must NOT leak "None".
                String valueStr = value == null ? "" : String.valueOf(value);
                if (description != null && !String.valueOf(description).isEmpty()) {
                    parts.add("## " + description + "\n" + valueStr + "\n");
                } else if (!valueStr.isEmpty()) {
                    parts.add(valueStr + "\n");
                }
            }
        }

        Object a2uiSchema = agUi.get("a2ui_schema");
        if (truthy(a2uiSchema)) {
            parts.add("## Available Components\n" + a2uiSchema + "\n");
        }
        return String.join("\n", parts);
    }

    /**
     * Composes the full subagent system prompt (port of {@code build_subagent_prompt}).
     *
     * @param contextPrompt the context prompt section
     * @param guidelines    generation/design/composition knobs (may be null)
     * @param editContext   previous-surface edit context for an update (may be null)
     * @return the assembled prompt
     */
    static String buildSubagentPrompt(String contextPrompt, Map<String, Object> guidelines,
                                      EditContext editContext) {
        Map<String, Object> g = guidelines == null ? Map.of() : guidelines;

        Object generation = g.get("generation_guidelines");
        if (generation == null) {
            generation = DEFAULT_GENERATION_GUIDELINES;
        }
        Object design = g.get("design_guidelines");
        if (design == null) {
            design = DEFAULT_DESIGN_GUIDELINES;
        }
        Object compositionGuide = g.get("composition_guide");

        List<String> parts = new ArrayList<>();
        if (truthy(generation)) {
            parts.add(String.valueOf(generation));
        }
        if (truthy(design)) {
            parts.add("## Design Guidelines\n" + design);
        }
        if (contextPrompt != null && !contextPrompt.isEmpty()) {
            parts.add(contextPrompt);
        }
        if (truthy(compositionGuide)) {
            parts.add(String.valueOf(compositionGuide));
        }

        if (editContext != null) {
            parts.add(buildEditBlock(editContext));
        }

        List<String> kept = new ArrayList<>();
        for (String part : parts) {
            if (part != null && !part.isEmpty()) {
                kept.add(part);
            }
        }
        return String.join("\n", kept);
    }

    /**
     * Builds the previous-surface edit block (port of the toolkit's {@code edit_context} section):
     * full components/data regeneration instructions plus the prior surface JSON (indent-2, matching
     * {@code json.dumps(..., indent=2)}).
     *
     * @param edit the edit context
     * @return the edit block text
     */
    private static String buildEditBlock(EditContext edit) {
        Map<String, Object> prior = edit.prior() == null ? Map.of() : edit.prior();
        Object priorComponents = prior.getOrDefault("components", List.of());
        Object priorData = prior.get("data");

        StringBuilder sb = new StringBuilder();
        sb.append("## Editing an existing surface\n");
        sb.append("You are editing surface '").append(edit.surfaceId())
                .append("'. Produce the FULL updated components array and data model — not just a diff. ")
                .append("Preserve component ids that the user has not asked to change so the renderer can ")
                .append("reconcile them. Reuse the same catalogId.\n\n");
        sb.append("### Previous components\n");
        sb.append(PythonJson.stringifyIndent2(priorComponents)).append("\n\n");
        sb.append("### Previous data\n");
        sb.append(PythonJson.stringifyIndent2(priorData)).append("\n");
        if (edit.changes() != null && !edit.changes().isEmpty()) {
            sb.append("\n### Requested changes\n").append(edit.changes()).append("\n");
        }
        return sb.toString();
    }

    /**
     * Python truthiness: non-null scalars and non-empty strings/iterables/maps are truthy.
     *
     * @param value the value to test
     * @return whether the value is Python-truthy
     */
    private static boolean truthy(Object value) {
        if (value == null) {
            return false;
        }
        if (value instanceof Boolean b) {
            return b;
        }
        if (value instanceof String s) {
            return !s.isEmpty();
        }
        if (value instanceof Number n) {
            return n.doubleValue() != 0;
        }
        if (value instanceof Iterable<?> it) {
            return it.iterator().hasNext();
        }
        if (value instanceof Map<?, ?> m) {
            return !m.isEmpty();
        }
        return true;
    }
}
