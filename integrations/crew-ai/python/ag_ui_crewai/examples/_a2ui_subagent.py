"""Shared subagent-driven A2UI turn for the dynamic-schema and recovery demos.

Both demos are plain agentic-chat flows with no A2UI tool wired: the frontend
a2ui middleware forwards ``injectA2UITool`` and the adapter auto-injects
``generate_a2ui``, which designs surfaces against the dojo's dynamic catalog and
validates/retries each one. The two feature flows differ only in name; recovery
is inherent to the toolkit loop, so they share this turn.
"""

import json
import logging

from litellm import acompletion

from ..sdk import copilotkit_stream
from ..a2ui_tool import apply_a2ui_plan_to_tools, plan_a2ui_injection

logger = logging.getLogger("ag_ui_crewai")

MODEL = "openai/gpt-4o"

# The dojo registers its dynamic component catalog (Row / HotelCard /
# ProductCard / TeamMemberCard) under this id; auto-injected surfaces must
# reference it so the renderer can resolve their components.
DOJO_DYNAMIC_CATALOG_ID = "https://a2ui.org/demos/dojo/dynamic_catalog.json"

# Teaches the sub-agent how to compose the dojo catalog's components. Mirrors
# the LangGraph / Strands dynamic-schema demos so a real model produces valid
# surfaces.
COMPOSITION_GUIDE = """
## Available Pre-made Components

The catalog has EXACTLY four components: Row, HotelCard, ProductCard,
TeamMemberCard. Use ONLY these. Do NOT use Column, Text, Card, Container, List,
Stack, or any other component - they are not in the catalog and the renderer
rejects them with "Unknown component".

### Row  (the ONLY layout container; must be the root)
Repeats a card template per item via structural children:
  {"id":"root","component":"Row","children":{"componentId":"card","path":"/items"}}

### HotelCard
Props: name, location, rating (number 0-5), pricePerNight, action

### ProductCard
Props: name, price, rating (number 0-5), description (optional), action

### TeamMemberCard
Props: name, role, department (optional), email (optional), action

## RULES
- The root component MUST have id "root" and component "Row". Do NOT wrap it in
  a Column or any other component - Row is the top-level container itself.
- Root is ALWAYS: {"id":"root","component":"Row","children":{"componentId":"<card-id>","path":"/items"}}
- ALWAYS include the referenced card component in the components array.
- Inside templates use RELATIVE paths (no leading slash): {"path":"name"}.
- Always provide data in the "data" argument as {"items":[...]}.
- Pick the ONE card type that best matches the request; generate 3-4 realistic items.
- The components array contains EXACTLY two entries: the root Row and the card.
"""

SYSTEM_PROMPT = (
    "You are a helpful assistant that creates rich visual UI on the fly. When "
    "the user asks for visual content (product comparisons, dashboards, team "
    "rosters, lists, cards, etc.), use the generate_a2ui tool to create a "
    "dynamic A2UI surface. After calling the tool, do NOT repeat the data in "
    "your text response; the tool renders the UI automatically. Just confirm "
    "what was rendered."
)

# Backend A2UI config: teach the sub-agent the dojo catalog and bind surfaces to
# it. The catalog id is also resolved from the frontend-sent schema, but naming
# it here keeps the demo self-describing.
A2UI_CONFIG = {
    "default_catalog_id": DOJO_DYNAMIC_CATALOG_ID,
    "guidelines": {"composition_guide": COMPOSITION_GUIDE},
}


async def run_a2ui_subagent_turn(state) -> None:
    """One agentic-chat turn with A2UI auto-injection: swap the injected render
    proxy for generate_a2ui, stream the model, and run generate_a2ui (sub-agent
    generation + progressive streaming + recovery) when the model calls it."""
    actions = (state.get("copilotkit") or {}).get("actions") or []
    existing_names = [
        a["function"]["name"]
        for a in actions
        if isinstance(a, dict)
        and isinstance(a.get("function"), dict)
        and a["function"].get("name")
    ]

    plan = plan_a2ui_injection(
        model=MODEL,
        state=state,
        existing_tool_names=existing_names,
        config=A2UI_CONFIG,
    )
    tools = apply_a2ui_plan_to_tools(actions, plan)
    tool_kwargs = {"tools": tools, "parallel_tool_calls": False} if tools else {}

    response = await copilotkit_stream(
        await acompletion(
            model=MODEL,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                *state["messages"],
            ],
            stream=True,
            **tool_kwargs,
        )
    )
    message = response.choices[0].message
    # Stamp the streamed message id onto the persisted assistant message so the
    # terminal MESSAGES_SNAPSHOT updates it in place instead of re-appending it
    # (a fresh id would re-anchor the generate_a2ui tool-call chip AFTER the
    # already-streamed surface activity - the tool card would jump to the end).
    assistant = message.model_dump()
    stream_id = getattr(response, "id", None)
    if stream_id:
        assistant["id"] = stream_id
    state["messages"].append(assistant)

    if not (plan and message.tool_calls):
        return

    for tool_call in message.tool_calls:
        if tool_call.function.name != plan["tool_name"]:
            continue
        try:
            args = json.loads(tool_call.function.arguments or "{}")
        except (json.JSONDecodeError, TypeError):
            logger.warning(
                "generate_a2ui tool-call args were not valid JSON; "
                "generating with defaults: %r",
                tool_call.function.arguments,
            )
            args = {}
        # run() emits its own TOOL_CALL_RESULT (given the outer call id) so the
        # middleware closes the call in render order and, on exhaustion, paints
        # the hard-failure - a flow can't leave it stuck at "building".
        envelope = await plan["tool"].run(args, tool_call_id=tool_call.id)
        state["messages"].append(
            {"role": "tool", "content": envelope, "tool_call_id": tool_call.id}
        )
