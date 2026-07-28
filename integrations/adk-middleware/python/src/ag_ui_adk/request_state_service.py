# src/ag_ui_adk/request_state_service.py

"""Session service wrapper that injects per-invocation ``temp:`` state.

ADK's :class:`Runner` fetches sessions fresh via ``session_service.get_session``
at the start of each invocation. Because every stock session service strips
``temp:``-prefixed keys before persisting them (see
``BaseSessionService._apply_temp_state`` / ``_trim_temp_delta_state``),
``temp:`` state produced *outside* an invocation — for example by the
``extract_state_from_request`` hook on the FastAPI endpoint — cannot reach
``tool_context.state`` through the normal ``append_event`` path.

This wrapper sits in front of the user-supplied session service and merges
pending ``temp:`` state into the session returned by ``get_session`` for a
specific ``(app_name, user_id, session_id)`` triple. All other calls are
forwarded verbatim, so the wrapper is transparent when no pending state is
registered.

See https://github.com/ag-ui-protocol/ag-ui/issues/1571.
"""

from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

from google.adk.events import Event
from google.adk.sessions.base_session_service import (
    BaseSessionService,
    GetSessionConfig,
    ListSessionsResponse,
)
from google.adk.sessions.session import Session


_PendingKey = Tuple[str, str, str]  # (app_name, user_id, session_id)


class RequestStateSessionService(BaseSessionService):
    """Transparently proxies a session service, injecting pending ``temp:`` state.

    The wrapper holds an in-memory mapping from
    ``(app_name, user_id, session_id)`` to a dict of ``temp:``-prefixed keys.
    On every call to :meth:`get_session`, the wrapper delegates to the inner
    service and, if any pending state is registered for that triple, merges it
    into ``session.state`` before returning. The pending entry is *not* cleared
    automatically — callers must call :meth:`clear_pending_temp_state` once the
    invocation has finished so later invocations do not inherit stale values.
    """

    def __init__(self, inner: BaseSessionService) -> None:
        self._inner = inner
        self._pending_temp_state: Dict[_PendingKey, Dict[str, Any]] = {}

    @property
    def inner(self) -> BaseSessionService:
        """The wrapped session service."""
        return self._inner

    def set_pending_temp_state(
        self,
        *,
        app_name: str,
        user_id: str,
        session_id: str,
        temp_state: Optional[Dict[str, Any]],
    ) -> None:
        """Register ``temp:`` state to inject on the next ``get_session`` call.

        Passing an empty dict or ``None`` removes any existing pending state
        for the triple.
        """
        key = (app_name, user_id, session_id)
        if temp_state:
            self._pending_temp_state[key] = dict(temp_state)
        else:
            self._pending_temp_state.pop(key, None)

    def clear_pending_temp_state(
        self, *, app_name: str, user_id: str, session_id: str
    ) -> None:
        """Remove any pending ``temp:`` state for the given triple."""
        self._pending_temp_state.pop((app_name, user_id, session_id), None)

    def _inject(self, session: Optional[Session], key: _PendingKey) -> Optional[Session]:
        if session is None:
            return None
        temp_state = self._pending_temp_state.get(key)
        if not temp_state:
            return session
        for k, v in temp_state.items():
            session.state[k] = v
        return session

    # ------------------------------------------------------------------
    # BaseSessionService interface — delegate to the inner implementation
    # ------------------------------------------------------------------

    async def create_session(
        self,
        *,
        app_name: str,
        user_id: str,
        state: Optional[Dict[str, Any]] = None,
        session_id: Optional[str] = None,
    ) -> Session:
        session = await self._inner.create_session(
            app_name=app_name,
            user_id=user_id,
            state=state,
            session_id=session_id,
        )
        if session is not None:
            self._inject(session, (app_name, user_id, session.id))
        return session

    async def get_session(
        self,
        *,
        app_name: str,
        user_id: str,
        session_id: str,
        config: Optional[GetSessionConfig] = None,
    ) -> Optional[Session]:
        session = await self._inner.get_session(
            app_name=app_name,
            user_id=user_id,
            session_id=session_id,
            config=config,
        )
        return self._inject(session, (app_name, user_id, session_id))

    async def list_sessions(
        self, *, app_name: str, user_id: Optional[str] = None
    ) -> ListSessionsResponse:
        return await self._inner.list_sessions(app_name=app_name, user_id=user_id)

    async def delete_session(
        self, *, app_name: str, user_id: str, session_id: str
    ) -> None:
        self._pending_temp_state.pop((app_name, user_id, session_id), None)
        await self._inner.delete_session(
            app_name=app_name, user_id=user_id, session_id=session_id
        )

    async def append_event(self, session: Session, event: Event) -> Event:
        return await self._inner.append_event(session=session, event=event)

    async def flush(self) -> None:
        """Delegate to the inner service's flush implementation.

        ADK's ``Runner.close()`` calls ``session_service.flush()`` to persist
        buffered state in write-behind session services. Without this override,
        the wrapper inherits ``BaseSessionService.flush`` (a no-op) and any
        buffering inner service is silently never flushed — causing data loss.

        See https://github.com/ag-ui-protocol/ag-ui/issues/2206.
        """
        inner_flush = getattr(self._inner, "flush", None)
        if inner_flush is not None:
            await inner_flush()
