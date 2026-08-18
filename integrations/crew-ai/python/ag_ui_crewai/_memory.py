"""Per-thread isolation of CrewAI memory.

The bug. A crew served with ``Crew(memory=True)`` leaks remembered
facts between chats. The bridge isolates requests by copying the flow, but that
copy does not touch memory: crewai 1.x builds ONE ``Memory`` over ONE on-disk
store, namespaced by a ``root_scope`` string that ``Crew.create_crew_memory``
derives from the CREW NAME. Every request to a given endpoint therefore reads
and writes the same namespace. Passing ``inputs["id"] = thread_id`` does not
help; that scopes crewai's flow-state persistence, a different subsystem.
``Agent(memory=True)`` has the same shape one level down: the agent builds its
OWN ``Memory``, and the executor prefers it over the crew's
(``memory = agent.memory or crew._memory`` in ``BaseAgentExecutor``), so an
agent-level memory bypasses a crew-level fix entirely.

The fix. Before the run starts, give THIS request's flow copy a crew whose
memory -- and whose agents' memories -- are ``MemoryScope`` views rooted at a
path derived from the AG-UI ``threadId``. Reads and writes through such a view
are confined to the thread's namespace and below, so thread A and thread B are
mutually invisible while each still sees its own history across sequential runs.
One physical store, no directory sprawl, and both ``Crew._memory`` and
``Agent.memory`` are typed ``Memory | MemoryScope | MemorySlice`` upstream, so a
view is a supported thing to hand them rather than a hack.

Three constraints shape the implementation:

* **The template crew is shared across concurrent requests, and so are its
  agents and tasks.** ``ChatWithCrewFlow`` is built once per endpoint and cached,
  and ``_copyutil.safe_deepcopy`` pins the uncopyable crew BY REFERENCE, so every
  in-flight request holds the same live ``Crew``, ``Agent``s and ``Task``s.
  Re-pointing any of those shared objects per request would be a data race. So
  nothing shared is ever mutated: we build per-request shallow VIEWS (crew,
  agents, tasks), point only the views at the thread scope, and swap the crew
  view onto the per-request flow copy. ``_verify_template_untouched`` fails the
  request loudly if a future refactor ever writes through to a shared object.
* **The memory has to reach the object that actually executes.** crewai resolves
  the executing agent from ``task.agent`` (or ``Crew.manager_agent`` under the
  hierarchical process), NOT from ``Crew.agents``, and it reaches the crew's
  memory through ``agent.crew`` -- which ``Crew.kickoff`` ASSIGNS on each agent
  it is given. Scoping an agent view that no task points at would therefore
  scope nothing, and leaving the shared agents in place would let one request's
  ``agent.crew = <crew view>`` decide which thread's namespace another request
  reads. So the whole executed graph is re-pointed together: agent views on the
  crew view, and task views whose ``agent`` is the matching agent view.
* **There are two run paths.** The legacy ``kickoff_async`` driver and the
  ``astream`` StreamFrame driver both read the crew off the flow copy, so scoping
  the flow copy before either driver is selected covers both.

Capability-detected, never version-gated: a crewai build without the unified
``Memory.scope`` view API degrades to "isolation not active" plus one warning
rather than crashing.
"""

from __future__ import annotations

import copy
import hashlib
import logging
import re
from typing import Any

# ``_Crew`` / ``_Agent`` / ``sanitize_scope_name`` are resolved in
# ``_capabilities`` with every other crewai symbol the bridge depends on, rather
# than re-derived here with a parallel ``getattr`` chain.
from ._capabilities import (
    CAPABILITIES,
    _Agent,
    _Crew,
    sanitize_scope_name as _crewai_sanitize_scope_name,
)
from ._config import resolve_thread_scoped_memory

_LOGGER = logging.getLogger(__name__)

# Namespace the per-thread scopes live under, relative to whatever root scope the
# crew already carries. A crew named "support" therefore stores thread A's
# memories under ``/crew/support/thread/<segment>`` and keeps crewai's own
# hierarchy intact above it.
_THREAD_SCOPE_ROOT = "/thread"

# Upper bound on the readable part of a scope segment. Thread ids are usually
# UUIDs, but nothing stops a client sending a very long one, and the segment ends
# up in a stored scope path.
_MAX_READABLE_SEGMENT = 64

# Length of the digest suffix, in hex characters. 16 hex chars is 64 bits, which
# makes an accidental collision between two live threads unreachable in practice.
_DIGEST_CHARS = 16

# Emitted at most once per process: an operator whose crewai lacks the view API
# needs to hear that isolation is off, but not once per request.
_DEGRADE_WARNED = False

# Raised when a write meant for a per-request view lands on the shared template
# instead. That is strictly worse than the bug this module fixes -- it would hand
# every other in-flight request THIS thread's namespace -- so it fails the run
# rather than degrading quietly.
_SHARED_MUTATION = (
    "ag-ui-crewai: building the per-thread memory views mutated the SHARED "
    "{what} instead of the per-request copy. Refusing to continue; concurrent "
    "requests would read one another's memory."
)


def _fallback_sanitize_scope_name(name: str) -> str:
    """Stand-in for ``crewai.memory.utils.sanitize_scope_name``.

    Same normalisation (lowercase, non ``[a-z0-9_-]`` to a hyphen, collapse and
    strip hyphens) so a build that does not expose crewai's helper still produces
    a segment shaped like the crew-name segment above it.
    """
    if not name:
        return "unknown"
    name = re.sub(r"[^a-z0-9_-]", "-", name.lower().strip())
    name = re.sub(r"-+", "-", name).strip("-")
    return name or "unknown"


def thread_scope_path(thread_id: str) -> str:
    """Return the scope path that isolates ``thread_id``.

    Shape: ``/thread/<readable>-<digest>``. The readable half is the sanitized
    thread id, so a stored scope tree stays diagnosable by eye. The digest half
    is what actually guarantees isolation: sanitisation is lossy (``a/b`` and
    ``a-b`` both normalise to ``a-b``, and a long id is truncated), so two
    distinct threads could otherwise collapse onto one namespace and leak into
    each other, which is the exact bug this module exists to prevent. The digest
    is taken over the RAW id and is therefore injective in practice.
    """
    raw = str(thread_id)
    sanitize = _crewai_sanitize_scope_name or _fallback_sanitize_scope_name
    try:
        readable = sanitize(raw)
    except Exception:  # noqa: BLE001 - a surprising crewai helper must not fail the run
        readable = _fallback_sanitize_scope_name(raw)
    readable = readable[:_MAX_READABLE_SEGMENT].strip("-") or "unknown"
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:_DIGEST_CHARS]
    return f"{_THREAD_SCOPE_ROOT}/{readable}-{digest}"


def _warn_isolation_unavailable(memory: Any, what: str) -> None:
    """Say once, loudly, that this deployment is running without isolation.

    Two causes worth distinguishing: the installed crewai has no unified memory
    view API at all, or it does but this particular crew (or agent) was handed a
    memory object that is not one of crewai's view types. The remedy differs.
    """
    global _DEGRADE_WARNED  # pylint: disable=global-statement
    if _DEGRADE_WARNED:
        return
    _DEGRADE_WARNED = True
    if not CAPABILITIES.memory_scope_available:
        cause = (
            f"crewai {CAPABILITIES.crewai_version} does not expose the unified "
            "memory view API (crewai.memory.unified_memory.Memory.scope)"
        )
        remedy = "Upgrade crewai, or disable memory"
    else:
        cause = (
            f"this {what}'s memory is a {type(memory).__name__}, which has no "
            "scope() view factory"
        )
        remedy = (
            f"Pass the {what} a crewai Memory (or an already-scoped view), or "
            "disable memory"
        )
    _LOGGER.warning(
        "ag-ui-crewai: %s memory is enabled but %s, so PER-THREAD MEMORY "
        "ISOLATION IS NOT ACTIVE: every AG-UI threadId served by this endpoint "
        "shares one memory namespace and can read another chat's remembered "
        "facts. %s. Further occurrences are silenced.",
        what,
        cause,
        remedy,
    )


def _attribute_containers(obj: Any) -> list[dict]:
    """Return the mutable attribute stores of ``obj`` worth scanning.

    Pydantic keeps declared fields in ``__dict__`` and private attributes in
    ``__pydantic_private__``; a crewai ``Flow`` holds an assigned ``self.crew`` in
    the former. Writing back through these dicts (rather than ``setattr``) is the
    same approach ``_copyutil.rebind_bound_methods`` takes, and for the same
    reason: ``BaseModel.__setattr__`` refuses or reroutes assignments that are not
    declared fields.
    """
    containers = []
    for candidate in (
        getattr(obj, "__dict__", None),
        getattr(obj, "__pydantic_private__", None),
    ):
        if isinstance(candidate, dict):
            containers.append(candidate)
    return containers


def _write_attr(obj: Any, name: str, value: Any) -> None:
    """Point ``obj.name`` at ``value``, going through the attribute store.

    Pydantic keeps declared fields (``Agent.memory``, ``Task.agent``,
    ``Crew.agents``) in ``__dict__`` and private attributes (``Crew._memory``) in
    ``__pydantic_private__``; writing back through whichever dict already holds
    the name avoids ``BaseModel.__setattr__`` refusing or re-validating the
    assignment. Only ever called on a ``copy.copy`` VIEW, which owns fresh
    mappings, so the shared original is unaffected.
    """
    private = getattr(obj, "__pydantic_private__", None)
    if isinstance(private, dict) and name in private:
        private[name] = value
        return
    fields = getattr(obj, "__dict__", None)
    if isinstance(fields, dict) and name in fields:
        fields[name] = value
        return
    setattr(obj, name, value)


def _has_memory(owner: Any) -> bool:
    """True when ``owner`` carries a memory object of its own.

    ``True`` / ``False`` do not count: crewai's validators turn those into a
    ``Memory`` / ``None`` at construction, so a leftover bool is a
    not-yet-validated value, not a memory to scope.
    """
    memory = getattr(owner, "memory", None)
    return memory is not None and not isinstance(memory, bool)


def _scoped_memory(memory: Any, scope_path: str, what: str) -> Any | None:
    """Return a ``scope_path``-rooted view of ``memory``, or ``None``.

    ``None`` covers all three "nothing to do here" cases: no memory, a memory
    object this crewai build cannot make a view of (warned about once), and a
    view factory that raised (warned about per occurrence, because a crewai-side
    error is worth seeing every time it happens).
    """
    if memory is None or isinstance(memory, bool):
        return None

    scope_factory = getattr(memory, "scope", None)
    if not callable(scope_factory):
        _warn_isolation_unavailable(memory, what)
        return None

    try:
        return scope_factory(scope_path)
    except Exception as exc:  # noqa: BLE001 - never fail a run over memory scoping
        _LOGGER.warning(
            "ag-ui-crewai: could not scope %s memory to %s (%s: %s); this run "
            "shares that memory's namespace with other threads.",
            what,
            scope_path,
            type(exc).__name__,
            exc,
        )
        return None


def _thread_scoped_agent(agent: Any, scope_path: str) -> Any:
    """Return a per-request view of ``agent``, its own memory scoped if it has one.

    Always a view, even for an agent with no memory of its own: ``Crew.kickoff``
    ASSIGNS ``agent.crew`` (and ``agent.agent_executor``) on every agent it runs,
    and the executor reads the crew's memory back off that attribute. Handing two
    concurrent requests the same agent object would let the later one decide
    which thread's namespace the earlier one reads.
    """
    memory = getattr(agent, "memory", None)
    view = copy.copy(agent)
    scoped_memory = _scoped_memory(memory, scope_path, "agent")
    if scoped_memory is not None:
        _write_attr(view, "memory", scoped_memory)
        if getattr(agent, "memory", None) is not memory:
            raise RuntimeError(_SHARED_MUTATION.format(what="Agent.memory"))
    return view


def _thread_scoped_tasks(tasks: Any, agent_views: dict[int, Any]) -> list[Any] | None:
    """Return per-request task views pointing at ``agent_views``, or ``None``.

    crewai picks the executing agent off ``task.agent``, so a task left pointing
    at the shared agent would bypass the scoped view entirely. ``task.context``
    is remapped alongside, because it names OTHER task objects whose ``output``
    this run fills in -- left pointing at the shared tasks, a downstream task
    would read an output this request never produced.
    """
    if not isinstance(tasks, (list, tuple)):
        return None

    views = [copy.copy(task) for task in tasks]
    by_task = {id(task): view for task, view in zip(tasks, views)}
    for task, view in zip(tasks, views):
        agent_view = agent_views.get(id(getattr(task, "agent", None)))
        if agent_view is not None:
            _write_attr(view, "agent", agent_view)
        context = getattr(task, "context", None)
        if isinstance(context, list) and any(id(t) in by_task for t in context):
            _write_attr(view, "context", [by_task.get(id(t), t) for t in context])
    return views


def _verify_template_untouched(crew: Any, before: dict[tuple[int, str], Any]) -> None:
    """Fail loudly if building the views wrote through to a shared object.

    ``before`` maps ``(id(shared object), attribute)`` to the value it held
    before the views were built. A mismatch means one of the writes landed on the
    template rather than on its copy, which under concurrency hands every other
    in-flight request THIS thread's namespace -- a worse leak than the one this
    module exists to fix, and one that would otherwise be silent.
    """
    for owner, attr in _template_attrs(crew):
        key = (id(owner), attr)
        if key in before and getattr(owner, attr, None) is not before[key]:
            raise RuntimeError(
                _SHARED_MUTATION.format(what=f"{type(owner).__name__}.{attr}")
            )


def _template_attrs(crew: Any):
    """Yield every ``(shared object, attribute)`` pair the view build must not touch."""
    yield crew, "_memory"
    yield crew, "agents"
    yield crew, "tasks"
    yield crew, "manager_agent"
    for agent in _crew_agents(crew):
        yield agent, "memory"
        yield agent, "crew"
    tasks = getattr(crew, "tasks", None)
    if isinstance(tasks, (list, tuple)):
        for task in tasks:
            yield task, "agent"
            yield task, "context"


def _crew_agents(crew: Any) -> list[Any]:
    """Every agent the crew can execute with: its roster plus the manager."""
    agents = getattr(crew, "agents", None)
    roster = list(agents) if isinstance(agents, (list, tuple)) else []
    manager = getattr(crew, "manager_agent", None)
    if manager is not None:
        roster.append(manager)
    return roster


def _thread_scoped_crew(crew: Any, scope_path: str) -> Any | None:
    """Return a shallow view of ``crew`` whose memory is scoped to ``scope_path``.

    ``None`` means "leave this crew alone": neither the crew nor any of its
    agents has memory to scope, or this crewai build cannot produce a view.

    The passed crew, its agents and its tasks are SHARED with every concurrent
    request and are never mutated -- ``copy.copy`` of a Pydantic model builds
    fresh ``__dict__`` / ``__pydantic_private__`` mappings, so pointing a view's
    attribute elsewhere leaves the original's alone. Everything below the views
    (tools, LLMs, knowledge, the underlying store, the save pool) stays shared,
    exactly as it already was before this module existed.
    """
    scoped_memory = _scoped_memory(getattr(crew, "_memory", None), scope_path, "crew")
    agents = _crew_agents(crew)
    if scoped_memory is None and not any(_has_memory(agent) for agent in agents):
        return None

    before = {(id(o), a): getattr(o, a, None) for o, a in _template_attrs(crew)}

    agent_views = {id(agent): _thread_scoped_agent(agent, scope_path) for agent in agents}

    crew_view = copy.copy(crew)
    if scoped_memory is not None:
        _write_attr(crew_view, "_memory", scoped_memory)
    roster = getattr(crew, "agents", None)
    if isinstance(roster, (list, tuple)):
        _write_attr(crew_view, "agents", [agent_views[id(a)] for a in roster])
    manager = getattr(crew, "manager_agent", None)
    if manager is not None:
        _write_attr(crew_view, "manager_agent", agent_views[id(manager)])
    task_views = _thread_scoped_tasks(getattr(crew, "tasks", None), agent_views)
    if task_views is not None:
        _write_attr(crew_view, "tasks", task_views)

    _verify_template_untouched(crew, before)
    return crew_view


def apply_thread_memory_scope(flow_copy: Any, thread_id: str | None) -> None:
    """Scope every crew and agent on ``flow_copy`` to ``thread_id``'s namespace.

    Called once per request, on the PER-REQUEST flow copy, before a run driver is
    selected -- so both the legacy ``kickoff_async`` path and the ``astream``
    StreamFrame path are covered.

    Scans the flow copy's own attributes for ``Crew`` instances (whose agents and
    tasks are scoped with them) and for standalone ``Agent`` instances, which a
    flow can drive directly through ``agent.kickoff()`` without a crew. That
    reaches the crew-serving endpoint's ``ChatWithCrewFlow.crew`` and whatever a
    user's ``Flow`` holds as an attribute. A crew or agent CONSTRUCTED INSIDE a
    flow method is not reachable from here and is not scoped; see the README for
    that limitation.

    Never raises for an environment reason: an unscopable memory degrades to the
    previous shared-namespace behaviour with a warning, because failing a chat
    outright is worse than the leak it would prevent.
    """
    if not resolve_thread_scoped_memory():
        return
    if not thread_id:
        # Nothing to derive a namespace from. Scoping every such request onto one
        # shared "unknown" namespace would isolate nothing while still hiding the
        # crew's own history, so leave the crew as-is.
        return
    if _Crew is None:  # pragma: no cover - crewai is a hard dependency
        return

    scope_path = thread_scope_path(thread_id)
    for container in _attribute_containers(flow_copy):
        for name, value in list(container.items()):
            if isinstance(value, _Crew):
                crew_view = _thread_scoped_crew(value, scope_path)
                if crew_view is not None:
                    container[name] = crew_view
            elif _Agent is not None and isinstance(value, _Agent) and _has_memory(value):
                agent_view = _thread_scoped_agent(value, scope_path)
                if getattr(agent_view, "memory", None) is not value.memory:
                    container[name] = agent_view
