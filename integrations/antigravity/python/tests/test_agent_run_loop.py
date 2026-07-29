"""Run-loop tests: the AG-UI lifecycle contract around the Antigravity stream.

These drive ``AntigravityAgent._run_locked`` against a fake Conversation so the
lifecycle rules can be asserted without starting a Go subprocess. The live
end-to-end path is covered by ``test_live_openai.py``.
"""

import asyncio

import pytest
from ag_ui.core import RunAgentInput, Tool as AGUITool
from ag_ui.core import (
    AssistantMessage,
    ResumeEntry,
    ToolCallStartEvent,
    ToolMessage,
    UserMessage,
)
from google.antigravity import types as ag_types

from ag_ui_antigravity.agent import AntigravityAgent
from ag_ui_antigravity.session_manager import AntigravitySession, SessionLimitExceeded
from ag_ui_antigravity.ui_bridge import UIBridge


BLOCK = object()
"""Script marker: the stream goes quiet until ``conversation.gate`` is set."""


class FakeConversation:
    """Replays scripted steps; ``on_send`` can trigger side effects (parking)."""

    def __init__(self, scripts, on_send=None):
        self._scripts = list(scripts)
        self._on_send = on_send
        self.sent = []
        # Released to let a BLOCKed stream carry on delivering its script,
        # which is how a turn that parked eventually finishes.
        self.gate = asyncio.Event()

    async def send(self, prompt):
        self.sent.append(prompt)
        if self._on_send:
            await self._on_send()

    async def receive_steps(self):
        script = self._scripts.pop(0) if self._scripts else []
        for item in script:
            if item is BLOCK:
                # The harness has gone quiet: it is waiting on our coroutine.
                await self.gate.wait()
                continue
            # AntigravityCancelledError derives from BaseException, not
            # Exception, so the check has to be widened to cover it.
            if isinstance(item, BaseException):
                raise item
            await asyncio.sleep(0)
            yield item


class FakeAgent:
    def __init__(self, conversation):
        self.conversation = conversation
        self.conversation_id = "conv-1"


def make_session(conversation, bridge=None, forwarded=()):
    """`forwarded` marks user-message ids a previous run already sent.

    A parked session always has one: the park implies an earlier run that
    forwarded the prompt which started the turn.
    """
    bridge = bridge or UIBridge()
    return AntigravitySession(
        thread_id="t1",
        agent=FakeAgent(conversation),
        bridge=bridge,
        tool_signature="sig",
        forwarded_prompts=set(forwarded),
    )


def text_step(delta, *, index=1, done=False):
    return ag_types.Step(
        id=f"traj:{index}",
        step_index=index,
        type=ag_types.StepType.TEXT_RESPONSE,
        source=ag_types.StepSource.MODEL,
        target=ag_types.StepTarget.USER,
        status=ag_types.StepStatus.DONE if done else ag_types.StepStatus.ACTIVE,
        content_delta=delta,
        content=delta,
    )


def run_input(**kwargs):
    defaults = dict(
        thread_id="t1",
        run_id="r1",
        state={},
        messages=[UserMessage(id="m1", role="user", content="hi")],
        tools=[],
        context=[],
        forwarded_props={},
    )
    defaults.update(kwargs)
    return RunAgentInput(**defaults)


async def drain(agen):
    return [e async for e in agen]


def _frontend_tool_bridge(name="set_theme"):
    """Returns (bridge, AG-UI tool definition, the parking Antigravity tool)."""
    bridge = UIBridge()
    tool_def = AGUITool(
        name=name, description="", parameters={"type": "object", "properties": {}}
    )
    (tool,) = bridge.build_frontend_tools([tool_def])
    return bridge, tool_def, tool


def _tool_call_id(events):
    return [e for e in events if e.type == "TOOL_CALL_START"][0].tool_call_id


def _resume_messages(tool_call_id, content="dark"):
    return [
        UserMessage(id="m1", role="user", content="hi"),
        ToolMessage(
            id="m2", role="tool", content=content, tool_call_id=tool_call_id
        ),
    ]


class TestLifecycle:
    async def test_happy_path_is_bookended(self):
        agent = AntigravityAgent()
        session = make_session(FakeConversation([[text_step("hi", done=True)]]))
        events = await drain(agent._run_locked(session, run_input()))
        assert [e.type for e in events] == [
            "TEXT_MESSAGE_START",
            "TEXT_MESSAGE_CONTENT",
            "TEXT_MESSAGE_END",
            "RUN_FINISHED",
        ]

    async def test_full_run_emits_exactly_one_run_started(self):
        agent = AntigravityAgent()
        session = make_session(FakeConversation([[text_step("hi", done=True)]]))
        agent._sessions.get_or_create = _fixed_session(session)

        events = await drain(agent.run(run_input()))
        assert [e.type for e in events].count("RUN_STARTED") == 1
        assert events[0].type == "RUN_STARTED"
        assert events[-1].type == "RUN_FINISHED"

    async def test_error_yields_run_error_and_never_run_finished(self):
        agent = AntigravityAgent()
        conversation = FakeConversation(
            [[ag_types.AntigravityExecutionError("upstream 500")]]
        )
        session = make_session(conversation)
        events = await drain(agent._run_locked(session, run_input()))
        types = [e.type for e in events]
        assert "RUN_ERROR" in types
        assert "RUN_FINISHED" not in types
        assert "upstream 500" in events[-1].message

    async def test_run_error_from_session_startup_is_terminal(self):
        agent = AntigravityAgent()

        async def boom(*args, **kwargs):
            raise RuntimeError("harness binary missing")

        agent._sessions.get_or_create = boom
        events = await drain(agent.run(run_input()))
        types = [e.type for e in events]
        assert types == ["RUN_STARTED", "RUN_ERROR"]
        assert "harness binary missing" in events[-1].message

    async def test_open_text_block_is_closed_before_run_finished(self):
        """A stream that ends mid-message must still bookend correctly."""
        agent = AntigravityAgent()
        session = make_session(FakeConversation([[text_step("partial")]]))
        events = await drain(agent._run_locked(session, run_input()))
        types = [e.type for e in events]
        assert types.index("TEXT_MESSAGE_END") < types.index("RUN_FINISHED")

    async def test_a_run_that_produces_nothing_still_terminates(self):
        """AG-UI requires a terminal event even when there is no work to do."""
        agent = AntigravityAgent()
        session = make_session(FakeConversation([[]]))
        agent._sessions.get_or_create = _fixed_session(session)
        events = await drain(agent.run(run_input(messages=[])))
        assert [e.type for e in events] == ["RUN_STARTED", "RUN_FINISHED"]

    async def test_an_unknown_interrupt_id_in_resume_is_ignored(self):
        """A stale resume from a retrying client must not swallow the prompt."""
        agent = AntigravityAgent()
        conversation = FakeConversation([[text_step("ok", done=True)]])
        session = make_session(conversation)
        await drain(
            agent._run_locked(
                session,
                run_input(
                    resume=[
                        ResumeEntry(
                            interrupt_id="long-gone", payload="x", status="resolved"
                        )
                    ]
                ),
            )
        )
        assert conversation.sent == ["hi"]

    async def test_a_stale_tool_message_is_ignored(self):
        agent = AntigravityAgent()
        conversation = FakeConversation([[text_step("ok", done=True)]])
        session = make_session(conversation)
        await drain(
            agent._run_locked(
                session,
                run_input(
                    messages=[
                        UserMessage(id="m1", role="user", content="hi"),
                        ToolMessage(
                            id="m2", role="tool", content="x", tool_call_id="long-gone"
                        ),
                    ]
                ),
            )
        )
        assert conversation.sent == ["hi"]

    async def test_a_tool_message_with_no_call_id_is_skipped(self):
        agent = AntigravityAgent()
        conversation = FakeConversation([[text_step("ok", done=True)]])
        session = make_session(conversation)
        await drain(
            agent._run_locked(
                session,
                run_input(
                    messages=[
                        UserMessage(id="m1", role="user", content="hi"),
                        ToolMessage(id="m2", role="tool", content="x", tool_call_id=""),
                    ]
                ),
            )
        )
        assert conversation.sent == ["hi"]

    async def test_a_trailing_assistant_message_does_not_hide_the_prompt(self):
        agent = AntigravityAgent()
        conversation = FakeConversation([[text_step("ok", done=True)]])
        session = make_session(conversation)
        await drain(
            agent._run_locked(
                session,
                run_input(
                    messages=[
                        UserMessage(id="m1", role="user", content="the question"),
                        AssistantMessage(id="m2", role="assistant", content="a reply"),
                    ]
                ),
            )
        )
        assert conversation.sent == ["the question"]

    async def test_a_history_with_no_user_message_sends_nothing(self):
        agent = AntigravityAgent()
        conversation = FakeConversation([[text_step("ok", done=True)]])
        session = make_session(conversation)
        events = await drain(
            agent._run_locked(
                session,
                run_input(
                    messages=[
                        AssistantMessage(id="m1", role="assistant", content="hello")
                    ]
                ),
            )
        )
        assert conversation.sent == []
        assert events == []

    async def test_only_latest_user_message_is_forwarded(self):
        """Antigravity keeps its own history; replaying it would duplicate."""
        agent = AntigravityAgent()
        conversation = FakeConversation([[text_step("ok", done=True)]])
        session = make_session(conversation)
        await drain(
            agent._run_locked(
                session,
                run_input(
                    messages=[
                        UserMessage(id="m1", role="user", content="first"),
                        UserMessage(id="m2", role="user", content="second"),
                    ]
                ),
            )
        )
        assert conversation.sent == ["second"]


class TestParking:
    async def test_run_ends_with_interrupt_outcome_when_a_hook_parks(self):
        agent = AntigravityAgent()
        bridge = UIBridge()
        hook = bridge.build_interaction_hook()
        spec = ag_types.AskQuestionInteractionSpec(
            questions=[ag_types.AskQuestionEntry(question="Which?", options=[])]
        )
        parked_task = {}

        async def on_send():
            parked_task["t"] = asyncio.create_task(hook.run(None, spec))

        # The stream never completes: the harness is waiting on our coroutine.
        conversation = FakeConversation([[BLOCK]], on_send=on_send)
        session = make_session(conversation, bridge)

        events = await asyncio.wait_for(
            drain(agent._run_locked(session, run_input())), 10
        )
        final = events[-1]
        assert final.type == "RUN_FINISHED"
        assert final.outcome is not None
        assert final.outcome.type == "interrupt"
        assert final.outcome.interrupts[0].reason == "ask_question"

        parked_task["t"].cancel()

    async def test_frontend_tool_events_reach_the_stream_then_run_ends(self):
        agent = AntigravityAgent()
        bridge = UIBridge()
        tool_def = AGUITool(
            name="set_theme",
            description="",
            parameters={"type": "object", "properties": {}},
        )
        (tool,) = bridge.build_frontend_tools([tool_def])
        parked = {}

        async def on_send():
            parked["t"] = asyncio.create_task(tool())

        conversation = FakeConversation([[BLOCK]], on_send=on_send)
        session = make_session(conversation, bridge)

        events = await asyncio.wait_for(
            drain(agent._run_locked(session, run_input(tools=[tool_def]))), 10
        )
        types = [e.type for e in events]
        assert "TOOL_CALL_START" in types
        assert "TOOL_CALL_END" in types
        assert types[-1] == "RUN_FINISHED"
        parked["t"].cancel()

    async def test_tool_message_resolves_the_parked_tool_next_run(self):
        agent = AntigravityAgent()
        bridge = UIBridge()
        tool_def = AGUITool(
            name="set_theme",
            description="",
            parameters={"type": "object", "properties": {}},
        )
        (tool,) = bridge.build_frontend_tools([tool_def])

        task = asyncio.create_task(tool())
        await asyncio.sleep(0.05)
        tool_call_id = [
            e for e in bridge.drain() if e.type == "TOOL_CALL_START"
        ][0].tool_call_id

        conversation = FakeConversation([[text_step("themed", done=True)]])
        session = make_session(conversation, bridge, forwarded={"m1"})

        events = await drain(
            agent._run_locked(
                session,
                run_input(
                    tools=[tool_def],
                    messages=[
                        UserMessage(id="m1", role="user", content="theme it"),
                        ToolMessage(
                            id="m2",
                            role="tool",
                            content="dark",
                            tool_call_id=tool_call_id,
                        ),
                    ],
                ),
            )
        )
        assert await asyncio.wait_for(task, 1) == "dark"
        # A pure resumption must not re-send the prompt as a new user turn.
        assert conversation.sent == []
        assert events[-1].type == "RUN_FINISHED"

    async def test_resume_entry_resolves_a_parked_interrupt_next_run(self):
        agent = AntigravityAgent()
        bridge = UIBridge()
        hook = bridge.build_interaction_hook()
        spec = ag_types.AskQuestionInteractionSpec(
            questions=[ag_types.AskQuestionEntry(question="Which?", options=[])]
        )
        task = asyncio.create_task(hook.run(None, spec))
        await asyncio.sleep(0.05)
        interrupt_id = bridge.pending_interrupts()[0].id

        conversation = FakeConversation([[text_step("answered", done=True)]])
        # The park implies a prior run that already forwarded the prompt.
        session = make_session(conversation, bridge, forwarded={"m1"})
        events = await drain(
            agent._run_locked(
                session,
                run_input(
                    resume=[
                        ResumeEntry(
                            interrupt_id=interrupt_id,
                            payload="purple",
                            status="resolved",
                        )
                    ]
                ),
            )
        )
        result = await asyncio.wait_for(task, 1)
        assert result.responses[0].freeform_response == "purple"
        assert conversation.sent == []
        assert events[-1].type == "RUN_FINISHED"

    async def test_cancelled_resume_entry_cancels_the_parked_request(self):
        agent = AntigravityAgent()
        bridge = UIBridge()
        hook = bridge.build_interaction_hook()
        spec = ag_types.AskQuestionInteractionSpec(
            questions=[ag_types.AskQuestionEntry(question="Which?", options=[])]
        )
        task = asyncio.create_task(hook.run(None, spec))
        await asyncio.sleep(0.05)
        interrupt_id = bridge.pending_interrupts()[0].id

        session = make_session(FakeConversation([[text_step("ok", done=True)]]), bridge)
        await drain(
            agent._run_locked(
                session,
                run_input(
                    resume=[
                        ResumeEntry(
                            interrupt_id=interrupt_id,
                            payload=None,
                            status="cancelled",
                        )
                    ]
                ),
            )
        )
        assert (await asyncio.wait_for(task, 1)).cancelled is True

    async def test_an_answered_interrupt_does_not_re_interrupt_the_next_run(self):
        agent = AntigravityAgent()
        bridge = UIBridge()
        hook = bridge.build_interaction_hook()
        spec = ag_types.AskQuestionInteractionSpec(
            questions=[ag_types.AskQuestionEntry(question="Which?", options=[])]
        )
        task = asyncio.create_task(hook.run(None, spec))
        await asyncio.sleep(0.05)
        interrupt_id = bridge.pending_interrupts()[0].id

        session = make_session(FakeConversation([[text_step("ok", done=True)]]), bridge)
        events = await drain(
            agent._run_locked(
                session,
                run_input(
                    resume=[
                        ResumeEntry(
                            interrupt_id=interrupt_id,
                            payload="p",
                            status="resolved",
                        )
                    ]
                ),
            )
        )
        await asyncio.wait_for(task, 1)
        assert events[-1].type == "RUN_FINISHED"
        assert events[-1].outcome is None

    async def test_a_parked_turn_keeps_its_iterator_and_in_flight_step(self):
        """Restarting receive_steps() would replay the in-progress turn, and
        cancelling the in-flight __anext__() would drop the step the harness is
        mid-way through delivering."""
        agent = AntigravityAgent()
        bridge, tool_def, tool = _frontend_tool_bridge()
        parked = {}

        async def on_send():
            parked["t"] = asyncio.create_task(tool())

        conversation = FakeConversation([[BLOCK, text_step("themed", done=True)]],
                                        on_send=on_send)
        session = make_session(conversation, bridge)

        first = await asyncio.wait_for(
            drain(agent._run_locked(session, run_input(tools=[tool_def]))), 10
        )
        assert session.step_iter is not None
        assert session.pending_step is not None
        first_iter = session.step_iter
        first_translator = session.translator
        assert first_translator is not None

        conversation.gate.set()
        second = await asyncio.wait_for(
            drain(
                agent._run_locked(
                    session,
                    run_input(
                        tools=[tool_def],
                        messages=_resume_messages(_tool_call_id(first)),
                    ),
                )
            ),
            10,
        )
        # The turn ran to completion on the same iterator and translator.
        assert session.step_iter is None, "an exhausted turn must be retired"
        assert "TEXT_MESSAGE_CONTENT" in [e.type for e in second]
        assert conversation.sent == ["hi"], "the turn must not be re-prompted"
        assert first_iter is not None and first_translator is not None
        await asyncio.wait_for(parked["t"], 1)

    async def test_a_redelivered_step_is_not_translated_twice_across_runs(self):
        """The turn-scoped translator is what stops the client re-running a tool."""
        agent = AntigravityAgent()
        bridge, tool_def, tool = _frontend_tool_bridge()
        parked = {}

        async def on_send():
            parked["t"] = asyncio.create_task(tool())

        # The harness re-delivers the completed step it already sent pre-park.
        already_sent = text_step("thinking about it", index=1, done=True)
        conversation = FakeConversation(
            [[
                already_sent,
                BLOCK,
                already_sent,
                text_step("done", index=2, done=True),
            ]],
            on_send=on_send,
        )
        session = make_session(conversation, bridge)

        first = await asyncio.wait_for(
            drain(agent._run_locked(session, run_input(tools=[tool_def]))), 10
        )
        assert [e.type for e in first].count("TEXT_MESSAGE_CONTENT") == 1

        conversation.gate.set()
        second = await asyncio.wait_for(
            drain(
                agent._run_locked(
                    session,
                    run_input(
                        tools=[tool_def],
                        messages=_resume_messages(_tool_call_id(first)),
                    ),
                )
            ),
            10,
        )
        deltas = [e.delta for e in second if e.type == "TEXT_MESSAGE_CONTENT"]
        assert deltas == ["done"], deltas
        await asyncio.wait_for(parked["t"], 1)

    async def test_frontend_tools_are_suppressed_in_the_translator(self):
        """Both the bridge and the translator see the call; only one may emit."""
        agent = AntigravityAgent()
        bridge = UIBridge()
        tool_def = AGUITool(
            name="set_theme",
            description="",
            parameters={"type": "object", "properties": {}},
        )
        bridge.build_frontend_tools([tool_def])

        call = ag_types.ToolCall(name="set_theme", args={"theme": "dark"}, id="tc-1")
        tool_step = ag_types.Step(
            id="traj:1",
            step_index=1,
            type=ag_types.StepType.TOOL_CALL,
            source=ag_types.StepSource.MODEL,
            target=ag_types.StepTarget.USER,
            status=ag_types.StepStatus.DONE,
            tool_calls=[call],
        )
        session = make_session(FakeConversation([[tool_step]]), bridge)
        events = await drain(
            agent._run_locked(session, run_input(tools=[tool_def]))
        )
        assert [e.type for e in events] == ["RUN_FINISHED"]


class TestTurnBoundaries:
    async def test_a_new_prompt_after_a_finished_turn_starts_a_clean_turn(self):
        """A translator carried over would suppress the reused step_index as
        an already-completed redelivery, silently dropping the second answer."""
        agent = AntigravityAgent()
        conversation = FakeConversation(
            [[text_step("one", done=True)], [text_step("two", done=True)]]
        )
        session = make_session(conversation)

        await drain(agent._run_locked(session, run_input()))
        second = await drain(
            agent._run_locked(
                session,
                run_input(messages=[UserMessage(id="m2", role="user", content="again")]),
            )
        )
        assert conversation.sent == ["hi", "again"]
        assert [e.delta for e in second if e.type == "TEXT_MESSAGE_CONTENT"] == ["two"]

    async def test_a_new_prompt_retires_an_abandoned_turn(self):
        """The client answered the park out of band and then moved on: the
        half-consumed iterator of the abandoned turn must not be reused, or the
        harness re-delivers it and the new prompt's answer never arrives."""
        agent = AntigravityAgent()
        bridge, tool_def, tool = _frontend_tool_bridge()
        parked = {}

        async def on_send():
            parked.setdefault("t", asyncio.create_task(tool()))

        conversation = FakeConversation(
            [[BLOCK], [text_step("fresh", done=True)]], on_send=on_send
        )
        session = make_session(conversation, bridge)

        first = await asyncio.wait_for(
            drain(agent._run_locked(session, run_input(tools=[tool_def]))), 10
        )
        stale_iterator = session.step_iter
        assert stale_iterator is not None

        # Answered outside this run's input, so the next run is a plain prompt.
        bridge.resolve_tool_call(_tool_call_id(first), "dark")
        bridge.forget_resolved()
        await asyncio.wait_for(parked["t"], 1)
        assert bridge.has_pending is False

        second = await asyncio.wait_for(
            drain(
                agent._run_locked(
                    session,
                    run_input(
                        tools=[tool_def],
                        messages=[UserMessage(id="m2", role="user", content="new")],
                    ),
                )
            ),
            10,
        )
        assert session.step_iter is not stale_iterator
        assert [e.delta for e in second if e.type == "TEXT_MESSAGE_CONTENT"] == ["fresh"]

    async def test_exhausted_stream_clears_the_iterator_for_the_next_turn(self):
        agent = AntigravityAgent()
        session = make_session(FakeConversation([[text_step("done", done=True)]]))
        await drain(agent._run_locked(session, run_input()))
        assert session.step_iter is None
        assert session.pending_step is None
        assert session.translator is None

    async def test_a_failed_turn_does_not_carry_its_iterator_forward(self):
        """A half-consumed iterator would replay the dead turn on the next run."""
        agent = AntigravityAgent()
        session = make_session(
            FakeConversation([[ag_types.AntigravityExecutionError("boom")]])
        )
        await drain(agent._run_locked(session, run_input()))
        assert session.step_iter is None
        assert session.translator is None

    async def test_a_run_with_nothing_to_say_or_resume_ends_immediately(self):
        agent = AntigravityAgent()
        conversation = FakeConversation([[text_step("never", done=True)]])
        session = make_session(conversation)
        events = await drain(
            agent._run_locked(session, run_input(messages=[]))
        )
        assert events == []
        assert conversation.sent == []

    async def test_a_queued_bridge_event_is_still_drained_on_an_empty_run(self):
        agent = AntigravityAgent()
        bridge = UIBridge()
        bridge.emit(
            ToolCallStartEvent(
                type="TOOL_CALL_START", tool_call_id="tc-1", tool_call_name="x"
            )
        )
        session = make_session(FakeConversation([[]]), bridge)
        events = await drain(agent._run_locked(session, run_input(messages=[])))
        assert [e.type for e in events] == ["TOOL_CALL_START"]

    async def test_a_blank_user_message_is_not_treated_as_a_prompt(self):
        agent = AntigravityAgent()
        conversation = FakeConversation([[text_step("x", done=True)]])
        session = make_session(conversation)
        await drain(
            agent._run_locked(
                session,
                run_input(messages=[UserMessage(id="m1", role="user", content="   ")]),
            )
        )
        assert conversation.sent == []

    async def test_a_new_prompt_while_parked_abandons_the_stale_request(self):
        """The user moved on, so the old park must be released.

        Keeping it looks safer but is not: the harness stays blocked inside our
        coroutine, `_steps_with_bridge` sees `has_pending` and returns before
        reading a single step, so the new turn's output is silently dropped and
        an exception from the harness never surfaces. `is_parked` also stays
        true, so the idle sweeper never reclaims the session.
        """
        agent = AntigravityAgent()
        bridge = UIBridge()
        tool_def = AGUITool(
            name="set_theme",
            description="",
            parameters={"type": "object", "properties": {}},
        )
        (tool,) = bridge.build_frontend_tools([tool_def])
        parked = {}

        async def on_send():
            # Only the FIRST turn parks; setdefault would evaluate its default
            # eagerly and spawn a second task on the new prompt.
            if "t" not in parked:
                parked["t"] = asyncio.create_task(tool())

        conversation = FakeConversation(
            [[BLOCK], [text_step("hello", index=5, done=True)]], on_send=on_send
        )
        session = make_session(conversation, bridge)

        await asyncio.wait_for(
            drain(agent._run_locked(session, run_input(tools=[tool_def]))), 10
        )
        assert session.is_parked

        events = await asyncio.wait_for(
            drain(
                agent._run_locked(
                    session,
                    run_input(
                        tools=[tool_def],
                        messages=[UserMessage(id="m2", role="user", content="also this")],
                    ),
                )
            ),
            10,
        )

        # The new turn's output reaches the client...
        assert "TEXT_MESSAGE_CONTENT" in [e.type for e in events]
        assert "".join(
            e.delta for e in events if e.type == "TEXT_MESSAGE_CONTENT"
        ) == "hello"
        # ...and the stale park is released, so the session can be reclaimed.
        assert not session.is_parked
        assert await asyncio.wait_for(parked["t"], 1)

    async def test_an_error_while_parked_releases_the_park(self):
        """A run that fails with something still parked must not pin the session.

        Isolates the error path specifically: this is a RESUME run (no new user
        prompt), so the new-prompt abandon cannot mask it. The failure arrives
        through the `__anext__()` future the previous run left in flight, which
        is the only way an error reaches a parked turn.
        """
        agent = AntigravityAgent()
        bridge = UIBridge()
        tool_def = AGUITool(
            name="set_theme",
            description="",
            parameters={"type": "object", "properties": {}},
        )
        other_def = AGUITool(
            name="set_font",
            description="",
            parameters={"type": "object", "properties": {}},
        )
        # Two DIFFERENT tools: per-turn dedup means two calls to the same tool
        # would only ever park once, leaving nothing behind to leak.
        first_tool, second_tool = bridge.build_frontend_tools([tool_def, other_def])

        answered = asyncio.create_task(first_tool(theme="dark"))
        still_parked = asyncio.create_task(second_tool(theme="light"))
        await asyncio.sleep(0.05)
        starts = [e for e in bridge.drain() if e.type == "TOOL_CALL_START"]

        session = make_session(FakeConversation([[]]), bridge)
        # The in-flight step future already carries the harness failure.
        failed: asyncio.Future = asyncio.get_running_loop().create_future()
        failed.set_exception(ag_types.AntigravityExecutionError("upstream 500"))
        session.step_iter = _NullIterator()
        session.pending_step = failed

        events = await drain(
            agent._run_locked(
                session,
                run_input(
                    tools=[tool_def, other_def],
                    messages=[
                        UserMessage(id="m1", role="user", content="theme it"),
                        ToolMessage(
                            id="m2",
                            role="tool",
                            content="ok",
                            tool_call_id=starts[0].tool_call_id,
                        ),
                    ],
                ),
            )
        )

        assert [e.type for e in events][-1] == "RUN_ERROR"
        assert "upstream 500" in events[-1].message
        assert not session.is_parked, "the surviving park still pins the session"
        await asyncio.wait_for(answered, 1)
        await asyncio.wait_for(still_parked, 1)


class _NullIterator:
    """A step iterator that is never advanced (the pending future stands in)."""

    async def __anext__(self):  # pragma: no cover - never reached
        raise StopAsyncIteration

    async def aclose(self):
        return None


class TestCancellation:
    async def test_cancellation_mid_stream_is_reported_as_cancelled(self):
        """A cancellation is not a successful run.

        It must also be reported identically wherever it surfaces: the handler
        in `run()` already emits RUN_ERROR/CANCELLED, so the in-loop path
        emitting RUN_FINISHED made the outcome depend on timing.
        """
        agent = AntigravityAgent()
        session = make_session(
            FakeConversation([[ag_types.AntigravityCancelledError("client went away")]])
        )
        events = await drain(agent._run_locked(session, run_input()))
        types = [e.type for e in events]
        assert types[-1] == "RUN_ERROR"
        assert events[-1].code == "CANCELLED"
        assert "RUN_FINISHED" not in types

    async def test_cancellation_is_reported_the_same_from_either_path(self):
        """In-loop and startup cancellations must not disagree."""
        agent = AntigravityAgent()
        in_loop = make_session(
            FakeConversation([[ag_types.AntigravityCancelledError("gone")]])
        )
        inner = await drain(agent._run_locked(in_loop, run_input()))

        async def boom(*args, **kwargs):
            raise ag_types.AntigravityCancelledError("gone")

        agent._sessions.get_or_create = boom
        outer = [e async for e in agent.run(run_input())]

        assert inner[-1].type == outer[-1].type == "RUN_ERROR"
        assert inner[-1].code == outer[-1].code == "CANCELLED"

    async def test_cancellation_during_session_startup_is_its_own_error_code(self):
        agent = AntigravityAgent()

        async def cancelled(*args, **kwargs):
            raise ag_types.AntigravityCancelledError("gone")

        agent._sessions.get_or_create = cancelled
        events = await drain(agent.run(run_input()))
        assert [e.type for e in events] == ["RUN_STARTED", "RUN_ERROR"]
        assert events[-1].code == "CANCELLED"


class TestSessionLimit:
    async def test_session_limit_surfaces_as_a_dedicated_error_code(self):
        agent = AntigravityAgent()

        async def over_limit(*args, **kwargs):
            raise SessionLimitExceeded("50 of 50 in use.")

        agent._sessions.get_or_create = over_limit
        events = await drain(agent.run(run_input()))
        assert [e.type for e in events] == ["RUN_STARTED", "RUN_ERROR"]
        assert events[-1].code == "SESSION_LIMIT"
        assert "50 of 50" in events[-1].message

    async def test_run_finished_is_not_appended_after_a_terminal_run_error(self):
        """Exactly one terminal event: RUN_FINISHED must never follow RUN_ERROR."""
        agent = AntigravityAgent()
        session = make_session(
            FakeConversation([[ag_types.AntigravityExecutionError("boom")]])
        )
        agent._sessions.get_or_create = _fixed_session(session)
        types = [e.type async for e in agent.run(run_input())]
        assert types.count("RUN_FINISHED") == 0
        assert types.count("RUN_ERROR") == 1

    async def test_the_session_lock_serializes_concurrent_runs(self):
        """AG-UI clients retry; the SDK rejects concurrent receive_steps()."""
        agent = AntigravityAgent()
        session = make_session(
            FakeConversation(
                [[text_step("one", done=True)], [text_step("two", done=True)]]
            )
        )
        agent._sessions.get_or_create = _fixed_session(session)

        async def go(run_id):
            return [e.type async for e in agent.run(run_input(run_id=run_id))]

        first, second = await asyncio.gather(go("r1"), go("r2"))
        for types in (first, second):
            assert types[0] == "RUN_STARTED"
            assert types[-1] == "RUN_FINISHED"

    @pytest.mark.parametrize(
        "exc",
        [
            SessionLimitExceeded("full"),
            ag_types.AntigravityCancelledError("gone"),
            RuntimeError("bookkeeping blew up"),
        ],
    )
    async def test_a_failure_after_the_terminal_event_adds_no_second_one(self, exc):
        """Exactly one terminal event, whatever goes wrong on the way out.

        Armed by the terminal event rather than by a call count: the run also
        touches the session while streaming (so a long turn does not look idle
        to the sweeper), and counting would trip on that instead.
        """
        agent = AntigravityAgent()
        session = make_session(FakeConversation([[text_step("hi", done=True)]]))
        armed = {"yes": False}
        real_touch = session.touch

        def touch():
            if armed["yes"]:
                raise exc
            real_touch()

        session.touch = touch
        agent._sessions.get_or_create = _fixed_session(session)

        types = []
        async for event in agent.run(run_input()):
            types.append(event.type)
            if event.type in ("RUN_FINISHED", "RUN_ERROR"):
                armed["yes"] = True

        assert types.count("RUN_FINISHED") + types.count("RUN_ERROR") == 1
        assert types[-1] == "RUN_FINISHED"

    async def test_the_session_is_touched_around_the_run(self):
        agent = AntigravityAgent()
        session = make_session(FakeConversation([[text_step("hi", done=True)]]))
        session.last_activity = 0.0
        agent._sessions.get_or_create = _fixed_session(session)
        await drain(agent.run(run_input()))
        assert session.last_activity > 0.0


def _fixed_session(session):
    async def _get_or_create(thread_id, *, signature, factory, bridge_factory=None):
        return session

    return _get_or_create


class TestErrorSteps:
    """The SDK raises only for source=SYSTEM with HTTP 400/401/403. Everything
    else -- rate limits, 5xx, model-side failures -- is *yielded* as a step with
    status=ERROR, so a loop that only catches exceptions calls a failed run a
    success."""

    def _error_step(self, source, message="rate limited", index=1):
        return ag_types.Step(
            id=f"traj:{index}",
            step_index=index,
            type=ag_types.StepType.TEXT_RESPONSE,
            source=source,
            target=ag_types.StepTarget.USER,
            status=ag_types.StepStatus.ERROR,
            error=message,
        )

    @pytest.mark.parametrize(
        "source", [ag_types.StepSource.MODEL, ag_types.StepSource.SYSTEM]
    )
    async def test_an_error_step_ends_the_run_as_run_error(self, source):
        agent = AntigravityAgent()
        session = make_session(FakeConversation([[self._error_step(source)]]))
        events = await drain(agent._run_locked(session, run_input()))

        types = [e.type for e in events]
        assert "RUN_ERROR" in types, types
        assert "RUN_FINISHED" not in types
        assert "rate limited" in events[-1].message

    async def test_partial_text_is_closed_before_the_error(self):
        agent = AntigravityAgent()
        session = make_session(
            FakeConversation(
                [[text_step("partial answer"), self._error_step(
                    ag_types.StepSource.MODEL, "upstream 503", index=2)]]
            )
        )
        events = await drain(agent._run_locked(session, run_input()))
        types = [e.type for e in events]
        assert types.index("TEXT_MESSAGE_END") < types.index("RUN_ERROR")
        assert "upstream 503" in events[-1].message

    async def test_a_successful_step_is_unaffected(self):
        agent = AntigravityAgent()
        session = make_session(FakeConversation([[text_step("fine", done=True)]]))
        events = await drain(agent._run_locked(session, run_input()))
        assert [e.type for e in events][-1] == "RUN_FINISHED"


class TestFailureWhileParked:
    """A park lasts as long as the human does -- the longest window in the
    design for the harness to die unobserved."""

    async def test_a_failure_that_landed_while_parked_is_surfaced(self):
        agent = AntigravityAgent()
        session = make_session(FakeConversation([[text_step("ignored", done=True)]]))
        failed: asyncio.Future = asyncio.get_running_loop().create_future()
        failed.set_exception(ag_types.AntigravityExecutionError("harness died"))
        session.pending_step = failed

        events = await drain(agent._run_locked(session, run_input()))

        assert [e.type for e in events] == ["RUN_ERROR"]
        assert "harness died" in events[-1].message

    async def test_a_clean_park_does_not_invent_a_failure(self):
        agent = AntigravityAgent()
        conversation = FakeConversation([[text_step("hi", done=True)]])
        session = make_session(conversation)
        pending: asyncio.Future = asyncio.get_running_loop().create_future()
        pending.cancel()
        session.pending_step = pending

        events = await drain(agent._run_locked(session, run_input()))
        assert [e.type for e in events][-1] == "RUN_FINISHED"


class TestEndOfTurnWhileParked:
    """The harness backgrounds a slow custom tool and goes idle, so the
    in-flight __anext__() left over from a parked run routinely completes with
    StopAsyncIteration. That is the turn ending, not the harness failing."""

    async def test_a_normal_end_of_turn_does_not_abort_the_next_prompt(self):
        agent = AntigravityAgent()
        conversation = FakeConversation([[text_step("new answer", index=7, done=True)]])
        session = make_session(conversation)

        ended: asyncio.Future = asyncio.get_running_loop().create_future()
        ended.set_exception(StopAsyncIteration())
        session.pending_step = ended
        session.step_iter = _NullIterator()

        events = await drain(
            agent._run_locked(
                session,
                run_input(messages=[UserMessage(id="m2", role="user", content="next")]),
            )
        )

        types = [e.type for e in events]
        assert "RUN_ERROR" not in types, types
        assert conversation.sent == ["next"], "the new prompt must reach the harness"
        assert "".join(
            e.delta for e in events if e.type == "TEXT_MESSAGE_CONTENT"
        ) == "new answer"


class TestPromptAlongsideAnswer:
    """Clients flush the tool result and whatever the user typed in one POST."""

    def _tool_def(self):
        return AGUITool(
            name="set_theme",
            description="",
            parameters={"type": "object", "properties": {}},
        )

    async def test_a_user_message_after_the_tool_answer_is_still_sent(self):
        agent = AntigravityAgent()
        bridge = UIBridge()
        tool_def = self._tool_def()
        (tool,) = bridge.build_frontend_tools([tool_def])
        task = asyncio.create_task(tool())
        await asyncio.sleep(0.05)
        call_id = [e for e in bridge.drain() if e.type == "TOOL_CALL_START"][0].tool_call_id

        conversation = FakeConversation([[text_step("ok", done=True)]])
        session = make_session(conversation, bridge, forwarded={"m1"})
        await drain(
            agent._run_locked(
                session,
                run_input(
                    tools=[tool_def],
                    messages=[
                        UserMessage(id="m1", role="user", content="theme it"),
                        ToolMessage(id="m2", role="tool", content="dark",
                                    tool_call_id=call_id),
                        UserMessage(id="m3", role="user", content="and also this"),
                    ],
                ),
            )
        )
        await asyncio.wait_for(task, 1)
        assert conversation.sent == ["and also this"]

    async def test_the_turns_original_prompt_is_not_replayed_on_resume(self):
        agent = AntigravityAgent()
        bridge = UIBridge()
        tool_def = self._tool_def()
        (tool,) = bridge.build_frontend_tools([tool_def])
        task = asyncio.create_task(tool())
        await asyncio.sleep(0.05)
        call_id = [e for e in bridge.drain() if e.type == "TOOL_CALL_START"][0].tool_call_id

        conversation = FakeConversation([[text_step("ok", done=True)]])
        session = make_session(conversation, bridge, forwarded={"m1"})
        await drain(
            agent._run_locked(
                session,
                run_input(
                    tools=[tool_def],
                    messages=[
                        UserMessage(id="m1", role="user", content="theme it"),
                        ToolMessage(id="m2", role="tool", content="dark",
                                    tool_call_id=call_id),
                    ],
                ),
            )
        )
        await asyncio.wait_for(task, 1)
        assert conversation.sent == [], "re-sending would run the whole turn again"


class TestStructuredOutputValidation:
    async def test_an_unknown_structured_output_mode_is_rejected(self):
        """The translator routes on != 'custom' and capabilities on == 'state',
        so a third value would make the agent emit what it says it cannot."""
        with pytest.raises(ValueError, match="structured_output_as"):
            AntigravityAgent(structured_output_as="snapshot")


class TestLongTurnKeepsItsSessionAlive:
    """`last_activity` is only stamped around the run, so a single Antigravity
    turn that outlives `session_timeout_seconds` would look idle to the sweeper
    and be reclaimed mid-stream."""

    async def test_streaming_keeps_the_session_out_of_the_sweeper(self):
        import time as _time

        from ag_ui_antigravity.session_manager import SessionManager

        agent = AntigravityAgent()
        manager = SessionManager(session_timeout_seconds=60)

        class AgingConversation(FakeConversation):
            """Each step costs more than the whole idle timeout."""

            def __init__(self, scripts, session_ref):
                super().__init__(scripts)
                self._session_ref = session_ref

            async def receive_steps(self):
                async for item in super().receive_steps():
                    self._session_ref["s"].last_activity -= 600
                    yield item

        ref = {}
        conversation = AgingConversation(
            [[text_step("a"), text_step("b"), text_step("c", done=True)]], ref
        )
        session = make_session(conversation)
        ref["s"] = session

        await drain(agent._run_locked(session, run_input()))

        assert not manager._expired(session, _time.monotonic()), (
            "a turn that streamed for longer than the idle timeout was left "
            "looking idle, so the sweeper would tear it down mid-run"
        )


class TestPromptIdentity:
    """Which user message to forward is decided by identity, not position.

    Position fails both ways: a ToolMessage left over from an earlier turn
    makes the current turn's prompt look 'new' and replays the whole turn,
    while a run resumed purely by a `resume` entry has no ToolMessage to
    anchor against and drops genuinely new text."""

    async def test_a_stale_tool_message_does_not_replay_the_turns_prompt(self):
        agent = AntigravityAgent()
        conversation = FakeConversation([[text_step("ok", done=True)]])
        session = make_session(conversation, forwarded={"turn1", "turn2"})

        await drain(
            agent._run_locked(
                session,
                run_input(
                    messages=[
                        UserMessage(id="turn1", role="user", content="TURN ONE"),
                        # a tool answer from the FIRST turn
                        ToolMessage(id="t1", role="tool", content="done",
                                    tool_call_id="old"),
                        UserMessage(id="turn2", role="user", content="TURN TWO"),
                    ]
                ),
            )
        )
        assert conversation.sent == [], "TURN TWO was already forwarded"

    async def test_new_text_is_forwarded_even_with_no_tool_message(self):
        agent = AntigravityAgent()
        conversation = FakeConversation([[text_step("ok", done=True)]])
        session = make_session(conversation, forwarded={"turn1"})

        await drain(
            agent._run_locked(
                session,
                run_input(
                    messages=[
                        UserMessage(id="turn1", role="user", content="TURN ONE"),
                        UserMessage(id="turn2", role="user", content="TURN TWO"),
                    ]
                ),
            )
        )
        assert conversation.sent == ["TURN TWO"]

    async def test_a_forwarded_prompt_is_recorded_so_the_next_run_skips_it(self):
        agent = AntigravityAgent()
        conversation = FakeConversation(
            [[text_step("a", done=True)], [text_step("b", done=True)]]
        )
        session = make_session(conversation)
        payload = run_input(
            messages=[UserMessage(id="only", role="user", content="hello")]
        )

        await drain(agent._run_locked(session, payload))
        await drain(agent._run_locked(session, payload))

        assert conversation.sent == ["hello"], "the same message went twice"
        assert "only" in session.forwarded_prompts


class TestPromptRecordedOnlyAfterSend:
    """Recording the id before the send makes a failed send look delivered, so
    the client's retry is swallowed and the run reports success."""

    async def test_a_failed_send_leaves_the_prompt_retryable(self):
        agent = AntigravityAgent()

        class RefusingConversation(FakeConversation):
            def __init__(self):
                super().__init__([[text_step("ok", done=True)]])
                self.fail = True

            async def send(self, prompt):
                if self.fail:
                    raise ag_types.AntigravityConnectionError("socket reset")
                await super().send(prompt)

        conversation = RefusingConversation()
        session = make_session(conversation)
        agent._sessions.get_or_create = _fixed_session(session)
        payload = run_input(
            messages=[UserMessage(id="m1", role="user", content="important")]
        )

        first = [e async for e in agent.run(payload)]
        assert first[-1].type == "RUN_ERROR"
        assert "m1" not in session.forwarded_prompts, "a failed send was recorded"

        conversation.fail = False
        second = await drain(agent._run_locked(session, payload))
        assert conversation.sent == ["important"], "the retry was swallowed"
        assert second[-1].type == "RUN_FINISHED"

    async def test_a_stale_failure_return_does_not_consume_the_prompt(self):
        agent = AntigravityAgent()
        conversation = FakeConversation([[text_step("ok", done=True)]])
        session = make_session(conversation)
        failed: asyncio.Future = asyncio.get_running_loop().create_future()
        failed.set_exception(ag_types.AntigravityExecutionError("harness died"))
        session.pending_step = failed

        payload = run_input(
            messages=[UserMessage(id="m1", role="user", content="important")]
        )
        events = await drain(agent._run_locked(session, payload))
        assert events[-1].type == "RUN_ERROR"
        assert "m1" not in session.forwarded_prompts
        assert conversation.sent == []


class TestMultimodalPrompt:
    async def test_text_parts_of_a_list_message_are_forwarded(self):
        """A list-shaped message must not silently become a no-op run."""
        from ag_ui.core import TextInputContent

        agent = AntigravityAgent()
        conversation = FakeConversation([[text_step("ok", done=True)]])
        session = make_session(conversation)
        await drain(
            agent._run_locked(
                session,
                run_input(
                    messages=[
                        UserMessage(
                            id="m1",
                            role="user",
                            content=[TextInputContent(type="text", text="hello")],
                        )
                    ]
                ),
            )
        )
        assert conversation.sent == ["hello"]

    async def test_a_message_with_no_text_parts_does_not_replay_an_older_turn(self):
        """An image-only message has nothing to send; the run must not fall
        back to a prompt the harness already has."""
        from ag_ui.core import ImageInputContent, InputContentUrlSource

        agent = AntigravityAgent()
        conversation = FakeConversation([[text_step("ok", done=True)]])
        session = make_session(conversation, forwarded={"m1"})
        await drain(
            agent._run_locked(
                session,
                run_input(
                    messages=[
                        UserMessage(id="m1", role="user", content="earlier turn"),
                        UserMessage(
                            id="m2",
                            role="user",
                            content=[
                                ImageInputContent(
                                    type="image",
                                    mime_type="image/png",
                                    source=InputContentUrlSource(
                                        type="url", value="https://example.com/a.png"
                                    ),
                                )
                            ],
                        ),
                    ]
                ),
            )
        )
        assert conversation.sent == []


class TestForcedCloseDuringARun:
    """A forced close cancels the future the run stashed on the session.
    `CancelledError` is a BaseException, so a bare one escapes both `run()` and
    the SSE writer and the client gets no terminal event at all."""

    async def test_a_forced_close_still_ends_the_run_with_a_terminal_event(self):
        from ag_ui_antigravity.session_manager import AntigravitySession

        agent = AntigravityAgent()
        conversation = FakeConversation([[BLOCK]])
        session = make_session(conversation)
        agent._sessions.get_or_create = _fixed_session(session)
        agent._sessions._sessions["t1"] = session

        events = []
        run = agent.run(run_input())

        # Start the run, let it reach the blocking read, then cancel the future
        # it stashed -- exactly what a forced close does.
        task = asyncio.create_task(asyncio.wait_for(_drain(run, events), 5))
        await asyncio.sleep(0.1)
        assert session.pending_step is not None, "the run never reached a read"
        session.pending_step.cancel()
        await task

        types = [e.type for e in events]
        terminals = [t for t in types if t in ("RUN_FINISHED", "RUN_ERROR")]
        assert len(terminals) == 1, f"expected one terminal event, got {types}"
        assert terminals[0] == "RUN_ERROR"
        assert events[-1].code == "CANCELLED"


async def _drain(run, events):
    async for event in run:
        events.append(event)


class TestSessionTornDownMidRun:
    """A forced close pops the session from the manager, but the run holds a
    direct reference and may be suspended in an await. Resuming onto it drives
    a shut-down harness and parks requests on a bridge that was already failed
    -- all on an object no sweeper can reach again."""

    async def test_a_run_aborts_when_its_session_is_closed_underneath_it(self):
        agent = AntigravityAgent()
        conversation = FakeConversation([[text_step("should not stream", done=True)]])
        session = make_session(conversation)
        agent._sessions._sessions["t1"] = session
        agent._sessions.get_or_create = _fixed_session(session)

        # Torn down between runs, exactly as a forced close leaves it.
        await agent._sessions.close("t1")
        assert session.closed

        events = [e async for e in agent.run(run_input())]
        types = [e.type for e in events]

        assert types[-1] == "RUN_ERROR"
        assert events[-1].code == "CANCELLED"
        assert conversation.sent == [], "drove a harness that was shut down"

    async def test_a_close_during_send_does_not_park_on_a_dead_session(self):
        agent = AntigravityAgent()

        class ClosingConversation(FakeConversation):
            def __init__(self, session_ref):
                super().__init__([[text_step("late", done=True)]])
                self._ref = session_ref

            async def send(self, prompt):
                # The manager tears the session down while we are suspended.
                self._ref["s"].closed = True
                await super().send(prompt)

        ref = {}
        conversation = ClosingConversation(ref)
        session = make_session(conversation)
        ref["s"] = session
        agent._sessions.get_or_create = _fixed_session(session)

        events = [e async for e in agent.run(run_input())]
        assert events[-1].type == "RUN_ERROR"
        assert events[-1].code == "CANCELLED"
        assert not session.is_parked, "left a request parked on a dead session"

    async def test_a_live_session_is_unaffected(self):
        agent = AntigravityAgent()
        conversation = FakeConversation([[text_step("fine", done=True)]])
        session = make_session(conversation)
        agent._sessions.get_or_create = _fixed_session(session)
        events = [e async for e in agent.run(run_input())]
        assert events[-1].type == "RUN_FINISHED"
        assert conversation.sent == ["hi"]

    async def test_a_close_mid_stream_is_reported_as_cancelled(self):
        """`yield step` suspends in the SSE writer awaiting the socket.

        A forced close landing there sets `step_iter = None`; resuming without
        a guard raises AttributeError, so a deliberate operator shutdown
        reaches the client as an agent bug with internal exception text.
        """
        agent = AntigravityAgent()
        conversation = FakeConversation(
            [[text_step("one"), text_step("two"), text_step("three", done=True)]]
        )
        session = make_session(conversation)
        agent._sessions._sessions["t1"] = session
        agent._sessions.get_or_create = _fixed_session(session)

        events = []
        async for event in agent.run(run_input()):
            events.append(event)
            # Close while the consumer holds the run mid-stream, exactly as an
            # awaiting SSE writer would.
            if event.type == "TEXT_MESSAGE_CONTENT" and not session.closed:
                await agent._sessions.close("t1")

        types = [e.type for e in events]
        assert types[-1] == "RUN_ERROR"
        assert events[-1].code == "CANCELLED", events[-1].message
        assert "AttributeError" not in (events[-1].message or "")
        assert len([t for t in types if t in ("RUN_FINISHED", "RUN_ERROR")]) == 1

    async def test_the_cancellation_reason_reaches_the_client(self):
        """'session closed' and 'client disconnected' differ operationally."""
        agent = AntigravityAgent()
        session = make_session(FakeConversation([[text_step("x", done=True)]]))
        session.closed = True
        agent._sessions.get_or_create = _fixed_session(session)

        events = [e async for e in agent.run(run_input())]
        assert events[-1].code == "CANCELLED"
        assert "closed while the run was in progress" in events[-1].message
