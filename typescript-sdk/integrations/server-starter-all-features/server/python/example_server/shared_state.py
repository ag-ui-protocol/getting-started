"""
Shared state endpoint for the AG-UI protocol.
"""

from fastapi import Request
from fastapi.responses import StreamingResponse
from ag_ui.core import (
    RunAgentInput,
    EventType,
    RunStartedEvent,
    RunFinishedEvent,
    StateSnapshotEvent
)
from ag_ui.encoder import EventEncoder

async def shared_state_endpoint(input_data: RunAgentInput, request: Request):
    """Shared state endpoint"""
    # Get the accept header from the request
    accept_header = request.headers.get("accept")

    # Create an event encoder to properly format SSE events
    encoder = EventEncoder(accept=accept_header)

    async def event_generator():
        # Send run started event
        yield encoder.encode(
            RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id
            ),
        )

        # Send state events
        async for event in send_state_events():
            yield encoder.encode(event)

        # Send run finished event
        yield encoder.encode(
            RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id
            ),
        )

    return StreamingResponse(
        event_generator(),
        media_type=encoder.get_content_type()
    )


async def send_state_events():
    """Send state events with recipe data"""
    # Define the recipe state
    state = {
        "recipe": {
            "skill_level": "Advanced",
            "special_preferences": ["Low Carb", "Spicy"],
            "cooking_time": "15 min",
            "ingredients": [
                {
                    "icon": "🍗",
                    "name": "chicken breast",
                    "amount": "1",
                },
                {
                    "icon": "🌶️",
                    "name": "chili powder",
                    "amount": "1 tsp",
                },
                {
                    "icon": "🧂",
                    "name": "Salt",
                    "amount": "a pinch",
                },
                {
                    "icon": "🥬",
                    "name": "Lettuce leaves",
                    "amount": "handful",
                },
            ],
            "instructions": [
                "Season chicken with chili powder and salt.",
                "Sear until fully cooked.",
                "Slice and wrap in lettuce.",
            ]
        }
    }

    # Send state snapshot event
    yield StateSnapshotEvent(
        type=EventType.STATE_SNAPSHOT,
        snapshot=state
    )
