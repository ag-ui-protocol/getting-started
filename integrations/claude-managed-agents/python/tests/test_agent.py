"""Ports of the TypeScript `agent.test.ts` assertions, plus lifecycle guards."""

import asyncio
from typing import Any

from ag_ui.core import RunAgentInput, RunErrorEvent, RunFinishedEvent

from ag_ui_claude_managed_agents import (
    BackendTool,
    InMemorySessionStore,
    ManagedAgentsAgent,
    SessionRecord,
)

from ag_ui_claude_managed_agents.types import SessionStore

from .fake_client import FakeAPIError, FakeClient
from .fake_store import RecordingSessionStore

IDLE_END_TURN = {
    "type": "session.status_idle",
    "id": "idle_1",
    "stop_reason": {"type": "end_turn"},
}

SESSION_KEY = "7:agent_1|0:|5:env_1|0:|thread_1"
"""The key the store and the busy gate share: scoped to the managed agent, not
the bare (client-supplied) thread id."""


def base_input(**overrides: Any) -> RunAgentInput:
    data: dict[str, Any] = {
        "thread_id": "thread_1",
        "run_id": "run_1",
        "state": {},
        "messages": [{"id": "u1", "role": "user", "content": "Hello"}],
        "tools": [],
        "context": [],
        "forwarded_props": {},
    }
    data.update(overrides)
    return RunAgentInput(**data)


async def collect(agent: ManagedAgentsAgent, run_input: RunAgentInput) -> list[Any]:
    return [event async for event in agent.run(run_input)]


def types(events: list[Any]) -> list[str]:
    return [event.type.value for event in events]


def new_agent(
    fake: FakeClient,
    store: SessionStore | None = None,
    managed_agent_id_override: str = "agent_1",
    environment_id: str = "env_1",
    **kwargs: Any,
) -> ManagedAgentsAgent:
    return ManagedAgentsAgent(
        managed_agent_id=managed_agent_id_override,
        environment_id=environment_id,
        client=fake,  # type: ignore[arg-type]
        session_store=store,
        **kwargs,
    )


async def test_creates_session_for_new_thread_and_streams_reply():
    fake = FakeClient(
        streams=[
            [
                {
                    "type": "agent.message",
                    "id": "msg_1",
                    "content": [{"type": "text", "text": "Hi!"}],
                },
                IDLE_END_TURN,
            ]
        ]
    )
    events = await collect(new_agent(fake), base_input())

    assert fake.create_calls == [
        {
            "agent": {"type": "agent", "id": "agent_1"},
            "environment_id": "env_1",
            "title": "AG-UI thread thread_1",
        }
    ]
    assert types(events) == [
        "RUN_STARTED",
        "STATE_SNAPSHOT",
        "CUSTOM",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
        "RUN_FINISHED",
    ]
    assert events[2].name == "managed_agents.session"
    assert events[2].value == {"sessionId": "sesn_1", "threadId": "thread_1"}
    assert fake.sent[0]["events"] == [
        {"type": "user.message", "content": [{"type": "text", "text": "Hello"}]}
    ]


async def test_pins_agent_version_and_custom_title_when_configured():
    fake = FakeClient(streams=[[IDLE_END_TURN]])
    agent = new_agent(
        fake, agent_version=3, session_title=lambda thread_id: f"Chat {thread_id}"
    )
    await collect(agent, base_input())
    assert fake.create_calls[0]["agent"] == {
        "type": "agent",
        "id": "agent_1",
        "version": 3,
    }
    assert fake.create_calls[0]["title"] == "Chat thread_1"


async def test_attaches_configured_vault_ids_when_creating_a_session():
    fake = FakeClient(streams=[[IDLE_END_TURN], [IDLE_END_TURN]])
    await collect(
        new_agent(fake, vault_ids=["vlt_1", "vlt_2"]), base_input()
    )
    assert fake.create_calls[0]["vault_ids"] == ["vlt_1", "vlt_2"]

    # Omitted entirely when none are configured, so the field is not sent empty.
    await collect(new_agent(fake), base_input(thread_id="thread_2"))
    assert "vault_ids" not in fake.create_calls[1]


async def test_reuses_session_on_next_run_and_sends_only_new_message():
    fake = FakeClient(
        streams=[
            [
                {
                    "type": "agent.message",
                    "id": "msg_1",
                    "content": [{"type": "text", "text": "one"}],
                },
                IDLE_END_TURN,
            ],
            [
                {
                    "type": "agent.message",
                    "id": "msg_2",
                    "content": [{"type": "text", "text": "two"}],
                },
                IDLE_END_TURN,
            ],
        ]
    )
    store = InMemorySessionStore()
    await collect(new_agent(fake, store), base_input())
    await collect(
        new_agent(fake, store),
        base_input(
            run_id="run_2",
            messages=[
                {"id": "u1", "role": "user", "content": "Hello"},
                {"id": "a1", "role": "assistant", "content": "one"},
                {"id": "u2", "role": "user", "content": "Follow-up"},
            ],
        ),
    )

    assert len(fake.create_calls) == 1
    assert fake.sent[1]["events"] == [
        {"type": "user.message", "content": [{"type": "text", "text": "Follow-up"}]}
    ]


async def test_dedupes_registered_tools_against_the_agents_own_custom_tools():
    """A custom tool already defined on the managed agent must not be sent
    twice when a frontend tool of the same name is registered: the frontend
    definition wins and the agent's copy is dropped."""
    fake = FakeClient(
        streams=[[IDLE_END_TURN]],
        agent_tools=[
            {"type": "agent_toolset_20260401", "configs": [], "default_config": {}},
            {
                "type": "custom",
                "name": "show_chart",
                "description": "Agent's own copy",
                "input_schema": {"type": "object", "properties": {}},
            },
        ],
    )
    await collect(
        new_agent(fake),
        base_input(
            tools=[
                {
                    "name": "show_chart",
                    "description": "Render a chart",
                    "parameters": {"type": "object"},
                }
            ]
        ),
    )

    tools = fake.create_calls[0]["agent"]["tools"]
    assert [tool.get("name") for tool in tools if tool.get("type") == "custom"] == [
        "show_chart"
    ]
    assert tools[-1]["description"] == "Render a chart"


async def test_registers_frontend_tools_as_custom_tools_when_creating_session():
    fake = FakeClient(
        streams=[[IDLE_END_TURN]],
        agent_tools=[
            {"type": "agent_toolset_20260401", "configs": [], "default_config": {}}
        ],
    )
    await collect(
        new_agent(fake),
        base_input(
            tools=[
                {
                    "name": "show_chart",
                    "description": "Render a chart",
                    "parameters": {
                        "type": "object",
                        "properties": {"title": {"type": "string"}},
                    },
                }
            ]
        ),
    )

    assert fake.create_calls[0]["agent"] == {
        "type": "agent_with_overrides",
        "id": "agent_1",
        "tools": [
            {"type": "agent_toolset_20260401", "configs": [], "default_config": {}},
            {
                "type": "custom",
                "name": "show_chart",
                "description": "Render a chart",
                "input_schema": {
                    "type": "object",
                    "properties": {"title": {"type": "string"}},
                },
            },
        ],
    }


async def test_registers_backend_tools_and_normalizes_names_with_frontend_winning():
    fake = FakeClient(streams=[[IDLE_END_TURN]], agent_tools=[])
    backend = BackendTool(
        name="lookup docs",
        description="Backend lookup",
        parameters={},
        handler=lambda _i: "x",
    )
    agent = new_agent(fake, backend_tools=[backend])
    await collect(
        agent,
        base_input(
            tools=[
                {
                    "name": "lookup docs",
                    "description": "Frontend lookup",
                    "parameters": {"type": "object"},
                }
            ]
        ),
    )

    tools = fake.create_calls[0]["agent"]["tools"]
    assert tools == [
        {
            "type": "custom",
            "name": "lookup_docs",
            "description": "Frontend lookup",
            "input_schema": {"type": "object"},
        }
    ]


async def test_round_trips_frontend_tool_park_then_resume_with_client_result():
    fake = FakeClient(
        streams=[
            [
                {
                    "type": "agent.custom_tool_use",
                    "id": "ctu_1",
                    "name": "show_chart",
                    "input": {"title": "Sales"},
                },
                {
                    "type": "session.status_idle",
                    "id": "idle_1",
                    "stop_reason": {"type": "requires_action", "event_ids": ["ctu_1"]},
                },
            ],
            [
                {
                    "type": "agent.message",
                    "id": "msg_1",
                    "content": [{"type": "text", "text": "Chart shown."}],
                },
                IDLE_END_TURN,
            ],
        ]
    )
    store = InMemorySessionStore()
    tools = [
        {
            "name": "show_chart",
            "description": "Render a chart",
            "parameters": {"type": "object"},
        }
    ]

    first = await collect(new_agent(fake, store), base_input(tools=tools))
    assert types(first) == [
        "RUN_STARTED",
        "STATE_SNAPSHOT",
        "CUSTOM",
        "TOOL_CALL_START",
        "TOOL_CALL_ARGS",
        "TOOL_CALL_END",
        "RUN_FINISHED",
    ]
    assert store.get(SESSION_KEY).pending_client_tool_use_ids == ["ctu_1"]

    second = await collect(
        new_agent(fake, store),
        base_input(
            run_id="run_2",
            tools=tools,
            messages=[
                {"id": "u1", "role": "user", "content": "Hello"},
                {
                    "id": "t1",
                    "role": "tool",
                    "toolCallId": "ctu_1",
                    "content": "rendered",
                },
            ],
        ),
    )

    assert fake.sent[1]["events"] == [
        {
            "type": "user.custom_tool_result",
            "custom_tool_use_id": "ctu_1",
            "content": [{"type": "text", "text": "rendered"}],
            "is_error": False,
        }
    ]
    assert "TEXT_MESSAGE_CONTENT" in types(second)
    assert types(second)[-1] == "RUN_FINISHED"
    assert store.get(SESSION_KEY).pending_client_tool_use_ids == []


async def test_forwards_tool_message_error_flag():
    fake = FakeClient(streams=[[IDLE_END_TURN]])
    store = InMemorySessionStore()
    store.set(
        SESSION_KEY,
        SessionRecord(
            session_id="sesn_1",
            tool_names=[],
            pending_client_tool_use_ids=["ctu_1"],
            last_user_message_id="u1",
        ),
    )
    await collect(
        new_agent(fake, store),
        base_input(
            messages=[
                {"id": "u1", "role": "user", "content": "Hello"},
                {
                    "id": "t1",
                    "role": "tool",
                    "toolCallId": "ctu_1",
                    "content": "boom",
                    "error": "failed",
                },
            ]
        ),
    )
    assert fake.sent[0]["events"] == [
        {
            "type": "user.custom_tool_result",
            "custom_tool_use_id": "ctu_1",
            "content": [{"type": "text", "text": "boom\nfailed"}],
            "is_error": True,
        }
    ]


async def test_stays_parked_when_some_tool_calls_remain_unanswered():
    fake = FakeClient(streams=[])
    store = InMemorySessionStore()
    store.set(
        SESSION_KEY,
        SessionRecord(
            session_id="sesn_1",
            tool_names=[],
            pending_client_tool_use_ids=["ctu_1", "ctu_2"],
            last_user_message_id="u1",
        ),
    )
    events = await collect(
        new_agent(fake, store),
        base_input(
            messages=[
                {"id": "u1", "role": "user", "content": "Hello"},
                {"id": "t1", "role": "tool", "toolCallId": "ctu_1", "content": "done"},
            ]
        ),
    )

    # The answered call is posted, the run finishes without streaming, and
    # the unanswered call stays pending.
    assert fake.sent[0]["events"] == [
        {
            "type": "user.custom_tool_result",
            "custom_tool_use_id": "ctu_1",
            "content": [{"type": "text", "text": "done"}],
            "is_error": False,
        }
    ]
    assert fake.stream_calls == []
    assert types(events)[-1] == "RUN_FINISHED"
    assert store.get(SESSION_KEY).pending_client_tool_use_ids == ["ctu_2"]


async def test_default_session_store_persists_across_runs():
    fake = FakeClient(
        streams=[
            [
                {
                    "type": "agent.custom_tool_use",
                    "id": "ctu_1",
                    "name": "show_chart",
                    "input": {},
                },
                {
                    "type": "session.status_idle",
                    "id": "idle_1",
                    "stop_reason": {"type": "requires_action", "event_ids": ["ctu_1"]},
                },
            ],
            [
                {
                    "type": "agent.message",
                    "id": "msg_1",
                    "content": [{"type": "text", "text": "Done."}],
                },
                IDLE_END_TURN,
            ],
        ]
    )
    # No session_store passed: the default in-memory store must survive between runs.
    agent = ManagedAgentsAgent(
        managed_agent_id="agent_1", environment_id="env_1", client=fake
    )  # type: ignore[arg-type]
    tools = [
        {
            "name": "show_chart",
            "description": "Render a chart",
            "parameters": {"type": "object"},
        }
    ]

    await collect(agent, base_input(tools=tools))
    await collect(
        agent,
        base_input(
            run_id="run_2",
            tools=tools,
            messages=[
                {"id": "u1", "role": "user", "content": "Hello"},
                {
                    "id": "t1",
                    "role": "tool",
                    "toolCallId": "ctu_1",
                    "content": "rendered",
                },
            ],
        ),
    )

    assert len(fake.create_calls) == 1
    assert fake.sent[1]["events"] == [
        {
            "type": "user.custom_tool_result",
            "custom_tool_use_id": "ctu_1",
            "content": [{"type": "text", "text": "rendered"}],
            "is_error": False,
        }
    ]


async def test_forwards_every_undelivered_user_message_in_order():
    fake = FakeClient(streams=[[IDLE_END_TURN]])
    store = InMemorySessionStore()
    store.set(
        SESSION_KEY,
        SessionRecord(
            session_id="sesn_1",
            tool_names=[],
            pending_client_tool_use_ids=[],
            last_user_message_id="u1",
        ),
    )

    await collect(
        new_agent(fake, store),
        base_input(
            messages=[
                {"id": "u1", "role": "user", "content": "delivered"},
                {"id": "u2", "role": "user", "content": "second"},
                {"id": "u3", "role": "user", "content": "third"},
            ]
        ),
    )

    assert fake.sent[0]["events"] == [
        {"type": "user.message", "content": [{"type": "text", "text": "second"}]},
        {"type": "user.message", "content": [{"type": "text", "text": "third"}]},
    ]
    assert store.get(SESSION_KEY).last_user_message_id == "u3"


async def test_extracts_text_from_multimodal_user_content():
    fake = FakeClient(streams=[[IDLE_END_TURN]])
    await collect(
        new_agent(fake),
        base_input(
            messages=[
                {
                    "id": "u1",
                    "role": "user",
                    "content": [{"type": "text", "text": "Look here"}],
                }
            ]
        ),
    )
    assert fake.sent[0]["events"] == [
        {"type": "user.message", "content": [{"type": "text", "text": "Look here"}]}
    ]


async def test_abandons_parked_tool_calls_when_user_sends_new_message_instead():
    fake = FakeClient(
        streams=[
            [
                {
                    "type": "agent.message",
                    "id": "msg_1",
                    "content": [{"type": "text", "text": "Moving on."}],
                },
                IDLE_END_TURN,
            ]
        ]
    )
    store = InMemorySessionStore()
    store.set(
        SESSION_KEY,
        SessionRecord(
            session_id="sesn_1",
            tool_names=[],
            pending_client_tool_use_ids=["ctu_1"],
            last_user_message_id="u1",
        ),
    )

    events = await collect(
        new_agent(fake, store),
        base_input(
            messages=[
                {"id": "u1", "role": "user", "content": "old"},
                {"id": "u2", "role": "user", "content": "never mind"},
            ]
        ),
    )

    # Tool results go first (resuming the parked session), then the message,
    # as two separate sends: the API rejects a user.message in the same batch
    # as the results while the session is still parked.
    assert fake.sent[0]["events"] == [
        {
            "type": "user.custom_tool_result",
            "custom_tool_use_id": "ctu_1",
            "content": [
                {
                    "type": "text",
                    "text": "The user did not provide a result for this tool call.",
                }
            ],
            "is_error": True,
        }
    ]
    assert fake.sent[1]["events"] == [
        {"type": "user.message", "content": [{"type": "text", "text": "never mind"}]}
    ]
    assert types(events)[-1] == "RUN_FINISHED"
    record = store.get(SESSION_KEY)
    assert record.pending_client_tool_use_ids == []
    assert record.last_user_message_id == "u2"


async def test_errors_when_run_has_nothing_new_to_send():
    fake = FakeClient(streams=[[IDLE_END_TURN]])
    store = InMemorySessionStore()
    store.set(
        SESSION_KEY,
        SessionRecord(
            session_id="sesn_1",
            tool_names=[],
            pending_client_tool_use_ids=[],
            last_user_message_id="u1",
        ),
    )

    events = await collect(new_agent(fake, store), base_input())
    assert isinstance(events[-1], RunErrorEvent)
    assert events[-1].code == "nothing_to_send"
    assert fake.sent == []


async def test_errors_before_creating_session_when_input_has_nothing_sendable():
    fake = FakeClient(streams=[[IDLE_END_TURN]])
    events = await collect(
        new_agent(fake),
        base_input(messages=[{"id": "a1", "role": "assistant", "content": "hi"}]),
    )
    assert isinstance(events[-1], RunErrorEvent)
    assert events[-1].code == "empty_run"
    assert fake.create_calls == []


async def test_whitespace_only_user_message_is_an_empty_run():
    fake = FakeClient(streams=[[IDLE_END_TURN]])
    events = await collect(
        new_agent(fake),
        base_input(messages=[{"id": "u1", "role": "user", "content": "   \n\t "}]),
    )
    assert isinstance(events[-1], RunErrorEvent)
    assert events[-1].code == "empty_run"
    assert fake.create_calls == []


async def test_image_only_user_message_is_an_empty_run():
    fake = FakeClient(streams=[[IDLE_END_TURN]])
    events = await collect(
        new_agent(fake),
        base_input(
            messages=[
                {
                    "id": "u1",
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {"type": "url", "value": "https://x/y.png"},
                        }
                    ],
                }
            ]
        ),
    )
    assert isinstance(events[-1], RunErrorEvent)
    assert events[-1].code == "empty_run"
    assert fake.create_calls == []


async def test_updates_session_tools_when_frontend_adds_new_one():
    fake = FakeClient(streams=[[IDLE_END_TURN], [IDLE_END_TURN]])
    store = InMemorySessionStore()
    await collect(new_agent(fake, store), base_input())
    assert fake.update_calls == []

    await collect(
        new_agent(fake, store),
        base_input(
            run_id="run_2",
            messages=[
                {"id": "u1", "role": "user", "content": "Hello"},
                {"id": "u2", "role": "user", "content": "Show me a chart"},
            ],
            tools=[
                {
                    "name": "show_chart",
                    "description": "Render a chart",
                    "parameters": {"type": "object"},
                }
            ],
        ),
    )

    assert fake.update_calls == [
        (
            "sesn_1",
            {
                "agent": {
                    "tools": [
                        {
                            "type": "agent_toolset_20260401",
                            "configs": [],
                            "default_config": {},
                        },
                        {
                            "type": "custom",
                            "name": "show_chart",
                            "description": "Render a chart",
                            "input_schema": {"type": "object"},
                        },
                    ]
                }
            },
        )
    ]


async def test_deletes_thread_record_when_session_ends():
    fake = FakeClient(
        streams=[
            [{"type": "session.status_terminated", "id": "term_1"}],
            [IDLE_END_TURN],
        ]
    )
    store = InMemorySessionStore()
    events = await collect(new_agent(fake, store), base_input())
    assert isinstance(events[-1], RunErrorEvent)
    assert events[-1].code == "session_ended"
    assert store.get(SESSION_KEY) is None

    # The next run creates a fresh session.
    await collect(new_agent(fake, store), base_input(run_id="run_2"))
    assert len(fake.create_calls) == 2


async def test_rejects_second_concurrent_run_on_same_thread():
    gate = asyncio.Event()
    fake = FakeClient(streams=[[gate, IDLE_END_TURN]])
    store = InMemorySessionStore()
    first_events: list[Any] = []

    async def first() -> None:
        async for event in new_agent(fake, store).run(base_input()):
            first_events.append(event)

    task = asyncio.create_task(first())
    # Let the first run get into the busy section.
    for _ in range(10):
        await asyncio.sleep(0)

    second = await collect(new_agent(fake, store), base_input(run_id="run_2"))
    assert isinstance(second[-1], RunErrorEvent)
    assert second[-1].message == "A run is already in progress on this thread."
    assert second[-1].code == "run_in_progress"

    gate.set()
    await task
    assert types(first_events)[-1] == "RUN_FINISHED"


async def test_same_thread_id_does_not_collide_across_different_stores():
    """The busy gate is keyed by store identity: distinct stores are distinct
    tenants, so one caller's slow run cannot block another's thread of the
    same (client-supplied) id."""
    gate = asyncio.Event()
    slow_fake = FakeClient(streams=[[gate, IDLE_END_TURN]])
    other_fake = FakeClient(
        streams=[
            [
                {
                    "type": "agent.message",
                    "id": "msg_1",
                    "content": [{"type": "text", "text": "b"}],
                },
                IDLE_END_TURN,
            ]
        ]
    )
    first_events: list[Any] = []

    async def first() -> None:
        async for event in new_agent(slow_fake, InMemorySessionStore()).run(
            base_input()
        ):
            first_events.append(event)

    task = asyncio.create_task(first())
    for _ in range(10):
        await asyncio.sleep(0)

    second = await collect(
        new_agent(other_fake, InMemorySessionStore()), base_input(run_id="run_2")
    )
    assert types(second)[-1] == "RUN_FINISHED"

    gate.set()
    await task
    assert types(first_events)[-1] == "RUN_FINISHED"


async def test_interrupts_session_when_client_disconnects():
    gate = asyncio.Event()
    fake = FakeClient(streams=[[gate]])
    agent = new_agent(fake)

    generator = agent.run(base_input())
    first = await generator.__anext__()
    assert first.type.value == "RUN_STARTED"
    # Let the turn open its stream and post the user message.
    for _ in range(10):
        await asyncio.sleep(0)
    assert len(fake.sent) == 1

    await generator.aclose()
    for _ in range(10):
        await asyncio.sleep(0)

    assert {"type": "user.interrupt"} in [
        event for send in fake.sent for event in send["events"]
    ]


async def test_interrupts_session_when_turn_times_out():
    gate = asyncio.Event()
    fake = FakeClient(streams=[[gate]])
    agent = new_agent(fake, turn_timeout_s=0.05)

    events = await collect(agent, base_input())

    assert isinstance(events[-1], RunErrorEvent)
    assert (
        events[-1].message == "The turn exceeded the 0.05s limit and was interrupted."
    )
    assert events[-1].code == "turn_timeout"
    assert {"type": "user.interrupt"} in [
        event for send in fake.sent for event in send["events"]
    ]
    gate.set()


async def test_stops_streaming_deltas_when_disabled():
    fake = FakeClient(streams=[[IDLE_END_TURN]])
    await collect(new_agent(fake, stream_deltas=False), base_input())
    assert fake.stream_calls == [("sesn_1", {})]


async def test_session_store_is_keyed_by_managed_agent_and_thread_id():
    fake = FakeClient(
        streams=[
            [
                {
                    "type": "agent.message",
                    "id": "msg_1",
                    "content": [{"type": "text", "text": "a"}],
                },
                IDLE_END_TURN,
            ],
        ]
    )
    store = RecordingSessionStore()

    await collect(new_agent(fake, store), base_input())

    assert len(fake.create_calls) == 1
    assert store.keys() == [SESSION_KEY]
    # Never the bare, client-supplied thread id.
    assert store.get("thread_1") is None


async def test_agents_differing_only_in_environment_do_not_share_a_session():
    """environment_id, agent_version and vault_ids are baked into the remote
    session at creation and can never be checked or changed on resume, so a key
    scoped only by managed agent let a staging and a production agent on one
    store share a session: every prod turn would then execute in staging,
    against staging vaults, with nothing surfaced to say so."""
    staging = FakeClient(streams=[[IDLE_END_TURN]], session_id="sesn_staging")
    prod = FakeClient(streams=[[IDLE_END_TURN]], session_id="sesn_prod")
    store = RecordingSessionStore()

    await collect(new_agent(staging, store, environment_id="env_staging"), base_input())
    await collect(
        new_agent(prod, store, environment_id="env_prod"), base_input(run_id="run_2")
    )

    assert len(staging.create_calls) == 1
    assert len(prod.create_calls) == 1
    assert sorted(store.keys()) == sorted(["7:agent_1|0:|11:env_staging|0:|thread_1", "7:agent_1|0:|8:env_prod|0:|thread_1"])


async def test_two_agents_sharing_a_store_never_adopt_each_others_session():
    """Regression: the busy gate was scoped by managed agent while the store was
    keyed by the bare thread id, so a second agent on the same thread id read
    the first agent's session — a session created against a different managed
    agent — without ever serializing against its runs."""
    first = FakeClient(streams=[[IDLE_END_TURN]], session_id="sesn_first")
    second = FakeClient(streams=[[IDLE_END_TURN]], session_id="sesn_second")
    store = RecordingSessionStore()

    await collect(
        new_agent(first, store, managed_agent_id_override="agent_a"), base_input()
    )
    await collect(
        new_agent(second, store, managed_agent_id_override="agent_b"),
        base_input(run_id="run_2"),
    )

    assert len(first.create_calls) == 1
    assert len(second.create_calls) == 1
    assert sorted(store.keys()) == ["7:agent_a|0:|5:env_1|0:|thread_1", "7:agent_b|0:|5:env_1|0:|thread_1"]
    assert store.get("7:agent_a|0:|5:env_1|0:|thread_1").session_id == "sesn_first"
    assert store.get("7:agent_b|0:|5:env_1|0:|thread_1").session_id == "sesn_second"


async def test_runs_serialize_on_the_same_key_the_store_uses():
    gate = asyncio.Event()
    fake = FakeClient(streams=[[gate, IDLE_END_TURN]])
    store = RecordingSessionStore()
    agent = new_agent(fake, store)

    generator = agent.run(base_input())
    await generator.__anext__()
    for _ in range(10):
        await asyncio.sleep(0)

    assert ManagedAgentsAgent._busy_threads[id(store)] == {SESSION_KEY}
    assert store.keys() == [SESSION_KEY]

    gate.set()
    async for _event in generator:
        pass


async def test_rejects_a_blank_thread_id():
    fake = FakeClient(streams=[[IDLE_END_TURN]])
    store = RecordingSessionStore()

    for thread_id in ("", "   "):
        events = await collect(
            new_agent(fake, store), base_input(thread_id=thread_id)
        )
        assert isinstance(events[-1], RunErrorEvent)
        assert events[-1].code == "invalid_thread_id"

    assert fake.create_calls == []
    assert store.keys() == []


async def test_tool_result_on_unknown_thread_does_not_create_session():
    fake = FakeClient(streams=[[IDLE_END_TURN]])
    events = await collect(
        new_agent(fake),
        base_input(
            messages=[
                {
                    "id": "t1",
                    "role": "tool",
                    "tool_call_id": "ctu_ghost",
                    "content": "late",
                }
            ]
        ),
    )
    assert fake.create_calls == []
    assert isinstance(events[-1], RunErrorEvent)
    assert events[-1].code == "tool_result_without_session"


async def test_interrupt_is_posted_before_busy_gate_is_released():
    """Regression: on disconnect the interrupt must be sent while the thread
    is still busy, so a user who resends immediately is not killed by a
    late interrupt."""
    gate = asyncio.Event()
    fake = FakeClient(streams=[[gate]])
    agent = new_agent(fake)
    busy_key = agent._session_key("thread_1")
    busy_when_interrupted: list[bool] = []
    original_send = fake._send

    async def send(session_id: str, *, events: list[Any]):
        if {"type": "user.interrupt"} in events:
            busy_when_interrupted.append(
                busy_key in ManagedAgentsAgent._busy_threads.get(id(agent.store), set())
            )
        return await original_send(session_id, events=events)

    fake.beta.sessions.events.send = send

    generator = agent.run(base_input())
    await generator.__anext__()
    for _ in range(10):
        await asyncio.sleep(0)
    await generator.aclose()
    for _ in range(10):
        await asyncio.sleep(0)

    assert busy_when_interrupted == [True]
    assert busy_key not in ManagedAgentsAgent._busy_threads.get(id(agent.store), set())


async def test_timeout_before_session_exists_does_not_interrupt():
    """A turn can time out while the session is still being created: there is
    no session id to interrupt, and the run must still error cleanly."""
    gate = asyncio.Event()
    fake = FakeClient(streams=[[IDLE_END_TURN]], create_gate=gate)
    events = await collect(new_agent(fake, turn_timeout_s=0.05), base_input())

    assert isinstance(events[-1], RunErrorEvent)
    assert (
        events[-1].message == "The turn exceeded the 0.05s limit and was interrupted."
    )
    assert events[-1].code == "turn_timeout"
    assert fake.sent == []  # no session, so no interrupt is possible
    gate.set()


SHOW_CHART_TOOL = {
    "name": "show_chart",
    "description": "Render a chart",
    "parameters": {"type": "object"},
}

PARKING_CALL = {
    "type": "agent.custom_tool_use",
    "id": "ctu_1",
    "name": "show_chart",
    "input": {},
}


async def test_keeps_a_parked_tool_id_when_a_later_event_fails_the_turn():
    """Regression: the session has already parked on ctu_1 by the time the
    error arrives. Without the id the next run cannot answer that call, so the
    remote session stays parked forever."""
    fake = FakeClient(
        streams=[
            [
                PARKING_CALL,
                {
                    "type": "session.error",
                    "id": "err_1",
                    "error": {
                        "type": "overloaded_error",
                        "message": "upstream is busy",
                        "retry_status": {"type": "exhausted"},
                    },
                },
            ]
        ]
    )
    store = RecordingSessionStore()

    events = await collect(
        new_agent(fake, store), base_input(tools=[SHOW_CHART_TOOL])
    )

    assert isinstance(events[-1], RunErrorEvent)
    assert events[-1].code == "overloaded_error"
    assert store.get(SESSION_KEY).pending_client_tool_use_ids == ["ctu_1"]


async def test_keeps_a_parked_tool_id_when_the_stream_raises_after_the_park():
    fake = FakeClient(streams=[[PARKING_CALL, RuntimeError("connection reset")]])
    store = RecordingSessionStore()

    events = await collect(
        new_agent(fake, store), base_input(tools=[SHOW_CHART_TOOL])
    )

    assert isinstance(events[-1], RunErrorEvent)
    assert events[-1].code == "run_failed"
    assert store.get(SESSION_KEY).pending_client_tool_use_ids == ["ctu_1"]


PARKED_THEN_UNKNOWN_ACTION = [
    PARKING_CALL,
    {
        "type": "session.status_idle",
        "id": "idle_1",
        "stop_reason": {"type": "requires_action", "event_ids": ["ctu_1", "mystery_1"]},
    },
]


async def test_forgets_a_parked_call_once_the_turns_interrupt_has_landed():
    """Regression: the park is persisted the moment the call is handed over, then
    the turn interrupts the session and fails. The interrupt cancels the wait, so
    answering that id on the next run is rejected as stale and wedges the thread
    -- it must not survive."""
    fake = FakeClient(streams=[PARKED_THEN_UNKNOWN_ACTION])
    store = RecordingSessionStore()

    events = await collect(
        new_agent(fake, store), base_input(tools=[SHOW_CHART_TOOL])
    )

    assert isinstance(events[-1], RunErrorEvent)
    assert events[-1].code == "unsupported_action"
    assert {"type": "user.interrupt"} in [
        event for send in fake.sent for event in send["events"]
    ]
    assert store.get(SESSION_KEY).pending_client_tool_use_ids == []


async def test_keeps_a_parked_call_when_the_turns_interrupt_could_not_be_delivered():
    """The mirror image: nothing reached the session, so it may still be parked
    and the id is still the only way to answer it."""
    fake = FakeClient(
        streams=[PARKED_THEN_UNKNOWN_ACTION],
        # Send 0 is the user message; send 1 is the interrupt.
        send_failures={1: RuntimeError("interrupt rejected")},
    )
    store = RecordingSessionStore()

    events = await collect(
        new_agent(fake, store), base_input(tools=[SHOW_CHART_TOOL])
    )

    assert events[-1].code == "unsupported_action"
    assert store.get(SESSION_KEY).pending_client_tool_use_ids == ["ctu_1"]


async def test_forgets_a_parked_call_once_the_teardown_interrupt_has_landed():
    """A timed-out turn never reaches _record_outcome, so the teardown path has
    to reconcile the record itself."""
    fake = FakeClient(streams=[[PARKING_CALL, asyncio.Event()]])
    store = RecordingSessionStore()

    events = await collect(
        new_agent(fake, store, turn_timeout_s=0.05),
        base_input(tools=[SHOW_CHART_TOOL]),
    )

    assert events[-1].code == "turn_timeout"
    assert {"type": "user.interrupt"} in [
        event for send in fake.sent for event in send["events"]
    ]
    assert store.get(SESSION_KEY).pending_client_tool_use_ids == []


async def test_keeps_a_parked_call_when_the_teardown_interrupt_could_not_be_delivered():
    fake = FakeClient(
        streams=[[PARKING_CALL, asyncio.Event()]],
        send_failures={1: RuntimeError("interrupt rejected")},
    )
    store = RecordingSessionStore()

    events = await collect(
        new_agent(fake, store, turn_timeout_s=0.05),
        base_input(tools=[SHOW_CHART_TOOL]),
    )

    assert events[-1].code == "turn_timeout"
    assert store.get(SESSION_KEY).pending_client_tool_use_ids == ["ctu_1"]


async def test_clears_a_stale_parked_id_when_the_session_goes_idle_on_end_turn():
    """Defensive: end_turn means nothing is awaited, so no pending id may
    survive into the next run and be answered against a resumed session."""
    fake = FakeClient(streams=[[IDLE_END_TURN]])
    store = RecordingSessionStore()
    store.set(
        SESSION_KEY,
        SessionRecord(
            session_id="sesn_1",
            tool_names=[],
            pending_client_tool_use_ids=["ctu_stale"],
            last_user_message_id="u1",
        ),
    )

    await collect(
        new_agent(fake, store),
        base_input(
            messages=[
                {"id": "u1", "role": "user", "content": "Hello"},
                {"id": "u2", "role": "user", "content": "never mind"},
            ]
        ),
    )

    assert store.get(SESSION_KEY).pending_client_tool_use_ids == []


async def test_emits_one_terminal_event_when_the_closing_write_fails():
    """Regression: the turn already emitted RUN_ERROR, then persisting the
    outcome failed and the outer handler appended a second terminal event."""
    fake = FakeClient(streams=[[{"type": "session.status_terminated", "id": "term_1"}]])
    store = RecordingSessionStore()

    def failing_delete(_key: str) -> None:
        raise RuntimeError("store is down")

    store.delete = failing_delete  # type: ignore[method-assign]
    reported: list[dict[str, Any]] = []

    events = await collect(
        new_agent(fake, store, on_error=lambda _e, context: reported.append(context)),
        base_input(),
    )

    terminal = [
        event
        for event in events
        if isinstance(event, (RunErrorEvent, RunFinishedEvent))
    ]
    assert len(terminal) == 1
    assert terminal[0].code == "session_ended"
    # The dropped error is not lost: it reaches the hook.
    assert "dropped_terminal_event" in [c["operation"] for c in reported]


async def test_an_inner_bounded_timeout_is_not_reported_as_the_turn_timeout():
    """Regression: an inner best-effort send has its own 15s bound, and both it
    and the turn deadline raise TimeoutError. Reporting the inner one as
    `turn_timeout` claimed the run had exceeded a limit it never came near."""

    class SlowStore:
        """A store whose write outlives the inner bound but not the turn."""

        def __init__(self) -> None:
            self._records: dict[str, SessionRecord] = {}

        def get(self, key: str) -> SessionRecord | None:
            return self._records.get(key)

        async def set(self, key: str, record: SessionRecord) -> None:
            self._records[key] = record

        def delete(self, key: str) -> None:
            self._records.pop(key, None)

    fake = FakeClient(streams=[[IDLE_END_TURN]])
    store = SlowStore()

    async def inner_timeout(_key: str, _record: SessionRecord) -> None:
        raise asyncio.TimeoutError

    store.set = inner_timeout  # type: ignore[method-assign]

    events = await collect(
        new_agent(fake, store, turn_timeout_s=300.0), base_input()
    )

    assert isinstance(events[-1], RunErrorEvent)
    assert events[-1].code == "run_failed"
    assert "300s" not in events[-1].message
    # No interrupt: the turn never ran past its own limit.
    assert {"type": "user.interrupt"} not in [
        event for send in fake.sent for event in send["events"]
    ]


async def test_a_failed_tool_confirmation_delivery_reports_its_own_cause():
    fake = FakeClient(
        streams=[
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
        ],
        # Send 0 is the user message; send 1 is the confirmation.
        send_failures={1: asyncio.TimeoutError()},
    )

    events = await collect(
        new_agent(fake, tool_confirmation="allow", turn_timeout_s=300.0), base_input()
    )

    assert isinstance(events[-1], RunErrorEvent)
    assert events[-1].code == "tool_confirmation_delivery_failed"
    # The session is parked on the confirmation, so it is interrupted.
    assert {"type": "user.interrupt"} in [
        event for send in fake.sent for event in send["events"]
    ]


async def test_clears_pending_tool_ids_even_when_follow_ups_fail():
    """Regression: once the tool results resume the session, they are recorded
    as delivered even if the follow-up messages then fail, so the next run
    never re-posts consumed results. Asserted against an out-of-process-shaped
    store so only genuinely persisted state counts."""
    fake = FakeClient(
        streams=[[IDLE_END_TURN]],
        # Send 0 (the tool results) succeeds; send 1 (the follow-up) fails
        # with a non-retryable error.
        send_failures={1: FakeAPIError(500, "server exploded")},
    )
    store = RecordingSessionStore()
    store.set(
        SESSION_KEY,
        SessionRecord(
            session_id="sesn_1",
            tool_names=[],
            pending_client_tool_use_ids=["ctu_1"],
            last_user_message_id="u1",
        ),
    )

    events = await collect(
        new_agent(fake, store),
        base_input(
            messages=[
                {"id": "u1", "role": "user", "content": "Hello"},
                {"id": "t1", "role": "tool", "toolCallId": "ctu_1", "content": "done"},
                {"id": "u2", "role": "user", "content": "and one more thing"},
            ]
        ),
    )

    assert isinstance(events[-1], RunErrorEvent)
    assert events[-1].message == "The run failed."
    record = store.get(SESSION_KEY)
    assert record.pending_client_tool_use_ids == []
    # The follow-up never landed, so the user message stays undelivered.
    assert record.last_user_message_id == "u1"


async def test_records_the_follow_up_delivery_separately_from_the_results():
    """Each delivery persists on its own, in send order."""
    fake = FakeClient(streams=[[IDLE_END_TURN]])
    store = RecordingSessionStore()
    store.set(
        SESSION_KEY,
        SessionRecord(
            session_id="sesn_1",
            tool_names=[],
            pending_client_tool_use_ids=["ctu_1"],
            last_user_message_id="u1",
        ),
    )
    store.writes.clear()

    await collect(
        new_agent(fake, store),
        base_input(
            messages=[
                {"id": "u1", "role": "user", "content": "Hello"},
                {"id": "t1", "role": "tool", "toolCallId": "ctu_1", "content": "done"},
                {"id": "u2", "role": "user", "content": "and one more thing"},
            ]
        ),
    )

    assert [
        (record.pending_client_tool_use_ids, record.last_user_message_id)
        for _key, record in store.writes
    ] == [([], "u1"), ([], "u2")]


async def test_abandons_multiple_pending_calls_in_original_order():
    fake = FakeClient(streams=[[IDLE_END_TURN]])
    store = InMemorySessionStore()
    store.set(
        SESSION_KEY,
        SessionRecord(
            session_id="sesn_1",
            tool_names=[],
            pending_client_tool_use_ids=["ctu_1", "ctu_2", "ctu_3"],
            last_user_message_id="u1",
        ),
    )

    await collect(
        new_agent(fake, store),
        base_input(
            messages=[
                {"id": "u1", "role": "user", "content": "old"},
                {"id": "u2", "role": "user", "content": "never mind"},
            ]
        ),
    )

    abandoned = fake.sent[0]["events"]
    assert [event["custom_tool_use_id"] for event in abandoned] == [
        "ctu_1",
        "ctu_2",
        "ctu_3",
    ]
    assert all(event["is_error"] for event in abandoned)
    assert fake.sent[1]["events"] == [
        {"type": "user.message", "content": [{"type": "text", "text": "never mind"}]}
    ]


async def test_frontend_tool_wins_normalized_name_collision_with_backend():
    fake = FakeClient(streams=[[IDLE_END_TURN]], agent_tools=[])
    backend = BackendTool(
        name="search_web",
        description="Backend search",
        parameters={},
        handler=lambda _i: "backend",
    )
    await collect(
        new_agent(fake, backend_tools=[backend]),
        base_input(
            tools=[
                {
                    "name": "search web",
                    "description": "Frontend search",
                    "parameters": {"type": "object"},
                }
            ]
        ),
    )

    tools = fake.create_calls[0]["agent"]["tools"]
    assert tools == [
        {
            "type": "custom",
            "name": "search_web",
            "description": "Frontend search",
            "input_schema": {"type": "object"},
        }
    ]


async def test_frontend_tools_with_colliding_normalized_names_keep_the_last():
    fake = FakeClient(streams=[[IDLE_END_TURN]], agent_tools=[])
    await collect(
        new_agent(fake),
        base_input(
            tools=[
                {"name": "search web", "description": "First", "parameters": {}},
                {"name": "search_web", "description": "Second", "parameters": {}},
            ]
        ),
    )

    tools = fake.create_calls[0]["agent"]["tools"]
    assert [tool["name"] for tool in tools] == ["search_web"]
    assert tools[0]["description"] == "Second"


async def test_refreshes_legacy_name_only_tool_cache():
    fake = FakeClient(streams=[[IDLE_END_TURN]])
    store = InMemorySessionStore()
    store.set(
        SESSION_KEY,
        SessionRecord(
            session_id="sesn_1",
            tool_names=["show_chart"],
            pending_client_tool_use_ids=[],
            last_user_message_id=None,
        ),
    )

    await collect(
        new_agent(fake, store),
        base_input(
            tools=[
                {
                    "name": "show_chart",
                    "description": "Render a chart",
                    "parameters": {"type": "object"},
                }
            ]
        ),
    )

    assert len(fake.update_calls) == 1
    record = store.get(SESSION_KEY)
    assert record is not None
    assert record.tool_definitions_fingerprint is not None


async def test_interrupts_backend_tool_and_answers_it_when_client_disconnects():
    """A disconnect mid backend-tool never leaves the session parked: the call
    gets an error result and the session is interrupted, both before the
    busy gate is released."""
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
    agent = new_agent(fake, backend_tools=[backend])

    generator = agent.run(base_input())
    await generator.__anext__()
    await started.wait()
    await generator.aclose()
    for _ in range(20):
        await asyncio.sleep(0)

    sent = [event for send in fake.sent for event in send["events"]]
    assert {
        "type": "user.custom_tool_result",
        "custom_tool_use_id": "ctu_1",
        "content": [{"type": "text", "text": "Tool execution was interrupted."}],
        "is_error": True,
    } in sent
    assert {"type": "user.interrupt"} in sent
    assert agent._session_key("thread_1") not in ManagedAgentsAgent._busy_threads.get(
        id(agent.store), set()
    )


SENSITIVE = (
    "401 from https://internal.example/v1/sessions "
    "(key sk-ant-SECRET, session sesn_private)"
)


async def test_surfaces_a_session_create_failure_without_relaying_its_text() -> None:
    """A failed sessions.create must reach the client as run_failed, not hang --
    and the exception can carry session ids, request paths or credentials, so the
    cause belongs to the hook and the client gets the code."""
    fake = FakeClient(create_error=RuntimeError(SENSITIVE))
    reported: list[tuple[BaseException, dict[str, Any]]] = []

    events = await collect(
        new_agent(fake, on_error=lambda error, context: reported.append((error, context))),
        base_input(),
    )

    assert isinstance(events[-1], RunErrorEvent)
    assert events[-1].message == "The run failed."
    assert events[-1].code == "run_failed"
    for event in events:
        assert "sk-ant-SECRET" not in event.model_dump_json()

    run_failed = [
        (error, context)
        for error, context in reported
        if context["operation"] == "run_failed"
    ]
    assert [str(error) for error, _context in run_failed] == [SENSITIVE]
    assert run_failed[0][1]["thread_id"] == "thread_1"


async def test_does_not_relay_a_failed_deliverys_exception_text_to_the_client() -> None:
    fake = FakeClient(
        streams=[
            [
                {
                    "type": "agent.custom_tool_use",
                    "id": "ctu_1",
                    "name": "get_time",
                    "input": {},
                },
                IDLE_END_TURN,
            ]
        ],
        # The user message posts fine; the tool result does not.
        send_failures={1: RuntimeError(SENSITIVE)},
    )
    reported: list[BaseException] = []
    backend = BackendTool(
        name="get_time", description="", parameters={}, handler=lambda _i: "noon"
    )

    events = await collect(
        new_agent(
            fake,
            backend_tools=[backend],
            on_error=lambda error, _context: reported.append(error),
        ),
        base_input(),
    )

    assert isinstance(events[-1], RunErrorEvent)
    assert (
        events[-1].message
        == "The result of tool call ctu_1 could not be delivered to the session."
    )
    assert events[-1].code == "tool_result_delivery_failed"
    # Not in the RUN_ERROR, and no TOOL_CALL_RESULT was emitted at all.
    for event in events:
        assert "sk-ant-SECRET" not in event.model_dump_json()
    assert "TOOL_CALL_RESULT" not in types(events)
    assert SENSITIVE in [str(error) for error in reported]


async def test_input_without_messages_or_tools_fields_is_an_empty_run() -> None:
    """RunAgentInput is not validated at runtime: a body missing these fields
    must read as an empty run, not raise a TypeError."""
    fake = FakeClient(streams=[[IDLE_END_TURN]])
    bare = RunAgentInput.model_construct(
        thread_id="thread_1", run_id="run_1", state={}, context=[], forwarded_props={}
    )

    events = await collect(new_agent(fake), bare)

    assert isinstance(events[-1], RunErrorEvent)
    assert events[-1].code == "empty_run"
    assert fake.create_calls == []


async def test_deletes_thread_record_when_the_session_is_deleted() -> None:
    fake = FakeClient(streams=[[{"type": "session.deleted", "id": "del_1"}]])
    store = InMemorySessionStore()

    events = await collect(new_agent(fake, store), base_input())

    assert isinstance(events[-1], RunErrorEvent)
    assert events[-1].code == "session_ended"
    assert store.get(SESSION_KEY) is None
