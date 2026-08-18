"""Per-run state installed on a flow object that two runs may share.

``_copyutil.safe_deepcopy`` pins-and-shares on the crewai 1.15.x deep-copy bug: a
value it cannot copy is carried by REFERENCE rather than isolated. So a
per-request ``flow_copy`` does not guarantee per-request sub-objects, and any
caller driving one flow instance across consecutive turns shares them outright.

Everything the conversational path installs on a flow is per-RUN: the abandonment
signal, the run's inputs, and the write-gate binding that pairs them. Carried
forward from a previous run, an already-abandoned signal silently drops every
write the live run makes, and stale inputs are overlaid onto its restores. Nothing
asserted that per-run state found on a flow belongs to THIS run, which is how one
instance of it reached review five times over.

So each install site is a parameter here. Adding a site to the production path
means adding one, and a site that stops rebinding fails its own row.
"""

import ast
import pathlib
import threading
from types import SimpleNamespace

import pytest

from crewai.flow.flow import Flow, start
from crewai.flow.persistence.base import FlowPersistence
from pydantic import Field

from ag_ui_crewai import _conversation as conversation_module
from ag_ui_crewai._conversation import (
    AbandonmentSignal,
    ConversationalTurn,
    force_per_turn_trace_finalization,
    hydrate_conversational_flow,
    overlay_conversational_persistence,
)


class _PerRunSpyPersistence(FlowPersistence):
    """A real crewai backend, so crewai's own resolution accepts the wrapper.

    Named per file, not ``_SpyPersistence``: ``FlowPersistence.__init_subclass__``
    registers every subclass in a process-wide registry keyed by CLASS NAME, so two
    test modules defining the same name leave whichever imported last serving both.
    """

    writes: list = Field(default_factory=list)

    def init_db(self) -> None:
        pass

    def save_state(self, flow_uuid, method_name, state_data):
        self.writes.append(("save_state", method_name))

    def load_state(self, flow_uuid):
        return {"id": flow_uuid}

    def save_pending_feedback(self, flow_uuid, context, state_data):
        self.writes.append(("save_pending_feedback", flow_uuid))

    def load_pending_feedback(self, flow_uuid):
        return None

    def clear_pending_feedback(self, flow_uuid):
        self.writes.append(("clear_pending_feedback", flow_uuid))


class _PlainFlow(Flow[dict]):
    """No persistence of any kind until a test assigns one."""

    @start()
    def step(self):
        return "ok"


def _run_inputs(label):
    return {"id": "thread-shared", "document": label}


def _turn(label):
    return ConversationalTurn(
        message=label, history=[{"role": "user", "content": label}], current_media=[]
    )


# --------------------------------------------------------------------------
# Every place a run installs its own state on the flow.
#
# ``install`` is the REAL production call. ``observe`` reads back what that call
# put there, so a site that forgot to rebind reports the previous run's value.
# --------------------------------------------------------------------------


def _install_persistence_overlay(flow, label, signal):
    overlay_conversational_persistence(
        flow, _run_inputs(label), abandonment=signal
    )


def _observe_lazy_guard(flow):
    """The binding the lazy ``__setattr__`` guard will give a wrapper it creates."""
    binding = getattr(flow, "_agui_persistence_guard")
    return {
        "document": binding.inputs.get("document"),
        "signal": binding.abandonment,
    }


def _observe_wrapper_binding(flow):
    """The run the installed write gate resolves for this caller, and its inputs."""
    wrapper = flow.persistence
    return {
        "document": wrapper.load_state("thread-shared").get("document"),
        "signal": wrapper.agui_run,
    }


def _install_hydration(flow, label, signal):
    hydrate_conversational_flow(flow, _run_inputs(label), _turn(label))


def _observe_hydrated_state(flow):
    state = flow._state
    return {
        "document": state.get("document"),
        "messages": [message.get("content") for message in state.get("messages", [])],
    }


def _install_trace_finalization(flow, label, signal):
    force_per_turn_trace_finalization(flow)


def _trace_seam(flow):
    """The per-request seam the trace site overrides on the instance."""
    return flow.__dict__.get("_should_defer_trace_finalization")


def _observe_trace_finalization(flow):
    """The forced flag, plus what the per-request seam answers and what it shadows.

    Read as VALUES rather than handed back as the object itself. Returning the
    object made the row's expectation a copy of this reading, so the comparison
    accepted a flow whose seam was never installed, or was not even callable.
    """
    seam = _trace_seam(flow)
    return {
        "defer": flow.defer_trace_finalization,
        "seam_answers": seam() if callable(seam) else seam,
        "seam_shadows_the_type": callable(seam)
        and seam is not getattr(type(flow), "_should_defer_trace_finalization", None),
    }


class _Site:
    """One install site: the production call, and how to read back what it set.

    ``expected`` is given the run's label and signal and NOTHING ELSE, so it
    cannot be written as a second reading of the slot ``observe`` reads. Where two
    runs legitimately install the same VALUES, ``rebound`` names the per-request
    object whose identity is the only evidence that the site reinstalled at all.
    """

    __slots__ = ("install", "observe", "expected", "rebound")

    def __init__(self, install, observe, expected, rebound=None):
        self.install = install
        self.observe = observe
        self.expected = expected
        self.rebound = rebound


INSTALL_SITES = {
    "lazy_persistence_guard": _Site(
        _install_persistence_overlay,
        _observe_lazy_guard,
        lambda label, signal: {"document": label, "signal": signal},
    ),
    "persistence_write_gate": _Site(
        _install_persistence_overlay,
        _observe_wrapper_binding,
        lambda label, signal: {"document": label, "signal": signal},
    ),
    "hydrated_state_inputs": _Site(
        _install_hydration,
        _observe_hydrated_state,
        lambda label, signal: {"document": label, "messages": [label]},
    ),
    "per_turn_trace_finalization": _Site(
        _install_trace_finalization,
        _observe_trace_finalization,
        lambda label, signal: {
            "defer": False,
            "seam_answers": False,
            "seam_shadows_the_type": True,
        },
        rebound=_trace_seam,
    ),
}


class _DeferringFlow:
    """Stands in for a conversational Flow that defers trace finalization.

    The seam is on the TYPE, which is the condition production checks before
    overriding it on the instance.
    """

    defer_trace_finalization = True

    def _should_defer_trace_finalization(self):
        return self.defer_trace_finalization


def _flow_for(site):
    """A flow shaped for the site under test, sharing one instance across runs."""
    if site == "persistence_write_gate":
        flow = _PlainFlow()
        flow.persistence = _PerRunSpyPersistence()
        return flow
    if site == "hydrated_state_inputs":
        return SimpleNamespace(_state={})
    if site == "per_turn_trace_finalization":
        return _DeferringFlow()
    return _PlainFlow()


@pytest.mark.parametrize("site", sorted(INSTALL_SITES))
def test_run_two_never_observes_run_ones_per_run_state(site):
    """Two sequential runs, ONE flow object: run two must see only its own state."""
    spec = INSTALL_SITES[site]
    flow = _flow_for(site)

    first_signal = AbandonmentSignal()
    spec.install(flow, "turn one", first_signal)
    # Run one ends the way the worst case ends: abandoned, with its signal live.
    first_signal.abandon()
    stale = spec.observe(flow)
    stale_object = None if spec.rebound is None else spec.rebound(flow)

    second_signal = AbandonmentSignal()
    spec.install(flow, "turn two", second_signal)

    assert spec.observe(flow) == spec.expected("turn two", second_signal)
    # Explicit, because a site whose two runs install the same VALUE would look
    # rebound while carrying the previous run's object forward.
    if spec.rebound is None:
        assert spec.observe(flow) != stale
    else:
        assert spec.rebound(flow) is not stale_object


@pytest.mark.parametrize("site", ["lazy_persistence_guard", "persistence_write_gate"])
def test_run_two_is_not_gated_on_run_ones_abandonment(site):
    """Inheriting an abandoned signal drops every write the live run makes.

    The gate state is the consequence the value comparison above cannot see: a
    wrapper still pointed at an abandoned run refuses run two's writes silently,
    and the run reports success while nothing was stored.
    """
    install = INSTALL_SITES[site].install
    flow = _flow_for("persistence_write_gate")
    backend = flow.persistence

    first_signal = AbandonmentSignal()
    install(flow, "turn one", first_signal)
    first_signal.abandon()

    second_signal = AbandonmentSignal()
    install(flow, "turn two", second_signal)

    flow.persistence.save_state("thread-shared", "draft", {"document": "turn two"})
    assert backend.writes == [("save_state", "draft")], (
        "run two's write was gated on run one's abandonment"
    )

    # And run two can still be abandoned in its own right.
    second_signal.abandon()
    flow.persistence.save_state("thread-shared", "late", {"document": "late"})
    assert backend.writes == [("save_state", "draft")]


@pytest.mark.parametrize("carry", ["same_flow", "pinned_onto_a_new_flow"])
def test_a_persistence_object_shared_by_reference_is_rebound(carry):
    """The wrapper itself is what the deep-copy bug shares between runs.

    It holds an event and a lock, so it is exactly the kind of value the crewai
    1.15.x fallback pins by reference instead of isolating. Both ways it arrives
    at run two are covered: the same flow instance driven twice, and the wrapper
    handed to a fresh flow copy.
    """
    backend = _PerRunSpyPersistence()
    first = _PlainFlow()
    first.persistence = backend
    first_signal = AbandonmentSignal()
    overlay_conversational_persistence(
        first, _run_inputs("turn one"), abandonment=first_signal
    )
    carried = first.persistence
    assert carried.agui_run is first_signal
    assert carried.agui_backend is backend
    first_signal.abandon()

    if carry == "same_flow":
        second = first
    else:
        second = _PlainFlow()
        object.__setattr__(second, "persistence", carried)

    second_signal = AbandonmentSignal()
    overlay_conversational_persistence(
        second, _run_inputs("turn two"), abandonment=second_signal
    )

    assert second.persistence is carried, "the shared-by-reference path was not taken"
    assert second.persistence.agui_run is second_signal
    assert second.persistence.agui_backend is backend
    assert second.persistence.load_state("thread-shared")["document"] == "turn two"

    second.persistence.save_state("thread-shared", "draft", {"document": "turn two"})
    assert backend.writes == [("save_state", "draft")]


def test_the_resolved_binding_is_a_whole_object_per_run():
    """A reader sees one run's pairing or the other's, never a mixture.

    The signal and the inputs are read at different moments by different threads,
    so re-pointing them field by field lets a reader pair the live signal with the
    previous run's inputs. A binding per run, never mutated, is what rules that out
    -- and it is also what lets the previous run's own worker keep reading its own
    pair while the live run reads the new one.
    """
    backend = _PerRunSpyPersistence()
    flow = _PlainFlow()
    flow.persistence = backend
    overlay_conversational_persistence(
        flow, _run_inputs("turn one"), abandonment=AbandonmentSignal()
    )
    wrapper = flow.persistence
    first_binding = wrapper._agui_gate()

    second_signal = AbandonmentSignal()
    overlay_conversational_persistence(
        flow, _run_inputs("turn two"), abandonment=second_signal
    )

    assert wrapper._agui_gate() is not first_binding
    # The previous binding is untouched, so a reader holding it still sees a
    # consistent pair rather than a half-updated one.
    assert first_binding.inputs["document"] == "turn one"
    assert first_binding.abandonment is not second_signal
    assert wrapper._agui_gate().inputs["document"] == "turn two"
    assert wrapper._agui_gate().abandonment is second_signal


# --------------------------------------------------------------------------
# The rows, against the production module they are rows OF.
#
# Scoped to ``_conversation``, which is where the conversational path installs
# per-run state. ``endpoint.create_queue`` stamps a per-REQUEST queue key on the
# flow as well; that one is not conversational and is covered by the cancellation
# suite, so it is deliberately out of this walk's reach.
# --------------------------------------------------------------------------

CONVERSATION_SOURCE = pathlib.Path(conversation_module.__file__)


# Writers the walk below finds that do not install per-run state on a flow, and
# why. The exemptions are named, so a NEW writer is uncovered until it is either
# driven by a row above or added here: the walk fails closed rather than being
# narrowed to the shapes it already knows.
NOT_PER_RUN_FLOW_STATE = {
    "ConversationWorkerRegistry._release": (
        "clears the released lease's own bookkeeping; a lease is not a flow"
    ),
}


def _module_functions(source_path):
    """Every function in the production module, by qualified name.

    Nested and class-nested functions included. The version that read ``tree.body``
    alone could not see a site on a method or inside a factory, and a site the walk
    cannot see is a site no row has to drive.
    """
    tree = ast.parse(source_path.read_text())
    functions = {}

    def visit(node, prefix):
        for child in ast.iter_child_nodes(node):
            nested = isinstance(
                child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
            )
            if not nested:
                visit(child, prefix)
                continue
            qualified = prefix + child.name
            if not isinstance(child, ast.ClassDef):
                functions[qualified] = child
            visit(child, qualified + ".")

    visit(tree, "")
    return functions


def _handed_parameters(function):
    """The parameters a caller hands this function.

    ``self`` and ``cls`` are the receiver rather than something handed in, so a
    method writing to its own instance is not installing state on anyone else's
    object. Every other parameter counts, whatever it is named: the version that
    matched the literal name ``flow`` reported a site that renamed its parameter as
    no site at all.
    """
    args = function.args
    names = [arg.arg for arg in (*args.posonlyargs, *args.args, *args.kwonlyargs)]
    for extra in (args.vararg, args.kwarg):
        if extra is not None:
            names.append(extra.arg)
    return {name for name in names if name not in ("self", "cls")}


def _installs_onto_a_handed_object(function):
    """True when this function writes an attribute onto something handed to it.

    Both shapes, because they are the same install: ``flow.attr = value``, and the
    ``setattr`` / ``object.__setattr__`` form the bridge needs where a pydantic
    ``__setattr__`` would refuse the plain one. Keying on the ``setattr`` call alone
    saw only the second. ``type.__setattr__(type(flow), ...)`` is still not one: it
    latches a warning on the CLASS, and its first argument is a call rather than the
    parameter.
    """
    parameters = _handed_parameters(function)
    if not parameters:
        return False
    for node in ast.walk(function):
        targets = []
        if isinstance(node, ast.Assign):
            targets = node.targets
        elif isinstance(node, (ast.AnnAssign, ast.AugAssign)):
            targets = [node.target]
        for target in targets:
            if (
                isinstance(target, ast.Attribute)
                and isinstance(target.value, ast.Name)
                and target.value.id in parameters
            ):
                return True
        if not isinstance(node, ast.Call) or not node.args:
            continue
        called = getattr(node.func, "attr", None) or getattr(node.func, "id", None)
        if called not in ("__setattr__", "setattr"):
            continue
        first = node.args[0]
        if isinstance(first, ast.Name) and first.id in parameters:
            return True
    return False


def production_install_sites(source_path=CONVERSATION_SOURCE):
    """Production functions that write an attribute onto an object handed to them.

    What this does NOT see, stated so the claim above it is the size it really is:
    a write reached through a local alias of the parameter, one made through
    ``flow.__dict__`` or ``vars(flow)``, one made onto the RESULT of a call rather
    than onto the parameter, and any install site outside ``_conversation``.
    """
    return {
        name
        for name, function in _module_functions(source_path).items()
        if _installs_onto_a_handed_object(function)
    }


def install_sites_the_rows_reach(source_path=CONVERSATION_SOURCE):
    """Production functions the rows above reach, directly or through a callee.

    Reached rather than called: the overlay installs the lazy guard itself, so the
    two rows that share it cover both sites.

    Module-level calls only, deliberately. A nested or class-nested writer is NOT
    counted as reached because its enclosing function happens to be, so one shows
    up as uncovered and has to be given a row or an exemption.
    """
    functions = _module_functions(source_path)
    reached = set()
    frontier = [
        name
        for site in INSTALL_SITES.values()
        for name in site.install.__code__.co_names
        if name in functions
    ]
    while frontier:
        name = frontier.pop()
        if name in reached:
            continue
        reached.add(name)
        frontier.extend(
            node.func.id
            for node in ast.walk(functions[name])
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id in functions
        )
    return reached


def test_every_install_site_is_parameterized():
    """A site added to the production path has to be added here too.

    Derived from ``_conversation``, because the version that compared this file's
    row names to a hardcoded copy of the same four names could not fail: it never
    read the production path it claimed to cover, so a new install site there was
    uncovered in silence.

    The claim is exactly as wide as ``production_install_sites``: every function in
    that module which writes an attribute onto an object handed to it is either
    driven by a row here or named in ``NOT_PER_RUN_FLOW_STATE``. The shapes that
    walk cannot see are listed on it.
    """
    sites = production_install_sites()
    assert sites, "the walk found no production install site at all"

    stale = sorted(set(NOT_PER_RUN_FLOW_STATE) - sites)
    assert stale == [], (
        f"these exemptions no longer name a writer in {CONVERSATION_SOURCE.name}, "
        f"so they can only hide the next one: {stale}"
    )

    uncovered = sorted(
        sites - install_sites_the_rows_reach() - set(NOT_PER_RUN_FLOW_STATE)
    )
    assert uncovered == [], (
        "these production functions write onto an object handed to them and no row "
        f"above drives them: add a row, or say in NOT_PER_RUN_FLOW_STATE why it is "
        f"not per-run flow state: {uncovered}"
    )
    # The overlay is the one production call that installs two of them, so a
    # refactor that splits it must show up as a changed site list.
    assert INSTALL_SITES["lazy_persistence_guard"].install is (
        INSTALL_SITES["persistence_write_gate"].install
    )


# --------------------------------------------------------------------------
# What the walk above can and cannot see, on synthetic modules.
#
# The test before this one is only worth its docstring if the walk really finds a
# new site, and the walk it replaced found one of these five. Written as sources
# rather than as edits to the production module, so the contract is readable and
# ``_conversation`` stays untouched.
# --------------------------------------------------------------------------

INSTALL_SHAPES = {
    "a_plain_attribute_assignment": """
def install(flow, binding):
    flow._agui_binding = binding
""",
    "a_setattr_call": """
def install(flow, binding):
    object.__setattr__(flow, "_agui_binding", binding)
""",
    "a_parameter_that_is_not_named_flow": """
def install(target, binding):
    object.__setattr__(target, "_agui_binding", binding)
""",
    "a_keyword_only_parameter": """
def install(*, flow, binding):
    flow._agui_binding = binding
""",
    "a_method_on_a_class": """
class Installer:
    def install(self, flow, binding):
        object.__setattr__(flow, "_agui_binding", binding)
""",
    "a_function_nested_in_a_factory": """
def build():
    def install(flow, binding):
        flow._agui_binding = binding
    return install
""",
    "an_augmented_write": """
def install(flow, count):
    flow._agui_installs += count
""",
}

NON_INSTALL_SHAPES = {
    # The receiver, not something handed in: a wrapper writing to itself is not
    # installing per-run state on anyone else's object.
    "a_method_writing_to_its_own_instance": """
class Wrapper:
    def bind(self, binding):
        self._agui_binding = binding
""",
    # Per-CLASS, which is where the bridge latches its declined-guard warning. The
    # first argument is a call, not the parameter.
    "a_write_latched_onto_the_class": """
def remember(flow):
    type.__setattr__(type(flow), "_agui_declined", True)
""",
    "a_read_of_the_flow": """
def observe(flow):
    return flow._agui_binding
""",
    # A local of the function's own making. Nothing the caller handed in is written,
    # so no state outlives the call.
    "a_write_onto_a_local": """
def install(binding):
    holder = object()
    holder._agui_binding = binding
    return holder
""",
}


def _synthetic_module(tmp_path, name, source):
    module = tmp_path / f"{name}.py"
    module.write_text(source)
    return module


@pytest.mark.parametrize("shape", sorted(INSTALL_SHAPES))
def test_the_walk_finds_each_shape_of_install_site(shape, tmp_path):
    """Each way a function can write onto the object it was handed."""
    module = _synthetic_module(tmp_path, shape, INSTALL_SHAPES[shape])

    assert production_install_sites(module), f"the walk missed {shape}"


@pytest.mark.parametrize("shape", sorted(NON_INSTALL_SHAPES))
def test_the_walk_is_not_a_check_that_matches_everything(shape, tmp_path):
    """The refusals above would prove nothing if every function were a site."""
    module = _synthetic_module(tmp_path, shape, NON_INSTALL_SHAPES[shape])

    assert production_install_sites(module) == set(), (
        f"the walk called {shape} an install site"
    )


def test_a_shared_signal_is_never_silently_reused_across_runs():
    """One ``AbandonmentSignal`` per run is the identity the gates key on.

    If two runs could share one, every gate that reads it conflates them, and no
    amount of rebinding elsewhere helps.
    """
    # References are held for the whole loop: comparing ids of objects that were
    # already collected would compare addresses CPython has since reused.
    signals = []
    observed = []
    flow = _PlainFlow()
    flow.persistence = _PerRunSpyPersistence()
    for label in ("turn one", "turn two", "turn three"):
        signal = AbandonmentSignal()
        signals.append(signal)
        overlay_conversational_persistence(
            flow, _run_inputs(label), abandonment=signal
        )
        observed.append(flow.persistence.agui_run)
    assert observed == signals
    assert len({id(signal) for signal in observed}) == 3


def test_the_gate_binding_lock_is_not_shared_between_runs():
    """Each run's drop bookkeeping is its own, so counts cannot bleed across.

    The dedup counters live on the binding; sharing them would make run two's
    first dropped write log at DEBUG because run one already logged the WARNING.
    """
    flow = _PlainFlow()
    flow.persistence = _PerRunSpyPersistence()
    first_signal = AbandonmentSignal()
    overlay_conversational_persistence(
        flow, _run_inputs("turn one"), abandonment=first_signal
    )
    first_signal.abandon()
    flow.persistence.save_state("thread-shared", "dropped", {})
    assert flow.persistence._agui_gate().drops == {"state write": 1}

    second_signal = AbandonmentSignal()
    overlay_conversational_persistence(
        flow, _run_inputs("turn two"), abandonment=second_signal
    )

    assert flow.persistence._agui_gate().drops == {}
    assert isinstance(flow.persistence._agui_gate().lock, type(threading.Lock()))
