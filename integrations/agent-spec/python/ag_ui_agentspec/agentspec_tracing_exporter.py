"""
AG-UI span processor for pyagentspec.tracing

This module bridges pyagentspec.tracing spans/events to AG-UI events
(`ag_ui.core.events`). It mirrors the behavior of the exporter used in the
telemetry package but adapts to the event shapes defined under
`pyagentspec.tracing.events`.

Notes for the pyagentspec.tracing version:
- LLM streaming uses `LlmGenerationChunkReceived`, which may carry text content
  and/or tool-call chunks; both are translated to AG-UI events.
- Tool execution events (`ToolExecutionRequest`/`ToolExecutionResponse`) do not
  carry a stable AG-UI `tool_call_id` of their own. We therefore correlate them:
  for the langgraph runtime the AG-UI `tool_call_id` is recovered from the
  request span's `tcid__` description, and for other runtimes the run-level
  `request_id` is used directly. Given that correlation, we DO emit AG-UI tool
  call lifecycle (`ToolCallChunkEvent`) and result (`ToolCallResultEvent`)
  events here.
"""

from __future__ import annotations

import ast
import os
import json
import uuid
import logging
import traceback
from contextvars import ContextVar
from typing import Any, Dict, List
from json_repair import repair_json

# AG‑UI Python SDK (events)
from ag_ui.core.events import (
    RunFinishedEvent,
    RunStartedEvent,
    StepFinishedEvent,
    StepStartedEvent,
    TextMessageChunkEvent,
    ToolCallResultEvent,
    ToolCallChunkEvent,
)

from pyagentspec.tracing.events.exception import ExceptionRaised
from pyagentspec.tracing.events.event import Event
from pyagentspec.tracing.events.llmgeneration import (
    LlmGenerationChunkReceived,
    LlmGenerationRequest,
    LlmGenerationResponse,
)
from pyagentspec.tracing.events.tool import (
    ToolExecutionRequest,
    ToolExecutionResponse,
)
from pyagentspec.tracing.spanprocessor import SpanProcessor
from pyagentspec.tracing.spans import LlmGenerationSpan, NodeExecutionSpan
from pyagentspec.tracing.spans.span import Span


# ContextVar used to bridge events into the FastAPI endpoint queue. The server
# should set this per request to an asyncio.Queue that receives AG‑UI events.
EVENT_QUEUE = ContextVar("AG_UI_EVENT_QUEUE", default=None)
logger = logging.getLogger("ag_ui_agentspec.tracing")


def _safe_model_dump(obj: Any) -> Any:
    model_dump = getattr(obj, "model_dump", None)
    if callable(model_dump):
        try:
            return model_dump()
        except Exception:  # pylint: disable=broad-exception-caught
            return repr(obj)
    return repr(obj)


class AgUiSpanProcessor(SpanProcessor):
    """Translate pyagentspec.tracing spans/events into AG-UI events.

    Emission strategy:
    - Run lifecycle: RUN_STARTED on startup, RUN_FINISHED on shutdown
    - Node spans: STEP_STARTED on start, STEP_FINISHED on end
    - LLM text streaming: on first chunk, mark started; emit TEXT_MESSAGE_CHUNK
    - LLM response: if no chunks, emit a single TEXT_MESSAGE_CHUNK; mark ended
    """

    def __init__(self, runtime: str) -> None:
        self._run = {"thread_id": str(uuid.uuid4()), "run_id": str(uuid.uuid4())}
        self._debug = os.getenv("AGUI_DEBUG", "").lower() in ("1", "true", "yes", "on")
        # Track if any text chunk has been emitted for a given LLM span
        self._llm_chunks_seen: Dict[str, bool] = {}
        # Track tool-call lifecycles seen via streaming to avoid double-emitting
        self._started_tool_calls: Dict[str, Any] = {}
        self._runtime = runtime
        # Correlate tool results with tool calls
        # tool_call_id is only available in the on_tool_start event
        # and not the on_tool_end event
        self._tool_run_id_to_tool_call_id: Dict[str, str] = {}

    def _emit(self, event_obj) -> None:
        queue = EVENT_QUEUE.get()
        if queue is None:
            raise RuntimeError("AG-UI event queue is not set")
        queue.put_nowait(event_obj)
        if self._debug:
            logger.info(
                "AGUI DEBUG event=%s payload=%s",
                type(event_obj).__name__,
                _safe_model_dump(event_obj),
            )

    async def _aemit(self, event_obj) -> None:
        queue = EVENT_QUEUE.get()
        if queue is None:
            raise RuntimeError("AG-UI event queue is not set")
        await queue.put(event_obj)
        if self._debug:
            logger.info(
                "AGUI DEBUG event=%s payload=%s",
                type(event_obj).__name__,
                _safe_model_dump(event_obj),
            )

    @property
    def _run_started_event(self):
        return RunStartedEvent(thread_id=self._run["thread_id"], run_id=self._run["run_id"])

    @property
    def _run_finished_event(self):
        return RunFinishedEvent(thread_id=self._run["thread_id"], run_id=self._run["run_id"])

    def startup(self) -> None:
        self._emit(self._run_started_event)

    def shutdown(self) -> None:
        self._emit(self._run_finished_event)

    async def startup_async(self) -> None:
        await self._aemit(self._run_started_event)

    async def shutdown_async(self) -> None:
        await self._aemit(self._run_finished_event)

    def on_start(self, span: Span) -> None:
        for ev in self._gather_start_events(span):
            self._emit(ev)

    def on_end(self, span: Span) -> None:
        for ev in self._gather_end_events(span):
            self._emit(ev)

    async def on_start_async(self, span: Span) -> None:
        for ev in self._gather_start_events(span):
            await self._aemit(ev)

    async def on_end_async(self, span: Span) -> None:
        for ev in self._gather_end_events(span):
            await self._aemit(ev)

    # Event routing
    def on_event(self, event: Event, span: Span, *args: Any, **kwargs: Any) -> None:
        for ev in self._gather_events_for_event(event, span):
            self._emit(ev)

    async def on_event_async(self, event: Event, span: Span) -> None:
        for ev in self._gather_events_for_event(event, span):
            await self._aemit(ev)

    # Internal helpers to keep sync/async paths DRY
    def _gather_start_events(self, span: Span) -> List[Any]:
        events: List[Any] = []
        if isinstance(span, LlmGenerationSpan):
            self._llm_chunks_seen[span.id] = False
        elif isinstance(span, NodeExecutionSpan):
            events.append(StepStartedEvent(step_name=span.node.name))
        return events

    def _gather_end_events(self, span: Span) -> List[Any]:
        events: List[Any] = []
        if isinstance(span, LlmGenerationSpan):
            self._llm_chunks_seen.pop(span.id, None)
        elif isinstance(span, NodeExecutionSpan):
            events.append(StepFinishedEvent(step_name=span.node.name))
        return events

    def _gather_events_for_event(self, event: Event, span: Span) -> List[Any]:
        events: List[Any] = []
        match event:
            case LlmGenerationChunkReceived():
                # WayFlow does not assign completion_id in streaming, falling back to request_id
                message_id = event.completion_id or event.request_id
                if not message_id:
                    raise ValueError("Expected assistant message id for text chunk")
                if event.content:
                    events.append(
                        TextMessageChunkEvent(
                            message_id=message_id,
                            role="assistant",
                            delta=_escape_html(event.content),
                        )
                    )
                    self._llm_chunks_seen[span.id] = True
                if event.tool_calls:
                    if len(event.tool_calls) != 1:
                        raise ValueError("expected exactly one tool call chunk")
                    tool_call_chunk = event.tool_calls[0]
                    tool_name = tool_call_chunk.tool_name
                    tool_call_id = tool_call_chunk.call_id
                    if tool_call_id not in self._started_tool_calls:
                        self._started_tool_calls[tool_call_id] = {"message_id": message_id}
                    events.append(
                        ToolCallChunkEvent(
                            tool_call_id=tool_call_id,
                            parent_message_id=message_id,
                            tool_call_name=tool_name,
                            delta=tool_call_chunk.arguments,
                        )
                    )
            case LlmGenerationRequest():
                return events  # not used for AG-UI
            case LlmGenerationResponse():
                message_id = event.completion_id
                if not message_id:
                    raise ValueError("Expected assistant message id in LLM response")
                # If no text chunks were streamed in this span, emit the full completion text as a single content event
                if not self._llm_chunks_seen.get(span.id, False):
                    completion_text = event.content
                    if completion_text:
                        events.append(
                            TextMessageChunkEvent(
                                message_id=message_id,
                                role="assistant",
                                delta=_escape_html(completion_text),
                            )
                        )
                    self._llm_chunks_seen[span.id] = True
                # if a tool_call was not streamed, emit a single ToolCallChunkEvent
                # Normalize arguments to a JSON string so frontends can JSON.parse() reliably
                for tool_call in event.tool_calls:
                    if tool_call.call_id not in self._started_tool_calls:
                        args_dict = json.loads(tool_call.arguments)
                        if isinstance(args_dict, dict) and (a2ui_json := args_dict.get("a2ui_json")):
                            args_dict["a2ui_json"] = repair_a2ui_json(a2ui_json)
                        tool_call.arguments = json.dumps(args_dict)

                        events.append(
                            ToolCallChunkEvent(
                                tool_call_id=tool_call.call_id,
                                parent_message_id=message_id,
                                tool_call_name=tool_call.tool_name,
                                delta=tool_call.arguments,
                            )
                        )
                        self._started_tool_calls[tool_call.call_id] = {"message_id": message_id}
            case ToolExecutionRequest():
                if self._runtime != "langgraph" and event.request_id not in self._started_tool_calls:
                    events.append(
                        ToolCallChunkEvent(
                            tool_call_id=event.request_id,
                            tool_call_name=event.tool.name,
                            delta=json.dumps(event.inputs),
                        )
                    )
                    self._started_tool_calls[event.request_id] = {
                        "message_id": span.id  # no need for accurate message_id here
                    }
                if self._runtime == "langgraph":
                    tool_call_id = span.description.replace("tcid__", "")
                    self._tool_run_id_to_tool_call_id[event.request_id] = tool_call_id
            case ToolExecutionResponse():
                if self._runtime == "langgraph":
                    # The correlation map is populated from the matching
                    # ToolExecutionRequest. If that request was never seen
                    # (out-of-order events, or a request span lacking a
                    # ``tcid__`` description), fall back to the run-level
                    # request_id rather than raising a KeyError.
                    if event.request_id in self._tool_run_id_to_tool_call_id:
                        tool_call_id = self._tool_run_id_to_tool_call_id[event.request_id]
                    else:
                        # Correlation miss: no matching ToolExecutionRequest was
                        # recorded for this request_id, so we cannot recover the
                        # AG-UI tool_call_id the frontend issued. We surrogate the
                        # raw request_id to avoid crashing, but the resulting tool
                        # result will be orphaned (it references an id the client
                        # never saw). Log it so the miss is observable.
                        logger.warning(
                            "AG-UI tool-call correlation miss: no ToolExecutionRequest "
                            "recorded for request_id=%r; using the raw request_id as a "
                            "surrogate tool_call_id. The emitted tool result may be "
                            "orphaned because the frontend never saw this id.",
                            event.request_id,
                        )
                        tool_call_id = event.request_id
                else:
                    tool_call_id = event.request_id
                content = _normalize_tool_output(event.outputs)
                # Tool results are emitted as separate "tool" messages on the client.
                # Use a unique message_id here (not the parent assistant message id), otherwise
                # the message list can contain duplicate IDs (assistant + tool), which breaks
                # React keys and message deduping logic downstream.
                #
                # Generate a fresh id so tool results never collide with assistant/user ids.
                tool_message_id = str(uuid.uuid4())
                events.append(
                    ToolCallResultEvent(
                        message_id=tool_message_id,
                        tool_call_id=tool_call_id,
                        content=content,
                        role="tool",
                    )
                )
            case ExceptionRaised():
                raise RuntimeError(
                    "[AG-UI SpanProcessor] ExceptionRaised occurred during agent execution:"
                    + event.exception_message
                    + f"\n\nStacktrace: {traceback.format_exc()}"
                )
            case _:
                return events
        return events


def repair_a2ui_json(a2ui_json: Any) -> str:
    if isinstance(a2ui_json, (list, dict)):
        parsed = a2ui_json
    elif isinstance(a2ui_json, str):
        s = a2ui_json.strip()
        try:
            parsed = json.loads(s)
        except json.JSONDecodeError:
            s2 = repair_json(s)
            parsed = json.loads(s2)
    else:
        raise NotImplementedError(f"Unexpected type for a2ui_json: {type(a2ui_json)}")
    return json.dumps(parsed, ensure_ascii=False)


def _escape_html(text: str) -> str:
    if text is None:
        return ""
    return str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _normalize_tool_output(outputs: Any) -> str:
    """Return a JSON string for AG-UI ToolCallResultEvent.content without double-encoding.

    Rules:
    - If outputs is a dict with a single key (e.g., {"weather_result": <value>}) and the inner
        value is itself JSON-like (dict/list or a JSON string), unwrap to the inner value for UI convenience.
    - If content is already a dict/list, serialize exactly once via json.dumps.
    - If content is a string that is valid JSON, pass it through unchanged (don’t wrap again).
    - Otherwise, stringify primitives.
    """
    content: Any = outputs
    # Unwrap single-key dicts to their inner value when appropriate
    if isinstance(outputs, dict) and len(outputs) == 1:
        inner = next(iter(outputs.values()))
        # If inner is a dict/list, prefer that directly; if it's a JSON string, keep as string
        if isinstance(inner, (dict, list)):
            content = inner
        else:
            content = inner
    # If it’s already a dict/list, serialize exactly once
    if isinstance(content, (dict, list)):
        return json.dumps(content)
    # If it’s a string that looks like JSON, pass through as-is (frontend will parse)
    if isinstance(content, str) and jsonable(content):
        return content
    if isinstance(content, str):
        try:
            content_dict = ast.literal_eval(content)
            return json.dumps(content_dict)
        except:
            pass
    # Fallback: stringify primitives
    return str(content)


def jsonable(string):
    try:
        json.loads(string)
        return True
    except:
        return False
