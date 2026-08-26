"""Every way the shipped examples can reach a provider must be bounded, and owned.

On the conversational path the provider bound is the only thing that ends a
worker at all: the request-side ceiling ends the HTTP response, not the thread
behind it, so an example that leaves a provider call unbounded ships a turn that
can outlive its request indefinitely.

The second rule is ownership: a bounded LLM is a MUTABLE crewai object, and
crewai writes to the instance it is handed (``enable_agent_streaming`` sets
``agent.llm.stream = True`` and never restores it, crewai
``crews/utils.py:54``), so one instance shared by two crewai objects carries
either one's settings into the other. Both rules are checked structurally over the
shipped tree AND behaviorally against the built objects, because the structural
check reads a shape and only the built objects prove the aliasing.

The check is a DENYLIST, and that is the point. The previous version listed the
call shapes it knew how to check and passed everything else, so each new entry
point was invisible until someone thought to add it, and twice the real defect sat
exactly there: an ``Agent()`` with no ``llm`` kwarg at all, which crewai turns into
an unbounded ``LLM`` from the environment. Here the classification runs the other
way: a module is provider-free only if it is SAID to be, and every name from
anywhere else must be bounded at each of its call sites. A new provider, a new
crewai symbol, or a whole new example file therefore fails closed until it is
either bounded or classified.
"""

import ast
import pathlib
import symtable
import sys

import pytest

import agents
from agents.crew_chat import CrewChatCrew


EXAMPLES_ROOT = pathlib.Path(agents.__file__).parent

# Modules that reach no provider. Anything an example imports and that is not
# listed here, not stdlib, and not a sibling example module is treated as
# provider-bearing.
PROVIDER_FREE_MODULES = frozenset(
    {
        "pydantic",
        "ag_ui_a2ui_toolkit",
        # crewai's flow authoring surface, its tool decorator, its conversational
        # config and its LLM base type: declarations and decorators, no calls out.
        "crewai.flow",
        "crewai.flow.flow",
        "crewai.tools",
        "crewai.experimental.conversational",
        "crewai.llms.base_llm",
        # First-party helpers that resolve configuration rather than call a model.
        "ag_ui_crewai._config",
        "ag_ui_crewai._hitl",
        # The demo server's own wiring, which now sits alongside the flows it
        # serves: it mounts routes and runs an ASGI app. The provider calls belong
        # to the flows it mounts, and those are audited at their own call sites.
        # Named exactly, like every other entry here, so no submodule of the bridge
        # is exempted along with the one that genuinely reaches no provider.
        "fastapi",
        "uvicorn",
        "ag_ui_crewai.endpoint",
    }
)

# Provider-bearing module -> the names from it that reach no provider. A name from
# one of these modules that is NOT listed needs a bound at every call site.
PROVIDER_BEARING_MODULES = {
    "litellm": frozenset(),
    "crewai": frozenset({"Process", "Task"}),
    "ag_ui_crewai.sdk": frozenset(
        {
            "CopilotKitState",
            "copilotkit_emit_state",
            "copilotkit_emit_tool_result",
            "copilotkit_exit",
            "copilotkit_predict_state",
            "copilotkit_stream",
            "responses_channel_available",
        }
    ),
    "ag_ui_crewai.a2ui_tool": frozenset({"apply_a2ui_plan_to_tools"}),
}

# Calls that ARE the bound rather than needing one, and where they come from.
# Both halves are checked: matched on the name alone, any callable that happens
# to be called ``bounded_llm`` vouches for an unbounded llm.
BOUND_HELPERS = frozenset({"bounded_llm"})
BOUND_HELPER_MODULES = frozenset({"._crewai_llm"})

# Resolvers whose return value is a real, operator-configurable bound.
BOUND_RESOLVERS = frozenset(
    {"resolve_provider_timeout_seconds", "resolve_agent_execution_ceiling_seconds"}
)

# Where a bound resolver has to come from. Matching the NAME alone let anything
# ending in a resolver's name vouch for a call, which is the same fail-open shape
# the bound-helper check already closes.
BOUND_RESOLVER_MODULES = frozenset({"ag_ui_crewai._config"})

CREWAI_LLM_KWARGS = ("llm", "chat_llm", "function_calling_llm", "manager_llm")

# Keywords whose mapping value IS the provider spec, so a ``timeout`` inside it
# is a keyword of the completion the callee builds from it.
MODEL_SPEC_KWARGS = frozenset({"model"})


def _example_files():
    return sorted(EXAMPLES_ROOT.rglob("*.py"))


def _module_origins(tree):
    """name -> the module it was imported from, for one example file.

    A single-dot relative import of a file that lives in ``examples/`` resolves to
    a module this walk covers in its own right, so it is provider-free HERE: the
    bound is checked where the call actually is.
    """
    origins = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            module = ("." * (node.level or 0)) + (node.module or "")
            for alias in node.names:
                origins[alias.asname or alias.name] = module
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if alias.asname:
                    origins[alias.asname] = alias.name
                    continue
                # ``import a.b`` binds ``a``, and ``a`` is the module ``a``: the
                # ``.b`` is part of the attribute chain at the call site, so
                # recording the full path here would count it twice.
                root = alias.name.split(".")[0]
                origins[root] = root
    return origins


def _is_walked_sibling(module):
    """A relative import of another example module, which this walk also covers."""
    if not module.startswith(".") or module.startswith(".."):
        return False
    return (EXAMPLES_ROOT / f"{module.lstrip('.')}.py").exists()


def _classifying_module(module):
    """The ``PROVIDER_BEARING_MODULES`` key that governs ``module``, or ``None``.

    A submodule is governed by its package: ``litellm.main`` is litellm and
    ``crewai.agent`` is crewai, so the specific ``Agent``/``Crew``/``LLM`` rules
    still apply when the call arrives down a longer chain.

    Ancestry widens what is CHECKED and never what is EXEMPT, which is why
    ``PROVIDER_FREE_MODULES`` gets no equivalent: a provider-free module has to be
    named exactly, so a new submodule underneath one is not covered by it.
    """
    parts = module.split(".")
    for stop in range(len(parts), 0, -1):
        candidate = ".".join(parts[:stop])
        if candidate in PROVIDER_BEARING_MODULES:
            return candidate
    return None


def _is_provider_free(module, name):
    if module in PROVIDER_FREE_MODULES or _is_walked_sibling(module):
        return True
    if module.split(".")[0] in sys.stdlib_module_names:
        return True
    if module.startswith("__future__"):
        return True
    owner = _classifying_module(module)
    known_safe = None if owner is None else PROVIDER_BEARING_MODULES[owner]
    return known_safe is not None and name in known_safe


def _callee(node, origins):
    """``(local name, defining module)`` for the thing this call calls.

    Handles ``acompletion(...)``, ``litellm.acompletion(...)`` and any deeper
    chain. The depth is the point: a walk that gave up at the second attribute
    accepted ``openai.chat.completions.create(...)``, ``litellm.main.acompletion
    (...)`` and ``crewai.agent.Agent(...)`` in silence, which is a denylist
    behaving like the allowlist it replaced.
    """
    func = node.func
    if isinstance(func, ast.Name):
        return func.id, origins.get(func.id)
    attributes = []
    while isinstance(func, ast.Attribute):
        attributes.append(func.attr)
        func = func.value
    if not attributes or not isinstance(func, ast.Name) or func.id not in origins:
        # ``self.state.messages.append(...)``, a method on a local, a call on a
        # call's result. Not rooted in an import, so not a way out of the package.
        return None, None
    attributes.reverse()
    name = attributes.pop()
    return name, ".".join([origins[func.id], *attributes])


def _keywords(node):
    return {keyword.arg: keyword.value for keyword in node.keywords if keyword.arg}


def _is_real_bound(value, origins=None):
    """A value that actually bounds: a bound resolver, or a positive number.

    ``timeout=None`` is the shape that made the previous check worthless: the
    keyword is present, so a presence test passed, while the provider client fell
    back to its own 600s default.

    A resolver counts only when it came from the config module. Matching the bare
    name let any ``<anything>.resolve_provider_timeout_seconds()`` vouch for the
    call, so a sibling example module or a stdlib alias of that name read as a
    bound.
    """
    if isinstance(value, ast.Call):
        name, module = _callee(value, origins or {})
        return name in BOUND_RESOLVERS and module in BOUND_RESOLVER_MODULES
    return (
        isinstance(value, ast.Constant)
        and isinstance(value.value, (int, float))
        and not isinstance(value.value, bool)
        and value.value > 0
    )


def _carries_a_bound(keywords, origins=None):
    """A real ``timeout=``, or a model SPEC mapping that carries one.

    The mapping form is how a model spec is handed to a sub-agent planner: the
    bound travels inside the spec the completion is built from rather than as a
    sibling keyword. Only that position counts. Read from any mapping at all, the
    key was a bound in name only: ``metadata={"timeout": 30}`` is a value the
    provider client passes through untouched, so a call one such entry away from
    the shipped tree audited clean while nothing bounded it.
    """
    if _is_real_bound(keywords.get("timeout"), origins):
        return True
    for kwarg in MODEL_SPEC_KWARGS:
        spec = keywords.get(kwarg)
        if not isinstance(spec, ast.Dict):
            continue
        for key, entry in zip(spec.keys, spec.values):
            if (
                isinstance(key, ast.Constant)
                and key.value == "timeout"
                and _is_real_bound(entry, origins)
            ):
                return True
    return False


def _is_bound_helper(name, module):
    """The shipped helper, not merely something named like it."""
    return name in BOUND_HELPERS and module in BOUND_HELPER_MODULES


def _helper_bound_targets(tree, origins):
    """``id()`` of every ``Name`` node bound directly from the bound helper.

    The one place a node type is named, and in the safe direction: a form left out
    vouches for nothing, so it can only make the audit refuse more. Held by node
    identity rather than by name so that the same name bound somewhere else is
    still counted as the rebind it is.
    """
    targets = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            bound = node.targets
        elif isinstance(node, (ast.AnnAssign, ast.NamedExpr)):
            bound = [node.target]
        else:
            continue
        if not isinstance(node.value, ast.Call):
            continue
        if not _is_bound_helper(*_callee(node.value, origins)):
            continue
        targets.update(id(target) for target in bound if isinstance(target, ast.Name))
    return targets


# PEP 695 type parameters bind a name through an identifier field as well, and
# their node types exist only on 3.12+, so they are looked up rather than named.
# ``isinstance`` against an empty tuple is simply False on the older versions.
_TYPE_PARAM_NODES = tuple(
    node
    for node in (
        getattr(ast, name, None) for name in ("TypeVar", "ParamSpec", "TypeVarTuple")
    )
    if node is not None
)


def _identifier_bindings(node):
    """Names bound by a construct that spells its target as a bare identifier.

    Everything else binds through a TARGET EXPRESSION, which the walk below reads
    off the ``Store``/``Del`` context instead. These are the constructs with no
    such expression, and ``_unseen_bindings`` is what keeps the list honest.
    """
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return {node.name}
    if isinstance(node, ast.arg):
        return {node.arg}
    if isinstance(node, ast.alias):
        return {node.asname or node.name.split(".")[0]}
    if isinstance(node, (ast.ExceptHandler, ast.MatchAs, ast.MatchStar)):
        return {node.name} if node.name else set()
    if isinstance(node, ast.MatchMapping):
        return {node.rest} if node.rest else set()
    if isinstance(node, (ast.Global, ast.Nonlocal)):
        return set(node.names)
    if isinstance(node, _TYPE_PARAM_NODES):
        return {node.name}
    return set()


def _unseen_bindings(source, seen):
    """Names CPython's own binder reports as bound that the walk did not see.

    The completeness check the list above cannot make for itself: ``symtable`` IS
    the compiler's binding analysis, so a construct the walk misses surfaces here
    rather than passing as "never rebound". Reported by the caller, not swallowed.

    Names that are not identifiers are the implicit comprehension iterators
    (``.0``), which no source can bind or read.
    """
    reported = set()
    tables = [symtable.symtable(source, "<audited example>", "exec")]
    while tables:
        table = tables.pop()
        tables.extend(table.get_children())
        for symbol in table.get_symbols():
            if (
                symbol.is_assigned()
                or symbol.is_imported()
                or symbol.is_parameter()
                or symbol.is_declared_global()
                or symbol.is_nonlocal()
            ):
                reported.add(symbol.get_name())
    return {name for name in reported - seen if name.isidentifier()}


def _bounded_llm_names(tree, origins, source):
    """``(names, unseen)``: locals a bound helper vouches for, and what leaked past.

    A name bound anywhere else in the file, by ANY mechanism, is dropped: the walk
    is flat, so one scope's helper call would otherwise vouch for a bare model id
    of the same name in another.

    The rebinds are collected by CONSTRUCTION rather than by listing the statements
    that bind. Every target expression in the grammar carries a ``Store`` (or
    ``Del``) context on its ``Name`` nodes, so one flat walk covers ``=``, ``:=``,
    annotated and augmented assignment, ``for``, ``with``, comprehensions, ``match``
    and ``del`` alike. That matters because the version keyed on ``ast.Assign``
    alone let an annotated assignment or a loop rebind quietly leave a helper's
    vouch standing over a bare model id.
    """
    helper_targets = _helper_bound_targets(tree, origins)
    bounded = set()
    rebound = set()
    seen = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            seen.add(node.id)
            (bounded if id(node) in helper_targets else rebound).add(node.id)
            continue
        identifiers = _identifier_bindings(node)
        seen |= identifiers
        rebound |= identifiers
    unseen = _unseen_bindings(source, seen)
    return bounded - rebound - unseen, unseen


def _is_bounded_llm(value, bounded_names, origins):
    if isinstance(value, ast.Call):
        return _is_bound_helper(*_callee(value, origins))
    return isinstance(value, ast.Name) and value.id in bounded_names


def _shared_llm_findings(tree, bounded_names, where_prefix, counts):
    """One bounded LLM local handed to more than one crewai owner.

    A crewai LLM is mutable and crewai writes to the instance it is handed:
    ``enable_agent_streaming`` sets ``agent.llm.stream = True`` and never restores
    it (crewai ``crews/utils.py:54``). Two owners of one instance therefore share
    whatever either of them sets, which is the hazard ``bounded_llm`` refuses to
    memoize its instances for in the first place.

    Counted per (owner, kwarg) SITE rather than per owner: one ``Agent`` given the
    same instance as both ``llm`` and ``function_calling_llm`` has the same defect.
    """
    uses = {}
    origins = _module_origins(tree)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        name, module = _callee(node, origins)
        if name not in ("Agent", "Crew"):
            continue
        if _classifying_module(module or "") != "crewai":
            continue
        for kwarg, value in _keywords(node).items():
            if kwarg not in CREWAI_LLM_KWARGS or not isinstance(value, ast.Name):
                continue
            if value.id not in bounded_names:
                continue
            counts["crewai_llm_owner"] += 1
            uses.setdefault(value.id, []).append(f"{name}({kwarg}=) line {node.lineno}")
    return [
        f"{where_prefix} the bounded llm `{local}` is handed to more than one "
        f"crewai owner ({'; '.join(sites)}); crewai mutates the instance it is "
        "given, so each owner needs its own"
        for local, sites in uses.items()
        if len(sites) > 1
    ]


def _audit_call(node, name, module, keywords, bounded_names, origins, where, counts):
    """Every rule for one call to a provider-bearing name. Returns findings."""
    findings = []
    if _is_bound_helper(name, module):
        return findings

    if module == "crewai" and name == "Agent":
        counts["crewai_agent"] += 1
        supplied = [kwarg for kwarg in CREWAI_LLM_KWARGS if kwarg in keywords]
        if not supplied:
            # The shape the previous allowlist could not see at all: with no llm,
            # crewai resolves one from the environment with no timeout.
            findings.append(
                f"{where} Agent() sets no llm, so crewai builds an unbounded one"
            )
        for kwarg in supplied:
            if not _is_bounded_llm(keywords[kwarg], bounded_names, origins):
                findings.append(f"{where} Agent({kwarg}=...) is not a bounded llm")
        if not _is_real_bound(keywords.get("max_execution_time"), origins):
            findings.append(
                f"{where} Agent() has no max_execution_time, which is the only "
                "per-execution bound crewai offers"
            )
        return findings

    if module == "crewai" and name == "Crew":
        counts["crewai_crew"] += 1
        for kwarg in CREWAI_LLM_KWARGS:
            if kwarg in keywords and not _is_bounded_llm(
                keywords[kwarg], bounded_names, origins
            ):
                findings.append(f"{where} Crew({kwarg}=...) is not a bounded llm")
        process = keywords.get("process")
        hierarchical = (
            isinstance(process, ast.Attribute) and process.attr == "hierarchical"
        )
        if hierarchical and "manager_llm" not in keywords:
            findings.append(
                f"{where} Crew(process=hierarchical) sets no manager_llm, so crewai "
                "builds an unbounded one"
            )
        return findings

    if module == "crewai" and name == "LLM":
        counts["crewai_llm_ctor"] += 1
        if not _is_real_bound(keywords.get("timeout"), origins):
            findings.append(f"{where} LLM() carries no provider timeout")
        return findings

    counts["provider_call"] += 1
    if not _carries_a_bound(keywords, origins):
        findings.append(f"{where} {name}() carries no provider timeout")
    return findings


def audit_examples(extra_files=()):
    """``(findings, counts)`` for the shipped example tree, plus ``extra_files``.

    ``extra_files`` is how the audit's own teeth are tested: a synthetic module is
    audited alongside the real tree from wherever the test put it, rather than
    written into the shipped package where a crashed run leaves it behind and an
    editable install imports it. Relative imports inside it still resolve against
    the real ``examples/``, which is what makes the synthetic sources realistic.
    """
    findings = []
    counts = {
        "provider_call": 0,
        "crewai_agent": 0,
        "crewai_crew": 0,
        "crewai_llm_ctor": 0,
        "crewai_llm_owner": 0,
        "unclassified": 0,
    }
    for path in [*_example_files(), *extra_files]:
        source = path.read_text()
        tree = ast.parse(source)
        origins = _module_origins(tree)
        bounded_names, unseen = _bounded_llm_names(tree, origins, source)
        if unseen:
            findings.append(
                f"{path.name} binds {sorted(unseen)} by a mechanism the rebind walk "
                "cannot see, so it cannot tell a bounded llm from a rebound one: "
                "teach _identifier_bindings the construct"
            )
        findings.extend(
            _shared_llm_findings(tree, bounded_names, path.name, counts)
        )
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            name, module = _callee(node, origins)
            if name is None or module is None:
                # A local function, a method on a local object, a builtin. Not an
                # import, so not a way out of this package.
                continue
            if _is_provider_free(module, name):
                continue
            owner = _classifying_module(module)
            if owner is None and not module.startswith("."):
                counts["unclassified"] += 1
                findings.append(
                    f"{path.name}:{node.lineno} {name}() comes from the "
                    f"unclassified module {module!r}: either add it to "
                    "PROVIDER_FREE_MODULES or give the call a real timeout"
                )
                continue
            findings.extend(
                _audit_call(
                    node,
                    name,
                    owner or module,
                    _keywords(node),
                    bounded_names,
                    origins,
                    f"{path.name}:{node.lineno}",
                    counts,
                )
            )
    return findings, counts


def test_every_shipped_example_bounds_its_provider_calls():
    """No unbounded way out of the shipped examples, by any shape at all."""
    findings, _counts = audit_examples()
    assert findings == []


def test_the_audit_matched_every_shape_it_guards():
    """A walk that silently matched nothing would report everything as bounded."""
    _findings, counts = audit_examples()
    for shape in (
        "provider_call",
        "crewai_agent",
        "crewai_crew",
        "crewai_llm_ctor",
        "crewai_llm_owner",
    ):
        assert counts[shape] > 0, f"the audit matched no {shape}: {counts}"
    assert counts["unclassified"] == 0


def test_the_crew_backed_examples_set_an_execution_ceiling():
    """The README names this as the closest thing to a per-turn bound.

    A per-read provider timeout is not a turn bound: crewai multiplies it by the
    client's retries, the executor's iterations, and the task-level retry. The
    execution ceiling is what removes the outermost of those factors, and the
    README says the shipped crew-backed examples set it, so that claim is checked
    rather than asserted in prose.
    """
    ceilings = []
    for path in _example_files():
        tree = ast.parse(path.read_text())
        origins = _module_origins(tree)
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            name, module = _callee(node, origins)
            if (name, module) != ("Agent", "crewai"):
                continue
            keywords = _keywords(node)
            ceilings.append(
                (path.name, _is_real_bound(keywords.get("max_execution_time"), origins))
            )

    assert ceilings, "no shipped example builds a crewai Agent"
    assert all(bounded for _name, bounded in ceilings), ceilings


# --------------------------------------------------------------------------
# The audit's own teeth: each shape it must refuse, refused.
#
# Parameterized over synthetic sources rather than over edits to the shipped
# tree, so the guard's contract is readable and the shipped files stay untouched.
# --------------------------------------------------------------------------

UNBOUNDED_SHAPES = {
    "bare_model_id_to_agent": """
from crewai import Agent
from ag_ui_crewai._config import resolve_agent_execution_ceiling_seconds
agent = Agent(llm="openai/gpt-4o",
              max_execution_time=resolve_agent_execution_ceiling_seconds())
""",
    "bare_model_id_to_crew_chat_llm": """
from crewai import Crew
crew = Crew(chat_llm="openai/gpt-4o")
""",
    "agent_with_no_llm_at_all": """
from crewai import Agent
from ag_ui_crewai._config import resolve_agent_execution_ceiling_seconds
agent = Agent(role="r", goal="g", backstory="b",
              max_execution_time=resolve_agent_execution_ceiling_seconds())
""",
    "agent_with_no_execution_ceiling": """
from crewai import Agent
from ._crewai_llm import bounded_llm
agent = Agent(llm=bounded_llm("openai/gpt-4o"))
""",
    "explicit_none_timeout": """
from litellm import acompletion
response = await acompletion(model="openai/gpt-4o", timeout=None)
""",
    "missing_timeout": """
from litellm import acompletion
response = await acompletion(model="openai/gpt-4o")
""",
    "zero_timeout": """
from litellm import acompletion
response = await acompletion(model="openai/gpt-4o", timeout=0)
""",
    "bare_model_into_the_a2ui_planner": """
from ag_ui_crewai.a2ui_tool import plan_a2ui_injection
plan = plan_a2ui_injection(model="openai/gpt-4o")
""",
    "a2ui_planner_model_dict_without_a_timeout": """
from ag_ui_crewai.a2ui_tool import plan_a2ui_injection
plan = plan_a2ui_injection(model={"model": "openai/gpt-4o"})
""",
    # A mapping the provider client never reads a bound out of. The mapping form
    # is recognised because a model SPEC carries the timeout into the completion;
    # accepting the key in any mapping at all makes every unbounded call one
    # ``metadata`` entry away from auditing clean.
    "timeout_in_a_mapping_that_binds_nothing": """
from litellm import acompletion
response = await acompletion(model="openai/gpt-4o", metadata={"timeout": 30})
""",
    "unbounded_llm_constructor": """
from crewai import LLM
llm = LLM(model="openai/gpt-4o")
""",
    "hierarchical_crew_without_a_manager_llm": """
from crewai import Crew, Process
crew = Crew(process=Process.hierarchical)
""",
    "a_new_provider_sdk_nobody_classified": """
import anthropic
client = anthropic.Anthropic()
""",
    "a_new_litellm_entry_point": """
from litellm import aresponses
stream = await aresponses(model="openai/gpt-4o")
""",
    "a_new_sdk_helper_nobody_classified": """
from ag_ui_crewai.sdk import copilotkit_new_channel
stream = await copilotkit_new_channel(model="openai/gpt-4o")
""",
    # Attribute chains deeper than one level. The classification has to follow the
    # chain to its root import: a walk that gives up at the second dot accepts
    # every provider reachable through a package's own submodules, which is the
    # allowlist hole this file exists to not have.
    "a_deep_chain_into_an_unclassified_provider_sdk": """
import openai
response = openai.chat.completions.create(model="gpt-4o")
""",
    "a_deep_chain_into_a_provider_bearing_submodule": """
import litellm
response = await litellm.main.acompletion(model="openai/gpt-4o")
""",
    "a_deep_chain_into_a_crewai_submodule": """
import crewai
agent = crewai.agent.Agent(role="r", goal="g", backstory="b")
""",
    # The helper is a name AND an origin. On the name alone, anything called
    # ``bounded_llm`` is a bound, and so is any local a helper call in some
    # unrelated scope happened to touch.
    "a_bound_helper_name_that_is_not_the_helper": """
from crewai import Agent
from functools import partial as bounded_llm
from ag_ui_crewai._config import resolve_agent_execution_ceiling_seconds
agent = Agent(llm=bounded_llm(str, "openai/gpt-4o"),
              max_execution_time=resolve_agent_execution_ceiling_seconds())
""",
    # A resolver is a name AND an origin too. Matched on the name alone, anything
    # whose last attribute reads like a resolver vouched for the call, so a
    # same-named function on a walked sibling module counted as a real bound.
    # A resolver is a name AND an origin too. Matched on the name alone, anything
    # whose last attribute read like a resolver vouched for the call. The carrier
    # has to be a module the audit already treats as provider-free, or the call
    # would be refused for being unclassified instead and prove nothing.
    "a_resolver_name_reached_through_a_provider_free_module": """
import os
from litellm import acompletion
response = await acompletion(
    model="openai/gpt-4o",
    timeout=os.resolve_provider_timeout_seconds(),
)
""",
    "a_bare_model_id_vouched_for_from_another_scope": """
from crewai import Agent
from ag_ui_crewai._config import resolve_agent_execution_ceiling_seconds
from ._crewai_llm import bounded_llm
def unrelated():
    llm = bounded_llm("openai/gpt-4o")
    return llm
llm = "openai/gpt-4o"
agent = Agent(llm=llm,
              max_execution_time=resolve_agent_execution_ceiling_seconds())
""",
    # The same vouching, through binding forms that are not a plain ``=``. A
    # rebind the walk cannot see leaves the helper's vouch standing, so the whole
    # point of dropping re-bound names is lost for every form it misses.
    "a_bare_model_id_annotated_over_a_vouched_name": """
from crewai import Agent
from ag_ui_crewai._config import resolve_agent_execution_ceiling_seconds
from ._crewai_llm import bounded_llm
def unrelated():
    llm = bounded_llm("openai/gpt-4o")
    return llm
llm: str = "openai/gpt-4o"
agent = Agent(llm=llm,
              max_execution_time=resolve_agent_execution_ceiling_seconds())
""",
    "a_bare_model_id_loop_bound_over_a_vouched_name": """
from crewai import Agent
from ag_ui_crewai._config import resolve_agent_execution_ceiling_seconds
from ._crewai_llm import bounded_llm
def unrelated():
    llm = bounded_llm("openai/gpt-4o")
    return llm
for llm in ("openai/gpt-4o",):
    agent = Agent(llm=llm,
                  max_execution_time=resolve_agent_execution_ceiling_seconds())
""",
    "a_bare_model_id_walrus_bound_over_a_vouched_name": """
from crewai import Agent
from ag_ui_crewai._config import resolve_agent_execution_ceiling_seconds
from ._crewai_llm import bounded_llm
def unrelated():
    llm = bounded_llm("openai/gpt-4o")
    return llm
agent = Agent(llm=(llm := "openai/gpt-4o"),
              max_execution_time=resolve_agent_execution_ceiling_seconds())
""",
    "a_bare_model_id_context_bound_over_a_vouched_name": """
from contextlib import nullcontext
from crewai import Agent
from ag_ui_crewai._config import resolve_agent_execution_ceiling_seconds
from ._crewai_llm import bounded_llm
def unrelated():
    llm = bounded_llm("openai/gpt-4o")
    return llm
with nullcontext("openai/gpt-4o") as llm:
    agent = Agent(llm=llm,
                  max_execution_time=resolve_agent_execution_ceiling_seconds())
""",
    # An import is a binding too, and this one shadows the vouched local with a
    # name that resolves to something the audit knows nothing about.
    "a_vouched_name_shadowed_by_an_import": """
from crewai import Agent
from ag_ui_crewai._config import resolve_agent_execution_ceiling_seconds
from ._crewai_llm import bounded_llm
from os import sep as llm
def unrelated():
    llm = bounded_llm("openai/gpt-4o")
    return llm
agent = Agent(llm=llm,
              max_execution_time=resolve_agent_execution_ceiling_seconds())
""",
    # Bounded, and still wrong: crewai writes to the instance it is handed, so one
    # LLM object owned by two crewai objects carries one's settings into the other.
    "one_bounded_llm_shared_by_two_crewai_owners": """
from crewai import Agent, Crew
from ag_ui_crewai._config import resolve_agent_execution_ceiling_seconds
from ._crewai_llm import bounded_llm
llm = bounded_llm("openai/gpt-4o")
agent = Agent(llm=llm,
              max_execution_time=resolve_agent_execution_ceiling_seconds())
crew = Crew(agents=[agent], chat_llm=llm)
""",
}


PROBE_NAME = "_audit_probe_example.py"


def _probe(tmp_path, source):
    """One synthetic example module, outside the shipped package."""
    probe = tmp_path / PROBE_NAME
    probe.write_text(source)
    return probe


@pytest.mark.parametrize("shape", sorted(UNBOUNDED_SHAPES))
def test_the_audit_refuses_each_unbounded_shape(shape, tmp_path):
    """Introduce one unbounded shape as a new example file; the audit must fail."""
    findings, _counts = audit_examples([_probe(tmp_path, UNBOUNDED_SHAPES[shape])])

    assert findings, f"the audit accepted {shape}"
    assert all(PROBE_NAME in finding for finding in findings), findings


def test_the_audit_accepts_the_bounded_form_of_each_shape(tmp_path):
    """The refusals above must not be a guard that refuses everything."""
    probe = _probe(
        tmp_path,
        """
from crewai import Agent, Crew, LLM, Process
from litellm import acompletion
from ag_ui_crewai._config import (
    resolve_agent_execution_ceiling_seconds,
    resolve_provider_timeout_seconds,
)
from ag_ui_crewai.a2ui_tool import plan_a2ui_injection
from ag_ui_crewai.sdk import copilotkit_responses
from ._crewai_llm import bounded_llm

llm = bounded_llm("openai/gpt-4o")
chat_llm = bounded_llm("openai/gpt-4o")
manager_llm = bounded_llm("openai/gpt-4o")
agent = Agent(
    llm=llm,
    max_execution_time=resolve_agent_execution_ceiling_seconds(),
)
crew = Crew(chat_llm=chat_llm)
managed = Crew(process=Process.hierarchical, manager_llm=manager_llm)
raw = LLM(model="openai/gpt-4o", timeout=resolve_provider_timeout_seconds())


async def turn():
    await acompletion(model="m", timeout=resolve_provider_timeout_seconds())
    await copilotkit_responses(model="m", timeout=resolve_provider_timeout_seconds())
    plan_a2ui_injection(
        model={"model": "m", "timeout": resolve_provider_timeout_seconds()}
    )
"""
    )
    findings, counts = audit_examples([probe])

    assert findings == []
    assert counts["provider_call"] > 0


def test_the_audit_accepts_a_bounded_call_down_a_deep_attribute_chain(tmp_path):
    """Following the chain must not become "any depth is refused".

    The depth is not the defect; losing the classification is. Reached down a
    submodule, the same call is held to the same rule, so a bound satisfies it.
    """
    probe = _probe(
        tmp_path,
        """
import crewai
import litellm
from ag_ui_crewai._config import (
    resolve_agent_execution_ceiling_seconds,
    resolve_provider_timeout_seconds,
)
from ._crewai_llm import bounded_llm

agent = crewai.agent.Agent(
    llm=bounded_llm("openai/gpt-4o"),
    max_execution_time=resolve_agent_execution_ceiling_seconds(),
)


async def turn():
    await litellm.main.acompletion(
        model="m", timeout=resolve_provider_timeout_seconds()
    )
""",
    )
    findings, counts = audit_examples([probe])

    assert findings == []
    assert counts["crewai_agent"] > 0


# --------------------------------------------------------------------------
# The rebind walk against CPython's own binder.
#
# The walk reads target expressions off their ``Store``/``Del`` contexts, so no
# statement type has to be listed for those. What is left is the handful of
# constructs that bind a bare identifier, and THAT list is checked here rather
# than trusted: ``symtable`` is the compiler's binding analysis, so a construct
# the list forgets shows up as a name it reports and the walk did not see.
# --------------------------------------------------------------------------

EVERY_BINDING_FORM = '''
import os
import os.path as os_path
from collections import OrderedDict as ordered

annotated: int = 1
declared: int
augmented = 0
augmented += 1
walrus_holder = (walrus := 2)
unpacked, [nested, *starred] = 1, (2, 3, 4)
del unpacked
comprehended = [comp_target for comp_target in ()]
generated = {key_target: value_target for key_target, value_target in ()}

for loop_target in ():
    pass

with open("f") as with_target, open("g") as (paired_a, paired_b):
    pass

try:
    pass
except ValueError as caught:
    pass

match {"k": 1}:
    case {"k": mapping_value, **mapping_rest}:
        pass
    case [first, *rest_items]:
        pass
    case {"other": _} | int() as captured:
        pass
    case other_capture:
        pass

lambda_bound = lambda lambda_param, *lambda_args, **lambda_kwargs: lambda_param


class Klass:
    class_attr = 1

    def method(self, positional, /, ordinary, *args, keyword_only=None, **kwargs):
        global module_global
        module_global = 1

        def inner():
            nonlocal positional
            positional = 2

        return inner


async def async_shapes(source):
    async with source as async_with_target:
        async for async_loop_target in source:
            pass
    return [item async for item in source]
'''

if sys.version_info >= (3, 11):
    EVERY_BINDING_FORM += '''
try:
    pass
except* TypeError as grouped:
    pass
'''

if sys.version_info >= (3, 12):
    EVERY_BINDING_FORM += '''
type Alias = int


def generic[T](type_param_user: T) -> T:
    return type_param_user
'''


def test_the_rebind_walk_accounts_for_every_binding_form_python_has():
    """A binding the walk cannot see would leave a helper's vouch standing.

    Which is exactly how a bare model id audited clean: the walk keyed on
    ``ast.Assign``, so an annotated assignment or a loop rebind was not a rebind as
    far as it could tell. Measured against the compiler rather than against a
    second list, so a form nobody here thought of still fails this.
    """
    tree = ast.parse(EVERY_BINDING_FORM)
    _bounded, unseen = _bounded_llm_names(tree, {}, EVERY_BINDING_FORM)

    assert unseen == set(), (
        "these names are bound by a construct the rebind walk cannot see: "
        f"{sorted(unseen)}"
    )


def test_an_unseen_binding_is_reported_rather_than_trusted(tmp_path, monkeypatch):
    """The backstop has to FAIL the audit, not quietly widen it.

    Reached by narrowing the identifier list, because the point is what happens
    when a construct is missing from it: the name it binds arrives as a finding
    rather than as a vouch nobody rechecked.
    """
    probe = _probe(
        tmp_path,
        """
from ._crewai_llm import bounded_llm
def unrelated():
    llm = bounded_llm("openai/gpt-4o")
    return llm
""",
    )
    assert audit_examples([probe])[0] == []

    monkeypatch.setitem(globals(), "_identifier_bindings", lambda node: set())
    findings, _counts = audit_examples([probe])

    assert [
        finding
        for finding in findings
        if PROBE_NAME in finding and "cannot see" in finding
    ], findings


# --------------------------------------------------------------------------
# The built objects, not the shape: only these prove the aliasing.
# --------------------------------------------------------------------------


def test_the_crew_chat_example_gives_each_crewai_owner_its_own_llm():
    """The shared-mutable-LLM hazard, measured on the objects crewai will use.

    ``Crew.kickoff`` with streaming calls ``enable_agent_streaming``, which sets
    ``agent.llm.stream = True`` on the instance and never restores it (crewai
    ``crews/utils.py:54``). With one instance behind both the agent and
    ``chat_llm``, that write reaches the chat helper too, and a ``_token_usage``
    dict crewai mutates in place is shared the same way. Asserted by mutating one
    and reading the other, because identity alone does not show the consequence.
    """
    crew = CrewChatCrew().crew()
    agent_llm = crew.agents[0].llm

    assert agent_llm is not crew.chat_llm
    agent_llm.stream = True
    assert crew.chat_llm.stream is False, (
        "crewai's streaming flip on the agent's llm reached the crew's chat_llm"
    )
