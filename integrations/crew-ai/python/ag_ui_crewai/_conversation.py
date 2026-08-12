"""CrewAI Conversational Flow turn and stream adaptation helpers."""

from __future__ import annotations

import asyncio
import contextvars
from dataclasses import dataclass
import logging
import threading
from typing import Any, Sequence

from pydantic import BaseModel

from .utils import dump_agui_message


_LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class ConversationalTurn:
    """One textual turn plus the history that must precede it."""

    message: str
    history: list[dict[str, Any]]
    current_media: list[dict[str, Any]]


def prepare_conversational_turn(messages: Sequence[Any]) -> ConversationalTurn:
    """Prepare one public ``stream_turn`` invocation from AG-UI history."""
    dumped = [dump_agui_message(message) for message in messages]
    current_index = (
        len(dumped) - 1 if dumped and dumped[-1].get("role") == "user" else None
    )

    if current_index is None:
        history = [message for message in dumped if message.get("role") != "system"]
        return ConversationalTurn(message="", history=history, current_media=[])

    history = [
        message for message in dumped[:current_index] if message.get("role") != "system"
    ]
    content = dumped[current_index].get("content")
    if isinstance(content, str):
        return ConversationalTurn(
            message=content,
            history=history,
            current_media=[],
        )

    text_parts: list[str] = []
    media_parts: list[dict[str, Any]] = []
    if isinstance(content, list):
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "text":
                text = part.get("text")
                if isinstance(text, str):
                    text_parts.append(text)
            else:
                media_parts.append(part)

    return ConversationalTurn(
        message="\n".join(text_parts),
        history=history,
        current_media=media_parts,
    )


def hydrate_conversational_flow(
    flow: Any,
    inputs: dict[str, Any],
    turn: ConversationalTurn,
) -> dict[str, Any]:
    """Seed regular AG-UI inputs before ``stream_turn`` adds current text."""
    seeded_messages = list(turn.history)
    if turn.current_media:
        seeded_messages.append({"role": "user", "content": list(turn.current_media)})
    hydrated = {**inputs, "messages": seeded_messages}

    state = getattr(flow, "_state", None)
    if isinstance(state, dict):
        state.update(hydrated)
        return hydrated
    if isinstance(state, BaseModel):
        current = state.model_dump()
        object.__setattr__(
            flow,
            "_state",
            type(state).model_validate({**current, **hydrated}),
        )
        return hydrated
    raise TypeError("Conversational Flow state must be a mapping or Pydantic model")


class _InputOverlayPersistence:
    """Overlay AG-UI request state onto a CrewAI persistence restore."""

    def __init__(self, persistence: Any, inputs: dict[str, Any]):
        self._persistence = persistence
        self._inputs = {key: value for key, value in inputs.items() if key != "id"}

    def load_state(self, flow_uuid: str) -> dict[str, Any] | None:
        stored = self._persistence.load_state(flow_uuid)
        if stored is None:
            return None
        return {**stored, **self._inputs}

    def __getattr__(self, name: str) -> Any:
        return getattr(self._persistence, name)


def overlay_conversational_persistence(
    flow: Any,
    inputs: dict[str, Any],
) -> None:
    """Make incoming AG-UI state win after CrewAI restores a session."""
    persistence = getattr(flow, "persistence", None)
    if persistence is None:
        return
    object.__setattr__(
        flow,
        "persistence",
        _InputOverlayPersistence(persistence, inputs),
    )


def force_per_turn_trace_finalization(flow: Any) -> None:
    """Make each AG-UI request own a complete CrewAI flow trace lifecycle.

    CrewAI reads the deferral decision through ``_should_defer_trace_finalization``
    (base Flow: the instance ``defer_trace_finalization`` attr; the conversational
    mixin: that OR the static ``conversational`` definition). Override the seam on
    the INSTANCE and set the instance attr, rather than flipping the shared
    ``conversational_config`` / class-cached flow definition -- serving one request
    must not permanently rewrite deferral for every other instance of the flow
    class in the same process.
    """
    object.__setattr__(flow, "defer_trace_finalization", False)
    if hasattr(type(flow), "_should_defer_trace_finalization"):
        object.__setattr__(flow, "_should_defer_trace_finalization", lambda: False)


class SyncStreamSessionAdapter:
    """Expose CrewAI's synchronous ``StreamSession`` as an async iterator."""

    def __init__(self, session: Any):
        self._session = session
        self._queue: asyncio.Queue[tuple[str, Any]] | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._cooperative_stop_logged = False

    def __aiter__(self):
        return self._iterate()

    def _start(self) -> None:
        if self._thread is not None:
            return
        self._loop = asyncio.get_running_loop()
        self._queue = asyncio.Queue()
        context = contextvars.copy_context()

        def publish(kind: str, value: Any = None) -> None:
            if self._loop is None or self._queue is None:
                return
            try:
                self._loop.call_soon_threadsafe(
                    self._queue.put_nowait,
                    (kind, value),
                )
            except RuntimeError:
                # The request loop already closed; no consumer remains to notify.
                return

        def produce() -> None:
            try:
                for frame in self._session:
                    if self._stop.is_set():
                        break
                    publish("item", frame)
            except Exception as exc:  # noqa: BLE001 - cross thread boundary
                publish("error", exc)
            finally:
                close = getattr(self._session, "close", None)
                if callable(close):
                    try:
                        close()
                    except Exception:  # noqa: BLE001 - teardown boundary
                        _LOGGER.exception(
                            "ag-ui-crewai failed to close a conversational "
                            "StreamSession after its worker stopped"
                        )
                publish("done")

        self._thread = threading.Thread(
            target=context.run,
            args=(produce,),
            daemon=True,
            name="ag-ui-crewai-conversation-stream",
        )
        self._thread.start()

    async def _iterate(self):
        self._start()
        assert self._queue is not None
        try:
            while True:
                kind, value = await self._queue.get()
                if kind == "item":
                    yield value
                elif kind == "error":
                    raise value
                else:
                    return
        finally:
            await self.aclose()

    async def aclose(self) -> None:
        """Request a cooperative stop without blocking the request loop.

        Deliberately weak teardown, stated plainly. CrewAI's synchronous
        generator cannot be closed safely from this event-loop thread while its
        worker is executing (Python raises ``ValueError: generator already
        executing``), so this only sets a flag. Two limits follow: ``_stop`` is
        observed only BETWEEN frames -- after ``next()`` returns (see the produce
        loop) -- so a provider call that emits nothing never sees it; and even
        once seen, the worker still blocks in ``session.close()`` -> CrewAI's
        ``finally: thread.join()`` for the remainder of the turn. This is weaker
        than the async StreamFrame path, which cancels the kickoff task outright;
        conversational is opt-in behind ``conversational=True``. The point of the
        flag and the warning is to make the limitation observable, not to
        guarantee prompt cancellation.
        """
        self._stop.set()
        if self._thread is None:
            close = getattr(self._session, "close", None)
            if callable(close):
                close()
        elif self._thread.is_alive() and not self._cooperative_stop_logged:
            _LOGGER.warning(
                "ag-ui-crewai requested cooperative cancellation of a "
                "conversational StreamSession; the CrewAI sync worker stays "
                "active until its current upstream operation emits or returns, "
                "then blocks in session.close() for the rest of the turn",
                extra={"worker_thread": self._thread.name},
            )
            self._cooperative_stop_logged = True
