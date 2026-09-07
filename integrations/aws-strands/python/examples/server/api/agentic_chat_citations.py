"""Citations example for AWS Strands.

Demonstrates citations reaching the client attached to the message they
annotate. When a model answers over sources, the adapter folds each citation
into the assistant message's ``metadata`` under the ``citations`` key, so a
frontend can render the sources next to the answer without correlating a second
event stream back to it.

The demo drives OpenAI's Responses API with the built-in ``web_search`` tool,
because that is the citation source reachable with the key the dojo already
has. Bedrock produces citations the same way over documents with citations
enabled; both arrive on the adapter as the same stream event and leave it in
the same shape, so what this demo shows is the wire behaviour rather than one
provider's quirk.

Requires ``strands-agents>=1.35.0``: earlier releases ship the Responses model
without the URL-citation mapping, so the run succeeds and cites nothing.
"""
import os
from pathlib import Path
from dotenv import load_dotenv

# Suppress OpenTelemetry context warnings
os.environ["OTEL_SDK_DISABLED"] = "true"
os.environ["OTEL_PYTHON_DISABLED_INSTRUMENTATIONS"] = "all"

from strands import Agent
from ag_ui_strands import StrandsAgent, create_strands_app
from server.model_factory import create_model
from server.settings import cors_origins

# Load environment variables from .env file
env_path = Path(__file__).parent.parent.parent / '.env'

load_dotenv(dotenv_path=env_path)

# Citations only exist where the provider produces them. `web_search` is the
# one built-in tool whose annotations Strands maps to citations, so this demo
# pins the Responses API rather than taking the factory default, the same way
# the reasoning demo pins it for reasoning summaries.
model = create_model(openai_api="responses", builtin_tools=[{"type": "web_search"}])

strands_agent = Agent(
    model=model,
    system_prompt="""
    You are a research assistant. Answer questions by searching the web and
    grounding what you say in what you find.

    Always search before answering a question about the world, even one you
    believe you know, so the answer carries its sources. Keep answers to two or
    three sentences.
    """,
)

agui_agent = StrandsAgent(
    agent=strands_agent,
    name="agentic_chat_citations",
    description="Strands agent whose answers carry the sources they came from",
)

app = create_strands_app(agui_agent, "/", origins=cors_origins())
