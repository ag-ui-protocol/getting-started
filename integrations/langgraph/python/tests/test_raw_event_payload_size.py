"""End-to-end payload-size measurement for the emit_raw_events opt-out (OSS-607).

Unlike test_raw_event_optout.py (which calls _dispatch_event directly), this
drives the *real* streaming pipeline — `_handle_stream_events` →
`_handle_single_event` → `_dispatch_event` — with a synthetic LangGraph event
stream whose events carry a large payload (the data that becomes `raw_event`),
then encodes every emitted AG-UI event with the real `EventEncoder` (the exact
call `endpoint.py` makes to write SSE) and measures the on-the-wire byte total.

Asserts the opt-out (1) removes `raw_event` from every emitted event and
(2) shrinks the encoded payload by an order of magnitude.
"""
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from langchain_core.messages import AIMessageChunk

from ag_ui.core import EventType, RunAgentInput
from ag_ui.encoder import EventEncoder

from ag_ui_langgraph.agent import LangGraphAgent

# ~50 KB blob per streamed event, standing in for the large LangGraph
# state/metadata that rides along on `raw_event` on a big-state graph.
_BLOB_CHARS = 50_000
_BIG_BLOB = {"lab_results": "x" * _BLOB_CHARS}


def _make_agent(**kwargs):
    from langgraph.graph.state import CompiledStateGraph

    graph = MagicMock(spec=CompiledStateGraph)
    graph.config_specs = []
    graph.nodes = {}
    state = MagicMock()
    state.values = {"messages": [], "copilotkit": {}}
    state.tasks = []
    state.next = []
    state.metadata = {"writes": {}}
    graph.aget_state = AsyncMock(return_value=state)
    return LangGraphAgent(name="test", graph=graph, **kwargs)


def _text_stream_event(text):
    """A LangGraph on_chat_model_stream event carrying a large side payload.

    The entire event dict becomes `raw_event` on the emitted AG-UI text event,
    so the blob in `data` is what inflates the wire payload.
    """
    # Real streamed chunks carry an id (the transient run-- id); the text
    # message id is derived from it, so it must be set.
    chunk = AIMessageChunk(content=text, id="run--msg1")
    chunk.response_metadata = {}
    chunk.tool_call_chunks = []
    return {
        "event": "on_chat_model_stream",
        "run_id": "run1",
        "metadata": {"langgraph_node": "model"},
        "data": {"chunk": chunk, "state_blob": _BIG_BLOB},
        "name": "model",
        "parent_ids": [],
        "tags": [],
    }


async def _run_and_measure(emit_raw_events):
    agent = _make_agent(emit_raw_events=emit_raw_events)
    encoder = EventEncoder()

    stream_events = [_text_stream_event("hello "), _text_stream_event("world")]

    async def fake_stream():
        for ev in stream_events:
            yield ev

    final_state = MagicMock()
    final_state.values = {"messages": [], "copilotkit": {}}
    final_state.tasks = []
    final_state.next = []
    final_state.metadata = {"writes": {}}

    mock_prepared = {
        "state": {"messages": [], "copilotkit": {}},
        "stream": fake_stream(),
        "config": {"configurable": {"thread_id": "t1"}},
    }

    def fake_get_state_snapshot(state):
        if isinstance(state, dict):
            return state
        return getattr(state, "values", {}) or {}

    with patch.object(agent, "prepare_stream", AsyncMock(return_value=mock_prepared)), \
         patch.object(agent.graph, "aget_state", AsyncMock(return_value=final_state)), \
         patch.object(agent, "get_state_snapshot", side_effect=fake_get_state_snapshot):
        input_data = RunAgentInput(
            thread_id="t1",
            run_id="run1",
            messages=[],
            state={},
            tools=[],
            context=[],
            forwarded_props={},
        )
        emitted = [ev async for ev in agent._handle_stream_events(input_data)]

    wire_bytes = sum(len(encoder.encode(ev).encode("utf-8")) for ev in emitted)
    events_with_raw = [ev for ev in emitted if getattr(ev, "raw_event", None) is not None]
    raw_events = [ev for ev in emitted if ev.type == EventType.RAW]
    return emitted, wire_bytes, events_with_raw, raw_events


class TestRawEventPayloadSize(unittest.IsolatedAsyncioTestCase):
    async def test_opt_out_removes_raw_event_and_shrinks_wire_payload(self):
        emitted_on, bytes_on, raw_on, raw_evts_on = await _run_and_measure(emit_raw_events=True)
        emitted_off, bytes_off, raw_off, raw_evts_off = await _run_and_measure(emit_raw_events=False)

        # Default ON: both raw carriers are present — the RAW passthrough events
        # and the piggy-backed raw_event — and the blob is on the wire. These
        # guard the fixture: if the pipeline stops carrying raw data they fail.
        self.assertGreater(len(raw_evts_on), 0, "expected RAW passthrough events on the default path")
        self.assertGreater(len(raw_on), 0, "expected piggy-backed raw_event on the default path")
        self.assertGreater(
            bytes_on, _BLOB_CHARS,
            f"expected the raw blob on the wire (>{_BLOB_CHARS}B), got {bytes_on}B",
        )

        # Opt-out: no RAW passthrough events, no piggy-backed raw_event on any
        # emitted event, and the wire payload collapses by an order of magnitude.
        self.assertEqual(len(raw_evts_off), 0, "opt-out must suppress RAW passthrough events")
        self.assertEqual(len(raw_off), 0, "opt-out must strip raw_event from every event")
        self.assertLess(
            bytes_off, bytes_on * 0.1,
            f"expected >=90% payload reduction; on={bytes_on}B off={bytes_off}B",
        )

        # The opt-out only removes raw data — every non-RAW AG-UI event still
        # emitted on the default path is still emitted when opted out.
        self.assertEqual(
            [e.type for e in emitted_on if e.type != EventType.RAW],
            [e.type for e in emitted_off],
            "opt-out must only drop RAW events, not any functional event",
        )

        # Emit the measured numbers so the reduction is visible in test output.
        print(
            f"\n[OSS-607] wire bytes: on={bytes_on:,}  off={bytes_off:,}  "
            f"reduction={100 * (1 - bytes_off / bytes_on):.1f}%  "
            f"(RAW events: on={len(raw_evts_on)} off={len(raw_evts_off)})"
        )


if __name__ == "__main__":
    unittest.main()
