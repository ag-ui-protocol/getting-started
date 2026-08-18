"""Public data types for the Managed Agents adapter."""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, runtime_checkable


@dataclass
class BackendTool:
    """A tool the agent may call, executed on this server rather than in the
    browser.

    Registered on the managed agent as a `custom` tool. When the agent calls
    it we run `handler`, stream the call and result to the UI, and post the
    result back into the session.
    """

    name: str
    description: str
    parameters: dict[str, Any]
    """JSON Schema for the tool input."""
    handler: Callable[[Any], Awaitable[str] | str]


ErrorHandler = Callable[[BaseException, dict[str, Any]], Awaitable[None] | None]
"""Notified when a best-effort operation fails.

These failures are deliberately swallowed — they must not fail the run — but
without a hook they are also invisible, leaving an operator with a wedged
thread and nothing in the logs. Receives the exception and a context dict
carrying at least ``operation``, plus ``session_id``/``thread_id`` when known.

May be a coroutine function: the awaitable it returns is awaited, so async
telemetry actually runs rather than being dropped as a never-awaited coroutine.
Exceptions raised by the handler — synchronously or from its awaitable — are
ignored. Nothing the handler does can fail a run.
"""


@dataclass
class SessionRecord:
    """Persistent mapping between an AG-UI thread and a managed session."""

    session_id: str
    tool_names: list[str] = field(default_factory=list)
    """Custom tool names currently registered on the session's agent."""
    tool_definitions_fingerprint: str | None = None
    """Fingerprint of the canonical custom tool definitions registered on the session."""
    pending_client_tool_use_ids: list[str] = field(default_factory=list)
    """Custom tool calls handed to the frontend that the session is parked on.

    The next run must answer them with `role: "tool"` messages.
    """
    last_user_message_id: str | None = None
    """ID of the last user message forwarded into the session."""


@runtime_checkable
class SessionStore(Protocol):
    """Where thread-to-session mappings live.

    The default is in-memory (lost on restart, in which case a fresh session
    is created). Provide your own to survive restarts or run several replicas.
    Methods may be plain functions or coroutines.

    `key` is opaque: it is derived from the managed agent id and the AG-UI
    thread id, so two agents sharing one store never adopt each other's
    sessions. Treat it as a string to store under, not as a thread id to parse.
    Thread ids are client-supplied, so put the endpoint behind your own
    authentication and use a store that partitions by caller if you need
    multi-tenant isolation.
    """

    def get(self, key: str) -> SessionRecord | None | Awaitable[SessionRecord | None]: ...

    def set(self, key: str, record: SessionRecord) -> None | Awaitable[None]: ...

    def delete(self, key: str) -> None | Awaitable[None]: ...


TurnStatus = Literal["finished", "parked", "errored"]


@dataclass
class TurnOutcome:
    """How a turn ended.

    `parked`: the session is parked on custom tool calls the frontend must
    answer. `errored`: a RUN_ERROR was already emitted.
    """

    status: TurnStatus
    client_tool_use_ids: list[str] = field(default_factory=list)
    session_ended: bool = False
    session_interrupted: bool = False
    """Whether a `user.interrupt` reached the session.

    It cancels whatever the session was waiting on, so any park recorded during
    this turn is no longer answerable and must not be carried into the next run.
    """
