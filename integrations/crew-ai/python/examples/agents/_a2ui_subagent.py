"""Shared subagent-driven A2UI turn for the dynamic-schema and recovery demos.

Both demos are plain agentic-chat flows with no A2UI tool wired: the frontend
a2ui middleware forwards ``injectA2UITool`` and the adapter auto-injects
``generate_a2ui``, which designs surfaces against the dojo's dynamic catalog and
validates/retries each one. The two feature flows differ only in name; recovery
is inherent to the toolkit loop, so they share this turn.
"""

import json
import logging
import uuid

from litellm import acompletion

from ag_ui_crewai._config import resolve_provider_timeout_seconds
from ag_ui_crewai.sdk import copilotkit_stream
from ag_ui_crewai.a2ui_tool import apply_a2ui_plan_to_tools, plan_a2ui_injection
from ._model_turn import (
    append_assistant_message,
    frontend_tool_names,
    resolve_client_tools,
    sort_tool_calls,
)

logger = logging.getLogger("ag_ui_crewai")

MODEL = "openai/gpt-5.4"

# Model turns per run: one generation plus its closing reply, with headroom for
# a second surface the user asked for in the same breath. Bounded so a model that
# keeps calling the tool cannot spin the run.
MAX_MODEL_TURNS = 4

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
Example:
  {"id":"card","component":"HotelCard","name":{"path":"name"},"location":{"path":"location"},
   "rating":{"path":"rating"},"pricePerNight":{"path":"pricePerNight"},
   "action":{"event":{"name":"book_hotel","context":{"name":{"path":"name"},"pricePerNight":{"path":"pricePerNight"}}}}}

### ProductCard
Props: name, price, rating (number 0-5), description (optional), action
Example:
  {"id":"card","component":"ProductCard","name":{"path":"name"},"price":{"path":"price"},
   "rating":{"path":"rating"},"description":{"path":"description"},
   "action":{"event":{"name":"select_product","context":{"name":{"path":"name"},"price":{"path":"price"}}}}}

### TeamMemberCard
Props: name, role, department (optional), email (optional), action
Example:
  {"id":"card","component":"TeamMemberCard","name":{"path":"name"},"role":{"path":"role"},
   "department":{"path":"department"},"email":{"path":"email"},
   "action":{"event":{"name":"contact_member","context":{"name":{"path":"name"},"email":{"path":"email"}}}}}

## RULES
- The root component MUST have id "root" and component "Row". Do NOT wrap it in
  a Column or any other component - Row is the top-level container itself.
- Root is ALWAYS: {"id":"root","component":"Row","children":{"componentId":"<card-id>","path":"/items"}}
- ALWAYS include the referenced card component in the components array.
- Inside templates use RELATIVE paths (no leading slash): {"path":"name"}.
- Every card MUST carry an "action", ALWAYS as an OBJECT of the form
  {"event":{"name":"<verb>","context":{...}}}. A bare string, or a missing
  action, renders a button that fires nothing.
- The action "context" MUST bind the fields a reply needs to name the chosen
  item, as relative paths: at minimum {"name":{"path":"name"}}, plus whatever
  else identifies the choice (price, email). The click is forwarded to the model
  as the action name and this context and nothing else, so a field left out
  cannot be mentioned in the answer.
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
    "what was rendered.\n\n"
    "The conversation may already contain a report that the user interacted with "
    "a surface you rendered earlier (clicked an action button, for example). That "
    "report is history, not a request for another surface: do NOT generate one and "
    "do NOT call any tool. Reply in text, naming the specific item the user chose "
    "and what happens next."
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
    generation + progressive streaming + recovery) when the model calls it.

    Loops the model over its own tool results (bounded by ``MAX_MODEL_TURNS``)
    so a turn that ends in a backend tool call still gets a closing model reply.

    What the loop does for a user action on a rendered surface, precisely: the
    middleware appends the action and its report to the NEXT run's input, so the
    report is already in history on the first turn and a model that answers it in
    text needs no loop at all. The loop saves the case the live model actually
    takes: it tool-calls FIRST (generating another surface), which without a loop
    would end the run on that call and leave the user's choice unacknowledged.
    """
    actions = (state.get("copilotkit") or {}).get("actions") or []
    existing_names = frontend_tool_names(actions)

    for _ in range(MAX_MODEL_TURNS):
        # Plan per turn, not once before the loop: the plan snapshots the
        # conversation it hands the render sub-agent, so a plan reused on turn 2
        # would show the sub-agent the turn-1 history - no assistant message, no
        # tool result, no action report. An in-run "update" would then find no
        # prior surface (hard failure) and a second create would be designed
        # blind to the first. Planning is local (no I/O), so this is cheap; None
        # still means "no injection".
        # A model DICT, not the bare id: the render sub-agent's completion is
        # built from these kwargs, and a bare id carries no timeout - leaving the
        # sub-agent and its recovery retries unbounded.
        plan = plan_a2ui_injection(
            model={"model": MODEL, "timeout": resolve_provider_timeout_seconds()},
            state=state,
            existing_tool_names=existing_names,
            config=A2UI_CONFIG,
        )
        backend_names = {plan["tool_name"]} if plan else set()
        # Which forwarded tools the client may answer comes from the PLAN, not
        # from a hardcoded name: the render proxy the plan swaps out is not on the
        # model's tool list, so a call to it must not end the run as a frontend
        # call (that would hand the render to the client and skip the generate
        # tool's validate/retry loop). With no plan, that same proxy is the only
        # renderer there is and stays a frontend tool.
        offered, client_names = resolve_client_tools(
            actions,
            backend_names=backend_names,
            drop_names=(plan.get("drop_tool_names") or ()) if plan else (),
        )
        tools = apply_a2ui_plan_to_tools(offered, plan)
        tool_kwargs = {"tools": tools, "parallel_tool_calls": False} if tools else {}

        response = await copilotkit_stream(
            await acompletion(
                timeout=resolve_provider_timeout_seconds(),
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
        tool_calls = message.tool_calls or []
        # An orphan call (a name neither generate_a2ui nor a frontend tool) is
        # answered by nobody, so it is dropped instead of persisted: an assistant
        # tool_calls entry with no matching tool result 400s every later run on
        # this thread.
        backend, client, orphan = sort_tool_calls(
            tool_calls,
            backend_names=backend_names,
            client_names=client_names,
        )
        append_assistant_message(
            state, response, message, drop_indexes={i for i, _ in orphan}
        )

        if not tool_calls:
            return

        for _, tool_call in backend:
            try:
                args = json.loads(tool_call.function.arguments or "{}")
            except (json.JSONDecodeError, TypeError):
                logger.warning(
                    "generate_a2ui tool-call args were not valid JSON; "
                    "generating with defaults: %r",
                    tool_call.function.arguments,
                )
                args = {}
            # run() emits its own TOOL_CALL_RESULT (given the outer call id) so
            # the middleware closes the call in render order and, on exhaustion,
            # paints the hard-failure - a flow can't leave it stuck at
            # "building". One id for that streamed result and the message
            # persisted here: the terminal MESSAGES_SNAPSHOT then updates the
            # message in place instead of minting a second id, which would
            # remount the surface card the client just painted.
            result_id = str(uuid.uuid4())
            envelope = await plan["tool"].run(
                args, tool_call_id=tool_call.id, result_message_id=result_id
            )
            state["messages"].append(
                {
                    "id": result_id,
                    "role": "tool",
                    "content": envelope,
                    "tool_call_id": tool_call.id,
                }
            )

        # A frontend call ends the run so the client can run it and send the
        # result back on the next one; feeding the model again here would leave
        # that call unanswered. An orphan call does NOT end the run: it was
        # dropped, so the history is well-formed, and ending here would cost the
        # user a reply. The model gets another turn to answer in text instead,
        # bounded by MAX_MODEL_TURNS.
        if client:
            return

    logger.warning(
        "A2UI turn hit the %d-model-turn cap with the model still calling tools; "
        "ending the run without a closing reply",
        MAX_MODEL_TURNS,
    )
