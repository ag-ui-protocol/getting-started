"""Translator tests, built from the step shapes the real harness emits.

The fixtures mirror what a live `receive_steps()` actually yields (captured
during the P0 spike): the same logical step re-emitted with a growing
`content`, an incremental `content_delta`, and `status` moving ACTIVE -> DONE.
"""

import json

import pytest
from google.antigravity import types as ag_types

from ag_ui_antigravity.event_translator import EventTranslator


def step(**kwargs):
    defaults = dict(
        id="traj:1",
        step_index=1,
        type=ag_types.StepType.TEXT_RESPONSE,
        source=ag_types.StepSource.MODEL,
        target=ag_types.StepTarget.USER,
        status=ag_types.StepStatus.ACTIVE,
    )
    defaults.update(kwargs)
    return ag_types.Step(**defaults)


async def collect(translator, steps):
    events = await collect_open(translator, steps)
    async for event in translator.close():
        events.append(event)
    return events


async def collect_open(translator, steps):
    """Like ``collect`` but leaves the turn's blocks open."""
    events = []
    for s in steps:
        async for event in translator.translate(s):
            events.append(event)
    return events


def types_of(events):
    return [e.type for e in events]


class TestTextStreaming:
    async def test_deltas_become_one_bookended_message(self):
        t = EventTranslator()
        events = await collect(
            t,
            [
                step(content_delta="hello", content="hello"),
                step(content_delta=" from", content="hello from"),
                step(
                    content_delta="",
                    content="hello from ag",
                    status=ag_types.StepStatus.DONE,
                ),
            ],
        )
        assert types_of(events) == [
            "TEXT_MESSAGE_START",
            "TEXT_MESSAGE_CONTENT",
            "TEXT_MESSAGE_CONTENT",
            "TEXT_MESSAGE_END",
        ]

    async def test_streams_delta_not_accumulated_content(self):
        t = EventTranslator()
        events = await collect(
            t,
            [
                step(content_delta="hello", content="hello"),
                step(content_delta=" world", content="hello world"),
            ],
        )
        deltas = [e.delta for e in events if e.type == "TEXT_MESSAGE_CONTENT"]
        assert deltas == ["hello", " world"]

    async def test_one_message_id_per_step_index(self):
        t = EventTranslator()
        events = await collect(
            t,
            [
                step(step_index=1, content_delta="a"),
                step(step_index=1, content_delta="b"),
                step(step_index=2, content_delta="c"),
            ],
        )
        ids = {e.message_id for e in events if e.type == "TEXT_MESSAGE_CONTENT"}
        assert len(ids) == 2

    async def test_user_echo_step_is_never_translated(self):
        """The harness echoes our own prompt back as a source=USER step."""
        t = EventTranslator()
        events = await collect(
            t,
            [
                step(
                    source=ag_types.StepSource.USER,
                    target=ag_types.StepTarget.UNKNOWN,
                    content_delta="what I typed",
                    content="what I typed",
                    status=ag_types.StepStatus.DONE,
                )
            ],
        )
        assert events == []


class TestThinking:
    async def test_thinking_is_bookended_and_closed_before_text(self):
        t = EventTranslator()
        events = await collect(
            t,
            [
                step(type=ag_types.StepType.THINKING, thinking_delta="hmm"),
                step(content_delta="answer"),
            ],
        )
        assert types_of(events) == [
            "THINKING_START",
            "THINKING_TEXT_MESSAGE_START",
            "THINKING_TEXT_MESSAGE_CONTENT",
            "THINKING_TEXT_MESSAGE_END",
            "THINKING_END",
            "TEXT_MESSAGE_START",
            "TEXT_MESSAGE_CONTENT",
            "TEXT_MESSAGE_END",
        ]


    async def test_consecutive_thinking_deltas_share_one_block(self):
        t = EventTranslator()
        events = await collect(
            t,
            [
                step(type=ag_types.StepType.THINKING, thinking_delta="one"),
                step(type=ag_types.StepType.THINKING, thinking_delta=" two"),
            ],
        )
        assert types_of(events) == [
            "THINKING_START",
            "THINKING_TEXT_MESSAGE_START",
            "THINKING_TEXT_MESSAGE_CONTENT",
            "THINKING_TEXT_MESSAGE_CONTENT",
            "THINKING_TEXT_MESSAGE_END",
            "THINKING_END",
        ]

    async def test_thinking_after_text_closes_the_text_block_first(self):
        t = EventTranslator()
        events = await collect(
            t,
            [
                step(content_delta="let me reconsider"),
                step(type=ag_types.StepType.THINKING, thinking_delta="hmm"),
            ],
        )
        order = types_of(events)
        assert order.index("TEXT_MESSAGE_END") < order.index(
            "THINKING_TEXT_MESSAGE_START"
        )

    async def test_reopened_text_after_thinking_gets_a_fresh_message_id(self):
        """The first message was closed for the thinking block and cannot reopen."""
        t = EventTranslator()
        events = await collect(
            t,
            [
                step(step_index=1, content_delta="a"),
                step(step_index=1, type=ag_types.StepType.THINKING, thinking_delta="h"),
                step(step_index=1, content_delta="b"),
            ],
        )
        starts = [e for e in events if e.type == "TEXT_MESSAGE_START"]
        assert len(starts) == 2
        assert starts[0].message_id != starts[1].message_id

    async def test_a_thinking_step_with_no_delta_emits_nothing(self):
        t = EventTranslator()
        events = await collect(t, [step(type=ag_types.StepType.THINKING)])
        assert events == []

    async def test_close_flushes_an_open_thinking_block(self):
        t = EventTranslator()
        events = await collect(
            t, [step(type=ag_types.StepType.THINKING, thinking_delta="unterminated")]
        )
        assert types_of(events)[-2:] == [
            "THINKING_TEXT_MESSAGE_END",
            "THINKING_END",
        ]

    async def test_a_tool_call_closes_an_open_thinking_block_first(self):
        t = EventTranslator()
        call = ag_types.ToolCall(name="view_file", args={"p": "/x"}, id="tc-1")
        events = await collect(
            t,
            [
                step(type=ag_types.StepType.THINKING, thinking_delta="hmm"),
                step(step_index=2, tool_calls=[call]),
            ],
        )
        order = types_of(events)
        assert order.index("THINKING_TEXT_MESSAGE_END") < order.index("TOOL_CALL_START")


class TestToolCalls:
    async def test_a_tool_call_stays_inside_the_assistant_message(self):
        """The call belongs to the message that made it, so that message stays open.

        Closing it first splits one assistant turn into two. CopilotKit's Slack
        renderer clears its "is thinking…" status on the first posted reply and
        latches it, then re-arms the status at TOOL_CALL_END -- so a narration
        posted ahead of the call leaves the indicator spinning long after the
        answer lands. Keeping the message open is also what makes
        `parentMessageId` meaningful.
        """
        t = EventTranslator()
        call = ag_types.ToolCall(name="view_file", args={"path": "/tmp/x"}, id="tc-1")
        events = await collect(
            t,
            [
                step(content_delta="let me look"),
                step(step_index=2, tool_calls=[call]),
                step(
                    step_index=2,
                    tool_calls=[call],
                    status=ag_types.StepStatus.DONE,
                ),
            ],
        )
        order = types_of(events)
        start = order.index("TOOL_CALL_START")
        assert "TEXT_MESSAGE_END" not in order[:start], (
            "the assistant message was closed before the tool call"
        )
        assert "TOOL_CALL_ARGS" in order
        assert order.count("TOOL_CALL_END") == 1

        opened = next(e for e in events if e.type == "TEXT_MESSAGE_START")
        started = next(e for e in events if e.type == "TOOL_CALL_START")
        assert started.parent_message_id == opened.message_id, (
            "the tool call is orphaned from the message that made it"
        )

    async def test_a_tool_call_still_closes_an_open_thinking_block(self):
        """THINKING_* is its own bracketed region and must not wrap the call."""
        t = EventTranslator()
        call = ag_types.ToolCall(name="view_file", args={"path": "/tmp/x"}, id="tc-1")
        events = await collect(
            t,
            [
                step(thinking_delta="hmm"),
                step(step_index=2, tool_calls=[call]),
            ],
        )
        order = types_of(events)
        assert order.index("THINKING_END") < order.index("TOOL_CALL_START")

    async def test_args_are_not_re_emitted_across_step_repeats(self):
        t = EventTranslator()
        call = ag_types.ToolCall(name="view_file", args={"path": "/tmp/x"}, id="tc-1")
        events = await collect(t, [step(tool_calls=[call]), step(tool_calls=[call])])
        assert types_of(events).count("TOOL_CALL_ARGS") == 1

    async def test_builtin_call_without_id_still_gets_stable_identity(self):
        """Built-in tool calls arrive with id=None, so identity is positional."""
        t = EventTranslator()
        call = ag_types.ToolCall(name="list_directory", args={"path": "/"})
        events = await collect(t, [step(tool_calls=[call]), step(tool_calls=[call])])
        starts = [e for e in events if e.type == "TOOL_CALL_START"]
        assert len(starts) == 1
        assert starts[0].tool_call_id

    async def test_suppressed_tool_is_not_emitted(self):
        """Frontend tools are emitted by the UI bridge, not the translator."""
        t = EventTranslator()
        t.suppress_tool("set_theme")
        call = ag_types.ToolCall(name="set_theme", args={"theme": "dark"}, id="tc-9")
        events = await collect(t, [step(tool_calls=[call])])
        assert types_of(events) == []

    async def test_keys_added_at_done_become_the_result(self):
        """Real harness shape: list_directory grows a `results` key at DONE."""
        t = EventTranslator()
        running = ag_types.ToolCall(
            name="list_directory", args={"directory_path": "/ws"}, id="tc-2"
        )
        done = ag_types.ToolCall(
            name="list_directory",
            args={"directory_path": "/ws", "results": [{"name": "note.txt"}]},
            id="tc-2",
        )
        events = await collect(
            t,
            [
                step(tool_calls=[running]),
                step(tool_calls=[done], status=ag_types.StepStatus.DONE),
            ],
        )
        results = [e for e in events if e.type == "TOOL_CALL_RESULT"]
        assert len(results) == 1
        assert "note.txt" in results[0].content

    async def test_tool_that_surfaces_no_result_still_closes(self):
        """view_file adds no keys at DONE; the call must not hang open."""
        t = EventTranslator()
        call = ag_types.ToolCall(
            name="view_file", args={"file_path": "/ws/a.txt"}, id="tc-3"
        )
        events = await collect(
            t,
            [
                step(tool_calls=[call]),
                step(tool_calls=[call], status=ag_types.StepStatus.DONE),
            ],
        )
        types = types_of(events)
        assert types.count("TOOL_CALL_END") == 1
        results = [e for e in events if e.type == "TOOL_CALL_RESULT"]
        assert len(results) == 1
        assert "without returning any output" in results[0].content


    async def test_builtin_calls_can_be_hidden_from_the_client(self):
        t = EventTranslator(emit_builtin_tool_calls=False)
        events = await collect(
            t,
            [
                step(
                    tool_calls=[
                        ag_types.ToolCall(name="view_file", args={"file_path": "/x"})
                    ]
                )
            ],
        )
        assert events == []

    async def test_hiding_builtins_still_emits_custom_tool_calls(self):
        t = EventTranslator(emit_builtin_tool_calls=False)
        events = await collect(
            t,
            [step(tool_calls=[ag_types.ToolCall(name="my_tool", args={}, id="tc-1")])],
        )
        assert "TOOL_CALL_START" in types_of(events)

    async def test_unserializable_args_do_not_break_the_stream(self):
        """A tool arg the harness surfaces as a non-JSON value must not kill the run."""
        t = EventTranslator()
        call = ag_types.ToolCall(name="my_tool", args={"blob": object()}, id="tc-1")
        events = await collect(t, [step(tool_calls=[call])])
        args = [e for e in events if e.type == "TOOL_CALL_ARGS"][0]
        assert "_unserializable" in args.delta

    async def test_args_deltas_always_concatenate_into_one_json_document(self):
        """The client does `function.arguments += delta`, so everything emitted
        for one call must join into exactly ONE parseable JSON document.

        A grown JSON object is not a string extension of the smaller one (the
        closing brace moves), so re-sending the whole dict on any change gives
        the client `{...}{...}` -- unparseable, and for a built-in it also
        leaks the tool's result into its arguments.
        """
        t = EventTranslator()
        running = ag_types.ToolCall(
            name="list_directory", args={"directory_path": "/ws"}, id="tc-1"
        )
        grown = ag_types.ToolCall(
            name="list_directory",
            args={"directory_path": "/ws", "results": [{"name": "secret.txt"}]},
            id="tc-1",
        )
        events = await collect(
            t,
            [
                step(tool_calls=[running]),
                step(tool_calls=[running]),
                step(tool_calls=[grown], status=ag_types.StepStatus.DONE),
            ],
        )

        buffer = "".join(
            e.delta for e in events if e.type == "TOOL_CALL_ARGS"
        )
        parsed = json.loads(buffer)  # would raise on `{...}{...}`
        assert parsed == {"directory_path": "/ws"}
        assert "results" not in parsed, "the result leaked into the arguments"

        result = [e for e in events if e.type == "TOOL_CALL_RESULT"][0]
        assert "secret.txt" in result.content

    async def test_a_shape_change_does_not_corrupt_the_buffer(self):
        t = EventTranslator()
        events = await collect(
            t,
            [
                step(
                    tool_calls=[
                        ag_types.ToolCall(name="t", args={"a": 1, "b": 2}, id="tc-1")
                    ]
                ),
                step(tool_calls=[ag_types.ToolCall(name="t", args={"z": 9}, id="tc-1")]),
            ],
        )
        buffer = "".join(e.delta for e in events if e.type == "TOOL_CALL_ARGS")
        assert json.loads(buffer) == {"a": 1, "b": 2}

    async def test_empty_args_still_produce_a_parseable_buffer(self):
        t = EventTranslator()
        events = await collect(
            t, [step(tool_calls=[ag_types.ToolCall(name="t", args={}, id="tc-1")])]
        )
        buffer = "".join(e.delta for e in events if e.type == "TOOL_CALL_ARGS")
        assert json.loads(buffer) == {}

    async def test_several_keys_added_at_done_are_returned_as_one_json_result(self):
        t = EventTranslator()
        running = ag_types.ToolCall(name="search_web", args={"q": "x"}, id="tc-1")
        done = ag_types.ToolCall(
            name="search_web",
            args={"q": "x", "results": ["a"], "count": 1},
            id="tc-1",
        )
        events = await collect(
            t,
            [
                step(tool_calls=[running]),
                step(tool_calls=[done], status=ag_types.StepStatus.DONE),
            ],
        )
        content = [e for e in events if e.type == "TOOL_CALL_RESULT"][0].content
        assert json.loads(content) == {"results": ["a"], "count": 1}


class TestErrorSteps:
    async def test_an_error_step_is_not_translated(self):
        """Platform errors surface as exceptions; an ERROR step is not output."""
        t = EventTranslator()
        events = await collect(
            t,
            [
                step(
                    content_delta="half an answer",
                    status=ag_types.StepStatus.ERROR,
                )
            ],
        )
        assert events == []

    async def test_an_error_step_does_not_disturb_an_open_block(self):
        t = EventTranslator()
        events = await collect(
            t,
            [
                step(content_delta="hello"),
                step(step_index=2, content_delta="x", status=ag_types.StepStatus.ERROR),
                step(content_delta=" world"),
            ],
        )
        deltas = [e.delta for e in events if e.type == "TEXT_MESSAGE_CONTENT"]
        assert deltas == ["hello", " world"]
        assert types_of(events).count("TEXT_MESSAGE_START") == 1


class TestStructuredOutput:
    async def test_finish_structured_output_becomes_state_snapshot(self):
        t = EventTranslator()
        events = await collect(
            t,
            [
                step(
                    type=ag_types.StepType.FINISH,
                    structured_output={"steps": ["a", "b"]},
                    status=ag_types.StepStatus.DONE,
                )
            ],
        )
        snapshots = [e for e in events if e.type == "STATE_SNAPSHOT"]
        assert len(snapshots) == 1
        assert snapshots[0].snapshot == {"steps": ["a", "b"]}

    async def test_custom_mode_emits_custom_event(self):
        t = EventTranslator(structured_output_as="custom")
        events = await collect(
            t,
            [
                step(
                    type=ag_types.StepType.FINISH,
                    structured_output={"x": 1},
                    status=ag_types.StepStatus.DONE,
                )
            ],
        )
        customs = [e for e in events if e.type == "CUSTOM"]
        assert len(customs) == 1
        assert customs[0].value == {"x": 1}

    async def test_an_open_text_block_is_closed_before_the_state_snapshot(self):
        t = EventTranslator()
        events = await collect(
            t,
            [
                step(content_delta="here you go"),
                step(
                    type=ag_types.StepType.FINISH,
                    structured_output={"x": 1},
                    status=ag_types.StepStatus.DONE,
                ),
            ],
        )
        order = types_of(events)
        assert order.index("TEXT_MESSAGE_END") < order.index("STATE_SNAPSHOT")

    async def test_a_redelivered_finish_step_does_not_repeat_the_snapshot(self):
        t = EventTranslator()
        finish = step(
            type=ag_types.StepType.FINISH,
            structured_output={"x": 1},
            status=ag_types.StepStatus.DONE,
        )
        events = await collect(t, [finish, finish])
        assert types_of(events).count("STATE_SNAPSHOT") == 1

    async def test_scalar_structured_output_is_wrapped(self):
        t = EventTranslator()
        events = await collect(
            t,
            [
                step(
                    type=ag_types.StepType.FINISH,
                    structured_output="done",
                    status=ag_types.StepStatus.DONE,
                )
            ],
        )
        snap = [e for e in events if e.type == "STATE_SNAPSHOT"][0]
        assert snap.snapshot == {"structured_output": "done"}


class TestClose:
    async def test_close_flushes_open_text_block(self):
        t = EventTranslator()
        events = await collect(t, [step(content_delta="unterminated")])
        assert types_of(events)[-1] == "TEXT_MESSAGE_END"

    async def test_close_flushes_open_tool_call(self):
        t = EventTranslator()
        call = ag_types.ToolCall(name="run_command", args={"cmd": "ls"}, id="tc-3")
        events = await collect(t, [step(tool_calls=[call])])
        assert types_of(events)[-1] == "TOOL_CALL_END"


class TestSubagents:
    async def test_subagent_invocation_brackets_a_step(self):
        t = EventTranslator()
        running = ag_types.ToolCall(
            name="start_subagent", args={"name": "researcher"}, id="sa-1"
        )
        events = await collect(
            t,
            [
                step(tool_calls=[running]),
                step(tool_calls=[running], status=ag_types.StepStatus.DONE),
            ],
        )
        types = types_of(events)
        assert types.index("STEP_STARTED") < types.index("STEP_FINISHED")
        started = [e for e in events if e.type == "STEP_STARTED"][0]
        assert started.step_name == "researcher"

    async def test_unnamed_subagent_falls_back_to_trajectory_id(self):
        t = EventTranslator()
        call = ag_types.ToolCall(name="start_subagent", args={}, id="sa-2")
        events = await collect(t, [step(id="traj-abc:3", tool_calls=[call])])
        started = [e for e in events if e.type == "STEP_STARTED"][0]
        assert started.step_name == "subagent:traj-abc"

    async def test_close_flushes_an_open_subagent_step(self):
        t = EventTranslator()
        call = ag_types.ToolCall(name="start_subagent", args={"name": "x"}, id="sa-3")
        events = await collect(t, [step(tool_calls=[call])])
        assert types_of(events)[-1] == "STEP_FINISHED"

    async def test_an_open_text_block_is_closed_before_step_started(self):
        t = EventTranslator()
        call = ag_types.ToolCall(name="start_subagent", args={"name": "x"}, id="sa-9")
        events = await collect(
            t,
            [
                step(content_delta="delegating this"),
                step(step_index=2, tool_calls=[call]),
            ],
        )
        order = types_of(events)
        assert order.index("TEXT_MESSAGE_END") < order.index("STEP_STARTED")

    async def test_an_open_text_block_is_closed_before_step_finished(self):
        t = EventTranslator()
        call = ag_types.ToolCall(name="start_subagent", args={"name": "x"}, id="sa-4")
        await collect_open(t, [step(tool_calls=[call])])
        events = []
        async for event in t.translate(step(step_index=2, content_delta="summary")):
            events.append(event)
        async for event in t.close_subagent_step("x"):
            events.append(event)
        order = types_of(events)
        assert order.index("TEXT_MESSAGE_END") < order.index("STEP_FINISHED")

    async def test_closing_a_subagent_step_that_never_opened_emits_nothing(self):
        t = EventTranslator()
        assert [e async for e in t.close_subagent_step("never-started")] == []

    async def test_a_subagent_step_is_opened_only_once(self):
        t = EventTranslator()
        call = ag_types.ToolCall(name="start_subagent", args={"name": "x"}, id="sa-5")
        events = await collect(t, [step(tool_calls=[call]), step(tool_calls=[call])])
        assert types_of(events).count("STEP_STARTED") == 1

    async def test_an_unnamed_subagent_without_a_trajectory_falls_back_to_the_index(self):
        t = EventTranslator()
        call = ag_types.ToolCall(name="start_subagent", args={}, id="sa-6")
        events = await collect(t, [step(id="", step_index=7, tool_calls=[call])])
        started = [e for e in events if e.type == "STEP_STARTED"][0]
        assert started.step_name == "subagent:7"

    async def test_a_non_string_name_arg_falls_back_to_the_trajectory_id(self):
        t = EventTranslator()
        call = ag_types.ToolCall(name="start_subagent", args={"name": 7}, id="sa-7")
        events = await collect(t, [step(id="traj-z:1", tool_calls=[call])])
        started = [e for e in events if e.type == "STEP_STARTED"][0]
        assert started.step_name == "subagent:traj-z"

    async def test_a_later_alias_is_used_when_name_is_absent(self):
        t = EventTranslator()
        call = ag_types.ToolCall(
            name="start_subagent", args={"agent_name": "planner"}, id="sa-8"
        )
        events = await collect(t, [step(tool_calls=[call])])
        assert [e for e in events if e.type == "STEP_STARTED"][0].step_name == "planner"


class TestTurnSpanningRedelivery:
    """A turn that parks spans several AG-UI runs; the harness re-delivers the
    steps it already sent, and translating them twice makes the client re-run
    the same tool. The translator is turn-scoped precisely to prevent that."""

    async def test_close_emits_the_real_tool_call_id_not_the_internal_key(self):
        t = EventTranslator()
        call = ag_types.ToolCall(name="search_web", args={"q": "x"}, id="tc-real")
        events = await collect(t, [step(tool_calls=[call])])
        end = [e for e in events if e.type == "TOOL_CALL_END"][0]
        start = [e for e in events if e.type == "TOOL_CALL_START"][0]
        assert end.tool_call_id == "tc-real"
        assert end.tool_call_id == start.tool_call_id

    async def test_a_call_flushed_at_a_run_boundary_still_delivers_its_result(self):
        """close() bookends a still-running call so the run's stream is valid.

        That must not be mistaken for completion: the harness delivers the
        result on a later run of the same turn, and dropping it leaves the
        client's tool card without output while the model got the full text.
        """
        t = EventTranslator()
        running = ag_types.ToolCall(
            name="list_directory", args={"directory_path": "/ws"}, id="tc-1"
        )

        # run 1: the call opens, then the run ends parked -> close() flushes it.
        run1 = await collect(t, [step(tool_calls=[running])])
        assert types_of(run1) == [
            "TOOL_CALL_START",
            "TOOL_CALL_ARGS",
            "TOOL_CALL_END",
        ]

        # run 2: a redelivered ACTIVE adds nothing...
        run2 = []
        async for event in t.translate(step(tool_calls=[running])):
            run2.append(event)
        assert run2 == [], types_of(run2)

        # ...but the real DONE carries the result through, without a second
        # START (the client already has the card) or a second END.
        done = ag_types.ToolCall(
            name="list_directory",
            args={"directory_path": "/ws", "results": [{"name": "note.txt"}]},
            id="tc-1",
        )
        async for event in t.translate(
            step(tool_calls=[done], status=ag_types.StepStatus.DONE)
        ):
            run2.append(event)
        assert types_of(run2) == ["TOOL_CALL_RESULT"], types_of(run2)
        assert "note.txt" in run2[0].content

        # And a redelivery after genuine completion is still ignored.
        after = []
        async for event in t.translate(step(tool_calls=[done])):
            after.append(event)
        assert after == []

    async def test_redelivered_completed_call_is_ignored(self):
        t = EventTranslator()
        call = ag_types.ToolCall(name="search_web", args={"q": "x"}, id="tc-2")
        first = await collect(
            t,
            [
                step(tool_calls=[call]),
                step(tool_calls=[call], status=ag_types.StepStatus.DONE),
            ],
        )
        assert types_of(first).count("TOOL_CALL_START") == 1

        again = []
        async for event in t.translate(step(tool_calls=[call])):
            again.append(event)
        assert again == []

    async def test_redelivered_text_step_is_not_replayed(self):
        t = EventTranslator()
        await collect(
            t,
            [
                step(content_delta="hello", content="hello"),
                step(content_delta=" world", content="hello world",
                     status=ag_types.StepStatus.DONE),
            ],
        )
        replay = []
        async for event in t.translate(step(content_delta="hello", content="hello")):
            replay.append(event)
        assert replay == []

    async def test_reopened_step_gets_a_fresh_message_id(self):
        """A message closed at a run boundary can never be reopened."""
        t = EventTranslator()
        run1 = await collect(t, [step(content_delta="partial")])
        first_id = [e for e in run1 if e.type == "TEXT_MESSAGE_START"][0].message_id

        run2 = []
        async for event in t.translate(step(content_delta=" more")):
            run2.append(event)
        second_id = [e for e in run2 if e.type == "TEXT_MESSAGE_START"][0].message_id
        assert second_id != first_id


class TestSubagentRedelivery:
    """A subagent bracket must survive the same redelivery the tool calls do,
    and must wrap the call rather than closing before it."""

    def _call(self):
        return ag_types.ToolCall(
            name="start_subagent", args={"name": "researcher"}, id="sa-r"
        )

    async def test_bracket_closes_after_the_call_it_wraps(self):
        t = EventTranslator()
        call = self._call()
        events = await collect(
            t,
            [
                step(tool_calls=[call]),
                step(tool_calls=[call], status=ag_types.StepStatus.DONE),
            ],
        )
        order = types_of(events)
        assert order.index("STEP_STARTED") < order.index("TOOL_CALL_START")
        assert order.index("TOOL_CALL_END") < order.index("STEP_FINISHED")
        assert order.index("TOOL_CALL_RESULT") < order.index("STEP_FINISHED")

    async def test_redelivered_subagent_step_emits_nothing(self):
        t = EventTranslator()
        call = self._call()
        await collect(
            t,
            [
                step(tool_calls=[call]),
                step(tool_calls=[call], status=ag_types.StepStatus.DONE),
            ],
        )
        replay = []
        async for event in t.translate(step(tool_calls=[call])):
            replay.append(event)
        assert replay == [], types_of(replay)

    async def test_bracket_is_emitted_even_when_builtin_cards_are_suppressed(self):
        t = EventTranslator(emit_builtin_tool_calls=False)
        call = self._call()
        events = await collect(
            t,
            [
                step(tool_calls=[call]),
                step(tool_calls=[call], status=ag_types.StepStatus.DONE),
            ],
        )
        assert types_of(events) == ["STEP_STARTED", "STEP_FINISHED"]


class TestThinkingBracketing:
    """@ag-ui/client's verifyEvents is unconditionally in AbstractAgent's
    pipeline and rejects a THINKING_TEXT_MESSAGE_START with no thinking step in
    progress -- which aborts the entire run, not just the thinking block."""

    def _thinking(self, delta, **kw):
        return step(type=ag_types.StepType.THINKING, thinking_delta=delta, **kw)

    async def test_thinking_messages_are_wrapped_in_a_thinking_step(self):
        t = EventTranslator()
        events = await collect(t, [self._thinking("hmm"), self._thinking(" ok")])
        assert types_of(events) == [
            "THINKING_START",
            "THINKING_TEXT_MESSAGE_START",
            "THINKING_TEXT_MESSAGE_CONTENT",
            "THINKING_TEXT_MESSAGE_CONTENT",
            "THINKING_TEXT_MESSAGE_END",
            "THINKING_END",
        ]

    async def test_a_tool_call_closes_the_thinking_step_first(self):
        t = EventTranslator()
        call = ag_types.ToolCall(name="view_file", args={}, id="tc-1")
        events = await collect(
            t, [self._thinking("plan"), step(step_index=2, tool_calls=[call])]
        )
        order = types_of(events)
        assert order.index("THINKING_END") < order.index("TOOL_CALL_START")
        assert order.index("THINKING_TEXT_MESSAGE_END") < order.index("THINKING_END")

    async def test_every_thinking_step_is_balanced(self):
        """Mirrors verifyEvents' state machine: never two STARTs, never an END
        without a START."""
        t = EventTranslator()
        call = ag_types.ToolCall(name="view_file", args={}, id="tc-2")
        events = await collect(
            t,
            [
                self._thinking("a"),
                step(content_delta="answer"),
                self._thinking("b", step_index=3),
                step(step_index=4, tool_calls=[call]),
                self._thinking("c", step_index=5),
            ],
        )
        depth = 0
        for kind in types_of(events):
            if kind == "THINKING_START":
                assert depth == 0, "nested THINKING_START"
                depth += 1
            elif kind == "THINKING_END":
                assert depth == 1, "THINKING_END without a START"
                depth -= 1
        assert depth == 0, "unclosed thinking step at end of run"


class TestBuiltinFailures:
    """TOOL_CALL_RESULT has no error field, so a failure has to say so in
    `content`. An empty string is indistinguishable from a tool that
    legitimately produced nothing, and the client renders it as success."""

    async def test_a_reported_error_is_named_in_the_result(self):
        t = EventTranslator()
        running = ag_types.ToolCall(
            name="run_command", args={"command": "rm /nope"}, id="tc-1"
        )
        failed = ag_types.ToolCall(
            name="run_command",
            args={"command": "rm /nope", "error": "permission denied"},
            id="tc-1",
        )
        events = await collect(
            t,
            [
                step(tool_calls=[running]),
                step(tool_calls=[failed], status=ag_types.StepStatus.DONE),
            ],
        )
        content = [e for e in events if e.type == "TOOL_CALL_RESULT"][0].content
        assert "error executing run_command" in content
        assert "permission denied" in content

    async def test_no_output_is_distinguishable_from_a_failure(self):
        t = EventTranslator()
        call = ag_types.ToolCall(name="view_file", args={"file_path": "/a"}, id="tc-2")
        events = await collect(
            t,
            [
                step(tool_calls=[call]),
                step(tool_calls=[call], status=ag_types.StepStatus.DONE),
            ],
        )
        content = [e for e in events if e.type == "TOOL_CALL_RESULT"][0].content
        assert content, "an empty result reads as success to the client"
        assert "view_file" in content
        assert "error" not in content.lower()

    async def test_a_real_result_is_unchanged(self):
        t = EventTranslator()
        running = ag_types.ToolCall(name="list_directory", args={"p": "/"}, id="tc-3")
        done = ag_types.ToolCall(
            name="list_directory", args={"p": "/", "results": ["a.txt"]}, id="tc-3"
        )
        events = await collect(
            t,
            [
                step(tool_calls=[running]),
                step(tool_calls=[done], status=ag_types.StepStatus.DONE),
            ],
        )
        content = [e for e in events if e.type == "TOOL_CALL_RESULT"][0].content
        assert "a.txt" in content
        assert "error" not in content.lower()
