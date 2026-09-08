"""Regression tests for non-text Strands tool results (issue #2233)."""

from __future__ import annotations

import base64
import json
from unittest.mock import MagicMock

import pytest
from ag_ui.core import EventType, RunAgentInput, UserMessage
from strands.tools.registry import ToolRegistry

from ag_ui_strands.agent import StrandsAgent
from ag_ui_strands.config import StrandsAgentConfig
from tests.json_wire_fixture import PARITY_JSON, PARITY_VALUE


def _build_agent(thread_id: str, result_content: list[dict]) -> StrandsAgent:
    template = MagicMock()
    template.model = MagicMock()
    template.system_prompt = "You are helpful"
    template.tool_registry.registry = {}
    template.record_direct_tool_call = True

    agent = StrandsAgent(
        template, name="test-agent", config=StrandsAgentConfig()
    )
    inner = MagicMock()
    inner.tool_registry = ToolRegistry()
    inner.session_manager = None

    async def _stream(_message):
        yield {
            "current_tool_use": {
                "name": "backend_tool",
                "toolUseId": "backend-1",
                "input": {},
            }
        }
        yield {"event": {"contentBlockStop": {}}}
        yield {
            "message": {
                "role": "user",
                "content": [
                    {
                        "toolResult": {
                            "toolUseId": "backend-1",
                            "content": result_content,
                        }
                    }
                ],
            }
        }

    inner.stream_async = _stream
    agent._agents_by_thread[thread_id] = inner
    return agent


async def _tool_result_content(result_content: list[dict]) -> str:
    thread_id = f"non-text-{len(result_content)}-{id(result_content)}"
    agent = _build_agent(thread_id, result_content)
    input_data = RunAgentInput(
        thread_id=thread_id,
        run_id="run-1",
        state={},
        messages=[UserMessage(id="user-1", content="run the tool")],
        tools=[],
        context=[],
        forwarded_props={},
    )
    events = [event async for event in agent.run(input_data)]
    results = [
        event for event in events if event.type == EventType.TOOL_CALL_RESULT
    ]
    assert len(results) == 1
    return results[0].content


@pytest.mark.parametrize(
    ("block", "expected"),
    [
        ({"json": {"ok": True}}, {"ok": True}),
        (
            {"image": {"format": "png", "source": {"bytes": b"\x00\x01"}}},
            {
                "image": {
                    "format": "png",
                    "source": {
                        "bytes": base64.b64encode(b"\x00\x01").decode()
                    },
                }
            },
        ),
        (
            {
                "document": {
                    "name": "result.pdf",
                    "format": "pdf",
                    "source": {"bytes": b"\x02\x03"},
                }
            },
            {
                "document": {
                    "name": "result.pdf",
                    "format": "pdf",
                    "source": {
                        "bytes": base64.b64encode(b"\x02\x03").decode()
                    },
                }
            },
        ),
        (
            {"video": {"format": "mp4", "source": {"bytes": b"\x04\x05"}}},
            {
                "video": {
                    "format": "mp4",
                    "source": {
                        "bytes": base64.b64encode(b"\x04\x05").decode()
                    },
                }
            },
        ),
    ],
)
async def test_non_text_result_is_forwarded(block: dict, expected: dict):
    content = await _tool_result_content([block])
    assert json.loads(content) == expected


async def test_multiple_non_text_results_are_forwarded_in_order():
    content = await _tool_result_content(
        [
            {"image": {"format": "png", "source": {"bytes": b"\x00\x01"}}},
            {
                "document": {
                    "name": "result.pdf",
                    "format": "pdf",
                    "source": {"bytes": b"\x02\x03"},
                }
            },
        ]
    )
    assert json.loads(content) == [
        {"image": {"format": "png", "source": {"bytes": "AAE="}}},
        {
            "document": {
                "name": "result.pdf",
                "format": "pdf",
                "source": {"bytes": "AgM="},
            }
        },
    ]


async def test_empty_result_still_closes_the_tool_with_empty_content():
    assert await _tool_result_content([]) == ""


async def test_text_results_keep_the_existing_last_text_block_semantics():
    content = await _tool_result_content(
        [
            {"image": {"format": "png", "source": {"bytes": b"ignored"}}},
            {"text": '"first"'},
            {"text": '"second"'},
        ]
    )
    assert json.loads(content) == "second"


async def test_a_json_result_reaches_the_wire_compact_and_unicode_preserving():
    """A JSON result block is re-serialized through ``dumps_wire``, so the
    padded separators and ASCII escapes of the Python defaults are gone."""
    content = await _tool_result_content([{"json": PARITY_VALUE}])
    assert content == PARITY_JSON
