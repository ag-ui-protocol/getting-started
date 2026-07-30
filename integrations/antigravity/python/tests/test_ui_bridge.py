"""UI bridge tests -- the park/resolve primitive behind every HITL case."""

import asyncio
import inspect
import json

import pytest
from ag_ui.core import Tool as AGUITool
from google.antigravity import types as ag_types

from ag_ui_antigravity.ui_bridge import UIBridge


def make_tool(name="set_theme"):
    return AGUITool(
        name=name,
        description="Sets the UI theme",
        parameters={
            "type": "object",
            "properties": {"theme": {"type": "string"}},
            "required": ["theme"],
        },
    )


class TestFrontendTools:
    async def test_call_emits_triplet_then_parks(self):
        bridge = UIBridge()
        (tool,) = bridge.build_frontend_tools([make_tool()])

        task = asyncio.create_task(tool(theme="dark"))
        await asyncio.sleep(0.05)

        assert not task.done(), "the tool must park, not return"
        events = bridge.drain()
        assert [e.type for e in events] == [
            "TOOL_CALL_START",
            "TOOL_CALL_ARGS",
            "TOOL_CALL_END",
        ]
        assert events[0].tool_call_name == "set_theme"
        assert '"theme": "dark"' in events[1].delta

        bridge.resolve_tool_call(events[0].tool_call_id, "ok")
        assert await asyncio.wait_for(task, 1) == "ok"

    async def test_schema_passes_through_untouched(self):
        """ToolWithSchema forwards the client's JSON Schema verbatim."""
        bridge = UIBridge()
        (tool,) = bridge.build_frontend_tools([make_tool()])
        assert tool.input_schema["properties"]["theme"]["type"] == "string"

    async def test_tool_without_parameters_gets_valid_empty_schema(self):
        bridge = UIBridge()
        (tool,) = bridge.build_frontend_tools(
            [AGUITool(name="ping", description="", parameters={})]
        )
        assert tool.input_schema == {"type": "object", "properties": {}}

    async def test_concurrent_parked_tools_resolve_independently(self):
        """The SDK dispatches tool calls concurrently (asyncio.gather).

        Dedup is off here: this covers the registry holding several
        simultaneous pending requests, not the once-per-turn policy that
        TestTurnDeduplication owns.
        """
        bridge = UIBridge(deduplicate_tool_calls=False)
        (tool,) = bridge.build_frontend_tools([make_tool()])

        t1 = asyncio.create_task(tool(theme="dark"))
        t2 = asyncio.create_task(tool(theme="light"))
        await asyncio.sleep(0.05)

        events = bridge.drain()
        starts = [e for e in events if e.type == "TOOL_CALL_START"]
        assert len(starts) == 2
        assert starts[0].tool_call_id != starts[1].tool_call_id

        bridge.resolve_tool_call(starts[1].tool_call_id, "second")
        assert await asyncio.wait_for(t2, 1) == "second"
        assert not t1.done()

        bridge.resolve_tool_call(starts[0].tool_call_id, "first")
        assert await asyncio.wait_for(t1, 1) == "first"

    async def test_unknown_tool_call_id_is_ignored(self):
        bridge = UIBridge()
        assert bridge.resolve_tool_call("nope", "x") is False

    async def test_unknown_interrupt_id_is_ignored(self):
        bridge = UIBridge()
        assert bridge.resolve_interrupt("nope", {}, cancelled=False) is False

    async def test_a_second_answer_to_the_same_call_is_ignored(self):
        """AG-UI clients retry; the first answer must win, not raise."""
        bridge = UIBridge()
        (tool,) = bridge.build_frontend_tools([make_tool()])
        task = asyncio.create_task(tool(theme="dark"))
        await asyncio.sleep(0.05)
        call_id = [e for e in bridge.drain() if e.type == "TOOL_CALL_START"][0].tool_call_id

        assert bridge.resolve_tool_call(call_id, "first") is True
        assert bridge.resolve_tool_call(call_id, "second") is False
        assert await asyncio.wait_for(task, 1) == "first"

    async def test_a_cancelled_tool_call_returns_a_message_for_the_model(self):
        bridge = UIBridge()
        (tool,) = bridge.build_frontend_tools([make_tool()])
        task = asyncio.create_task(tool(theme="dark"))
        await asyncio.sleep(0.05)
        call_id = [e for e in bridge.drain() if e.type == "TOOL_CALL_START"][0].tool_call_id

        bridge.resolve_interrupt(call_id, None, cancelled=True)
        assert await asyncio.wait_for(task, 1) == "The user cancelled this tool call."


class TestQuestions:
    def _spec(self):
        return ag_types.AskQuestionInteractionSpec(
            questions=[
                ag_types.AskQuestionEntry(
                    question="Which colour?",
                    options=[
                        ag_types.AskQuestionOption(id="r", text="red"),
                        ag_types.AskQuestionOption(id="b", text="blue"),
                    ],
                )
            ]
        )

    async def test_hook_parks_and_exposes_interrupt(self):
        bridge = UIBridge()
        hook = bridge.build_interaction_hook()

        task = asyncio.create_task(hook.run(None, self._spec()))
        await asyncio.sleep(0.05)
        assert not task.done()

        interrupts = bridge.pending_interrupts()
        assert len(interrupts) == 1
        assert interrupts[0].reason == "ask_question"
        assert interrupts[0].response_schema["type"] == "object"

        bridge.resolve_interrupt(
            interrupts[0].id,
            {"responses": [{"selected_option_ids": ["b"]}]},
            cancelled=False,
        )
        result = await asyncio.wait_for(task, 1)
        assert result.responses[0].selected_option_ids == ["b"]

    async def test_bare_string_payload_is_accepted_as_freeform(self):
        bridge = UIBridge()
        hook = bridge.build_interaction_hook()
        task = asyncio.create_task(hook.run(None, self._spec()))
        await asyncio.sleep(0.05)

        interrupt_id = bridge.pending_interrupts()[0].id
        bridge.resolve_interrupt(interrupt_id, "purple", cancelled=False)
        result = await asyncio.wait_for(task, 1)
        assert result.responses[0].freeform_response == "purple"

    async def test_cancellation_returns_cancelled_result(self):
        bridge = UIBridge()
        hook = bridge.build_interaction_hook()
        task = asyncio.create_task(hook.run(None, self._spec()))
        await asyncio.sleep(0.05)

        interrupt_id = bridge.pending_interrupts()[0].id
        bridge.resolve_interrupt(interrupt_id, None, cancelled=True)
        result = await asyncio.wait_for(task, 1)
        assert result.cancelled is True

    async def test_missing_responses_are_padded_to_question_count(self):
        bridge = UIBridge()
        hook = bridge.build_interaction_hook()
        spec = ag_types.AskQuestionInteractionSpec(
            questions=[
                ag_types.AskQuestionEntry(question="one", options=[]),
                ag_types.AskQuestionEntry(question="two", options=[]),
            ]
        )
        task = asyncio.create_task(hook.run(None, spec))
        await asyncio.sleep(0.05)
        bridge.resolve_interrupt(
            bridge.pending_interrupts()[0].id, {"responses": ["a"]}, cancelled=False
        )
        result = await asyncio.wait_for(task, 1)
        assert len(result.responses) == 2
        assert result.responses[1].skipped is True

    @pytest.mark.parametrize(
        "payload,expected",
        [
            ({"selected_option_ids": ["b"]}, ["b"]),
            ({"responses": {"selected_option_ids": ["b"]}}, ["b"]),
            ([{"selected_option_ids": ["b"]}], ["b"]),
        ],
    )
    async def test_loose_resume_payload_shapes_are_accepted(self, payload, expected):
        """Simple clients should not have to build the full envelope."""
        bridge = UIBridge()
        hook = bridge.build_interaction_hook()
        task = asyncio.create_task(hook.run(None, self._spec()))
        await asyncio.sleep(0.05)
        bridge.resolve_interrupt(
            bridge.pending_interrupts()[0].id, payload, cancelled=False
        )
        result = await asyncio.wait_for(task, 1)
        assert result.responses[0].selected_option_ids == expected

    async def test_an_uninterpretable_payload_becomes_a_skipped_response(self):
        bridge = UIBridge()
        hook = bridge.build_interaction_hook()
        task = asyncio.create_task(hook.run(None, self._spec()))
        await asyncio.sleep(0.05)
        bridge.resolve_interrupt(bridge.pending_interrupts()[0].id, 42, cancelled=False)
        result = await asyncio.wait_for(task, 1)
        assert len(result.responses) == 1
        assert result.responses[0].skipped is True

    async def test_unusable_list_items_are_dropped_then_padded(self):
        bridge = UIBridge()
        hook = bridge.build_interaction_hook()
        task = asyncio.create_task(hook.run(None, self._spec()))
        await asyncio.sleep(0.05)
        bridge.resolve_interrupt(
            bridge.pending_interrupts()[0].id, {"responses": [None]}, cancelled=False
        )
        result = await asyncio.wait_for(task, 1)
        assert len(result.responses) == 1
        assert result.responses[0].skipped is True

    async def test_the_interrupt_message_falls_back_when_there_are_no_questions(self):
        bridge = UIBridge()
        hook = bridge.build_interaction_hook()
        spec = ag_types.AskQuestionInteractionSpec(questions=[])
        task = asyncio.create_task(hook.run(None, spec))
        await asyncio.sleep(0.05)
        interrupt = bridge.pending_interrupts()[0]
        assert interrupt.message == "The agent has a question."
        assert interrupt.response_schema["properties"]["responses"]["minItems"] == 0
        bridge.resolve_interrupt(interrupt.id, {}, cancelled=False)
        await asyncio.wait_for(task, 1)


class TestApproval:
    async def test_parks_and_approves(self):
        bridge = UIBridge()
        hook = bridge.build_tool_approval_hook()
        call = ag_types.ToolCall(name="run_command", args={"cmd": "rm -rf /"})
        # ToolCall.id is None inside the decide hook -- the bridge must mint one.
        assert call.id is None

        task = asyncio.create_task(hook.run(None, call))
        await asyncio.sleep(0.05)

        interrupts = bridge.pending_interrupts()
        assert len(interrupts) == 1
        assert interrupts[0].reason == "tool_approval"
        assert interrupts[0].metadata["tool_name"] == "run_command"

        bridge.resolve_interrupt(interrupts[0].id, {"approved": True}, cancelled=False)
        result = await asyncio.wait_for(task, 1)
        assert result.allow is True

    async def test_denial_carries_a_message_to_the_model(self):
        bridge = UIBridge()
        hook = bridge.build_tool_approval_hook()
        task = asyncio.create_task(
            hook.run(None, ag_types.ToolCall(name="run_command", args={}))
        )
        await asyncio.sleep(0.05)
        bridge.resolve_interrupt(
            bridge.pending_interrupts()[0].id, {"approved": False}, cancelled=False
        )
        result = await asyncio.wait_for(task, 1)
        assert result.allow is False
        assert result.message

    async def test_frontend_tools_bypass_approval(self):
        """Approving the client's own tool would double-prompt the user."""
        bridge = UIBridge()
        bridge.build_frontend_tools([make_tool("set_theme")])
        hook = bridge.build_tool_approval_hook()
        result = await asyncio.wait_for(
            hook.run(None, ag_types.ToolCall(name="set_theme", args={})), 1
        )
        assert result.allow is True
        assert bridge.pending_interrupts() == []

    async def test_auto_approve_list_bypasses_approval(self):
        bridge = UIBridge()
        hook = bridge.build_tool_approval_hook(auto_approve={"view_file"})
        result = await asyncio.wait_for(
            hook.run(None, ag_types.ToolCall(name="view_file", args={})), 1
        )
        assert result.allow is True

    async def _decide(self, payload, *, cancelled=False):
        bridge = UIBridge()
        hook = bridge.build_tool_approval_hook()
        task = asyncio.create_task(
            hook.run(None, ag_types.ToolCall(name="run_command", args={}))
        )
        await asyncio.sleep(0.05)
        bridge.resolve_interrupt(
            bridge.pending_interrupts()[0].id, payload, cancelled=cancelled
        )
        return await asyncio.wait_for(task, 1)

    @pytest.mark.parametrize(
        "payload,allowed",
        [
            (True, True),
            (False, False),
            ("yes", True),
            ("APPROVED", True),
            ("no", False),
            ({"allow": True}, True),
            ({"approved": True}, True),
            (None, False),
        ],
    )
    async def test_loose_approval_payload_shapes_are_accepted(self, payload, allowed):
        assert (await self._decide(payload)).allow is allowed

    async def test_an_approval_message_is_passed_through_to_the_model(self):
        result = await self._decide({"approved": True, "message": "just this once"})
        assert result.allow is True
        assert result.message == "just this once"

    async def test_cancelling_an_approval_denies_the_call(self):
        result = await self._decide(None, cancelled=True)
        assert result.allow is False
        assert "cancelled" in result.message

    async def test_unserializable_tool_args_are_stringified_in_the_interrupt(self):
        """The interrupt metadata is JSON-encoded onto the wire."""
        bridge = UIBridge()
        hook = bridge.build_tool_approval_hook()
        task = asyncio.create_task(
            hook.run(None, ag_types.ToolCall(name="run_command", args={"h": object()}))
        )
        await asyncio.sleep(0.05)
        interrupt = bridge.pending_interrupts()[0]
        assert isinstance(interrupt.metadata["args"], str)
        bridge.resolve_interrupt(interrupt.id, False, cancelled=False)
        await asyncio.wait_for(task, 1)


class TestTeardown:
    async def test_fail_all_unblocks_parked_callers(self):
        bridge = UIBridge()
        (tool,) = bridge.build_frontend_tools([make_tool()])
        task = asyncio.create_task(tool(theme="dark"))
        await asyncio.sleep(0.05)

        bridge.fail_all(RuntimeError("session closed"))
        with pytest.raises(RuntimeError, match="session closed"):
            await asyncio.wait_for(task, 1)

    async def test_fail_all_leaves_an_already_answered_request_alone(self):
        bridge = UIBridge()
        (tool,) = bridge.build_frontend_tools([make_tool()])
        task = asyncio.create_task(tool(theme="dark"))
        await asyncio.sleep(0.05)
        call_id = [e for e in bridge.drain() if e.type == "TOOL_CALL_START"][0].tool_call_id
        bridge.resolve_tool_call(call_id, "ok")

        bridge.fail_all(RuntimeError("session closed"))
        assert await asyncio.wait_for(task, 1) == "ok"

    async def test_forget_resolved_empties_the_registry_for_answered_requests(self):
        """A turn can park many times; keeping answered entries leaks them."""
        bridge = UIBridge()
        (tool,) = bridge.build_frontend_tools([make_tool()])
        task = asyncio.create_task(tool(theme="dark"))
        await asyncio.sleep(0.05)
        call_id = [e for e in bridge.drain() if e.type == "TOOL_CALL_START"][0].tool_call_id
        bridge.resolve_tool_call(call_id, "ok")
        await asyncio.wait_for(task, 1)

        bridge.forget_resolved()
        assert bridge._pending == {}
        assert bridge._by_tool_call == {}

    async def test_forget_resolved_keeps_a_still_parked_request(self):
        bridge = UIBridge()
        (tool,) = bridge.build_frontend_tools([make_tool()])
        task = asyncio.create_task(tool(theme="dark"))
        await asyncio.sleep(0.05)

        bridge.forget_resolved()
        assert bridge.has_pending is True
        call_id = [e for e in bridge.drain() if e.type == "TOOL_CALL_START"][0].tool_call_id
        bridge.resolve_tool_call(call_id, "ok")
        assert await asyncio.wait_for(task, 1) == "ok"

    async def test_has_pending_tracks_parked_state(self):
        bridge = UIBridge()
        (tool,) = bridge.build_frontend_tools([make_tool()])
        assert bridge.has_pending is False

        task = asyncio.create_task(tool(theme="dark"))
        await asyncio.sleep(0.05)
        assert bridge.has_pending is True

        call_id = [e for e in bridge.drain() if e.type == "TOOL_CALL_START"][0].tool_call_id
        bridge.resolve_tool_call(call_id, "ok")
        await asyncio.wait_for(task, 1)
        assert bridge.has_pending is False


class TestTurnDeduplication:
    """The harness backgrounds a slow custom tool and lets the model continue;
    the model then re-issues the call. Re-dispatching would make the client run
    a side-effecting action twice, so a tool goes to the client once per turn."""

    async def _dispatch(self, bridge, tool, **kwargs):
        task = asyncio.create_task(tool(**kwargs))
        await asyncio.sleep(0.05)
        starts = [e for e in bridge.drain() if e.type == "TOOL_CALL_START"]
        return task, starts

    async def test_identical_repeat_returns_the_cached_result(self):
        bridge = UIBridge()
        (tool,) = bridge.build_frontend_tools([make_tool()])

        task, starts = await self._dispatch(bridge, tool, theme="dark")
        assert len(starts) == 1
        bridge.resolve_tool_call(starts[0].tool_call_id, "applied")
        assert await asyncio.wait_for(task, 1) == "applied"

        # Same call again in the same turn: no new dispatch to the client.
        assert await asyncio.wait_for(tool(theme="dark"), 1) == "applied"
        assert [e for e in bridge.drain() if e.type == "TOOL_CALL_START"] == []

    async def test_repeat_with_different_args_is_not_re_dispatched(self):
        bridge = UIBridge()
        (tool,) = bridge.build_frontend_tools([make_tool()])

        task, starts = await self._dispatch(bridge, tool, theme="dark")
        bridge.resolve_tool_call(starts[0].tool_call_id, "applied")
        await asyncio.wait_for(task, 1)

        result = await asyncio.wait_for(tool(theme="light"), 1)
        assert [e for e in bridge.drain() if e.type == "TOOL_CALL_START"] == []
        # The model is told plainly what happened rather than handed a stale
        # result dressed up as this call's.
        assert "already ran in this turn" in result
        assert "applied" in result

    async def test_a_new_turn_allows_the_tool_again(self):
        bridge = UIBridge()
        (tool,) = bridge.build_frontend_tools([make_tool()])

        task, starts = await self._dispatch(bridge, tool, theme="dark")
        bridge.resolve_tool_call(starts[0].tool_call_id, "applied")
        await asyncio.wait_for(task, 1)

        bridge.reset_turn()
        task2, starts2 = await self._dispatch(bridge, tool, theme="dark")
        assert len(starts2) == 1, "a new turn must dispatch to the client again"
        bridge.resolve_tool_call(starts2[0].tool_call_id, "applied again")
        assert await asyncio.wait_for(task2, 1) == "applied again"

    async def test_dedup_can_be_disabled(self):
        bridge = UIBridge(deduplicate_tool_calls=False)
        (tool,) = bridge.build_frontend_tools([make_tool()])

        task, starts = await self._dispatch(bridge, tool, theme="dark")
        bridge.resolve_tool_call(starts[0].tool_call_id, "applied")
        await asyncio.wait_for(task, 1)

        task2, starts2 = await self._dispatch(bridge, tool, theme="dark")
        assert len(starts2) == 1
        bridge.resolve_tool_call(starts2[0].tool_call_id, "again")
        assert await asyncio.wait_for(task2, 1) == "again"

    async def test_two_different_tools_both_dispatch(self):
        bridge = UIBridge()
        first, second = bridge.build_frontend_tools(
            [make_tool("set_theme"), make_tool("set_font")]
        )
        t1, s1 = await self._dispatch(bridge, first, theme="dark")
        bridge.resolve_tool_call(s1[0].tool_call_id, "ok")
        await asyncio.wait_for(t1, 1)

        t2, s2 = await self._dispatch(bridge, second, theme="serif")
        assert len(s2) == 1, "dedup must be per tool, not global"
        bridge.resolve_tool_call(s2[0].tool_call_id, "ok2")
        assert await asyncio.wait_for(t2, 1) == "ok2"


class TestConcurrentDeduplication:
    """The SDK gathers a tool batch concurrently, so two identical calls can be
    in flight before either has a result. The claim must be staked at dispatch,
    not at completion, or both reach the client and both side effects happen."""

    async def test_identical_concurrent_calls_dispatch_once(self):
        bridge = UIBridge()
        (tool,) = bridge.build_frontend_tools([make_tool("send_email")])

        first = asyncio.create_task(tool(theme="dark"))
        second = asyncio.create_task(tool(theme="dark"))
        await asyncio.sleep(0.05)

        starts = [e for e in bridge.drain() if e.type == "TOOL_CALL_START"]
        assert len(starts) == 1, "a side-effecting tool must reach the client once"

        bridge.resolve_tool_call(starts[0].tool_call_id, "sent")
        assert await asyncio.wait_for(first, 1) == "sent"
        assert await asyncio.wait_for(second, 1) == "sent"

    async def test_concurrent_call_with_other_args_waits_and_is_told(self):
        bridge = UIBridge()
        (tool,) = bridge.build_frontend_tools([make_tool()])

        first = asyncio.create_task(tool(theme="dark"))
        second = asyncio.create_task(tool(theme="light"))
        await asyncio.sleep(0.05)

        starts = [e for e in bridge.drain() if e.type == "TOOL_CALL_START"]
        assert len(starts) == 1
        assert not second.done(), "must wait for the in-flight result, not guess"

        bridge.resolve_tool_call(starts[0].tool_call_id, "applied")
        assert await asyncio.wait_for(first, 1) == "applied"
        assert "already ran in this turn" in await asyncio.wait_for(second, 1)

    async def test_a_failed_first_dispatch_releases_its_waiter(self):
        bridge = UIBridge()
        (tool,) = bridge.build_frontend_tools([make_tool()])

        first = asyncio.create_task(tool(theme="dark"))
        second = asyncio.create_task(tool(theme="dark"))
        await asyncio.sleep(0.05)

        bridge.fail_all(RuntimeError("session closed"))
        with pytest.raises(RuntimeError, match="session closed"):
            await asyncio.wait_for(first, 1)
        with pytest.raises(RuntimeError, match="session closed"):
            await asyncio.wait_for(second, 1)


class TestServerTools:
    """Server-side tools must report their own results.

    Antigravity runs a custom Python tool through the SDK's ToolRunner and the
    harness reports it as a single TOOL_CALL/ACTIVE step -- no DONE step, and no
    result field on Step at all, because the return value goes back over the
    WebSocket straight to the model. So the step stream can never yield a
    TOOL_CALL_RESULT and a client rendering the call would spin forever.
    """

    async def test_call_emits_triplet_then_the_real_result(self):
        bridge = UIBridge()

        async def get_weather(location: str) -> str:
            """Gets the weather.

            Args:
              location: The city.
            """
            return '{"temperature": 22}'

        (wrapped,) = bridge.build_server_tools([get_weather])
        assert await wrapped(location="Tokyo") == '{"temperature": 22}'

        kinds = [e.type for e in bridge.drain()]
        assert [k if isinstance(k, str) else k.value for k in kinds] == [
            "TOOL_CALL_START",
            "TOOL_CALL_ARGS",
            "TOOL_CALL_END",
            "TOOL_CALL_RESULT",
        ]

    async def test_result_carries_the_return_value(self):
        bridge = UIBridge()

        async def get_weather(location: str) -> dict:
            """Gets the weather.

            Args:
              location: The city.
            """
            return {"temperature": 22, "conditions": "sunny"}

        (wrapped,) = bridge.build_server_tools([get_weather])
        await wrapped(location="Tokyo")
        events = bridge.drain()

        args = json.loads(events[1].delta)
        assert args == {"location": "Tokyo"}
        # A dict is serialized; the client parses it back. Without this the
        # weather card falls through to its `?? 0` defaults.
        assert json.loads(events[3].content) == {
            "temperature": 22,
            "conditions": "sunny",
        }
        assert events[0].tool_call_id == events[3].tool_call_id
        assert events[0].tool_call_name == "get_weather"

    async def test_sync_tools_are_supported(self):
        bridge = UIBridge()

        def add(a: int, b: int) -> int:
            """Adds two numbers.

            Args:
              a: First.
              b: Second.
            """
            return a + b

        (wrapped,) = bridge.build_server_tools([add])
        assert await wrapped(a=2, b=3) == 5
        assert json.loads(bridge.drain()[3].content) == 5

    async def test_failure_is_reported_in_content_and_reraised(self):
        bridge = UIBridge()

        async def boom(location: str) -> str:
            """Always fails.

            Args:
              location: The city.
            """
            raise RuntimeError("upstream is down")

        (wrapped,) = bridge.build_server_tools([boom])
        with pytest.raises(RuntimeError, match="upstream is down"):
            await wrapped(location="Tokyo")

        events = bridge.drain()
        # ToolCallResultEvent has no error channel, so it travels in content --
        # an empty result would render as a successful call.
        assert "There was an error executing boom" in events[3].content
        assert "upstream is down" in events[3].content

    def test_signature_is_preserved_for_schema_derivation(self):
        """The SDK derives the tool schema by introspecting the function.

        A wrapper taking bare **kwargs would erase the parameters and the model
        would be handed a tool it cannot call correctly.
        """
        bridge = UIBridge()

        async def get_weather(location: str) -> str:
            """Gets the weather.

            Args:
              location: The city.
            """
            return "{}"

        (wrapped,) = bridge.build_server_tools([get_weather])
        assert wrapped.__name__ == "get_weather"
        assert wrapped.__doc__ == get_weather.__doc__
        assert list(inspect.signature(wrapped).parameters) == ["location"]

    def test_names_are_registered_for_suppression(self):
        """The adapter suppresses step-driven events for these names.

        Without that the call would be emitted twice: once from the ACTIVE step
        and once by the wrapper.
        """
        bridge = UIBridge()

        async def get_weather(location: str) -> str:
            """Gets the weather.

            Args:
              location: The city.
            """
            return "{}"

        bridge.build_server_tools([get_weather])
        assert "get_weather" in bridge.server_tool_names
