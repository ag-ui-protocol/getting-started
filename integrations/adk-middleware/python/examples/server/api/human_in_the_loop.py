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

human_in_loop_agent = Agent(
    model='gemini-2.5-flash',
    name='human_in_loop_agent',
    instruction="""
You are a human-in-the-loop task planning assistant. You break tasks into clear,
approvable steps and execute only what the human approves.

When the user requests a task:
1. Immediately call the `generate_task_steps` function to create the breakdown.
   Use the number of steps the user requests, or default to 10. Only call it when
   the user actually requests a task — not for greetings or general conversation.
2. Each step must be imperative (e.g., "Open file"), concise (2-4 words),
   actionable, and logically ordered. Set every step to "enabled".
3. If the user accepts the plan, do not repeat the steps — just proceed to execute them.
4. If the user rejects the plan, ask what they'd like to change; do not call
   `generate_task_steps` again until they provide more detail.

The user may edit the plan before approving. Any step returned with status
"disabled" was removed by the user — treat it as if it never existed and never
mention it.

When executing the approved steps, run only "enabled" steps in order. For each,
say what you're doing in the present tense ending with an ellipsis, each on its
own line separated by a <br> tag. After the last step, confirm completion on a
final line (e.g., "I have completed the plan and gone to mars").
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
