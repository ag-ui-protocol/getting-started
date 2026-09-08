"""
Dynamic A2UI tool: LLM-generated UI from conversation context.

A secondary LLM generates v0.9 A2UI components via a structured tool call.
The generate_a2ui tool wraps the output as a2ui_operations, which the
middleware detects in the TOOL_CALL_RESULT and renders automatically.
"""

import os
import sys

from langchain.agents import create_agent
from langchain_openai import ChatOpenAI
from ag_ui_langgraph import get_a2ui_tools

CUSTOM_CATALOG_ID = "https://a2ui.org/demos/dojo/dynamic_catalog.json"

# Project-specific composition rules — tells the subagent how to use the
# pre-made domain components (HotelCard, ProductCard, TeamMemberCard) shipped
# in the dojo's dynamic catalog.
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

base_model = ChatOpenAI(model="gpt-4o")

TOOLS = [
    get_a2ui_tools(
        {
            "model": base_model,
            "default_catalog_id": CUSTOM_CATALOG_ID,
            "guidelines": {"composition_guide": COMPOSITION_GUIDE},
        }
    )
]


SYSTEM_PROMPT = """You are a helpful assistant that creates rich visual UI on the fly.

When the user asks for visual content (product comparisons, dashboards, lists, cards, etc.),
use the generate_a2ui tool to create a dynamic A2UI surface.
IMPORTANT: After calling the tool, do NOT repeat the data in your text response. The tool renders UI automatically. Just confirm what was rendered."""


# Converted from a manual StateGraph + ToolNode to create_agent to isolate the
# graph-shape variable in the A2UI-streaming investigation. The same
# get_a2ui_tools tool is bound directly (NOT auto-injected via
# CopilotKitMiddleware), so the ONLY difference vs the prior version is
# StateGraph -> create_agent.
is_fast_api = os.environ.get("LANGGRAPH_FAST_API", "false").lower() == "true"

if is_fast_api:
    from langgraph.checkpoint.memory import MemorySaver

    graph = create_agent(
        model=base_model,
        tools=TOOLS,
        system_prompt=SYSTEM_PROMPT,
        checkpointer=MemorySaver(),
    )
else:
    graph = create_agent(
        model=base_model,
        tools=TOOLS,
        system_prompt=SYSTEM_PROMPT,
    )
