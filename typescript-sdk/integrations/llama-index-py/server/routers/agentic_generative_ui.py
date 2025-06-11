import asyncio
import copy
import jsonpatch

from llama_index.core.workflow import Context
from llama_index.llms.openai import OpenAI
from llama_index.protocols.ag_ui.server import get_ag_ui_workflow_router
from llama_index.protocols.ag_ui.events import StateDeltaWorkflowEvent, StateSnapshotWorkflowEvent


# Genrative UI demo
async def run_x_num_steps(
    ctx: Context, num_steps: int,
) -> str:
    """Run a given number of steps"""
    state = await ctx.get("state", default={})
    if state is None:
        state = {
            "steps": [
                {
                    "description": f"Step {i + 1}",
                    "status": "pending"
                }
                for i in range(num_steps)
            ]
        }
    else:
        state["steps"].extend([
            {
                "description": f"Step {i + 1}",
                "status": "pending"
            }
            for i in range(num_steps)
        ])

    # Send initial state snapshot
    ctx.write_event_to_stream(
        StateSnapshotWorkflowEvent(
            snapshot=state
        )
    )

    # Sleep for 1 second
    await asyncio.sleep(1.0)

    # Create a copy to track changes for JSON patches
    previous_state = copy.deepcopy(state)

    # Update each step and send deltas
    for i, step in enumerate(state["steps"]):
        step["status"] = "completed"
        
        # Generate JSON patch from previous state to current state
        patch = jsonpatch.make_patch(previous_state, state)
        
        # Send state delta event
        ctx.write_event_to_stream(
            StateDeltaWorkflowEvent(
                delta=patch.patch
            )
        )
        
        # Update previous state for next iteration
        previous_state = copy.deepcopy(state)
        
        # Sleep for 1 second
        await asyncio.sleep(1.0)

    # Optionally send a final snapshot to the client
    ctx.write_event_to_stream(
        StateSnapshotWorkflowEvent(
            snapshot=state
        )
    )

    return "Done!"


agentic_generative_ui_router = get_ag_ui_workflow_router(
    llm=OpenAI(model="gpt-4.1"),
    tools=[run_x_num_steps],
    initial_state={},
)
