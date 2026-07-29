"""The seam between the Antigravity harness and the AG-UI client.

Every human-in-the-loop case in this integration shares one primitive:

    emit AG-UI events into the *current* run's stream, park an asyncio.Future
    in the session, await it, and resolve it from the *next* run's input.

That works because Antigravity's custom tools and hooks are async, awaited, and
carry no timeout on either the Python or the Go side -- the harness stays alive
on the awaited coroutine while the SSE response for run N is already closed
(verified by ``tests/test_parking_gate.py``; see the README).

Three cases are wired here:

``frontend tools``
    Each ``RunAgentInput.tools`` entry becomes a custom async Antigravity tool
    built from its JSON Schema. Calling it emits TOOL_CALL_START/ARGS/END and
    parks; the client returns a ``ToolMessage`` next run and its content becomes
    the tool's return value, which the harness feeds to the model natively.

``model questions``
    ``OnInteractionHook`` receives an ``AskQuestionInteractionSpec`` and parks.
    The run ends with a ``RunFinishedInterruptOutcome``; the client answers via
    ``RunAgentInput.resume``.

``tool approval``
    ``PreToolCallDecideHook`` parks on an approval interrupt and returns
    ``HookResult(allow=...)``. Registering it also satisfies the SDK's mandatory
    safety guard, so write/MCP tools no longer require a separate policy.

Two details the SDK forces on us:

* ``ToolCall.id`` is ``None`` inside the decide hook, so approvals mint their
  own correlation id.
* Tool dispatch is concurrent (``asyncio.gather`` in the SDK's ToolRunner), so
  the registry must hold multiple simultaneous pending requests per session --
  though at most one per frontend-tool *name*, see ``_turn_results``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from ag_ui.core import (
    BaseEvent,
    Interrupt,
    Tool as AGUITool,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallStartEvent,
)
from google.antigravity import types as ag_types
from google.antigravity.hooks import hooks as ag_hooks
from google.antigravity.tools.tool_runner import ToolWithSchema

logger = logging.getLogger(__name__)

KIND_FRONTEND_TOOL = "frontend_tool"
KIND_QUESTION = "question"
KIND_APPROVAL = "approval"

# Handed to a parked tool/hook when the user moves on instead of answering.
# Distinct from _CANCELLED: the user did not decline, they changed direction,
# and telling the model "you were cancelled" would have it report a fiction.
_ABANDONED = (
    "The user sent a new message instead of answering this request, so it was "
    "not completed. Do not report it as declined."
)


@dataclass
class PendingRequest:
    """One parked request awaiting a client answer."""

    id: str
    kind: str
    future: asyncio.Future
    tool_call_id: Optional[str] = None
    tool_name: Optional[str] = None
    interrupt: Optional[Interrupt] = None
    metadata: Dict[str, Any] = field(default_factory=dict)


class UIBridge:
    """Per-session event queue plus futures registry.

    One instance lives for as long as the session does -- it must outlive any
    individual run, because that is precisely what "parking across two HTTP
    runs" means.
    """

    def __init__(self, *, deduplicate_tool_calls: bool = True) -> None:
        self._queue: asyncio.Queue[BaseEvent] = asyncio.Queue()
        self._pending: Dict[str, PendingRequest] = {}
        # tool_call_id -> pending id, for resolving ToolMessages.
        self._by_tool_call: Dict[str, str] = {}
        self._frontend_tool_names: set[str] = set()
        self._deduplicate = deduplicate_tool_calls
        # tool name -> (args, Future[result]) claimed by its first dispatch
        # this turn. Keyed on name alone, so a concurrent call with *different*
        # arguments also waits on it rather than dispatching a second time.
        self._turn_results: Dict[str, tuple] = {}

    def reset_turn(self) -> None:
        """Retires the per-turn frontend-tool claims.

        Safe to simply drop: each dispatcher holds its own claim future in a
        local and settles that object, so clearing the dict cannot strand a
        waiter.
        """
        self._turn_results.clear()

    # ------------------------------------------------------------------
    # Queue plumbing
    # ------------------------------------------------------------------

    def emit(self, event: BaseEvent) -> None:
        self._queue.put_nowait(event)

    def drain(self) -> List[BaseEvent]:
        """Removes and returns every currently queued event."""
        events: List[BaseEvent] = []
        while True:
            try:
                events.append(self._queue.get_nowait())
            except asyncio.QueueEmpty:
                return events

    @property
    def has_pending(self) -> bool:
        return any(not p.future.done() for p in self._pending.values())

    def pending_interrupts(self) -> List[Interrupt]:
        return [
            p.interrupt
            for p in self._pending.values()
            if p.interrupt is not None and not p.future.done()
        ]

    @property
    def frontend_tool_names(self) -> set[str]:
        return set(self._frontend_tool_names)

    # ------------------------------------------------------------------
    # Registry
    # ------------------------------------------------------------------

    def _park(self, request: PendingRequest) -> asyncio.Future:
        self._pending[request.id] = request
        if request.tool_call_id:
            self._by_tool_call[request.tool_call_id] = request.id
        return request.future

    def resolve_tool_call(self, tool_call_id: str, value: Any) -> bool:
        """Resolves a parked frontend tool with a client-supplied result."""
        pending_id = self._by_tool_call.get(tool_call_id)
        if pending_id is None:
            return False
        return self._resolve(pending_id, value)

    def resolve_interrupt(self, interrupt_id: str, payload: Any, cancelled: bool) -> bool:
        """Resolves a parked question/approval from a ``ResumeEntry``."""
        pending = self._pending.get(interrupt_id)
        if pending is None:
            return False
        if cancelled:
            return self._resolve(pending.id, _CANCELLED)
        return self._resolve(pending.id, payload)

    def _resolve(self, pending_id: str, value: Any) -> bool:
        pending = self._pending.get(pending_id)
        if pending is None or pending.future.done():
            return False
        pending.future.set_result(value)
        return True

    def pending_ids(self) -> set:
        """Ids of requests still awaiting a client answer."""
        return {p.id for p in self._pending.values() if not p.future.done()}

    def abandon_pending(self) -> int:
        """Releases every parked request because the user moved on.

        Resolves rather than raises: the harness is blocked inside a tool or
        hook, and a plain answer lets it wind the old turn down, whereas an
        exception would surface to the model as a tool crash.
        """
        released = 0
        for pending in self._pending.values():
            if not pending.future.done():
                pending.future.set_result(_ABANDONED)
                released += 1
        self._pending.clear()
        self._by_tool_call.clear()
        return released

    def fail_all(self, exc: BaseException) -> None:
        """Fails every parked request -- used when a session is torn down."""
        for pending in self._pending.values():
            if not pending.future.done():
                pending.future.set_exception(exc)
        self._pending.clear()
        self._by_tool_call.clear()

    def forget_resolved(self) -> None:
        for pid in [p.id for p in self._pending.values() if p.future.done()]:
            pending = self._pending.pop(pid, None)
            if pending and pending.tool_call_id:
                self._by_tool_call.pop(pending.tool_call_id, None)

    # ------------------------------------------------------------------
    # 1. Frontend tools
    # ------------------------------------------------------------------

    def build_frontend_tools(self, tools: List[AGUITool]) -> List[ToolWithSchema]:
        """Turns ``RunAgentInput.tools`` into parking Antigravity tools."""
        built: List[ToolWithSchema] = []
        for tool in tools:
            built.append(self._build_frontend_tool(tool))
            self._frontend_tool_names.add(tool.name)
        return built

    def _build_frontend_tool(self, tool: AGUITool) -> ToolWithSchema:
        bridge = self

        async def _invoke(**kwargs: Any) -> Any:
            # The harness escalates a slow custom tool to a "background task"
            # and lets the model carry on without its result. The model then
            # re-issues the call -- often with slightly different arguments --
            # which would make the client execute a side-effecting action the
            # user has already seen. A frontend tool is therefore dispatched at
            # most once per turn; a repeat is answered locally.
            args = kwargs or {}
            loop = asyncio.get_running_loop()
            claim_future: Optional[asyncio.Future] = None

            if bridge._deduplicate:
                claim = bridge._turn_results.get(tool.name)
                if claim is not None:
                    first_args, done = claim
                    logger.debug("Suppressing repeated %s call this turn", tool.name)
                    # The first dispatch may still be in flight (the SDK's
                    # ToolRunner gathers a tool batch concurrently), so wait for
                    # its result rather than reading a slot that is not filled
                    # in yet.
                    first_result = await asyncio.shield(done)
                    if first_args == args:
                        return first_result
                    # Different arguments: don't silently pass off the old result
                    # as this call's, say plainly what happened so the model
                    # stops retrying and reports what actually ran.
                    return (
                        f"{tool.name} already ran in this turn with arguments "
                        f"{json.dumps(first_args)} and returned "
                        f"{json.dumps(first_result, default=str)}. It was not run "
                        "again. Tell the user the result; only call it again on a "
                        "later turn if they ask for another change."
                    )
                # Claim the slot BEFORE parking, so a concurrent identical call
                # in the same batch waits on us instead of dispatching again.
                claim_future = loop.create_future()
                bridge._turn_results[tool.name] = (args, claim_future)

            tool_call_id = str(uuid.uuid4())
            request = PendingRequest(
                id=tool_call_id,
                kind=KIND_FRONTEND_TOOL,
                future=loop.create_future(),
                tool_call_id=tool_call_id,
                tool_name=tool.name,
            )

            bridge.emit(
                ToolCallStartEvent(
                    type="TOOL_CALL_START",
                    tool_call_id=tool_call_id,
                    tool_call_name=tool.name,
                )
            )
            bridge.emit(
                ToolCallArgsEvent(
                    type="TOOL_CALL_ARGS",
                    tool_call_id=tool_call_id,
                    delta=json.dumps(kwargs or {}),
                )
            )
            bridge.emit(
                ToolCallEndEvent(type="TOOL_CALL_END", tool_call_id=tool_call_id)
            )

            logger.debug("Parking frontend tool %s (%s)", tool.name, tool_call_id)
            try:
                result = await bridge._park(request)
            except BaseException as exc:
                # Settle the future WE created, never a dict re-read: reset_turn()
                # may have dropped the entry already, and a waiter blocked on the
                # future object would then hang forever -- taking the harness'
                # tool batch, and the run holding session.lock, with it.
                if claim_future is not None and not claim_future.done():
                    claim_future.set_exception(exc)
                    # Mark retrieved so a claim nobody waited on does not warn.
                    claim_future.add_done_callback(
                        lambda f: f.cancelled() or f.exception()
                    )
                bridge._turn_results.pop(tool.name, None)
                raise
            logger.debug("Frontend tool %s resumed", tool.name)
            if result is _CANCELLED:
                result = "The user cancelled this tool call."
            if claim_future is not None and not claim_future.done():
                claim_future.set_result(result)
            return result

        _invoke.__name__ = tool.name
        _invoke.__doc__ = tool.description or f"Client-side tool: {tool.name}"
        schema = tool.parameters if isinstance(tool.parameters, dict) else {}
        if not schema:
            schema = {"type": "object", "properties": {}}
        return ToolWithSchema(_invoke, schema)

    # ------------------------------------------------------------------
    # 2. Model questions -> AG-UI interrupt
    # ------------------------------------------------------------------

    def build_interaction_hook(self) -> ag_hooks.OnInteractionHook:
        bridge = self

        @ag_hooks.on_interaction
        async def _on_interaction(
            spec: ag_types.AskQuestionInteractionSpec,
        ) -> ag_types.QuestionHookResult:
            interrupt_id = str(uuid.uuid4())
            loop = asyncio.get_running_loop()

            questions = [
                {
                    "question": q.question,
                    "is_multi_select": q.is_multi_select,
                    "options": [{"id": o.id, "text": o.text} for o in q.options],
                }
                for q in spec.questions
            ]
            interrupt = Interrupt(
                id=interrupt_id,
                reason="ask_question",
                message=questions[0]["question"] if questions else "The agent has a question.",
                response_schema=_question_response_schema(questions),
                metadata={"questions": questions},
            )
            request = PendingRequest(
                id=interrupt_id,
                kind=KIND_QUESTION,
                future=loop.create_future(),
                interrupt=interrupt,
                metadata={"questions": questions},
            )

            logger.debug("Parking ask_question interrupt %s", interrupt_id)
            payload = await bridge._park(request)
            if payload is _CANCELLED or payload == _ABANDONED:
                return ag_types.QuestionHookResult(responses=[], cancelled=True)
            return _to_question_hook_result(payload, spec)

        return _on_interaction

    # ------------------------------------------------------------------
    # 3. Tool approval -> AG-UI interrupt
    # ------------------------------------------------------------------

    def build_tool_approval_hook(
        self, *, auto_approve: Optional[set[str]] = None
    ) -> ag_hooks.PreToolCallDecideHook:
        """Builds the approval decide-hook.

        Registering this hook also satisfies the SDK's mandatory-safety guard,
        which otherwise refuses to start when write tools or MCP servers are
        enabled without an explicit policy.
        """
        bridge = self
        allowed = auto_approve or set()

        @ag_hooks.pre_tool_call_decide
        async def _decide(call: ag_types.ToolCall) -> ag_types.HookResult:
            name = call.name.value if hasattr(call.name, "value") else str(call.name)
            # Frontend tools are the client's own; approving them here would
            # double-prompt the very user who supplied them.
            if name in bridge._frontend_tool_names or name in allowed:
                return ag_types.HookResult(allow=True)

            # ToolCall.id is None inside this hook, so mint a correlation id.
            interrupt_id = str(uuid.uuid4())
            loop = asyncio.get_running_loop()
            interrupt = Interrupt(
                id=interrupt_id,
                reason="tool_approval",
                message=f"Allow the agent to run `{name}`?",
                response_schema={
                    "type": "object",
                    "properties": {
                        "approved": {"type": "boolean"},
                        "message": {"type": "string"},
                    },
                    "required": ["approved"],
                },
                metadata={"tool_name": name, "args": _jsonable(call.args)},
            )
            request = PendingRequest(
                id=interrupt_id,
                kind=KIND_APPROVAL,
                future=loop.create_future(),
                interrupt=interrupt,
                tool_name=name,
            )

            logger.debug("Parking approval for %s (%s)", name, interrupt_id)
            payload = await bridge._park(request)
            if payload is _CANCELLED:
                return ag_types.HookResult(
                    allow=False, message="The user cancelled the approval request."
                )
            if payload == _ABANDONED:
                return ag_types.HookResult(allow=False, message=_ABANDONED)
            approved, message, understood = _read_approval(payload)
            if not understood:
                logger.warning(
                    "Uninterpretable approval payload for %s: %r", name, payload
                )
                return ag_types.HookResult(
                    allow=False,
                    message=(
                        "The approval response could not be interpreted, so the "
                        "call was blocked. This is not a decision by the user."
                    ),
                )
            return ag_types.HookResult(
                allow=approved,
                message=message or ("" if approved else "The user denied this tool call."),
            )

        return _decide


class _Cancelled:
    """Sentinel for a client-cancelled parked request."""

    def __repr__(self) -> str:  # pragma: no cover - debug aid
        return "<cancelled>"


_CANCELLED = _Cancelled()


def _question_response_schema(questions: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "responses": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "selected_option_ids": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                        "freeform_response": {"type": "string"},
                        "skipped": {"type": "boolean"},
                    },
                },
                "minItems": len(questions),
            }
        },
        "required": ["responses"],
    }


def _to_question_hook_result(
    payload: Any, spec: ag_types.AskQuestionInteractionSpec
) -> ag_types.QuestionHookResult:
    """Coerces a client resume payload into a QuestionHookResult.

    Accepts the documented ``{"responses": [...]}`` shape, a bare list, or a
    plain string (treated as a freeform answer to the first question) so simple
    clients do not have to construct the full envelope.
    """
    if isinstance(payload, str):
        return ag_types.QuestionHookResult(
            responses=[ag_types.QuestionResponse(freeform_response=payload)]
        )
    raw: Any = payload
    if isinstance(payload, dict):
        raw = payload.get("responses", payload)
    if isinstance(raw, dict):
        raw = [raw]
    if not isinstance(raw, list):
        raw = []

    responses: List[ag_types.QuestionResponse] = []
    for item in raw:
        if isinstance(item, str):
            responses.append(ag_types.QuestionResponse(freeform_response=item))
        elif isinstance(item, dict):
            responses.append(
                ag_types.QuestionResponse(
                    selected_option_ids=item.get("selected_option_ids"),
                    freeform_response=item.get("freeform_response", "") or "",
                    skipped=bool(item.get("skipped", False)),
                )
            )
    # The harness expects one response per question.
    while len(responses) < len(spec.questions):
        responses.append(ag_types.QuestionResponse(skipped=True))
    return ag_types.QuestionHookResult(responses=responses)


_AFFIRMATIVE = frozenset({"yes", "true", "approve", "approved", "y", "ok"})
_NEGATIVE = frozenset({"no", "false", "deny", "denied", "n", "reject"})


def _read_approval(payload: Any) -> tuple[bool, str, bool]:
    """Returns (approved, message, understood).

    ``understood`` separates "the user said no" from "we could not tell what
    the client sent" -- reporting the second as a denial puts words in the
    user's mouth.
    """
    if isinstance(payload, bool):
        return payload, "", True
    if isinstance(payload, str):
        text = payload.strip().lower()
        if text in _AFFIRMATIVE:
            return True, "", True
        if text in _NEGATIVE:
            return False, "", True
        return False, "", False
    if isinstance(payload, dict):
        raw = payload.get("approved", payload.get("allow"))
        if raw is None:
            return False, "", False
        return bool(raw), str(payload.get("message", "") or ""), True
    return False, "", False


def _jsonable(value: Any) -> Any:
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return str(value)
