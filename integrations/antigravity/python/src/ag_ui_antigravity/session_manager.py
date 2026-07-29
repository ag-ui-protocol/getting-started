"""Keeps a live Antigravity session per AG-UI ``thread_id``.

AG-UI is one run per HTTP POST. An Antigravity ``Conversation`` is a long-lived
Go subprocess doing real file and shell work. Bridging the two is the bulk of
this integration, and it has two distinct resume modes:

``hot resume`` (required for HITL)
    While a hook or custom tool is parked, the subprocess *and its blocked
    coroutine* must stay in memory. A suspended coroutine cannot be serialized,
    so mid-decision state only exists in-process. Parked sessions therefore get
    a much longer grace period than idle ones -- but not an exemption, or a user
    who closes the tab mid-request pins a Go subprocess for good.

``cold resume`` (plain multi-turn)
    A recycled session with nothing parked is rebuilt from the SDK's own
    ``conversation_id`` + ``session_continuation_mode=RESUME`` + ``save_dir``.

Sessions are also keyed on the client's tool signature: Antigravity fixes the
tool list in the harness config at connect time and exposes no way to update it
mid-session, so a client that changes its ``tools`` between runs forces a
rebuild (cold resume) rather than silently running with a stale tool list.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from google.antigravity import Agent
from google.antigravity import types as ag_types

from .ui_bridge import UIBridge

logger = logging.getLogger(__name__)


class SessionLimitExceeded(RuntimeError):
    """Raised when the configured concurrent-session cap is reached."""


@dataclass
class AntigravitySession:
    """One live Antigravity process bound to an AG-UI thread."""

    thread_id: str
    agent: Agent
    bridge: UIBridge
    tool_signature: str
    conversation_id: Optional[str] = None
    last_activity: float = field(default_factory=time.monotonic)
    # The live `receive_steps()` iterator, kept across a park. The Antigravity
    # turn spans both HTTP runs, so tearing the iterator down and starting a
    # fresh one on resume makes the harness re-deliver steps we already
    # translated -- the same tool call would be replayed to the client forever.
    step_iter: Optional[Any] = None
    # An `__anext__()` future that was already in flight when the run parked.
    # It must be awaited, not cancelled: cancelling it destroys the step the
    # harness is mid-way through delivering.
    pending_step: Optional[asyncio.Future] = None
    # Translator state (message ids, which steps/tool calls are already done)
    # is per-TURN, not per-run, for the same reason as `step_iter`.
    translator: Optional[Any] = None
    # Ids of user messages already sent to the harness. The harness owns the
    # conversation history, so a message must be forwarded exactly once --
    # and the AG-UI client resends the whole transcript every run.
    forwarded_prompts: set = field(default_factory=set)
    # Set when the manager tears this session down. A run holds a direct
    # reference and can be suspended in an await at that moment, so it has to
    # be able to notice that the session it is using is no longer live.
    closed: bool = False
    # Serializes runs on the same thread; AG-UI clients can retry or
    # double-submit, and the SDK rejects concurrent receive_steps().
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def touch(self) -> None:
        self.last_activity = time.monotonic()

    def raise_if_closed(self) -> None:
        """Aborts a run whose session was torn down underneath it.

        A forced close removes the session from the manager while a run may be
        suspended in an await. Carrying on would drive a shut-down harness,
        park requests on a bridge that has already been failed, and leave all
        of it on an object no sweeper can ever reach again.
        """
        if self.closed:
            raise ag_types.AntigravityCancelledError(
                "The Antigravity session was closed while the run was in progress."
            )

    async def reset_stream(self) -> Optional[BaseException]:
        """Retires all per-turn state, returning any unobserved harness failure.

        Drops the ``receive_steps()`` iterator, any in-flight ``__anext__()``,
        the translator, and the bridge's frontend-tool claims. Called when the
        turn ends normally, when it errors, and when a new user prompt abandons
        a parked one -- so it is not only an end-of-turn hook.
        """
        iterator, self.step_iter = self.step_iter, None
        pending, self.pending_step = self.pending_step, None
        self.translator = None
        self.bridge.reset_turn()

        failure: Optional[BaseException] = None
        if pending is not None:
            if pending.done():
                # A harness failure that landed while the run was parked. Left
                # unretrieved it becomes a bare "Task exception was never
                # retrieved" at GC, with the real error lost.
                if not pending.cancelled():
                    raised = pending.exception()
                    # StopAsyncIteration is how the iterator reports a turn
                    # that simply ended -- routine when the harness backgrounds
                    # a slow tool and goes idle while we are parked. Treating it
                    # as a failure would abort the user's next message.
                    if not isinstance(raised, StopAsyncIteration):
                        failure = raised
            else:
                pending.cancel()
                # Let the cancellation actually run: aclose() on a generator
                # whose __anext__ is still suspended raises "already running",
                # and returning without ever yielding leaves the SDK's
                # _is_receiving set for the next send().
                with contextlib.suppress(asyncio.CancelledError):
                    await pending

        if iterator is not None and hasattr(iterator, "aclose"):
            try:
                await iterator.aclose()
            except Exception:
                # A stream left open can duplicate or error on the next turn,
                # so this is worth seeing in production, not just at DEBUG.
                logger.warning("Error closing step iterator", exc_info=True)
        return failure

    @property
    def conversation(self):
        return self.agent.conversation

    @property
    def is_parked(self) -> bool:
        """True while a hook or frontend tool is awaiting the client."""
        return self.bridge.has_pending


def tool_signature(tool_names: List[str]) -> str:
    """Stable fingerprint of the client's tool set."""
    payload = json.dumps(sorted(tool_names))
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


class SessionManager:
    """Owns the ``thread_id -> live Conversation`` map, with idle cleanup."""

    def __init__(
        self,
        *,
        session_timeout_seconds: int = 1800,
        cleanup_interval_seconds: int = 60,
        max_sessions: int = 50,
        parked_timeout_seconds: int = 7200,
    ):
        self._sessions: Dict[str, AntigravitySession] = {}
        self._session_timeout = session_timeout_seconds
        # A parked session is pinned so its suspended coroutine survives, but
        # an unanswered request must not pin it forever: a user who closes the
        # tab mid-HITL would otherwise hold a Go subprocess for the process
        # lifetime, and `max_sessions` such tabs wedge the server for good.
        self._parked_timeout = parked_timeout_seconds
        self._cleanup_interval = cleanup_interval_seconds
        self._max_sessions = max_sessions
        self._cleanup_task: Optional[asyncio.Task] = None
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self) -> None:
        if self._cleanup_task is None or self._cleanup_task.done():
            self._cleanup_task = asyncio.create_task(self._cleanup_loop())

    async def stop(self) -> None:
        if self._cleanup_task:
            self._cleanup_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._cleanup_task
            self._cleanup_task = None
        for thread_id in list(self._sessions):
            # Shutdown must not leave a Go subprocess behind, even mid-run.
            await self.close(thread_id, force=True)

    async def _cleanup_loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(self._cleanup_interval)
                await self.sweep()
            except asyncio.CancelledError:
                raise
            except Exception:  # keep the sweeper alive across a transient failure
                logger.exception("Session cleanup sweep failed")

    async def sweep(self) -> int:
        """Closes reclaimable sessions (see ``_expired``)."""
        now = time.monotonic()
        candidates = [tid for tid, s in self._sessions.items() if self._expired(s, now)]
        reclaimed = 0
        for thread_id in candidates:
            async with self._lock:
                # Re-checked under the lock: this loop awaits between closes, so
                # a candidate can have picked up a run since the snapshot.
                if thread_id not in self._sessions:
                    continue
                if not self._expired(self._sessions[thread_id], time.monotonic()):
                    continue
                logger.info("Closing idle Antigravity session %s", thread_id)
                await self._close_locked(thread_id)
                reclaimed += 1
        return reclaimed

    def _expired(self, session: "AntigravitySession", now: float) -> bool:
        """True when a session may be reclaimed.

        Parked sessions get a much longer grace period rather than an exemption
        -- the suspended coroutine must survive a human thinking, not a human
        who never comes back.
        """
        # A run in flight holds the lock. Reclaiming underneath it cancels the
        # `__anext__` the loop is awaiting, and CancelledError is a
        # BaseException -- it escapes every `except Exception` between here and
        # the SSE writer, so the client gets an unclosed message and a stream
        # that simply stops, with no terminal event at all.
        if session.lock.locked():
            return False
        idle = now - session.last_activity
        if session.is_parked:
            # Never shorter than the ordinary timeout: a parked session is
            # waiting on a human and deserves at least as long as an idle one.
            return idle > max(self._parked_timeout, self._session_timeout)
        return idle > self._session_timeout

    # ------------------------------------------------------------------
    # Access
    # ------------------------------------------------------------------

    def get(self, thread_id: str) -> Optional[AntigravitySession]:
        return self._sessions.get(thread_id)

    async def get_or_create(
        self,
        thread_id: str,
        *,
        signature: str,
        factory: Callable[[UIBridge, Optional[str]], Agent],
        bridge_factory: Callable[[], UIBridge] = UIBridge,
    ) -> AntigravitySession:
        """Returns the live session for ``thread_id``, creating it if needed.

        Args:
          thread_id: AG-UI thread id.
          signature: Fingerprint of the client's tool set. A mismatch against a
            non-parked session triggers a cold-resume rebuild.
          factory: Builds a fresh ``Agent`` given the session's bridge and, for
            cold resume, the previous ``conversation_id``.
        """
        async with self._lock:
            recycled: Optional[str] = None
            carried: set = set()
            existing = self._sessions.get(thread_id)
            if existing is not None:
                if existing.tool_signature == signature or existing.is_parked:
                    if existing.tool_signature != signature:
                        logger.warning(
                            "Tool set changed for parked thread %s; keeping the "
                            "live session so the parked coroutine survives.",
                            thread_id,
                        )
                    existing.touch()
                    return existing
                if existing.lock.locked():
                    # A run is streaming on this session. Tearing it down here
                    # cancels the future that run awaits, and CancelledError is
                    # a BaseException -- it escapes to the SSE writer and the
                    # client gets no terminal event. Defer: the in-flight run
                    # keeps the old tool list, the next one rebuilds.
                    logger.warning(
                        "Tool set changed for thread %s while a run is in "
                        "flight; deferring the rebuild to the next run.",
                        thread_id,
                    )
                    existing.touch()
                    return existing
                logger.info(
                    "Tool set changed for thread %s; rebuilding via cold resume.",
                    thread_id,
                )
                recycled, carried = await self._close_locked(
                    thread_id, keep_conversation_id=True
                )

            if len(self._sessions) >= self._max_sessions:
                # Try to make room before refusing.
                await self._sweep_locked()
                if len(self._sessions) >= self._max_sessions:
                    raise SessionLimitExceeded(
                        f"Refusing to start a new Antigravity session: "
                        f"{len(self._sessions)} of {self._max_sessions} in use."
                    )

            bridge = bridge_factory()
            agent = factory(bridge, recycled)
            await agent.__aenter__()
            session = AntigravitySession(
                thread_id=thread_id,
                agent=agent,
                bridge=bridge,
                tool_signature=signature,
                conversation_id=agent.conversation_id,
                # Carried across a cold resume: the rebuilt harness restores the
                # same conversation, so those prompts are still in its history.
                forwarded_prompts=carried,
            )
            self._sessions[thread_id] = session
            logger.info(
                "Started Antigravity session for thread %s (%d live)",
                thread_id,
                len(self._sessions),
            )
            return session

    async def close(self, thread_id: str, *, force: bool = True) -> None:
        """Closes a session. Explicit by default, so it does not silently skip."""
        async with self._lock:
            await self._close_locked(thread_id, force=force)

    async def _close_locked(
        self,
        thread_id: str,
        *,
        keep_conversation_id: bool = False,
        force: bool = False,
    ) -> tuple:
        """Closes a session, returning ``(conversation_id, forwarded_prompts)``.

        Both are needed to cold-resume: the harness restores the conversation,
        so its history already contains the prompts we forwarded.

        Reclamation is refused while a run holds ``session.lock``. The check
        lives here, under the manager lock, because ``sweep()`` picks its
        victims and then awaits between closes -- a session can go live in that
        window. Closing one underneath its run cancels the future the run is
        awaiting, and ``CancelledError`` is a ``BaseException``: it escapes
        every ``except Exception`` up to the SSE writer, so the client gets no
        terminal event at all. ``force`` is for shutdown, which must tear down
        even a busy session rather than leak its subprocess.
        """
        session = self._sessions.get(thread_id)
        if session is None:
            return (None, set())
        if not force and session.lock.locked():
            logger.debug(
                "Not reclaiming session %s: a run is in flight", thread_id
            )
            return (None, set())
        self._sessions.pop(thread_id, None)
        # Flagged before the awaits below: a run suspended inside one of them
        # must not resume onto a session the manager has abandoned.
        session.closed = True
        recycled = None
        carried: set = set()
        if keep_conversation_id:
            recycled = session.conversation_id or getattr(
                session.agent, "conversation_id", None
            )
            carried = set(session.forwarded_prompts)
        session.bridge.fail_all(
            RuntimeError("The Antigravity session was closed before the client replied.")
        )
        await session.reset_stream()
        try:
            await session.agent.__aexit__(None, None, None)
        except Exception:  # teardown best effort
            logger.exception("Error shutting down Antigravity session %s", thread_id)
        return (recycled, carried)

    async def _sweep_locked(self) -> None:
        now = time.monotonic()
        for tid in [t for t, s in self._sessions.items() if self._expired(s, now)]:
            await self._close_locked(tid)

    # ------------------------------------------------------------------
    # Introspection
    # ------------------------------------------------------------------

    def stats(self) -> Dict[str, Any]:
        return {
            "live_sessions": len(self._sessions),
            "parked_sessions": sum(1 for s in self._sessions.values() if s.is_parked),
            "max_sessions": self._max_sessions,
            "session_timeout_seconds": self._session_timeout,
            "parked_timeout_seconds": max(
                self._parked_timeout, self._session_timeout
            ),
        }
