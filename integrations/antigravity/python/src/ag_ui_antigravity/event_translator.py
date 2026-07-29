"""Translates Antigravity ``Step`` objects into AG-UI protocol events.

The Antigravity stream is already ordered and delta-shaped: ``receive_steps()``
yields one logical ``Step`` per ``trajectory_id:step_index``, re-emitted as it
grows with ``status`` moving ACTIVE -> DONE and ``content_delta`` /
``thinking_delta`` carrying each increment. There is nothing to merge or
re-order, so the translator is a straight per-step state machine.

Two rules drive the shape of this file:

* AG-UI requires strict bookending -- a TEXT_MESSAGE_START must be closed by a
  TEXT_MESSAGE_END before any tool-call event opens, and likewise for thinking.
  ``_close_open_blocks`` is called at every transition.
* Steps whose ``source`` is USER are the harness echoing our own prompt back.
  They must never be translated, or the user's message would be replayed as an
  assistant message.
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any, AsyncGenerator, Optional

from ag_ui.core import (
    BaseEvent,
    CustomEvent,
    StateSnapshotEvent,
    StepFinishedEvent,
    StepStartedEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ThinkingEndEvent,
    ThinkingStartEvent,
    ThinkingTextMessageContentEvent,
    ThinkingTextMessageEndEvent,
    ThinkingTextMessageStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
    ToolCallStartEvent,
)
from google.antigravity import types as ag_types

logger = logging.getLogger(__name__)


def done_status(step: ag_types.Step) -> bool:
    return step.status == ag_types.StepStatus.DONE


def step_failure(step: ag_types.Step) -> Optional[str]:
    """Returns a failure message when a step reports one, else None.

    ``receive_steps()`` raises only for ``source=SYSTEM`` errors carrying HTTP
    400/401/403 (see the SDK's ``local_connection.receive_steps``). Rate limits,
    5xx and model-side failures are *yielded* as a step with
    ``status=ERROR``, so a run that only watches for exceptions reports them as
    success.
    """
    if step.status != ag_types.StepStatus.ERROR:
        return None
    http_code = getattr(step, "http_code", 0)
    detail = step.error or step.content or "the Antigravity harness reported a failure"
    return f"{detail} (HTTP {http_code})" if http_code else detail


# Antigravity's FINISH step carries the structured_output payload. Emitting it
# as a STATE_SNAPSHOT drives shared-state / generative-UI demos; consumers that
# prefer an opaque channel can switch to CUSTOM via `structured_output_as`.
STRUCTURED_OUTPUT_AS_STATE = "state"
STRUCTURED_OUTPUT_AS_CUSTOM = "custom"


class EventTranslator:
    """Holds the open-block and completed-step state for one Antigravity turn.

    Scope is the TURN, not the AG-UI run. A turn that parks on a human spans
    several runs, and on each later run the harness re-delivers the steps of
    that turn it has already sent. A per-run translator has no memory of them
    and re-emits every one, so the client sees duplicate tool calls, executes
    them again, and the conversation never converges. The session therefore
    keeps one translator per turn and retires it when the turn ends.
    """

    def __init__(
        self,
        *,
        structured_output_as: str = STRUCTURED_OUTPUT_AS_STATE,
        emit_builtin_tool_calls: bool = True,
    ):
        self._structured_output_as = structured_output_as
        self._emit_builtin_tool_calls = emit_builtin_tool_calls

        # step_index -> AG-UI message id, so a step re-emitted with new deltas
        # keeps streaming into the same message.
        self._message_ids: dict[int, str] = {}
        self._open_text: Optional[str] = None      # message_id of open text block
        self._open_text_index: Optional[int] = None
        self._open_thinking: bool = False
        # Antigravity tool-call identity -> AG-UI tool_call_id.
        self._tool_call_ids: dict[str, str] = {}
        self._open_tool_calls: set[str] = set()
        # Steps already carried to completion. When a turn spans several AG-UI
        # runs, the harness re-delivers the earlier steps of that turn on the
        # later runs; without these guards each redelivery would be translated
        # into a second TOOL_CALL_START / TEXT_MESSAGE_START and the client
        # would see (and re-execute) the same call again.
        self._completed_tool_calls: set[str] = set()
        # Calls that were still open when a run ended and so were bookended by
        # close(). They are NOT finished -- the harness delivers their result on
        # a later run of the same turn -- so they must not be treated as
        # redeliveries, only prevented from re-opening.
        self._flushed_open: set[str] = set()
        self._completed_steps: set[int] = set()
        self._emitted_args: dict[str, str] = {}
        # Argument keys present when a tool call was first seen. Built-in tools
        # report their outcome by *growing* the args dict at DONE, so the keys
        # that appear later are the result.
        self._input_arg_keys: dict[str, set[str]] = {}
        self._open_steps: set[str] = set()
        # Frontend (client-executed) tools are emitted by the UI bridge, not
        # here, so the translator must not double-emit them.
        self._suppressed_tool_names: set[str] = set()

    def suppress_tool(self, name: str) -> None:
        """Marks a tool as emitted elsewhere (the UI bridge)."""
        self._suppressed_tool_names.add(name)

    # ------------------------------------------------------------------
    # Block bookkeeping
    # ------------------------------------------------------------------

    def _message_id_for(self, step: ag_types.Step) -> str:
        if step.step_index not in self._message_ids:
            self._message_ids[step.step_index] = str(uuid.uuid4())
        return self._message_ids[step.step_index]

    async def _close_open_blocks(self) -> AsyncGenerator[BaseEvent, None]:
        """Closes any open text/thinking block. Must run before other events."""
        if self._open_thinking:
            yield ThinkingTextMessageEndEvent(type="THINKING_TEXT_MESSAGE_END")
            yield ThinkingEndEvent(type="THINKING_END")
            self._open_thinking = False
        if self._open_text is not None:
            yield TextMessageEndEvent(
                type="TEXT_MESSAGE_END", message_id=self._open_text
            )
            # A closed message can never be reopened, so if this step produces
            # more text later it must start a new one.
            self._message_ids.pop(self._open_text_index, None)
            self._open_text = None
            self._open_text_index = None

    async def close(self) -> AsyncGenerator[BaseEvent, None]:
        """Flushes open blocks at end of run.

        Always call before the terminal event -- RUN_FINISHED *or* RUN_ERROR;
        the error path is the one that actually needs it, since that is where a
        half-streamed message would otherwise be left unclosed.
        """
        async for event in self._close_open_blocks():
            yield event
        # `_open_tool_calls` holds internal keys, not AG-UI ids -- map through
        # `_tool_call_ids` before emitting. Record these as *flushed*, not
        # completed: the call is still running, and marking it completed would
        # make the translator drop the DONE step that carries its result.
        for key in list(self._open_tool_calls):
            yield ToolCallEndEvent(
                type="TOOL_CALL_END", tool_call_id=self._tool_call_ids[key]
            )
            self._open_tool_calls.discard(key)
            self._flushed_open.add(key)
        for step_name in list(self._open_steps):
            yield StepFinishedEvent(type="STEP_FINISHED", step_name=step_name)
            self._open_steps.discard(step_name)

    # ------------------------------------------------------------------
    # Main entry point
    # ------------------------------------------------------------------

    async def translate(
        self, step: ag_types.Step
    ) -> AsyncGenerator[BaseEvent, None]:
        """Yields the AG-UI events for one Antigravity step."""
        # The harness echoes the user's own prompt as a step with source=USER.
        # Translating it would replay the user's message as assistant output.
        if step.source == ag_types.StepSource.USER:
            return

        # An ERROR step carries no translatable content. The run loop inspects
        # `status` itself (see `step_failure`) and ends the run as RUN_ERROR --
        # the SDK only *raises* for source=SYSTEM with HTTP 400/401/403, so
        # every 429, 5xx and model-side failure arrives here as a step instead.
        if step.status == ag_types.StepStatus.ERROR:
            return

        # A step that already reached DONE on an earlier run of this turn is a
        # redelivery, not new output.
        already_done = step.step_index in self._completed_steps

        if not already_done and (
            step.type == ag_types.StepType.THINKING or step.thinking_delta
        ):
            async for event in self._translate_thinking(step):
                yield event

        if step.content_delta and not already_done:
            async for event in self._translate_text(step):
                yield event

        if step.tool_calls:
            async for event in self._translate_tool_calls(step):
                yield event

        if (
            step.type == ag_types.StepType.FINISH
            and step.structured_output is not None
            and not already_done
        ):
            async for event in self._close_open_blocks():
                yield event
            async for event in self._translate_structured_output(step):
                yield event

        # A step reaching DONE closes its text block so the next step (or a
        # tool call) starts cleanly.
        if step.status == ag_types.StepStatus.DONE:
            async for event in self._close_open_blocks():
                yield event
            self._completed_steps.add(step.step_index)

    # ------------------------------------------------------------------
    # Per-kind translation
    # ------------------------------------------------------------------

    async def _translate_thinking(
        self, step: ag_types.Step
    ) -> AsyncGenerator[BaseEvent, None]:
        if not step.thinking_delta:
            return
        if self._open_text is not None:
            yield TextMessageEndEvent(
                type="TEXT_MESSAGE_END", message_id=self._open_text
            )
            self._message_ids.pop(self._open_text_index, None)
            self._open_text = None
            self._open_text_index = None
        if not self._open_thinking:
            # THINKING_START must bracket the message events: the client's
            # verifyEvents rejects a THINKING_TEXT_MESSAGE_START with no
            # thinking step in progress, which aborts the whole run.
            yield ThinkingStartEvent(type="THINKING_START")
            yield ThinkingTextMessageStartEvent(type="THINKING_TEXT_MESSAGE_START")
            self._open_thinking = True
        yield ThinkingTextMessageContentEvent(
            type="THINKING_TEXT_MESSAGE_CONTENT", delta=step.thinking_delta
        )

    async def _translate_text(
        self, step: ag_types.Step
    ) -> AsyncGenerator[BaseEvent, None]:
        if self._open_thinking:
            yield ThinkingTextMessageEndEvent(type="THINKING_TEXT_MESSAGE_END")
            yield ThinkingEndEvent(type="THINKING_END")
            self._open_thinking = False

        message_id = self._message_id_for(step)
        if self._open_text is not None and self._open_text != message_id:
            yield TextMessageEndEvent(
                type="TEXT_MESSAGE_END", message_id=self._open_text
            )
            self._message_ids.pop(self._open_text_index, None)
            self._open_text = None
            self._open_text_index = None
        if self._open_text is None:
            message_id = self._message_id_for(step)
            yield TextMessageStartEvent(
                type="TEXT_MESSAGE_START", message_id=message_id, role="assistant"
            )
            self._open_text = message_id
            self._open_text_index = step.step_index
        yield TextMessageContentEvent(
            type="TEXT_MESSAGE_CONTENT",
            message_id=message_id,
            delta=step.content_delta,
        )

    def _tool_key(self, step: ag_types.Step, call: ag_types.ToolCall, pos: int) -> str:
        """Stable identity for a tool call across the step re-emissions.

        Built-in tool calls arrive with ``id=None``, so identity
        falls back to (step_index, position, name).
        """
        if call.id:
            return f"id:{call.id}"
        return f"pos:{step.step_index}:{pos}:{call.name}"

    async def _translate_tool_calls(
        self, step: ag_types.Step
    ) -> AsyncGenerator[BaseEvent, None]:
        for pos, call in enumerate(step.tool_calls):
            name = call.name.value if hasattr(call.name, "value") else str(call.name)
            if name in self._suppressed_tool_names:
                continue

            key = self._tool_key(step, call, pos)
            # Redelivery of a call this turn already finished. Re-emitting it
            # would show the client a duplicate card and, for client-executed
            # tools, make it run the tool a second time. This guard comes first
            # so a redelivered subagent step does not re-open its bracket
            # either.
            if key in self._completed_tool_calls:
                continue
            # Bookended at a run boundary while still running: suppress a second
            # START/ARGS, but let the DONE branch below deliver the result.
            flushed = key in self._flushed_open
            if flushed and not done_status(step):
                continue

            # A subagent invocation brackets the work it delegates, so it maps
            # onto AG-UI's STEP_STARTED/STEP_FINISHED rather than a bare tool
            # call. The bracket is structural, so it is emitted even when
            # built-in tool cards are suppressed -- opened before this call's
            # own events and closed after them. A step first observed at DONE
            # (no preceding ACTIVE) yields only the closing half.
            is_subagent = name == ag_types.BuiltinTools.START_SUBAGENT.value
            subagent_name = _subagent_name(call, step) if is_subagent else ""
            done = step.status == ag_types.StepStatus.DONE
            if is_subagent and not done:
                async for event in self.open_subagent_step(subagent_name):
                    yield event

            if not self._emit_builtin_tool_calls and _is_builtin(call.name):
                if done:
                    self._completed_tool_calls.add(key)
                    async for event in self.close_subagent_step(subagent_name):
                        yield event
                continue

            if key not in self._tool_call_ids:
                self._tool_call_ids[key] = call.id or str(uuid.uuid4())
            tool_call_id = self._tool_call_ids[key]

            if key not in self._open_tool_calls and not flushed:
                async for event in self._close_open_blocks():
                    yield event
                yield ToolCallStartEvent(
                    type="TOOL_CALL_START",
                    tool_call_id=tool_call_id,
                    tool_call_name=name,
                    parent_message_id=self._message_ids.get(step.step_index),
                )
                self._open_tool_calls.add(key)
                self._input_arg_keys[key] = set(
                    call.args.keys() if isinstance(call.args, dict) else ()
                )

            # Antigravity hands us the whole args dict (it does not stream arg
            # fragments), so emit only the delta beyond what we already sent.
            args_json = _safe_json(call.args)
            already = self._emitted_args.get(key, "")
            # A flushed call is already bookended; args after its END would be
            # out of order. The grown args are its result, delivered below.
            if flushed:
                self._emitted_args[key] = args_json
            elif args_json != already:
                delta = (
                    args_json[len(already):]
                    if args_json.startswith(already)
                    else args_json
                )
                if delta:
                    yield ToolCallArgsEvent(
                        type="TOOL_CALL_ARGS", tool_call_id=tool_call_id, delta=delta
                    )
                self._emitted_args[key] = args_json

            if step.status == ag_types.StepStatus.DONE:
                # A flushed call already had its END emitted at the boundary;
                # a second one would unbalance the client's bookkeeping.
                if not flushed:
                    yield ToolCallEndEvent(
                        type="TOOL_CALL_END", tool_call_id=tool_call_id
                    )
                self._open_tool_calls.discard(key)
                self._flushed_open.discard(key)
                self._completed_tool_calls.add(key)
                # Built-in tools are executed by the harness, which reports the
                # outcome by adding keys to the args payload at DONE rather than
                # emitting a separate result step. Some tools (view_file) add
                # nothing at all -- their output goes straight to the model. We
                # still close the call with an (empty) result so clients mark it
                # complete instead of leaving it spinning.
                yield ToolCallResultEvent(
                    type="TOOL_CALL_RESULT",
                    message_id=str(uuid.uuid4()),
                    tool_call_id=tool_call_id,
                    content=_extract_builtin_result(
                        call, self._input_arg_keys.get(key, set())
                    ),
                )
                # Close the bracket after the call it wraps, not before.
                if is_subagent:
                    async for event in self.close_subagent_step(subagent_name):
                        yield event

    async def _translate_structured_output(
        self, step: ag_types.Step
    ) -> AsyncGenerator[BaseEvent, None]:
        payload = step.structured_output
        if self._structured_output_as == STRUCTURED_OUTPUT_AS_CUSTOM:
            yield CustomEvent(
                type="CUSTOM", name="antigravity.structured_output", value=payload
            )
            return
        if not isinstance(payload, dict):
            # STATE_SNAPSHOT's snapshot is free-form, but wrapping a scalar keeps
            # client reducers from having to special-case non-objects.
            payload = {"structured_output": payload}
        yield StateSnapshotEvent(type="STATE_SNAPSHOT", snapshot=payload)

    # ------------------------------------------------------------------
    # Subagents
    # ------------------------------------------------------------------

    async def open_subagent_step(self, name: str) -> AsyncGenerator[BaseEvent, None]:
        async for event in self._close_open_blocks():
            yield event
        if name not in self._open_steps:
            yield StepStartedEvent(type="STEP_STARTED", step_name=name)
            self._open_steps.add(name)

    async def close_subagent_step(self, name: str) -> AsyncGenerator[BaseEvent, None]:
        if name in self._open_steps:
            async for event in self._close_open_blocks():
                yield event
            yield StepFinishedEvent(type="STEP_FINISHED", step_name=name)
            self._open_steps.discard(name)


def _subagent_name(call: ag_types.ToolCall, step: ag_types.Step) -> str:
    """Best-effort label for a subagent invocation.

    Steps belonging to a subagent share its ``trajectory_id`` (the part of
    ``Step.id`` before the colon), which is the stable fallback when the args
    carry no readable name.
    """
    args = call.args if isinstance(call.args, dict) else {}
    for key in ("name", "subagent", "subagent_name", "agent", "agent_name"):
        value = args.get(key)
        if isinstance(value, str) and value:
            return value
    trajectory_id = step.id.split(":")[0] if step.id else ""
    return f"subagent:{trajectory_id or step.step_index}"


def _is_builtin(name: Any) -> bool:
    try:
        ag_types.BuiltinTools(name)
        return True
    except ValueError:
        return False


def _safe_json(value: Any) -> str:
    try:
        return json.dumps(value or {})
    except (TypeError, ValueError):
        return json.dumps({"_unserializable": str(value)})


def _extract_builtin_result(call: ag_types.ToolCall, input_keys: set) -> str:
    """Returns a completed built-in tool's result payload, or "" if none.

    The harness surfaces results under tool-specific keys -- ``list_directory``
    grows a ``results`` key, ``search_web`` a different one -- so rather than
    guessing names, we take whatever keys appeared *after* the call was first
    observed. Tools like ``view_file`` add nothing (their output is fed to the
    model out of band), which yields "".
    """
    args = call.args or {}
    if not isinstance(args, dict):
        return ""
    produced = {k: v for k, v in args.items() if k not in input_keys}
    if not produced:
        return ""
    if len(produced) == 1:
        (value,) = produced.values()
        return value if isinstance(value, str) else _safe_json(value)
    return _safe_json(produced)
