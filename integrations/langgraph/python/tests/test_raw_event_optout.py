"""Tests for the ``emit_raw_events`` opt-out (OSS-607).

The LangGraph integration piggy-backs the full underlying LangGraph event onto
almost every emitted AG-UI event via ``raw_event``. On graphs with large state
this inflates payloads (Function Health reported ~1.5 MB events). Constructing
the agent with ``emit_raw_events=False`` strips that piggy-backed ``raw_event``
at the single ``_dispatch_event`` choke point, while leaving the explicit
``EventType.RAW`` passthrough channel untouched.
"""
import unittest
from unittest.mock import MagicMock

from ag_ui.core import EventType, RawEvent, TextMessageEndEvent

from ag_ui_langgraph import LangGraphAgent


def _make_agent(**kwargs):
    graph = MagicMock()
    graph.nodes = {}
    return LangGraphAgent(name="test", graph=graph, **kwargs)


class TestEmitRawEventsOptOut(unittest.TestCase):
    def test_default_is_on_and_preserves_raw_event(self):
        agent = _make_agent()
        self.assertTrue(agent.emit_raw_events)
        ev = TextMessageEndEvent(
            type=EventType.TEXT_MESSAGE_END, message_id="m1", raw_event={"big": "payload"}
        )
        out = agent._dispatch_event(ev)
        self.assertEqual(out.raw_event, {"big": "payload"})

    def test_opt_out_strips_piggybacked_raw_event(self):
        agent = _make_agent(emit_raw_events=False)
        self.assertFalse(agent.emit_raw_events)
        ev = TextMessageEndEvent(
            type=EventType.TEXT_MESSAGE_END, message_id="m1", raw_event={"big": "payload"}
        )
        out = agent._dispatch_event(ev)
        self.assertIsNone(out.raw_event)

    # Note: the RAW passthrough events (EventType.RAW) are suppressed at the
    # emission layer in _handle_stream_events, not in _dispatch_event — see
    # test_raw_event_payload_size.py, which asserts zero RAW events (and a
    # >=90% wire-payload reduction) when opted out over the real pipeline.

    def test_clone_preserves_emit_raw_events(self):
        agent = _make_agent(emit_raw_events=False)
        cloned = agent.clone()
        self.assertFalse(cloned.emit_raw_events)

    def test_dispatch_event_raw_passthrough_ignores_the_opt_out(self):
        """The ``EventType.RAW`` arm json-safes its payload and never reads the flag.

        RAW is the explicit passthrough channel: opting out suppresses RAW
        events at the emission layer (see test_raw_event_payload_size), so any
        RAW event that does reach ``_dispatch_event`` was asked for and must
        arrive whole. Asserted on both an opted-out instance and an instance
        built without ``__init__`` — the arm runs before any flag lookup, so it
        must not need one. The second case is the load-bearing one: the flag is
        a plain instance attribute set by ``__init__``, so a lookup added to
        this arm would raise AttributeError, not merely read the wrong value.
        """
        for label, agent in (
            ("opted out", _make_agent(emit_raw_events=False)),
            ("no __init__", object.__new__(LangGraphAgent)),
        ):
            with self.subTest(agent=label):
                ev = RawEvent(type=EventType.RAW, event={"tags": {"a", "b"}})
                out = agent._dispatch_event(ev)
                # Payload preserved, and json-safed on the way through (the set
                # became a list) — which is the whole job of this arm.
                self.assertIsNotNone(out.event)
                self.assertEqual(sorted(out.event["tags"]), ["a", "b"])
                self.assertIsInstance(out.event["tags"], list)


if __name__ == "__main__":
    unittest.main()
