"""Live end-to-end tests: real harness subprocess, real model, real HTTP.

Opt-in -- these start a Go subprocess and spend tokens:

    export OPENAI_API_KEY=...
    pytest tests/test_live_openai.py -m live

They exercise the whole path the dojo uses: FastAPI endpoint -> SSE ->
AntigravityAgent -> SessionManager -> Antigravity harness -> OpenAI.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
import tempfile
import uuid

import httpx
import pytest

sys.path.insert(
    0, os.path.join(os.path.dirname(__file__), "..", "examples", "server")
)

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(
        not os.environ.get("OPENAI_API_KEY"),
        reason="OPENAI_API_KEY is required for live tests",
    ),
]

MODEL = os.environ.get("ANTIGRAVITY_TEST_MODEL", "gpt-4.1-mini")


@pytest.fixture(scope="module")
def base_url():
    from openai_proxy import start_background

    return start_background(port=8955)


@pytest.fixture(scope="module")
def workspace():
    with tempfile.TemporaryDirectory(prefix="ag-ui-antigravity-") as path:
        yield path


@pytest.fixture(scope="module")
def short_workspace():
    """A workspace with a deliberately short path.

    macOS temp directories are ~75 characters of high-entropy text. A model
    asked to repeat one back inside a tool call gets it wrong often enough to
    make a test flaky, and the harness treats a bad path as fatal.
    """
    path = os.path.join("/tmp", f"agw{os.getpid()}")
    os.makedirs(path, exist_ok=True)
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


def run_input(thread_id, prompt, *, tools=None, messages=None, resume=None):
    payload = {
        "threadId": thread_id,
        "runId": str(uuid.uuid4()),
        "state": {},
        "messages": messages
        or [{"id": str(uuid.uuid4()), "role": "user", "content": prompt}],
        "tools": tools or [],
        "context": [],
        "forwardedProps": {},
    }
    if resume is not None:
        payload["resume"] = resume
    return payload


async def collect(agent, payload):
    from ag_ui.core import RunAgentInput

    events = []
    async for event in agent.run(RunAgentInput.model_validate(payload)):
        events.append(event)
    return events


def text_of(events):
    return "".join(
        e.delta for e in events if e.type == "TEXT_MESSAGE_CONTENT"
    )


def types_of(events):
    return [e.type for e in events]


def assert_lifecycle(events):
    """AG-UI's core contract: one RUN_STARTED, exactly one terminal event."""
    types = types_of(events)
    assert types[0] == "RUN_STARTED"
    assert types.count("RUN_STARTED") == 1
    terminals = [t for t in types if t in ("RUN_FINISHED", "RUN_ERROR")]
    assert len(terminals) == 1, f"expected one terminal event, got {terminals}"
    assert types[-1] == terminals[0]
    if "RUN_ERROR" in types:
        assert "RUN_FINISHED" not in types


@pytest.mark.asyncio
async def test_streams_text_and_bookends_the_run(base_url, workspace):
    from ag_ui_antigravity import AntigravityAgent

    agent = AntigravityAgent(
        model=MODEL,
        base_url=base_url,
        system_instructions="Answer in one short sentence.",
        workspaces=[workspace],
    )
    try:
        events = await asyncio.wait_for(
            collect(agent, run_input("live-1", "Say exactly: hello from antigravity")),
            180,
        )
    finally:
        await agent.close()

    assert_lifecycle(events)
    types = types_of(events)
    assert "TEXT_MESSAGE_START" in types
    assert types.index("TEXT_MESSAGE_START") < types.index("TEXT_MESSAGE_END")
    assert "hello from antigravity" in text_of(events).lower()


@pytest.mark.asyncio
async def test_multi_turn_reuses_the_session_and_keeps_history(base_url, workspace):
    from ag_ui_antigravity import AntigravityAgent

    agent = AntigravityAgent(
        model=MODEL,
        base_url=base_url,
        system_instructions="Answer in one short sentence.",
        workspaces=[workspace],
    )
    thread = "live-multiturn"
    try:
        first = await asyncio.wait_for(
            collect(agent, run_input(thread, "My favourite colour is octarine. Acknowledge.")),
            180,
        )
        assert_lifecycle(first)

        second = await asyncio.wait_for(
            collect(agent, run_input(thread, "What is my favourite colour?")), 180
        )
        assert_lifecycle(second)
        # History lives in the harness process, proving the session was reused.
        assert "octarine" in text_of(second).lower()
        assert agent.session_manager.stats()["live_sessions"] == 1
    finally:
        await agent.close()


@pytest.mark.asyncio
async def test_frontend_tool_parks_then_resumes_across_two_runs(base_url, workspace):
    """Park on a client-executed tool, resume on the next run -- end to end."""
    from ag_ui_antigravity import AntigravityAgent

    tool = {
        "name": "get_user_favorite_color",
        "description": "Returns the current user's favourite colour.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    }
    agent = AntigravityAgent(
        model=MODEL,
        base_url=base_url,
        system_instructions=(
            "Always call get_user_favorite_color to answer colour questions. "
            "After it returns, state the colour verbatim in one short sentence."
        ),
        workspaces=[workspace],
    )
    thread = "live-frontend-tool"
    try:
        # ---- run N: the tool parks, the run ends, the SSE closes ----
        first = await asyncio.wait_for(
            collect(agent, run_input(thread, "What is my favourite colour?", tools=[tool])),
            180,
        )
        assert_lifecycle(first)
        starts = [e for e in first if e.type == "TOOL_CALL_START"]
        assert len(starts) == 1, types_of(first)
        assert starts[0].tool_call_name == "get_user_favorite_color"
        tool_call_id = starts[0].tool_call_id
        assert "TOOL_CALL_END" in types_of(first)

        # The harness is now parked on our coroutine with no stream attached.
        session = agent.session_manager.get(thread)
        assert session is not None and session.is_parked

        # ---- run N+1: the client answers; the model continues ----
        second = await asyncio.wait_for(
            collect(
                agent,
                run_input(
                    thread,
                    "",
                    tools=[tool],
                    messages=[
                        {
                            "id": str(uuid.uuid4()),
                            "role": "tool",
                            "content": "chartreuse",
                            "toolCallId": tool_call_id,
                        }
                    ],
                ),
            ),
            180,
        )
        assert_lifecycle(second)
        assert "chartreuse" in text_of(second).lower(), text_of(second)
        assert not agent.session_manager.get(thread).is_parked
    finally:
        await agent.close()


@pytest.mark.asyncio
async def test_builtin_tool_calls_are_reported(base_url, short_workspace):
    """Built-in tools are executed by the harness and reported to the client.

    Uses `short_workspace`, not the shared `workspace` fixture, and that is
    load-bearing. This prompt asks the model to echo an absolute path back into
    a tool call, and with a long random temp path it garbles it -- measured at
    0/14 failures on a 9-character path against 2/14 on a 75-character one,
    with captured errors showing the path truncated or a chunk duplicated. The
    harness treats the resulting bad path as a fatal
    AntigravityExecutionError rather than handing it back to the model, so the
    run dies mid-tool-call. See "Keep workspace paths short" in the README.
    """
    from ag_ui_antigravity import AntigravityAgent

    target = os.path.join(short_workspace, "greeting.txt")
    with open(target, "w") as handle:
        handle.write("the magic word is xyzzy\n")

    agent = AntigravityAgent(
        model=MODEL,
        base_url=base_url,
        system_instructions=(
            "You have filesystem tools. Use them to answer questions about files."
        ),
        workspaces=[short_workspace],
    )
    try:
        events = await asyncio.wait_for(
            collect(
                agent,
                run_input(
                    "live-builtin",
                    f"List the files in {short_workspace}, then read {target} "
                    "and tell me the magic word.",
                ),
            ),
            240,
        )
    finally:
        await agent.close()

    assert_lifecycle(events)
    types = types_of(events)
    assert "TOOL_CALL_START" in types, types
    # Every built-in call must be closed AND resolved, or clients leave the
    # tool card spinning forever.
    assert types.count("TOOL_CALL_START") == types.count("TOOL_CALL_END")
    assert types.count("TOOL_CALL_START") == types.count("TOOL_CALL_RESULT")
    assert "xyzzy" in text_of(events).lower(), text_of(events)


@pytest.mark.asyncio
async def test_sse_endpoint_serves_the_wire_format(base_url, workspace):
    """Full HTTP path: FastAPI -> EventSourceResponse -> data: {json}."""
    from ag_ui_antigravity import AntigravityAgent, create_antigravity_app

    agent = AntigravityAgent(
        model=MODEL,
        base_url=base_url,
        system_instructions="Answer in one short sentence.",
        workspaces=[workspace],
    )
    app = create_antigravity_app({"agentic_chat": agent})

    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(
            transport=transport, base_url="http://testserver", timeout=180
        ) as client:
            frames = []
            async with client.stream(
                "POST",
                "/agentic_chat",
                json=run_input("live-sse", "Say exactly: sse works"),
            ) as response:
                assert response.status_code == 200
                assert "text/event-stream" in response.headers["content-type"]
                async for line in response.aiter_lines():
                    if line.startswith("data: "):
                        frames.append(json.loads(line[len("data: "):]))
    finally:
        await agent.close()

    assert frames[0]["type"] == "RUN_STARTED"
    assert frames[0]["threadId"] == "live-sse"
    assert frames[-1]["type"] == "RUN_FINISHED"
    text = "".join(
        f["delta"] for f in frames if f["type"] == "TEXT_MESSAGE_CONTENT"
    )
    assert "sse works" in text.lower()


@pytest.mark.asyncio
async def test_server_side_tool_reports_its_result(base_url, workspace):
    """A backend tool's return value must reach the client.

    The harness reports a custom Python tool as a single TOOL_CALL/ACTIVE step
    -- no DONE step, no result on Step -- because the value goes back over the
    WebSocket straight to the model. The adapter emits the call and its result
    itself; without that the dojo's backend_tool_rendering card spins forever.
    """
    import json

    from ag_ui_antigravity import AntigravityAgent

    async def get_weather(location: str) -> str:
        """Gets the current weather for a location.

        Args:
          location: The city to look up.
        """
        return json.dumps({"temperature": 22, "conditions": "Clear sky"})

    agent = AntigravityAgent(
        model=MODEL,
        base_url=base_url,
        workspaces=[workspace],
        save_dir=os.path.join(workspace, "save"),
        system_instructions=(
            "Use get_weather for any weather question, then summarise it in "
            "one short sentence."
        ),
        tools=[get_weather],
        enable_frontend_tools=False,
        enable_ask_question=False,
    )
    try:
        events = await collect(
            agent, run_input("server-tool", "What's the weather in Tokyo?")
        )
    finally:
        await agent.close()

    assert_lifecycle(events)
    types = types_of(events)

    starts = [e for e in events if e.type == "TOOL_CALL_START"]
    assert [e.tool_call_name for e in starts] == ["get_weather"], (
        "expected exactly one get_weather call, got "
        f"{[e.tool_call_name for e in starts]}"
    )

    results = [e for e in events if e.type == "TOOL_CALL_RESULT"]
    assert len(results) == 1, f"expected one TOOL_CALL_RESULT, got {len(results)}"
    assert json.loads(results[0].content)["temperature"] == 22
    assert results[0].tool_call_id == starts[0].tool_call_id

    # Ordering the client depends on: the call is bookended before its result.
    assert types.index("TOOL_CALL_END") < types.index("TOOL_CALL_RESULT")
    assert "22" in text_of(events) or "Tokyo" in text_of(events)


@pytest.mark.asyncio
async def test_cold_resume_rebuilds_the_session_and_keeps_history(base_url, workspace):
    """The documented persistence pattern, driven through the adapter.

    `persistence.md` is explicit that Antigravity's answer to "come back later"
    is to close the agent and reopen it with the same `conversation_id` and
    `save_dir`. The adapter does that on its own whenever the client's tool set
    changes between runs, which forces a rebuild rather than running against a
    stale tool list.

    The unit tests only prove the config carries the right fields, and the
    pooled test proves a strategy rehydrates history. Neither exercises this
    path end to end -- which is how a bug that gave every session its own
    `tempfile.mkdtemp()` save directory (so resume restored nothing) survived
    until it was found by hand.
    """
    from ag_ui.core import Tool as AGUITool

    from ag_ui_antigravity import AntigravityAgent

    def tool(name):
        return AGUITool(
            name=name,
            description=f"Does {name}.",
            parameters={"type": "object", "properties": {}},
        ).model_dump()

    agent = AntigravityAgent(
        model=MODEL,
        base_url=base_url,
        system_instructions="Answer in one short sentence. Remember what you are told.",
        workspaces=[workspace],
    )
    thread = "live-cold-resume"
    try:
        first = await asyncio.wait_for(
            collect(
                agent,
                run_input(
                    thread,
                    "Remember this: my passphrase is octarine. Acknowledge.",
                    tools=[tool("alpha")],
                ),
            ),
            180,
        )
        assert_lifecycle(first)
        before = agent.session_manager.get(thread)
        assert before is not None
        # Read it off the live agent: `session.conversation_id` is snapshotted
        # at creation, before any message has been exchanged, so the SDK always
        # reports None there. `_close_locked` falls back to the agent for
        # exactly this reason.
        conversation_id = before.agent.conversation_id
        assert conversation_id, "no conversation_id to resume from"

        # A changed tool set is the adapter's own cold-resume trigger: the
        # harness fixes the tool list at connect time, so the session must be
        # rebuilt rather than run against a stale one.
        second = await asyncio.wait_for(
            collect(
                agent,
                run_input(
                    thread, "What is my passphrase?", tools=[tool("beta")]
                ),
            ),
            180,
        )
        assert_lifecycle(second)

        after = agent.session_manager.get(thread)
        assert after is not None
        assert after is not before, "the session was not rebuilt"
        assert after.agent.conversation_id == conversation_id, (
            "the rebuild started a new conversation instead of resuming the old "
            f"one: {after.agent.conversation_id} != {conversation_id}"
        )
        assert "octarine" in text_of(second).lower(), (
            f"cold resume lost the history: {text_of(second)!r}"
        )
    finally:
        await agent.close()


@pytest.mark.asyncio
async def test_an_evicted_thread_resumes_when_it_returns(base_url, workspace):
    """A thread that idles out and comes back keeps its history.

    The trajectory stays in `save_dir` after the session is swept, so this is
    only a matter of remembering the conversation id. Before that was kept, a
    returning user got a brand-new conversation and the agent had amnesia while
    its history sat unreachable on disk.
    """
    from ag_ui_antigravity import AntigravityAgent
    from ag_ui_antigravity.session_manager import SessionManager

    agent = AntigravityAgent(
        model=MODEL,
        base_url=base_url,
        system_instructions="Answer in one short sentence. Remember what you are told.",
        workspaces=[workspace],
        save_dir=os.path.join(workspace, "evict-save"),
        session_manager=SessionManager(
            session_timeout_seconds=0, cleanup_interval_seconds=1
        ),
    )
    thread = "live-evicted"
    try:
        first = await asyncio.wait_for(
            collect(agent, run_input(thread, "Remember: the codeword is zarquon.")),
            180,
        )
        assert_lifecycle(first)
        before = agent.session_manager.get(thread).agent.conversation_id
        assert before

        # Let the idle sweeper reclaim it.
        for _ in range(30):
            await asyncio.sleep(1)
            if agent.session_manager.stats()["live_sessions"] == 0:
                break
        assert agent.session_manager.stats()["live_sessions"] == 0, (
            "the session was never swept, so this proves nothing"
        )

        second = await asyncio.wait_for(
            collect(agent, run_input(thread, "What is the codeword?")), 180
        )
        assert_lifecycle(second)
        after = agent.session_manager.get(thread).agent.conversation_id
        assert after == before, (
            f"started a new conversation instead of resuming: {after} != {before}"
        )
        assert "zarquon" in text_of(second).lower(), (
            f"the returning thread lost its history: {text_of(second)!r}"
        )
    finally:
        await agent.close()
