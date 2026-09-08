"""Agentic Chat with Multimodal support for AWS Strands.

Demonstrates multimodal message handling. When the user uploads an image,
the adapter converts AG-UI InputContent to Strands ContentBlock format
and passes it to the vision-capable model.
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
    You are a helpful assistant that can analyze images and documents.
    When the user shares an image, describe what you see in detail.
    When the user shares a document, summarize its contents.
    Always be descriptive and specific about visual content.
    """,
)

agui_agent = StrandsAgent(
    agent=strands_agent,
    name="agentic_chat_multimodal",
    description="Conversational Strands agent with multimodal content support",
)

app = create_strands_app(agui_agent, "/", origins=cors_origins())
