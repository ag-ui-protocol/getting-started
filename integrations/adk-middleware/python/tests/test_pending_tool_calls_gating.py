#!/usr/bin/env python
"""Regression tests for the pending_tool_calls HITL gating fix (issues #1652, #1732).

ag-ui-adk 0.6.1 began writing ``pending_tool_calls`` to ``session.state``
mid-stream for *every* tool call (PR #1581), including backend tools that
resolve in the same stream on the same pod. With ``DatabaseSessionService``,
those writes trip the ``Session._storage_update_marker`` while the ADK Runner
is mid-``run_async``, surfacing as::

    ValueError: The session has been modified in storage since it was loaded.
    Please reload the session before appending more events.

#1652 fixed the backend-tool variant by gating writes on
``execution.long_running_tool_ids``. #1732 / PR #1735 fixed the HITL/client-tool
variant by deferring the consumer's persistence call until the producer task
has finished, so the runner no longer races its own session row.

Tests cover:

1. The wiring: ``ExecutionState`` carries the shared set; ``ClientProxyTool``
   adds IDs to it before enqueuing ``TOOL_CALL_START``; ``ClientProxyToolset``
   passes the set into proxy tools.
2. End-to-end behavior with a scripted LLM and ``DatabaseSessionService``
   (sqlite+aiosqlite) — backend-only turn must complete cleanly *and* not
   pollute ``pending_tool_calls``.
3. Synchronous smoke coverage for the HITL/client-tool path on
   ``DatabaseSessionService`` (assertions on persistence + no errors).
4. **Live LLM** integration coverage (#1732 reproducer): drives a HITL turn
   with a real Gemini model so realistic streaming timing exposes the
   producer/consumer race that PR #1735 fixed. Requires ``GOOGLE_API_KEY``.

The DatabaseSessionService tests can be run against PostgreSQL by setting
``AGUI_DATABASE_URL`` (e.g.
``postgresql+psycopg://user:pass@localhost/db``). They default to
``sqlite+aiosqlite:///<tmp>`` which exercises the same storage-marker code
path as PostgreSQL.
"""

from __future__ import annotations

import asyncio
import logging
import os
import uuid
from pathlib import Path
from typing import AsyncGenerator, List, Optional

import pytest
import pytest_asyncio

from ag_ui.core import (
    RunAgentInput,
    Tool as AGUITool,
    UserMessage,
)

from ag_ui_adk import ADKAgent
from ag_ui_adk.agui_toolset import AGUIToolset
from ag_ui_adk.client_proxy_tool import ClientProxyTool
from ag_ui_adk.client_proxy_toolset import ClientProxyToolset
from ag_ui_adk.execution_state import ExecutionState
from ag_ui_adk.session_manager import SessionManager

from google.adk.agents import Agent, LlmAgent
from google.adk.apps import App, ResumabilityConfig
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.sessions import DatabaseSessionService, InMemorySessionService
from google.genai import types

from tests.constants import LIVE_TEST_MODEL

# Default model for live tests (Gemini Flash — cheap and fast).
DEFAULT_MODEL = LIVE_TEST_MODEL


STALE_MARKER = "The session has been modified in storage since it was loaded"


# ---------------------------------------------------------------------------
# Wiring tests (do not require a live DB)
# ---------------------------------------------------------------------------


class TestExecutionStateLongRunningSet:
    @pytest.mark.asyncio
    async def test_default_is_empty_owned_set(self):
        state = ExecutionState(
            task=asyncio.create_task(asyncio.sleep(0)),
            thread_id="t",
            event_queue=asyncio.Queue(),
        )
        assert state.long_running_tool_ids == set()
        # Mutating the local default shouldn't leak across instances.
        state.long_running_tool_ids.add("a")
        state2 = ExecutionState(
            task=asyncio.create_task(asyncio.sleep(0)),
            thread_id="t2",
            event_queue=asyncio.Queue(),
        )
        assert state2.long_running_tool_ids == set()

    @pytest.mark.asyncio
    async def test_accepts_external_shared_set(self):
        shared: set[str] = set()
        state = ExecutionState(
            task=asyncio.create_task(asyncio.sleep(0)),
            thread_id="t",
            event_queue=asyncio.Queue(),
            long_running_tool_ids=shared,
        )
        # Mutating the external set is visible on ExecutionState and vice-versa.
        shared.add("from-outside")
        assert "from-outside" in state.long_running_tool_ids
        state.long_running_tool_ids.add("from-inside")
        assert "from-inside" in shared


class TestClientProxyToolPopulatesSet:
    @pytest.mark.asyncio
    async def test_proxy_tool_registers_id_before_emitting_start(self):
        """ClientProxyTool must add tool_call_id to the shared set BEFORE
        putting TOOL_CALL_START on the queue, so a consumer that reads
        TOOL_CALL_END later sees the id in the gate (issue #1652).
        """
        ag_ui_tool = AGUITool(
            name="frontend_action",
            description="A frontend action",
            parameters={"type": "object", "properties": {}},
        )
        queue: asyncio.Queue = asyncio.Queue()
        long_running: set[str] = set()

        proxy = ClientProxyTool(
            ag_ui_tool=ag_ui_tool,
            event_queue=queue,
            long_running_tool_ids=long_running,
        )

        class _Ctx:
            function_call_id = "call-abc"

        # _execute_proxy_tool is the inner method invoked when ADK runs the
        # LongRunningFunctionTool wrapper. It is what actually emits events.
        await proxy._execute_proxy_tool({}, _Ctx())

        # The id must already be in the shared set, and at least one event
        # must be on the queue.
        assert "call-abc" in long_running, (
            "ClientProxyTool did not register HITL tool_call_id before emitting "
            "events; consumer gate would race (issue #1652)."
        )
        assert queue.qsize() >= 1

        # Drain the queue and assert ordering: the id was added before the
        # very first event was put. We can't observe that directly, but we
        # can confirm that the first event is TOOL_CALL_START for this id,
        # not something later — providing a stable invariant for the test.
        first = await queue.get()
        # Some configurations emit a PredictState CustomEvent first; skip it.
        from ag_ui.core import EventType
        if first.type == EventType.CUSTOM:
            first = await queue.get()
        assert first.type == EventType.TOOL_CALL_START
        assert first.tool_call_id == "call-abc"


class TestClientProxyToolsetPlumbing:
    @pytest.mark.asyncio
    async def test_toolset_passes_set_into_proxy_tools(self):
        ag_ui_tool = AGUITool(
            name="frontend_action",
            description="A frontend action",
            parameters={"type": "object", "properties": {}},
        )
        queue: asyncio.Queue = asyncio.Queue()
        toolset = ClientProxyToolset(
            ag_ui_tools=[ag_ui_tool],
            event_queue=queue,
        )
        shared: set[str] = set()
        toolset._long_running_tool_ids = shared  # mimic adk_agent.py wiring

        tools = await toolset.get_tools()
        assert len(tools) == 1
        # Internal field is fine to assert in a unit test — it documents the
        # contract that the toolset wires through.
        assert tools[0]._long_running_tool_ids is shared


# ---------------------------------------------------------------------------
# End-to-end regression tests using a scripted LLM and DatabaseSessionService
# (or InMemorySessionService for the control). These do NOT require
# GOOGLE_API_KEY because the LLM is a fully scripted stub.
# ---------------------------------------------------------------------------


class _StaleSessionDetector(logging.Handler):
    """Catch the swallowed-in-logger form of the stale-session ValueError.

    ``session_manager.update_session_state`` catches the ValueError and logs
    it as ERROR instead of re-raising, so tests need to listen on the log
    stream to see the bug from outside ADKAgent.
    """

    def __init__(self) -> None:
        super().__init__(level=logging.ERROR)
        self.tripped: bool = False
        self.first: Optional[str] = None

    def emit(self, record: logging.LogRecord) -> None:
        msg = record.getMessage()
        if STALE_MARKER in msg:
            self.tripped = True
            if self.first is None:
                self.first = f"{record.name}: {msg}"


class _ScriptedFunctionCallLlm(BaseLlm):
    """Turn 1: emit a function_call for ``tool_name``.

    Turn 2: emit final text. Used to drive the backend-tool regression
    scenario from issue #1652 without needing a real LLM.
    """

    tool_name: str = "get_fortune"
    turn_count: int = 0

    async def generate_content_async(
        self, llm_request, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        self.turn_count += 1
        if self.turn_count == 1:
            yield LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part(
                            function_call=types.FunctionCall(
                                name=self.tool_name, args={}
                            )
                        )
                    ],
                ),
                partial=False,
                turn_complete=True,
            )
        else:
            yield LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[types.Part(text="Your fortune: keep going.")],
                ),
                partial=False,
                turn_complete=True,
            )


def get_fortune() -> str:
    """Backend tool used by the scripted LLM scenario."""
    return "Good things come to those who wait."


def _make_db_url(tmp_path: Path) -> str:
    """Return the DB URL to use for the live-ish regression tests.

    Defaults to a temporary sqlite+aiosqlite file (exercises the same
    storage-marker code path as PostgreSQL). Override with
    ``AGUI_DATABASE_URL`` to run against a real Postgres in CI/local.
    """
    override = os.getenv("AGUI_DATABASE_URL")
    if override:
        return override
    db_path = tmp_path / f"repro_{uuid.uuid4().hex}.db"
    return f"sqlite+aiosqlite:///{db_path}"


@pytest_asyncio.fixture
async def detector():
    """Install a log handler that catches the swallowed stale-session error."""
    handler = _StaleSessionDetector()
    root = logging.getLogger()
    prev_level = root.level
    root.addHandler(handler)
    root.setLevel(logging.ERROR)
    try:
        yield handler
    finally:
        root.removeHandler(handler)
        root.setLevel(prev_level)


@pytest_asyncio.fixture
async def reset_session_manager():
    SessionManager.reset_instance()
    yield
    SessionManager.reset_instance()


class TestStaleSessionRegression:
    """End-to-end coverage for issue #1652.

    Each test drives one full AG-UI run with a scripted LLM and asserts that
    the run completes without the stale-session error logged or raised.
    """

    async def _run_one(self, agent: ADKAgent, message: str = "Give me a fortune"):
        events = []
        saw_run_error = False
        async for event in agent.run(
            RunAgentInput(
                thread_id=str(uuid.uuid4()),
                run_id=str(uuid.uuid4()),
                state={},
                messages=[
                    UserMessage(id=str(uuid.uuid4()), content=message)
                ],
                tools=[],
                context=[],
                forwarded_props={},
            )
        ):
            events.append(event)
            if type(event).__name__ == "RunErrorEvent":
                saw_run_error = True
        return events, saw_run_error

    @pytest.mark.asyncio
    async def test_backend_tool_with_database_session_service(
        self, detector, reset_session_manager, tmp_path
    ):
        """The exact reporter's scenario: scripted LLM + backend tool +
        DatabaseSessionService. Must not log the stale-session error.
        """
        db_url = _make_db_url(tmp_path)
        adk = ADKAgent(
            adk_agent=LlmAgent(
                name="FortuneAgent",
                model=_ScriptedFunctionCallLlm(model="scripted"),
                tools=[get_fortune],
                instruction="Call get_fortune when asked.",
            ),
            app_name="repro_1652",
            user_id="user_1",
            session_service=DatabaseSessionService(db_url=db_url),
        )

        events, saw_run_error = await self._run_one(adk)

        assert not detector.tripped, (
            f"Stale-session error logged during backend-tool turn: "
            f"{detector.first}. This is the regression from issue #1652."
        )
        assert not saw_run_error, (
            "RunErrorEvent surfaced from backend-tool turn — "
            "regression from issue #1652."
        )
        # We expect at least RUN_STARTED and RUN_FINISHED bookends.
        type_names = {type(e).__name__ for e in events}
        assert "RunStartedEvent" in type_names
        assert "RunFinishedEvent" in type_names

    @pytest.mark.asyncio
    async def test_backend_tool_with_in_memory_session_service_control(
        self, detector, reset_session_manager
    ):
        """Control: same scenario with InMemorySessionService. Verifies the
        scripted LLM path itself is healthy and that our gating change
        doesn't regress the non-DB happy path.
        """
        adk = ADKAgent(
            adk_agent=LlmAgent(
                name="FortuneAgent",
                model=_ScriptedFunctionCallLlm(model="scripted"),
                tools=[get_fortune],
                instruction="Call get_fortune when asked.",
            ),
            app_name="repro_1652_control",
            user_id="user_1",
            session_service=InMemorySessionService(),
        )

        events, saw_run_error = await self._run_one(adk)
        assert not detector.tripped
        assert not saw_run_error
        type_names = {type(e).__name__ for e in events}
        assert "RunStartedEvent" in type_names
        assert "RunFinishedEvent" in type_names

    @pytest.mark.asyncio
    async def test_backend_tool_does_not_pollute_pending_tool_calls(
        self, detector, reset_session_manager, tmp_path
    ):
        """A backend tool's id must NOT end up in session.state's
        ``pending_tool_calls`` list — that list is reserved for HITL handoffs.
        Persisting backend ids is wasted I/O AND the source of the
        stale-marker race (issue #1652).
        """
        db_url = _make_db_url(tmp_path)
        session_service = DatabaseSessionService(db_url=db_url)
        adk = ADKAgent(
            adk_agent=LlmAgent(
                name="FortuneAgent",
                model=_ScriptedFunctionCallLlm(model="scripted"),
                tools=[get_fortune],
                instruction="Call get_fortune when asked.",
            ),
            app_name="repro_1652_pending",
            user_id="user_1",
            session_service=session_service,
        )

        thread_id = str(uuid.uuid4())
        async for _ in adk.run(
            RunAgentInput(
                thread_id=thread_id,
                run_id=str(uuid.uuid4()),
                state={},
                messages=[
                    UserMessage(id=str(uuid.uuid4()), content="Give me a fortune")
                ],
                tools=[],
                context=[],
                forwarded_props={},
            )
        ):
            pass

        # Pull the session out of the DB and inspect its state.
        # The session_id is derived from thread_id by ADKAgent's session
        # manager; we look it up via the manager's metadata cache.
        metadata = adk._get_session_metadata(thread_id, "user_1")
        assert metadata is not None, "session metadata should have been cached"
        session_id, app_name, user_id = metadata
        session = await session_service.get_session(
            session_id=session_id, app_name=app_name, user_id=user_id
        )
        assert session is not None
        pending = session.state.get("pending_tool_calls", [])
        assert pending == [], (
            f"backend tool calls leaked into pending_tool_calls: {pending}. "
            f"Only HITL/client tools should be persisted (issue #1652)."
        )
        assert not detector.tripped

    @pytest.mark.asyncio
    async def test_hitl_client_tool_with_database_session_service(
        self, detector, reset_session_manager, tmp_path
    ):
        """Smoke coverage for the HITL/client-tool path on
        ``DatabaseSessionService`` (companion to issue #1732 / PR #1735).

        Drives a single HITL turn end-to-end with a scripted LLM and
        verifies the path completes cleanly. Pins three post-fix
        invariants:

          1. No stale-session error is logged.
          2. No ``RunErrorEvent`` reaches the client.
          3. PR #1581's persistence guarantee holds — the HITL tool call
             id is recorded in ``session.state['pending_tool_calls']`` by
             the time the run finishes.

        Note: this scripted-LLM test does NOT reproduce the specific
        producer/consumer race PR #1735 fixed. A pure-HITL turn where the
        tool returns ``None`` produces a single ADK ``append_event`` call
        — no ``function_response`` is built for long-running tools (see
        ``google.adk.flows.llm_flows.functions._execute_single_function_call_async``).
        The race requires a *second* ADK ``append_event`` after the
        middleware's mid-stream write, which only happens with realistic
        LLM streaming. The live-LLM test in
        :class:`TestStaleSessionRegressionLiveLLM` does reproduce the race
        and gates on ``GOOGLE_API_KEY``. This synchronous test is the fast
        always-runnable smoke check.
        """
        db_url = _make_db_url(tmp_path)
        session_service = DatabaseSessionService(db_url=db_url)

        frontend_tool = AGUITool(
            name="frontend_action",
            description="A frontend action that pauses for user input.",
            parameters={"type": "object", "properties": {}},
        )

        adk = ADKAgent(
            adk_agent=LlmAgent(
                name="HITLAgent",
                model=_ScriptedFunctionCallLlm(
                    model="scripted", tool_name="frontend_action"
                ),
                # AGUIToolset() is the middleware's placeholder for the
                # client tools that arrive via RunAgentInput.tools — it gets
                # swapped for a ClientProxyToolset at run time, which marks
                # every wrapped call as is_long_running=True. That is what
                # routes the call through the HITL code path the PR fixed.
                tools=[AGUIToolset()],
                instruction="Call frontend_action when asked.",
            ),
            app_name="repro_1732",
            user_id="user_1",
            session_service=session_service,
        )

        thread_id = str(uuid.uuid4())
        events = []
        saw_run_error: bool = False
        tool_call_ids: List[str] = []

        async for event in adk.run(
            RunAgentInput(
                thread_id=thread_id,
                run_id=str(uuid.uuid4()),
                state={},
                messages=[
                    UserMessage(id=str(uuid.uuid4()), content="Please act")
                ],
                tools=[frontend_tool],
                context=[],
                forwarded_props={},
            )
        ):
            events.append(event)
            name = type(event).__name__
            if name == "RunErrorEvent":
                saw_run_error = True
            if name == "ToolCallEndEvent":
                tool_call_ids.append(event.tool_call_id)

        # (1) The OCC race must not fire. This is the #1732 assertion: if
        # any mid-runner write to session.state happens (including the
        # pending_tool_calls write that PR #1735 deferred), the next ADK
        # append_event raises ValueError and session_manager logs it.
        assert not detector.tripped, (
            f"Stale-session error logged during HITL turn: {detector.first}. "
            f"This is the regression from issue #1732."
        )

        # (2) The run must complete cleanly — no RUN_ERROR surfaced to the
        # client. If the OCC violation had propagated out of the consumer's
        # try/except, this would fail.
        assert not saw_run_error, (
            "RunErrorEvent surfaced from HITL turn — regression from #1732."
        )

        type_names = {type(e).__name__ for e in events}
        assert "RunStartedEvent" in type_names
        assert "RunFinishedEvent" in type_names
        assert "ToolCallEndEvent" in type_names, (
            "Test setup error: HITL function call was never emitted as "
            "ToolCallEndEvent — confirm AGUIToolset is swapped for "
            "ClientProxyToolset and that the scripted LLM's tool_name "
            "matches the AGUITool in RunAgentInput.tools."
        )

        # (3) PR #1581's persistence guarantee still holds: the HITL tool
        # call id must be recorded in session.state['pending_tool_calls']
        # by the time RUN_FINISHED reaches the client. Without this check,
        # PR #1735 could silently regress to "never persist" and the
        # OCC-safety test above would still pass.
        metadata = adk._get_session_metadata(thread_id, "user_1")
        assert metadata is not None, (
            "session metadata should have been cached for this thread"
        )
        session_id, app_name, user_id = metadata
        session = await session_service.get_session(
            session_id=session_id, app_name=app_name, user_id=user_id
        )
        assert session is not None
        pending = session.state.get("pending_tool_calls", [])
        assert tool_call_ids and pending == tool_call_ids, (
            f"HITL tool call id should be persisted in pending_tool_calls. "
            f"Expected {tool_call_ids}, got {pending}. "
            f"This is PR #1581's cross-pod-handoff invariant."
        )


class TestHitlClientToolStillPersisted:
    """Sanity check that PR #1581's original behavior is preserved for HITL
    tools: a client-side tool must register its id in
    ``execution.long_running_tool_ids`` before TOOL_CALL_END is emitted.

    We assert the wiring directly rather than driving a full HITL turn
    (which requires resumability config and a second AG-UI run) — the
    relevant code path is identical and covered by existing HITL tests in
    ``test_tool_tracking_hitl.py``.
    """

    @pytest.mark.asyncio
    async def test_long_running_set_populated_after_proxy_emit(self):
        ag_ui_tool = AGUITool(
            name="frontend_action",
            description="A frontend action",
            parameters={"type": "object", "properties": {}},
        )
        queue: asyncio.Queue = asyncio.Queue()
        long_running: set[str] = set()

        toolset = ClientProxyToolset(
            ag_ui_tools=[ag_ui_tool],
            event_queue=queue,
        )
        toolset._long_running_tool_ids = long_running
        tools = await toolset.get_tools()
        proxy = tools[0]

        class _Ctx:
            function_call_id = "hitl-call-1"

        await proxy._execute_proxy_tool({}, _Ctx())

        assert "hitl-call-1" in long_running


# ---------------------------------------------------------------------------
# Live LLM integration test for #1732
# ---------------------------------------------------------------------------


class TestStaleSessionRegressionLiveLLM:
    """Live integration test for issue #1732.

    The synchronous scripted-LLM tests in :class:`TestStaleSessionRegression`
    cannot reproduce the #1732 race: a HITL fire-and-forget tool returning
    ``None`` causes ADK to emit only one event (no function_response), so
    there is no second ``append_event`` to race against the middleware's
    ``pending_tool_calls`` write.

    A real Gemini call produces realistic streaming timing and richer event
    sequences (text alongside / preceding the function_call, async network
    gaps that let the consumer interleave), which is what triggered the
    bug in the reporter's environment. This class drives an HITL turn end
    to end against a real model + ``DatabaseSessionService`` and asserts
    the OCC error from #1732 is not logged.

    Requires ``GOOGLE_API_KEY``. Falls back to ``llmock_server`` when no
    real key is configured (via the autouse fixture below), though the
    LLMock variant may not produce the same timing characteristics that
    expose the race.
    """

    @pytest.fixture(autouse=True)
    def setup_llmock(self, llmock_server):
        """Start LLMock when no real GOOGLE_API_KEY is set (session-scoped)."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def check_api_key(self):
        """Skip when no API key (real or LLMock-injected) is available."""
        if not os.getenv("GOOGLE_API_KEY"):
            pytest.skip(
                "GOOGLE_API_KEY not set and LLMock unavailable — skipping live test"
            )

    @pytest.mark.asyncio
    async def test_hitl_client_tool_live_llm_with_database_session_service(
        self, check_api_key, detector, tmp_path
    ):
        """End-to-end #1732 reproducer with a real Gemini model.

        Drives a single HITL turn with:
          - ``DatabaseSessionService`` (sqlite or Postgres via env override)
          - ``ResumabilityConfig(is_resumable=True)`` — the resumable HITL
            path keeps the runner alive after the LRO event, which is the
            configuration the original reporter was on (ADK >= 1.27)
          - A real Gemini model (``LIVE_TEST_MODEL``, currently
            ``gemini-3.5-flash``) that will be prompted to call
            ``approve_action`` (a client/frontend tool)

        Assertions:
          1. No stale-session error is logged (the #1732 regression).
          2. No ``RunErrorEvent`` reaches the client.
          3. The HITL tool call id is recorded in
             ``session.state['pending_tool_calls']`` by the time the run
             finishes (PR #1581's persistence guarantee).

        Without PR #1735's fix, the middleware's mid-runner
        ``pending_tool_calls`` write bumps the session row's storage marker
        while ADK is mid-stream. ADK's next ``append_event`` then raises
        ``ValueError: The session has been modified in storage since it
        was loaded``, which propagates as ``RUN_ERROR`` via
        ``_run_adk_in_background``'s ``except Exception``.
        """
        db_url = _make_db_url(tmp_path)
        session_service = DatabaseSessionService(db_url=db_url)

        approve_tool = AGUITool(
            name="approve_action",
            description="Ask the user to approve an action before proceeding.",
            parameters={
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "description": "The action to approve",
                    }
                },
                "required": ["action"],
            },
        )

        agent = Agent(
            model=DEFAULT_MODEL,
            name="hitl_stale_session_agent",
            instruction=(
                "You are a careful assistant. When asked to do anything, "
                "ALWAYS call the approve_action tool first to confirm with "
                "the user. Keep responses brief."
            ),
            tools=[AGUIToolset()],
        )

        # Resumable App so the runner exercises the post-LRO code paths
        # that produce the additional ADK append_event the race depends on.
        adk_app = App(
            name="repro_1732_live",
            root_agent=agent,
            resumability_config=ResumabilityConfig(is_resumable=True),
        )

        adk = ADKAgent.from_app(
            adk_app,
            user_id="user_1",
            session_service=session_service,
        )

        thread_id = str(uuid.uuid4())
        events = []
        saw_run_error: bool = False
        tool_call_ids: List[str] = []

        async for event in adk.run(
            RunAgentInput(
                thread_id=thread_id,
                run_id=str(uuid.uuid4()),
                state={},
                messages=[
                    UserMessage(
                        id=str(uuid.uuid4()),
                        content="Please archive the project files.",
                    )
                ],
                tools=[approve_tool],
                context=[],
                forwarded_props={},
            )
        ):
            events.append(event)
            name = type(event).__name__
            if name == "RunErrorEvent":
                saw_run_error = True
                logging.getLogger(__name__).error(
                    f"RunErrorEvent: code={getattr(event, 'code', None)} "
                    f"message={getattr(event, 'message', None)}"
                )
            if name == "ToolCallEndEvent":
                tool_call_ids.append(event.tool_call_id)

        # (1) The #1732 regression assertion.
        assert not detector.tripped, (
            f"Stale-session error logged during live HITL turn: "
            f"{detector.first}. This is the regression from issue #1732."
        )

        # (2) No RUN_ERROR surfaces. (RUN_ERROR with code
        # BACKGROUND_EXECUTION_ERROR is the exact failure mode the
        # reporter saw on the SSE stream.)
        assert not saw_run_error, (
            "RunErrorEvent surfaced from live HITL turn — #1732 regression. "
            "Check the test logs for the underlying ValueError message."
        )

        # If Gemini didn't call the tool (LLM behavior varies), skip the
        # persistence assertion — we still got value from the OCC check.
        # Otherwise the persistence guarantee from PR #1581 must hold.
        if not tool_call_ids:
            pytest.skip(
                "Live model did not call approve_action in this run — "
                "persistence assertion skipped (OCC assertion still applied)."
            )

        metadata = adk._get_session_metadata(thread_id, "user_1")
        assert metadata is not None
        session_id, app_name, user_id = metadata
        session = await session_service.get_session(
            session_id=session_id, app_name=app_name, user_id=user_id
        )
        assert session is not None
        pending = session.state.get("pending_tool_calls", [])
        assert pending == tool_call_ids, (
            f"HITL tool call ids should be persisted in pending_tool_calls. "
            f"Expected {tool_call_ids}, got {pending}. "
            f"This is PR #1581's cross-pod-handoff invariant."
        )
