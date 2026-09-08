"""Dynamic A2UI example for AWS Strands.

A plain agent with no a2ui wiring. When the runtime enables A2UI tool
injection, the adapter auto-injects ``generate_a2ui`` and renders surfaces
generated from the conversation.
"""
import os
from pathlib import Path
from dotenv import load_dotenv

# Suppress OpenTelemetry context warnings from Strands SDK
os.environ["OTEL_SDK_DISABLED"] = "true"
os.environ["OTEL_PYTHON_DISABLED_INSTRUMENTATIONS"] = "all"

from strands import Agent
from ag_ui_strands import StrandsAgent, StrandsAgentConfig, create_strands_app
from server.model_factory import create_model
from server.settings import cors_origins

# Load environment variables from .env file
env_path = Path(__file__).parent.parent.parent / '.env'
load_dotenv(dotenv_path=env_path)

# The dojo registers its dynamic component catalog (HotelCard, ProductCard,
# TeamMemberCard) under this id; auto-injected surfaces must reference it so
# the renderer can resolve their components.
DOJO_CATALOG_ID = "https://a2ui.org/demos/dojo/dynamic_catalog.json"

# Teaches the sub-agent how to compose the dojo catalog's components. Mirrors
# the LangGraph dynamic-schema demo's COMPOSITION_GUIDE so a real model (not
# just the e2e mock) can produce valid surfaces.
COMPOSITION_GUIDE = """
## Available Pre-made Components

You have 3 card components. Use Row as the root with structural children to
repeat a card per item.

### Row
Layout container. Repeat a card template via structural children:
  {"id":"root","component":"Row","children":{"componentId":"card","path":"/items"}}

### HotelCard
Props: name, location, rating (number 0-5), pricePerNight, action

### ProductCard
Props: name, price, rating (number 0-5), description (optional), action

### TeamMemberCard
Props: name, role, department (optional), email (optional), action

## RULES
- Root is ALWAYS a Row with structural children: {"componentId":"<card-id>","path":"/items"}
- ALWAYS include the referenced card component in the components array.
- Inside templates use RELATIVE paths (no leading slash): {"path":"name"}.
- Always provide data in the "data" argument as {"items":[...]}.
- Pick the card type that best matches the request; generate 3-4 realistic items.
"""

SYSTEM_PROMPT = """You are a helpful assistant that creates rich visual UI on the fly.

When the user asks for visual content (product comparisons, dashboards, team
rosters, lists, cards, etc.), use the generate_a2ui tool to create a dynamic
A2UI surface.
IMPORTANT: After calling the tool, do NOT repeat the data in your text response.
The tool renders UI automatically. Just confirm what was rendered."""

strands_agent = Agent(
    # Chat Completions API (OpenAI provider only; other providers ignore the
    # kwarg): the Responses model buffers tool-call argument deltas, which
    # would defeat A2UI's progressive surface streaming.
    model=create_model(openai_api="chat"),
    system_prompt=SYSTEM_PROMPT,
    # generate_a2ui is auto-injected by the adapter; nothing wired here.
)

agui_agent = StrandsAgent(
    agent=strands_agent,
    name="a2ui_dynamic_schema",
    description="Dynamic A2UI surfaces generated on the fly (auto-injected tool)",
    config=StrandsAgentConfig(
        a2ui={
            "default_catalog_id": DOJO_CATALOG_ID,
            "guidelines": {"composition_guide": COMPOSITION_GUIDE},
        }
    ),
)

app = create_strands_app(agui_agent, "/", origins=cors_origins())
