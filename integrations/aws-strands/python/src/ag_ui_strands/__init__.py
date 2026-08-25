"""
AWS Strands Integration for AG-UI.

Wraps a Strands ``Agent`` as an AG-UI agent: event-stream translation,
frontend proxy-tool sync, per-thread session management, and the two-tier
A2UI surface generation (``get_a2ui_tools`` / ``plan_a2ui_injection``).
"""
from .agent import INTERRUPT_CANCELLED, StrandsAgent
from .a2ui_tool import (
    A2UI_OPERATIONS_KEY,
    A2UI_STREAM_KEY,
    A2UIGuidelines,
    A2UIToolParams,
    BASIC_CATALOG_ID,
    get_a2ui_tools,
    is_auto_injected_a2ui_tool,
    plan_a2ui_injection,
)
from .client_proxy_tool import create_proxy_tool, sync_proxy_tools
from .utils import (
    DEFAULT_URL_FETCH_POLICY,
    UrlFetchPolicy,
    UrlFetchPolicyError,
    create_strands_app,
)
from .endpoint import add_strands_fastapi_endpoint, add_ping
from .config import (
    StrandsAgentConfig,
    ToolBehavior,
    ToolCallContext,
    ToolResultContext,
    ToolStreamEventContext,
    PredictStateMapping,
    SessionManagerProvider,
    ToolStreamEventHandler,
)
from ag_ui.core import (
    Interrupt,
    ResumeEntry,
    RunFinishedInterruptOutcome,
    RunFinishedSuccessOutcome,
)

__all__ = [
    "StrandsAgent",
    "INTERRUPT_CANCELLED",
    "A2UI_STREAM_KEY",
    "A2UI_OPERATIONS_KEY",
    "A2UIToolParams",
    "A2UIGuidelines",
    "BASIC_CATALOG_ID",
    "get_a2ui_tools",
    "is_auto_injected_a2ui_tool",
    "plan_a2ui_injection",
    "create_proxy_tool",
    "sync_proxy_tools",
    "create_strands_app",
    "UrlFetchPolicy",
    "UrlFetchPolicyError",
    "DEFAULT_URL_FETCH_POLICY",
    "add_strands_fastapi_endpoint",
    "add_ping",
    "StrandsAgentConfig",
    "ToolBehavior",
    "ToolCallContext",
    "ToolResultContext",
    "ToolStreamEventContext",
    "PredictStateMapping",
    "SessionManagerProvider",
    "ToolStreamEventHandler",
    "Interrupt",
    "ResumeEntry",
    "RunFinishedInterruptOutcome",
    "RunFinishedSuccessOutcome",
]

