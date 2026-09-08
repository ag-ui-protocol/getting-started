"""A2UI Dynamic Schema feature (OSS-158).

ADK port of the LangGraph ``a2ui_dynamic_schema`` example, using the adapter's
A2UI **auto-injection**: the ``LlmAgent`` wires no A2UI tool itself. When the
runtime forwards ``injectA2UITool``, the ADKAgent injects ``generate_a2ui``
onto the agent and infers the sub-agent model from the agent's
``canonical_model``. Inside the tool, a forced ``render_a2ui`` sub-agent
generates a v0.9 A2UI surface and the toolkit's validate->retry recovery loop
runs. The result is wrapped as ``a2ui_operations``, which the A2UI middleware
detects in the tool result and renders automatically.
"""

from __future__ import annotations

from fastapi import FastAPI
from google.adk.agents import LlmAgent

from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint

# Catalog the dojo renders this demo against (HotelCard / ProductCard /
# TeamMemberCard / Row). The client (dojo page) supplies the catalog via the
# CopilotKit `a2ui` prop; the middleware injects it into the run, and the adapter
# renders it into the sub-agent prompt (Google's render_as_llm_instructions) and
# validates against it (toolkit, structural/lenient). The subagent never picks one.
CUSTOM_CATALOG_ID = "https://a2ui.org/demos/dojo/dynamic_catalog.json"

# Project-specific composition rules — tells the subagent how to use the
# pre-made domain components shipped in the dojo's dynamic catalog. Kept
# byte-identical to the LangGraph python example so both integrations behave
# the same for a given prompt.
COMPOSITION_GUIDE = """
## Available Pre-made Components

You have 4 components. Use Row as the root with structural children to repeat a card per item.

### Row
Layout container. Use structural children to repeat a card template:
  {"id":"root","component":"Row","children":{"componentId":"card","path":"/items"}}

### HotelCard
Props: name, location, rating (number 0-5), pricePerNight, amenities (optional), action
Example:
  {"id":"card","component":"HotelCard","name":{"path":"name"},"location":{"path":"location"},
   "rating":{"path":"rating"},"pricePerNight":{"path":"pricePerNight"},
   "action":{"event":{"name":"book","context":{"name":{"path":"name"}}}}}

### ProductCard
Props: name, price, rating (number 0-5), description (optional), badge (optional), action
Example:
  {"id":"card","component":"ProductCard","name":{"path":"name"},"price":{"path":"price"},
   "rating":{"path":"rating"},"description":{"path":"description"},
   "action":{"event":{"name":"select","context":{"name":{"path":"name"}}}}}

### TeamMemberCard
Props: name, role, department (optional), email (optional), avatarUrl (optional), action
Example:
  {"id":"card","component":"TeamMemberCard","name":{"path":"name"},"role":{"path":"role"},
   "department":{"path":"department"},"email":{"path":"email"},
   "action":{"event":{"name":"contact","context":{"name":{"path":"name"}}}}}

## RULES
- Root is ALWAYS a Row with structural children: {"componentId":"<card-id>","path":"/items"}
- Inside templates, use RELATIVE paths (no leading slash): {"path":"name"} not {"path":"/name"}
- Always provide data in the "data" argument as {"items":[...]}
- Pick the card type that best matches the user's request
- Generate 3-4 realistic items with diverse data
"""

SYSTEM_PROMPT = """You are a helpful assistant that creates rich visual UI on the fly.

When the user asks for visual content (product comparisons, dashboards, lists, cards, etc.),
use the generate_a2ui tool to create a dynamic A2UI surface.
When the user asks to MODIFY a surface you already rendered, call generate_a2ui with
intent="update" and target_surface_id set to that surface's id.
IMPORTANT: After calling the tool, do NOT repeat the data in your text response. The tool renders UI automatically. Just confirm what was rendered."""

# gemini-2.5-pro reliably produces valid, in-catalog A2UI for this demo. The
# auto-injected generate_a2ui tool infers its sub-agent model from this agent's
# canonical_model (the registry resolves the string to a Gemini instance).
_MODEL = "gemini-2.5-pro"

dynamic_schema_agent = LlmAgent(
    model=_MODEL,
    name="a2ui_dynamic_schema",
    instruction=SYSTEM_PROMPT,
    # generate_a2ui is auto-injected by the adapter; nothing wired here.
)

adk_a2ui_dynamic_schema = ADKAgent(
    adk_agent=dynamic_schema_agent,
    app_name="demo_app",
    user_id="demo_user",
    session_timeout_seconds=3600,
    use_in_memory_services=True,
    # Optional A2UI preferences; the runtime's injectA2UITool flag (forwarded by
    # the dojo's per-agent A2UIMiddleware) triggers injection and the adapter
    # renders these into the sub-agent prompt.
    a2ui={
        "default_catalog_id": CUSTOM_CATALOG_ID,
        "guidelines": {"composition_guide": COMPOSITION_GUIDE},
    },
)

app = FastAPI(title="ADK Middleware A2UI Dynamic Schema")
add_adk_fastapi_endpoint(app, adk_a2ui_dynamic_schema, path="/")
