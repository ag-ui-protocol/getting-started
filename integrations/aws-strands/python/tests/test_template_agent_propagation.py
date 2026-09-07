"""Tests that every Strands Agent __init__ param round-trips to per-thread instances.

Driven by inspect.signature so new Strands params are covered automatically.

Two rules keep this suite honest, both learned the hard way:

* It never skips. A param this suite cannot exercise is a param that would be
  dropped in production without anyone noticing, so an unexercisable param
  fails here instead. The previous version skipped whenever the template
  rejected its sentinel, and that skip is what hid a silently-dropped param
  through several Strands releases.
* It never narrows to a fixed list of params. Discovery off the constructor
  signature is the only reason the gap was ever found; a curated list would
  only ever cover the params someone already knew about.
"""

from __future__ import annotations

import enum
import functools
import inspect
import logging
import types
import typing
import warnings
import weakref
from unittest.mock import MagicMock, patch

import pytest
from strands import Agent
from strands.tools.registry import ToolRegistry

from ag_ui_strands.agent import (
    StrandsAgent,
    _AGUI_EXPLICIT_PARAMS,
    _STRANDS_ACCEPTS_PLUGINS,
    _template_plugin_names,
    _extract_agent_kwargs,
    _forwardable_parameters,
    _references_agent,
    _registry_contents,
    _resolve_template_param,
    _AGENT_BOUND,
    _MISSING,
)


# Only the one test below that drives a real ``strands.Agent`` with a real
# plugin needs the SDK's plugin system. Everything else here exercises the
# adapter's own reading, reporting and forwarding, which are the adapter's
# code on every release, so those tests run at the declared strands-agents
# floor too. Keeping the gate that narrow is deliberate: a skip at the floor
# is a version of this package nobody checked.
try:
    from strands.plugins import Plugin as _StrandsPlugin
except ImportError:  # pragma: no cover - depends on the installed SDK
    _StrandsPlugin = None

_needs_sdk_plugins = pytest.mark.skipif(
    _StrandsPlugin is None or not _STRANDS_ACCEPTS_PLUGINS,
    reason="this strands-agents release has no plugin system to drive",
)
# Subclassable stand-in so the plugin class below still imports on a release
# without them. The single test that touches it is skipped there.
_PluginBase = _StrandsPlugin if _StrandsPlugin is not None else object


def _mock_model():
    m = MagicMock()
    m.stateful = False
    return m


def _run_input(thread_id: str = "t1"):
    from ag_ui.core import RunAgentInput, UserMessage

    return RunAgentInput(
        thread_id=thread_id,
        run_id="r1",
        state={},
        messages=[UserMessage(id="u1", content="hello")],
        tools=[],
        context=[],
        forwarded_props={},
    )


class _CapturingCore:
    def __init__(self, **kwargs):
        self.init_kwargs = kwargs
        self.tool_registry = ToolRegistry()

    async def stream_async(self, _msg: str):
        if False:
            yield


async def _trigger_thread_creation(ag: StrandsAgent, thread_id: str) -> _CapturingCore:
    stream = ag.run(_run_input(thread_id))
    try:
        async for _ in stream:
            break
    finally:
        await stream.aclose()
    assert thread_id in ag._agents_by_thread, (
        f"no per-thread agent was built for {thread_id}; the run ended before "
        f"construction, so this test would assert nothing"
    )
    return ag._agents_by_thread[thread_id]


# ---------------------------------------------------------------------------
# Sentinel synthesis
# ---------------------------------------------------------------------------
#
# A bare MagicMock is rejected by any param Strands type-checks, which used to
# mean "skip". Instead, build a value that satisfies the param's annotation, so
# the template accepts it and the round-trip is genuinely asserted. Driven off
# the annotation rather than the param name, so a new param of a known shape is
# covered without editing this file.


class _Unsynthesizable(Exception):
    """No value satisfying this annotation could be constructed."""


def _is_declared_dict_shape(annotation: typing.Any) -> bool:
    """Whether the annotation is a dict with declared keys (a TypedDict).

    Checked structurally rather than with ``typing.is_typeddict``, which does
    not recognise one declared through ``typing_extensions``.
    """
    return hasattr(annotation, "__required_keys__") or hasattr(
        annotation, "__optional_keys__"
    )


def _synthesize(annotation: typing.Any, label: str) -> typing.Any:
    """Build a value satisfying ``annotation``, tagged with ``label``."""
    if annotation is inspect.Parameter.empty or annotation is typing.Any:
        return MagicMock(name=f"sentinel-{label}")

    origin = typing.get_origin(annotation)
    args = typing.get_args(annotation)

    if origin is typing.Literal:
        if not args:
            raise _Unsynthesizable(f"empty Literal for {label}")
        return args[0]

    # Python 3.10-3.13 report `X | None` as types.UnionType and `Union[X, None]`
    # as typing.Union; 3.14 merged them. Accept both or every optional param
    # goes unsynthesized on the older interpreters.
    if origin is typing.Union or origin is types.UnionType:
        candidates = []
        for arg in args:
            if arg is type(None):
                continue
            try:
                candidates.append(_synthesize(arg, label))
            except _Unsynthesizable:
                continue
        if not candidates:
            raise _Unsynthesizable(f"no satisfiable member of {annotation} for {label}")
        # Prefer a plain value: Strands normalizes some params on the way in
        # (wrapping a dict in a container, say) and a plain value survives that
        # where a stand-in does not. Otherwise keep annotation order, because
        # the first member is the type the param actually validates against;
        # reordering picks a sibling sentinel class the constructor rejects.
        for candidate in candidates:
            if isinstance(candidate, (dict, list, tuple, str, bool, int, float)):
                return candidate
        return candidates[0]

    if origin is type:
        # e.g. ``type[BaseModel]`` wants the class itself, not an instance.
        base = args[0] if args else object
        if not isinstance(base, type):
            raise _Unsynthesizable(f"non-class type arg {base!r} for {label}")
        return type(f"Sentinel_{label}", (base,), {})

    if origin in (list, typing.List):
        return [_synthesize(args[0], label) if args else MagicMock()]
    if origin in (tuple, typing.Tuple):
        return (_synthesize(args[0], label) if args else MagicMock(),)
    if origin in (dict, typing.Dict) or (
        origin is not None and "Mapping" in str(origin)
    ):
        return {"sentinel": label}
    if origin is not None and (
        "Sequence" in str(origin) or "Iterable" in str(origin)
    ):
        return [_synthesize(args[0], label) if args else MagicMock()]
    if origin is not None and "Callable" in str(origin):
        return MagicMock(name=f"sentinel-{label}")

    if annotation is bool:
        # Returned by the caller below only after checking it differs from the
        # param's default; a sentinel equal to the default proves nothing.
        return True
    if annotation is str:
        return f"sentinel-{label}"
    if annotation is int:
        return 7
    if annotation is float:
        return 7.5
    if annotation is dict:
        return {"sentinel": label}
    if annotation is list:
        return [MagicMock(name=f"sentinel-{label}")]

    if _is_declared_dict_shape(annotation):
        # A declared dict shape is a config the SDK splats into a real
        # constructor, so a dict of invented keys satisfies the annotation and
        # then fails the call it feeds. Faithfully filling one means building
        # whatever its fields reference, which is unbounded. Decline, so a
        # union falls through to the member that can be built directly.
        raise _Unsynthesizable(f"declared dict shape {annotation!r} for {label}")

    if isinstance(annotation, type):
        if issubclass(annotation, enum.Enum):
            members = list(annotation)
            if not members:
                raise _Unsynthesizable(f"empty enum for {label}")
            return members[0]
        # Some params are validated by exact type, which rejects both a spec'd
        # MagicMock and a subclass instance, so try the annotated class itself
        # first and only then widen. Each step is skipped when the class cannot
        # be built that way.
        for build in (
            lambda: annotation(),
            lambda: type(f"Sentinel_{label}", (annotation,), {})(),
        ):
            try:
                return build()
            except Exception:  # noqa: BLE001 - not every class default-constructs
                continue
        # spec= makes the mock pass isinstance checks against the annotation.
        return MagicMock(spec=annotation, name=f"sentinel-{label}")

    raise _Unsynthesizable(f"unhandled annotation {annotation!r} for {label}")


@functools.lru_cache(maxsize=1)
def _annotations() -> dict:
    """Resolved annotations for Agent.__init__, falling back to raw ones.

    get_type_hints evaluates string annotations and raises NameError when the
    SDK's own module namespace does not export a name it references. That is
    the SDK's business, not a reason to fail here, but the fallback hands back
    unresolved annotations that behave differently, so say so rather than
    degrading silently.
    """
    try:
        return typing.get_type_hints(Agent.__init__)
    except Exception as e:  # noqa: BLE001 - any resolution failure degrades the same way
        warnings.warn(
            f"could not resolve Agent.__init__ annotations ({type(e).__name__}: {e}); "
            f"falling back to raw annotations, which resolve unions differently",
            stacklevel=2,
        )
        return {
            n: p.annotation
            for n, p in inspect.signature(Agent.__init__).parameters.items()
        }


def _discover_forwardable_params() -> list[str]:
    """Every Agent.__init__ param the adapter is expected to auto-forward.

    Taken from the adapter's own list so the suite cannot drift from what the
    code iterates. Only params handled by an explicit, separately-tested route
    are excluded. Nothing is excluded for being awkward to test.
    """
    return [name for name, _ in _forwardable_parameters()]


def _unwrap_container(value: typing.Any) -> typing.Any:
    """Mirror the adapter's own unwrapping of Strands state containers.

    Strands wraps some params in a container on the way in (``state`` becomes
    an ``AgentState``), and the adapter unwraps it again to hand the plain
    value back to the next constructor. Comparing the wrappers would compare
    two distinct container objects that hold identical contents.
    """
    if isinstance(value, (dict, list, tuple, str)):
        return value
    if isinstance(value, MagicMock):
        # A mock answers every attribute, so duck-typing .get() here would
        # "unwrap" a sentinel into an unrelated child mock and compare that.
        return value
    get = getattr(value, "get", None)
    if callable(get):
        try:
            return get()
        except TypeError:
            return value
    return value


def _same_value(expected: typing.Any, actual: typing.Any) -> bool:
    """Identity for scalars, element-wise identity for containers.

    Registry-backed params cannot preserve container identity: a registry keeps
    its contents in its own collection, so any accessor hands back a fresh list
    no matter how it is read. The container is an implementation detail of the
    handoff; what the constructor consumes is the elements, so element identity
    is the invariant worth asserting. Requiring container identity here would
    only be satisfiable by reaching past the registry's own accessor, which
    would make this suite depend on a private field layout Strands is free to
    change without notice.
    """
    if expected is actual:
        return True
    expected = _unwrap_container(expected)
    actual = _unwrap_container(actual)
    if expected is actual:
        return True
    if isinstance(expected, (list, tuple)) and isinstance(actual, (list, tuple)):
        return len(expected) == len(actual) and all(
            e is a for e, a in zip(expected, actual)
        )
    if isinstance(expected, dict) and isinstance(actual, dict):
        # Value equality, not element identity: a dict-valued param is
        # serialized and rebuilt on the way into the new agent, so the entries
        # are equal rather than the same objects.
        return expected == actual
    return expected == actual


def _distinguishable_sentinel(param_name: str) -> typing.Any:
    """A value for ``param_name`` that differs from the param's own default.

    A sentinel that happens to equal the default (``True`` for a bool that
    already defaults to ``True``) makes the round-trip assertion pass whether
    or not the setting survived, which is the failure mode this suite exists
    to prevent.
    """
    annotation = _annotations().get(param_name, inspect.Parameter.empty)
    try:
        sentinel = _synthesize(annotation, param_name)
    except _Unsynthesizable as e:
        pytest.fail(
            f"{param_name}: could not build a value satisfying {annotation!r} ({e}). "
            f"A param this suite cannot exercise is a param that can be dropped "
            f"without the suite noticing -- teach _synthesize this shape."
        )

    default = inspect.signature(Agent.__init__).parameters[param_name].default
    if isinstance(sentinel, bool) and sentinel == default:
        sentinel = not sentinel
    literal_args = typing.get_args(_annotations().get(param_name))
    if (
        typing.get_origin(_annotations().get(param_name)) is typing.Literal
        and sentinel == default
    ):
        other = next((a for a in literal_args if a != default), None)
        if other is None:
            pytest.fail(
                f"{param_name}: the Literal has only one value, so nothing can "
                f"distinguish a forwarded setting from the default."
            )
        sentinel = other
    if isinstance(sentinel, enum.Enum) and sentinel == default:
        other = next((m for m in type(sentinel) if m != default), None)
        if other is None:
            pytest.fail(
                f"{param_name}: {type(sentinel).__name__} has only one member, so no "
                f"value can distinguish a forwarded setting from the default."
            )
        sentinel = other
    if sentinel == default and isinstance(sentinel, (int, float, str)):
        pytest.fail(
            f"{param_name}: synthesized sentinel {sentinel!r} equals the param's "
            f"default, so the round-trip assertion cannot fail. Teach "
            f"_distinguishable_sentinel this shape."
        )
    return sentinel


@pytest.mark.parametrize("param_name", _discover_forwardable_params())
def test_template_param_round_trips(param_name):
    """A value set on the template must reach the per-thread agent.

    Reaching it is asserted two ways: the extracted kwargs carry the value, and
    a real per-thread Agent built from those kwargs resolves the param to the
    same value the template does. The second check is what makes facade params
    pass honestly -- a param Strands resolves into *other* params never appears
    in the kwargs under its own name, but its effect still has to survive.
    """
    sentinel = _distinguishable_sentinel(param_name)

    try:
        template = Agent(model=_mock_model(), **{param_name: sentinel})
    except (TypeError, ValueError) as e:
        pytest.fail(
            f"{param_name}: template rejected a value synthesized for its own "
            f"annotation ({e}). Either the annotation is wrong or _synthesize "
            f"needs to handle this shape; skipping here is what let a "
            f"silently-dropped param survive."
        )

    kwargs, unreadable, template_owned = _extract_agent_kwargs(template)

    # The bar: a setting either reaches the per-thread agent, or the adapter
    # accounts for it by name. Silent loss is the defect. Returning here without
    # asserting anything would let a forwarding regression pass as "reported",
    # so assert the report actually names it and says which kind it is.
    if param_name in unreadable:
        assert param_name not in kwargs, (
            f"{param_name}: reported unreadable yet still forwarded; the report "
            f"and the kwargs disagree."
        )
        return
    if param_name in template_owned:
        assert param_name not in kwargs, (
            f"{param_name}: reported as owned by the template yet still forwarded, "
            f"which is the cross-wiring the report claims to prevent."
        )
        return

    # Compare against the value handed to the template, never the resolver's
    # own answer for the template. Resolver-against-resolver only proves the
    # two sides agree, so a resolver reading the wrong attribute passes as long
    # as it reads the same wrong attribute twice.
    assert _same_value(sentinel, kwargs.get(param_name, _MISSING)), (
        f"{param_name}: set {sentinel!r} on the template but the per-thread "
        f"kwargs carry {kwargs.get(param_name, _MISSING)!r}."
    )

    clone = Agent(
        model=template.model,
        system_prompt=template.system_prompt,
        tools=list(template.tool_registry.registry.values()),
        **kwargs,
    )

    # Pass the annotation, as the adapter does; without it the type check that
    # guards real forwarding is skipped and this reads a different code path.
    annotation = _annotations().get(param_name, inspect.Parameter.empty)
    rebuilt = _resolve_template_param(clone, param_name, annotation)
    assert _same_value(sentinel, rebuilt), (
        f"{param_name}: set {sentinel!r} on the template but the rebuilt agent "
        f"resolves to {rebuilt!r}."
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("param_name", _discover_forwardable_params())
async def test_template_param_reaches_thread_agent_kwargs(param_name):
    """The forwarded value is actually handed to the per-thread constructor.

    Covers the wiring between extraction and construction, which the pure
    extraction test above cannot see.
    """
    sentinel = _distinguishable_sentinel(param_name)
    template = Agent(model=_mock_model(), **{param_name: sentinel})

    ag = StrandsAgent(template, name="test")
    if param_name in ag._unforwardable_params:
        assert param_name not in ag._agent_kwargs, (
            f"{param_name}: reported as unforwardable yet present in the kwargs "
            f"handed to every per-thread agent."
        )
        return

    with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
        instance = await _trigger_thread_creation(ag, f"thread-{param_name}")

    assert param_name in instance.init_kwargs, (
        f"{param_name}: recovered from the template but never handed to the "
        f"per-thread constructor. got kwargs={list(instance.init_kwargs)}"
    )
    assert _same_value(sentinel, instance.init_kwargs[param_name]), (
        f"{param_name}: set {sentinel!r} on the template but the per-thread agent "
        f"was built with {instance.init_kwargs[param_name]!r}."
    )


@pytest.mark.asyncio
async def test_no_constructor_param_is_dropped_silently(caplog):
    """Every constructor param is forwarded, handled explicitly, or announced.

    This is the check that would have caught the original defect. When Strands
    adds a param the adapter cannot carry across, the adapter has to say so;
    what it must never do is drop it without a word.

    The saying happens when the first per-thread agent is built rather than at
    construction, because ``thread_agent_kwargs`` can supply any of these and
    at construction it has not run.
    """
    template = Agent(model=_mock_model())
    ag = StrandsAgent(template, name="test")

    with caplog.at_level(logging.WARNING, logger="ag_ui_strands.agent"):
        with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
            await _trigger_thread_creation(ag, "t1")

    accounted = (
        set(ag._agent_kwargs) | set(ag._unforwardable_params) | _AGUI_EXPLICIT_PARAMS
    )
    # Anything not accounted for has to be genuinely absent from the template.
    # Judged by reading the attributes directly rather than by asking the
    # resolver again: using the code under test as its own oracle would make
    # this pass for any resolver, including one that reads nothing at all.
    unaccounted = [
        name for name, _ in _forwardable_parameters() if name not in accounted
    ]
    still_present = [
        name
        for name in unaccounted
        if any(
            getattr(template, attr, None) is not None
            for attr in (name, f"_{name}", f"_default_{name}")
        )
    ]
    assert still_present == [], (
        f"these params hold a value on the template but are neither forwarded "
        f"nor reported: {still_present}."
    )

    # Both kinds have to be named in a warning: either way the setting does
    # not reach the agents that serve requests, and silence is the defect this
    # suite exists to catch. They are still kept apart, because they point the
    # caller at different fixes.
    for param in ag._unreadable_params:
        assert any(param in m for m in caplog.messages), (
            f"{param} could not be read off the template but was never named in "
            f"a warning; got {caplog.messages}"
        )
    for param in ag._template_owned_params:
        assert param in ag._unforwardable_params, (
            f"{param} is owned by the template but is not recorded as unforwardable"
        )
        assert any(param in m for m in caplog.messages), (
            f"{param} is wired to the template and cannot be carried, but the "
            f"caller was never told; got {caplog.messages}"
        )
    assert not set(ag._template_owned_params) & set(ag._unreadable_params), (
        "a param cannot be both unreadable and read-but-template-owned"
    )


def test_excluded_params_never_forwarded():
    """Params in _AGUI_EXPLICIT_PARAMS are handled elsewhere and must never
    appear in the generic _agent_kwargs forwarding path."""
    template = Agent(model=_mock_model())
    ag = StrandsAgent(template, name="test")
    for p in _AGUI_EXPLICIT_PARAMS - {"self"}:
        assert p not in ag._agent_kwargs, f"{p} leaked into _agent_kwargs"


@pytest.mark.asyncio
async def test_template_session_manager_is_dropped_and_warns(caplog):
    """Template-level session_manager is the known footgun: drop it, warn loudly."""
    session_manager = MagicMock(name="session_manager")
    template = Agent(model=_mock_model(), session_manager=session_manager)

    with caplog.at_level(logging.WARNING, logger="ag_ui_strands.agent"):
        ag = StrandsAgent(template, name="test")

    assert any("session_manager_provider" in m for m in caplog.messages), (
        f"expected a warning pointing to session_manager_provider; got {caplog.messages}"
    )
    assert "session_manager" not in ag._agent_kwargs

    with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
        instance = await _trigger_thread_creation(ag, "t1")

    # #798's explicit kwarg should be None since no provider is configured.
    assert instance.init_kwargs.get("session_manager") is None


def test_template_session_manager_no_warning_when_provider_set(caplog):
    """With a provider configured, the warning should NOT fire."""
    from ag_ui_strands.config import StrandsAgentConfig

    session_manager = MagicMock(name="session_manager")
    template = Agent(model=_mock_model(), session_manager=session_manager)
    config = StrandsAgentConfig(session_manager_provider=lambda _inp: MagicMock())

    with caplog.at_level(logging.WARNING, logger="ag_ui_strands.agent"):
        StrandsAgent(template, name="test", config=config)

    assert not any("session_manager_provider" in m for m in caplog.messages), (
        f"unexpected warning: {caplog.messages}"
    )


# ---------------------------------------------------------------------------
# Storage-convention coverage
# ---------------------------------------------------------------------------
#
# The conventions below are exercised against synthetic agents rather than a
# real one, because which convention Strands uses for which param changes
# between releases. Asserting them directly keeps the coverage stable across
# the supported Strands range instead of depending on whichever params happen
# to use each convention in the installed version.


def test_resolves_underscore_prefixed_attribute():
    """Strands keeps some init params at ``self._<name>``."""
    sentinel = object()
    fake = type("FakeAgent", (), {})()
    fake._retry_strategy = sentinel
    assert _resolve_template_param(fake, "retry_strategy") is sentinel


def test_reads_a_list_backed_registry_through_its_public_accessor():
    """A registry exposing a public accessor is read through it.

    The accessor returns a fresh list, so the recovered container is a
    different object; the elements are what the constructor consumes and they
    keep their identity.
    """

    class Registry:
        def __init__(self, handlers):
            self._handlers = handlers

        @property
        def handlers(self):
            return list(self._handlers)

    handler = object()
    fake = type("FakeAgent", (), {})()
    fake._intervention_registry = Registry([handler])

    recovered = _resolve_template_param(fake, "interventions")
    assert recovered == [handler]
    assert recovered[0] is handler


def test_reads_a_dict_backed_registry_from_its_backing_field():
    """A registry with no public accessor falls back to its backing field.

    Dict-backed registries are keyed by name; the values are what the
    constructor takes.
    """

    class Registry:
        def __init__(self, plugins):
            self._plugins = plugins

    plugin = object()
    fake = type("FakeAgent", (), {})()
    fake._plugin_registry = Registry({"p": plugin})

    recovered = _resolve_template_param(fake, "plugins")
    assert recovered == [plugin]
    assert recovered[0] is plugin


def test_registry_holding_the_agent_is_not_forwarded():
    """A registry that keeps a reference to its own agent must not be shared.

    Registration hands the owning agent to whatever the registry holds, so its
    contents are wired to that agent and cannot serve a second one.
    """
    import weakref

    param = _first_forwardable_param()
    singular = param[:-1] if param.endswith("s") else param

    class OwnedRegistry:
        def __init__(self, owner, contents):
            self._agent_ref = weakref.ref(owner)
            self._contents = contents

    fake = type("FakeAgent", (), {})()
    setattr(fake, f"_{singular}_registry", OwnedRegistry(fake, [object()]))

    assert _resolve_template_param(fake, param) is _AGENT_BOUND


def test_registry_holding_an_unrelated_agent_is_still_forwarded():
    """The reference has to be to THIS agent, not to any agent at all.

    A registry that happens to hold a weak reference to something else is not
    evidence that its contents belong to the template.
    """
    import weakref

    param = _first_forwardable_param()
    singular = param[:-1] if param.endswith("s") else param
    contents = [object()]

    class Unrelated:
        pass

    stranger = Unrelated()

    class RegistryWithAStrangerRef:
        def __init__(self):
            self._cache_ref = weakref.ref(stranger)
            self._contents = contents

    fake = type("FakeAgent", (), {})()
    setattr(fake, f"_{singular}_registry", RegistryWithAStrangerRef())

    assert _resolve_template_param(fake, param) == contents


def test_registry_contents_of_the_wrong_type_are_not_forwarded():
    """Probing matches on where a value sits, which is a guess.

    A registry exposing some unrelated collection must not be handed to the
    constructor as though it were the parameter.
    """
    param = "interventions"
    singular = param[:-1]

    class RegistryWithCounts:
        def __init__(self):
            self._counts = [0, 1, 2]

    class Handler:
        pass

    fake = type("FakeAgent", (), {})()
    setattr(fake, f"_{singular}_registry", RegistryWithCounts())

    assert _resolve_template_param(fake, param, list[Handler]) is _MISSING


def test_unrecoverable_param_is_reported_not_dropped():
    """A param stored under no recognised convention is named, not swallowed."""

    class Hidden:
        """Holds the value somewhere no convention reaches."""

    fake = type("FakeAgent", (), {})()
    fake._utterly_unrelated_name = Hidden()

    assert _resolve_template_param(fake, "interventions") is _MISSING


def test_extraction_reports_every_param_it_cannot_read():
    """Params that resolve to nothing come back named, not quietly skipped.

    Driven against a bare object so it holds on any Strands version, including
    ones where every real param happens to be recoverable. Without this, the
    reporting path is only exercised by whichever SDK release happens to have
    an unreadable param, which is precisely the coverage gap that let the
    original defect through.
    """
    kwargs, unreadable, template_owned = _extract_agent_kwargs(object())

    expected = [name for name, _ in _forwardable_parameters()]
    assert kwargs == {}
    assert template_owned == []
    assert unreadable == expected, (
        "every unreadable param must be reported; "
        f"missing {sorted(set(expected) - set(unreadable))}"
    )


def _first_forwardable_param() -> str:
    """A real constructor param name, so these tests bind to the live signature."""
    name = next(iter(_discover_forwardable_params()), None)
    assert name, "Agent.__init__ has no forwardable params; test premise broken"
    return name


def test_varargs_are_not_treated_as_forwardable_params():
    """``*args`` / ``**kwargs`` are not settings a caller puts on a template.

    Reported as unreadable they would produce a permanent warning naming
    something nobody can set. Patched in rather than read off the live SDK,
    which currently declares neither, so the rule holds whenever one appears.
    """

    class AgentWithVarargs:
        def __init__(self, model=None, *args, temperature=None, **kwargs):
            pass

    with patch("ag_ui_strands.agent.StrandsAgentCore", AgentWithVarargs):
        names = [name for name, _ in _forwardable_parameters()]

    assert "temperature" in names, "a real keyword param should still be covered"
    assert "args" not in names and "kwargs" not in names, (
        f"varargs must not be treated as forwardable settings; got {names}"
    )


def test_extraction_separates_unreadable_from_template_owned():
    """The two failure kinds must not collapse into one another.

    They get different treatment: unreadable means this adapter has a gap and
    the caller is warned, template-owned means the SDK wired the value to one
    agent and the caller is not. Reporting either as the other misinforms.

    Driven against a synthetic agent because which params are registry-backed
    changes between Strands releases, and on some of them none are.
    """
    import weakref

    param = _first_forwardable_param()
    singular = param[:-1] if param.endswith("s") else param

    class OwnedRegistry:
        def __init__(self, owner, contents):
            self._agent_ref = weakref.ref(owner)
            self._contents = contents

    fake = type("FakeAgent", (), {})()
    # The reference must point at this agent; that is what makes the contents
    # its property rather than something merely cached nearby.
    setattr(fake, f"_{singular}_registry", OwnedRegistry(fake, [object()]))

    kwargs, unreadable, template_owned = _extract_agent_kwargs(fake)

    assert param in template_owned, (
        f"{param} is wired to its agent but was not recorded as template-owned"
    )
    assert param not in unreadable, (
        f"{param} was read successfully; reporting it as unreadable would send "
        f"the caller after a gap that does not exist"
    )
    assert param not in kwargs, f"{param} is template-owned but was forwarded anyway"


def test_none_valued_attribute_does_not_mask_a_later_convention():
    """A param exposed as None before it is populated must not end the search.

    Strands sometimes declares an attribute under the param's own name and
    fills the value in elsewhere. Stopping at the None would drop a setting the
    caller did make.
    """
    param = _first_forwardable_param()
    sentinel = object()

    fake = type("FakeAgent", (), {})()
    setattr(fake, param, None)
    setattr(fake, f"_{param}", sentinel)

    assert _resolve_template_param(fake, param) is sentinel, (
        f"{param}: a None under the public name masked the value under _{param}"
    )


@pytest.mark.asyncio
async def test_unforwardable_params_are_named_when_a_thread_is_built(caplog):
    """The adapter says so rather than failing silently.

    Said when the first per-thread agent is built, not at construction: a
    caller can supply any of these through ``thread_agent_kwargs``, and at
    construction that hook has not run, so warning then would nag a caller who
    had already handled it.
    """
    template = Agent(model=_mock_model())

    with patch(
        "ag_ui_strands.agent._extract_agent_kwargs",
        return_value=({}, ["some_new_param"], []),
    ):
        ag = StrandsAgent(template, name="test")

    assert ag._unforwardable_params == ["some_new_param"]

    with caplog.at_level(logging.WARNING, logger="ag_ui_strands.agent"):
        with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
            await _trigger_thread_creation(ag, "t1")

    assert any("some_new_param" in m for m in caplog.messages), (
        f"expected the unforwardable param to be named; got {caplog.messages}"
    )


@pytest.mark.asyncio
async def test_later_thread_that_omits_a_param_is_still_warned(caplog):
    """One-shot has to mean per param, not per adapter.

    A thread that supplies everything must not buy silence for a thread that
    supplies nothing: the second thread really does lose those settings.
    """
    from ag_ui_strands.config import StrandsAgentConfig

    template = Agent(model=_mock_model())
    config = StrandsAgentConfig(
        thread_agent_kwargs=lambda inp: (
            {"some_new_param": "supplied"} if inp.thread_id == "supplies" else {}
        )
    )

    with patch(
        "ag_ui_strands.agent._extract_agent_kwargs",
        return_value=({}, ["some_new_param"], []),
    ):
        ag = StrandsAgent(template, name="test", config=config)

    with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
        await _trigger_thread_creation(ag, "supplies")
        with caplog.at_level(logging.WARNING, logger="ag_ui_strands.agent"):
            await _trigger_thread_creation(ag, "omits")

    assert any("some_new_param" in m for m in caplog.messages), (
        f"the thread that omitted it was told nothing; got {caplog.messages}"
    )


@pytest.mark.asyncio
async def test_a_param_is_only_warned_about_once(caplog):
    """The other half of one-shot: two threads that both omit it hear once."""
    template = Agent(model=_mock_model())

    with patch(
        "ag_ui_strands.agent._extract_agent_kwargs",
        return_value=({}, ["some_new_param"], []),
    ):
        ag = StrandsAgent(template, name="test")

    def mentions() -> int:
        # Only the message under test: the fake core logs unrelated warnings
        # of its own, and counting those would measure the stub, not the rule.
        return sum("some_new_param" in m for m in caplog.messages)

    with caplog.at_level(logging.WARNING, logger="ag_ui_strands.agent"):
        with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
            await _trigger_thread_creation(ag, "first")
            after_first = mentions()
            await _trigger_thread_creation(ag, "second")

    assert after_first == 1, (
        f"expected the first thread to be told once; got {caplog.messages}"
    )
    assert mentions() == after_first, (
        f"warned twice about the same param; got {caplog.messages}"
    )


@pytest.mark.asyncio
async def test_no_warning_for_a_param_the_hook_supplies(caplog):
    """Acting on the warning has to make it stop.

    A message that keeps arriving after the caller has done what it asked
    teaches them to ignore it.
    """
    from ag_ui_strands.config import StrandsAgentConfig

    template = Agent(model=_mock_model())
    config = StrandsAgentConfig(
        thread_agent_kwargs=lambda _input: {"some_new_param": "supplied"}
    )

    with patch(
        "ag_ui_strands.agent._extract_agent_kwargs",
        return_value=({}, ["some_new_param", "another_param"], []),
    ):
        ag = StrandsAgent(template, name="test", config=config)

    with caplog.at_level(logging.WARNING, logger="ag_ui_strands.agent"):
        with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
            await _trigger_thread_creation(ag, "t1")

    said = "\n".join(caplog.messages)
    assert "some_new_param" not in said, (
        f"warned about a param the hook supplied; got {caplog.messages}"
    )
    # The one it did not supply is still named.
    assert "another_param" in said, (
        f"expected the unsupplied param to be named; got {caplog.messages}"
    )


# ---------------------------------------------------------------------------
# plugins
# ---------------------------------------------------------------------------
#
# ``plugins`` is the param that motivated splitting the two warnings. Strands
# consumes the list during construction: it runs each plugin's ``init_agent``
# against the agent that received it and registers the plugin's hooks and
# tools into that agent's registries, keeping only a registry bound back to
# it. Nothing can be read off the template and nothing can be handed to a
# second agent, so a plugin set on the template never runs against the agents
# that serve requests. The adapter answers that with a dedicated kwarg, and
# tells anyone who used the template instead.
#
# Most of what follows is the adapter reading, reporting and forwarding, none
# of which needs a real plugin. Those tests use a synthetic registry and plain
# sentinels, the way the resolver tests above already do, so they run on every
# supported release rather than only the ones new enough to have plugins.


class _FakePluginRegistry:
    """A plugin registry in the shape the adapter reads.

    Bound to its agent by weak reference and keyed by plugin name, which is
    what a real ``_PluginRegistry`` is. Built here rather than by constructing
    a real Agent with plugins so these tests still run at the declared
    strands-agents floor, which has no plugin system at all.
    """

    def __init__(self, owner, plugins: dict):
        self._agent_ref = weakref.ref(owner)
        self._plugins = dict(plugins)


class _NamedPlugin:
    """The only thing the adapter reads off a plugin is its name."""

    def __init__(self, name: str):
        self.name = name


def _template_with_plugins(*names: str):
    """A real Agent carrying a registry of caller plugins under those names."""
    agent = Agent(model=_mock_model())
    agent._plugin_registry = _FakePluginRegistry(
        agent, {name: _NamedPlugin(name) for name in names}
    )
    return agent


def _plugin_warnings(messages: list[str]) -> list[str]:
    return [m for m in messages if "plugins" in m]


def _as_if_sdk_took_plugins():
    """Assert the forwarding on a release whose real Agent would refuse it.

    The per-thread core is a stub in these tests, and a stub takes any kwarg.
    What stands between them and running at the declared floor is the wrap-time
    capability check, so declaring the capability is the whole adaptation. It
    says out loud what the stub already assumes, which is better than skipping
    and leaving the adapter's own forwarding logic unasserted on that release.
    """
    return patch("ag_ui_strands.agent._STRANDS_ACCEPTS_PLUGINS", True)


@pytest.mark.asyncio
async def test_template_plugins_are_named_when_a_thread_is_built(caplog):
    """The silence this closes: plugins on the template, and no plugins anywhere.

    The template never serves a request, so its plugins never run. Before this
    the caller got neither the behaviour nor a word about losing it, which is
    the worst of the two failure modes: nothing to notice and nothing to
    search for.
    """
    ag = StrandsAgent(_template_with_plugins("mine"), name="test")

    with caplog.at_level(logging.WARNING, logger="ag_ui_strands.agent"):
        with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
            await _trigger_thread_creation(ag, "t1")

    assert _plugin_warnings(caplog.messages), (
        f"plugins were set on the template and dropped without a word; "
        f"got {caplog.messages}"
    )


@pytest.mark.asyncio
async def test_an_agent_with_no_caller_plugins_says_nothing(caplog):
    """Strands registers plugins of its own on every Agent.

    Counting those would warn every caller about a setting nobody made, and a
    warning everybody gets is one nobody reads. This is the assertion that
    keeps the message rare enough to be worth reading.
    """
    template = Agent(model=_mock_model())
    ag = StrandsAgent(template, name="test")

    with caplog.at_level(logging.WARNING, logger="ag_ui_strands.agent"):
        with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
            await _trigger_thread_creation(ag, "t1")

    assert not _plugin_warnings(caplog.messages), (
        f"warned about plugins on an agent the caller gave none; "
        f"got {caplog.messages}"
    )


def test_the_sdks_own_plugins_are_not_read_as_the_callers():
    """The filter that keeps the warning off every caller, asserted directly.

    Driven against a synthetic registry so it states the rule rather than
    whichever built-ins the installed release happens to register.
    """
    agent = Agent(model=_mock_model())
    agent._plugin_registry = _FakePluginRegistry(
        agent,
        {"strands:model": _NamedPlugin("strands:model"), "mine": _NamedPlugin("mine")},
    )

    assert _template_plugin_names(agent) == ["mine"], (
        "expected only the caller's plugin to be reported as uncarried"
    )


@pytest.mark.asyncio
async def test_no_plugins_warning_when_the_explicit_kwarg_supplies_them(caplog):
    """Acting on the warning has to make it stop.

    The kwarg is what the message asks for, so a caller who has already used
    it must not keep hearing about the template.
    """
    with _as_if_sdk_took_plugins():
        ag = StrandsAgent(
            _template_with_plugins("on-template"), name="test", plugins=[object()]
        )

        with caplog.at_level(logging.WARNING, logger="ag_ui_strands.agent"):
            with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
                await _trigger_thread_creation(ag, "t1")

    assert not _plugin_warnings(caplog.messages), (
        f"warned about plugins the caller had already supplied; "
        f"got {caplog.messages}"
    )


@pytest.mark.asyncio
async def test_plugins_are_only_warned_about_once(caplog):
    """One thread's message must not become every thread's message."""
    ag = StrandsAgent(_template_with_plugins("mine"), name="test")

    with caplog.at_level(logging.WARNING, logger="ag_ui_strands.agent"):
        with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
            await _trigger_thread_creation(ag, "first")
            after_first = len(_plugin_warnings(caplog.messages))
            await _trigger_thread_creation(ag, "second")

    assert after_first == 1, (
        f"expected the first thread to be told once; got {caplog.messages}"
    )
    assert len(_plugin_warnings(caplog.messages)) == after_first, (
        f"warned twice about the same param; got {caplog.messages}"
    )


@pytest.mark.asyncio
async def test_the_plugins_warning_points_at_the_kwarg_that_fixes_it():
    """A message naming the problem and not the route is half a message."""
    ag = StrandsAgent(_template_with_plugins("mine"), name="test")

    with patch.object(logging.getLogger("ag_ui_strands.agent"), "warning") as warn:
        with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
            await _trigger_thread_creation(ag, "t1")

    # Rendered rather than read off the format string: the route is chosen at
    # call time, so the format string alone would not show which one was said.
    said = [call.args[0] % call.args[1:] for call in warn.call_args_list]
    assert any("StrandsAgent(plugins=" in m for m in said), (
        f"the warning never named the kwarg that carries plugins; got {said}"
    )


@pytest.mark.asyncio
async def test_plugins_kwarg_reaches_the_per_thread_agent():
    """The forwarding half: what the caller passes is what the thread gets.

    A sentinel rather than a real plugin, because the adapter's job here is to
    hand the list on unexamined. What a real plugin then does with a real
    Agent is asserted separately below.
    """
    plugin = object()
    with _as_if_sdk_took_plugins():
        ag = StrandsAgent(Agent(model=_mock_model()), name="test", plugins=[plugin])

        with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
            instance = await _trigger_thread_creation(ag, "t1")

    assert "plugins" in instance.init_kwargs, (
        f"plugins kwarg never reached the per-thread constructor; "
        f"got kwargs={list(instance.init_kwargs)}"
    )
    assert plugin in instance.init_kwargs["plugins"], (
        f"expected the caller's plugin to be forwarded; "
        f"got {instance.init_kwargs['plugins']!r}"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "plugins_value",
    [None, []],
    ids=["omitted", "explicit-empty-list"],
)
async def test_a_falsy_plugins_value_omits_the_kwarg(plugins_value):
    """"No plugins" is said by not passing the kwarg at all.

    ``plugins=[]`` is a value, and a future Strands could read it as "register
    none of the defaults either", which is not what an unset option means.
    """
    template = Agent(model=_mock_model())
    ag = StrandsAgent(template, name="test", plugins=plugins_value)

    with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
        instance = await _trigger_thread_creation(ag, "t1")

    assert "plugins" not in instance.init_kwargs, (
        f"expected the plugins kwarg to be omitted, but it was forwarded as "
        f"{instance.init_kwargs.get('plugins')!r}"
    )


def test_plugins_on_a_release_without_them_is_refused_at_wrap_time():
    """A release below the plugin system gets an answer, not a traceback.

    The declared strands-agents floor has no ``plugins`` parameter at all.
    Left alone, the kwarg reached that constructor and Strands raised a bare
    TypeError from inside per-thread construction, which escapes the run
    generator: the caller saw an SDK traceback on their first request rather
    than a sentence about the argument they passed. Refusing while the wrapper
    is being built says it once, at the point the mistake was made.
    """
    template = Agent(model=_mock_model())

    with patch("ag_ui_strands.agent._STRANDS_ACCEPTS_PLUGINS", False):
        with pytest.raises(TypeError, match="plugins"):
            StrandsAgent(template, name="test", plugins=[object()])

        # Not asking for the feature is not a misconfiguration, so the same
        # release must still build a wrapper that never mentions plugins.
        StrandsAgent(template, name="test")
        StrandsAgent(template, name="test", plugins=[])


class _CountingPlugin(_PluginBase):
    """Records which agents it was initialized against."""

    name = "counting-plugin"

    def __init__(self):
        super().__init__()
        self.agents: list = []

    def init_agent(self, agent):
        self.agents.append(agent)


@_needs_sdk_plugins
@pytest.mark.asyncio
async def test_a_forwarded_plugin_is_initialized_once_per_thread():
    """The assertion that outranks the kwarg plumbing.

    The one test here that needs the SDK's real plugin system, and the reason
    it is worth a skip on older releases: what a plugin is for is the work it
    does in ``init_agent``, and that has to happen against each agent that
    serves requests. Once per thread and against that thread's own agent is
    the whole contract; the kwarg is only how it gets there.
    """
    plugin = _CountingPlugin()
    template = Agent(model=_mock_model())
    ag = StrandsAgent(template, name="test", plugins=[plugin])

    first = await _trigger_thread_creation(ag, "thread-a")
    second = await _trigger_thread_creation(ag, "thread-b")

    assert plugin.agents == [first, second], (
        f"expected init_agent to run once against each thread's own agent; "
        f"got {plugin.agents!r}"
    )
