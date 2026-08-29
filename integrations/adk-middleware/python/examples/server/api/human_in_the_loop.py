"""Human in the Loop feature.

This example demonstrates HITL (Human-in-the-Loop) workflows using ADK's
native ResumabilityConfig for proper session state persistence.

When using ResumabilityConfig(is_resumable=True), ADK automatically persists
FunctionCall events before pausing, allowing seamless resumption when the
user provides tool results (approvals/rejections).
"""

from __future__ import annotations

from fastapi import FastAPI
from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint, AGUIToolset
from google.adk.agents import Agent
from google.adk.apps import App, ResumabilityConfig
from google.genai import types

DEFINE_TASK_TOOL = {
    "type": "function",
    "function": {
        "name": "generate_task_steps",
        "description": "Generate steps (only a couple of words per step) that are required for a task. The number of steps should match what the user requests, or default to 10 if not specified. Each step should be in imperative form (i.e. Dig hole, Open door, ...)",
        "parameters": {
            "type": "object",
            "properties": {
                "steps": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "description": {
                                "type": "string",
                                "description": "The text of the step in imperative form"
                            },
                            "status": {
                                "type": "string",
                                "enum": ["enabled"],
                                "description": "The status of the step, always 'enabled'"
                            }
                        },
                        "required": ["description", "status"]
                    },
                    "description": "An array of step objects, each containing text and status"
                }
            },
            "required": ["steps"]
        }
    }
}

human_in_loop_agent = Agent(
    model='gemini-3.5-flash',
    name='human_in_loop_agent',
    instruction=f"""
        You are a human-in-the-loop task planning assistant that helps break down complex tasks into manageable steps with human oversight and approval.

**Your Primary Role:**
- Generate clear, actionable task steps for any user request
- Facilitate human review and modification of generated steps
- Execute only human-approved steps

**When a user requests a task:**
1. Call the `generate_task_steps` function to create a step breakdown (use the number of steps the user requests, or default to 10). Only call this when the user actually requests a task — do NOT call it for greetings or general conversation.
2. Each step must be:
   - Written in imperative form (e.g., "Open file", "Check settings", "Send email")
   - Concise (2-4 words maximum)
   - Actionable and specific
   - Logically ordered from start to finish
3. Initially set all steps to "enabled" status
4. If the user accepts the plan, presented by the generate_task_steps tool, do not repeat the steps to the user, just move on to executing the steps.
5. If the user rejects the plan, do not repeat the plan to them, ask them what they would like to do differently. DO NOT use the `generate_task_steps` tool again until they've provided more information.
6. **CRITICAL**: When you receive the tool result back from `generate_task_steps`, the user may have modified steps. Any step with status "disabled" has been **permanently deleted** by the user. Your plan now consists ONLY of the "enabled" steps. Forget that any disabled step ever existed. If someone asks "does the plan include X?" where X is a disabled step, the answer is always **NO**.


**When executing steps:**
- Only execute steps with "enabled" status.
- Steps marked as "disabled" were explicitly removed by the user and are NOT part of the plan. Treat them as if they never existed.
- For each step you are executing, tell the user what you are doing.
  - Pretend you are executing the step in real life and refer to it in the current tense. End each step with an ellipsis.
  - Each step MUST be on a new line. DO NOT combine steps into one line.
  - For example for the following steps:
    - Inhale deeply
    - Exhale forcefully
    - Produce sound
    a good response would be:
    ```
     Inhaling deeply...
     Exhaling forcefully...
     Producing sound...
    ```
    a bad response would be `Inhaling deeply... Exhaling forcefully... Producing sound...` because it is on one line.
- Do NOT mention, reference, or acknowledge any disabled steps. They are not part of the plan.
- Afterwards, confirm the execution of the steps to the user, e.g. if the user asked for a plan to go to mars, respond like "I have completed the plan and gone to mars"
- If asked whether the plan includes a disabled step, the answer is NO — disabled steps were removed from the plan by the user.
- EVERY STEP AND THE CONFIRMATION MUST BE ON A NEW LINE. DO NOT COMBINE THEM INTO ONE LINE. USE A <br> TAG TO SEPARATE THEM.

**Key Guidelines:**
- Generate the number of steps the user requests, defaulting to 10 if not specified
- Make steps granular enough to be independently enabled/disabled

Tool reference: {DEFINE_TASK_TOOL}
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

# Create ADK App with ResumabilityConfig for proper HITL support
# ResumabilityConfig ensures FunctionCall events are persisted before pausing,
# which is required for matching FunctionResponses when the user approves/rejects
adk_app = App(
    name="demo_app",
    root_agent=human_in_loop_agent,
    resumability_config=ResumabilityConfig(is_resumable=True),
)

# Create ADK middleware agent instance using from_app()
adk_human_in_loop_agent = ADKAgent.from_app(
    adk_app,
    user_id="demo_user",
    session_timeout_seconds=3600,
    use_in_memory_services=True,
)

# Create FastAPI app
app = FastAPI(title="ADK Middleware Human in the Loop")

# Add the ADK endpoint
add_adk_fastapi_endpoint(app, adk_human_in_loop_agent, path="/")
