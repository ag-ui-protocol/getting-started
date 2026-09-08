"""The streamed reasoning message must adopt the provider's canonical
reasoning id when the stream carries one.

Since 2111267 the snapshot converter (``_reasoning_block_to_agui_message``)
emits checkpointed reasoning under the provider's canonical block id (OpenAI
``rs_…``). If the streaming path mints a fresh ``uuid4`` instead, the client
can never reconcile the streamed copy with the snapshot copy and renders the
same reasoning twice (the langgraph-python dojo e2e strict-mode failure).

With ``use_responses_api=True``, the canonical id only travels on text-less
chunks — the ``response.output_item.added`` chunk (``{id, summary: []}``,
observed on the LangGraph Platform wire) and, depending on the
langchain-openai version, the ``…summary_part.added`` chunk (``{id, summary:
[{text: ""}]}``). The ``…summary_text.delta`` chunks carry text but no id.
These tests pin that:

  * ``resolve_reasoning_content`` surfaces the id-carrier chunks (instead of
    dropping them for having no text) and extracts the block id,
  * ``handle_reasoning_event`` stashes the id from a text-less chunk WITHOUT
    emitting anything (summary-less store=true items must keep rendering
    nothing) and opens the reasoning message under the stashed id when the
    first text delta arrives,
  * id-less providers keep the uuid fallback, and non-first summary parts
    never reuse the item id.
"""

import unittest

from ag_ui.core import EventType

from ag_ui_langgraph.utils import resolve_reasoning_content
from tests._helpers import make_agent, _record_dispatch


class FakeChunk:
    def __init__(self, content=None, additional_kwargs=None):
        self.content = content or []
        self.additional_kwargs = additional_kwargs or {}


class TestResolveReasoningContentCanonicalId(unittest.TestCase):
    def test_summary_part_added_chunk_carries_id(self):
        """`response.reasoning_summary_part.added` shape: empty text, id set.

        Must be surfaced (not dropped) so the id can seed REASONING_START.
        """
        chunk = FakeChunk(content=[{
            "type": "reasoning",
            "id": "rs-canonical",
            "summary": [{"index": 0, "type": "summary_text", "text": ""}],
            "index": 0,
        }])
        result = resolve_reasoning_content(chunk)
        self.assertIsNotNone(result)
        self.assertEqual(result["text"], "")
        self.assertEqual(result["id"], "rs-canonical")
        self.assertEqual(result["index"], 0)

    def test_summary_text_delta_chunk_has_no_id(self):
        """`response.reasoning_summary_text.delta` shape: text, no id —
        unchanged behavior, and no id key invented."""
        chunk = FakeChunk(content=[{
            "type": "reasoning",
            "summary": [{"index": 0, "type": "summary_text", "text": "Because X"}],
            "index": 0,
        }])
        result = resolve_reasoning_content(chunk)
        self.assertIsNotNone(result)
        self.assertEqual(result["text"], "Because X")
        self.assertIsNone(result.get("id"))

    def test_id_attached_when_text_and_id_both_present(self):
        chunk = FakeChunk(content=[{
            "type": "reasoning",
            "id": "rs-canonical",
            "summary": [{"index": 0, "type": "summary_text", "text": "Hi"}],
            "index": 0,
        }])
        result = resolve_reasoning_content(chunk)
        self.assertEqual(result["text"], "Hi")
        self.assertEqual(result["id"], "rs-canonical")

    def test_item_added_empty_summary_carries_id(self):
        """`response.output_item.added` shape ({id, summary: []}) — the only
        id carrier on the LangGraph Platform wire. Surfaced as a text-less
        carrier; handle_reasoning_event stashes it without emitting."""
        chunk = FakeChunk(content=[{
            "type": "reasoning",
            "id": "rs-canonical",
            "summary": [],
            "index": 0,
        }])
        result = resolve_reasoning_content(chunk)
        self.assertIsNotNone(result)
        self.assertEqual(result["text"], "")
        self.assertEqual(result["id"], "rs-canonical")

    def test_empty_summary_without_id_still_dropped(self):
        chunk = FakeChunk(content=[{"type": "reasoning", "summary": [], "index": 0}])
        self.assertIsNone(resolve_reasoning_content(chunk))

    def test_part_added_with_null_id_dropped(self):
        """Observed platform wire shape: part.added with `id: null` and empty
        text — nothing to surface."""
        chunk = FakeChunk(content=[{
            "type": "reasoning",
            "id": None,
            "summary": [{"index": 0, "type": "summary_text", "text": ""}],
            "index": 0,
        }])
        self.assertIsNone(resolve_reasoning_content(chunk))

    def test_non_first_summary_part_does_not_reuse_id(self):
        """A second summary part (summary index 1) belongs to the same
        reasoning item; reusing the canonical id there would mint two AG-UI
        messages with the same id. It must fall back to the uuid path."""
        chunk = FakeChunk(content=[{
            "type": "reasoning",
            "id": "rs-canonical",
            "summary": [{"index": 1, "type": "summary_text", "text": ""}],
            "index": 0,
        }])
        result = resolve_reasoning_content(chunk)
        self.assertIsNotNone(result)
        self.assertEqual(result["index"], 1)
        self.assertIsNone(result.get("id"))


class TestHandleReasoningEventCanonicalId(unittest.TestCase):
    def setUp(self):
        self.agent = _record_dispatch(make_agent())
        self.agent.active_run = {}

    def _events(self, reasoning_data):
        return list(self.agent.handle_reasoning_event(reasoning_data))

    def test_id_carrier_chunk_emits_nothing(self):
        """The text-less id carrier must not open a message — a store=true
        item (id only, no summary ever) must keep rendering nothing."""
        self._events({"type": "text", "text": "", "index": 0, "id": "rs-canonical"})
        self.assertEqual(self.agent.dispatched, [])
        # pending_reasoning_ids is keyed per subagent lane ("__root__" here).
        self.assertEqual(
            (self.agent.active_run.get("pending_reasoning_ids") or {}).get("__root__"),
            "rs-canonical",
        )

    def test_first_delta_opens_under_stashed_canonical_id(self):
        self._events({"type": "text", "text": "", "index": 0, "id": "rs-canonical"})
        self._events({"type": "text", "text": "Because X", "index": 0})
        start_events = [
            e for e in self.agent.dispatched if e.type == EventType.REASONING_START
        ]
        self.assertEqual(len(start_events), 1)
        self.assertEqual(start_events[0].message_id, "rs-canonical")
        # consumed: a later id-less reasoning item must not inherit it
        self.assertIsNone(
            (self.agent.active_run.get("pending_reasoning_ids") or {}).get("__root__")
        )

    def test_subsequent_deltas_join_the_canonical_message(self):
        self._events({"type": "text", "text": "", "index": 0, "id": "rs-canonical"})
        self._events({"type": "text", "text": "Because X", "index": 0})
        start_events = [
            e for e in self.agent.dispatched if e.type == EventType.REASONING_START
        ]
        content_events = [
            e
            for e in self.agent.dispatched
            if e.type == EventType.REASONING_MESSAGE_CONTENT
        ]
        self.assertEqual(len(start_events), 1)
        self.assertEqual(len(content_events), 1)
        self.assertEqual(content_events[0].message_id, "rs-canonical")
        self.assertEqual(content_events[0].delta, "Because X")

    def test_uuid_fallback_when_stream_has_no_id(self):
        self._events({"type": "text", "text": "thinking…", "index": 0})
        start_events = [
            e for e in self.agent.dispatched if e.type == EventType.REASONING_START
        ]
        self.assertEqual(len(start_events), 1)
        self.assertTrue(start_events[0].message_id)
        self.assertNotEqual(start_events[0].message_id, "rs-canonical")


if __name__ == "__main__":
    unittest.main()
