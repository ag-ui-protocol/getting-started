"""Tool Based Generative UI feature."""

from __future__ import annotations

from typing import Any, List

from fastapi import FastAPI
from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint, AGUIToolset
from google.adk.agents import Agent
from google.adk.tools import ToolContext
from google.genai import types

# List of available images (modify path if needed)
IMAGE_LIST = [
    "Osaka_Castle_Turret_Stone_Wall_Pine_Trees_Daytime.jpg",
    "Tokyo_Skyline_Night_Tokyo_Tower_Mount_Fuji_View.jpg",
    "Itsukushima_Shrine_Miyajima_Floating_Torii_Gate_Sunset_Long_Exposure.jpg",
    "Takachiho_Gorge_Waterfall_River_Lush_Greenery_Japan.jpg",
    "Bonsai_Tree_Potted_Japanese_Art_Green_Foliage.jpeg",
    "Shirakawa-go_Gassho-zukuri_Thatched_Roof_Village_Aerial_View.jpg",
    "Ginkaku-ji_Silver_Pavilion_Kyoto_Japanese_Garden_Pond_Reflection.jpg",
    "Senso-ji_Temple_Asakusa_Cherry_Blossoms_Kimono_Umbrella.jpg",
    "Cherry_Blossoms_Sakura_Night_View_City_Lights_Japan.jpg",
    "Mount_Fuji_Lake_Reflection_Cherry_Blossoms_Sakura_Spring.jpg"
]

# Prepare the image list string for the prompt
image_list_str = "\n".join([f"- {img}" for img in IMAGE_LIST])

haiku_generator_agent = Agent(
    model='gemini-3.5-flash',
    name='haiku_generator_agent',
    instruction=f"""
        You are an expert haiku generator that creates beautiful Japanese haiku poems
        and their English translations. You also have the ability to select relevant
        images that complement the haiku's theme and mood.

        When generating a haiku:
        1. Create a traditional 5-7-5 syllable structure haiku in Japanese
        2. Provide an accurate and poetic English translation
        3. Select exactly 3 image filenames from the available list that best
           represent or complement the haiku's theme, mood, or imagery. You must
           provide the image names, even if none of them are truly relevant.

        Available images to choose from:
        {image_list_str}

        Always use the generate_haiku tool to create your haiku. The tool will handle
        the formatting and validation of your response.

        Do not mention the selected image names in your conversational response to
        the user - let the tool handle that information.

        Focus on creating haiku that capture the essence of Japanese poetry:
        nature imagery, seasonal references, emotional depth, and moments of beauty
        or contemplation. That said, any topic is fair game. Do not refuse to generate
        a haiku on any topic as long as it is appropriate.
    """,
    generate_content_config=types.GenerateContentConfig(
        temperature=0.7,  # Slightly higher temperature for creativity
        top_p=0.9,
        top_k=40
    ),
    tools=[
        AGUIToolset(), # Add the tools provided by the AG-UI client
    ]
)

# Create ADK middleware agent instance
adk_agent_haiku_generator = ADKAgent(
    adk_agent=haiku_generator_agent,
    app_name="demo_app",
    user_id="demo_user",
    session_timeout_seconds=3600,
    use_in_memory_services=True
)

# Create FastAPI app
app = FastAPI(title="ADK Middleware Tool Based Generative UI")

# Add the ADK endpoint
add_adk_fastapi_endpoint(app, adk_agent_haiku_generator, path="/")
