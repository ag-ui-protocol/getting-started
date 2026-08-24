"""Tests for LangGraphAgent.clone() subclass preservation."""

import functools
import inspect
import unittest
from unittest.mock import MagicMock

from ag_ui_langgraph import LangGraphAgent
from ag_ui_langgraph.agent import ROOT_SUBGRAPH_NAME, _CLONE_BEHAVIOR_FLAGS


class SubclassAgent(LangGraphAgent):
    """Test subclass that adds custom behavior."""

    def __init__(self, *, name, graph, description=None, config=None, enable_legacy_on_interrupt_event=True, emit_interrupt_outcome=False, emit_raw_events=True, custom_flag=False):
        super().__init__(name=name, graph=graph, description=description, config=config, enable_legacy_on_interrupt_event=enable_legacy_on_interrupt_event, emit_interrupt_outcome=emit_interrupt_outcome, emit_raw_events=emit_raw_events)
        self.custom_flag = custom_flag

    def custom_method(self):
        return "subclass behavior"


class LegacySignatureAgent(LangGraphAgent):
    """Subclass whose __init__ predates the emit/interrupt flags.

    This is the shape of ``copilotkit.LangGraphAGUIAgent``: a closed
    keyword-only signature accepting exactly the four parameters clone()
    documents. Every kwarg clone() adds beyond those four breaks it, and
    because add_langgraph_fastapi_endpoint clones per request, that break is
    a 500 on every request rather than a startup error.
    """

    def __init__(self, *, name, graph, description=None, config=None):
        super().__init__(name=name, graph=graph, description=description, config=config)


class KwargsSwallowingAgent(LangGraphAgent):
    """Subclass that captures **kwargs but never forwards them to super().

    A VAR_KEYWORD parameter proves nothing about whether the flags land: this
    shape accepts every keyword a caller could pass and then throws them away.
    """

    def __init__(self, *, name, graph, description=None, config=None, **kwargs):
        super().__init__(name=name, graph=graph, description=description, config=config)


class KwargsForwardingAgent(LangGraphAgent):
    """Subclass that captures **kwargs and forwards them to super()."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)


class IgnoresDeclaredFlagAgent(LangGraphAgent):
    """Subclass that declares a flag by name but drops it on the floor."""

    def __init__(self, *, name, graph, description=None, config=None, emit_raw_events=True):
        super().__init__(name=name, graph=graph, description=description, config=config)


class PositionalOnlyFlagAgent(LangGraphAgent):
    """Subclass with a positional-only parameter that shadows a flag name.

    ``emit_raw_events`` cannot be passed by keyword here, so any attempt to hand
    it to the constructor by keyword makes the construction fail.
    """

    def __init__(self, emit_raw_events=True, /, *, name, graph, description=None, config=None):
        super().__init__(
            name=name,
            graph=graph,
            description=description,
            config=config,
            emit_raw_events=emit_raw_events,
        )


class OpaqueSignatureAgent(LangGraphAgent):
    """Subclass whose ``__init__`` genuinely defeats ``inspect.signature``.

    A wrapper that advertises a ``__signature__`` ``inspect`` cannot use
    (anything that is neither an ``inspect.Signature`` nor a parsable text
    signature). ``inspect.signature`` then raises for real — nothing about
    ``inspect`` is patched here, and the class stays perfectly constructible,
    so clone() must run end to end. clone() no longer introspects the class it
    constructs, which is exactly why this shape is uneventful now; it stays as
    the regression net against reintroducing that introspection.
    """

    def __init__(self, *, name, graph, description=None, config=None):
        super().__init__(name=name, graph=graph, description=description, config=config)

    __init__.__signature__ = object()


class ClosedParentAgent(LangGraphAgent):
    """A released-shape subclass: closed signature, exactly the four params.

    Stands in for ``copilotkit.LangGraphAGUIAgent``. Kept separate from
    ``LegacySignatureAgent`` so the grandchild fixtures below can subclass it
    without perturbing that fixture's own tests.
    """

    def __init__(self, *, name, graph, description=None, config=None):
        super().__init__(name=name, graph=graph, description=description, config=config)


class GrandchildForwardingAgent(ClosedParentAgent):
    """``**kwargs`` forwarded up into a *closed* parent signature.

    The load-bearing shape: a VAR_KEYWORD parameter proves only that *this*
    class accepts the keyword, never that its MRO does. Anything clone() hands
    over beyond the four documented parameters is forwarded verbatim into
    ``ClosedParentAgent.__init__``, which rejects it — ``TypeError: got an
    unexpected keyword argument 'enable_legacy_on_interrupt_event'``. Because
    ``add_langgraph_fastapi_endpoint`` clones per request, that is a 500 on
    every request for a user who merely subclassed the released agent.
    """

    def __init__(self, **kwargs):
        super().__init__(**kwargs)


class PinnedAndForwardedFlagAgent(LangGraphAgent):
    """Pins a flag itself *and* forwards ``**kwargs``.

    A perfectly reasonable way to hard-disable raw events for a deployment.
    Handing ``emit_raw_events`` to this constructor through the ``**kwargs``
    door makes the super() call receive it twice: ``TypeError: __init__() got
    multiple values for keyword argument 'emit_raw_events'``.
    """

    def __init__(self, **kwargs):
        super().__init__(emit_raw_events=False, **kwargs)


class SkipsSuperInitAgent(LangGraphAgent):
    """Subclass whose ``__init__`` never calls ``super().__init__()``.

    It sets the identity attributes clone() reads and nothing else, so the
    instance genuinely has no ``enable_legacy_on_interrupt_event`` /
    ``emit_interrupt_outcome`` attribute at all. A ``getattr(self, name)`` with
    no default raises AttributeError for those — once per request, since the
    endpoint clones per request — for a class that is otherwise constructible
    and usable.
    """

    def __init__(self, *, name, graph, description=None, config=None):
        self.name = name
        self.graph = graph
        self.description = description
        self.config = config or {}


def _passthrough(fn):
    """A ``functools.wraps`` decorator that forwards everything untouched.

    Deliberately declares ``*args, **kwargs`` so the wrapper itself accepts any
    call: an argument mismatch is therefore raised by the *inner* function, one
    frame deeper than the ``clone()`` frame.
    """

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        return fn(*args, **kwargs)

    return wrapper


class WrappedRequiredParamAgent(LangGraphAgent):
    """Decorator-wrapped ``__init__`` with a genuinely required extra param.

    Same defect as ``StrictAgent`` in
    ``test_clone_subclass_with_required_extra_param_raises`` — it must override
    clone() — but wrapped, so the failure surfaces from a different frame. The
    guidance must reach the subclass author either way.
    """

    @_passthrough
    def __init__(self, *, name, graph, api_key, description=None, config=None):
        super().__init__(name=name, graph=graph, description=description, config=config)
        self.api_key = api_key


class OpaqueRequiredParamAgent(LangGraphAgent):
    """Unintrospectable ``__init__`` *and* a required extra param.

    The union of the two awkward shapes: nothing about the class can be read,
    and constructing it with the four documented parameters cannot work. The
    guidance must still be produced.
    """

    def __init__(self, *, name, graph, api_key, description=None, config=None):
        super().__init__(name=name, graph=graph, description=description, config=config)
        self.api_key = api_key

    __init__.__signature__ = object()


class TestCloneBehaviorFlagList(unittest.TestCase):
    """``_CLONE_BEHAVIOR_FLAGS`` must not drift from ``LangGraphAgent.__init__``.

    clone() reads the flag names from a static tuple instead of deriving them
    per request, because the derivation was fooled by wrapped constructors and
    failed *silently* (an empty derivation carried no flags at all). This test
    is what replaces that runtime protection: it is the one place the tuple and
    the signature are checked against each other, and it fails in both
    directions — a flag added to ``__init__`` but missing from the tuple, and a
    name in the tuple that ``__init__`` no longer has.
    """

    #: The parameters that say *which* agent is being cloned. clone() passes
    #: these four (plus ``self``) to the constructor; every other ``__init__``
    #: parameter is a behavior flag it must carry by assignment. Spelled out
    #: here rather than imported from the module under test on purpose: a test
    #: that imports the code's own idea of the split restates the code instead
    #: of checking it.
    IDENTITY_PARAMS = frozenset({"self", "name", "graph", "description", "config"})

    def test_static_flag_tuple_matches_init_signature(self):
        params = inspect.signature(LangGraphAgent.__init__).parameters
        expected = set(params) - self.IDENTITY_PARAMS

        self.assertEqual(
            set(_CLONE_BEHAVIOR_FLAGS),
            expected,
            "_CLONE_BEHAVIOR_FLAGS has drifted from LangGraphAgent.__init__. "
            "A flag in __init__ but not in the tuple is silently reset by "
            "clone() on every request; a name in the tuple but not in __init__ "
            "is dead weight clone() looks up and skips.",
        )
        self.assertTrue(expected, "expected at least one behavior flag")

    def test_static_flag_tuple_has_no_duplicates(self):
        """A repeated name would make the drift check pass while clone() churns."""
        self.assertEqual(
            len(_CLONE_BEHAVIOR_FLAGS), len(set(_CLONE_BEHAVIOR_FLAGS))
        )


class TestFlagDefaults(unittest.TestCase):
    """The documented flag defaults, and the plain keyword opt-out."""

    def _make_graph(self):
        graph = MagicMock()
        graph.config_specs = []
        return graph

    def test_base_defaults_apply_with_no_argument(self):
        """No keyword: the documented defaults hold."""
        agent = LangGraphAgent(name="test", graph=self._make_graph())
        self.assertTrue(agent.enable_legacy_on_interrupt_event)
        self.assertFalse(agent.emit_interrupt_outcome)
        self.assertTrue(agent.emit_raw_events)

    def test_explicit_argument_opts_out(self):
        """The plain non-default keyword path."""
        agent = LangGraphAgent(
            name="test", graph=self._make_graph(), emit_raw_events=False
        )
        self.assertFalse(agent.emit_raw_events)


class TestClone(unittest.TestCase):
    """Test that clone() preserves subclass identity and behavior."""

    def _make_graph(self):
        """Create a mock compiled graph for testing."""
        graph = MagicMock()
        graph.config_specs = []
        return graph

    def test_clone_subclass_with_legacy_signature(self):
        """A subclass accepting only the four documented params must clone."""
        agent = LegacySignatureAgent(name="test", graph=self._make_graph())
        cloned = agent.clone()
        self.assertIsInstance(cloned, LegacySignatureAgent)
        self.assertEqual(cloned.name, "test")

    def test_clone_carries_flags_through_legacy_signature(self):
        """Flags the subclass __init__ cannot accept still reach the clone.

        Dropping them would silently revert emit_raw_events=False to the
        default on every request, reintroducing the OSS-607 payload bloat
        with no error anywhere.
        """
        agent = LegacySignatureAgent(name="test", graph=self._make_graph())
        agent.emit_raw_events = False
        agent.emit_interrupt_outcome = True
        agent.enable_legacy_on_interrupt_event = False

        cloned = agent.clone()

        self.assertFalse(cloned.emit_raw_events)
        self.assertTrue(cloned.emit_interrupt_outcome)
        self.assertFalse(cloned.enable_legacy_on_interrupt_event)

    def test_clone_carries_flags_when_init_accepts_them(self):
        """A subclass that declares and forwards the flags still gets them."""
        agent = SubclassAgent(
            name="test",
            graph=self._make_graph(),
            emit_raw_events=False,
            emit_interrupt_outcome=True,
        )
        cloned = agent.clone()
        self.assertFalse(cloned.emit_raw_events)
        self.assertTrue(cloned.emit_interrupt_outcome)

    def test_clone_carries_flags_when_kwargs_are_swallowed(self):
        """**kwargs that is never forwarded must not lose the flags.

        The subclass accepts every keyword and discards it, so the only thing
        that can guarantee the clone carries the source's values is the
        unconditional post-construction assignment.
        """
        agent = KwargsSwallowingAgent(name="test", graph=self._make_graph())
        agent.emit_raw_events = False
        agent.emit_interrupt_outcome = True
        agent.enable_legacy_on_interrupt_event = False

        cloned = agent.clone()

        self.assertFalse(cloned.emit_raw_events)
        self.assertTrue(cloned.emit_interrupt_outcome)
        self.assertFalse(cloned.enable_legacy_on_interrupt_event)

    def test_clone_carries_flags_when_kwargs_are_forwarded(self):
        """The forwarding **kwargs shape must keep working too."""
        agent = KwargsForwardingAgent(
            name="test", graph=self._make_graph(), emit_raw_events=False
        )
        self.assertFalse(agent.emit_raw_events)

        cloned = agent.clone()

        self.assertIsInstance(cloned, KwargsForwardingAgent)
        self.assertFalse(cloned.emit_raw_events)

    def test_clone_carries_flag_declared_but_ignored_by_subclass(self):
        """Declaring a flag parameter and ignoring it must not lose it."""
        agent = IgnoresDeclaredFlagAgent(
            name="test", graph=self._make_graph(), emit_raw_events=False
        )
        # Precondition, asserted rather than left to a comment the next line
        # then contradicts: the subclass declared the parameter and never
        # forwarded it, so the constructor argument did NOT land and the
        # instance is still on the default. If this fixture ever starts
        # forwarding, the test below stops covering the "declared but ignored"
        # shape and says so here instead of passing for the wrong reason.
        self.assertTrue(agent.emit_raw_events)

        # Now put the instance on a non-default value the only way that works
        # for this shape, so the clone has something to lose.
        agent.emit_raw_events = False

        cloned = agent.clone()

        self.assertFalse(cloned.emit_raw_events)

    def test_clone_with_positional_only_flag_name(self):
        """A positional-only param sharing a flag name must not break clone().

        Handing that name to the constructor by keyword raises TypeError, which
        clone() would relabel as a spurious "must override clone()" signature
        error. clone() passes only the four documented parameters, so the shape
        is uneventful — this pins that it stays so.
        """
        agent = PositionalOnlyFlagAgent(False, name="test", graph=self._make_graph())
        self.assertFalse(agent.emit_raw_events)

        cloned = agent.clone()

        self.assertIsInstance(cloned, PositionalOnlyFlagAgent)
        self.assertFalse(cloned.emit_raw_events)

    def test_clone_returns_same_class(self):
        """clone() should return an instance of the same class, not the base."""
        agent = SubclassAgent(name="test", graph=self._make_graph())
        cloned = agent.clone()
        self.assertIsInstance(cloned, SubclassAgent)

    def test_clone_base_class(self):
        """clone() on the base class should still return LangGraphAgent."""
        agent = LangGraphAgent(name="test", graph=self._make_graph())
        cloned = agent.clone()
        self.assertIsInstance(cloned, LangGraphAgent)

    def test_clone_copies_fields(self):
        """clone() should copy name, graph, description, and config."""
        graph = self._make_graph()
        config = {"recursion_limit": 50}
        agent = LangGraphAgent(
            name="my-agent",
            graph=graph,
            description="A test agent",
            config=config,
        )
        cloned = agent.clone()
        self.assertEqual(cloned.name, "my-agent")
        self.assertIs(cloned.graph, graph)
        self.assertEqual(cloned.description, "A test agent")
        self.assertEqual(cloned.config, config)

    def test_clone_shallow_copies_config(self):
        """clone() should shallow-copy config so mutations don't leak."""
        config = {"recursion_limit": 50}
        agent = LangGraphAgent(name="test", graph=self._make_graph(), config=config)
        cloned = agent.clone()
        self.assertEqual(cloned.config, config)
        self.assertIsNot(cloned.config, agent.config)

    def test_clone_subclass_has_overridden_methods(self):
        """clone() of a subclass should have the subclass's methods."""
        agent = SubclassAgent(name="test", graph=self._make_graph())
        cloned = agent.clone()
        self.assertEqual(cloned.custom_method(), "subclass behavior")

    def test_clone_does_not_preserve_subclass_extra_state(self):
        """clone() only passes base-class params; subclass defaults apply."""
        agent = SubclassAgent(name="test", graph=self._make_graph(), custom_flag=True)
        cloned = agent.clone()
        # Documented limitation: custom_flag reverts to its default
        self.assertFalse(cloned.custom_flag)

    def test_clone_subclass_with_required_extra_param_raises(self):
        """Subclasses with extra required params must override clone()."""
        class StrictAgent(LangGraphAgent):
            def __init__(self, *, name, graph, api_key, description=None, config=None):
                super().__init__(name=name, graph=graph, description=description, config=config)
                self.api_key = api_key

        agent = StrictAgent(name="test", graph=self._make_graph(), api_key="sk-123")
        with self.assertRaises(TypeError) as ctx:
            agent.clone()
        self.assertIn("must override clone()", str(ctx.exception))

    def test_clone_signature_mismatch_on_documented_param_raises(self):
        """Rejecting one of the four documented params is a signature error.

        Complements test_clone_subclass_with_required_extra_param_raises: that
        one is a *missing required argument*, this one is an *unexpected
        keyword*. Both are raised by the call machinery, so both must keep
        producing the "must override clone()" guidance.
        """
        class NoConfigAgent(LangGraphAgent):
            def __init__(self, *, name, graph):
                super().__init__(name=name, graph=graph)

        agent = NoConfigAgent(name="test", graph=self._make_graph())
        with self.assertRaises(TypeError) as ctx:
            agent.clone()
        self.assertIn("must override clone()", str(ctx.exception))

    def test_clone_reports_the_underlying_typeerror_message(self):
        """The guidance wraps the original error, it does not replace it.

        clone() makes a single construction attempt and diagnoses any TypeError
        as a signature problem. That verdict is right for the shapes above and
        wrong for a TypeError raised from inside a constructor *body*, so the
        message the constructor actually produced has to survive — both
        interpolated into the guidance and chained as ``__cause__`` — or the
        reader of a body error is left with nothing to go on.
        """
        class BodyTypeErrorAgent(LangGraphAgent):
            fail = False

            def __init__(self, *, name, graph, description=None, config=None):
                if BodyTypeErrorAgent.fail:
                    raise TypeError("boom")
                super().__init__(
                    name=name, graph=graph, description=description, config=config
                )

        agent = BodyTypeErrorAgent(name="test", graph=self._make_graph())
        BodyTypeErrorAgent.fail = True

        with self.assertRaises(TypeError) as ctx:
            agent.clone()

        self.assertIn("boom", str(ctx.exception))
        self.assertIsInstance(ctx.exception.__cause__, TypeError)
        self.assertEqual(str(ctx.exception.__cause__), "boom")

    def test_clone_propagates_non_typeerror_from_init(self):
        """Only TypeError is diagnosed; anything else propagates untouched.

        Guards against widening the handler to ``except Exception``.
        """
        class BodyValueErrorAgent(LangGraphAgent):
            fail = False

            def __init__(self, *, name, graph, description=None, config=None):
                if BodyValueErrorAgent.fail:
                    raise ValueError("bad value")
                super().__init__(
                    name=name, graph=graph, description=description, config=config
                )

        agent = BodyValueErrorAgent(name="test", graph=self._make_graph())
        BodyValueErrorAgent.fail = True

        with self.assertRaises(ValueError) as ctx:
            agent.clone()

        self.assertEqual(str(ctx.exception), "bad value")
        self.assertNotIn("must override clone()", str(ctx.exception))

    def test_clone_with_no_config(self):
        """clone() with default (empty) config round-trips correctly."""
        agent = LangGraphAgent(name="test", graph=self._make_graph())
        cloned = agent.clone()
        self.assertEqual(cloned.config, {})

    def test_clone_isolates_mutable_state(self):
        """clone() should produce a separate instance (not the same object)."""
        agent = LangGraphAgent(name="test", graph=self._make_graph())
        cloned = agent.clone()
        self.assertIsNot(agent, cloned)
        self.assertIsNot(agent.messages_in_process, cloned.messages_in_process)

    def test_clone_resets_per_request_state(self):
        """The clone must start on clean per-request state, not inherit it.

        This is the whole reason clone() exists (#1277): the endpoint holds one
        agent instance and clones it per request, so any per-run field carried
        over would let concurrent requests read each other's run — a stale
        active_run id on emitted events, a resurrected in-progress message, or
        a subgraph boundary that never re-fires because current_subgraph
        already reads as the node being entered.
        """
        agent = LangGraphAgent(name="test", graph=self._make_graph())
        agent.active_run = {"id": "run-1", "node_name": "agent"}
        agent.messages_in_process = {"run-1": {"id": "msg-1", "tool_call_id": None}}
        agent.current_subgraph = "hotels_agent"

        cloned = agent.clone()

        self.assertIsNone(cloned.active_run)
        self.assertEqual(cloned.messages_in_process, {})
        # Not merely equal-and-empty: a shared dict would still let the two
        # requests write into each other once either starts streaming.
        self.assertIsNot(cloned.messages_in_process, agent.messages_in_process)
        self.assertEqual(cloned.current_subgraph, ROOT_SUBGRAPH_NAME)

        # The source keeps its own in-flight state; cloning is not a reset of
        # the instance the endpoint holds.
        self.assertEqual(agent.active_run, {"id": "run-1", "node_name": "agent"})
        self.assertEqual(agent.current_subgraph, "hotels_agent")

    def test_clone_subclass_with_unreadable_init_signature(self):
        """An __init__ inspect.signature cannot read must still clone.

        clone() must not introspect the class it constructs. Every previous
        attempt to do so had to grow a fallback for this shape, and getting the
        fallback wrong turned into a 500 on every request (the endpoint clones
        per request).
        """
        # Precondition, asserted rather than assumed: the signature lookup
        # really does raise here. If a future CPython starts tolerating this
        # __signature__, this test stops covering the shape and says so.
        with self.assertRaises((TypeError, ValueError)):
            inspect.signature(OpaqueSignatureAgent.__init__)

        agent = OpaqueSignatureAgent(name="test", graph=self._make_graph())
        agent.emit_raw_events = False

        cloned = agent.clone()

        self.assertIsInstance(cloned, OpaqueSignatureAgent)
        self.assertEqual(cloned.name, "test")
        self.assertFalse(cloned.emit_raw_events)


class TestCloneSubclassShapes(unittest.TestCase):
    """Constructor shapes that a flag pass into __init__ used to break.

    Each of these accepts a flag keyword without being able to *use* it, which
    is why clone() hands the constructor nothing but the four documented
    parameters and assigns the flags afterwards. They pass trivially now; that
    is the point, and they are the regression net against reintroducing the
    pass.
    """

    def _make_graph(self):
        graph = MagicMock()
        graph.config_specs = []
        return graph

    def test_clone_grandchild_forwarding_into_closed_parent(self):
        """Shape 1: ``**kwargs`` forwarded up into a closed parent signature."""
        agent = GrandchildForwardingAgent(name="test", graph=self._make_graph())
        agent.emit_raw_events = False
        agent.emit_interrupt_outcome = True

        cloned = agent.clone()

        self.assertIsInstance(cloned, GrandchildForwardingAgent)
        self.assertEqual(cloned.name, "test")
        # Non-default flags survive: the whole point of carrying them.
        self.assertFalse(cloned.emit_raw_events)
        self.assertTrue(cloned.emit_interrupt_outcome)

    def test_clone_flag_pinned_and_forwarded_by_subclass(self):
        """Shape 2: the subclass pins a flag and also forwards ``**kwargs``."""
        agent = PinnedAndForwardedFlagAgent(name="test", graph=self._make_graph())
        self.assertFalse(agent.emit_raw_events)
        agent.emit_interrupt_outcome = True

        cloned = agent.clone()

        self.assertIsInstance(cloned, PinnedAndForwardedFlagAgent)
        self.assertFalse(cloned.emit_raw_events)
        self.assertTrue(cloned.emit_interrupt_outcome)

    def test_clone_non_mapping_config_is_not_relabeled_as_signature_error(self):
        """A ``config`` that is not a mapping is a config bug, not a signature bug.

        ``dict(self.config)`` is evaluated before clone()'s ``try`` on purpose.
        Move it inside and the TypeError it raises is diagnosed as a signature
        mismatch, sending the reader to go fix an ``__init__`` that was never
        involved.
        """
        for cls in (LangGraphAgent, OpaqueSignatureAgent):
            with self.subTest(cls=cls.__name__):
                agent = cls(name="test", graph=self._make_graph(), config=object())

                with self.assertRaises(TypeError) as ctx:
                    agent.clone()

                self.assertNotIn("must override clone()", str(ctx.exception))
                # The real cause survives intact.
                self.assertIn("not iterable", str(ctx.exception))

    def test_clone_survives_instance_missing_a_flag_attribute(self):
        """Shape 5: an instance that genuinely lacks a flag attribute.

        clone() looks the flags up one at a time and skips the ones that are
        not there. Reading them with a plain ``getattr(self, name)`` instead
        turns this shape into an AttributeError on every request.
        """
        agent = SkipsSuperInitAgent(name="test", graph=self._make_graph())
        # Precondition: two of the three flags really are absent, and one is
        # present because we put it there.
        self.assertFalse(hasattr(agent, "enable_legacy_on_interrupt_event"))
        self.assertFalse(hasattr(agent, "emit_interrupt_outcome"))
        agent.emit_raw_events = False

        cloned = agent.clone()

        self.assertIsInstance(cloned, SkipsSuperInitAgent)
        self.assertEqual(cloned.name, "test")
        # The flag that exists is still carried: degrading on the missing ones
        # must not degrade into carrying nothing.
        self.assertFalse(cloned.emit_raw_events)
        # The absent ones are left absent rather than invented.
        self.assertFalse(hasattr(cloned, "enable_legacy_on_interrupt_event"))
        self.assertFalse(hasattr(cloned, "emit_interrupt_outcome"))

    def test_clone_wrapped_init_signature_mismatch_still_guides(self):
        """Shape 3: a wrapper must not hide a real signature mismatch."""
        agent = WrappedRequiredParamAgent(
            name="test", graph=self._make_graph(), api_key="sk-123"
        )

        with self.assertRaises(TypeError) as ctx:
            agent.clone()

        self.assertIn("must override clone()", str(ctx.exception))

    def test_clone_unintrospectable_signature_mismatch_still_guides(self):
        """Shape 4: an unreadable signature plus a required extra param."""
        with self.assertRaises((TypeError, ValueError)):
            inspect.signature(OpaqueRequiredParamAgent.__init__)

        agent = OpaqueRequiredParamAgent(
            name="test", graph=self._make_graph(), api_key="sk-123"
        )

        with self.assertRaises(TypeError) as ctx:
            agent.clone()

        self.assertIn("must override clone()", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
