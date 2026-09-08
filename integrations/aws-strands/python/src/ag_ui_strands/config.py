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
    Mapping,
    Optional,
)

from ag_ui.core import RunAgentInput

from strands.session import SessionManager

from .utils import UrlFetchPolicy


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


ThreadAgentKwargsProvider = Callable[["RunAgentInput"], Mapping[str, Any]]
"""Builds extra constructor kwargs for one thread's agent.

See :attr:`StrandsAgentConfig.thread_agent_kwargs`.
"""


TemplateToolsProvider = Callable[
    ["RunAgentInput"],
    Awaitable[Optional[Iterable[Any]]] | Optional[Iterable[Any]],
]
"""Chooses which of the template's tools one request may see.

See :attr:`StrandsAgentConfig.template_tools_provider`.
"""


@dataclass
class StrandsAgentConfig:
    """Top-level configuration for the Strands agent adapter."""

    tool_behaviors: Dict[str, ToolBehavior] = field(default_factory=dict)
    state_context_builder: Optional[StateContextBuilder] = None
    thread_agent_kwargs: Optional["ThreadAgentKwargsProvider"] = None
    """Extra keyword arguments for each per-thread Strands ``Agent``.

    The adapter builds one ``Agent`` per thread from the template it was given,
    by reading the template's settings back off the built instance. Some
    settings cannot be read back at all: Strands consumes them into internal
    state during construction and keeps nothing under a name the adapter can
    find. Others are readable but belong to the agent that owns them, so
    handing the same instance to every thread would let one conversation
    disturb another.

    Either way the template is the wrong place to put them. This hook is the
    supported route: it runs once per ``thread_id`` and whatever mapping it
    returns is applied over the recovered kwargs, so a caller can set anything
    the adapter cannot carry and override anything it can.

    ``model``, ``system_prompt``, ``tools`` and ``session_manager`` stay the
    adapter's to set, because they are what keeps threads apart and a run
    coherent.

    Called with the ``RunAgentInput`` that created the thread. If it raises,
    the run yields ``RUN_ERROR`` and the thread is not cached, so the next
    request retries it.
    """
    template_tools_provider: Optional["TemplateToolsProvider"] = None
    """Which of the template agent's tools this request may see.

    Called once per request with that request's ``RunAgentInput``, so the answer
    can vary turn by turn on one thread: the caller's identity is in
    ``forwarded_props`` or ``context``, and a tool the request must not reach is
    simply left out of the returned iterable. May be async.

    Return the tools themselves or their names, whichever is to hand. Return
    ``None`` to decline filtering, which leaves every template tool available;
    an empty iterable is a real answer and leaves none of them. A name the
    template does not contribute is dropped with a warning, because this hook
    narrows the wrapped agent's tools and cannot add one.

    The container is checked rather than merely iterated. A ``str`` and a
    ``Mapping`` are both refused: a bare name would come apart into characters,
    and a permission map would have its keys read as an allow-list while its
    values went unread, so a name mapped to ``False`` would still be allowed.
    Lists, tuples, sets and generators are all accepted.

    Applied to the live per-thread agent's tool registry, never by rebuilding
    that agent: the instance holds the thread's ``SessionManager``, its native
    interrupt checkpoint and its history, so replacing it to change a tool list
    would discard a conversation and any approval waiting inside it.

    Three consequences worth knowing:

    - A tool in the batch a live interrupt checkpoint would resume stays
      registered whatever this returns. The human's answer is about to be
      routed back into that batch, and an absent tool turns it into a "tool not
      found" the model re-fires. This is the rule ``sync_proxy_tools`` already
      applies to a proxy parked in a frontend-tool interrupt. The exemption
      does not outlast what it is for: the narrowing is re-applied inside the
      run once the batch has been dispatched, before the model is asked again.
    - History is never rewritten. A filtered-out tool's earlier calls and
      results stay in the thread's messages, so the model can still read what
      it did with a tool it can no longer call, and a provider that returns
      different sets across turns does not invalidate the transcript.
    - If it raises, the run yields ``RUN_ERROR`` with code
      ``TEMPLATE_TOOLS_PROVIDER_ERROR`` and stops, matching
      ``thread_agent_kwargs``. A filter that fails open would hand the model
      tools the caller meant to withhold.

    Client-declared tools on ``RunAgentInput.tools`` are outside this hook:
    they are re-synchronised from the request every turn already, so a caller
    that wants fewer of those sends fewer. Not applied on the multi-agent
    orchestrator path, which has no template registry to filter.

    One deployment note. With an external ``agents_by_thread`` map a
    request-scoped wrapper is rebuilt per request while the cached thread agent
    keeps the registry it already had, so a template whose tools are built per
    request hands the adapter equivalent but not identical objects. Ownership
    of a registry entry therefore falls back from object identity to the tool's
    name plus "not one of the adapter's other producers". Stable tool objects
    are still the simpler thing to hand it.

    Example::

        StrandsAgentConfig(
            template_tools_provider=lambda input_data: (
                ["read_docs"]
                if (input_data.forwarded_props or {}).get("role") != "admin"
                else None
            )
        )
    """
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
    url_fetch_policy: Optional[UrlFetchPolicy] = None
    """Policy applied to every server-side fetch of a URL content source.

    ``None`` uses :data:`~ag_ui_strands.utils.DEFAULT_URL_FETCH_POLICY`, which
    fetches only ``http``/``https``, refuses addresses outside the public
    internet, and bounds both a single attachment and everything one run
    fetches. A deployment whose attachments live on a private CDN or behind
    split DNS passes ``UrlFetchPolicy(allow_private_networks=True)``; cloud
    metadata endpoints stay blocked either way.
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

