"""Backend Tool Rendering example for AWS Strands.

Backend ``@tool`` functions execute server-side; their results flow
through Strands' normal tool-result event into the AG-UI message stream.
The frontend renders the tool call + result for the user via the message
snapshot — no frontend execution, no agent-side AG-UI event emission.
"""
import os
from pathlib import Path
from dotenv import load_dotenv

# Suppress OpenTelemetry context warnings from Strands SDK
os.environ["OTEL_SDK_DISABLED"] = "true"
os.environ["OTEL_PYTHON_DISABLED_INSTRUMENTATIONS"] = "all"

from strands import Agent, tool
from ag_ui_strands import StrandsAgent, create_strands_app
from server.model_factory import create_model
from server.settings import cors_origins

# Load environment variables from .env file
env_path = Path(__file__).parent.parent.parent / '.env'

load_dotenv(dotenv_path=env_path)

# Create model from MODEL_PROVIDER env var (default: openai)
model = create_model()

# Define backend tools for demonstration
@tool
def render_chart(chart_type: str, data: str) -> dict:
    """
    Render a chart with backend processing capabilities.
    
    Args:
        chart_type: Type of chart (bar, line, pie, etc.)
        data: Chart data in JSON format
    
    Returns:
        Chart data for frontend rendering
    """
    return {
        "chart_type": chart_type,
        "data": data[:100],
        "status": "rendered"
    }

@tool
def get_weather(location: str) -> dict:
    """
    Get weather information for a location.
    
    Args:
        location: The location to get weather for
    
    Returns:
        Weather data with temperature, conditions, humidity, wind speed
    """
    import random
    
    # Simulate different weather conditions
    conditions_list = ["sunny", "cloudy", "rainy", "clear", "partly cloudy"]
    
    return {
        "temperature": random.randint(60, 85),
        "conditions": random.choice(conditions_list),
        "humidity": random.randint(30, 80),
        "wind_speed": random.randint(5, 20),
        "feels_like": random.randint(58, 88)
    }

strands_agent = Agent(
    model=model,
    tools=[get_weather, render_chart],
    system_prompt="You are a helpful assistant with backend tool rendering capabilities. You can get weather information and render charts.",
)

agui_agent = StrandsAgent(
    agent=strands_agent,
    name="backend_tool_rendering",
    description="AWS Strands agent with backend tool rendering support",
)

app = create_strands_app(agui_agent, "/", origins=cors_origins())

