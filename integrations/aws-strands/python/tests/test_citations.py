"""Citations reach the client attached to the assistant message they annotate.

They ride the `citations` key of that message's metadata. Two things make this
more than a passthrough. Citations arrive interleaved with the text they
support, so what a client holds mid-stream has to be a whole prefix rather than
a fragment. And a ``MESSAGES_SNAPSHOT`` replaces the message a client
assembled, so the snapshot's own copy has to carry them or they vanish the
moment one arrives.

The single-agent tests drive a REAL ``strands.Agent`` over a scripted model
provider replaying Bedrock-shaped chunks, so the envelope under test is the one
Strands actually produces rather than one hand-built to match the adapter. The
orchestrator tests at the bottom use a fake Graph instead, because a real
``strands.multiagent`` Graph would need real node agents to script.

``CitationStreamEvent`` has two envelopes across the declared range
(``strands-agents>=1.15.0``): ``{"callback": {"citation": ..., "delta": ...}}``
on 1.15.0-1.20.0 and ``{"citation": ..., "delta": ...}`` from 1.21.0, verified
by reading each published wheel. Only the first is exercised by a real Agent
here, because that is what the lockfile resolves, so
``test_both_citation_envelopes_are_read`` pins the other one directly against
``citation_from_event``.
"""

from __future__ import annotations

import logging

from typing import Any, AsyncIterable, Optional

import pytest
from ag_ui.core import AssistantMessage, EventType, RunAgentInput, UserMessage
from ag_ui.encoder import EventEncoder
from strands import Agent as StrandsAgentCore
from strands import tool
from strands.models.model import Model
from unittest.mock import MagicMock

from ag_ui_strands.agent import StrandsAgent
from ag_ui_strands.citations import (
    CITATIONS_METADATA_KEY,
    CitationAccumulator,
    citation_from_event,
    copy_metadata,
    discard_orphans,
    normalize_citation,
    normalize_location,
)
from ag_ui_strands.config import StrandsAgentConfig


CITATION = {
    "title": "quarterly-report.pdf",
    "sourceContent": [{"text": "revenue grew 12%"}],
    "location": {"documentChar": {"documentIndex": 0, "start": 10, "end": 26}},
}


class ScriptedModel(Model):
    """Replays canned Bedrock-shaped stream turns, one turn per invocation."""

    def __init__(self, turns: list[list[dict]]) -> None:
        self._turns = list(turns)
        self.calls = 0

    def update_config(self, **model_config: Any) -> None:  # pragma: no cover
        pass

    def get_config(self) -> Any:  # pragma: no cover
        return {}

    def structured_output(self, *args: Any, **kwargs: Any):  # pragma: no cover
        raise NotImplementedError

    async def stream(
        self,
        messages: Any,
        tool_specs: Optional[list] = None,
        system_prompt: Optional[str] = None,
        **kwargs: Any,
    ) -> AsyncIterable[dict]:
        turn = self._turns[min(self.calls, len(self._turns) - 1)]
        self.calls += 1
        for event in turn:
            yield event


def _turn(*parts: dict) -> list[dict]:
    """One assistant turn whose content block replays ``parts`` in order.

    Bedrock interleaves citation deltas with the text deltas of the same
    content block, so the caller controls the order rather than getting text
    then citations.
    """
    return [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockStart": {"start": {}}},
        *({"contentBlockDelta": {"delta": part}} for part in parts),
        {"contentBlockStop": {}},
        {"messageStop": {"stopReason": "end_turn"}},
    ]


def _text_then_tool_turn(*parts: dict, tool_use_id: str, name: str) -> list[dict]:
    """A turn whose text block is followed, in the same turn, by a tool call."""
    return [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockStart": {"start": {}}},
        *({"contentBlockDelta": {"delta": part}} for part in parts),
        {"contentBlockStop": {}},
        {
            "contentBlockStart": {
                "start": {"toolUse": {"toolUseId": tool_use_id, "name": name}}
            }
        },
        {"contentBlockDelta": {"delta": {"toolUse": {"input": "{}"}}}},
        {"contentBlockStop": {}},
        {"messageStop": {"stopReason": "tool_use"}},
    ]


def _template_agent() -> MagicMock:
    mock = MagicMock()
    mock.model = MagicMock()
    mock.system_prompt = "You are helpful"
    mock.tool_registry.registry = {}
    mock.record_direct_tool_call = True
    return mock


def _wrap(
    strands_agent: StrandsAgentCore, config: StrandsAgentConfig | None = None
) -> StrandsAgent:
    agent = StrandsAgent(
        _template_agent(), name="test-agent", config=config or StrandsAgentConfig()
    )
    agent._agents_by_thread["t1"] = strands_agent
    return agent


async def _collect(agent: StrandsAgent) -> list:
    run_input = RunAgentInput(
        thread_id="t1",
        run_id="r1",
        state={},
        messages=[UserMessage(id="u1", role="user", content="hello")],
        tools=[],
        context=[],
        forwarded_props={},
    )
    events = [event async for event in agent.run(run_input)]
    encoder = EventEncoder()
    for event in events:
        encoder.encode(event)
    return events


def _of_type(events: list, event_type: EventType) -> list:
    return [e for e in events if e.type == event_type]


def _cited(event: Any) -> Optional[list]:
    metadata = getattr(event, "metadata", None)
    return None if metadata is None else metadata.get(CITATIONS_METADATA_KEY)


def _last_snapshot_assistant(events: list):
    snapshots = _of_type(events, EventType.MESSAGES_SNAPSHOT)
    if not snapshots:
        return None
    assistants = [m for m in snapshots[-1].messages if m.role == "assistant"]
    return assistants[-1] if assistants else None


@pytest.mark.asyncio
async def test_each_citation_publishes_on_the_next_text_delta():
    """A reader sees its sources while the answer is still streaming."""
    strands_agent = StrandsAgentCore(
        model=ScriptedModel(
            [
                _turn(
                    {"text": "Revenue grew 12%."},
                    {"citation": {**CITATION, "title": "first.pdf"}},
                    {"text": " Margins held."},
                    {"citation": {**CITATION, "title": "second.pdf"}},
                    {"text": " Costs fell."},
                )
            ]
        ),
        callback_handler=None,
    )

    contents = _of_type(
        await _collect(_wrap(strands_agent)), EventType.TEXT_MESSAGE_CONTENT
    )

    # Nothing before the first citation, then one, then both. Each publish is a
    # complete list because metadata merging replaces a key rather than
    # appending to it.
    assert [
        None if _cited(e) is None else [c["title"] for c in _cited(e)]
        for e in contents
    ] == [None, ["first.pdf"], ["first.pdf", "second.pdf"]]


@pytest.mark.asyncio
async def test_an_unchanged_list_is_not_resent_on_every_later_delta():
    strands_agent = StrandsAgentCore(
        model=ScriptedModel(
            [
                _turn(
                    {"text": "a"},
                    {"citation": CITATION},
                    {"text": "b"},
                    {"text": "c"},
                    {"text": "d"},
                )
            ]
        ),
        callback_handler=None,
    )

    contents = _of_type(
        await _collect(_wrap(strands_agent)), EventType.TEXT_MESSAGE_CONTENT
    )

    assert len([e for e in contents if _cited(e) is not None]) == 1


@pytest.mark.asyncio
async def test_text_offset_records_how_much_had_streamed():
    strands_agent = StrandsAgentCore(
        model=ScriptedModel(
            [
                _turn(
                    {"text": "Revenue grew."},
                    {"citation": {**CITATION, "title": "first.pdf"}},
                    {"text": " Margins held."},
                    {"citation": {**CITATION, "title": "second.pdf"}},
                )
            ]
        ),
        callback_handler=None,
    )

    end = _of_type(
        await _collect(_wrap(strands_agent)), EventType.TEXT_MESSAGE_END
    )[0]

    assert [c["textOffset"] for c in _cited(end)] == [
        len("Revenue grew."),
        len("Revenue grew. Margins held."),
    ]


@pytest.mark.asyncio
async def test_a_citation_with_no_text_after_it_still_reaches_the_client():
    """The mid-stream publish rides the next text delta, so a citation that
    arrives last has only the closing events to travel on."""
    strands_agent = StrandsAgentCore(
        model=ScriptedModel(
            [_turn({"text": "Revenue grew."}, {"citation": CITATION})]
        ),
        callback_handler=None,
    )

    events = await _collect(_wrap(strands_agent))

    contents = _of_type(events, EventType.TEXT_MESSAGE_CONTENT)
    assert all(_cited(e) is None for e in contents)

    end = _of_type(events, EventType.TEXT_MESSAGE_END)[0]
    assert len(_cited(end)) == 1


@pytest.mark.asyncio
async def test_the_snapshot_message_carries_them_too():
    """A snapshot replaces the message a client assembled, metadata included."""
    strands_agent = StrandsAgentCore(
        model=ScriptedModel(
            [_turn({"text": "Revenue grew."}, {"citation": CITATION})]
        ),
        callback_handler=None,
    )

    message = _last_snapshot_assistant(await _collect(_wrap(strands_agent)))

    assert message.content == "Revenue grew."
    assert [c["title"] for c in message.metadata[CITATIONS_METADATA_KEY]] == [
        "quarterly-report.pdf"
    ]


@pytest.mark.asyncio
async def test_nothing_is_attached_when_the_model_cites_nothing():
    strands_agent = StrandsAgentCore(
        model=ScriptedModel([_turn({"text": "Revenue grew."})]),
        callback_handler=None,
    )

    events = await _collect(_wrap(strands_agent))

    assert all(_cited(e) is None for e in events)
    assert _last_snapshot_assistant(events).metadata is None


@pytest.mark.asyncio
async def test_one_message_citations_do_not_leak_into_the_next():
    """A tool call closes the assistant turn and rotates message_id."""

    @tool
    def lookup() -> str:
        """Look something up."""
        return "ok"

    strands_agent = StrandsAgentCore(
        model=ScriptedModel(
            [
                _text_then_tool_turn(
                    {"text": "Revenue grew."},
                    {"citation": {**CITATION, "title": "first.pdf"}},
                    tool_use_id="tool-1",
                    name="lookup",
                ),
                _turn({"text": "Done."}),
            ]
        ),
        tools=[lookup],
        callback_handler=None,
    )

    ends = _of_type(await _collect(_wrap(strands_agent)), EventType.TEXT_MESSAGE_END)

    assert [c["title"] for c in _cited(ends[0])] == ["first.pdf"]
    assert _cited(ends[-1]) is None


@pytest.mark.asyncio
async def test_the_wire_shape_drops_empties_and_unwraps_the_location():
    """The shape both adapters have to agree on.

    Bedrock wraps the location in the key naming its kind; the TypeScript SDK
    hands its adapter the flattened, discriminated form. Unwrapping here is
    what makes the two emit the same object. Absent fields stay absent rather
    than becoming empty strings, for the same reason.
    """
    strands_agent = StrandsAgentCore(
        model=ScriptedModel(
            [
                _turn(
                    {"text": "x"},
                    {
                        "citation": {
                            "title": "",
                            "source": "",
                            "sourceContent": [{"text": ""}],
                            "location": {
                                "documentPage": {
                                    "documentIndex": 2,
                                    "start": 4,
                                    "end": 5,
                                }
                            },
                        }
                    },
                )
            ]
        ),
        callback_handler=None,
    )

    end = _of_type(
        await _collect(_wrap(strands_agent)), EventType.TEXT_MESSAGE_END
    )[0]

    assert _cited(end) == [
        {
            "location": {
                "type": "documentPage",
                "documentIndex": 2,
                "start": 4,
                "end": 5,
            },
            "textOffset": 1,
        }
    ]


@pytest.mark.asyncio
async def test_citations_survive_the_run_without_message_snapshots():
    """With snapshots off the message events are the only channel."""
    strands_agent = StrandsAgentCore(
        model=ScriptedModel(
            [_turn({"text": "Revenue grew."}, {"citation": CITATION})]
        ),
        callback_handler=None,
    )

    events = await _collect(
        _wrap(strands_agent, StrandsAgentConfig(emit_messages_snapshot=False))
    )

    assert _of_type(events, EventType.MESSAGES_SNAPSHOT) == []
    end = _of_type(events, EventType.TEXT_MESSAGE_END)[0]
    assert [c["title"] for c in _cited(end)] == ["quarterly-report.pdf"]


# ---------------------------------------------------------------------------
# Multi-agent orchestrator path
# ---------------------------------------------------------------------------
#
# A separate translation path with its own per-node message envelopes and no
# message snapshot behind it, so a node's citations reach the client only
# through that node's own message events. A Graph runs its nodes concurrently
# and multiplexes their events into one queue, which is why the accumulator is
# keyed by node rather than shared.


class FakeOrchestrator:
    """Graph stand-in with the shape that routes down the orchestrator path."""

    def __init__(self, events: list) -> None:
        self.id = "test-graph"
        self.nodes: dict = {}
        self._events = events

    async def stream_async(self, task, invocation_state=None, **kwargs):
        for event in self._events:
            yield event


def _node_stream(node_id: str, inner: dict) -> dict:
    return {"type": "multiagent_node_stream", "node_id": node_id, "event": inner}


def _node_start(node_id: str) -> dict:
    return {
        "type": "multiagent_node_start",
        "node_id": node_id,
        "node_type": "agent",
    }


def _node_stop(node_id: str) -> dict:
    return {"type": "multiagent_node_stop", "node_id": node_id}


@pytest.mark.asyncio
async def test_orchestrator_attaches_a_node_citation_to_that_node_message():
    orchestrator = FakeOrchestrator(
        [
            _node_start("researcher"),
            _node_stream("researcher", {"data": "Revenue grew."}),
            _node_stream(
                "researcher",
                {"citation": {**CITATION, "title": "first.pdf"}, "delta": {}},
            ),
            _node_stop("researcher"),
            _node_start("writer"),
            _node_stream("writer", {"data": "Final answer."}),
            _node_stop("writer"),
        ]
    )

    events = await _collect(StrandsAgent(orchestrator, name="test"))
    ends = _of_type(events, EventType.TEXT_MESSAGE_END)

    assert [c["title"] for c in _cited(ends[0])] == ["first.pdf"]
    assert _cited(ends[0])[0]["textOffset"] == len("Revenue grew.")
    assert _cited(ends[1]) is None


@pytest.mark.asyncio
async def test_orchestrator_keeps_concurrent_nodes_citations_apart():
    """Two nodes interleaved in one queue must not inherit each other's sources."""
    orchestrator = FakeOrchestrator(
        [
            _node_start("a"),
            _node_start("b"),
            _node_stream("a", {"data": "one"}),
            _node_stream("b", {"data": "two"}),
            _node_stream(
                "a", {"citation": {**CITATION, "title": "a.pdf"}, "delta": {}}
            ),
            _node_stream(
                "b", {"citation": {**CITATION, "title": "b.pdf"}, "delta": {}}
            ),
            _node_stop("a"),
            _node_stop("b"),
        ]
    )

    events = await _collect(StrandsAgent(orchestrator, name="test"))
    ends = _of_type(events, EventType.TEXT_MESSAGE_END)

    assert [[c["title"] for c in _cited(e)] for e in ends] == [
        ["a.pdf"],
        ["b.pdf"],
    ]


# ---------------------------------------------------------------------------
# Regressions found in review
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_offsets_restart_per_message_with_snapshots_off():
    """The offset belongs to the message, not to the run.

    It used to be measured from ``accumulated_text``, which is reset only
    inside the ``emit_snapshots`` guard, so with snapshots off the counter kept
    climbing and every message after the first carried run-wide offsets.
    """

    @tool
    def lookup() -> str:
        """Look something up."""
        return "ok"

    strands_agent = StrandsAgentCore(
        model=ScriptedModel(
            [
                _text_then_tool_turn(
                    {"text": "Revenue grew."},
                    {"citation": {**CITATION, "title": "first.pdf"}},
                    tool_use_id="tool-1",
                    name="lookup",
                ),
                _turn(
                    {"text": "Margins held."},
                    {"citation": {**CITATION, "title": "second.pdf"}},
                ),
            ]
        ),
        tools=[lookup],
        callback_handler=None,
    )

    events = await _collect(
        _wrap(strands_agent, StrandsAgentConfig(emit_messages_snapshot=False))
    )
    ends = _of_type(events, EventType.TEXT_MESSAGE_END)

    assert [c["textOffset"] for c in _cited(ends[0])] == [len("Revenue grew.")]
    # Not len("Revenue grew.") + len("Margins held.").
    assert [c["textOffset"] for c in _cited(ends[-1])] == [len("Margins held.")]


@pytest.mark.asyncio
async def test_the_seeded_snapshot_keeps_a_previous_turn_citations():
    """Turn two must not erase what turn one delivered.

    A ``MESSAGES_SNAPSHOT`` replaces the message a client assembled, and the
    seed is rebuilt from ``RunAgentInput.messages`` field by field. Dropping
    metadata there wiped the prior turn's citations the moment a second turn
    started.
    """
    prior = AssistantMessage(
        id="a1",
        role="assistant",
        content="Revenue grew.",
        metadata={CITATIONS_METADATA_KEY: [{"title": "first.pdf", "textOffset": 13}]},
    )

    strands_agent = StrandsAgentCore(
        model=ScriptedModel([_turn({"text": "Margins held."})]),
        callback_handler=None,
    )
    agent = _wrap(strands_agent)

    run_input = RunAgentInput(
        thread_id="t1",
        run_id="r2",
        state={},
        messages=[
            UserMessage(id="u1", role="user", content="hello"),
            prior,
            UserMessage(id="u2", role="user", content="and margins?"),
        ],
        tools=[],
        context=[],
        forwarded_props={},
    )
    events = [e async for e in agent.run(run_input)]
    encoder = EventEncoder()
    for event in events:
        encoder.encode(event)

    snapshots = _of_type(events, EventType.MESSAGES_SNAPSHOT)
    assert snapshots, "expected a snapshot to inspect"
    echoed = [m for m in snapshots[-1].messages if m.id == "a1"]
    assert echoed, "the prior assistant turn should still be in the snapshot"
    assert [c["title"] for c in echoed[0].metadata[CITATIONS_METADATA_KEY]] == [
        "first.pdf"
    ]


@pytest.mark.asyncio
async def test_a_citation_with_no_text_is_dropped_loudly_not_carried_forward(caplog):
    """There is no message for it to annotate, and it must not reach the next one."""

    @tool
    def lookup() -> str:
        """Look something up."""
        return "ok"

    strands_agent = StrandsAgentCore(
        model=ScriptedModel(
            [
                _text_then_tool_turn(
                    {"citation": {**CITATION, "title": "orphan.pdf"}},
                    tool_use_id="tool-1",
                    name="lookup",
                ),
                _turn({"text": "Margins held."}),
            ]
        ),
        tools=[lookup],
        callback_handler=None,
    )

    with caplog.at_level("WARNING"):
        events = await _collect(_wrap(strands_agent))

    for end in _of_type(events, EventType.TEXT_MESSAGE_END):
        assert _cited(end) is None, "an orphaned citation reached a later message"
    assert any("no open assistant message" in r.message for r in caplog.records)


@pytest.mark.asyncio
async def test_an_unserializable_citation_is_dropped_rather_than_breaking_the_stream(
    caplog,
):
    """A value that will not encode would abort the whole SSE stream."""

    class Unencodable:
        pass

    strands_agent = StrandsAgentCore(
        model=ScriptedModel(
            [
                _turn(
                    {"text": "Revenue grew."},
                    {
                        "citation": {
                            "title": "bad.pdf",
                            # Survives location normalisation (it is a wrapped
                            # dict) and fails only at the encoder, which is the
                            # path the guard exists for.
                            "location": {"documentChar": {"start": Unencodable()}},
                        }
                    },
                    {"citation": {**CITATION, "title": "good.pdf"}},
                )
            ]
        ),
        callback_handler=None,
    )

    with caplog.at_level("WARNING"):
        events = await _collect(_wrap(strands_agent))

    end = _of_type(events, EventType.TEXT_MESSAGE_END)[0]
    assert [c["title"] for c in _cited(end)] == ["good.pdf"]
    assert any("unserializable citation" in r.message for r in caplog.records)


@pytest.mark.asyncio
async def test_a_non_finite_number_is_dropped_rather_than_silently_nulled():
    """``json.dumps`` would emit a bare NaN token, which is not JSON."""
    strands_agent = StrandsAgentCore(
        model=ScriptedModel(
            [
                _turn(
                    {"text": "x"},
                    {
                        "citation": {
                            "title": "nan.pdf",
                            "location": {"documentChar": {"start": float("nan")}},
                        }
                    },
                )
            ]
        ),
        callback_handler=None,
    )

    end = _of_type(await _collect(_wrap(strands_agent)), EventType.TEXT_MESSAGE_END)[0]
    assert _cited(end) is None


@pytest.mark.asyncio
async def test_a_citation_naming_no_source_at_all_is_dropped():
    """An entry holding only an offset points a reader at nothing."""
    strands_agent = StrandsAgentCore(
        model=ScriptedModel([_turn({"text": "x"}, {"citation": {"location": {}}})]),
        callback_handler=None,
    )

    end = _of_type(await _collect(_wrap(strands_agent)), EventType.TEXT_MESSAGE_END)[0]
    assert _cited(end) is None


@pytest.mark.asyncio
async def test_the_quoted_passage_and_source_reach_the_wire():
    """The fields a reader actually renders, pinned individually."""
    strands_agent = StrandsAgentCore(
        model=ScriptedModel(
            [
                _turn(
                    {"text": "Revenue grew."},
                    {
                        "citation": {
                            "title": "quarterly-report.pdf",
                            "source": "s3://reports/quarterly-report.pdf",
                            "sourceContent": [{"text": "revenue grew 12%"}],
                            "location": {"web": {"url": "https://example.test/q4"}},
                        }
                    },
                )
            ]
        ),
        callback_handler=None,
    )

    end = _of_type(await _collect(_wrap(strands_agent)), EventType.TEXT_MESSAGE_END)[0]

    assert _cited(end) == [
        {
            "title": "quarterly-report.pdf",
            "source": "s3://reports/quarterly-report.pdf",
            "sourceContent": [{"text": "revenue grew 12%"}],
            "location": {"type": "web", "url": "https://example.test/q4"},
            "textOffset": len("Revenue grew."),
        }
    ]


def test_both_citation_envelopes_are_read():
    """The declared range spans both, and only one is installed here.

    Verified against the published wheels: 1.15.0 through 1.20.0 nest the
    citation under ``callback``, 1.21.0 onward put it at the top level.
    """
    citation = {"title": "x.pdf"}
    assert (
        citation_from_event({"callback": {"citation": citation, "delta": {}}})
        == citation
    )
    assert citation_from_event({"citation": citation, "delta": {}}) == citation
    # An unpaired citation key belongs to the RAW fallback, not to this branch.
    assert citation_from_event({"citation": citation}) is None


def test_a_published_list_is_not_mutated_by_a_later_publish():
    """A consumer holding an earlier publish must not see it change."""
    accumulator = CitationAccumulator()
    accumulator.advance("Revenue grew.")
    accumulator.add({"title": "first.pdf", "sourceContent": [{"text": "a"}]})

    first = accumulator.pending()
    first[CITATIONS_METADATA_KEY][0]["sourceContent"][0]["text"] = "mutated"

    assert (
        accumulator.take()[CITATIONS_METADATA_KEY][0]["sourceContent"][0]["text"] == "a"
    )


# ---------------------------------------------------------------------------
# The shape contract the two adapters share
# ---------------------------------------------------------------------------
#
# Each assertion below has a byte-for-byte counterpart in the TypeScript
# adapter's `citations.test.ts`, under the same heading. They are the executable
# form of the README's claim that both bridges produce equal objects for the
# same Bedrock response, so a change to one that is not made to the other shows
# up as a diff between two test files rather than as a support ticket.

# A four-byte emoji: one Python character, two UTF-16 code units. The offset is
# an index a browser will slice with, so UTF-16 is the unit both sides count.
EMOJI_TEXT = "Revenue grew \U0001f4c8 fast."
EMOJI_UTF16_LEN = 21


def test_the_offset_counts_utf16_code_units_not_python_characters():
    """Both adapters must land on the same number for the same text."""
    accumulator = CitationAccumulator()
    accumulator.advance(EMOJI_TEXT)
    accumulator.add({"title": "x.pdf"})

    assert len(EMOJI_TEXT) == EMOJI_UTF16_LEN - 1, "fixture must contain an astral char"
    assert accumulator.take()[CITATIONS_METADATA_KEY][0]["textOffset"] == EMOJI_UTF16_LEN


def test_a_search_result_location_is_renamed_to_the_shared_discriminator():
    """Bedrock wraps it as `searchResultLocation`; the TS SDK emits `searchResult`."""
    assert normalize_location(
        {"searchResultLocation": {"searchResultIndex": 2, "start": 1, "end": 4}}
    ) == {"type": "searchResult", "searchResultIndex": 2, "start": 1, "end": 4}


def test_known_location_kinds_keep_their_names():
    for kind in ("documentChar", "documentPage", "documentChunk", "web"):
        assert normalize_location({kind: {"start": 1}})["type"] == kind


def test_an_empty_or_unusable_location_is_not_a_location():
    assert normalize_location({"documentChar": {}}) is None
    assert normalize_location({}) is None
    assert normalize_location(None) is None
    assert normalize_location("documentChar") is None
    assert normalize_location(False) is None
    # A wrapper whose payload is not an object would otherwise pass through
    # undiscriminated and rescue a citation that names no source.
    assert normalize_location({"documentChar": "0-9"}) is None
    assert normalize_citation({"location": {"documentChar": "0-9"}}, 0) is None


def test_location_fields_the_provider_left_empty_are_dropped():
    """The SDK omits a falsy `domain` rather than emitting it."""
    assert normalize_location({"web": {"url": "https://example.test", "domain": ""}}) == {
        "type": "web",
        "url": "https://example.test",
    }


def test_an_already_flattened_location_passes_through():
    flat = {"type": "documentChar", "documentIndex": 0, "start": 1, "end": 2}
    assert normalize_location(flat) == flat


def test_a_citation_rescued_only_by_an_empty_location_is_still_dropped():
    assert normalize_citation({"title": "", "location": {"documentChar": {}}}, 0) is None


def test_a_citation_that_is_not_an_object_is_dropped_with_a_warning(caplog):
    with caplog.at_level("WARNING"):
        assert normalize_citation(["not", "a", "citation"], 0) is None
    assert any("not an object" in r.message for r in caplog.records)


def test_the_drop_warning_survives_a_citation_with_uncomparable_keys():
    """This path exists to survive a malformed citation, so it must not raise."""
    assert normalize_citation({1: "a", "b": "c"}, 0) is None


# ---------------------------------------------------------------------------
# More regressions found in review
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_snapshot_copy_is_independent_of_the_event_on_the_wire():
    """The retained message is re-emitted in every later snapshot of the run."""
    strands_agent = StrandsAgentCore(
        model=ScriptedModel(
            [_turn({"text": "Revenue grew."}, {"citation": CITATION})]
        ),
        callback_handler=None,
    )

    events = await _collect(_wrap(strands_agent))
    end = _of_type(events, EventType.TEXT_MESSAGE_END)[0]
    message = _last_snapshot_assistant(events)

    wire = _cited(end)
    retained = message.metadata[CITATIONS_METADATA_KEY]
    assert wire == retained
    assert wire is not retained
    wire[0]["title"] = "mutated"
    assert retained[0]["title"] == "quarterly-report.pdf"


@pytest.mark.asyncio
async def test_reasoning_does_not_destroy_a_citation_waiting_for_its_message():
    """A node can cite before its first text delta, with reasoning in between."""
    orchestrator = FakeOrchestrator(
        [
            _node_start("thinker"),
            _node_stream(
                "thinker",
                {"citation": {**CITATION, "title": "early.pdf"}, "delta": {}},
            ),
            _node_stream(
                "thinker", {"reasoningText": "considering", "reasoning": True}
            ),
            _node_stream("thinker", {"data": "Revenue grew."}),
            _node_stop("thinker"),
        ]
    )

    events = await _collect(StrandsAgent(orchestrator, name="test"))
    ends = _of_type(events, EventType.TEXT_MESSAGE_END)

    assert len(ends) == 1
    assert [c["title"] for c in _cited(ends[0])] == ["early.pdf"]


@pytest.mark.asyncio
async def test_a_node_that_only_cites_is_swept_with_a_warning(caplog):
    """Nothing to annotate, so the sources are dropped rather than reassigned."""
    orchestrator = FakeOrchestrator(
        [
            _node_start("citer"),
            _node_stream(
                "citer", {"citation": {**CITATION, "title": "orphan.pdf"}, "delta": {}}
            ),
            _node_stop("citer"),
            _node_start("writer"),
            _node_stream("writer", {"data": "Revenue grew."}),
            _node_stop("writer"),
        ]
    )

    with caplog.at_level("WARNING"):
        events = await _collect(StrandsAgent(orchestrator, name="test"))

    ends = _of_type(events, EventType.TEXT_MESSAGE_END)
    assert len(ends) == 1
    assert _cited(ends[0]) is None
    assert any("no open assistant message" in r.message for r in caplog.records)
    assert any("(node_id=citer)" in r.message for r in caplog.records)


def test_the_orphan_warning_carries_exactly_one_label():
    """Callers pass a pre-labelled context, so the message must not add its own."""
    accumulator = CitationAccumulator()
    accumulator.add({"title": "orphan.pdf"})

    records: list[str] = []
    handler = logging.Handler()
    handler.emit = lambda record: records.append(record.getMessage())
    logger = logging.getLogger("ag_ui_strands.citations")
    logger.addHandler(handler)
    try:
        discard_orphans(accumulator, "node_id=citer")
    finally:
        logger.removeHandler(handler)

    assert records, "expected a warning"
    assert "(node_id=citer)" in records[0]
    assert "thread_id=node_id" not in records[0]


def test_a_lone_surrogate_in_the_text_does_not_abort_the_run():
    """A Python str can hold one; encoding it would raise from the text path."""
    accumulator = CitationAccumulator()
    accumulator.advance("ab\ud800c")
    accumulator.add({"title": "x.pdf"})

    # Four UTF-16 code units, which is also what `"ab\ud800c".length` is in JS.
    assert accumulator.take()[CITATIONS_METADATA_KEY][0]["textOffset"] == 4


def test_a_location_whose_discriminator_is_not_a_string_is_dropped():
    """Mirrors the TypeScript rule; without it the two adapters disagree."""
    assert normalize_location({"type": 42, "start": 1}) is None
    assert normalize_location({"type": "", "start": 1}) is None


def test_a_citation_list_that_stops_encoding_is_dropped_with_a_warning(caplog):
    """The snapshot copy must not disagree with the event on the wire."""

    class Unencodable:
        pass

    with caplog.at_level("WARNING"):
        assert copy_metadata({CITATIONS_METADATA_KEY: [Unencodable()]}) is None
    assert any("no longer encodes" in r.message for r in caplog.records)


@pytest.mark.asyncio
async def test_client_metadata_is_copied_into_the_snapshot_not_referenced():
    """The rebuilt message is retained and re-emitted in every later snapshot.

    Handing back the caller's own dict aliased a client's input into all of
    them, so a later mutation of one would rewrite history.
    """
    from ag_ui_strands.agent import _build_snapshot_messages

    original = {CITATIONS_METADATA_KEY: [{"title": "first.pdf", "textOffset": 3}]}
    prior = AssistantMessage(
        id="a1", role="assistant", content="abc", metadata=original
    )

    rebuilt = _build_snapshot_messages([prior])

    assert rebuilt[0].metadata == original
    assert rebuilt[0].metadata is not original
    original[CITATIONS_METADATA_KEY][0]["title"] = "mutated"
    assert rebuilt[0].metadata[CITATIONS_METADATA_KEY][0]["title"] == "first.pdf"


@pytest.mark.asyncio
async def test_client_metadata_that_will_not_encode_is_dropped_not_forwarded(caplog):
    """It would otherwise fail at encode time with the whole run in flight."""
    from ag_ui_strands.agent import _build_snapshot_messages

    class Unencodable:
        pass

    prior = AssistantMessage(
        id="a1", role="assistant", content="abc", metadata={"bad": Unencodable()}
    )

    with caplog.at_level("WARNING"):
        rebuilt = _build_snapshot_messages([prior])

    assert rebuilt[0].metadata is None
    assert any("will not encode" in r.message for r in caplog.records)


def test_an_untagged_location_is_omitted_with_a_warning_not_in_silence(caplog):
    """The citation survives; only the location this adapter cannot place goes.

    A provider sending an untagged shape still named a source, so dropping the
    whole citation would lose more than it protects.
    """
    with caplog.at_level("WARNING"):
        entry = normalize_citation(
            {"title": "quarterly-report.pdf", "location": {"documentChar": "0-9"}}, 4
        )

    assert entry == {"title": "quarterly-report.pdf", "textOffset": 4}
    assert any("not in tagged form" in r.message for r in caplog.records)


def test_an_absent_location_is_not_warned_about(caplog):
    """Only a location that was sent and could not be read earns the warning."""
    with caplog.at_level("WARNING"):
        entry = normalize_citation({"title": "x.pdf"}, 0)

    assert entry == {"title": "x.pdf", "textOffset": 0}
    assert not any("not in tagged form" in r.message for r in caplog.records)
