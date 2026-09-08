"""A2UI Error Recovery feature (OSS-158).

ADK port of the LangGraph ``a2ui_recovery`` example — the same dynamic-schema
setup with the validate->retry recovery loop made explicit. The showcase forces
an invalid->valid (recover) and an always-invalid (exhaust) sequence via aimock
fixtures: a faulty surface never paints (the middleware gate suppresses it), the
errors are fed back, and either a valid surface paints or a tasteful hard-failure
is shown once the attempt cap is hit.
"""

from __future__ import annotations

import logging

from fastapi import FastAPI
from google.adk.agents import LlmAgent
from google.adk.models import Gemini

from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint, get_a2ui_tool

from .a2ui_dynamic_schema import COMPOSITION_GUIDE, CUSTOM_CATALOG_ID, SYSTEM_PROMPT

logger = logging.getLogger(__name__)

_MODEL = "gemini-2.5-pro"


def _log_attempt(record: dict) -> None:
    # Dev observability: each attempt (incl. rejected ones) is logged.
    logger.info(
        "[a2ui recovery] attempt %s: %s %s",
        record.get("attempt"),
        "valid" if record.get("ok") else "invalid",
        record.get("errors"),
    )


a2ui_tool = get_a2ui_tool({
    "model": Gemini(model=_MODEL),
    "default_catalog_id": CUSTOM_CATALOG_ID,
    "guidelines": {"composition_guide": COMPOSITION_GUIDE},
    # Recovery runs by default; set explicitly for the showcase. Each rejected
    # attempt's structural validation errors are fed back into the retry prompt.
    "recovery": {"maxAttempts": 3},
    "on_a2ui_attempt": _log_attempt,
})

recovery_agent = LlmAgent(
    model=_MODEL,
    name="a2ui_recovery",
    instruction=SYSTEM_PROMPT,
    tools=[a2ui_tool],
)

adk_a2ui_recovery = ADKAgent(
    adk_agent=recovery_agent,
    app_name="demo_app",
    user_id="demo_user",
    session_timeout_seconds=3600,
    use_in_memory_services=True,
)

app = FastAPI(title="ADK Middleware A2UI Error Recovery")
add_adk_fastapi_endpoint(app, adk_a2ui_recovery, path="/")
