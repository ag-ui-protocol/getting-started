# Copyright © 2025 Oracle and/or its affiliates.
#
# This software is under the Apache License 2.0
# (LICENSE-APACHE or http://www.apache.org/licenses/LICENSE-2.0) or Universal Permissive License
# (UPL) 1.0 (LICENSE-UPL or https://oss.oracle.com/licenses/upl), at your option.
"""Shared fixtures and lightweight fakes for the Agent-Spec AG-UI adapter tests.

These tests exercise the *translation* layer (pyagentspec tracing spans/events
-> AG-UI protocol events) and the runner input-preparation helpers. None of
them call an LLM API: the span processor is fed pre-constructed pyagentspec
tracing events and the runners are fed fake LangGraph/Wayflow objects, so the
network is never touched and no aimock recording is required.

Real pyagentspec event/span classes are used (built with ``model_construct`` to
bypass their heavy required-field validation) because the span processor
dispatches on event *type* via structured ``match``/``case`` pattern matching --
duck-typed stand-ins would not match those cases.
"""

import asyncio
from typing import Any, Optional

import pytest

from ag_ui.core import RunAgentInput


# ---------------------------------------------------------------------------
# Real pyagentspec tracing event / span builders.
#
# The span processor keys off the concrete event class (``case
# LlmGenerationResponse():`` etc.), so we must hand it genuine instances. Their
# constructors require complex ``tool``/``llm_config`` components we do not
# need for the translation paths under test, so we use ``model_construct`` to
# stamp out a real-typed instance carrying only the attributes the processor
# actually reads.
# ---------------------------------------------------------------------------

from pyagentspec.tracing.events.tool import (  # noqa: E402
    ToolExecutionRequest,
    ToolExecutionResponse,
)
from pyagentspec.tracing.events.llmgeneration import (  # noqa: E402
    LlmGenerationChunkReceived,
    LlmGenerationResponse,
)
from pyagentspec.tracing.events.exception import ExceptionRaised  # noqa: E402
from pyagentspec.tracing.spans.span import Span  # noqa: E402


def make_span(*, id: str = "span-1", description: str = "", node_name: Optional[str] = None) -> Span:
    """Build a real tracing ``Span`` carrying only the attributes the processor reads."""
    span = Span.model_construct(id=id, description=description)
    return span


class FakeToolCall:
    """Stand-in for a pyagentspec streamed/returned tool call.

    The processor reads ``.tool_name``, ``.call_id`` and ``.arguments`` off of
    the objects in ``event.tool_calls``; the real container type is internal to
    pyagentspec, so a tiny duck-typed object is the cleanest fake here.
    """

    def __init__(self, *, call_id: str, tool_name: str, arguments: str):
        self.call_id = call_id
        self.tool_name = tool_name
        self.arguments = arguments


class FakeTool:
    """Stand-in for the ``event.tool`` component (only ``.name`` is read)."""

    def __init__(self, name: str):
        self.name = name


def llm_chunk(*, content: str = "", request_id: str = "req-1",
              completion_id: Optional[str] = None, tool_calls=None) -> LlmGenerationChunkReceived:
    return LlmGenerationChunkReceived.model_construct(
        content=content,
        request_id=request_id,
        completion_id=completion_id,
        tool_calls=tool_calls or [],
    )


def llm_response(*, content: str = "", request_id: str = "req-1",
                 completion_id: Optional[str] = None, tool_calls=None) -> LlmGenerationResponse:
    return LlmGenerationResponse.model_construct(
        content=content,
        request_id=request_id,
        completion_id=completion_id,
        tool_calls=tool_calls or [],
    )


def tool_request(*, request_id: str, tool_name: str = "get_weather", inputs=None) -> ToolExecutionRequest:
    return ToolExecutionRequest.model_construct(
        request_id=request_id,
        tool=FakeTool(tool_name),
        inputs=inputs or {},
    )


def tool_response(*, request_id: str, outputs: Any) -> ToolExecutionResponse:
    return ToolExecutionResponse.model_construct(request_id=request_id, outputs=outputs)


def exception_raised(*, message: str = "boom") -> ExceptionRaised:
    return ExceptionRaised.model_construct(exception_message=message)


# ---------------------------------------------------------------------------
# AG-UI input factory
# ---------------------------------------------------------------------------

@pytest.fixture
def make_input():
    """Factory for RunAgentInput with sensible defaults."""

    def _make(
        *,
        thread_id: str = "thread-1",
        run_id: str = "run-1",
        messages=None,
        tools=None,
        state=None,
        context=None,
        forwarded_props=None,
    ) -> RunAgentInput:
        return RunAgentInput(
            thread_id=thread_id,
            run_id=run_id,
            messages=messages or [],
            tools=tools or [],
            state=state if state is not None else None,
            context=context or [],
            forwarded_props=forwarded_props or {},
        )

    return _make


@pytest.fixture
def event_queue():
    """An asyncio.Queue wired into the processor's EVENT_QUEUE ContextVar.

    Yields a (queue, drain) pair. ``drain()`` returns every non-sentinel item
    currently buffered without blocking.
    """
    from ag_ui_agentspec.agentspec_tracing_exporter import EVENT_QUEUE

    queue: asyncio.Queue = asyncio.Queue()
    token = EVENT_QUEUE.set(queue)

    def drain():
        items = []
        while not queue.empty():
            items.append(queue.get_nowait())
        return items

    try:
        yield queue, drain
    finally:
        EVENT_QUEUE.reset(token)
