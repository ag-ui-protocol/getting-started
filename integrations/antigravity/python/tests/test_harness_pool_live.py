"""Live gates for harness pooling -- the properties only a real harness can settle.

Pooling trades per-session isolation for shared fate, and no Google document
states that one ``localharness`` process may host several conversations. The
wire protocol is shaped for it and it demonstrably works, but every assumption
that buys is checked here against a real process:

* conversations really do share one process, and stay isolated while they do
  (tools, history, workspace);
* releasing one conversation does not kill its siblings, and a failed
  initialization does not either;
* cold resume still works when the conversation is pooled;
* **a dead process makes its conversations raise rather than hang** -- a hang
  would wedge a thread forever, because ``SessionManager`` holds its per-session
  lock across ``receive_steps``;
* **a parked conversation does not block its siblings** -- this integration
  needs human-in-the-loop parking and pooling at the same time, and if they do
  not compose then parked conversations must be placed on their own process.

    pytest tests/test_harness_pool_live.py -m live
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys

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
SHIM_PORT = int(os.environ.get("ANTIGRAVITY_POOL_TEST_PORT", "8967"))


def harness_pids() -> list:
    out = subprocess.run(
        ["pgrep", "-f", "localharness"], capture_output=True, text=True
    )
    return out.stdout.split()


@pytest.fixture(scope="module")
def base_url():
    from openai_proxy import start_background

    return start_background(port=SHIM_PORT)


def make_tool(name: str, value: str):
    async def _tool() -> str:
        return value

    _tool.__name__ = f"get_{name}"
    _tool.__doc__ = f"Returns the {name} code.\n\n    Args:\n      None.\n    "
    return _tool


def build_agent(
    *, base_url, pool, save_dir, workspace, tools=(), instructions=None, hooks=()
):
    """A pooled Agent, built exactly the way the adapter builds one."""
    from google.antigravity import Agent, CapabilitiesConfig
    from google.antigravity.hooks import policy

    from ag_ui_antigravity.agent import _PooledResumableOpenAIConfig

    config = _PooledResumableOpenAIConfig(
        model=MODEL,
        base_url=base_url,
        harness_pool=pool,
        save_dir=str(save_dir),
        workspaces=[str(workspace)],
        system_instructions=instructions
        or "Use the tool available to you and report its value verbatim, in one short sentence.",
        tools=list(tools),
        hooks=list(hooks),
        capabilities=CapabilitiesConfig(enable_subagents=False),
        policies=[policy.allow_all()],
    )
    return Agent(config)


async def run_turn(agent, prompt: str) -> str:
    from google.antigravity import types as ag_types

    conversation = agent.conversation
    await conversation.send(prompt)
    text = ""
    async for step in conversation.receive_steps():
        if step.source == ag_types.StepSource.MODEL and step.content_delta:
            text += step.content_delta
    return text


@pytest.fixture
async def pool():
    from ag_ui_antigravity.harness_pool import HarnessPool

    created = HarnessPool(max_conversations_per_process=8, idle_grace_seconds=600)
    try:
        yield created
    finally:
        await created.shutdown()


# ----------------------------------------------------------------------
# Sharing and isolation
# ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_conversations_share_one_process_and_stay_isolated(
    base_url, pool, tmp_path
):
    words = {"alpha": "ALPHA_7", "beta": "BETA_8", "gamma": "GAMMA_9"}
    save_dir = tmp_path / "save"
    agents = {}
    for name, value in words.items():
        workspace = tmp_path / name
        workspace.mkdir()
        agent = build_agent(
            base_url=base_url,
            pool=pool,
            save_dir=save_dir,
            workspace=workspace,
            tools=[make_tool(name, value)],
        )
        await agent.__aenter__()
        agents[name] = agent

    try:
        assert pool.stats()["processes"] == 1, "three conversations, one process"
        assert pool.stats()["conversations"] == 3

        results = await asyncio.gather(
            *[
                run_turn(agents[n], f"What is the {n} code? Use your tool.")
                for n in words
            ]
        )

        for name, text in zip(words, results):
            assert words[name] in text, f"{name} did not get its own value: {text!r}"
            for other, value in words.items():
                if other != name:
                    assert value not in text, (
                        f"{name} leaked {other}'s value: {text!r}"
                    )

        # History isolation: no conversation may contain another's value.
        for name, agent in agents.items():
            history = " ".join(
                step.content for step in agent.conversation.history if step.content
            )
            for other, value in words.items():
                if other != name:
                    assert value not in history, f"{name} history leaked {other}"

        # Tool isolation: beta was never given alpha's tool.
        cross = await run_turn(
            agents["beta"],
            "Call the tool named get_alpha. If you have no such tool, reply NO_TOOL.",
        )
        assert "ALPHA_7" not in cross
    finally:
        for agent in agents.values():
            await agent.__aexit__(None, None, None)


@pytest.mark.asyncio
async def test_workspace_stays_per_conversation(base_url, pool, tmp_path):
    """``workspaces`` rides in HarnessConfig, so pooling must not merge them.

    This is the load-bearing claim for multi-tenant sandboxing: if pooling
    collapsed workspaces, every tenant would see every other tenant's files.
    """
    save_dir = tmp_path / "save"
    first_ws = tmp_path / "first"
    second_ws = tmp_path / "second"
    first_ws.mkdir()
    second_ws.mkdir()
    (first_ws / "secret.txt").write_text("FIRST_ONLY_MARKER\n")
    (second_ws / "other.txt").write_text("nothing interesting\n")

    instructions = (
        "List the files in your workspace and report their names. Be brief."
    )
    second = build_agent(
        base_url=base_url,
        pool=pool,
        save_dir=save_dir,
        workspace=second_ws,
        instructions=instructions,
    )
    first = build_agent(
        base_url=base_url,
        pool=pool,
        save_dir=save_dir,
        workspace=first_ws,
        instructions=instructions,
    )
    await second.__aenter__()
    await first.__aenter__()
    try:
        assert pool.stats()["processes"] == 1
        question = "What files are in your workspace? Just list the names."

        # Positive control first. Without it the negative assertion below is
        # vacuous: a model that simply declines to list anything would "pass".
        owner_text = await run_turn(first, question)
        assert "secret.txt" in owner_text, (
            "positive control failed -- the owning conversation cannot see its "
            f"own workspace, so the isolation assertion proves nothing: {owner_text!r}"
        )

        other_text = await run_turn(second, question)
        assert "secret.txt" not in other_text, (
            f"pooling leaked the other conversation's workspace: {other_text!r}"
        )
    finally:
        await first.__aexit__(None, None, None)
        await second.__aexit__(None, None, None)


@pytest.mark.asyncio
async def test_releasing_one_conversation_spares_the_others(
    base_url, pool, tmp_path
):
    save_dir = tmp_path / "save"
    keep = build_agent(
        base_url=base_url, pool=pool, save_dir=save_dir, workspace=tmp_path
    )
    drop = build_agent(
        base_url=base_url, pool=pool, save_dir=save_dir, workspace=tmp_path
    )
    await keep.__aenter__()
    await drop.__aenter__()
    try:
        assert pool.stats()["processes"] == 1
        await drop.__aexit__(None, None, None)

        assert pool.stats()["processes"] == 1, "the shared process must survive"
        assert pool.stats()["conversations"] == 1
        text = await run_turn(keep, "Say STILL_ALIVE and nothing else.")
        assert "STILL_ALIVE" in text
    finally:
        await keep.__aexit__(None, None, None)


@pytest.mark.asyncio
async def test_failed_initialization_spares_the_siblings(base_url, pool, tmp_path):
    """The unpooled path kills the process on init failure; pooling must not.

    Doing so would destroy every co-tenant because of one conversation's bad
    config.
    """
    save_dir = tmp_path / "save"
    healthy = build_agent(
        base_url=base_url, pool=pool, save_dir=save_dir, workspace=tmp_path
    )
    await healthy.__aenter__()
    try:
        broken = build_agent(
            base_url=base_url, pool=pool, save_dir=save_dir, workspace=tmp_path
        )
        # Force the init exchange to fail without touching the process.
        broken._config.harness_pool  # noqa: B018 - the pool is shared by design
        strategy_timeout = 0.001
        with pytest.raises(Exception):
            original = broken._config.create_strategy

            def _impatient(*, tool_runner, hook_runner):
                strategy = original(tool_runner=tool_runner, hook_runner=hook_runner)
                strategy._init_timeout = strategy_timeout
                return strategy

            broken._config.create_strategy = _impatient
            await broken.__aenter__()

        # The slot must have been handed back, and the process left alone.
        assert pool.stats()["processes"] == 1
        assert pool.stats()["conversations"] == 1
        text = await run_turn(healthy, "Say STILL_ALIVE and nothing else.")
        assert "STILL_ALIVE" in text
    finally:
        await healthy.__aexit__(None, None, None)


# ----------------------------------------------------------------------
# P2 gate -- shared fate
# ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_process_death_raises_rather_than_hangs(base_url, pool, tmp_path):
    """A killed harness must fail its conversations promptly.

    Ship-blocker if it hangs: ``SessionManager`` holds a per-session lock across
    ``receive_steps``, so a conversation that never returns wedges that thread
    for the lifetime of the server.
    """
    save_dir = tmp_path / "save"
    agents = [
        build_agent(
            base_url=base_url, pool=pool, save_dir=save_dir, workspace=tmp_path
        )
        for _ in range(2)
    ]
    for agent in agents:
        await agent.__aenter__()

    assert pool.stats()["processes"] == 1
    process = next(iter(pool._processes.values()))[0]

    # Kill it the way a crash would, with no chance to clean up.
    process._process.kill()
    await asyncio.wait_for(process.dead.wait(), timeout=10)

    for agent in agents:
        with pytest.raises(BaseException):
            # Must settle quickly; a timeout here IS the failure.
            await asyncio.wait_for(
                run_turn(agent, "Say anything."), timeout=30
            )

    # And the pool must not hand the corpse to anyone else.
    assert not process.has_capacity


# ----------------------------------------------------------------------
# P2.5 gate -- parking versus pooling
# ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_parked_conversation_does_not_block_its_siblings(
    base_url, pool, tmp_path
):
    """HITL parking and pooling must compose, or density must drop to 1.

    A frontend tool parks by awaiting a Future that only the next HTTP run
    resolves. If that stalls co-tenants, one human thinking about an approval
    freezes every other conversation on the process -- in which case parked
    conversations need their own process.
    """
    save_dir = tmp_path / "save"
    parked = asyncio.Event()
    never = asyncio.get_running_loop().create_future()

    async def lookup_favorite_color(user: str) -> str:
        """Looks up a user's favorite color. Returns the color name.

        Args:
          user: The user's name.
        """
        parked.set()
        return await never  # parked for the whole test

    parker = build_agent(
        base_url=base_url,
        pool=pool,
        save_dir=save_dir,
        workspace=tmp_path,
        tools=[lookup_favorite_color],
        instructions=(
            "You must call the lookup_favorite_color tool to answer, then state "
            "the colour verbatim."
        ),
    )
    sibling_a = build_agent(
        base_url=base_url,
        pool=pool,
        save_dir=save_dir,
        workspace=tmp_path,
        tools=[make_tool("alpha", "ALPHA_7")],
    )
    sibling_b = build_agent(
        base_url=base_url,
        pool=pool,
        save_dir=save_dir,
        workspace=tmp_path,
        tools=[make_tool("beta", "BETA_8")],
    )
    for agent in (parker, sibling_a, sibling_b):
        await agent.__aenter__()

    reader = None
    try:
        assert pool.stats()["processes"] == 1, "all three must share a process"

        async def drain():
            async for _ in parker.conversation.receive_steps():
                pass

        await parker.conversation.send("What is Ada's favourite colour? Use the tool.")
        reader = asyncio.create_task(drain())
        await asyncio.wait_for(parked.wait(), timeout=120)
        assert not never.done()

        # The gate: with one conversation parked indefinitely, the others must
        # still complete full turns on the same process.
        results = await asyncio.wait_for(
            asyncio.gather(
                run_turn(sibling_a, "What is the alpha code? Use your tool."),
                run_turn(sibling_b, "What is the beta code? Use your tool."),
            ),
            timeout=180,
        )
        assert "ALPHA_7" in results[0], f"sibling A blocked behind the park: {results[0]!r}"
        assert "BETA_8" in results[1], f"sibling B blocked behind the park: {results[1]!r}"
        assert parked.is_set() and not never.done(), "the park must still be held"
    finally:
        if reader is not None:
            reader.cancel()
            try:
                await reader
            except (asyncio.CancelledError, Exception):
                pass
        if not never.done():
            never.set_result("octarine")
        for agent in (sibling_a, sibling_b, parker):
            try:
                await agent.__aexit__(None, None, None)
            except Exception:
                pass


# ----------------------------------------------------------------------
# Cold resume and leaks
# ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cold_resume_rehydrates_history_on_a_pooled_conversation(
    base_url, pool, tmp_path
):
    """Resume must work when the conversation lives on a shared process.

    Exercises the ``initial_history`` rehydration in ``PooledStrategy``, which
    fresh-conversation tests cannot reach.
    """
    from google.antigravity import types as ag_types

    save_dir = tmp_path / "save"
    first = build_agent(
        base_url=base_url,
        pool=pool,
        save_dir=save_dir,
        workspace=tmp_path,
        instructions="Answer in one short sentence. Remember what the user tells you.",
    )
    await first.__aenter__()
    try:
        await run_turn(first, "Remember this: my passphrase is octarine.")
        conversation_id = first.conversation_id
        assert conversation_id
    finally:
        await first.__aexit__(None, None, None)

    from google.antigravity import Agent, CapabilitiesConfig
    from google.antigravity.hooks import policy

    from ag_ui_antigravity.agent import _PooledResumableOpenAIConfig

    resumed = Agent(
        _PooledResumableOpenAIConfig(
            model=MODEL,
            base_url=base_url,
            harness_pool=pool,
            save_dir=str(save_dir),
            workspaces=[str(tmp_path)],
            system_instructions="Answer in one short sentence.",
            capabilities=CapabilitiesConfig(enable_subagents=False),
            policies=[policy.allow_all()],
            conversation_id=conversation_id,
            session_continuation_mode=ag_types.SessionContinuationMode.CREATE_OR_RESUME,
        )
    )
    await resumed.__aenter__()
    try:
        assert resumed.conversation.history, "resume returned no prior history"
        text = await run_turn(resumed, "What is my passphrase?")
        assert "octarine" in text.lower(), f"cold resume lost the history: {text!r}"
    finally:
        await resumed.__aexit__(None, None, None)


@pytest.mark.asyncio
async def test_adapter_shares_one_process_across_threads(base_url, tmp_path):
    """End-to-end through ``AntigravityAgent.run()`` -- the path the dojo uses.

    Everything above drives the pooled configs directly. This checks the whole
    adapter: two AG-UI threads, one harness process, correct terminal events.
    """
    from ag_ui.core import EventType, RunAgentInput, UserMessage

    from ag_ui_antigravity import AntigravityAgent

    adapter = AntigravityAgent(
        model=MODEL,
        base_url=base_url,
        save_dir=str(tmp_path / "save"),
        workspaces=[str(tmp_path)],
        system_instructions="Reply with exactly the word PONG.",
        enable_frontend_tools=False,
        enable_ask_question=False,
        max_conversations_per_process=4,
    )
    try:
        for thread in ("thread-one", "thread-two"):
            events = [
                event
                async for event in adapter.run(
                    RunAgentInput(
                        thread_id=thread,
                        run_id=f"run-{thread}",
                        state={},
                        messages=[UserMessage(id="m1", role="user", content="ping")],
                        tools=[],
                        context=[],
                        forwarded_props={},
                    )
                )
            ]
            kinds = [e.type for e in events]
            assert kinds[0] == EventType.RUN_STARTED
            assert kinds[-1] == EventType.RUN_FINISHED, (
                f"{thread} did not finish cleanly: {kinds}"
            )

        assert adapter.harness_pool.stats()["processes"] == 1, (
            "two AG-UI threads must share one harness process"
        )
        assert adapter.harness_pool.stats()["conversations"] == 2
    finally:
        await adapter.close()

    assert adapter.harness_pool.stats()["processes"] == 0, (
        "close() must tear the pool down"
    )


@pytest.mark.asyncio
async def test_churn_leaves_no_harness_processes(base_url, tmp_path):
    """Sessions come and go; processes must not accumulate."""
    from ag_ui_antigravity.harness_pool import HarnessPool

    before = set(harness_pids())
    churn_pool = HarnessPool(
        max_conversations_per_process=2, idle_grace_seconds=0.5
    )
    save_dir = tmp_path / "save"
    try:
        for _ in range(6):
            agent = build_agent(
                base_url=base_url,
                pool=churn_pool,
                save_dir=save_dir,
                workspace=tmp_path,
            )
            await agent.__aenter__()
            await agent.__aexit__(None, None, None)
        # Give the reaper a couple of cycles.
        await asyncio.sleep(2.0)
        assert churn_pool.stats()["processes"] == 0
    finally:
        await churn_pool.shutdown()

    await asyncio.sleep(1.0)
    leaked = set(harness_pids()) - before
    assert not leaked, f"leaked harness processes: {leaked}"


@pytest.mark.asyncio
async def test_a_thread_recovers_after_its_harness_dies(base_url, tmp_path):
    """A crashed harness must not wedge the thread forever.

    A conversation is pinned to one process for life, so when that process dies
    the session is unusable. Before this was handled, the run after the failing
    one did not merely error -- it hung on a socket nobody would ever answer,
    holding `session.lock`. `_expired()` returns False while the lock is held,
    so the session could never be swept either: one crash killed the thread for
    the lifetime of the server and leaked its slot against `max_sessions`.

    Note the pre-crash history does not survive, and that is upstream: the
    harness writes trajectories through SQLite's WAL and reopens them with
    `immutable=1`, which ignores WAL files, so a killed process leaves an
    empty-looking conversation behind.
    """
    from ag_ui.core import EventType, RunAgentInput, UserMessage

    from ag_ui_antigravity import AntigravityAgent

    adapter = AntigravityAgent(
        model=MODEL,
        base_url=base_url,
        save_dir=str(tmp_path / "save"),
        workspaces=[str(tmp_path)],
        system_instructions="Reply with exactly the word PONG.",
        enable_frontend_tools=False,
        enable_ask_question=False,
    )
    thread = "crash-recovery"

    async def turn(run_id):
        events = [
            e
            async for e in adapter.run(
                RunAgentInput(
                    thread_id=thread, run_id=run_id, state={},
                    messages=[UserMessage(id=run_id, role="user", content="ping")],
                    tools=[], context=[], forwarded_props={},
                )
            )
        ]
        return events[-1].type

    try:
        assert await turn("r1") == EventType.RUN_FINISHED

        process = next(iter(adapter.harness_pool._processes.values()))[0]
        process._process.kill()
        await asyncio.wait_for(process.dead.wait(), timeout=10)

        # The run that meets the corpse reports it rather than hanging.
        assert await asyncio.wait_for(turn("r2"), timeout=60) == EventType.RUN_ERROR

        # THE REGRESSION: this one used to hang forever.
        assert await asyncio.wait_for(turn("r3"), timeout=120) == (
            EventType.RUN_FINISHED
        ), "the thread did not recover after its harness died"
        assert adapter.harness_pool.stats()["processes"] == 1
    finally:
        await adapter.close()
