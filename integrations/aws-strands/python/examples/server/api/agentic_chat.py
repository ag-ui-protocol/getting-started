"""Agentic Chat example for AWS Strands.

Simple conversational agent. Frontend tools like change_background are
forwarded from the client at runtime via RunAgentInput.tools and
dynamically registered as proxy tools — no server-side @tool definition needed.
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

# Create model from MODEL_PROVIDER env var (default: openai)
model = create_model()

strands_agent = Agent(
    model=model,
    system_prompt="""
    You are a helpful assistant.
    When the user greets you, always greet them back. Your greeting should always start with "Hello".
    Your greeting should also always ask (exact wording) "how can I assist you?"
    """,
)

agui_agent = StrandsAgent(
    agent=strands_agent,
    name="agentic_chat",
    description="Conversational Strands agent with AG-UI streaming",
)

app = create_strands_app(agui_agent, "/", origins=cors_origins())
