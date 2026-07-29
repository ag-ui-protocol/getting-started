"""Tests for ClaudeAgentAdapter event translation and option building.

The adapter's job is to translate a Claude Agent SDK message stream into the
AG-UI protocol event sequence. We drive ``_stream_claude_sdk`` directly with a
fake stream of SDK ``StreamEvent`` / message objects, so no LLM call is made.

We also test ``run()`` error handling by injecting a fake SessionWorker, and
``build_options`` merging behavior.
"""

import json

import pytest

from ag_ui.core import EventType
from ag_ui_claude_sdk.adapter import ClaudeAgentAdapter
from ag_ui_claude_sdk.config import STATE_MANAGEMENT_TOOL_FULL_NAME, AG_UI_MCP_SERVER_NAME

from ag_ui_claude_sdk.utils import extract_tool_names

from claude_agent_sdk import AssistantMessage, ToolUseBlock

from .conftest import stream_event, aiter


def _types(events):
    return [e.type for e in events]


async def _drive(adapter, stream_items, make_input, **input_kwargs):
    """Run _stream_claude_sdk over a fake message stream and collect events."""
    inp = make_input(**input_kwargs)
    frontend = set(extract_tool_names(inp.tools)) if inp.tools else set()
    # Seed per-thread state as run() would.
    adapter._per_thread_state[inp.thread_id] = inp.state
    events = []
    async for ev in adapter._stream_claude_sdk(
        aiter(stream_items), inp.thread_id, inp.run_id, inp, frontend
    ):
        events.append(ev)
    return events


class TestStreamTextMessage:
    @pytest.mark.asyncio
    async def test_streamed_text_produces_start_content_end(self, make_input):
        adapter = ClaudeAgentAdapter(name="t")
        stream = [
            stream_event({"type": "message_start"}),
            stream_event(
                {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hello "}}
            ),
            stream_event(
                {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "world"}}
            ),
            stream_event({"type": "message_stop"}),
        ]
        events = await _drive(adapter, stream, make_input)
        types = _types(events)
        assert EventType.TEXT_MESSAGE_START in types
        assert EventType.TEXT_MESSAGE_END in types
        contents = [e for e in events if e.type == EventType.TEXT_MESSAGE_CONTENT]
        assert "".join(c.delta for c in contents) == "Hello world"
        # START precedes content precedes END
        assert types.index(EventType.TEXT_MESSAGE_START) < types.index(EventType.TEXT_MESSAGE_END)

    @pytest.mark.asyncio
    async def test_messages_snapshot_emitted_at_end(self, make_input):
        adapter = ClaudeAgentAdapter(name="t")
        stream = [
            stream_event({"type": "message_start"}),
            stream_event(
                {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hi"}}
            ),
            stream_event({"type": "message_stop"}),
        ]
        events = await _drive(adapter, stream, make_input)
        snapshots = [e for e in events if e.type == EventType.MESSAGES_SNAPSHOT]
        assert len(snapshots) == 1
        assert any(getattr(m, "content", None) == "Hi" for m in snapshots[0].messages)


class TestResultMessageErrorHandling:
    """Regression tests for ag-ui-protocol/ag-ui#2145.

    An errored turn used to fold its failure text into MESSAGES_SNAPSHOT
    twice (once via the streamed text, once via the non-streaming
    AssistantMessage fallback minting a fresh, never-streamed id) with no
    RUN_ERROR signal at all.
    """

    @pytest.mark.asyncio
    async def test_errored_turn_emits_one_assistant_message(self, make_input):
        from claude_agent_sdk import AssistantMessage, ResultMessage
        from claude_agent_sdk.types import TextBlock

        adapter = ClaudeAgentAdapter(name="t")
        error_text = "API Error: 400 You have reached your specified API usage limits."
        stream = [
            # Streamed text: gets a real message id, upserted at message_stop.
            stream_event({"type": "message_start"}),
            stream_event(
                {"type": "content_block_delta", "delta": {"type": "text_delta", "text": error_text}}
            ),
            stream_event({"type": "message_stop"}),
            # SDK redelivers the same content as a complete AssistantMessage
            # AFTER message_stop reset current_message_id to None — this used
            # to mint a second, never-streamed id for identical text.
            AssistantMessage(content=[TextBlock(text=error_text)], model="claude-x"),
            ResultMessage(
                subtype="error_during_execution",
                duration_ms=1,
                duration_api_ms=1,
                is_error=True,
                num_turns=1,
                session_id="thread-1",
                result=error_text,
            ),
        ]
        events = await _drive(adapter, stream, make_input)

        snapshots = [e for e in events if e.type == EventType.MESSAGES_SNAPSHOT]
        assert len(snapshots) == 1
        assistant_msgs = [
            m for m in snapshots[0].messages if getattr(m, "role", None) == "assistant"
        ]
        assert len(assistant_msgs) == 1, (
            f"expected exactly 1 assistant message on an errored turn, got "
            f"{len(assistant_msgs)}"
        )

        # Terminal events are owned by run(): the stream itself must NOT emit
        # RUN_ERROR (run() emits it in place of RUN_FINISHED).
        assert not any(e.type == EventType.RUN_ERROR for e in events)
        # The failure text is threaded to run() via the per-run result slot
        # (_drive never pops it, unlike run()'s finally).
        stored = adapter._per_run_result[("thread-1", "run-1")]
        assert stored["is_error"] is True
        assert stored["result"] == error_text

    @pytest.mark.asyncio
    async def test_successful_turn_unaffected(self, make_input):
        """The is_error gating must not touch normal, non-errored turns."""
        from claude_agent_sdk import ResultMessage

        adapter = ClaudeAgentAdapter(name="t")
        stream = [
            stream_event({"type": "message_start"}),
            stream_event(
                {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hi there"}}
            ),
            stream_event({"type": "message_stop"}),
            ResultMessage(
                subtype="success",
                duration_ms=1,
                duration_api_ms=1,
                is_error=False,
                num_turns=1,
                session_id="thread-1",
                result="Hi there",
            ),
        ]
        events = await _drive(adapter, stream, make_input)

        snapshots = [e for e in events if e.type == EventType.MESSAGES_SNAPSHOT]
        assert len(snapshots) == 1
        assistant_msgs = [
            m for m in snapshots[0].messages if getattr(m, "role", None) == "assistant"
        ]
        assert len(assistant_msgs) == 1
        assert assistant_msgs[0].content == "Hi there"
        assert not any(e.type == EventType.RUN_ERROR for e in events)
        # The failure-text slot is error-only: a success turn must not grow a
        # "result" key, or it would leak into RunFinishedEvent.result.
        assert "result" not in adapter._per_run_result[("thread-1", "run-1")]

    @pytest.mark.asyncio
    async def test_run_replaces_run_finished_with_run_error_on_api_error(
        self, make_input, monkeypatch
    ):
        """Terminal events are owned by run(): an errored turn must end in
        exactly one RUN_ERROR *in place of* RUN_FINISHED (verifyEvents rejects
        anything after RUN_ERROR), mirroring TestRunErrorPath."""
        from claude_agent_sdk import AssistantMessage, ResultMessage
        from claude_agent_sdk.types import TextBlock

        error_text = "API Error: 400 You have reached your specified API usage limits."
        result_msg = ResultMessage(
            subtype="error_during_execution",
            duration_ms=1,
            duration_api_ms=1,
            is_error=True,
            num_turns=1,
            session_id="thread-1",
            result=error_text,
        )
        # Newer SDKs add api_error_status to ResultMessage; the installed
        # version predates it, so attach dynamically (plain dataclass, no
        # slots) to exercise the best-effort code threading.
        result_msg.api_error_status = 400

        stream = [
            stream_event({"type": "message_start"}),
            stream_event(
                {"type": "content_block_delta", "delta": {"type": "text_delta", "text": error_text}}
            ),
            stream_event({"type": "message_stop"}),
            AssistantMessage(content=[TextBlock(text=error_text)], model="claude-x"),
            result_msg,
        ]

        class _FakeStreamingWorker:
            """SessionWorker stand-in that streams the canned errored turn."""

            def __init__(self, *args, **kwargs):
                pass

            async def start(self):
                pass

            def is_alive(self):
                return True

            def query(self, prompt, session_id="default"):
                async def _gen():
                    for m in stream:
                        yield m

                return _gen()

            async def stop(self):
                pass

        adapter = ClaudeAgentAdapter(name="t")
        monkeypatch.setattr("ag_ui_claude_sdk.adapter.SessionWorker", _FakeStreamingWorker)
        inp = make_input(messages=[{"id": "1", "role": "user", "content": "hi"}])
        events = [e async for e in adapter.run(inp)]
        types = _types(events)

        assert EventType.RUN_STARTED in types
        assert types.count(EventType.RUN_ERROR) == 1
        assert EventType.RUN_FINISHED not in types
        assert types[-1] == EventType.RUN_ERROR  # nothing may follow RUN_ERROR
        err = events[-1]
        assert err.message == error_text
        assert err.code == "400"

        snapshots = [e for e in events if e.type == EventType.MESSAGES_SNAPSHOT]
        assert len(snapshots) == 1
        assistant_msgs = [
            m for m in snapshots[0].messages if getattr(m, "role", None) == "assistant"
        ]
        assert len(assistant_msgs) == 1

        # The stream completed cleanly (unlike the exception paths), so the
        # healthy worker/session must NOT be evicted.
        assert "thread-1" in adapter._workers


class TestStreamToolCall:
    @pytest.mark.asyncio
    async def test_backend_tool_call_sequence(self, make_input):
        adapter = ClaudeAgentAdapter(name="t")
        stream = [
            stream_event({"type": "message_start"}),
            stream_event(
                {
                    "type": "content_block_start",
                    "content_block": {"type": "tool_use", "id": "tc1", "name": "mcp__srv__lookup"},
                }
            ),
            stream_event(
                {
                    "type": "content_block_delta",
                    "delta": {"type": "input_json_delta", "partial_json": '{"q":"x"}'},
                }
            ),
            stream_event({"type": "content_block_stop"}),
            stream_event({"type": "message_stop"}),
        ]
        events = await _drive(adapter, stream, make_input)
        types = _types(events)
        assert EventType.TOOL_CALL_START in types
        assert EventType.TOOL_CALL_ARGS in types
        assert EventType.TOOL_CALL_END in types
        start = next(e for e in events if e.type == EventType.TOOL_CALL_START)
        assert start.tool_call_name == "lookup"  # prefix stripped
        # exactly one END for the one tool call
        assert types.count(EventType.TOOL_CALL_END) == 1

    @pytest.mark.asyncio
    async def test_subagent_tool_call_gets_parent_message_id(self, make_input):
        # A complete AssistantMessage, not a StreamEvent, is how a subagent's
        # own turn arrives — this hits the fallback branch (#2118).
        adapter = ClaudeAgentAdapter(name="t")
        subagent_message = AssistantMessage(
            content=[ToolUseBlock(id="tc-subagent-1", name="mcp__ui__render_ui", input={})],
            model="claude-haiku-4-5",
            parent_tool_use_id="tc-agent-call",
        )
        events = await _drive(adapter, [subagent_message], make_input)
        types = _types(events)
        assert EventType.TOOL_CALL_START in types
        start = next(e for e in events if e.type == EventType.TOOL_CALL_START)
        assert start.tool_call_name == "render_ui"  # prefix stripped
        assert start.parent_message_id is not None
        assert start.parent_message_id != "tc-agent-call"  # not the SDK's parent_tool_use_id

        # The id must also be the one reported in the run's MESSAGES_SNAPSHOT,
        # i.e. it's a real, stable message id, not an arbitrary placeholder.
        snapshot = next(e for e in events if e.type == EventType.MESSAGES_SNAPSHOT)
        assert any(getattr(m, "id", None) == start.parent_message_id for m in snapshot.messages)

    @pytest.mark.asyncio
    async def test_frontend_tool_halts_stream(self, make_input):
        adapter = ClaudeAgentAdapter(name="t")
        # Register a frontend tool named "confirm"
        tools = [{"name": "confirm", "description": "", "parameters": {}}]
        stream = [
            stream_event({"type": "message_start"}),
            stream_event(
                {
                    "type": "content_block_start",
                    "content_block": {"type": "tool_use", "id": "tc1", "name": "mcp__ag_ui__confirm"},
                }
            ),
            stream_event(
                {
                    "type": "content_block_delta",
                    "delta": {"type": "input_json_delta", "partial_json": "{}"},
                }
            ),
            stream_event({"type": "content_block_stop"}),
            # This message_stop must NOT be processed -- stream halts on the frontend tool
            stream_event(
                {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "AFTER"}}
            ),
        ]
        events = await _drive(adapter, stream, make_input, tools=tools)
        # The post-halt text must not appear.
        contents = [e for e in events if e.type == EventType.TEXT_MESSAGE_CONTENT]
        assert all(c.delta != "AFTER" for c in contents)
        assert EventType.TOOL_CALL_END in _types(events)


class TestStreamStateMerge:
    # ── Item 1: state merge when prior thread state is None ──
    @pytest.mark.asyncio
    async def test_state_update_with_none_prior_merges_onto_empty(self, make_input):
        # When no prior state exists (None) and the update is a dict, the result
        # must be the dict itself (merge onto empty), and a STATE_SNAPSHOT must
        # be emitted — NOT silently treated as a non-dict replace that skips the
        # change check.
        adapter = ClaudeAgentAdapter(name="t")
        stream = [
            stream_event({"type": "message_start"}),
            stream_event(
                {
                    "type": "content_block_start",
                    "content_block": {
                        "type": "tool_use",
                        "id": "tc1",
                        "name": STATE_MANAGEMENT_TOOL_FULL_NAME,
                    },
                }
            ),
            stream_event(
                {
                    "type": "content_block_delta",
                    "delta": {
                        "type": "input_json_delta",
                        "partial_json": '{"state_updates": {"count": 5}}',
                    },
                }
            ),
            stream_event({"type": "content_block_stop"}),
            stream_event({"type": "message_stop"}),
        ]
        # state=None seeds _per_thread_state[thread] = None
        events = await _drive(adapter, stream, make_input, state=None)
        snaps = [e for e in events if e.type == EventType.STATE_SNAPSHOT]
        assert len(snaps) == 1
        assert snaps[0].snapshot == {"count": 5}
        assert adapter._per_thread_state["thread-1"] == {"count": 5}


class TestStreamReasoning:
    @pytest.mark.asyncio
    async def test_thinking_block_emits_reasoning_events(self, make_input):
        adapter = ClaudeAgentAdapter(name="t")
        stream = [
            stream_event({"type": "message_start"}),
            stream_event(
                {"type": "content_block_start", "content_block": {"type": "thinking"}}
            ),
            stream_event(
                {"type": "content_block_delta", "delta": {"type": "thinking_delta", "thinking": "hmm"}}
            ),
            stream_event(
                {"type": "content_block_delta", "delta": {"type": "signature_delta", "signature": "sig"}}
            ),
            stream_event({"type": "content_block_stop"}),
            stream_event({"type": "message_stop"}),
        ]
        events = await _drive(adapter, stream, make_input)
        types = _types(events)
        assert EventType.REASONING_START in types
        assert EventType.REASONING_MESSAGE_START in types
        assert EventType.REASONING_MESSAGE_CONTENT in types
        assert EventType.REASONING_END in types
        # signature was accumulated -> encrypted value emitted
        assert EventType.REASONING_ENCRYPTED_VALUE in types
        enc = next(e for e in events if e.type == EventType.REASONING_ENCRYPTED_VALUE)
        assert enc.encrypted_value == "sig"
        # The encrypted value must be tied to the reasoning block it belongs to,
        # not to the enclosing assistant message id.
        rstart = next(e for e in events if e.type == EventType.REASONING_START)
        assert enc.entity_id == rstart.message_id

    # ── Item 2: signature must not clobber across multiple thinking blocks ──
    @pytest.mark.asyncio
    async def test_two_thinking_blocks_each_emit_their_own_signature(self, make_input):
        # Two thinking blocks in ONE message, each with its own signature. Each
        # block's encrypted value must carry that block's signature, tied to
        # that block's reasoning id. The old code reset accumulated_signature on
        # the first block's stop but emitted with the message id, so a later
        # block's signature attached to the wrong entity / got dropped.
        adapter = ClaudeAgentAdapter(name="t")
        stream = [
            stream_event({"type": "message_start"}),
            # Block 1
            stream_event({"type": "content_block_start", "content_block": {"type": "thinking"}}),
            stream_event(
                {"type": "content_block_delta", "delta": {"type": "thinking_delta", "thinking": "one"}}
            ),
            stream_event(
                {"type": "content_block_delta", "delta": {"type": "signature_delta", "signature": "SIG1"}}
            ),
            stream_event({"type": "content_block_stop"}),
            # Block 2
            stream_event({"type": "content_block_start", "content_block": {"type": "thinking"}}),
            stream_event(
                {"type": "content_block_delta", "delta": {"type": "thinking_delta", "thinking": "two"}}
            ),
            stream_event(
                {"type": "content_block_delta", "delta": {"type": "signature_delta", "signature": "SIG2"}}
            ),
            stream_event({"type": "content_block_stop"}),
            stream_event({"type": "message_stop"}),
        ]
        events = await _drive(adapter, stream, make_input)
        encs = [e for e in events if e.type == EventType.REASONING_ENCRYPTED_VALUE]
        rstarts = [e for e in events if e.type == EventType.REASONING_START]
        assert len(rstarts) == 2
        # Exactly two signatures, one per block, no clobber.
        assert len(encs) == 2
        sigs = {e.encrypted_value for e in encs}
        assert sigs == {"SIG1", "SIG2"}
        # Each encrypted value is tied to a distinct reasoning block entity.
        entity_ids = {e.entity_id for e in encs}
        assert entity_ids == {r.message_id for r in rstarts}
        # And the pairing is correct: SIG1 -> block 1, SIG2 -> block 2.
        by_entity = {e.entity_id: e.encrypted_value for e in encs}
        assert by_entity[rstarts[0].message_id] == "SIG1"
        assert by_entity[rstarts[1].message_id] == "SIG2"


class TestStreamCleanup:
    @pytest.mark.asyncio
    async def test_hanging_tool_call_closed_on_stream_end(self, make_input):
        adapter = ClaudeAgentAdapter(name="t")
        # tool_use opened but stream ends without content_block_stop
        stream = [
            stream_event({"type": "message_start"}),
            stream_event(
                {
                    "type": "content_block_start",
                    "content_block": {"type": "tool_use", "id": "tc1", "name": "lookup"},
                }
            ),
        ]
        events = await _drive(adapter, stream, make_input)
        # Cleanup must close the hanging tool call.
        assert EventType.TOOL_CALL_END in _types(events)


class TestBuildOptions:
    def test_dict_options_merged(self):
        adapter = ClaudeAgentAdapter(name="t", options={"model": "claude-x"})
        opts = adapter.build_options()
        assert opts.model == "claude-x"
        # include_partial_messages default applied
        assert opts.include_partial_messages is True

    def test_api_key_stripped(self):
        # api_key must be popped from the merged kwargs before constructing
        # ClaudeAgentOptions (it is handled via env var, and the options
        # dataclass has no such field). Build must succeed (proving the pop
        # happened — otherwise ClaudeAgentOptions(**kwargs) would raise on the
        # unexpected api_key kwarg) and the secret must be absent from vars(opts).
        adapter = ClaudeAgentAdapter(name="t", options={"api_key": "secret", "model": "m"})
        opts = adapter.build_options()
        opts_vars = vars(opts)
        assert "api_key" not in opts_vars
        assert "secret" not in opts_vars.values()
        # The non-secret kwargs still flow through.
        assert opts.model == "m"

    def test_state_adds_state_management_tool(self, make_input):
        adapter = ClaudeAgentAdapter(name="t")
        inp = make_input(state={"count": 1})
        opts = adapter.build_options(inp)
        assert STATE_MANAGEMENT_TOOL_FULL_NAME in (opts.allowed_tools or [])
        assert AG_UI_MCP_SERVER_NAME in (opts.mcp_servers or {})

    def test_state_addendum_appended_to_system_prompt(self, make_input):
        adapter = ClaudeAgentAdapter(name="t", options={"system_prompt": "BASE"})
        inp = make_input(state={"count": 1})
        opts = adapter.build_options(inp)
        assert opts.system_prompt.startswith("BASE")
        assert "Current Shared State" in opts.system_prompt

    # ── Item 6: forwarded prop that isn't a valid ClaudeAgentOptions kwarg ──
    def test_forwarded_prop_invalid_kwarg_does_not_crash(self, make_input):
        # `temperature` is whitelisted in ALLOWED_FORWARDED_PROPS but is NOT a
        # valid ClaudeAgentOptions field. Applying it must not raise a TypeError
        # from ClaudeAgentOptions(**kwargs); the invalid kwarg is dropped and a
        # valid one alongside it still flows through.
        adapter = ClaudeAgentAdapter(name="t")
        inp = make_input(forwarded_props={"temperature": 0.5, "model": "claude-x"})
        opts = adapter.build_options(inp)  # must not raise
        assert opts.model == "claude-x"
        assert not hasattr(opts, "temperature")

    def test_forwarded_prop_valid_kwarg_still_applied(self, make_input):
        adapter = ClaudeAgentAdapter(name="t")
        inp = make_input(forwarded_props={"max_turns": 3})
        opts = adapter.build_options(inp)
        assert opts.max_turns == 3


class _FakeFailingWorker:
    """A SessionWorker stand-in whose query raises immediately."""

    def __init__(self, *args, **kwargs):
        pass

    async def start(self):
        pass

    def query(self, prompt, session_id="default"):
        async def _gen():
            raise RuntimeError("boom")
            yield  # pragma: no cover

        return _gen()

    async def stop(self):
        pass


class TestRunErrorPath:
    @pytest.mark.asyncio
    async def test_run_emits_run_error_on_worker_failure(self, make_input, monkeypatch):
        adapter = ClaudeAgentAdapter(name="t")
        monkeypatch.setattr("ag_ui_claude_sdk.adapter.SessionWorker", _FakeFailingWorker)

        inp = make_input(messages=[{"id": "1", "role": "user", "content": "hi"}])
        events = [e async for e in adapter.run(inp)]
        types = _types(events)
        # RUN_STARTED then RUN_ERROR (not RUN_FINISHED)
        assert EventType.RUN_STARTED in types
        assert EventType.RUN_ERROR in types
        assert EventType.RUN_FINISHED not in types
        err = next(e for e in events if e.type == EventType.RUN_ERROR)
        assert "boom" in err.message

    @pytest.mark.asyncio
    async def test_error_path_cleans_all_three_dicts(self, make_input, monkeypatch):
        # The run() error path must evict the worker AND drop per-thread state
        # and per-run results, not just the worker + lock. Otherwise an errored
        # thread leaks _per_thread_state / _per_run_result forever.
        adapter = ClaudeAgentAdapter(name="t")
        monkeypatch.setattr("ag_ui_claude_sdk.adapter.SessionWorker", _FakeFailingWorker)

        inp = make_input(
            thread_id="leaky",
            state={"x": 1},
            messages=[{"id": "1", "role": "user", "content": "hi"}],
        )
        _ = [e async for e in adapter.run(inp)]
        assert "leaky" not in adapter._workers
        assert "leaky" not in adapter._state_locks
        assert "leaky" not in adapter._per_thread_state
        # No per-run result entry for the errored thread survives.
        assert not any(k[0] == "leaky" for k in adapter._per_run_result)


class _FakeAliveWorker:
    """A SessionWorker stand-in that stays alive and is never queried."""

    def __init__(self, *args, **kwargs):
        pass

    async def start(self):
        pass

    def is_alive(self):
        return True

    async def stop(self):
        pass


class _FakeDeadWorker:
    """A SessionWorker stand-in whose background task has died."""

    def __init__(self, *args, **kwargs):
        self.stopped = False

    async def start(self):
        pass

    def is_alive(self):
        return False

    def query(self, prompt, session_id="default"):
        async def _gen():
            # A dead worker can never serve a query; if reuse isn't guarded the
            # real worker would hang here forever. Make the test fail loudly.
            raise AssertionError("dead worker was reused for a query")
            yield  # pragma: no cover

        return _gen()

    async def stop(self):
        self.stopped = True


class TestEviction:
    @pytest.mark.asyncio
    async def test_lru_eviction_cleans_all_three_dicts(self):
        # LRU eviction must pop _per_thread_state and per-run results, not
        # just _workers + _state_locks. Cap at 1 worker, insert 2 idle entries.
        # Async so _evict_workers' asyncio.create_task has a running loop.
        import asyncio
        from datetime import datetime, timedelta

        adapter = ClaudeAgentAdapter(name="t", max_workers=1)
        for i, tid in enumerate(["old", "new"]):
            adapter._workers[tid] = {
                "worker": _FakeAliveWorker(),
                "last_used": datetime.now() + timedelta(seconds=i),
                "active": False,
            }
            adapter._state_locks[tid] = asyncio.Lock()
            adapter._per_thread_state[tid] = {"v": i}
            adapter._per_run_result[(tid, "r")] = {"r": i}

        adapter._evict_workers()

        # "old" (lowest last_used) is evicted; all per-thread state cleaned for it.
        assert "old" not in adapter._workers
        assert "old" not in adapter._state_locks
        assert "old" not in adapter._per_thread_state
        assert not any(k[0] == "old" for k in adapter._per_run_result)
        # "new" survives.
        assert "new" in adapter._workers
        assert any(k[0] == "new" for k in adapter._per_run_result)

    @pytest.mark.asyncio
    async def test_clear_session_cleans_all_three_dicts(self):
        import asyncio

        adapter = ClaudeAgentAdapter(name="t")
        adapter._workers["s"] = {"worker": _FakeAliveWorker(), "last_used": None, "active": False}
        adapter._state_locks["s"] = asyncio.Lock()
        adapter._per_thread_state["s"] = {"v": 1}
        adapter._per_run_result[("s", "r")] = {"r": 1}

        await adapter.clear_session("s")

        assert "s" not in adapter._workers
        assert "s" not in adapter._state_locks
        assert "s" not in adapter._per_thread_state
        assert not any(k[0] == "s" for k in adapter._per_run_result)


class _FakeSlowStopWorker:
    """A worker whose stop() yields control, so the eviction task is pending
    when _evict_workers returns — exercising the fire-and-forget GC hazard."""

    def __init__(self, *args, **kwargs):
        self.stopped = False

    async def start(self):
        pass

    def is_alive(self):
        return True

    async def stop(self):
        # Yield so the task is not synchronously complete.
        import asyncio
        await asyncio.sleep(0)
        self.stopped = True


class TestWorkerLifecycle:
    # ── Item 7(b): eviction stop tasks must not be GC-able before completion ──
    @pytest.mark.asyncio
    async def test_eviction_stop_tasks_are_retained_until_complete(self):
        import asyncio
        from datetime import datetime, timedelta

        adapter = ClaudeAgentAdapter(name="t", max_workers=1)
        for i, tid in enumerate(["old", "new"]):
            adapter._workers[tid] = {
                "worker": _FakeSlowStopWorker(),
                "last_used": datetime.now() + timedelta(seconds=i),
                "active": False,
            }

        evicted_worker = adapter._workers["old"]["worker"]
        adapter._evict_workers()

        # A strong reference to the in-flight stop task must be retained by the
        # adapter so the garbage collector cannot reap it mid-flight.
        assert hasattr(adapter, "_pending_tasks")
        assert len(adapter._pending_tasks) >= 1

        # Let the retained task run to completion.
        await asyncio.gather(*list(adapter._pending_tasks))
        assert evicted_worker.stopped is True
        # Completed tasks are dropped from the retention set.
        assert len(adapter._pending_tasks) == 0

    # ── Run-admission serialization (Fix 1): two same-thread runs no longer run
    # concurrently — the run-lock serializes them, so the refcount never exceeds
    # 1. The active_runs refcount machinery is retained purely as
    # DEFENSE-IN-DEPTH: ``active_runs`` is PER-THREAD, and the per-thread run-lock
    # caps it at 1, so ``active_runs > 1`` is unreachable on every path — both
    # same-thread (serialized) AND cross-thread (distinct threads have distinct
    # refcounts, so a single thread's count is never bumped by a peer thread). ──
    @pytest.mark.asyncio
    async def test_same_thread_runs_serialized_refcount_bounded_at_one(self, make_input, monkeypatch):
        import asyncio

        gate = asyncio.Event()
        max_seen = {"n": 0}

        class _GatedWorker:
            def __init__(self, *a, **kw):
                pass

            async def start(self):
                pass

            def is_alive(self):
                return True

            def query(self, prompt, session_id="default"):
                async def _gen():
                    # Block the FIRST admitted run's stream open; while it holds
                    # the run-lock the second run cannot even increment the
                    # refcount (it waits at admission).
                    await gate.wait()
                    return
                    yield  # pragma: no cover

                return _gen()

            async def stop(self):
                pass

        adapter = ClaudeAgentAdapter(name="t")
        monkeypatch.setattr("ag_ui_claude_sdk.adapter.SessionWorker", _GatedWorker)
        inp = make_input(thread_id="shared", messages=[{"id": "1", "role": "user", "content": "hi"}])

        async def drive():
            return [e async for e in adapter.run(inp)]

        t1 = asyncio.create_task(drive())
        t2 = asyncio.create_task(drive())
        # Let scheduling settle; the refcount must NEVER exceed 1 (serialized).
        for _ in range(60):
            await asyncio.sleep(0)
            entry = adapter._workers.get("shared")
            if entry:
                max_seen["n"] = max(max_seen["n"], entry.get("active_runs", 0))
        assert max_seen["n"] == 1, (
            f"same-thread runs were not serialized; refcount reached {max_seen['n']}"
        )

        # Release the gate so the first run finishes and the second proceeds.
        gate.set()
        await asyncio.gather(t1, t2)
        entry = adapter._workers.get("shared")
        assert entry is not None
        # After BOTH ran (serially) the worker is idle and evictable.
        assert entry["active_runs"] == 0
        assert entry["active"] is False

    # ── Run-lock release on the error path (Fix 1): a same-thread run that
    # raises must release the run-lock so the next same-thread run proceeds; the
    # shared worker must not be torn down out from under a still-pending run. ──
    @pytest.mark.asyncio
    async def test_erroring_run_releases_lock_for_next_same_thread_run(
        self, make_input, monkeypatch
    ):
        import asyncio

        stop_calls = {"n": 0}

        class _FailThenOkWorker:
            call_index = 0

            def __init__(self, *a, **kw):
                pass

            async def start(self):
                pass

            def is_alive(self):
                return True

            def query(self, prompt, session_id="default"):
                idx = _FailThenOkWorker.call_index
                _FailThenOkWorker.call_index += 1

                async def _fail():
                    raise RuntimeError("boom")
                    yield  # pragma: no cover

                async def _ok():
                    return
                    yield  # pragma: no cover

                return _fail() if idx == 0 else _ok()

            async def stop(self):
                stop_calls["n"] += 1

        adapter = ClaudeAgentAdapter(name="t")
        monkeypatch.setattr("ag_ui_claude_sdk.adapter.SessionWorker", _FailThenOkWorker)
        inp = make_input(
            thread_id="shared", messages=[{"id": "1", "role": "user", "content": "hi"}]
        )

        async def drive():
            return [e async for e in adapter.run(inp)]

        # A (fails) is admitted first; B waits on the run-lock. Launch overlapping.
        t_a = asyncio.create_task(drive())
        t_b = asyncio.create_task(drive())
        events_a, events_b = await asyncio.wait_for(
            asyncio.gather(t_a, t_b), timeout=5.0
        )

        # A surfaced RUN_ERROR; B then proceeded once the run-lock was released.
        assert EventType.RUN_ERROR in _types(events_a)
        assert EventType.RUN_FINISHED in _types(events_b)

        # A's error path tore down its (solo, at that moment) worker; B re-created
        # a fresh one and finished cleanly. End state: idle/evictable, no leak.
        entry = adapter._workers.get("shared")
        assert entry is not None
        assert entry["active_runs"] == 0
        assert entry["active"] is False

    # ── Single erroring run (the common path) still pops + stops the worker ──
    @pytest.mark.asyncio
    async def test_single_erroring_run_still_evicts_worker(self, make_input, monkeypatch):
        stop_calls = {"n": 0}

        class _SoloFailingWorker:
            def __init__(self, *a, **kw):
                pass

            async def start(self):
                pass

            def is_alive(self):
                return True

            def query(self, prompt, session_id="default"):
                async def _gen():
                    raise RuntimeError("boom")
                    yield  # pragma: no cover

                return _gen()

            async def stop(self):
                stop_calls["n"] += 1

        adapter = ClaudeAgentAdapter(name="t")
        monkeypatch.setattr("ag_ui_claude_sdk.adapter.SessionWorker", _SoloFailingWorker)
        inp = make_input(
            thread_id="solo", messages=[{"id": "1", "role": "user", "content": "hi"}]
        )
        events = [e async for e in adapter.run(inp)]
        assert EventType.RUN_ERROR in _types(events)
        # No peer: the worker is popped and stopped exactly as before.
        assert "solo" not in adapter._workers
        assert stop_calls["n"] == 1
        assert "solo" not in adapter._state_locks
        assert "solo" not in adapter._per_thread_state
        assert not any(k[0] == "solo" for k in adapter._per_run_result)

    @pytest.mark.asyncio
    async def test_active_worker_not_evicted_by_ttl(self):
        from datetime import datetime, timedelta

        adapter = ClaudeAgentAdapter(name="t", worker_ttl_seconds=0.0)
        w = _FakeAliveWorker()
        # active=True simulates a concurrent in-flight run holding the worker.
        adapter._workers["busy"] = {
            "worker": w,
            "last_used": datetime.now() - timedelta(seconds=10),
            "active": True,
        }
        adapter._evict_workers()
        # An active worker must survive TTL eviction even though it is stale.
        assert "busy" in adapter._workers


class TestPoisonedWorkerCache:
    @pytest.mark.asyncio
    async def test_dead_cached_worker_is_evicted_and_replaced(self, make_input, monkeypatch):
        # A cached worker whose task has died must be evicted so the next run
        # creates a fresh worker instead of reusing the dead one (which would
        # hang forever waiting on a queue nothing drains).
        adapter = ClaudeAgentAdapter(name="t")
        dead = _FakeDeadWorker()
        adapter._workers["th"] = {"worker": dead, "last_used": None, "active": False}

        # The fresh worker created on the retry uses a fake that errors on query
        # (so run still completes via RUN_ERROR rather than touching the LLM),
        # but crucially the DEAD worker must NOT be the one queried.
        monkeypatch.setattr("ag_ui_claude_sdk.adapter.SessionWorker", _FakeFailingWorker)

        inp = make_input(thread_id="th", messages=[{"id": "1", "role": "user", "content": "hi"}])
        events = [e async for e in adapter.run(inp)]
        types = _types(events)
        # Dead worker was stopped during eviction.
        assert dead.stopped is True
        # A fresh worker replaced it (RUN_ERROR comes from _FakeFailingWorker,
        # NOT the AssertionError the dead worker would have raised).
        assert EventType.RUN_ERROR in types
        err = next(e for e in events if e.type == EventType.RUN_ERROR)
        assert "boom" in err.message

    @pytest.mark.asyncio
    async def test_dead_cached_worker_with_live_peer_fails_loud(self, make_input):
        # The dead-worker branch is refcount-aware: when a cached worker reports
        # is_alive()==False BUT a concurrent peer still holds it (active_runs > 0),
        # the arriving NEW run must FAIL LOUD. It must neither reuse the dead
        # worker (querying it would hang — the peer's exited run-loop will never
        # service the new run's output queue) nor evict it (that would tear the
        # worker out from under the live peer). Instead it emits a descriptive
        # RunErrorEvent and stops WITHOUT disturbing the peer's entry. (Item 7a)
        stop_calls = {"n": 0}
        query_calls = {"n": 0}

        class _DeadWorkerWithLivePeer:
            """Reports dead. If the new run ever reuses it and calls query(),
            that is the hang-risk bug — flag it loudly so the test catches a
            regression to the reuse behavior."""

            def __init__(self, *args, **kwargs):
                pass

            async def start(self):
                pass

            def is_alive(self):
                return False

            def query(self, prompt, session_id="default"):
                query_calls["n"] += 1

                async def _gen():
                    # A real dead worker would hang here forever; raise instead
                    # so a reuse regression fails fast rather than blocking.
                    raise AssertionError(
                        "dead worker was queried by the arriving run (hang risk)"
                    )
                    yield  # pragma: no cover

                return _gen()

            async def stop(self):
                stop_calls["n"] += 1

        adapter = ClaudeAgentAdapter(name="t")
        worker = _DeadWorkerWithLivePeer()
        # Pre-seed the cache as if a concurrent peer run already holds this
        # (now-dead) worker: active_runs=1 simulates the live peer.
        adapter._workers["shared"] = {
            "worker": worker,
            "last_used": None,
            "active": True,
            "active_runs": 1,
        }

        inp = make_input(
            thread_id="shared", messages=[{"id": "1", "role": "user", "content": "hi"}]
        )
        events = [e async for e in adapter.run(inp)]

        # LOUD FAILURE: the arriving run emits RUN_ERROR (never reuses → never
        # queries the dead worker → no hang).
        assert EventType.RUN_ERROR in _types(events), (
            "arriving run on a dead-worker-with-live-peer must fail loud"
        )
        assert EventType.RUN_FINISHED not in _types(events)
        assert query_calls["n"] == 0, "dead worker must not be queried (hang risk)"

        # PEER UNTOUCHED: the shared entry survives, is not popped, not stopped.
        entry = adapter._workers.get("shared")
        assert entry is not None, "shared worker evicted while a peer run was live"
        assert entry["worker"] is worker
        assert stop_calls["n"] == 0, "shared worker stopped while a peer run was live"
        # REFCOUNT INTACT: the peer's count must be exactly what it was (1). The
        # arriving run must not increment-then-abandon, nor decrement the peer's
        # count via the finally block.
        assert entry["active_runs"] == 1, (
            f"peer refcount corrupted: expected 1, got {entry['active_runs']}"
        )
        assert entry["active"] is True
