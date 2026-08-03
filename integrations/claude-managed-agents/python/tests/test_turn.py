"""Ports of the TypeScript `turn.test.ts` assertions."""

import asyncio
import time
from typing import Any

import pytest
from ag_ui.core import (
    ReasoningEndEvent,
    ReasoningMessageEndEvent,
    ReasoningMessageStartEvent,
    ReasoningStartEvent,
    RunErrorEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
    ToolCallStartEvent,
)

from ag_ui_claude_managed_agents import (
    TOOL_RESULT_MAX_CHARS,
    BackendTool,
    TurnOutcome,
    run_turn,
)
from ag_ui_claude_managed_agents import turn as turn_module

from .fake_client import FakeClient, parked_race_error

IDLE_END_TURN = {
    "type": "session.status_idle",
    "id": "idle_1",
    "stop_reason": {"type": "end_turn"},
}


async def collect(
    stream_events: list[Any],
    client_options: dict[str, Any] | None = None,
    **overrides: Any,
):
    fake = FakeClient(streams=[stream_events], **(client_options or {}))
    emitted: list[Any] = []
    options: dict[str, Any] = {
        "client": fake,
        "session_id": "sesn_1",
        "outbound": [
            {"type": "user.message", "content": [{"type": "text", "text": "hi"}]}
        ],
        "client_tools": {},
        "backend_tools": {},
        "tool_confirmation": None,
        "stream_deltas": True,
        "emit": emitted.append,
    }
    options.update(overrides)
    outcome = await run_turn(**options)
    return emitted, outcome, fake


def types(events: list[Any]) -> list[str]:
    return [event.type.value for event in events]


async def test_streams_text_preview_tops_up_from_buffered_message_and_finishes():
    emitted, outcome, fake = await collect(
        [
            {"type": "session.status_running", "id": "run_1"},
            {"type": "event_start", "event": {"type": "agent.message", "id": "msg_1"}},
            {
                "type": "event_delta",
                "event_id": "msg_1",
                "delta": {
                    "type": "content_delta",
                    "index": 0,
                    "content": {"type": "text", "text": "Hel"},
                },
            },
            {
                "type": "event_delta",
                "event_id": "msg_1",
                "delta": {
                    "type": "content_delta",
                    "index": 0,
                    "content": {"type": "text", "text": "lo"},
                },
            },
            {
                "type": "agent.message",
                "id": "msg_1",
                "content": [{"type": "text", "text": "Hello there"}],
            },
            IDLE_END_TURN,
        ]
    )
    assert outcome == TurnOutcome(status="finished")
    assert fake.sent[0]["events"] == [
        {"type": "user.message", "content": [{"type": "text", "text": "hi"}]}
    ]
    assert emitted == [
        TextMessageStartEvent(message_id="msg_1", role="assistant"),
        TextMessageContentEvent(message_id="msg_1", delta="Hel"),
        TextMessageContentEvent(message_id="msg_1", delta="lo"),
        TextMessageContentEvent(message_id="msg_1", delta=" there"),
        TextMessageEndEvent(message_id="msg_1"),
    ]


async def test_requests_previews_when_streaming_deltas():
    _, _, fake = await collect([IDLE_END_TURN])
    assert fake.stream_calls == [
        ("sesn_1", {"event_deltas": ["agent.message", "agent.thinking"]})
    ]

    _, _, fake = await collect([IDLE_END_TURN], stream_deltas=False)
    assert fake.stream_calls == [("sesn_1", {})]


async def test_emits_whole_message_when_there_was_no_preview():
    emitted, _, _ = await collect(
        [
            {
                "type": "agent.message",
                "id": "msg_1",
                "content": [{"type": "text", "text": "All at once"}],
            },
            IDLE_END_TURN,
        ]
    )
    assert emitted == [
        TextMessageStartEvent(message_id="msg_1", role="assistant"),
        TextMessageContentEvent(message_id="msg_1", delta="All at once"),
        TextMessageEndEvent(message_id="msg_1"),
    ]


async def test_re_emits_corrected_message_when_preview_diverges():
    emitted, _, _ = await collect(
        [
            {"type": "event_start", "event": {"type": "agent.message", "id": "msg_1"}},
            {
                "type": "event_delta",
                "event_id": "msg_1",
                "delta": {
                    "type": "content_delta",
                    "index": 0,
                    "content": {"type": "text", "text": "Draft"},
                },
            },
            {
                "type": "agent.message",
                "id": "msg_1",
                "content": [{"type": "text", "text": "Final"}],
            },
            IDLE_END_TURN,
        ]
    )
    assert emitted == [
        TextMessageStartEvent(message_id="msg_1", role="assistant"),
        TextMessageContentEvent(message_id="msg_1", delta="Draft"),
        TextMessageEndEvent(message_id="msg_1"),
        TextMessageStartEvent(message_id="corrected_msg_1", role="assistant"),
        TextMessageContentEvent(message_id="corrected_msg_1", delta="Final"),
        TextMessageEndEvent(message_id="corrected_msg_1"),
    ]


async def test_maps_thinking_stretch_to_reasoning_start_and_end():
    emitted, _, _ = await collect(
        [
            {
                "type": "event_start",
                "event": {"type": "agent.thinking", "id": "think_1"},
            },
            {"type": "agent.thinking", "id": "think_1"},
            IDLE_END_TURN,
        ]
    )
    assert emitted == [
        ReasoningStartEvent(message_id="think_1"),
        ReasoningMessageStartEvent(message_id="think_1", role="reasoning"),
        ReasoningMessageEndEvent(message_id="think_1"),
        ReasoningEndEvent(message_id="think_1"),
    ]


async def test_maps_unpreviewed_thinking_to_reasoning_pair():
    emitted, _, _ = await collect(
        [{"type": "agent.thinking", "id": "think_1"}, IDLE_END_TURN]
    )
    assert types(emitted) == ["REASONING_START", "REASONING_END"]


async def test_streams_builtin_tool_calls_and_their_results():
    emitted, _, _ = await collect(
        [
            {
                "type": "agent.tool_use",
                "id": "tu_1",
                "name": "bash",
                "input": {"command": "ls"},
            },
            {
                "type": "agent.tool_result",
                "id": "tr_1",
                "tool_use_id": "tu_1",
                "content": [{"type": "text", "text": "file.txt"}],
            },
            IDLE_END_TURN,
        ]
    )
    assert emitted == [
        ToolCallStartEvent(tool_call_id="tu_1", tool_call_name="bash"),
        ToolCallArgsEvent(tool_call_id="tu_1", delta='{"command":"ls"}'),
        ToolCallEndEvent(tool_call_id="tu_1"),
        ToolCallResultEvent(
            message_id="result_tu_1",
            tool_call_id="tu_1",
            content="file.txt",
            role="tool",
        ),
    ]


async def test_maps_mcp_tool_calls_with_server_qualified_name():
    emitted, _, _ = await collect(
        [
            {
                "type": "agent.mcp_tool_use",
                "id": "mcp_1",
                "name": "search",
                "mcp_server_name": "docs",
                "input": {"q": "x"},
            },
            {
                "type": "agent.mcp_tool_result",
                "id": "mr_1",
                "mcp_tool_use_id": "mcp_1",
                "content": [{"type": "text", "text": "found"}],
            },
            IDLE_END_TURN,
        ]
    )
    assert emitted[0] == ToolCallStartEvent(
        tool_call_id="mcp_1", tool_call_name="docs: search"
    )
    assert emitted[3] == ToolCallResultEvent(
        message_id="result_mcp_1", tool_call_id="mcp_1", content="found", role="tool"
    )


async def test_flattens_mixed_tool_result_content():
    emitted, _, _ = await collect(
        [
            {
                "type": "agent.tool_result",
                "id": "tr_1",
                "tool_use_id": "tu_1",
                "content": [
                    {
                        "type": "text",
                        "text": "Caf&eacute; &amp; &#39;more&#39; &lt;b&gt;",
                    },
                    {
                        "type": "search_result",
                        "title": "Docs &amp; guides",
                        "source": "https://example.com",
                        "content": [{"type": "text", "text": "body text"}],
                    },
                    {"type": "image", "source": {}},
                ],
            },
            IDLE_END_TURN,
        ]
    )
    assert emitted == [
        ToolCallResultEvent(
            message_id="result_tu_1",
            tool_call_id="tu_1",
            # The text block is literal tool output and stays verbatim; only
                # the search result, whose body comes from HTML, is decoded.
                content=(
                    "Caf&eacute; &amp; &#39;more&#39; &lt;b&gt;\n"
                    "[search result] Docs & guides — https://example.com\n"
                    "body text\n[image]"
                ),
            role="tool",
        )
    ]


async def test_runs_backend_tool_and_posts_result_back_into_session():
    async def handler(_input: Any) -> str:
        return "noon"

    backend = BackendTool(
        name="get_time", description="", parameters={}, handler=handler
    )
    emitted, _, fake = await collect(
        [
            {
                "type": "agent.custom_tool_use",
                "id": "ctu_1",
                "name": "get_time",
                "input": {},
            },
            {
                "type": "session.status_idle",
                "id": "idle_1",
                "stop_reason": {"type": "requires_action", "event_ids": ["ctu_1"]},
            },
            IDLE_END_TURN,
        ],
        backend_tools={"get_time": backend},
    )
    assert (
        ToolCallResultEvent(
            message_id="result_ctu_1", tool_call_id="ctu_1", content="noon", role="tool"
        )
        in emitted
    )
    assert fake.sent[1]["events"] == [
        {
            "type": "user.custom_tool_result",
            "custom_tool_use_id": "ctu_1",
            "content": [{"type": "text", "text": "noon"}],
            "is_error": False,
        }
    ]


async def test_reports_backend_tool_exception_as_error_result():
    def handler(_input: Any) -> str:
        raise ValueError("clock offline")

    backend = BackendTool(
        name="get_time", description="", parameters={}, handler=handler
    )
    _, _, fake = await collect(
        [
            {
                "type": "agent.custom_tool_use",
                "id": "ctu_1",
                "name": "get_time",
                "input": {},
            },
            IDLE_END_TURN,
        ],
        backend_tools={"get_time": backend},
    )
    assert fake.sent[1]["events"] == [
        {
            "type": "user.custom_tool_result",
            "custom_tool_use_id": "ctu_1",
            "content": [{"type": "text", "text": "clock offline"}],
            "is_error": True,
        }
    ]


async def test_handler_leaked_cancelled_error_is_reported_not_treated_as_teardown():
    """A handler that leaks a CancelledError of its own (e.g. re-raised from
    an inner cancelled task) while the run is healthy must be reported like
    any failure: no spurious interrupt, and the turn still finishes."""

    async def handler(_input: Any) -> str:
        raise asyncio.CancelledError()

    backend = BackendTool(
        name="get_time", description="", parameters={}, handler=handler
    )
    events, outcome, fake = await collect(
        [
            {
                "type": "agent.custom_tool_use",
                "id": "ctu_1",
                "name": "get_time",
                "input": {},
            },
            IDLE_END_TURN,
        ],
        backend_tools={"get_time": backend},
    )

    assert outcome.status == "finished"
    sent = [event for send in fake.sent for event in send["events"]]
    assert {"type": "user.interrupt"} not in sent
    assert {
        "type": "user.custom_tool_result",
        "custom_tool_use_id": "ctu_1",
        "content": [{"type": "text", "text": "CancelledError"}],
        "is_error": True,
    } in sent


async def test_posts_error_result_for_tool_nothing_can_execute():
    _, _, fake = await collect(
        [
            {
                "type": "agent.custom_tool_use",
                "id": "ctu_1",
                "name": "mystery",
                "input": {},
            },
            IDLE_END_TURN,
        ]
    )
    result = fake.sent[1]["events"][0]
    assert result["type"] == "user.custom_tool_result"
    assert result["custom_tool_use_id"] == "ctu_1"
    assert result["is_error"] is True
    assert result["content"] == [
        {"type": "text", "text": 'No handler is registered for tool "mystery".'}
    ]


async def test_parks_turn_when_frontend_must_execute_tool():
    emitted, outcome, fake = await collect(
        [
            {
                "type": "agent.custom_tool_use",
                "id": "ctu_1",
                "name": "confirm_purchase",
                "input": {"amount": 5},
            },
            {
                "type": "session.status_idle",
                "id": "idle_1",
                "stop_reason": {"type": "requires_action", "event_ids": ["ctu_1"]},
            },
        ],
        client_tools={"confirm_purchase": "confirm_purchase"},
    )
    assert outcome == TurnOutcome(status="parked", client_tool_use_ids=["ctu_1"])
    assert len(fake.sent) == 1  # only the user message; no result posted
    assert types(emitted) == ["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END"]


async def test_reports_frontends_original_name_for_normalized_tool():
    emitted, outcome, _ = await collect(
        [
            {
                "type": "agent.custom_tool_use",
                "id": "ctu_1",
                "name": "search_web",
                "input": {},
            },
            {
                "type": "session.status_idle",
                "id": "idle_1",
                "stop_reason": {"type": "requires_action", "event_ids": ["ctu_1"]},
            },
        ],
        client_tools={"search_web": "search web"},
    )
    assert outcome == TurnOutcome(status="parked", client_tool_use_ids=["ctu_1"])
    assert emitted[0] == ToolCallStartEvent(
        tool_call_id="ctu_1", tool_call_name="search web"
    )


async def test_answers_confirmation_gated_tool_when_policy_is_configured():
    _, outcome, fake = await collect(
        [
            {
                "type": "agent.tool_use",
                "id": "tu_1",
                "name": "bash",
                "input": {},
                "evaluated_permission": "ask",
            },
            {
                "type": "session.status_idle",
                "id": "idle_1",
                "stop_reason": {"type": "requires_action", "event_ids": ["tu_1"]},
            },
            {
                "type": "agent.tool_result",
                "id": "tr_1",
                "tool_use_id": "tu_1",
                "content": [],
            },
            IDLE_END_TURN,
        ],
        tool_confirmation="allow",
    )
    assert outcome == TurnOutcome(status="finished")
    assert fake.sent[1]["events"] == [
        {"type": "user.tool_confirmation", "tool_use_id": "tu_1", "result": "allow"}
    ]


async def test_fails_run_on_confirmation_gated_tool_with_no_policy():
    emitted, outcome, fake = await collect(
        [
            {
                "type": "agent.tool_use",
                "id": "tu_1",
                "name": "bash",
                "input": {},
                "evaluated_permission": "ask",
            },
            {
                "type": "session.status_idle",
                "id": "idle_1",
                "stop_reason": {"type": "requires_action", "event_ids": ["tu_1"]},
            },
        ]
    )
    assert outcome.status == "errored"
    assert isinstance(emitted[-1], RunErrorEvent)
    assert emitted[-1].code == "tool_confirmation_required"
    assert fake.sent[1]["events"] == [{"type": "user.interrupt"}]


async def test_interrupts_and_errors_on_an_unknown_blocking_action():
    emitted, outcome, fake = await collect(
        [
            {
                "type": "session.status_idle",
                "id": "idle_1",
                "stop_reason": {"type": "requires_action", "event_ids": ["unknown_1"]},
            }
        ]
    )
    assert outcome.status == "errored"
    assert emitted[-1].code == "unsupported_action"
    assert fake.sent[1]["events"] == [{"type": "user.interrupt"}]


async def test_surfaces_terminal_session_error_with_its_type_as_code():
    emitted, outcome, _ = await collect(
        [
            {
                "type": "session.error",
                "id": "err_1",
                "error": {
                    "type": "billing_error",
                    "message": "Out of credits",
                    "retry_status": {"type": "terminal"},
                },
            }
        ]
    )
    assert outcome.status == "errored"
    assert emitted == [RunErrorEvent(message="Out of credits", code="billing_error")]


async def test_ignores_retrying_session_error_and_completes():
    _, outcome, _ = await collect(
        [
            {
                "type": "session.error",
                "id": "err_1",
                "error": {
                    "type": "model_overloaded_error",
                    "message": "busy",
                    "retry_status": {"type": "retrying"},
                },
            },
            {
                "type": "agent.message",
                "id": "msg_1",
                "content": [{"type": "text", "text": "ok"}],
            },
            IDLE_END_TURN,
        ]
    )
    assert outcome == TurnOutcome(status="finished")


async def test_treats_retries_exhausted_as_error_not_clean_finish():
    emitted, outcome, _ = await collect(
        [
            {
                "type": "session.status_idle",
                "id": "idle_1",
                "stop_reason": {"type": "retries_exhausted"},
            }
        ]
    )
    assert outcome.status == "errored"
    assert emitted[-1].code == "retries_exhausted"


async def test_reports_terminated_session_as_ended():
    _, outcome, _ = await collect(
        [{"type": "session.status_terminated", "id": "term_1"}]
    )
    assert outcome == TurnOutcome(status="errored", session_ended=True)


async def test_reports_deleted_session_as_ended():
    emitted, outcome, _ = await collect([{"type": "session.deleted", "id": "del_1"}])
    assert outcome == TurnOutcome(status="errored", session_ended=True)
    assert emitted[-1].code == "session_ended"


async def test_closes_dangling_preview_when_model_request_ends_without_message():
    emitted, _, _ = await collect(
        [
            {"type": "event_start", "event": {"type": "agent.message", "id": "msg_1"}},
            {
                "type": "event_delta",
                "event_id": "msg_1",
                "delta": {
                    "type": "content_delta",
                    "index": 0,
                    "content": {"type": "text", "text": "partia"},
                },
            },
            {
                "type": "span.model_request_end",
                "id": "span_1",
                "model_request_start_id": "s_1",
                "is_error": True,
                "model_usage": {},
            },
            IDLE_END_TURN,
        ]
    )
    assert types(emitted) == [
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
    ]


async def test_keeps_top_up_when_successful_span_end_arrives_before_buffered_message():
    """A successful model_request_end must not close the preview: the buffered
    agent.message arrives after it and still owes the streamed text its top-up."""
    emitted, _, _ = await collect(
        [
            {"type": "event_start", "event": {"type": "agent.message", "id": "msg_1"}},
            {
                "type": "event_delta",
                "event_id": "msg_1",
                "delta": {
                    "type": "content_delta",
                    "index": 0,
                    "content": {"type": "text", "text": "Hel"},
                },
            },
            {
                "type": "span.model_request_end",
                "id": "span_1",
                "model_request_start_id": "s_1",
                "is_error": False,
                "model_usage": {},
            },
            {
                "type": "agent.message",
                "id": "msg_1",
                "content": [{"type": "text", "text": "Hello there"}],
            },
            IDLE_END_TURN,
        ]
    )
    assert [(event.type.value, getattr(event, "delta", None)) for event in emitted] == [
        ("TEXT_MESSAGE_START", None),
        ("TEXT_MESSAGE_CONTENT", "Hel"),
        ("TEXT_MESSAGE_CONTENT", "lo there"),
        ("TEXT_MESSAGE_END", None),
    ]


async def test_errors_when_stream_ends_before_turn_completes():
    emitted, outcome, _ = await collect(
        [{"type": "event_start", "event": {"type": "agent.message", "id": "msg_1"}}]
    )
    assert outcome.status == "errored"
    # The open message is closed before the error.
    assert types(emitted) == ["TEXT_MESSAGE_START", "TEXT_MESSAGE_END", "RUN_ERROR"]
    assert emitted[-1].code == "stream_ended"


async def test_does_not_emit_empty_content_delta():
    emitted, _, _ = await collect(
        [
            {"type": "event_start", "event": {"type": "agent.message", "id": "msg_1"}},
            {
                "type": "event_delta",
                "event_id": "msg_1",
                "delta": {
                    "type": "content_delta",
                    "index": 0,
                    "content": {"type": "text", "text": ""},
                },
            },
            {
                "type": "agent.message",
                "id": "msg_1",
                "content": [{"type": "text", "text": "Hi"}],
            },
            IDLE_END_TURN,
        ]
    )
    assert emitted == [
        TextMessageStartEvent(message_id="msg_1", role="assistant"),
        TextMessageContentEvent(message_id="msg_1", delta="Hi"),
        TextMessageEndEvent(message_id="msg_1"),
    ]
    assert all(
        event.delta for event in emitted if isinstance(event, TextMessageContentEvent)
    )


async def test_truncates_long_tool_results():
    emitted, _, _ = await collect(
        [
            {
                "type": "agent.tool_result",
                "id": "tr_1",
                "tool_use_id": "tu_1",
                "content": [
                    {"type": "text", "text": "x" * (TOOL_RESULT_MAX_CHARS + 500)}
                ],
            },
            IDLE_END_TURN,
        ]
    )
    assert emitted == [
        ToolCallResultEvent(
            message_id="result_tu_1",
            tool_call_id="tu_1",
            content="x" * TOOL_RESULT_MAX_CHARS,
            role="tool",
        )
    ]


async def test_answers_confirmation_gated_mcp_tool_when_policy_is_configured():
    emitted, outcome, fake = await collect(
        [
            {
                "type": "agent.mcp_tool_use",
                "id": "mcp_1",
                "name": "delete_page",
                "mcp_server_name": "wiki",
                "input": {},
                "evaluated_permission": "ask",
            },
            {
                "type": "session.status_idle",
                "id": "idle_1",
                "stop_reason": {"type": "requires_action", "event_ids": ["mcp_1"]},
            },
            IDLE_END_TURN,
        ],
        tool_confirmation="deny",
    )
    assert outcome == TurnOutcome(status="finished")
    assert emitted[0] == ToolCallStartEvent(
        tool_call_id="mcp_1", tool_call_name="wiki: delete_page"
    )
    assert fake.sent[1]["events"] == [
        {"type": "user.tool_confirmation", "tool_use_id": "mcp_1", "result": "deny"}
    ]


async def test_requires_action_batch_mixes_confirmation_and_client_park():
    emitted, outcome, fake = await collect(
        [
            {
                "type": "agent.tool_use",
                "id": "tu_1",
                "name": "bash",
                "input": {},
                "evaluated_permission": "ask",
            },
            {
                "type": "agent.custom_tool_use",
                "id": "ctu_1",
                "name": "show_chart",
                "input": {},
            },
            {
                "type": "session.status_idle",
                "id": "idle_1",
                "stop_reason": {
                    "type": "requires_action",
                    "event_ids": ["tu_1", "ctu_1"],
                },
            },
        ],
        tool_confirmation="allow",
        client_tools={"show_chart": "show_chart"},
    )
    # The built-in tool is confirmed, then the run parks on the frontend tool.
    assert fake.sent[1]["events"] == [
        {"type": "user.tool_confirmation", "tool_use_id": "tu_1", "result": "allow"}
    ]
    assert outcome == TurnOutcome(status="parked", client_tool_use_ids=["ctu_1"])


async def test_frontend_tool_wins_dispatch_when_backend_shares_normalized_name():
    calls: list[Any] = []
    backend = BackendTool(
        name="search_web",
        description="",
        parameters={},
        handler=lambda tool_input: calls.append(tool_input) or "backend",
    )
    _, outcome, _ = await collect(
        [
            {
                "type": "agent.custom_tool_use",
                "id": "ctu_1",
                "name": "search_web",
                "input": {},
            },
            {
                "type": "session.status_idle",
                "id": "idle_1",
                "stop_reason": {"type": "requires_action", "event_ids": ["ctu_1"]},
            },
        ],
        client_tools={"search_web": "search web"},
        backend_tools={"search_web": backend},
    )
    assert outcome == TurnOutcome(status="parked", client_tool_use_ids=["ctu_1"])
    assert calls == []  # the frontend tool won; the backend handler never ran


async def test_runs_plain_sync_backend_handler():
    def handler(_input: Any) -> str:
        return "sync result"

    backend = BackendTool(
        name="get_time", description="", parameters={}, handler=handler
    )
    _, _, fake = await collect(
        [
            {
                "type": "agent.custom_tool_use",
                "id": "ctu_1",
                "name": "get_time",
                "input": {},
            },
            IDLE_END_TURN,
        ],
        backend_tools={"get_time": backend},
    )
    assert fake.sent[1]["events"] == [
        {
            "type": "user.custom_tool_result",
            "custom_tool_use_id": "ctu_1",
            "content": [{"type": "text", "text": "sync result"}],
            "is_error": False,
        }
    ]


async def test_blocking_sync_backend_handler_does_not_stall_the_event_loop():
    def handler(_input: Any) -> str:
        time.sleep(0.2)  # a blocking call, e.g. a sync HTTP request
        return "done"

    backend = BackendTool(name="slow", description="", parameters={}, handler=handler)
    ticks = 0
    running = True

    async def ticker() -> None:
        nonlocal ticks
        while running:
            ticks += 1
            await asyncio.sleep(0.01)

    ticker_task = asyncio.create_task(ticker())
    try:
        _, outcome, _ = await collect(
            [
                {
                    "type": "agent.custom_tool_use",
                    "id": "ctu_1",
                    "name": "slow",
                    "input": {},
                },
                IDLE_END_TURN,
            ],
            backend_tools={"slow": backend},
        )
    finally:
        running = False
        await ticker_task
    assert outcome == TurnOutcome(status="finished")
    # The loop kept ticking while the handler blocked in its worker thread.
    assert ticks >= 5


async def test_posts_interrupted_result_when_backend_tool_is_cancelled():
    """A backend handler cut off by a timeout or disconnect still answers the
    call, shielded from the cancellation, so the session is never left parked."""
    started = asyncio.Event()
    release = asyncio.Event()  # never set: the handler would run forever

    async def handler(_input: Any) -> str:
        started.set()
        await release.wait()
        return "never"

    backend = BackendTool(name="slow", description="", parameters={}, handler=handler)
    fake = FakeClient(
        streams=[
            [
                {
                    "type": "agent.custom_tool_use",
                    "id": "ctu_1",
                    "name": "slow",
                    "input": {},
                }
            ]
        ]
    )
    task = asyncio.create_task(
        run_turn(
            client=fake,
            session_id="sesn_1",
            outbound=[
                {"type": "user.message", "content": [{"type": "text", "text": "hi"}]}
            ],
            client_tools={},
            backend_tools={"slow": backend},
            tool_confirmation=None,
            stream_deltas=True,
            emit=lambda _event: None,
        )
    )
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert fake.sent[-1]["events"] == [
        {
            "type": "user.custom_tool_result",
            "custom_tool_use_id": "ctu_1",
            "content": [{"type": "text", "text": "Tool execution was interrupted."}],
            "is_error": True,
        }
    ]


async def test_retries_follow_ups_while_session_finishes_unparking(monkeypatch):
    """A user.message posted right after tool results can 400 while the
    session finishes un-parking; the send is retried on that specific error."""
    monkeypatch.setattr(turn_module, "PARKED_RETRY_DELAYS_S", (0.0, 0.0))
    result = {
        "type": "user.custom_tool_result",
        "custom_tool_use_id": "ctu_1",
        "content": [{"type": "text", "text": "done"}],
        "is_error": False,
    }
    message = {"type": "user.message", "content": [{"type": "text", "text": "hi"}]}
    _, outcome, fake = await collect(
        [IDLE_END_TURN],
        # Send 0 is the results batch; sends 1-2 hit the parked race.
        client_options={
            "send_failures": {1: parked_race_error(), 2: parked_race_error()}
        },
        outbound=[result, message],
    )
    assert outcome == TurnOutcome(status="finished")
    assert fake.send_attempts == 4
    assert fake.sent[0]["events"] == [result]
    assert fake.sent[1]["events"] == [message]


async def test_follow_ups_give_up_after_the_last_retry(monkeypatch):
    monkeypatch.setattr(turn_module, "PARKED_RETRY_DELAYS_S", (0.0,))
    fake = FakeClient(
        streams=[[IDLE_END_TURN]],
        send_failures={0: parked_race_error(), 1: parked_race_error()},
    )
    with pytest.raises(Exception, match="waiting on responses"):
        await run_turn(
            client=fake,
            session_id="sesn_1",
            outbound=[
                {"type": "user.message", "content": [{"type": "text", "text": "hi"}]}
            ],
            client_tools={},
            backend_tools={},
            tool_confirmation=None,
            stream_deltas=True,
            emit=lambda _event: None,
        )
    assert fake.send_attempts == 2
    assert fake.streams_opened[0].closed


CUSTOM_TOOL_USE = {
    "type": "agent.custom_tool_use",
    "id": "ctu_1",
    "name": "get_time",
    "input": {},
}


async def test_never_reports_a_tool_result_the_session_did_not_receive() -> None:
    """Regression: the result is delivered before the UI is told about it. A
    TOOL_CALL_RESULT the agent never saw would report a success that did not
    happen, and the session stays parked on the call — so it is interrupted."""
    backend = BackendTool(
        name="get_time", description="", parameters={}, handler=lambda _: "noon"
    )
    emitted, outcome, fake = await collect(
        [CUSTOM_TOOL_USE, IDLE_END_TURN],
        # The outbound user message posts fine; the result post fails.
        {"send_failures": {1: RuntimeError("send failed")}},
        backend_tools={"get_time": backend},
    )

    assert outcome.status == "errored"
    assert [e for e in emitted if isinstance(e, ToolCallResultEvent)] == []
    assert isinstance(emitted[-1], RunErrorEvent)
    assert emitted[-1].code == "tool_result_delivery_failed"
    assert (
        emitted[-1].message
        == "The result of tool call ctu_1 could not be delivered to the session."
    )
    assert {"type": "user.interrupt"} in [
        event for send in fake.sent for event in send["events"]
    ]


async def test_reports_a_delivery_failure_for_a_tool_nothing_can_execute() -> None:
    emitted, outcome, fake = await collect(
        [{**CUSTOM_TOOL_USE, "name": "mystery"}, IDLE_END_TURN],
        {"send_failures": {1: RuntimeError("send failed")}},
    )

    assert outcome.status == "errored"
    assert [e for e in emitted if isinstance(e, ToolCallResultEvent)] == []
    assert emitted[-1].code == "tool_result_delivery_failed"
    assert {"type": "user.interrupt"} in [
        event for send in fake.sent for event in send["events"]
    ]


async def test_emits_the_tool_result_only_after_the_session_accepted_it() -> None:
    backend = BackendTool(
        name="get_time", description="", parameters={}, handler=lambda _: "noon"
    )
    order: list[str] = []
    fake = FakeClient(streams=[[CUSTOM_TOOL_USE, IDLE_END_TURN]])
    original_send = fake.beta.sessions.events.send

    async def tracking_send(session_id: str, *, events: list[Any]) -> Any:
        if any(e.get("type") == "user.custom_tool_result" for e in events):
            order.append("sent")
        return await original_send(session_id, events=events)

    fake.beta.sessions.events.send = tracking_send

    def record(event: Any) -> None:
        if isinstance(event, ToolCallResultEvent):
            order.append("emitted")

    await run_turn(
        client=fake,
        session_id="sesn_1",
        outbound=[{"type": "user.message", "content": [{"type": "text", "text": "hi"}]}],
        client_tools={},
        backend_tools={"get_time": backend},
        tool_confirmation=None,
        stream_deltas=True,
        emit=record,
    )

    assert order == ["sent", "emitted"]


async def test_falls_back_to_a_stock_message_when_a_session_error_carries_none() -> None:
    emitted, _, _ = await collect(
        [
            {
                "type": "session.error",
                "id": "err_1",
                "error": {
                    "type": "unknown_error",
                    "message": "",
                    "retry_status": {"type": "terminal"},
                },
            }
        ]
    )
    assert len(emitted) == 1
    assert isinstance(emitted[0], RunErrorEvent)
    assert emitted[0].message == "The session reported an error."
    assert emitted[0].code == "unknown_error"


async def test_the_best_effort_interrupt_is_bounded(monkeypatch) -> None:
    """Regression: the turn's interrupt was unbounded, so a stalled connection
    held the thread's run gate open for as long as the socket did."""
    monkeypatch.setattr(turn_module, "BEST_EFFORT_SEND_TIMEOUT_S", 0.05)
    stalled = asyncio.Event()
    fake = FakeClient(
        streams=[
            [
                {
                    "type": "session.status_idle",
                    "id": "idle_1",
                    "stop_reason": {
                        "type": "requires_action",
                        "event_ids": ["mystery_1"],
                    },
                }
            ]
        ]
    )
    original_send = fake.beta.sessions.events.send

    async def stalling_send(session_id: str, *, events: list[Any]) -> Any:
        if any(e.get("type") == "user.interrupt" for e in events):
            await stalled.wait()  # never set
        return await original_send(session_id, events=events)

    fake.beta.sessions.events.send = stalling_send

    reported: list[dict[str, Any]] = []
    events: list[Any] = []
    # An outer deadline so a regression fails here instead of hanging the suite.
    async with asyncio.timeout(2.0):
        await run_turn(
            client=fake,
            session_id="sesn_1",
            outbound=[
                {"type": "user.message", "content": [{"type": "text", "text": "hi"}]}
            ],
            client_tools={},
            backend_tools={},
            tool_confirmation=None,
            stream_deltas=True,
            emit=events.append,
            on_error=lambda _e, context: reported.append(context),
        )

    # The turn still reports the real cause, and the stalled interrupt is
    # surfaced through the hook rather than swallowed.
    assert isinstance(events[-1], RunErrorEvent)
    assert events[-1].code == "unsupported_action"
    assert "interrupt" in [context["operation"] for context in reported]


async def test_reports_an_unhandled_stop_reason_instead_of_waiting_it_out() -> None:
    """Ignoring an unknown stop reason left the turn waiting on a session that
    will never resume until the timeout fired."""
    emitted, outcome, fake = await collect(
        [
            {
                "type": "session.status_idle",
                "id": "idle_1",
                "stop_reason": {"type": "awaiting_martian_input"},
            }
        ]
    )

    assert outcome.status == "errored"
    assert isinstance(emitted[-1], RunErrorEvent)
    assert emitted[-1].code == "unknown_stop_reason"
    assert emitted[-1].message == (
        "The session went idle for a reason this integration does not handle: "
        "awaiting_martian_input."
    )
    assert {"type": "user.interrupt"} in [
        event for send in fake.sent for event in send["events"]
    ]


async def test_emits_tool_arguments_as_compact_unescaped_json() -> None:
    """All three ports must agree byte for byte: no \\uXXXX escaping of
    non-ASCII and no HTML escaping of < > &."""
    emitted, _outcome, _fake = await collect(
        [
            {
                "type": "agent.tool_use",
                "id": "tu_1",
                "name": "search",
                "input": {"q": "café <b>&</b> 日本", "n": 1},
            },
            IDLE_END_TURN,
        ]
    )

    args = next(e for e in emitted if isinstance(e, ToolCallArgsEvent))
    assert args.delta == '{"q":"café <b>&</b> 日本","n":1}'


IDLE_UNKNOWN_ACTION = {
    "type": "session.status_idle",
    "id": "idle_1",
    "stop_reason": {"type": "requires_action", "event_ids": ["mystery_1"]},
}


async def test_records_whether_the_interrupt_it_sent_actually_landed() -> None:
    """A landed interrupt cancels whatever the session was waiting on, so the
    caller has to know: any park from this turn is no longer answerable."""
    _emitted, landed, _fake = await collect([IDLE_UNKNOWN_ACTION])
    assert landed == TurnOutcome(status="errored", session_interrupted=True)

    # Send 0 is the user message; send 1 is the interrupt.
    _emitted, failed, _fake = await collect(
        [IDLE_UNKNOWN_ACTION], {"send_failures": {1: RuntimeError("interrupt rejected")}}
    )
    assert failed == TurnOutcome(status="errored", session_interrupted=False)
