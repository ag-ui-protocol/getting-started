"""Tool-based Generative UI example for AWS Strands.

The ``generate_haiku`` tool is declared on the frontend via ``useFrontendTool``.
The adapter auto-registers it as a proxy tool when ``RunAgentInput.tools``
arrives, so the backend registers no native tool here. Strands invokes the proxy
with the structured haiku arguments, the adapter halts the run after the proxy
returns, and the browser renders the haiku card from the streamed
``TOOL_CALL_*`` events.
"""

import os
from pathlib import Path

from dotenv import load_dotenv

env_path = Path(__file__).parent.parent.parent / '.env'
load_dotenv(dotenv_path=env_path)

# Quieten OpenTelemetry context warnings by default. Ordering matters twice
# over: after `load_dotenv` so a value in examples/.env wins, and before the
# strands import below, which is the point at which the setting takes effect.
os.environ.setdefault("OTEL_SDK_DISABLED", "true")
os.environ.setdefault("OTEL_PYTHON_DISABLED_INSTRUMENTATIONS", "all")

from strands import Agent
from ag_ui_strands import StrandsAgent, create_strands_app
from server.model_factory import create_model


model = create_model()

strands_agent = Agent(
    model=model,
    tools=[],
    system_prompt="""You are a creative haiku generator.

When the user asks for a haiku, ALWAYS call the `generate_haiku` tool with:
- 3 lines of haiku in Japanese
- 3 lines of haiku translated to English
- One relevant image_name from the provided list
- A CSS gradient for the card background

Do not respond with plain text, always use the tool.""",
)

agui_agent = StrandsAgent(
    agent=strands_agent,
    name="tool_based_generative_ui",
    description="AWS Strands haiku generator with frontend-rendered tool",
)

app = create_strands_app(agui_agent, "/")
