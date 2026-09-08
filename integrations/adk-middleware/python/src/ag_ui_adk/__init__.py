# src/__init__.py

"""ADK Middleware for AG-UI Protocol

This middleware enables Google ADK agents to be used with the AG-UI protocol.
"""

from __future__ import annotations

import logging
import os
from typing import Dict, Iterable

from .adk_agent import ADKAgent
from .event_translator import EventTranslator, adk_events_to_messages
from .session_manager import SessionManager, CONTEXT_STATE_KEY, INVOCATION_ID_STATE_KEY
from .endpoint import (
    AgentResolver,
    add_adk_fastapi_endpoint,
    create_adk_app,
    resolve_agent_from_message_history,
)
from .config import PredictStateMapping, normalize_predict_state
from .agui_toolset import AGUIToolset
from .a2ui_tool import (
    get_a2ui_tool,
    A2UISubAgentTool,
    plan_a2ui_injection,
    is_auto_injected_a2ui_tool,
)
__all__ = [
    'ADKAgent',
    'AgentResolver',
    'add_adk_fastapi_endpoint',
    'create_adk_app',
    'resolve_agent_from_message_history',
    'EventTranslator',
    'SessionManager',
    'CONTEXT_STATE_KEY',
    'INVOCATION_ID_STATE_KEY',
    'PredictStateMapping',
    'normalize_predict_state',
    'adk_events_to_messages',
    'AGUIToolset',
    'get_a2ui_tool',
    'A2UISubAgentTool',
    'plan_a2ui_injection',
    'is_auto_injected_a2ui_tool',
]

__version__ = "0.1.0"


def _configure_logging_from_env() -> None:
    """Configure component loggers based on environment variables."""

    root_level = os.getenv('LOG_ROOT_LEVEL')
    if root_level:
        try:
            level = getattr(logging, root_level.upper())
        except AttributeError:
            logging.getLogger(__name__).warning(
                "Invalid LOG_ROOT_LEVEL value '%s'", root_level
            )
        else:
            logging.basicConfig(level=level, force=True)

    component_levels: Dict[str, Iterable[str]] = {
        'LOG_ADK_AGENT': ('ag_ui_adk.adk_agent',),
        'LOG_EVENT_TRANSLATOR': (
            'ag_ui_adk.event_translator',
            'event_translator',
        ),
        'LOG_ENDPOINT': ('ag_ui_adk.endpoint', 'endpoint'),
        'LOG_SESSION_MANAGER': (
            'ag_ui_adk.session_manager',
            'session_manager',
        ),
    }

    for env_var, logger_names in component_levels.items():
        level_name = os.getenv(env_var)
        if not level_name:
            continue

        try:
            level = getattr(logging, level_name.upper())
        except AttributeError:
            logging.getLogger(__name__).warning(
                "Invalid value '%s' for %s", level_name, env_var
            )
            continue

        for logger_name in logger_names:
            logging.getLogger(logger_name).setLevel(level)


_configure_logging_from_env()
