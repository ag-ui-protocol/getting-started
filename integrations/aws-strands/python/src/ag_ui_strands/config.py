"""Configuration primitives for customizing Strands agent behavior."""

from __future__ import annotations

import inspect
from dataclasses import dataclass, field
from typing import (
    Any,
    AsyncIterator,
    Awaitable,
    Callable,
    Dict,
    Iterable,
    List,
    Optional,
)

from ag_ui.core import RunAgentInput

from strands.session import SessionManager


StatePayload = Dict[str, Any]


@dataclass
class ToolCallContext:
    """Context passed to tool call hooks."""

    input_data: RunAgentInput
    tool_name: str
    tool_use_id: str
    tool_input: Any
    args_str: str


@dataclass
class ToolResultContext(ToolCallContext):
    """Context passed to tool result hooks."""

    result_data: Any
    message_id: str


ArgsStreamer = Callable[[ToolCallContext], AsyncIterator[str]]
StateFromArgs = Callable[[ToolCallContext], Awaitable[Optional[StatePayload]] | Optional[StatePayload]]
StateFromResult = Callable[[ToolResultContext], Awaitable[Optional[StatePayload]] | Optional[StatePayload]]
CustomResultHandler = Callable[[ToolResultContext], AsyncIterator[Any]]
StateContextBuilder = Callable[[RunAgentInput, str], str]
SessionManagerProvider = Callable[[RunAgentInput], Awaitable[Optional[SessionManager]] | Optional[SessionManager]]


@dataclass
class ToolStreamEventContext:
    """Context passed to tool_stream_event_handler hooks.

    Carries every piece of information available at the point a tool yields an
    intermediate streaming event, so handlers can make routing decisions without
    needing to close over external state.
    """

    tool_use_id: str
    """The Strands ``toolUseId`` for the tool call that produced this event."""

    tool_name: str
    """The name of the tool that produced this event."""

    stream_data: Any
    """The raw data payload yielded by the tool (the ``data`` field of the
    ``tool_stream_event`` dict emitted by Strands)."""


ToolStreamEventHandler = Callable[["ToolStreamEventContext"], AsyncIterator[Any]]
"""Handler for raw tool_stream_event data emitted by async-generator tools.

Must be an **async generator function** — i.e. it must contain at least one
``yield`` statement.  A plain ``async def`` that returns an ``AsyncIterator``
will satisfy the type but will not be iterated correctly.

Called with a :class:`ToolStreamEventContext` for every intermediate event
yielded by the tool while it is executing.  The handler may yield zero or more
AG-UI Event objects which are forwarded directly into the top-level event
stream.

When a handler is registered for a tool, the default behaviour of emitting a
``StateSnapshotEvent`` for ``{"state": ...}`` payloads is suppressed for that
tool.  The handler is responsible for any state updates it wants to emit.
"""


@dataclass
class PredictStateMapping:
    """Declarative mapping telling the UI how to predict state from tool args."""

    state_key: str
    tool: str
    tool_argument: str

    def to_payload(self) -> Dict[str, str]:
        return {
            "state_key": self.state_key,
            "tool": self.tool,
            "tool_argument": self.tool_argument,
        }


@dataclass
class ToolBehavior:
    """Declarative configuration for tool-specific handling."""

    skip_messages_snapshot: bool = False
    """When True, suppress the ``MessagesSnapshotEvent`` that would normally
    follow this tool's ``TOOL_CALL_END`` / ``TOOL_CALL_RESULT`` events.

    Useful when ``custom_result_handler`` already emits its own
    ``MessagesSnapshotEvent`` and you want to avoid duplicates.
    """
    continue_after_frontend_call: bool = False
    stop_streaming_after_result: bool = False
    interrupt_on_call: bool = False
    """Interrupt before a server-executed tool runs. Client-provided tools
    should gate execution in the client.
    """
    predict_state: Optional[Iterable[PredictStateMapping]] = None
    args_streamer: Optional[ArgsStreamer] = None
    state_from_args: Optional[StateFromArgs] = None
    state_from_result: Optional[StateFromResult] = None
    custom_result_handler: Optional[CustomResultHandler] = None
    tool_stream_event_handler: Optional[ToolStreamEventHandler] = None


@dataclass
class StrandsAgentConfig:
    """Top-level configuration for the Strands agent adapter."""

    tool_behaviors: Dict[str, ToolBehavior] = field(default_factory=dict)
    state_context_builder: Optional[StateContextBuilder] = None
    session_manager_provider: Optional[SessionManagerProvider] = None
    """Optional factory for creating per-thread SessionManager instances.

    Called exactly once per thread_id the first time that thread is seen.
    Subsequent requests on the same thread reuse the cached agent (and its
    SessionManager). If the provider depends on per-request data (e.g. auth
    tokens in ``forwarded_props``), be aware that only the first request's
    data is used to initialise the session manager.

    If the provider raises an exception the run yields a ``RUN_ERROR`` event
    and returns early; the thread is NOT cached so the provider will be
    retried on the next request.

    If the provider returns ``None`` a warning is logged and the agent runs
    without session persistence; the thread IS cached in this state, so the
    provider will not be called again for the same thread.
    """
    emit_messages_snapshot: bool = True
    """Emit ``MessagesSnapshotEvent`` at lifecycle boundaries (after the
    initial state snapshot, after each ``TOOL_CALL_END`` /
    ``TOOL_CALL_RESULT``, and after each ``TEXT_MESSAGE_END``).

    Required for CopilotKit v2 frontends, which key tool-call rendering
    off canonical message reconstruction rather than the streaming
    ``TOOL_CALL_*`` events alone. Set to False for raw AG-UI consumers
    that do their own message reconstruction.
    """
    replay_history_into_strands: bool = True
    """When True (and the cached Strands agent has no ``session_manager``),
    reconcile the per-thread ``StrandsAgentCore.messages`` list with
    ``RunAgentInput.messages`` before invoking ``stream_async``.

    This prevents the LLM from re-firing frontend tools every turn
    because Strands' internal history was missing the tool result that
    the frontend produced. Disable only if you manage Strands history
    yourself (e.g. via a custom ``session_manager``).
    """
    a2ui: Optional[Dict[str, Any]] = None
    """A2UI auto-injection config — everything A2UI-related in one
    place. When the CopilotKit runtime forwards ``injectA2UITool`` (or
    ``a2ui["inject_a2ui_tool"]`` opts in on a host that doesn't), the adapter
    injects a ``generate_a2ui`` recovery tool and infers the model from the
    wrapped agent — no manual ``get_a2ui_tools()`` needed. Keys:

    - ``inject_a2ui_tool`` — opt in without the runtime flag; a string also
      names the injected render tool to drop.
    - ``default_catalog_id`` — catalog id stamped into auto-injected surfaces
      (must match the host renderer's catalog).
    - ``guidelines`` — ``{"composition_guide": ...}`` teaches the sub-agent the
      catalog's components; required for a real model to compose them.
    - ``catalog`` — inline catalog for catalog-aware (semantic) recovery.
    - ``recovery`` — recovery loop config. NOTE: keys are camelCase per the
      shared toolkit contract — e.g. ``{"maxAttempts": 5}`` (a snake_case
      ``max_attempts`` is silently ignored).
    """


async def maybe_await(value: Any) -> Any:
    """Await coroutine-like values produced by hook callables."""

    if inspect.isawaitable(value):
        return await value
    return value


def normalize_predict_state(value: Optional[Iterable[PredictStateMapping]]) -> List[PredictStateMapping]:
    """Normalize predict state config into a concrete list."""

    if value is None:
        return []
    if isinstance(value, PredictStateMapping):
        return [value]
    return list(value)

