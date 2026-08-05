"""Per-thread isolation of CrewAI memory (crew-level and agent-level).

Everything here runs OFFLINE against a real ``Crew(memory=True)`` / a real
``Agent`` with its own ``Memory``: a fake embedding function stands in for
OpenAI, and every write supplies an explicit scope / categories / importance,
which is the condition under which crewai's ``EncodingFlow`` skips its LLM
analysis step. The only thing mocked is the embedder, so the store, the scope
arithmetic and the recall path are all real.

``Agent(memory=True)`` builds its Memory with crewai's DEFAULT embedder, which
needs a live API key the moment anything is written. Behavioural tests therefore
hand the agent an explicit ``Memory(embedder=<deterministic>)`` -- the same
object ``memory=True`` would have produced, minus the network. Constructing
``Agent(memory=True)`` is itself offline (the embedder is resolved lazily), so
the reported shape is still asserted directly, structurally.

The seam under test is the one the FastAPI endpoints use: copy the flow for this
request, then scope the copy's memory to the request's ``threadId``.
"""

import copy
import hashlib
import logging

import pytest
from crewai import Agent, Crew, Flow, Process, Task
from crewai.flow import start
from crewai.memory.unified_memory import Memory
from chromadb.api.types import EmbeddingFunction as _ChromaEmbeddingFunction
from crewai.rag.embeddings.providers.custom.embedding_callable import (
    CustomEmbeddingFunction as _CrewEmbeddingFunction,
)

from ag_ui_crewai import _memory as memory_module
from ag_ui_crewai._memory import apply_thread_memory_scope, thread_scope_path
from ag_ui_crewai.endpoint import _copy_flow


class _DeterministicEmbedder(_CrewEmbeddingFunction, _ChromaEmbeddingFunction):
    """Offline embedder: the first 16 bytes of a SHA-256 digest, scaled to [0, 1].

    crewai validates the ``custom`` embedder spec against chromadb's
    ``EmbeddingFunction`` and then against its own ``CustomEmbeddingFunction``,
    so the class has to satisfy both.
    """

    def __init__(self):
        # chromadb warns when an embedding function omits ``__init__``.
        pass

    def __call__(self, input):  # noqa: A002 - the upstream parameter is named ``input``
        return [
            [byte / 255.0 for byte in hashlib.sha256(text.encode()).digest()[:16]]
            for text in input
        ]


_EMBEDDER_SPEC = {
    "provider": "custom",
    "config": {"embedding_callable": _DeterministicEmbedder},
}


def _remember(view, content):
    """Write through a ``Memory`` or ``MemoryScope`` without invoking an LLM."""
    return view.remember(
        content, scope="/facts", categories=["fact"], importance=0.9
    )


def _recall(view, query):
    return [match.record.content for match in view.recall(query, depth="shallow")]


@pytest.fixture
def memory_crew(tmp_path, monkeypatch):
    """A real ``Crew(memory=True)`` whose store lives under ``tmp_path``.

    ``CREWAI_STORAGE_DIR`` is read when the storage backend is CONSTRUCTED, which
    happens inside ``Crew(...)`` via the ``create_crew_memory`` model validator,
    so setting it here (before the crew is built) is early enough. It must be
    absolute; see the note in ``conftest.py``.
    """
    monkeypatch.setenv("CREWAI_STORAGE_DIR", str(tmp_path / "crewai-store"))
    agent = Agent(role="helper", goal="help", backstory="b", llm="gpt-4o-mini")
    task = Task(description="d", expected_output="e", agent=agent)
    return Crew(
        name="support-crew",
        agents=[agent],
        tasks=[task],
        memory=True,
        embedder=_EMBEDDER_SPEC,
    )


class _CrewHoldingFlow(Flow):
    """Minimal stand-in for ``ChatWithCrewFlow``: a flow with a ``crew`` attribute.

    ``ChatWithCrewFlow.__init__`` issues a live LLM call to generate its chat
    inputs, so it cannot be constructed offline. The only property this seam cares
    about is the one reproduced here: a crew reachable as a flow attribute, shared
    by every request because the flow is cached per endpoint.
    """

    def __init__(self, crew):
        super().__init__()
        self.crew = crew

    @start()
    def go(self):  # pragma: no cover - never kicked off in these tests
        return "ok"


@pytest.fixture
def crew_flow(memory_crew):
    return _CrewHoldingFlow(memory_crew)


def _serve(flow, thread_id):
    """Do to ``flow`` exactly what an endpoint does at the start of a request."""
    flow_copy = _copy_flow(flow)
    apply_thread_memory_scope(flow_copy, thread_id)
    return flow_copy


@pytest.fixture(autouse=True)
def _reset_degrade_warning():
    """Un-latch the one-shot degradation warning between tests."""
    memory_module._DEGRADE_WARNED = False
    yield
    memory_module._DEGRADE_WARNED = False


# ---------------------------------------------------------------------------
# The reported bug
# ---------------------------------------------------------------------------


def test_two_threads_cannot_read_each_others_memory(crew_flow):
    """The reported leak: chat B must not see what chat A remembered."""
    run_a = _serve(crew_flow, "thread-A")
    _remember(run_a.crew._memory, "THREAD-A-SECRET: the user's name is Ada")

    run_b = _serve(crew_flow, "thread-B")

    assert _recall(run_b.crew._memory, "what is the user's name") == []
    # ...and A did not lose its own memory in the process.
    assert any(
        "THREAD-A-SECRET" in content
        for content in _recall(run_a.crew._memory, "what is the user's name")
    )


def test_writes_from_both_threads_stay_separated(crew_flow):
    """Symmetry: neither direction leaks once both threads have written."""
    run_a = _serve(crew_flow, "thread-A")
    run_b = _serve(crew_flow, "thread-B")

    _remember(run_a.crew._memory, "A-ONLY: the favourite colour is teal")
    _remember(run_b.crew._memory, "B-ONLY: the favourite colour is amber")

    assert _recall(run_a.crew._memory, "favourite colour") == [
        "A-ONLY: the favourite colour is teal"
    ]
    assert _recall(run_b.crew._memory, "favourite colour") == [
        "B-ONLY: the favourite colour is amber"
    ]


def test_one_thread_keeps_its_memory_across_sequential_runs(crew_flow):
    """Isolation must not degenerate into amnesia: a thread still has a history."""
    first_run = _serve(crew_flow, "thread-A")
    _remember(first_run.crew._memory, "REMEMBERED: the deploy target is staging")

    second_run = _serve(crew_flow, "thread-A")
    third_run = _serve(crew_flow, "thread-A")

    assert _recall(second_run.crew._memory, "deploy target") == [
        "REMEMBERED: the deploy target is staging"
    ]
    assert _recall(third_run.crew._memory, "deploy target") == [
        "REMEMBERED: the deploy target is staging"
    ]


# ---------------------------------------------------------------------------
# Race safety: the template crew is shared across concurrent requests
# ---------------------------------------------------------------------------


def test_shared_template_crew_is_never_mutated(crew_flow):
    """Scoping must not re-point the crew every other in-flight request holds."""
    template_crew = crew_flow.crew
    template_memory = template_crew._memory

    run = _serve(crew_flow, "thread-A")

    assert crew_flow.crew is template_crew
    assert template_crew._memory is template_memory
    assert type(template_memory).__name__ == "Memory"
    # The request got its own crew view carrying a scoped memory.
    assert run.crew is not template_crew
    assert type(run.crew._memory).__name__ == "MemoryScope"


def test_concurrent_requests_get_independent_scopes(crew_flow):
    """Two overlapping requests must not clobber one another's scope."""
    run_a = _serve(crew_flow, "thread-A")
    run_b = _serve(crew_flow, "thread-B")

    assert run_a.crew is not run_b.crew
    assert run_a.crew._memory.root_path != run_b.crew._memory.root_path
    # Both views still share the one physical store; only the namespace differs.
    assert run_a.crew._memory._memory is run_b.crew._memory._memory


def test_scoped_view_changes_nothing_but_the_memory(crew_flow):
    """The crew, agent and task views differ from the originals only in memory.

    The agents and tasks are per-request views (see
    ``test_the_shared_agents_and_tasks_are_never_mutated`` for why), but they are
    still equal to the originals field-for-field, and everything hanging off them
    -- tools, LLM, knowledge -- is the same object.
    """
    run = _serve(crew_flow, "thread-A")

    assert run.crew.name == crew_flow.crew.name
    assert run.crew.agents == crew_flow.crew.agents
    assert run.crew.tasks == crew_flow.crew.tasks
    assert run.crew.agents[0].llm is crew_flow.crew.agents[0].llm
    assert run.crew.agents[0].tools is crew_flow.crew.agents[0].tools


# ---------------------------------------------------------------------------
# Agent-level memory: ``Agent(memory=...)`` beats the crew's, so it needs its own
# scope. crewai's executor resolves ``agent.memory or crew._memory``.
# ---------------------------------------------------------------------------


def _offline_memory():
    """The ``Memory`` ``Agent(memory=True)`` builds, minus the OpenAI embedder."""
    return Memory(embedder=_EMBEDDER_SPEC)


@pytest.fixture
def agent_memory_flow(tmp_path, monkeypatch):
    """A crew whose AGENT carries its own memory (the crew's is off)."""
    monkeypatch.setenv("CREWAI_STORAGE_DIR", str(tmp_path / "crewai-store"))
    agent = Agent(
        role="helper",
        goal="help",
        backstory="b",
        llm="gpt-4o-mini",
        memory=_offline_memory(),
    )
    task = Task(description="d", expected_output="e", agent=agent)
    crew = Crew(name="support-crew", agents=[agent], tasks=[task])
    return _CrewHoldingFlow(crew)


def _executing_agent(run):
    """The agent crewai will actually run the first task with."""
    return run.crew._get_agent_to_use(run.crew.tasks[0])


def test_two_threads_cannot_read_each_others_agent_memory(agent_memory_flow):
    """The same leak one level down: an agent's own memory must be per-thread."""
    run_a = _serve(agent_memory_flow, "thread-A")
    _remember(_executing_agent(run_a).memory, "AGENT-A-SECRET: the user is Ada")

    run_b = _serve(agent_memory_flow, "thread-B")

    assert _recall(_executing_agent(run_b).memory, "who is the user") == []
    assert _recall(_executing_agent(run_a).memory, "who is the user") == [
        "AGENT-A-SECRET: the user is Ada"
    ]


def test_one_thread_keeps_its_agent_memory_across_sequential_runs(agent_memory_flow):
    """Isolation must not degenerate into amnesia at the agent level either."""
    first_run = _serve(agent_memory_flow, "thread-A")
    _remember(_executing_agent(first_run).memory, "REMEMBERED: the target is staging")

    second_run = _serve(agent_memory_flow, "thread-A")

    assert _recall(_executing_agent(second_run).memory, "the target") == [
        "REMEMBERED: the target is staging"
    ]


def test_the_task_executes_with_the_scoped_agent(agent_memory_flow):
    """The scoped agent has to be the one crewai picks, or the scoping is inert.

    crewai resolves the executing agent from ``task.agent``, NOT from
    ``Crew.agents``, so a task left pointing at the shared agent would run with
    the shared, unscoped memory however well-scoped the roster is.
    """
    run = _serve(agent_memory_flow, "thread-A")

    assert _executing_agent(run) is run.crew.agents[0]
    assert type(_executing_agent(run).memory).__name__ == "MemoryScope"


def test_an_agent_built_with_memory_true_is_scoped(tmp_path, monkeypatch):
    """The reported shape, asserted verbatim: ``Agent(memory=True)``.

    Structural only -- ``memory=True`` resolves to a ``Memory`` on crewai's
    DEFAULT embedder, so writing through it would need a live API key.
    """
    monkeypatch.setenv("CREWAI_STORAGE_DIR", str(tmp_path / "crewai-store"))
    agent = Agent(role="helper", goal="help", backstory="b", llm="gpt-4o-mini", memory=True)
    task = Task(description="d", expected_output="e", agent=agent)
    flow = _CrewHoldingFlow(Crew(name="support-crew", agents=[agent], tasks=[task]))

    run_a = _serve(flow, "thread-A")
    run_b = _serve(flow, "thread-B")

    assert type(agent.memory).__name__ == "Memory"
    assert type(_executing_agent(run_a).memory).__name__ == "MemoryScope"
    assert (
        _executing_agent(run_a).memory.root_path
        != _executing_agent(run_b).memory.root_path
    )


def test_a_hierarchical_manager_agents_memory_is_scoped(tmp_path, monkeypatch):
    """Under the hierarchical process the executing agent is the MANAGER."""
    monkeypatch.setenv("CREWAI_STORAGE_DIR", str(tmp_path / "crewai-store"))
    manager = Agent(
        role="manager",
        goal="manage",
        backstory="b",
        llm="gpt-4o-mini",
        memory=_offline_memory(),
    )
    worker = Agent(role="helper", goal="help", backstory="b", llm="gpt-4o-mini")
    task = Task(description="d", expected_output="e", agent=worker)
    flow = _CrewHoldingFlow(
        Crew(
            name="support-crew",
            agents=[worker],
            tasks=[task],
            process=Process.hierarchical,
            manager_agent=manager,
        )
    )

    run_a = _serve(flow, "thread-A")
    _remember(_executing_agent(run_a).memory, "MANAGER-A: the budget is 40")

    run_b = _serve(flow, "thread-B")

    assert _executing_agent(run_a) is run_a.crew.manager_agent
    assert _recall(_executing_agent(run_b).memory, "the budget") == []
    assert type(manager.memory).__name__ == "Memory"


def test_a_standalone_agent_on_the_flow_is_scoped(tmp_path, monkeypatch):
    """An agent a flow drives directly, with no crew, is scoped too."""
    monkeypatch.setenv("CREWAI_STORAGE_DIR", str(tmp_path / "crewai-store"))
    agent = Agent(
        role="helper",
        goal="help",
        backstory="b",
        llm="gpt-4o-mini",
        memory=_offline_memory(),
    )

    class _AgentHoldingFlow(Flow):
        def __init__(self):
            super().__init__()
            self.agent = agent

        @start()
        def go(self):  # pragma: no cover - never kicked off
            return "ok"

    flow = _AgentHoldingFlow()
    run_a = _serve(flow, "thread-A")
    _remember(run_a.agent.memory, "SOLO-A: the room is 12B")

    run_b = _serve(flow, "thread-B")

    assert _recall(run_b.agent.memory, "which room") == []
    assert type(agent.memory).__name__ == "Memory"


def test_an_agent_without_its_own_memory_still_gets_the_scoped_crew(crew_flow):
    """Falling back to crew memory must reach THIS request's scoped crew.

    ``Crew.kickoff`` assigns ``agent.crew`` on every agent it is given, and the
    executor reads the crew's memory back off that attribute. Two concurrent
    requests sharing one agent object would leave the loser reading the winner's
    thread namespace, so each request gets its own agent view even when the agent
    has no memory of its own.
    """
    run_a = _serve(crew_flow, "thread-A")
    run_b = _serve(crew_flow, "thread-B")

    assert _executing_agent(run_a).memory is None
    assert _executing_agent(run_a) is not _executing_agent(run_b)
    assert _executing_agent(run_a) is not crew_flow.crew.agents[0]


def test_the_shared_agents_and_tasks_are_never_mutated(agent_memory_flow):
    """Nothing the concurrent requests share may be re-pointed."""
    template_crew = agent_memory_flow.crew
    template_agent = template_crew.agents[0]
    template_task = template_crew.tasks[0]
    template_memory = template_agent.memory

    run_a = _serve(agent_memory_flow, "thread-A")
    run_b = _serve(agent_memory_flow, "thread-B")

    assert template_agent.memory is template_memory
    assert type(template_memory).__name__ == "Memory"
    assert template_task.agent is template_agent
    assert template_crew.agents[0] is template_agent
    assert template_crew.tasks[0] is template_task
    # ...and the two requests hold independent scopes over the one store.
    memory_a = _executing_agent(run_a).memory
    memory_b = _executing_agent(run_b).memory
    assert memory_a.root_path != memory_b.root_path
    assert memory_a._memory is memory_b._memory is template_memory


def test_task_context_edges_point_at_this_requests_tasks(tmp_path, monkeypatch):
    """A copied task's ``context`` must name the copies, not the shared tasks.

    ``context`` names other Task OBJECTS, and crewai reads their ``.output`` to
    build the downstream prompt. Left pointing at the shared tasks, a downstream
    task would read an output this request never produced.
    """
    monkeypatch.setenv("CREWAI_STORAGE_DIR", str(tmp_path / "crewai-store"))
    agent = Agent(role="helper", goal="help", backstory="b", llm="gpt-4o-mini")
    first = Task(description="first", expected_output="e", agent=agent)
    second = Task(description="second", expected_output="e", agent=agent, context=[first])
    flow = _CrewHoldingFlow(
        Crew(
            name="support-crew",
            agents=[agent],
            tasks=[first, second],
            memory=True,
            embedder=_EMBEDDER_SPEC,
        )
    )

    run = _serve(flow, "thread-A")

    assert run.crew.tasks[1].context == [run.crew.tasks[0]]
    assert run.crew.tasks[1].context[0] is run.crew.tasks[0]
    assert second.context == [first]


def test_opt_out_leaves_agent_memory_shared(agent_memory_flow, monkeypatch):
    """``AGUI_CREWAI_THREAD_SCOPED_MEMORY=false`` disables agent scoping too."""
    monkeypatch.setenv("AGUI_CREWAI_THREAD_SCOPED_MEMORY", "false")

    run_a = _serve(agent_memory_flow, "thread-A")
    _remember(_executing_agent(run_a).memory, "SHARED: the office is in Lisbon")
    run_b = _serve(agent_memory_flow, "thread-B")

    assert _executing_agent(run_a) is agent_memory_flow.crew.agents[0]
    assert _recall(_executing_agent(run_b).memory, "where is the office") == [
        "SHARED: the office is in Lisbon"
    ]


# ---------------------------------------------------------------------------
# Fail-loud: a write that lands on a shared object must not be served
# ---------------------------------------------------------------------------


def test_a_write_through_to_the_shared_agent_fails_the_request(tmp_path, monkeypatch):
    """A copy that is not a copy must raise, not silently share one namespace."""
    monkeypatch.setenv("CREWAI_STORAGE_DIR", str(tmp_path / "crewai-store"))

    class _UncopyableAgent(Agent):
        def __copy__(self):
            return self

    agent = _UncopyableAgent(
        role="helper",
        goal="help",
        backstory="b",
        llm="gpt-4o-mini",
        memory=_offline_memory(),
    )
    task = Task(description="d", expected_output="e", agent=agent)
    flow = _CrewHoldingFlow(Crew(name="support-crew", agents=[agent], tasks=[task]))

    with pytest.raises(RuntimeError, match="mutated the SHARED .*Agent.memory"):
        _serve(flow, "thread-A")


def test_a_write_through_to_the_shared_task_fails_the_request(tmp_path, monkeypatch):
    """Same guarantee for tasks: ``task.agent`` is what selects the memory."""
    monkeypatch.setenv("CREWAI_STORAGE_DIR", str(tmp_path / "crewai-store"))

    class _UncopyableTask(Task):
        def __copy__(self):
            return self

    agent = Agent(role="helper", goal="help", backstory="b", llm="gpt-4o-mini")
    task = _UncopyableTask(description="d", expected_output="e", agent=agent)
    flow = _CrewHoldingFlow(
        Crew(
            name="support-crew",
            agents=[agent],
            tasks=[task],
            memory=True,
            embedder=_EMBEDDER_SPEC,
        )
    )

    with pytest.raises(RuntimeError, match="mutated the SHARED .*Task.agent"):
        _serve(flow, "thread-A")


# ---------------------------------------------------------------------------
# Scope-path derivation
# ---------------------------------------------------------------------------


def test_scope_path_is_derived_from_the_thread_id():
    path = thread_scope_path("Thread A")
    assert path.startswith("/thread/thread-a-")
    assert thread_scope_path("Thread A") == path


def test_scope_paths_differ_for_ids_that_sanitise_alike():
    """Sanitisation is lossy; the digest suffix is what keeps threads apart."""
    assert thread_scope_path("a/b") != thread_scope_path("a-b")
    assert thread_scope_path("x" * 200) != thread_scope_path("x" * 201)


def test_scope_path_survives_an_id_with_no_usable_characters():
    assert thread_scope_path("///").startswith("/thread/unknown-")


def test_two_threads_whose_ids_sanitise_alike_are_isolated(crew_flow):
    """The end-to-end consequence of the digest suffix."""
    run_slash = _serve(crew_flow, "tenant/7")
    run_dash = _serve(crew_flow, "tenant-7")

    _remember(run_slash.crew._memory, "SLASH-TENANT: quota is 40")

    assert _recall(run_dash.crew._memory, "quota") == []


# ---------------------------------------------------------------------------
# Opt-out
# ---------------------------------------------------------------------------


def test_opt_out_restores_the_shared_namespace(crew_flow, monkeypatch):
    """``AGUI_CREWAI_THREAD_SCOPED_MEMORY=false`` reinstates one namespace per crew."""
    monkeypatch.setenv("AGUI_CREWAI_THREAD_SCOPED_MEMORY", "false")

    run_a = _serve(crew_flow, "thread-A")
    _remember(run_a.crew._memory, "SHARED: the office is in Lisbon")
    run_b = _serve(crew_flow, "thread-B")

    assert run_a.crew is crew_flow.crew
    assert _recall(run_b.crew._memory, "where is the office") == [
        "SHARED: the office is in Lisbon"
    ]


def test_an_unrecognised_opt_out_value_keeps_isolation_on(crew_flow, monkeypatch):
    """A typo must not silently reopen the leak."""
    monkeypatch.setenv("AGUI_CREWAI_THREAD_SCOPED_MEMORY", "flase")

    run_a = _serve(crew_flow, "thread-A")
    _remember(run_a.crew._memory, "TYPO-GUARD: the office is in Lisbon")
    run_b = _serve(crew_flow, "thread-B")

    assert _recall(run_b.crew._memory, "where is the office") == []


# ---------------------------------------------------------------------------
# Degradation and no-ops
# ---------------------------------------------------------------------------


def test_a_crew_without_memory_is_left_untouched(tmp_path, monkeypatch):
    monkeypatch.setenv("CREWAI_STORAGE_DIR", str(tmp_path / "crewai-store"))
    agent = Agent(role="helper", goal="help", backstory="b", llm="gpt-4o-mini")
    task = Task(description="d", expected_output="e", agent=agent)
    crew = Crew(name="memoryless", agents=[agent], tasks=[task])
    flow = _CrewHoldingFlow(crew)

    run = _serve(flow, "thread-A")

    assert run.crew._memory is None


def test_a_missing_thread_id_leaves_the_crew_untouched(crew_flow):
    run = _serve(crew_flow, "")

    assert type(run.crew._memory).__name__ == "Memory"


def test_a_memory_without_the_view_api_degrades_with_one_warning(crew_flow, caplog):
    """No crash, no isolation, and exactly one warning per process."""

    class _LegacyMemory:
        """A memory object predating (or replacing) ``Memory.scope``."""

    unscopable_crew = copy.copy(crew_flow.crew)
    unscopable_crew.__pydantic_private__["_memory"] = _LegacyMemory()
    flow = _CrewHoldingFlow(unscopable_crew)

    with caplog.at_level(logging.WARNING, logger="ag_ui_crewai._memory"):
        first = _serve(flow, "thread-A")
        second = _serve(flow, "thread-B")

    assert isinstance(first.crew._memory, _LegacyMemory)
    assert isinstance(second.crew._memory, _LegacyMemory)
    warnings = [
        record for record in caplog.records
        if "PER-THREAD MEMORY ISOLATION IS NOT ACTIVE" in record.message
    ]
    assert len(warnings) == 1


def test_a_failing_scope_factory_degrades_instead_of_failing_the_run(
    crew_flow, caplog
):
    """A crewai-side error while building the view must not kill the chat."""

    class _AngryMemory:
        def scope(self, path):
            raise RuntimeError("boom")

    angry_crew = copy.copy(crew_flow.crew)
    angry_crew.__pydantic_private__["_memory"] = _AngryMemory()
    flow = _CrewHoldingFlow(angry_crew)

    with caplog.at_level(logging.WARNING, logger="ag_ui_crewai._memory"):
        run = _serve(flow, "thread-A")

    assert isinstance(run.crew._memory, _AngryMemory)
    assert any("could not scope crew memory" in r.message for r in caplog.records)


# ---------------------------------------------------------------------------
# Endpoint wiring
# ---------------------------------------------------------------------------


class _InertFlow:
    """A flow-shaped object that neither runs nor supports StreamFrames."""

    async def kickoff_async(self, inputs=None):  # pragma: no cover - never awaited
        return "ok"


@pytest.mark.parametrize("factory", ["flow", "crew"])
async def test_both_endpoint_factories_scope_memory_before_running(
    factory, monkeypatch
):
    """Both endpoints scope the request's flow copy, and do it BEFORE a driver runs.

    Scoping happens in the endpoint body, ahead of ``_run_flow_stream``'s choice
    between the legacy ``kickoff_async`` driver and the ``astream`` StreamFrame
    driver, so it cannot be dead code on one of them.
    """
    from types import SimpleNamespace

    from ag_ui.core import RunAgentInput
    from fastapi import FastAPI

    from ag_ui_crewai import endpoint as ep

    calls = []
    monkeypatch.setattr(
        ep,
        "apply_thread_memory_scope",
        lambda flow_copy, thread_id: calls.append((flow_copy, thread_id)),
    )

    app = FastAPI()
    if factory == "flow":
        ep.add_crewai_flow_fastapi_endpoint(app, _InertFlow(), path="/run")
    else:
        monkeypatch.setattr(
            ep, "ChatWithCrewFlow", lambda *_a, **_kw: _InertFlow()
        )
        ep.add_crewai_crew_fastapi_endpoint(app, object(), path="/run")

    route = next(r for r in app.router.routes if getattr(r, "path", None) == "/run")
    request = SimpleNamespace(headers=SimpleNamespace(get=lambda *_a, **_kw: None))
    await route.endpoint(
        RunAgentInput(
            thread_id="thread-A",
            run_id="run-1",
            state={},
            messages=[],
            tools=[],
            context=[],
            forwarded_props={},
        ),
        request,
    )

    assert len(calls) == 1
    scoped_flow, thread_id = calls[0]
    assert thread_id == "thread-A"
    assert isinstance(scoped_flow, _InertFlow)
