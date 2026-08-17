"""CrewAI Conversational Flow turn and stream adaptation helpers."""

from __future__ import annotations

import asyncio
import contextvars
import copy
from dataclasses import dataclass, field
import logging
import threading
import time
from typing import Any, Sequence

from pydantic import BaseModel, model_serializer

from ._capabilities import conversational_message_roles
from ._config import resolve_max_conversation_workers
from .utils import dump_agui_message


_LOGGER = logging.getLogger(__name__)

# Name every sync conversational worker thread carries. Exported rather than
# inlined at the one construction site so an operator grepping a thread dump and
# a test asserting no worker outlived its request read the same string.
WORKER_THREAD_NAME = "ag-ui-crewai-conversation-stream"


class AbandonmentSignal:
    """One-shot "this AG-UI request is gone, publish nothing more" flag.

    ONE instance per run, shared by every layer that could still publish after
    the request generator has torn down: the sync worker thread (which reads it
    between frames), the adapter's loop hand-off, the scoped raw-event sink, and
    the persistence overlay. A shared signal rather than a flag per layer,
    because the layers abandon at different moments but must agree on the same
    decision; a worker that keeps parking events into a buffer nobody reads, or
    writing state a newer turn already replaced, is the failure mode.

    ``threading.Event`` because the setter is the request loop and the readers
    include a worker thread. ``_abandoned_at`` is written BEFORE the event is
    set, so any reader that observes ``abandoned`` also observes the timestamp.
    """

    __slots__ = ("_event", "_lock", "_abandoned_at")

    def __init__(self) -> None:
        self._event = threading.Event()
        # The request loop and the worker thread can both abandon (a disconnect
        # racing a per-frame ceiling), so the claim below is a lock, not a
        # check-then-act: two callers would otherwise both pass the test and the
        # second would move a timestamp operators read as "abandoned this long".
        self._lock = threading.Lock()
        self._abandoned_at: float | None = None

    def abandon(self) -> None:
        """Mark the run abandoned. Idempotent; keeps the FIRST timestamp."""
        with self._lock:
            if self._abandoned_at is not None:
                return
            self._abandoned_at = time.monotonic()
            self._event.set()

    @property
    def abandoned(self) -> bool:
        return self._event.is_set()

    @property
    def abandoned_at(self) -> float | None:
        """Monotonic stamp of the abandonment, or ``None`` if still live."""
        return self._abandoned_at


@dataclass(frozen=True)
class ConversationWorkerStats:
    """Point-in-time view of the sync conversational worker population."""

    max_workers: int
    active: int
    abandoned_active: int
    oldest_abandoned_age_seconds: float | None
    capacity_rejections: int
    thread_conflict_rejections: int


class ConversationCapacityExceeded(RuntimeError):
    """No slot left in the process-wide sync conversational worker pool.

    Raised INSTEAD of starting another unkillable thread. The caller maps it to
    a correlated RUN_ERROR so the client is told the deployment is saturated
    rather than being served a run that quietly competes for the same threads.
    """


class ConversationThreadBusy(RuntimeError):
    """An ABANDONED worker for this flow's ``threadId`` is still running.

    Abandonment is what conflicts, not concurrency as such. A turn whose run
    reached a terminal event keeps working after its last frame (assistant
    append, terminal handlers, thread join), and refusing the conversation's next
    message for that tail would break ordinary back-to-back turns. An abandoned
    turn is the one worth refusing: nobody is reading it, it is still running
    against the same conversation inside CrewAI, and when it lands relative to
    the new turn is not knowable from here.
    """


class ConversationWorkerAborted(RuntimeError):
    """The turn's frames are gone; this is not a normal end of stream.

    Raised into the request in place of an exhausted stream when the worker
    unwound on a ``BaseException``, when an adapter whose consumer already tore
    down is iterated again, and when one whose session was closed before any
    worker read it is iterated at all. Each case otherwise looks exactly like
    natural exhaustion, and the driver finalizes that into a successful
    RUN_FINISHED on a turn nobody ever saw.
    """


def conversational_flow_key(flow: Any) -> str:
    """Which FLOW a conversation belongs to, for the pool key.

    The registry is process-wide and one process serves many endpoints (the dojo
    serves about fifteen), while ``threadId`` is chosen by the client. Keying a
    conversation by the thread alone therefore makes two unrelated flows that
    happen to share an id one conversation, and an abandoned turn on either
    refuses fresh turns on the other.

    The flow's qualified CLASS name, not ``id(flow)``: the driver holds a
    per-request copy, and the lazy persistence guard reparents that copy onto a
    synthesized subclass, so object identity differs between the turns of one
    conversation. That subclass carries the original's ``__qualname__`` and
    ``__module__`` (see :func:`_guarded_flow_class`), so the key is stable across
    both. Two endpoints serving separate INSTANCES of one flow class do share a
    key; they also share crewai's persistence namespace for a session id, so
    treating them as one conversation is the safe direction to be wrong in.
    """
    cls = type(flow)
    module = getattr(cls, "__module__", "?")
    name = getattr(cls, "__qualname__", None) or getattr(cls, "__name__", "?")
    return f"{module}.{name}"


def _lease_abandoned(lease: "ConversationWorkerLease") -> bool:
    """The ONE predicate for "the run holding this slot was abandoned".

    Shared by the kickoff conflict gate, the population stats, and the
    termination log. Two predicates for one question (the event versus the
    presence of a timestamp) is how those three come to disagree about the same
    lease, and each of them decides something operators read.
    """
    return lease.signal.abandoned


class ConversationWorkerLease:
    """A held slot in the worker pool, released when the worker really ends.

    Released from the worker thread's own ``finally`` rather than from the
    request teardown: the entire point of the accounting is that the thread
    outlives the request, so releasing at teardown would report capacity that
    does not exist. ``release`` is idempotent so the never-started path can
    release it from the request side without double-counting.
    """

    __slots__ = ("flow_key", "thread_id", "run_id", "signal", "started_at",
                 "_registry", "_released")

    def __init__(
        self,
        *,
        registry: "ConversationWorkerRegistry",
        flow_key: str,
        thread_id: str,
        run_id: str,
        signal: AbandonmentSignal,
    ) -> None:
        self._registry = registry
        self.flow_key = flow_key
        self.thread_id = thread_id
        self.run_id = run_id
        self.signal = signal
        self.started_at = time.monotonic()
        self._released = False

    @property
    def age_seconds(self) -> float:
        """How long this slot has been held, for the lines operators read."""
        return time.monotonic() - self.started_at

    @property
    def released(self) -> bool:
        return self._released

    def release(self) -> None:
        self._registry._release(self)  # pylint: disable=protected-access


class ConversationWorkerRegistry:
    """Process-wide bound and bookkeeping for sync conversational workers.

    A plain ``threading.Lock``, not an ``asyncio`` one: releases arrive from
    worker threads, acquisitions from request loops, and the critical section is
    a few list operations.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._leases: list[ConversationWorkerLease] = []
        self._capacity_rejections = 0
        self._thread_conflict_rejections = 0

    def acquire(
        self,
        *,
        flow_key: str,
        thread_id: str,
        run_id: str,
        signal: AbandonmentSignal,
        max_workers: int | None = None,
    ) -> ConversationWorkerLease:
        """Reserve a worker slot, or raise the reason it cannot be reserved."""
        ceiling = (
            resolve_max_conversation_workers() if max_workers is None else max_workers
        )
        rejection: Exception | None = None
        reason = ""
        lease: ConversationWorkerLease | None = None
        stats: ConversationWorkerStats | None = None
        concurrent_live: tuple[str, float] | None = None
        # Nothing is logged while the lock is held: a logging handler that reads
        # the pool back would deadlock on this non-reentrant lock.
        with self._lock:
            stale = self._lease_for_conversation_locked(
                flow_key, thread_id, abandoned=True
            )
            if stale is not None:
                self._thread_conflict_rejections += 1
                reason = "thread-busy-rejected"
                rejection = ConversationThreadBusy(
                    conversational_thread_busy_detail(
                        thread_id=thread_id, run_id=stale.run_id
                    )
                )
            elif len(self._leases) >= ceiling:
                self._capacity_rejections += 1
                reason = "capacity-rejected"
                rejection = ConversationCapacityExceeded(
                    f"all {ceiling} CrewAI sync conversational worker slots are in use"
                )
            else:
                live = self._lease_for_conversation_locked(
                    flow_key, thread_id, abandoned=False
                )
                if live is not None:
                    concurrent_live = (live.run_id, live.age_seconds)
                lease = ConversationWorkerLease(
                    registry=self,
                    flow_key=flow_key,
                    thread_id=thread_id,
                    run_id=run_id,
                    signal=signal,
                )
                self._leases.append(lease)
            if lease is None:
                # Only on the rejection paths: the population walk is what the
                # refusal message and its log line are made of, and computing it
                # under the lock on every successful acquire threw it away.
                stats = self._stats_locked(ceiling)
        if lease is not None:
            if concurrent_live is not None:
                # Admitted, and deliberately so: refusing an ordinary back-to-back
                # message for the length of a finished turn's tail is worse than
                # the write race it would prevent (the README documents that the
                # race stays open). Logged because it is the window in which the
                # older turn's write can still land last, and nothing else says so.
                _LOGGER.info(
                    "ag-ui-crewai admitted a second live conversational turn "
                    "flow=%s thread=%s run=%s while run=%s has held its slot for "
                    "%.1fs; the older turn's remaining writes are NOT gated",
                    flow_key,
                    thread_id,
                    run_id,
                    concurrent_live[0],
                    concurrent_live[1],
                )
            return lease
        _log_worker_stats(
            reason,
            thread_id=thread_id,
            run_id=run_id,
            # Every no-lease branch computed the population under the lock, so the
            # fallback never runs; it is here so the argument matches the signature
            # instead of the reader having to prove the flow.
            stats=stats if stats is not None else self.stats(),
            level=logging.WARNING,
        )
        # Every no-lease branch above sets ``rejection``; the fallback keeps the
        # signature honest instead of handing the caller a ``None`` slot.
        raise (
            rejection
            if rejection is not None
            else ConversationCapacityExceeded(
                f"could not reserve one of {ceiling} CrewAI sync conversational "
                "worker slots"
            )
        )

    def _lease_for_conversation_locked(
        self,
        flow_key: str | None,
        thread_id: str,
        *,
        abandoned: bool,
    ) -> ConversationWorkerLease | None:
        """The one predicate for "this conversation is busy elsewhere".

        Shared by the kickoff gate, the concurrency log and the read-only query so
        they can never disagree about what counts as one conversation. A lease
        matches on the FLOW and the thread: see :func:`conversational_flow_key`.
        ``None`` widens the match to every flow, which only the read-only query
        passes. Caller holds ``_lock``.
        """
        for held in self._leases:
            if held.thread_id != thread_id:
                continue
            if flow_key is not None and held.flow_key != flow_key:
                continue
            if _lease_abandoned(held) is abandoned:
                return held
        return None

    def abandoned_run_for_thread(
        self,
        thread_id: str,
        *,
        flow_key: str | None = None,
    ) -> str | None:
        """Run id of an abandoned turn still executing for this conversation.

        ``flow_key`` restricts the answer to ONE flow's conversation, which is what
        a gate must pass: without it this reports any flow's abandoned turn on the
        thread, which is a read-only "is this id busy anywhere" question.
        """
        with self._lock:
            lease = self._lease_for_conversation_locked(
                flow_key, thread_id, abandoned=True
            )
            return None if lease is None else lease.run_id

    def _release(self, lease: ConversationWorkerLease) -> None:
        # Resolved before the lock, and LIVE rather than from acquire time: the
        # resolver can log (a handler that reads the pool back would deadlock on
        # this non-reentrant lock), and a termination line that reports the
        # ceiling as it was hours ago disagrees with ``stats()`` after an
        # operator raises it.
        ceiling = resolve_max_conversation_workers()
        with self._lock:
            if lease._released:  # pylint: disable=protected-access
                return
            lease._released = True  # pylint: disable=protected-access
            try:
                self._leases.remove(lease)
            except ValueError:  # pragma: no cover - defensive
                pass
            abandoned = _lease_abandoned(lease)
            abandoned_at = lease.signal.abandoned_at
            if abandoned_at is None:
                # Unreachable while ``abandoned`` is true: ``abandon()`` writes the
                # stamp BEFORE it sets the event that was just read through. Kept
                # so the arithmetic below is total, rather than as a second age an
                # operator would have to interpret.
                abandoned_at = time.monotonic()
            stats = self._stats_locked(ceiling)
        if not abandoned:
            _LOGGER.debug(
                "ag-ui-crewai conversational worker held its slot for %.1fs flow=%s "
                "thread=%s run=%s",
                lease.age_seconds,
                lease.flow_key,
                lease.thread_id,
                lease.run_id,
            )
            _log_worker_stats(
                "worker-finished",
                thread_id=lease.thread_id,
                run_id=lease.run_id,
                stats=stats,
                level=logging.DEBUG,
            )
            return
        # An abandoned worker terminating is the event operators actually want:
        # it is the only moment that proves the containment worked rather than
        # the thread having leaked for the process lifetime.
        _LOGGER.info(
            "ag-ui-crewai abandoned conversational worker terminated after %.1fs "
            "thread=%s run=%s",
            time.monotonic() - abandoned_at,
            lease.thread_id,
            lease.run_id,
        )
        _log_worker_stats(
            "abandoned-worker-finished",
            thread_id=lease.thread_id,
            run_id=lease.run_id,
            stats=stats,
            level=logging.INFO,
        )

    def _stats_locked(self, max_workers: int) -> ConversationWorkerStats:
        now = time.monotonic()
        abandoned = [lease for lease in self._leases if _lease_abandoned(lease)]
        oldest = max(
            (
                now - lease.signal.abandoned_at
                for lease in abandoned
                if lease.signal.abandoned_at is not None
            ),
            default=None,
        )
        return ConversationWorkerStats(
            max_workers=max_workers,
            active=len(self._leases),
            abandoned_active=len(abandoned),
            oldest_abandoned_age_seconds=oldest,
            capacity_rejections=self._capacity_rejections,
            thread_conflict_rejections=self._thread_conflict_rejections,
        )

    def stats(self) -> ConversationWorkerStats:
        """Snapshot the population, for a metrics scrape or a health endpoint."""
        ceiling = resolve_max_conversation_workers()
        with self._lock:
            return self._stats_locked(ceiling)

    def clear(self) -> None:
        """Drop all bookkeeping. For test isolation, not for production use."""
        with self._lock:
            for lease in self._leases:
                lease._released = True  # pylint: disable=protected-access
            self._leases.clear()
            self._capacity_rejections = 0
            self._thread_conflict_rejections = 0


CONVERSATION_WORKERS = ConversationWorkerRegistry()


def _log_worker_stats(
    reason: str,
    *,
    thread_id: str,
    run_id: str,
    stats: ConversationWorkerStats,
    level: int = logging.INFO,
) -> None:
    """Emit the whole worker population on one line, keyed by what happened."""
    oldest = stats.oldest_abandoned_age_seconds
    _LOGGER.log(
        level,
        "ag-ui-crewai conversational workers reason=%s thread=%s run=%s active=%d "
        "abandoned_active=%d oldest_abandoned_age=%s capacity_rejections=%d "
        "thread_conflict_rejections=%d max_workers=%d",
        reason,
        thread_id,
        run_id,
        stats.active,
        stats.abandoned_active,
        "none" if oldest is None else f"{oldest:.1f}s",
        stats.capacity_rejections,
        stats.thread_conflict_rejections,
        stats.max_workers,
    )


def acquire_conversation_worker(
    *,
    flow_key: str,
    thread_id: str,
    run_id: str,
    signal: AbandonmentSignal,
) -> ConversationWorkerLease:
    """Reserve a slot in the process-wide sync conversational worker pool."""
    return CONVERSATION_WORKERS.acquire(
        flow_key=flow_key,
        thread_id=thread_id,
        run_id=run_id,
        signal=signal,
    )


def conversation_worker_stats() -> ConversationWorkerStats:
    """Report active turns, still-running abandoned turns, and rejections."""
    return CONVERSATION_WORKERS.stats()


def abandoned_conversational_run_for_thread(
    thread_id: str,
    *,
    flow_key: str | None = None,
) -> str | None:
    """Run id of an abandoned conversational turn still holding ``thread_id``.

    The per-conversation counterpart to the process-wide stats, for the gates that
    must refuse a second concurrent turn on one conversation. Read under the
    registry lock, because releases arrive from worker threads.

    A GATE must pass ``flow_key`` (:func:`conversational_flow_key`), so it refuses
    only for the flow whose state the abandoned turn is still writing. Left out,
    the answer spans every flow in the process, which is a diagnostic question
    rather than a gating one.
    """
    return CONVERSATION_WORKERS.abandoned_run_for_thread(
        thread_id, flow_key=flow_key
    )


def conversational_thread_busy_detail(*, thread_id: str, run_id: str) -> str:
    """The one client-facing sentence for a conversation that is still busy."""
    return (
        f"an abandoned CrewAI conversational turn for thread={thread_id} "
        f"is still running (started run={run_id})"
    )


def report_conversational_abandonment(
    *,
    thread_id: str,
    run_id: str,
) -> ConversationWorkerStats:
    """Log the population right after a run was abandoned with a live worker."""
    stats = CONVERSATION_WORKERS.stats()
    _log_worker_stats(
        "abandoned",
        thread_id=thread_id,
        run_id=run_id,
        stats=stats,
        level=logging.WARNING,
    )
    return stats


@dataclass(frozen=True)
class ConversationalTurn:
    """One textual turn plus the history that must precede it."""

    message: str
    history: list[dict[str, Any]]
    current_media: list[dict[str, Any]]


def _seedable_history_roles() -> frozenset[str]:
    """The roles a seeded conversational history message may carry.

    ``system`` is excluded because CrewAI resolves its OWN system prompt for a
    conversational turn, which is how this path has always behaved. The rest of the
    exclusion is that same rule generalised: AG-UI carries roles CrewAI's
    conversational history cannot hold, and one of them anywhere in the seeded
    history fails ``ConversationMessage`` validation for the whole turn.

    An allowlist rather than a denylist, so a role AG-UI adds later degrades to
    being dropped instead of to a crash. The accepted set is probed off the
    installed crewai (see :func:`~._capabilities.conversational_message_roles`).
    """
    return conversational_message_roles() - {"system"}


def prepare_conversational_turn(messages: Sequence[Any]) -> ConversationalTurn:
    """Prepare one public ``stream_turn`` invocation from AG-UI history."""
    dumped = [dump_agui_message(message) for message in messages]
    current_index = (
        len(dumped) - 1 if dumped and dumped[-1].get("role") == "user" else None
    )
    seedable = _seedable_history_roles()

    if current_index is None:
        history = [message for message in dumped if message.get("role") in seedable]
        return ConversationalTurn(message="", history=history, current_media=[])

    history = [
        message for message in dumped[:current_index] if message.get("role") in seedable
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


def _seeded_messages(turn: ConversationalTurn) -> list[dict[str, Any]]:
    """One independent copy of the turn's history, plus its current media."""
    seeded = copy.deepcopy(turn.history)
    if turn.current_media:
        seeded.append({"role": "user", "content": copy.deepcopy(turn.current_media)})
    return seeded


def _state_field_values(state: BaseModel) -> dict[str, Any]:
    """Every value the model currently holds, ``Field(exclude=True)`` included.

    ``model_dump()`` HONOURS ``exclude=True``, so seeding through a dump and a
    revalidate hands every excluded field back its default. On
    :class:`~.sdk.CopilotKitState` that is the entire set of fields CrewAI's
    conversational runtime keeps its per-turn bookkeeping in
    (``current_user_message``, ``last_intent``, ``events``, ``agent_threads``, ...),
    reset on every single turn.

    ``__dict__`` is the declared fields as they stand, and pydantic keeps ``extra``
    values apart from it, so both have to be read.
    """
    values = dict(state.__dict__)
    extra = getattr(state, "__pydantic_extra__", None)
    if extra:
        values.update(extra)
    return values


def _state_can_hold_messages(state: BaseModel) -> bool:
    """Whether a seeded ``messages`` key survives validation onto ``state``."""
    if "messages" in type(state).model_fields:
        return True
    return type(state).model_config.get("extra") == "allow"


def hydrate_conversational_flow(
    flow: Any,
    inputs: dict[str, Any],
    turn: ConversationalTurn,
) -> dict[str, Any]:
    """Seed regular AG-UI inputs before ``stream_turn`` adds current text.

    The seeded messages are DEEP copies, and the flow gets a SECOND set. Two
    aliases to break, both leading back to a flow that edits its own history:

    * ``ConversationalTurn`` is frozen, but its lists hold plain dicts whose
      ``content`` / ``tool_calls`` / media values are themselves mutable. A
      per-message ``dict()`` shares every one of them with the frozen turn, which
      the persistence overlay's inputs are built from;
    * what this RETURNS becomes those overlay inputs (see
      :func:`_build_gate_binding`), so handing the same list object to the flow
      state makes a flow's edit to its own history an edit to the write gate's
      restore overlay.

    ``deepcopy`` is safe on these: every message came from
    :func:`~.utils.dump_agui_message`, whose output is JSON-shaped.
    """
    hydrated = {**inputs, "messages": _seeded_messages(turn)}
    # The flow's own set. Validation builds a new LIST for the pydantic branch but
    # passes the dicts inside it through, so both branches need this.
    flow_inputs = {**hydrated, "messages": _seeded_messages(turn)}

    state = getattr(flow, "_state", None)
    if isinstance(state, dict):
        state.update(flow_inputs)
        return hydrated
    if isinstance(state, BaseModel):
        if not _state_can_hold_messages(state):
            # Refused rather than seeded: pydantic's default ``extra="ignore"``
            # would throw the key away, and the turn would run against an empty
            # conversation with nothing said about it.
            raise TypeError(
                f"Conversational Flow state {type(state).__name__} declares no "
                "'messages' field, so the conversation history cannot be seeded "
                "onto it. Declare 'messages' on the state (which "
                "ag_ui_crewai.sdk.CopilotKitState does), or allow extra fields."
            )
        # Through pydantic's OWN channel, not ``object.__setattr__``: ``_state`` is
        # a private attribute, which pydantic keeps in ``__pydantic_private__``. A
        # raw write lands in the instance ``__dict__`` instead, where it shadows the
        # private store on every later READ while crewai's own ``self._state = ...``
        # (its persistence restore among them) keeps writing the store nothing reads
        # again.
        setattr(
            flow,
            "_state",
            type(state).model_validate({**_state_field_values(state), **flow_inputs}),
        )
        return hydrated
    raise TypeError("Conversational Flow state must be a mapping or Pydantic model")


@dataclass
class _GateBinding:
    """ONE run's identity, as the persistence gate needs it.

    Not a property of the wrapper: a wrapper can be shared by two runs (see
    :func:`_guarded_persistence`) and the gate's answer differs between them, so
    the binding travels with the CALLER instead, in ``_ACTIVE_GATE``. Inputs and
    signal live together so a reader can never pair one run's signal with
    another's inputs.
    """

    inputs: dict[str, Any]
    abandonment: AbandonmentSignal
    drops: dict[str, int] = field(default_factory=dict)
    lock: threading.Lock = field(default_factory=threading.Lock)


# The run whose gate applies to THIS caller. Set when the overlay installs for a
# run, so every thread the run later spawns inherits it: the adapter copies the
# context before starting its worker, and crewai's own frame thread copies it
# again from there. That is what makes an abandoned worker and the live run that
# replaced it evaluate DIFFERENT signals through one shared wrapper.
_ACTIVE_GATE: contextvars.ContextVar[_GateBinding] = contextvars.ContextVar(
    "ag_ui_crewai_conversation_gate"
)


def _build_gate_binding(
    inputs: dict[str, Any],
    abandonment: AbandonmentSignal,
) -> _GateBinding:
    """One run's binding, and make it the active one for this context.

    ``id`` is stripped from the overlay inputs: it is the conversation key crewai
    restores BY, so overlaying it onto a restore would answer the lookup with the
    lookup.
    """
    binding = _GateBinding(
        inputs={key: value for key, value in inputs.items() if key != "id"},
        abandonment=abandonment,
    )
    _ACTIVE_GATE.set(binding)
    return binding


class _PersistenceWriteGate:
    """Overlay AG-UI request state onto a CrewAI persistence restore.

    Also the gate on WRITES from an abandoned turn. The sync worker outlives its
    request, so its remaining saves and pause checkpoints land after the client
    has gone -- and, once a new turn for the same conversation has been served,
    after NEWER state was already stored. Persistence is keyed by conversation,
    not by run, so such a write is a silent rollback. Dropping it is the only
    correct outcome: the run it describes has no consumer left.

    Mixed INTO crewai's own ``FlowPersistence`` (see :func:`_gate_class`) rather
    than merely duck-typed like it: ``Flow.persistence`` is annotated with a
    serializer that raises on any other type, so a duck-typed wrapper turns
    every ``model_dump_json()`` of the flow into a ``TypeError``.
    """

    def _agui_bind(self, backend: Any, binding: _GateBinding) -> None:
        """Wrap ``backend``, with ``binding`` as the no-contextvar fallback."""
        object.__setattr__(self, "_agui_backend_ref", backend)
        object.__setattr__(self, "_agui_fallback", binding)
        # The one field crewai's base class carries. Left at its default the
        # wrapper would report itself as a plain backend to anything that reads
        # it, so mirror the real one.
        object.__setattr__(
            self, "persistence_type", getattr(backend, "persistence_type", "base")
        )

    def _agui_repoint(self, binding: _GateBinding) -> None:
        """Move the FALLBACK of an already-installed wrapper to the current run.

        A per-request flow copy does not guarantee a per-request persistence
        object. The crewai 1.15.x deep-copy fallback pins values it cannot copy
        (this wrapper holds an event and a lock, so it is one) by reference rather
        than isolating them, so a flow whose ``persistence`` already carries a
        wrapper hands the SAME one to the next turn; so does any caller that
        drives one flow instance across consecutive turns.

        Only the fallback moves, and it moves FORWARD. Callers that belong to a
        run carry their own binding in ``_ACTIVE_GATE``, so neither run depends on
        where this points; the fallback answers a caller with no run in scope (the
        request thread before the overlay, a flow serialization, crewai touching
        the backend from a context copied before the overlay). Pointed at the
        newest run it can only ever be too permissive for a stranger, never the
        original defect of gating a LIVE run on an already-abandoned signal.
        """
        self._agui_bind(self._agui_backend_ref, binding)

    def _agui_gate(self) -> _GateBinding:
        """The binding that applies to THIS caller: its own run's, else the fallback.

        Tested for ``None`` rather than truthiness: what this returns decides
        whether a write is dropped, and a binding that ever grew a ``__len__``
        would silently start falling through.
        """
        active = _ACTIVE_GATE.get(None)
        return self._agui_fallback if active is None else active

    @property
    def agui_run(self) -> AbandonmentSignal:
        """The run this caller is gated by. One signal per run, so it is the identity."""
        return self._agui_gate().abandonment

    @property
    def agui_backend(self) -> Any:
        """The real crewai backend behind the gate."""
        return self._agui_backend_ref

    def init_db(self) -> None:
        # Backend setup, not a state write, so never gated: dropping writes must
        # not stop a backend from being usable for reads.
        self._agui_backend_ref.init_db()

    def load_state(self, flow_uuid: str) -> dict[str, Any] | None:
        stored = self._agui_backend_ref.load_state(flow_uuid)
        if stored is None:
            return None
        return {**stored, **self._agui_gate().inputs}

    def _drop_abandoned_write(self, what: str, args: tuple, kwargs: dict) -> bool:
        binding = self._agui_gate()
        if not binding.abandonment.abandoned:
            return False
        flow_uuid = args[0] if args else kwargs.get("flow_uuid")
        with binding.lock:
            # Deduped per run and per kind: a disconnect-heavy deployment drops
            # a write per frame, and one WARNING each turns the signal into
            # noise. The first is loud, the rest are countable.
            seen = binding.drops.get(what, 0)
            binding.drops[what] = seen + 1
        if seen:
            _LOGGER.debug(
                "ag-ui-crewai dropped %s #%d from the same abandoned "
                "conversational turn flow_uuid=%s",
                what,
                seen + 1,
                flow_uuid,
            )
            return True
        _LOGGER.warning(
            "ag-ui-crewai dropped a %s from an abandoned conversational turn "
            "flow_uuid=%s; the request is gone and newer state may already be "
            "stored for this conversation. Further drops from this turn are "
            "logged at DEBUG",
            what,
            flow_uuid,
        )
        return True

    def load_pending_feedback(self, *args: Any, **kwargs: Any) -> Any:
        # Declared rather than delegated by ``__getattr__``: crewai's base class
        # provides a concrete "there is no pause" implementation, which would
        # shadow the fallthrough and make every resume see no pending feedback.
        # The same is true of any other concrete method on that base.
        return self._agui_backend_ref.load_pending_feedback(*args, **kwargs)

    # The three mutating calls crewai makes, each declared explicitly. Anything
    # else -- backend internals, a backend's own extras -- falls through
    # ``__getattr__`` to the real backend UNGATED, which is deliberate: dropping
    # writes must not break a session restore or a resume. Adding a mutating
    # method to this list is required when crewai grows one.
    def save_state(self, *args: Any, **kwargs: Any) -> Any:
        if self._drop_abandoned_write("state write", args, kwargs):
            return None
        return self._agui_backend_ref.save_state(*args, **kwargs)

    def save_pending_feedback(self, *args: Any, **kwargs: Any) -> Any:
        if self._drop_abandoned_write("pause checkpoint", args, kwargs):
            return None
        return self._agui_backend_ref.save_pending_feedback(*args, **kwargs)

    def clear_pending_feedback(self, *args: Any, **kwargs: Any) -> Any:
        # The destructive one: crewai clears the pause marker on resume, so an
        # abandoned worker reaching it deletes a NEWER turn's pause checkpoint.
        if self._drop_abandoned_write("pause-checkpoint deletion", args, kwargs):
            return None
        return self._agui_backend_ref.clear_pending_feedback(*args, **kwargs)

    def model_dump(self, *args: Any, **kwargs: Any) -> Any:
        """Serialize as the WRAPPED backend, which is what crewai stored.

        crewai serializes ``Flow.persistence`` by dumping it; reporting this
        wrapper's own (empty) shape would leak an AG-UI implementation detail
        into every flow dump and lose the backend's configuration.
        """
        dump = getattr(self._agui_backend_ref, "model_dump", None)
        if callable(dump):
            return dump(*args, **kwargs)
        return super().model_dump(*args, **kwargs)  # type: ignore[misc]

    @model_serializer(mode="wrap")
    def _agui_serialize_as_the_backend(self, handler: Any, info: Any) -> Any:
        """The same substitution for the mode ``model_dump`` above never sees.

        Only crewai's json-mode ``PlainSerializer`` routes through ``model_dump``
        (``flow/runtime/__init__.py:573-575``). ``Flow.persistence`` is
        ``SerializeAsAny``, so a python-mode ``flow.model_dump()`` serializes THIS
        instance's fields instead, and this wrapper declares exactly one: measured
        on crewai 1.15.11, a SQLite backend's ``db_path`` disappears from the dump
        the moment the gate is installed.

        ``mode="wrap"`` rather than ``"plain"``: the handler is the default
        serialization of this instance, which is what a backend with no
        ``model_dump`` of its own has to fall back to, and calling ``model_dump``
        there would come straight back here.
        """
        dump = getattr(self._agui_backend_ref, "model_dump", None)
        if callable(dump):
            return dump(mode=getattr(info, "mode", "python"))
        return handler(self)

    def __getattr__(self, name: str) -> Any:
        try:
            return super().__getattr__(name)  # type: ignore[misc]
        except AttributeError:
            pass
        if name.startswith("_"):
            # Our own binding, and pydantic's internals, must never be answered
            # by the backend: that turns a missing attribute into a confusing one.
            raise AttributeError(name)
        return getattr(self._agui_backend_ref, name)


_GUARD_ATTR = "_agui_persistence_guard"
_GUARDED_FLAG = "_agui_persistence_guarded"
_GUARDED_CLASS_ATTR = "_agui_guarded_flow_class"

_GATE_CLASS: type | None = None
_CLASS_BUILD_LOCK = threading.Lock()


def _flow_persistence_base() -> type:
    """crewai's ``FlowPersistence``, or ``object`` if that surface moved."""
    failure: Exception | None = None
    try:
        from crewai.flow.persistence.base import (  # pylint: disable=import-outside-toplevel
            FlowPersistence,
        )
    except Exception as exc:  # noqa: BLE001 - capability probe
        FlowPersistence = None  # type: ignore[assignment]
        failure = exc
    if isinstance(FlowPersistence, type):
        return FlowPersistence
    # ``exc_info`` because the warning is the only notice of a degraded gate, and
    # "the surface moved" and "importing it raised" call for different fixes.
    _LOGGER.warning(
        "ag-ui-crewai could not find crewai's FlowPersistence base class; the "
        "conversational write gate still drops writes from abandoned turns, but "
        "serializing a flow while it is installed may now fail",
        exc_info=failure,
    )
    return object


def _gate_class() -> type:
    """The concrete wrapper class: the write gate over crewai's own base.

    Built once per process, and the base is PROBED. ``Flow.persistence`` is
    annotated with a serializer that raises ``TypeError`` on anything that is
    not a ``FlowPersistence``, so the wrapper has to be one; if that surface has
    moved the gate still works but the flow can no longer be serialized while it
    is installed, which is exactly the kind of quiet degradation that has to
    reach a log.

    Once per process also because ``FlowPersistence.__init_subclass__`` adds
    every concrete subclass to a crewai-global registry keyed by class name.
    """
    global _GATE_CLASS  # pylint: disable=global-statement
    if _GATE_CLASS is not None:
        return _GATE_CLASS
    # Probed BEFORE the lock: it imports crewai and can log, and doing either
    # while holding a lock is the shape that deadlocks (an import that reaches
    # back into this module, a logging handler that builds a gate).
    base = _flow_persistence_base()
    with _CLASS_BUILD_LOCK:
        if _GATE_CLASS is None:
            _GATE_CLASS = type(
                "_InputOverlayPersistence",
                (_PersistenceWriteGate, base),
                {},
            )
        return _GATE_CLASS


def _guarded_persistence(persistence: Any, binding: _GateBinding) -> Any:
    """Gate ``persistence``, re-pointing the fallback of a wrapper already there."""
    if isinstance(persistence, _PersistenceWriteGate):
        persistence._agui_repoint(binding)  # pylint: disable=protected-access
        return persistence
    gate = _gate_class()()
    gate._agui_bind(persistence, binding)  # pylint: disable=protected-access
    return gate


def _make_guarded_setattr(original_setattr: Any) -> Any:
    """Build the ``__setattr__`` that intercepts a late ``persistence=``."""

    def guarded_setattr(self: Any, name: str, value: Any) -> None:
        guard = getattr(self, _GUARD_ATTR, None)
        if name == "persistence" and value is not None and guard is not None:
            # ``guard`` is only the fallback: the caller creating this backend is
            # inside a run (crewai creates it while saving a pause checkpoint), so
            # its own binding in ``_ACTIVE_GATE`` is what will gate its writes.
            value = _guarded_persistence(value, guard)
        original_setattr(self, name, value)

    return guarded_setattr


def _remember_declined_guard(cls: type) -> None:
    """Record that this flow class cannot be guarded, so the warning fires once."""
    try:
        type.__setattr__(cls, _GUARDED_CLASS_ATTR, False)
    except Exception as exc:  # noqa: BLE001 - the warning below still fires
        # Not fatal, but not silent either: a class that refuses the latch turns
        # the once-per-class warning into one per turn, and an operator reading a
        # storm should be able to see why it is a storm.
        _LOGGER.debug(
            "ag-ui-crewai could not latch the declined guard on %s, so its warning "
            "will repeat per turn cause=%s",
            getattr(cls, "__name__", cls),
            type(exc).__name__,
        )


def _guarded_flow_class(cls: type) -> type | None:
    """The subclass whose ``__setattr__`` catches a lazily created backend.

    Cached ON the original class, so a conversational request no longer builds a
    fresh pydantic model class per turn (measured in milliseconds each) and the
    cache's lifetime is the flow class's own.

    Returns ``None`` when the flow definition cannot be carried faithfully.
    crewai reads ``type(self).flow_definition()`` mid-turn and caches it in
    ``cls.__dict__``; a synthesized subclass starts with an empty ``__dict__``,
    and crewai builds a definition from the class's OWN namespace, so it would
    rebuild an EMPTY method graph and the flow's ``@start`` / ``@listen`` steps
    would silently stop firing. An ungated pause checkpoint is a bad outcome; a
    flow whose steps do not run is a far worse one, so decline instead.
    """
    cached = cls.__dict__.get(_GUARDED_CLASS_ATTR)
    if isinstance(cached, type):
        return cached
    if cached is False:
        # Declined for this class already, and said so loudly then. Repeating it
        # per turn would bury the line that mattered.
        return None
    # Read the definition the way crewai reads it: out of ``cls.__dict__``,
    # never through ``getattr``. A ``getattr`` walks the MRO and would stamp an
    # ANCESTOR's definition (a different name, a different method graph) onto
    # the subclass, which is then what crewai reads for the rest of the turn.
    definition = cls.__dict__.get("_flow_definition")
    if definition is None:
        _remember_declined_guard(cls)
        _LOGGER.warning(
            "ag-ui-crewai could not carry %s's flow definition onto a guarded "
            "subclass, so it will not install one: a pause checkpoint written by "
            "an abandoned conversational turn of this flow is NOT gated. "
            "Guarding it would have rebuilt the flow's method graph from an "
            "empty namespace and its steps would never have run",
            cls.__name__,
        )
        return None
    with _CLASS_BUILD_LOCK:
        cached = cls.__dict__.get(_GUARDED_CLASS_ATTR)
        if isinstance(cached, type):
            return cached
        try:
            # Named after the original, not decorated: crewai reports
            # ``self.__class__.__name__`` as the ``flow_name`` of its
            # conversation-turn events whenever the flow carries no explicit
            # name, so a synthesized name lands in telemetry.
            guarded = type(
                cls.__name__,
                (cls,),
                {"__setattr__": _make_guarded_setattr(cls.__setattr__)},
            )
            # Set after class creation so the model metaclass does not
            # reinterpret these as fields.
            type.__setattr__(guarded, "_flow_definition", definition)
            type.__setattr__(guarded, "__qualname__", cls.__qualname__)
            type.__setattr__(guarded, "__module__", cls.__module__)
            type.__setattr__(guarded, _GUARDED_FLAG, True)
            type.__setattr__(cls, _GUARDED_CLASS_ATTR, guarded)
        except Exception as exc:  # noqa: BLE001 - a best-effort guard must not fail a run
            _remember_declined_guard(cls)
            guarded, failure = None, exc
    if guarded is None:
        # Reported outside the lock: a logging handler that reaches back into a
        # flow would deadlock on this non-reentrant one. ``exc_info`` is the
        # captured exception, since its context is gone by here.
        _LOGGER.warning(
            "ag-ui-crewai could not build a guarded subclass of %s, so a "
            "pause checkpoint from an abandoned conversational turn of this "
            "flow is NOT gated",
            cls.__name__,
            exc_info=failure,
        )
    return guarded


def _install_lazy_persistence_guard(flow: Any, binding: _GateBinding) -> None:
    """Guard a backend crewai creates AFTER this overlay was installed.

    On ``HumanFeedbackPending`` with nothing configured, crewai does
    ``self.persistence = default_flow_persistence()`` and saves the pause
    checkpoint through it -- a write the wrapped attribute never sees, because at
    overlay time the attribute was ``None``.

    Installing a backend up front instead would be worse than the leak: crewai's
    ``_checkpoint_state_for_ask`` is a no-op purely BECAUSE persistence is
    ``None``, so an eager install turns every ``ask()`` on every run, abandoned
    or not, into a real ``save_state``. So intercept the assignment rather than
    pre-empt it, by overriding ``__setattr__`` on a per-flow-class subclass.
    ``persistence`` is a pydantic field: a subclass PROPERTY would be swallowed
    by the model metaclass and read back as the field default, and a
    per-instance attribute is never consulted for a dunder.
    """
    # The guard lives on the INSTANCE, not in the override's closure, so the
    # subclass can be shared by every instance of the flow class. It carries only
    # the FALLBACK binding: the writes it gates are made from inside a run, whose
    # own binding is in ``_ACTIVE_GATE``, so a flow instance shared across turns
    # does not hand one turn's signal to another.
    object.__setattr__(flow, _GUARD_ATTR, binding)
    cls = type(flow)
    if cls.__dict__.get(_GUARDED_FLAG):
        return
    guarded = _guarded_flow_class(cls)
    if guarded is None:
        return
    try:
        object.__setattr__(flow, "__class__", guarded)
    except Exception:  # noqa: BLE001 - a best-effort guard must not fail a run
        _LOGGER.warning(
            "ag-ui-crewai could not reparent %s onto its guarded subclass, so a "
            "pause checkpoint from an abandoned conversational turn is NOT gated",
            cls.__name__,
            exc_info=True,
        )


def _enabled_persist_definitions(flow: Any) -> list[Any]:
    """Every already-enabled ``@persist`` definition on this flow."""
    definition = getattr(flow, "_definition", None)
    if definition is None:
        return []
    candidates = [getattr(definition, "persist", None)]
    values = getattr(getattr(definition, "methods", None), "values", None)
    if callable(values):
        candidates.extend(getattr(method, "persist", None) for method in values())
    enabled: list[Any] = []
    seen: set[int] = set()
    for candidate in candidates:
        if candidate is None or not getattr(candidate, "enabled", False):
            continue
        if id(candidate) in seen:
            continue
        seen.add(id(candidate))
        enabled.append(candidate)
    return enabled


_PERSIST_WARNED_ATTR = "_agui_persist_gap_warned"


def _persist_writes_reach_the_gate(flow: Any) -> bool:
    """Whether crewai routes this flow's ``@persist`` through ``flow.persistence``.

    It does when persistence was INSTANCE-supplied. crewai 1.15.11's
    ``_persist_method_completion`` picks the backend as ``self.persistence if
    self._instance_persistence and self.persistence is not None else
    self._persist_backend_for(...)`` (``flow/runtime/__init__.py:2942-2946``), and
    ``_instance_persistence`` is fixed at post-init from the constructor argument
    (same file, line 773) -- before this overlay runs, so wrapping the attribute
    cannot change the answer.

    Unknown counts as NOT gated: a probe that cannot tell must not silence a
    warning about a gap.
    """
    return bool(getattr(flow, "_instance_persistence", False)) and (
        getattr(flow, "persistence", None) is not None
    )


def _warn_about_ungated_persist_writes(flow: Any, inputs: dict[str, Any]) -> None:
    """Say plainly when ``@persist`` writes from an abandoned turn are NOT gated.

    Only when they really are not. With persistence supplied to the constructor,
    ``@persist`` writes go through the wrapped ``flow.persistence`` and ARE gated
    (see :func:`_persist_writes_reach_the_gate`); warning there declares a working
    guarantee void. Otherwise ``_persist_method_completion`` resolves a backend out
    of the private ``_persist_backends`` cache, which the gate cannot reach without
    seeding it -- and a seeded entry sits BESIDE an already-resolved one that can
    still win. No shipped flow uses ``@persist``, so the honest outcome there is a
    loud limitation rather than a partial guard an operator would read as a
    guarantee.

    Once per flow class, not once per turn: the configuration is a property of the
    class, and a line repeated every turn buries itself.

    Silent when the definition surface is absent: a probe that cannot tell
    whether ``@persist`` is in play has nothing to report.
    """
    if _persist_writes_reach_the_gate(flow):
        return
    definitions = _enabled_persist_definitions(flow)
    if not definitions:
        return
    cls = type(flow)
    if cls.__dict__.get(_PERSIST_WARNED_ATTR):
        return
    try:
        type.__setattr__(cls, _PERSIST_WARNED_ATTR, True)
    except Exception as exc:  # noqa: BLE001 - the warning below still fires
        # Same as the declined-guard latch: a class that refuses it turns one
        # notice into one per turn, and that is worth being able to explain.
        _LOGGER.debug(
            "ag-ui-crewai could not latch the @persist gap warning on %s, so it "
            "will repeat per turn cause=%s",
            cls.__name__,
            type(exc).__name__,
        )
    _LOGGER.warning(
        "ag-ui-crewai: %s has %d enabled @persist definition(s), whose writes do "
        "not go through flow.persistence and are therefore NOT gated: state "
        "written by an abandoned conversational turn of this flow can silently "
        "roll back a newer turn thread=%s",
        cls.__name__,
        len(definitions),
        inputs.get("id"),
    )


def overlay_conversational_persistence(
    flow: Any,
    inputs: dict[str, Any],
    *,
    abandonment: AbandonmentSignal,
) -> None:
    """Make incoming AG-UI state win after CrewAI restores a session.

    Also the WRITE GATE for an abandoned turn, across the two ways crewai
    reaches a persistence backend that this can gate: the ``persistence``
    attribute, and one crewai creates lazily on a pause. A backend ``@persist``
    resolves from the flow DEFINITION is a third way, gated only when persistence
    was instance-supplied, and said so out loud otherwise (see
    :func:`_warn_about_ungated_persist_writes`). Every probe is by capability,
    never by crewai version, and each part that degrades WARNS rather than voiding
    the documented gate in silence.

    Also where this run becomes the active gate for the current context, which is
    what every layer below resolves its own decision from.
    """
    binding = _build_gate_binding(inputs, abandonment)
    # Before the guard install, so the once-per-class latch lands on the flow's
    # OWN class rather than on the guarded subclass the install reparents it onto.
    _warn_about_ungated_persist_writes(flow, inputs)
    _install_lazy_persistence_guard(flow, binding)
    persistence = getattr(flow, "persistence", None)
    if persistence is None:
        return
    object.__setattr__(
        flow,
        "persistence",
        _guarded_persistence(persistence, binding),
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

    def __init__(
        self,
        session: Any,
        *,
        abandonment: AbandonmentSignal | None = None,
        lease: ConversationWorkerLease | None = None,
    ):
        # The registry watches a held slot THROUGH its lease's signal
        # (``_lease_abandoned`` reads ``lease.signal.abandoned``), so an adapter
        # that abandons any other signal leaves the thread-busy gate blind to the
        # very turn it exists to refuse. Refused here rather than served: the pool
        # would report the slot as live for as long as the worker held it, and the
        # conversation's next message would be admitted alongside it.
        if lease is not None and abandonment is not getattr(
            lease, "signal", abandonment
        ):
            raise ValueError(
                "a conversational worker lease must carry the same "
                "AbandonmentSignal the adapter is given"
            )
        self._session = session
        # The loop and the queue as ONE value, so a reader gets both or neither.
        # Two attributes let the request teardown null the second between a
        # reader's check and its use; see ``_consumer_plumbing``.
        self._plumbing: (
            tuple[asyncio.AbstractEventLoop, asyncio.Queue[tuple[str, Any]]] | None
        ) = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        # Set once the worker will produce nothing further, whether it exhausted
        # the turn, failed, or aborted. Distinguishes "the thread is merely on
        # its way out" from "the thread is still inside the turn", which is the
        # difference between a successful run and one worth warning about.
        self._producer_finished = threading.Event()
        self._cooperative_stop_logged = False
        # Frames the worker could not hand over because the request loop had
        # already closed. Written from the worker thread only, so a plain int.
        self._undeliverable = 0
        # Claimed under a lock: the request loop and the worker thread can both
        # reach ``_close_session`` (a teardown racing the worker's own exit), and
        # an unsynchronized check-then-set lets both pass it and close twice, which
        # is not something every session promises to tolerate.
        self._close_lock = threading.Lock()
        self._session_closed = False
        # ``_stop`` is this adapter's own teardown flag; ``_abandonment`` is the
        # run-wide one every other publisher also reads. Either one means "the
        # consumer is gone", so ``_abandoned`` is their union.
        #
        # Who OWNS the run-wide signal matters for what a close means. With no
        # signal supplied there is no request driver above us, so closing IS the
        # abandonment. With one supplied, the driver decides -- and decides
        # BEFORE closing us -- so a close with the signal still clear means the
        # run ended terminally and the worker is only finishing its tail.
        self._owns_abandonment = abandonment is None
        self._abandonment = (
            abandonment if abandonment is not None else AbandonmentSignal()
        )
        self._lease = lease

    def __aiter__(self):
        return self._iterate()

    @property
    def _abandoned(self) -> bool:
        return self._stop.is_set() or self._abandonment.abandoned

    @property
    def worker_alive(self) -> bool:
        """True while the sync worker thread is still executing the turn.

        Both halves are load bearing. A thread can be alive while its ``produce``
        has already published its last frame, and it can have reported finishing
        while the thread object is still winding down; a still-running turn has to
        count in either case, because the callers use this to decide whether one
        needs reporting.
        """
        thread = self._thread
        if thread is None:
            return False
        return thread.is_alive() or not self._producer_finished.is_set()

    def _consumer_plumbing(
        self,
    ) -> tuple[asyncio.AbstractEventLoop, asyncio.Queue[tuple[str, Any]]] | None:
        """The request loop and queue as one snapshot, or ``None`` if released.

        The ONE accessor every reader goes through. The request loop releases the
        plumbing while the worker thread is still publishing, so a reader that
        checks the loop and the queue and only then dereferences them can have
        either nulled underneath it. That ``AttributeError`` escapes ``publish``,
        breaks the drain, and reaches ``close()`` while CrewAI's generator is
        suspended at its ``yield``, whose own ``thread.join()`` then blocks for
        the rest of the turn while the pool slot is still held: the exact
        deadlock the drain exists to prevent, on an ordinary terminal turn.
        """
        return self._plumbing

    @property
    def _loop(self) -> asyncio.AbstractEventLoop | None:
        """Observation view of the snapshot; code paths use the accessor."""
        plumbing = self._consumer_plumbing()
        return None if plumbing is None else plumbing[0]

    @property
    def _queue(self) -> asyncio.Queue[tuple[str, Any]] | None:
        """Observation view of the snapshot; code paths use the accessor."""
        plumbing = self._consumer_plumbing()
        return None if plumbing is None else plumbing[1]

    def _release_lease(self) -> None:
        if self._lease is not None:
            self._lease.release()

    def _lease_ids(self) -> tuple[Any, Any]:
        """``(thread, run)`` for the lines operators read, from the lease.

        The lease is the only thing here that knows them: the adapter is handed a
        session and a signal, and both are anonymous.
        """
        return (
            getattr(self._lease, "thread_id", None),
            getattr(self._lease, "run_id", None),
        )

    def _close_session(self, when: str) -> None:
        """Close the CrewAI session ONCE, reporting a failure rather than raising.

        Every caller is a teardown boundary whose own caller swallows errors at
        DEBUG, so propagating would hide this instead of surfacing it. Closed at
        most once because two of the paths can both be reached for one session (a
        worker that never started, plus the driver's own teardown), and a second
        close is not something every session promises to tolerate. The claim is
        under a lock rather than relying on the callers never interleaving: two of
        them run on different threads.
        """
        with self._close_lock:
            if self._session_closed:
                return
            self._session_closed = True
        close = getattr(self._session, "close", None)
        if not callable(close):
            return
        try:
            close()
        except Exception:  # noqa: BLE001 - teardown boundary
            _LOGGER.exception(
                "ag-ui-crewai failed to close a conversational StreamSession %s",
                when,
            )

    def _release_consumer_plumbing(self) -> None:
        """Drop the loop and queue once the async consumer has unwound.

        The drain worker can outlive the request by the length of a provider
        call, and until these go the queue keeps every undelivered frame
        reachable. Safe to drop mid-drain: ``publish`` early-returns on a
        released snapshot, and the drain loop never reaches ``publish`` anyway
        because ``_abandoned`` is already true by the time this runs.
        """
        self._plumbing = None

    def _start(self) -> None:
        if self._thread is not None:
            return
        if self._session_closed:
            # No worker ever ran and the session is already closed (a start that
            # failed, or a teardown before the first read), so this iteration can
            # only ever be empty -- which the driver finalizes into a SUCCESSFUL
            # run. Refuse loudly instead of restarting on a closed session.
            raise ConversationWorkerAborted(
                "the CrewAI conversational session was closed before any worker "
                "read it, so it cannot be iterated"
            )
        self._plumbing = (asyncio.get_running_loop(), asyncio.Queue())
        context = contextvars.copy_context()

        def publish(kind: str, value: Any = None) -> None:
            plumbing = self._consumer_plumbing()
            if plumbing is None:
                return
            if self._abandoned:
                # Checked before the loop hand-off, not after: once the run is
                # abandoned there is no consumer, and every frame, error, and
                # completion belongs to a request that no longer exists.
                return
            loop, queue = plumbing
            try:
                loop.call_soon_threadsafe(queue.put_nowait, (kind, value))
            except RuntimeError:
                # The request loop already closed; no consumer remains to notify.
                # Said out loud, because this is the one drop the abandonment gate
                # above did NOT decide: the run was never marked abandoned, so what
                # falls here is a frame -- or the turn's terminal ``error`` -- that
                # the driver was still owed. Once per adapter at WARNING; a closed
                # loop does not reopen, so every later kind lands here too.
                self._undeliverable += 1
                if self._undeliverable == 1:
                    _LOGGER.warning(
                        "ag-ui-crewai could not hand a conversational %s to its "
                        "request: the loop had already closed. Everything the "
                        "worker publishes from here is lost, counted at DEBUG",
                        kind,
                    )
                else:
                    _LOGGER.debug(
                        "ag-ui-crewai dropped conversational %s #%d onto a closed "
                        "request loop",
                        kind,
                        self._undeliverable,
                    )
                return

        def produce() -> None:
            discarded = 0
            aborted: BaseException | None = None
            failed = False
            try:
                for frame in self._session:
                    if self._abandoned:
                        # DRAIN, do not break. Breaking leaves CrewAI's sync
                        # generator suspended at its ``yield``, so ``close()``
                        # throws GeneratorExit into it and its own
                        # ``finally: thread.join()`` (crewai
                        # ``utilities/streaming.py:285``) blocks for the rest of
                        # the turn, while the unbounded ``queue.Queue`` behind it
                        # (same file, line 213) keeps growing with nobody reading.
                        # Consuming to natural exhaustion instead lets CrewAI's
                        # producer reach its end sentinel, so that join returns
                        # promptly and the queue stops growing. NOT that nothing
                        # accumulates: ``StreamSession.subscribe`` appends every
                        # frame to ``_frames`` (crewai ``types/streaming.py:172``),
                        # so a drained session still retains the whole turn.
                        discarded += 1
                        continue
                    publish("item", frame)
            except Exception as exc:  # noqa: BLE001 - cross thread boundary
                # Marked finished BEFORE the error is published: publishing wakes
                # the consumer, which tears the adapter down while this thread is
                # still on its way out, and a still-clear flag there reads as a
                # worker stuck mid-turn (the cooperative-cancellation warning).
                failed = True
                self._producer_finished.set()
                # ``publish`` drops this when abandoned: a late failure of a run
                # nobody is reading must not be raised into an unrelated request.
                publish("error", exc)
            except BaseException as exc:
                # Not a turn that ended; a turn that was cut off. Recorded so the
                # ``finally`` publishes an abort instead of a completion, then
                # re-raised so the thread dies as loudly as it would have.
                aborted = exc
                raise
            finally:
                try:
                    self._producer_finished.set()
                    self._close_session("after its worker stopped")
                    if failed:
                        # The error already published IS the terminal item. A
                        # ``done`` behind it reads as a completed turn to anything
                        # consuming this queue directly (``_iterate`` raises on the
                        # error first and never reaches it).
                        pass
                    elif aborted is None:
                        publish("done")
                    else:
                        # A completion here would read as natural exhaustion, and
                        # the driver finalizes that into a successful
                        # RUN_FINISHED on a turn that never finished.
                        publish("aborted", aborted)
                    if discarded:
                        # The reason matters to whoever reads this: a terminal
                        # turn drains its tail because the REQUEST is gone, and
                        # calling that an abandoned run sends operators hunting a
                        # cancellation that never happened.
                        _LOGGER.info(
                            "ag-ui-crewai drained and discarded %d frame(s) from %s",
                            discarded,
                            "an abandoned conversational turn"
                            if self._abandonment.abandoned
                            else "a conversational turn whose request had already "
                            "gone",
                        )
                finally:
                    # Released here, from the worker's own exit, so the pool
                    # never reports a slot the thread still holds. Runs on the
                    # error paths too, since ``finally`` outlives the except.
                    self._release_lease()

        thread = threading.Thread(
            target=context.run,
            args=(produce,),
            daemon=True,
            name=WORKER_THREAD_NAME,
        )
        try:
            thread.start()
        except BaseException:
            # The thread never ran, so ``produce``'s finally will never close the
            # session or release the slot it was holding. Do both here: this path
            # is raised out of ``_iterate`` BEFORE its ``finally``, so nothing
            # else will (and under thread-table exhaustion, giving the slot back
            # is the difference between recovering and wedging).
            self._close_session("whose worker could not be started")
            self._release_lease()
            # Dropped so a re-iteration cannot find live plumbing and start a
            # second worker on a session that is already closed; ``_start`` refuses
            # outright on the closed session, which is the loud outcome.
            self._release_consumer_plumbing()
            raise
        # Published only once the worker is really running, so ``worker_alive``
        # never reports a thread that does not exist yet.
        self._thread = thread

    async def _iterate(self):
        self._start()
        plumbing = self._consumer_plumbing()
        if plumbing is None:
            # A previous consumer already unwound and released the plumbing, so
            # this iteration can only ever be empty -- and an empty stream is
            # what the driver finalizes into a SUCCESSFUL run. Fail instead.
            _LOGGER.warning(
                "ag-ui-crewai refused to re-iterate a conversational "
                "StreamSession whose consumer already unwound; its frames are "
                "gone and an empty stream would be reported as a completed turn"
            )
            raise ConversationWorkerAborted(
                "the CrewAI conversational stream was already consumed and torn "
                "down, so it cannot be iterated again"
            )
        _, queue = plumbing
        try:
            while True:
                kind, value = await queue.get()
                if kind == "item":
                    yield value
                elif kind == "error":
                    raise value
                elif kind == "aborted":
                    raise ConversationWorkerAborted(
                        "the CrewAI conversational worker aborted before the "
                        "turn finished"
                    ) from value
                else:
                    return
        finally:
            try:
                await self.aclose()
            finally:
                self._release_consumer_plumbing()

    async def aclose(self) -> None:
        """Abandon the turn without blocking the request loop.

        Containment, not cancellation, stated plainly. CrewAI's synchronous
        generator cannot be closed safely from this event-loop thread while its
        worker is executing (Python raises ``ValueError: generator already
        executing``), and Python cannot kill a running thread, so this sets a
        flag and returns. The flag is observed only BETWEEN frames -- after
        ``next()`` returns -- so a provider call that emits nothing never sees
        it, and the turn keeps running until that call and the rest of the Flow
        work finish. What the flag DOES guarantee: from here on the worker
        publishes nothing, parks nothing, and writes no state, and it drains the
        session to exhaustion rather than leaving CrewAI's queue to grow behind a
        blocked join (the frames CrewAI already recorded for the turn stay on its
        session either way). The bound on how long that takes is the provider
        timeout, not this call. The pool slot stays held until the thread ends.

        The run-wide signal is declared abandoned here ONLY when this adapter
        owns it. When a request driver supplied it, that driver alone decides,
        because only it can tell a lost request from a turn that finished: this
        method is also reached after a completed RUN_FINISHED whose worker is
        still appending the assistant message and running its terminal handlers.
        Abandoning there would drop that tail's persistence writes and make the
        next message on the conversation get refused as busy.

        NOT a queue drain contract: once the run is abandoned the worker also
        stops publishing its terminal ``done`` / ``aborted``, deliberately,
        because those belong to a request that no longer exists. Anything that
        consumes this adapter's queue -- directly, or by iterating ``__aiter__``
        past the abandonment -- must therefore stop on the abandonment signal;
        waiting for a terminal item after an abandonment waits forever.
        """
        self._stop.set()
        if self._owns_abandonment:
            self._abandonment.abandon()
        if self._thread is None:
            try:
                self._close_session("whose worker never started")
            finally:
                # No worker ever ran, so nothing else will hand the slot back. In
                # the ``finally`` because a raising ``close()`` would otherwise
                # leak the slot for the process lifetime.
                self._release_lease()
        elif (
            self._thread.is_alive()
            # Not merely "the thread is alive": a successful turn reaches here
            # with its worker mid-exit or mid-tail, and telling operators we
            # cancelled it is crying wolf. Both extra conditions are load
            # bearing: the producer being unfinished rules out a worker that is
            # only on its way out, and a still-clear run-wide signal rules out a
            # run its driver already declared terminal.
            and not self._producer_finished.is_set()
            and (self._owns_abandonment or self._abandonment.abandoned)
            and not self._cooperative_stop_logged
        ):
            # Correlated IN THE MESSAGE. The thread name lived in ``extra=``,
            # which default formatters do not print, so the one line that says a
            # worker outlived its request named neither the thread an operator
            # would look for in a dump nor the run it belongs to.
            thread_id, run_id = self._lease_ids()
            _LOGGER.warning(
                "ag-ui-crewai requested cooperative cancellation of a "
                "conversational StreamSession; the CrewAI sync worker stays "
                "active until its current upstream operation emits or returns, "
                "then drains and discards the rest of the turn while holding a "
                "worker slot thread=%s run=%s worker_thread=%s",
                thread_id,
                run_id,
                self._thread.name,
            )
            self._cooperative_stop_logged = True
