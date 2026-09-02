"""Example: Tool-based Generative UI Agent

This example shows how to create an Agno Agent with custom tools for haiku generation
and background changing, exposed in an AG-UI compatible way.
"""
from typing import List

from agno.agent.agent import Agent
from agno.db.in_memory import InMemoryDb
from agno.os import AgentOS
from agno.os.interfaces.agui import AGUI
from agno.models.openai import OpenAIChat
from agno.tools import tool


@tool(external_execution=True)
def generate_haiku(english: List[str], japanese: List[str], image_names: List[str]) -> str: # pylint: disable=unused-argument
    """

    Generate a haiku in Japanese and its English translation.
    YOU MUST PROVIDE THE ENGLISH HAIKU AND THE JAPANESE HAIKU AND THE IMAGE NAMES.
    When picking image names, pick them from the following list:
        - "Osaka_Castle_Turret_Stone_Wall_Pine_Trees_Daytime.jpg",
        - "Tokyo_Skyline_Night_Tokyo_Tower_Mount_Fuji_View.jpg",
        - "Itsukushima_Shrine_Miyajima_Floating_Torii_Gate_Sunset_Long_Exposure.jpg",
        - "Takachiho_Gorge_Waterfall_River_Lush_Greenery_Japan.jpg",
        - "Bonsai_Tree_Potted_Japanese_Art_Green_Foliage.jpeg",
        - "Shirakawa-go_Gassho-zukuri_Thatched_Roof_Village_Aerial_View.jpg",
        - "Ginkaku-ji_Silver_Pavilion_Kyoto_Japanese_Garden_Pond_Reflection.jpg",
        - "Senso-ji_Temple_Asakusa_Cherry_Blossoms_Kimono_Umbrella.jpg",
        - "Cherry_Blossoms_Sakura_Night_View_City_Lights_Japan.jpg",
        - "Mount_Fuji_Lake_Reflection_Cherry_Blossoms_Sakura_Spring.jpg"

    Args:
        english: List[str]: An array of three lines of the haiku in English. YOU MUST PROVIDE THE ENGLISH HAIKU.
        japanese: List[str]: An array of three lines of the haiku in Japanese. YOU MUST PROVIDE THE JAPANESE HAIKU.
        image_names: List[str]: An array of three image names. YOU MUST PROVIDE THE IMAGE NAMES.


    Returns:
        str: A confirmation message.
    """ # pylint: disable=line-too-long
    return "Haiku generated"

agent = Agent(
    db=InMemoryDb(),
    model=OpenAIChat(id="gpt-4o"),
    tools=[generate_haiku],
    description="Help the user with writing Haikus. If the user asks for a haiku, use the generate_haiku tool to display the haiku to the user.",
    debug_mode=True,
)

agent_os = AgentOS(
  agents=[agent],
  interfaces=[AGUI(agent=agent)]
)

app = agent_os.get_app()
