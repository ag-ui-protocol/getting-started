"""Predictive State Updates example for AWS Strands.

``write_document`` is declared on the frontend (the dojo page registers it via
``useHumanInTheLoop``), so the adapter auto-registers it as a proxy tool when
``RunAgentInput.tools`` arrives. No backend ``@tool`` here.

The demo is the ``predict_state`` mapping below. Before the first argument delta
reaches the browser, the adapter emits a ``PredictState`` custom event saying
that the tool's ``document`` argument feeds the ``document`` state key. The
frontend then paints the document editor from the partial JSON while the model
is still streaming it, instead of waiting for the completed tool call.

``state_from_args`` closes the loop with an authoritative ``StateSnapshot``
carrying the finished document, emitted before ``TOOL_CALL_END`` so the
editor's optimistic text is replaced by server-confirmed state rather than
left as a prediction.
"""

import json
import logging
import os
from pathlib import Path

from dotenv import load_dotenv

env_path = Path(__file__).parent.parent.parent / '.env'
load_dotenv(dotenv_path=env_path)

# Quieten OpenTelemetry context warnings by default. Ordering matters twice
# over: after `load_dotenv` so a value in examples/.env wins, and before the
# strands import below, which is the point at which the setting takes effect.
os.environ.setdefault("OTEL_SDK_DISABLED", "true")
os.environ.setdefault("OTEL_PYTHON_DISABLED_INSTRUMENTATIONS", "all")


logger = logging.getLogger(__name__)

from strands import Agent
from ag_ui_strands import (
    PredictStateMapping,
    StrandsAgent,
    StrandsAgentConfig,
    ToolBehavior,
    create_strands_app,
)
from server.model_factory import create_model


def build_document_prompt(input_data, user_message: str) -> str:
    """Inject the current document into the prompt so edits are incremental."""
    state = getattr(input_data, "state", None)
    document = state.get("document") if isinstance(state, dict) else None
    # Type-guarded, matching the TypeScript mirror: a non-string document would
    # otherwise be interpolated as its Python repr and shown to the model as if
    # it were the document text.
    if not isinstance(document, str) or not document:
        return user_message
    return (
        f"This is the current state of the document:\n----\n{document}\n----\n\n"
        f"User request: {user_message}"
    )


async def document_state_from_args(context):
    """Publish the finished document as authoritative shared state.

    The adapter calls this once the tool call is complete, so the arguments here
    are final and every give-up path below is a genuine surprise rather than a
    partial read. Each one says so, because returning ``None`` silently leaves
    the browser showing its own prediction with nothing authoritative behind it,
    which looks exactly like success.
    """
    tool_input = context.tool_input
    if isinstance(tool_input, str):
        try:
            tool_input = json.loads(tool_input)
        except json.JSONDecodeError:
            logger.warning(
                "write_document arguments were not valid JSON; "
                "no authoritative document state published"
            )
            return None
    if not isinstance(tool_input, dict):
        logger.warning(
            "write_document arguments were %s, not an object; "
            "no authoritative document state published",
            type(tool_input).__name__,
        )
        return None
    document = tool_input.get("document")
    if not isinstance(document, str):
        logger.warning(
            "write_document produced no string `document` argument (got %s); "
            "the editor keeps its prediction with nothing to confirm it",
            type(document).__name__,
        )
        return None
    return {"document": document}


predictive_state_config = StrandsAgentConfig(
    state_context_builder=build_document_prompt,
    tool_behaviors={
        "write_document": ToolBehavior(
            predict_state=[
                PredictStateMapping(
                    state_key="document",
                    tool="write_document",
                    tool_argument="document",
                )
            ],
            state_from_args=document_state_from_args,
        )
    },
)

# Named explicitly even though it is already this factory's default, because the
# demo depends on it: the Responses API buffers tool-call argument deltas, which
# would leave the predict-state mapping nothing to project from. Its TypeScript
# mirror must pass the same value against a default of Responses.
model = create_model(openai_api="chat")

strands_agent = Agent(
    model=model,
    tools=[],
    system_prompt="""You are a helpful assistant for writing documents.

To write or edit the document, you MUST use the `write_document` tool.
You MUST pass the full updated document, even when changing only a few words.
When making edits, keep them minimal: do not rewrite every word.
Format the document with markdown, but never use italic or strike-through
formatting, which is reserved for showing the user a diff.
Keep stories SHORT.

After calling the tool, do NOT repeat the document as a message. Just briefly
summarize the changes you made, 2 sentences max.""",
)

agui_agent = StrandsAgent(
    agent=strands_agent,
    name="predictive_state_updates",
    description="AWS Strands document editor that streams tool arguments into shared state",
    config=predictive_state_config,
)

app = create_strands_app(agui_agent, "/")
