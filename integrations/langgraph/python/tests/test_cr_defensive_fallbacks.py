"""Coverage for defensive fallbacks and stream-path fixes called out in
code review.

Each test pins one behaviour the MESSAGES_SNAPSHOT cleanup PR fixed so
future refactors don't silently reintroduce the crash:

* C.1 handle_node_change emits STEP events when the node name changes
  while _handle_stream_events iterates the generator.
* C.2 Error events with missing / malformed data.message produce a
  RunErrorEvent with a placeholder message rather than crashing.
* C.3 A non-string (or None) run_id on a stream event is ignored; the
  active_run id is not overwritten.
* C.4 ``active_run.manually_emitted_state == {}`` is an explicit empty
  emission and must NOT fall back to current_graph_state.
* C.5 state.tasks = None and state.metadata = None are both tolerated by
  the post-run fallback.
* C.6 get_schema_keys returns the successfully-computed input/output/
  config keys even when context_schema raises.
"""

import unittest
from unittest.mock import AsyncMock, MagicMock

from ag_ui.core import EventType
from ag_ui_langgraph import LangGraphAgent

from tests._helpers import make_agent, _record_dispatch


class TestHandleNodeChangeEmitsSteps(unittest.TestCase):
    """C.1 — handle_node_change must emit STEP_FINISHED then
    STEP_STARTED when the node name transitions."""

    def test_node_transition_emits_end_then_start(self):
        agent = make_agent()
        agent.active_run = {"id": "run-1", "node_name": "alpha"}
        _record_dispatch(agent)

        events = list(agent.handle_node_change("beta"))

        types = [getattr(e, "type", None) for e in events]
        self.assertEqual(
            types,
            [EventType.STEP_FINISHED, EventType.STEP_STARTED],
            f"unexpected event sequence: {types!r}",
        )
        self.assertEqual(agent.active_run["node_name"], "beta")

    def test_same_node_name_emits_nothing(self):
        agent = make_agent()
        agent.active_run = {"id": "run-1", "node_name": "alpha"}
        _record_dispatch(agent)

        events = list(agent.handle_node_change("alpha"))
        self.assertEqual(events, [])


class TestRunErrorDefensive(unittest.IsolatedAsyncioTestCase):
    """C.2 — error events missing data.message must not crash; a
    placeholder message and a warning log are emitted."""

    async def test_missing_data_message_uses_placeholder(self):
        agent = make_agent()

        async def fake_prepare(*args, **kwargs):
            agent.active_run["schema_keys"] = {
                "input": ["messages"], "output": ["messages"],
                "config": [], "context": [],
            }

            async def gen():
                # Error event with no data field at all.
                yield {"event": "error"}

            return {
                "stream": gen(),
                "state": MagicMock(values={"messages": []}),
                "config": {"configurable": {"thread_id": "t1"}},
            }

        agent.prepare_stream = fake_prepare
        final_state = MagicMock()
        final_state.values = {"messages": []}
        final_state.tasks = []
        final_state.next = []
        final_state.metadata = {"writes": {}}
        agent.graph.aget_state = AsyncMock(return_value=final_state)

        run_input = MagicMock()
        run_input.run_id = "run-1"
        run_input.thread_id = "t1"
        run_input.forwarded_props = {}

        collected = []
        with self.assertLogs("ag_ui_langgraph.agent", level="WARNING") as log_ctx:
            async for ev in agent._handle_stream_events(run_input):
                collected.append(ev)

        run_errors = [e for e in collected if getattr(e, "type", None) == EventType.RUN_ERROR]
        self.assertEqual(len(run_errors), 1)
        self.assertEqual(run_errors[0].message, "Unknown error")
        self.assertIn("missing data.message", "\n".join(log_ctx.output))


class TestRunIdTypeValidation(unittest.IsolatedAsyncioTestCase):
    """C.3 — non-string run_id on an event is ignored; active_run["id"]
    is preserved."""

    async def test_non_string_run_id_ignored(self):
        agent = make_agent()

        async def fake_prepare(*args, **kwargs):
            agent.active_run["schema_keys"] = {
                "input": ["messages"], "output": ["messages"],
                "config": [], "context": [],
            }

            async def gen():
                # Invalid run_id — should log a warning and NOT overwrite id.
                yield {
                    "event": "on_chain_start",
                    "run_id": 42,
                    "name": "x",
                    "data": {},
                    "metadata": {"langgraph_node": "x"},
                }

            return {
                "stream": gen(),
                "state": MagicMock(values={"messages": []}),
                "config": {"configurable": {"thread_id": "t1"}},
            }

        agent.prepare_stream = fake_prepare
        final_state = MagicMock()
        final_state.values = {"messages": []}
        final_state.tasks = []
        final_state.next = []
        final_state.metadata = {"writes": {}}
        agent.graph.aget_state = AsyncMock(return_value=final_state)

        run_input = MagicMock()
        run_input.run_id = "run-original"
        run_input.thread_id = "t1"
        run_input.forwarded_props = {}

        observed_ids = []
        with self.assertLogs("ag_ui_langgraph.agent", level="WARNING") as log_ctx:
            async for _ in agent._handle_stream_events(run_input):
                if agent.active_run is not None:
                    observed_ids.append(agent.active_run["id"])

        # active_run is torn down to None in the finally block; inspect what
        # the id was during streaming.
        self.assertTrue(observed_ids, "active_run was never observed mid-stream")
        self.assertTrue(
            all(i == "run-original" for i in observed_ids),
            f"active_run['id'] was overwritten by non-string run_id: {observed_ids!r}",
        )
        self.assertIn("non-string run_id", "\n".join(log_ctx.output))


class TestManuallyEmittedStateIsNoneSemantics(unittest.IsolatedAsyncioTestCase):
    """C.4 — manually_emitted_state = {} must NOT fall back to
    current_graph_state; only None means 'not set'."""

    async def test_empty_dict_is_respected(self):
        agent = make_agent()

        async def fake_prepare(*args, **kwargs):
            agent.active_run["schema_keys"] = {
                "input": ["messages"], "output": ["messages"],
                "config": [], "context": [],
            }

            async def gen():
                yield {
                    "event": "on_chain_start",
                    "run_id": "run-1",
                    "name": "n",
                    "data": {},
                    "metadata": {"langgraph_node": "n"},
                }
                # End of a node, carrying a non-empty state update.
                yield {
                    "event": "on_chain_end",
                    "run_id": "run-1",
                    "name": "n",
                    "data": {"output": {"custom_key": "from_graph"}},
                    "metadata": {"langgraph_node": "n"},
                }

            return {
                "stream": gen(),
                "state": MagicMock(values={"messages": []}),
                "config": {"configurable": {"thread_id": "t1"}},
            }

        agent.prepare_stream = fake_prepare
        final_state = MagicMock()
        final_state.values = {"messages": []}
        final_state.tasks = []
        final_state.next = []
        final_state.metadata = {"writes": {}}
        agent.graph.aget_state = AsyncMock(return_value=final_state)

        run_input = MagicMock()
        run_input.run_id = "run-1"
        run_input.thread_id = "t1"
        run_input.forwarded_props = {}

        collected = []
        # Set manually_emitted_state = {} before the first snapshot fires by
        # patching get_state_snapshot to capture what the stream passed in.
        captured_snapshots = []
        orig_get_state_snapshot = agent.get_state_snapshot

        def capture(state):
            captured_snapshots.append(dict(state) if isinstance(state, dict) else state)
            return orig_get_state_snapshot(state)

        agent.get_state_snapshot = capture

        async def drive():
            async for ev in agent._handle_stream_events(run_input):
                collected.append(ev)
                # Immediately after run starts, force manually_emitted_state = {}.
                if agent.active_run is not None and "manually_emitted_state" in agent.active_run and agent.active_run.get("manually_emitted_state") is None:
                    agent.active_run["manually_emitted_state"] = {}

        await drive()

        # If the empty-dict semantics were broken (truthy fallback), the
        # node-exit snapshot would contain 'custom_key' from current_graph_state.
        # With correct semantics ({} wins over current_graph_state), the snapshot
        # at that point should be empty or not include 'custom_key'.
        exit_snapshots = [s for s in captured_snapshots if isinstance(s, dict)]
        self.assertTrue(
            all("custom_key" not in s for s in exit_snapshots),
            f"manually_emitted_state=={{}} was overridden by current_graph_state: {exit_snapshots!r}",
        )


class TestStateNoneGuards(unittest.IsolatedAsyncioTestCase):
    """C.5 — state.tasks = None and state.metadata = None at post-run
    time do not crash _handle_stream_events."""

    async def test_none_tasks_and_metadata_tolerated(self):
        agent = make_agent()

        async def fake_prepare(*args, **kwargs):
            agent.active_run["schema_keys"] = {
                "input": ["messages"], "output": ["messages"],
                "config": [], "context": [],
            }

            async def gen():
                if False:
                    yield None

            return {
                "stream": gen(),
                "state": MagicMock(values={"messages": []}),
                "config": {"configurable": {"thread_id": "t1"}},
            }

        agent.prepare_stream = fake_prepare

        final_state = MagicMock()
        final_state.values = {"messages": []}
        final_state.tasks = None       # the M30 guard
        final_state.next = []
        final_state.metadata = None    # the P15 guard
        agent.graph.aget_state = AsyncMock(return_value=final_state)

        run_input = MagicMock()
        run_input.run_id = "run-1"
        run_input.thread_id = "t1"
        run_input.forwarded_props = {}

        # Should not raise.
        collected = []
        async for ev in agent._handle_stream_events(run_input):
            collected.append(ev)

        types = [getattr(e, "type", None) for e in collected]
        self.assertIn(EventType.RUN_STARTED, types)
        self.assertIn(EventType.RUN_FINISHED, types)


class TestContextSchemaIsolation(unittest.TestCase):
    """C.6 — A failing context_schema must not discard successfully-
    computed input/output/config keys."""

    def test_context_value_error_keeps_other_keys(self):
        graph = MagicMock()
        graph.config_specs = []
        graph.get_input_jsonschema.return_value = {"properties": {"foo": {}}}
        graph.get_output_jsonschema.return_value = {"properties": {"bar": {}}}
        # Production now prefers the non-deprecated get_config_jsonschema().
        graph.get_config_jsonschema.return_value = {"properties": {"cfg": {}}}

        # Production prefers get_context_jsonschema(); make it raise to exercise
        # the inner context-specific warning path. context_schema stays present
        # (default MagicMock attr is truthy) so the outer guard is satisfied.
        graph.get_context_jsonschema.side_effect = ValueError("pydantic v2 schema gen failed")

        agent = LangGraphAgent(name="test", graph=graph)

        with self.assertLogs("ag_ui_langgraph.agent", level="WARNING") as log_ctx:
            result = agent.get_schema_keys({"configurable": {"thread_id": "t1"}})

        # input/output/config must be the computed keys, not the fallback.
        self.assertEqual(result["input"], ["foo", *agent.constant_schema_keys])
        self.assertEqual(result["output"], ["bar", *agent.constant_schema_keys])
        self.assertEqual(result["config"], ["cfg"])
        self.assertEqual(result["context"], [])

        # The inner warning (context-specific), not the outer fallback, should
        # fire.
        joined = "\n".join(log_ctx.output)
        self.assertIn("context_schema introspection failed", joined)
        self.assertNotIn("falling back to default schema keys", joined)


class TestChunkReasoningHelpersDictShape(unittest.IsolatedAsyncioTestCase):
    """C.7 — resolve_reasoning_content / resolve_encrypted_reasoning_content
    and the on_chat_model_stream path must tolerate chunks delivered as raw
    dicts (not just BaseMessage attribute-bearing objects).

    Regression for PR 1544 reviewer repro: an ``on_chat_model_stream``
    event whose ``event["data"]["chunk"]`` is a dict like
    ``{"response_metadata": {}, "tool_call_chunks": [], "content": "",
    "id": "msg-1"}`` previously raised ``AttributeError`` because the
    helpers did ``chunk.content`` / ``chunk.additional_kwargs`` directly.
    """

    def test_resolve_reasoning_content_accepts_dict_chunk(self):
        from ag_ui_langgraph.utils import resolve_reasoning_content

        # Must not raise AttributeError on dict-shaped chunks.
        result = resolve_reasoning_content(
            {
                "response_metadata": {},
                "tool_call_chunks": [],
                "content": "",
                "id": "msg-1",
            }
        )
        self.assertIsNone(result)

    def test_resolve_reasoning_content_dict_additional_kwargs(self):
        from ag_ui_langgraph.utils import resolve_reasoning_content

        # additional_kwargs path (DeepSeek / Qwen / xAI) on a dict chunk.
        result = resolve_reasoning_content(
            {
                "content": "",
                "additional_kwargs": {"reasoning_content": "deep thought"},
            }
        )
        self.assertIsNotNone(result)
        self.assertEqual(result["text"], "deep thought")

    def test_resolve_encrypted_reasoning_content_accepts_dict_chunk(self):
        from ag_ui_langgraph.utils import resolve_encrypted_reasoning_content

        result = resolve_encrypted_reasoning_content(
            {"content": [{"type": "redacted_thinking", "data": "opaque"}]}
        )
        self.assertEqual(result, "opaque")

        # dict-shaped empty chunk must be handled without AttributeError.
        self.assertIsNone(
            resolve_encrypted_reasoning_content(
                {
                    "response_metadata": {},
                    "tool_call_chunks": [],
                    "content": "",
                    "id": "msg-1",
                }
            )
        )

    async def test_handle_single_event_dict_chunk_does_not_raise(self):
        agent = make_agent()
        agent.active_run = {
            "id": "run-1",
            "node_name": "n",
            "has_function_streaming": False,
        }
        _record_dispatch(agent)

        event = {
            "event": "on_chat_model_stream",
            "data": {
                "chunk": {
                    "response_metadata": {},
                    "tool_call_chunks": [],
                    "content": "",
                    "id": "msg-1",
                }
            },
            "metadata": {},
        }

        # Previously raised AttributeError('dict' object has no attribute
        # 'content') inside resolve_reasoning_content. Must now drain
        # cleanly.
        collected = []
        async for ev in agent._handle_single_event(event, {"messages": []}):
            collected.append(ev)


class TestEmptyStringDeltaEmitsContentEvent(unittest.IsolatedAsyncioTestCase):
    """C.8 — An empty-string content delta on an in-progress assistant
    message must NOT emit ``TEXT_MESSAGE_END``.

    Regression for PR 1544 reviewer repro: with the prior truthy check
    ``tool_call_data is None and message_content``, ``""`` is falsey and
    the event falls through to the end-event branch, prematurely closing
    the streamed message. After the fix, an empty-string delta is a
    silent no-op and the in-progress message stays open.
    """

    async def test_empty_string_delta_does_not_end_message(self):
        from types import SimpleNamespace

        from ag_ui_langgraph.agent import MessageInProgress

        agent = make_agent()
        agent.active_run = {
            "id": "run-1",
            "node_name": "n",
            "has_function_streaming": False,
        }
        _record_dispatch(agent)

        # Put an in-progress text message into the agent so the code path
        # reaches the content-vs-end decision.
        agent.set_message_in_progress(
            "run-1",
            MessageInProgress(id="msg-1", tool_call_id=None, tool_call_name=None),
        )

        chunk = SimpleNamespace(
            content="",
            id="msg-1",
            response_metadata={},
            tool_call_chunks=[],
            additional_kwargs={},
        )
        event = {
            "event": "on_chat_model_stream",
            "data": {"chunk": chunk},
            "metadata": {},
        }

        collected = []
        async for ev in agent._handle_single_event(event, {"messages": []}):
            collected.append(ev)

        types = [getattr(e, "type", None) for e in collected]
        # The primary regression: a zero-length delta must NOT prematurely
        # close the in-progress assistant message.
        self.assertNotIn(
            EventType.TEXT_MESSAGE_END,
            types,
            f"empty-string delta prematurely closed the message: {types!r}",
        )
        # AG-UI's TextMessageContentEvent rejects delta="" (min_length=1),
        # so the correct behaviour is a silent no-op: no event is emitted,
        # and the message stays open for the next non-empty delta.
        self.assertEqual(collected, [])
        still_open = agent.get_message_in_progress("run-1")
        self.assertIsNotNone(still_open)
        self.assertEqual(still_open["id"], "msg-1")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
