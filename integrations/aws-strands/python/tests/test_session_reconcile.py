"""Tests for reconciling frontend-tool results into a Strands SessionManager.

Frontend (proxy) tools return a ``"Forwarded to client"`` placeholder result
server-side; the real result only arrives on the next run inside
``RunAgentInput.messages``. These tests exercise the helper that overwrites the
persisted placeholder ``toolResult`` with the real client result so the session
store (and the agent's in-memory history) hold the true value.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from strands.session.file_session_manager import FileSessionManager
from strands.types.session import SessionAgent, SessionMessage

from ag_ui_strands import session_reconcile
from ag_ui_strands.session_reconcile import (
    AG_UI_FRONTEND_CALL_IDS_STATE_KEY,
    has_placeholder_results,
    reconcile_frontend_tool_results,
)

PLACEHOLDER = "Forwarded to client"


def _make_session(tmp_path, session_id="s1", agent_id="default"):
    sm = FileSessionManager(session_id=session_id, storage_dir=str(tmp_path))
    sm.session_repository.create_agent(
        session_id,
        SessionAgent(agent_id=agent_id, state={}, conversation_manager_state={}),
    )
    return sm


def _seed(sm, agent_id, index, message):
    sm.session_repository.create_message(
        sm.session_id, agent_id, SessionMessage(message=message, message_id=index)
    )


def _tool_result_block(tool_use_id, text):
    return {
        "toolResult": {
            "toolUseId": tool_use_id,
            "status": "success",
            "content": [{"text": text}],
        }
    }


def test_active_proxy_placeholder_requires_exact_reserved_result_shape():
    exact_result = {
        "toolUseId": "native-proxy",
        "status": "success",
        "content": [{"text": PLACEHOLDER}],
    }

    def detected(result, *, activated=True):
        agent = SimpleNamespace(
            _interrupt_state=SimpleNamespace(
                activated=activated,
                context={"tool_results": [result]},
            )
        )
        return bool(session_reconcile.active_proxy_placeholder_ids(agent))

    assert detected(exact_result)
    assert not detected(exact_result, activated=False)
    assert not detected(
        {**exact_result, "content": [{"text": f"prefix {PLACEHOLDER} suffix"}]}
    )
    assert not detected({**exact_result, "status": "error"})
    assert not detected({**exact_result, "content": [{"text": PLACEHOLDER}, {"text": "extra"}]})
    assert not detected({**exact_result, "unexpected": True})
    assert not session_reconcile.active_proxy_placeholder_ids(SimpleNamespace())


def test_repository_capability_requires_public_repository_api_and_stable_agent_id():
    repository = SimpleNamespace(
        list_messages=lambda session_id, agent_id: [],
        update_message=lambda session_id, agent_id, message: None,
    )
    manager = SimpleNamespace(
        session_id="session-1",
        session_repository=repository,
    )

    assert session_reconcile._supports_repository_reconciliation(
        manager, SimpleNamespace(agent_id="stable-agent")
    )
    assert not session_reconcile._supports_repository_reconciliation(
        SimpleNamespace(session_id="session-1"),
        SimpleNamespace(agent_id="stable-agent"),
    )
    assert not session_reconcile._supports_repository_reconciliation(
        manager, SimpleNamespace()
    )
    assert not session_reconcile._supports_repository_reconciliation(
        manager, SimpleNamespace(agent_id="")
    )


@pytest.mark.parametrize(
    ("throwing_owner", "throwing_attribute"),
    [
        pytest.param("manager", "session_id", id="session-id"),
        pytest.param("manager", "session_repository", id="session-repository"),
        pytest.param("agent", "agent_id", id="agent-id"),
        pytest.param("repository", "list_messages", id="list-messages"),
        pytest.param("repository", "update_message", id="update-message"),
    ],
)
def test_repository_capability_fails_closed_on_throwing_accessors(
    throwing_owner, throwing_attribute
):
    class ThrowingAccessor(SimpleNamespace):
        def __getattribute__(self, name):
            if name == object.__getattribute__(self, "throwing_attribute"):
                raise RuntimeError(f"{name} unavailable")
            return super().__getattribute__(name)

    repository = SimpleNamespace(
        list_messages=lambda session_id, agent_id: [],
        update_message=lambda session_id, agent_id, message: None,
    )
    manager = SimpleNamespace(
        session_id="session-1",
        session_repository=repository,
    )
    agent = SimpleNamespace(agent_id="stable-agent")
    owners = {
        "manager": manager,
        "agent": agent,
        "repository": repository,
    }
    throwing = ThrowingAccessor(
        **vars(owners[throwing_owner]),
        throwing_attribute=throwing_attribute,
    )
    if throwing_owner == "repository":
        manager.session_repository = throwing
    else:
        owners[throwing_owner] = throwing

    assert not session_reconcile._supports_repository_reconciliation(
        owners["manager"], owners["agent"]
    )


def test_reconcile_overwrites_persisted_placeholder_in_store(tmp_path):
    sm = _make_session(tmp_path)
    agent_id = "default"
    _seed(sm, agent_id, 0, {"role": "user", "content": [{"text": "set it"}]})
    _seed(
        sm,
        agent_id,
        1,
        {
            "role": "assistant",
            "content": [{"toolUse": {"toolUseId": "tu-1", "name": "approve", "input": {}}}],
        },
    )
    _seed(
        sm,
        agent_id,
        2,
        {"role": "user", "content": [_tool_result_block("tu-1", PLACEHOLDER)]},
    )

    agent = SimpleNamespace(agent_id=agent_id, messages=[])
    corrected = reconcile_frontend_tool_results(
        sm, agent, {"tu-1": ('{"approved": false}', False)}
    )

    assert corrected == {"tu-1"}
    persisted = sm.session_repository.list_messages(sm.session_id, agent_id)
    result_block = persisted[2].message["content"][0]["toolResult"]
    assert result_block["content"] == [{"text": '{"approved": false}'}]


def test_reconcile_returns_set_of_corrected_tool_use_ids(tmp_path):
    sm = _make_session(tmp_path)
    agent_id = "default"
    _seed(
        sm,
        agent_id,
        0,
        {"role": "user", "content": [_tool_result_block("tu-1", PLACEHOLDER)]},
    )
    agent = SimpleNamespace(
        agent_id=agent_id,
        messages=[{"role": "user", "content": [_tool_result_block("tu-1", PLACEHOLDER)]}],
    )

    corrected = reconcile_frontend_tool_results(
        sm, agent, {"tu-1": ("R", False), "tu-absent": ("X", False)}
    )

    assert corrected == {"tu-1"}


def test_reconcile_recognizes_exact_persisted_result_without_rewriting(
    tmp_path, monkeypatch
):
    sm = _make_session(tmp_path)
    agent_id = "default"
    _seed(
        sm,
        agent_id,
        0,
        {"role": "user", "content": [_tool_result_block("tu-1", "R")]},
    )
    monkeypatch.setattr(
        sm.session_repository,
        "update_message",
        lambda *args: pytest.fail("exact persisted result must not be rewritten"),
    )

    corrected = reconcile_frontend_tool_results(
        sm, SimpleNamespace(agent_id=agent_id, messages=[]), {"tu-1": ("R", False)}
    )

    assert corrected == {"tu-1"}


def test_reconcile_corrects_in_memory_agent_messages(tmp_path):
    sm = _make_session(tmp_path)
    agent_id = "default"
    _seed(sm, agent_id, 0, {"role": "user", "content": [{"text": "set it"}]})
    _seed(
        sm,
        agent_id,
        1,
        {"role": "user", "content": [_tool_result_block("tu-1", PLACEHOLDER)]},
    )

    # The cached agent still holds the placeholder in its live message list.
    agent = SimpleNamespace(
        agent_id=agent_id,
        messages=[
            {"role": "user", "content": [{"text": "set it"}]},
            {"role": "user", "content": [_tool_result_block("tu-1", PLACEHOLDER)]},
        ],
    )

    reconcile_frontend_tool_results(sm, agent, {"tu-1": ('{"approved": true}', False)})

    in_memory = agent.messages[1]["content"][0]["toolResult"]
    assert in_memory["content"] == [{"text": '{"approved": true}'}]


def test_active_interrupt_context_reconciliation_error_is_not_swallowed(tmp_path):
    sm = _make_session(tmp_path)

    class ExplodingToolResults(list):
        def __iter__(self):
            raise RuntimeError("checkpoint unavailable")

    parked_results = ExplodingToolResults(
        [
            {
                "toolUseId": "native-proxy",
                "status": "success",
                "content": [{"text": PLACEHOLDER}],
            }
        ]
    )
    interrupt_state = SimpleNamespace(
        activated=True,
        context={"tool_results": parked_results},
    )
    agent = SimpleNamespace(
        agent_id="default",
        messages=[],
        _interrupt_state=interrupt_state,
    )

    with pytest.raises(RuntimeError, match="checkpoint unavailable"):
        reconcile_frontend_tool_results(
            sm, agent, {"native-proxy": ('{"approved": true}', False)}
        )

    assert interrupt_state.activated
    assert interrupt_state.context["tool_results"] is parked_results


def test_reconcile_stamps_error_status_on_active_interrupt_context(tmp_path):
    sm = _make_session(tmp_path)
    parked_result = _tool_result_block("native-proxy", PLACEHOLDER)["toolResult"]
    agent = SimpleNamespace(
        agent_id="default",
        messages=[],
        _interrupt_state=SimpleNamespace(
            activated=True,
            context={"tool_results": [parked_result]},
        ),
    )

    corrected = reconcile_frontend_tool_results(
        sm, agent, {"native-proxy": ("boom", True)}
    )

    assert corrected == {"native-proxy"}
    assert parked_result["content"] == [{"text": "boom"}]
    assert parked_result["status"] == "error"


def test_reconcile_handles_parallel_tool_calls_in_one_message(tmp_path):
    sm = _make_session(tmp_path)
    agent_id = "default"
    _seed(
        sm,
        agent_id,
        0,
        {
            "role": "assistant",
            "content": [
                {"toolUse": {"toolUseId": "tu-1", "name": "a", "input": {}}},
                {"toolUse": {"toolUseId": "tu-2", "name": "b", "input": {}}},
            ],
        },
    )
    _seed(
        sm,
        agent_id,
        1,
        {
            "role": "user",
            "content": [
                _tool_result_block("tu-1", PLACEHOLDER),
                _tool_result_block("tu-2", PLACEHOLDER),
            ],
        },
    )

    agent = SimpleNamespace(agent_id=agent_id, messages=[])
    corrected = reconcile_frontend_tool_results(
        sm, agent, {"tu-1": ("R1", False), "tu-2": ("R2", False)}
    )

    assert corrected == {"tu-1", "tu-2"}
    blocks = sm.session_repository.list_messages(sm.session_id, agent_id)[1].message[
        "content"
    ]
    assert blocks[0]["toolResult"]["content"] == [{"text": "R1"}]
    assert blocks[1]["toolResult"]["content"] == [{"text": "R2"}]


def test_has_placeholder_results_detects_remaining_stub():
    assert has_placeholder_results(
        [{"role": "user", "content": [_tool_result_block("tu-1", PLACEHOLDER)]}]
    )
    assert not has_placeholder_results(
        [{"role": "user", "content": [_tool_result_block("tu-1", "real result")]}]
    )
    assert not has_placeholder_results([])


def test_has_placeholder_results_scopes_to_only_ids():
    messages = [
        {"role": "user", "content": [_tool_result_block("tu-old", PLACEHOLDER)]},
        {"role": "user", "content": [_tool_result_block("tu-new", "real")]},
    ]
    # A stale placeholder for tu-old must not count when scoped to tu-new.
    assert not has_placeholder_results(messages, only_ids={"tu-new"})
    assert has_placeholder_results(messages, only_ids={"tu-old"})


def test_reconcile_leaves_non_placeholder_results_untouched(tmp_path):
    sm = _make_session(tmp_path)
    agent_id = "default"
    _seed(
        sm,
        agent_id,
        0,
        {"role": "user", "content": [_tool_result_block("tu-1", "already the real result")]},
    )

    agent = SimpleNamespace(agent_id=agent_id, messages=[])
    corrected = reconcile_frontend_tool_results(
        sm, agent, {"tu-1": ("SHOULD NOT APPLY", False)}
    )

    assert corrected == set()
    block = sm.session_repository.list_messages(sm.session_id, agent_id)[0].message[
        "content"
    ][0]["toolResult"]
    assert block["content"] == [{"text": "already the real result"}]


def test_reconcile_stamps_error_status_on_the_persisted_result(tmp_path):
    # The proxy wrote the placeholder with a hardcoded "success" status. A
    # client-reported failure has to overwrite that too, or the model reads the
    # real error text under a success flag.
    sm = _make_session(tmp_path)
    agent_id = "default"
    _seed(
        sm,
        agent_id,
        0,
        {"role": "user", "content": [_tool_result_block("tu-1", PLACEHOLDER)]},
    )

    agent = SimpleNamespace(agent_id=agent_id, messages=[])
    corrected = reconcile_frontend_tool_results(
        sm, agent, {"tu-1": ("boom: invalid id", True)}
    )

    assert corrected == {"tu-1"}
    block = sm.session_repository.list_messages(sm.session_id, agent_id)[0].message[
        "content"
    ][0]["toolResult"]
    assert block["content"] == [{"text": "boom: invalid id"}]
    assert block["status"] == "error"


def test_reconcile_keeps_success_status_when_the_tool_did_not_fail(tmp_path):
    sm = _make_session(tmp_path)
    agent_id = "default"
    _seed(
        sm,
        agent_id,
        0,
        {"role": "user", "content": [_tool_result_block("tu-1", PLACEHOLDER)]},
    )

    agent = SimpleNamespace(agent_id=agent_id, messages=[])
    reconcile_frontend_tool_results(sm, agent, {"tu-1": ("all good", False)})

    block = sm.session_repository.list_messages(sm.session_id, agent_id)[0].message[
        "content"
    ][0]["toolResult"]
    assert block["status"] == "success"


def test_reconcile_stamps_error_status_on_the_in_memory_history(tmp_path):
    # A same-process continuation reads agent.messages, not the store.
    sm = _make_session(tmp_path)
    agent_id = "default"
    _seed(
        sm,
        agent_id,
        0,
        {"role": "user", "content": [_tool_result_block("tu-1", PLACEHOLDER)]},
    )
    agent = SimpleNamespace(
        agent_id=agent_id,
        messages=[{"role": "user", "content": [_tool_result_block("tu-1", PLACEHOLDER)]}],
    )

    reconcile_frontend_tool_results(sm, agent, {"tu-1": ("boom", True)})

    in_memory = agent.messages[0]["content"][0]["toolResult"]
    assert in_memory["content"] == [{"text": "boom"}]
    assert in_memory["status"] == "error"


def test_reconcile_stamps_each_parallel_result_independently(tmp_path):
    # One failed and one successful frontend tool in the same turn must not
    # share a status.
    sm = _make_session(tmp_path)
    agent_id = "default"
    _seed(
        sm,
        agent_id,
        0,
        {
            "role": "user",
            "content": [
                _tool_result_block("tu-1", PLACEHOLDER),
                _tool_result_block("tu-2", PLACEHOLDER),
            ],
        },
    )

    agent = SimpleNamespace(agent_id=agent_id, messages=[])
    reconcile_frontend_tool_results(
        sm, agent, {"tu-1": ("ok", False), "tu-2": ("failed", True)}
    )

    blocks = sm.session_repository.list_messages(sm.session_id, agent_id)[0].message[
        "content"
    ]
    assert blocks[0]["toolResult"]["status"] == "success"
    assert blocks[1]["toolResult"]["status"] == "error"


def test_reconcile_leaves_status_alone_when_the_block_is_not_a_placeholder(tmp_path):
    # Already-real results are never rewritten, so an unrelated error flag in
    # pending_results must not leak onto them.
    sm = _make_session(tmp_path)
    agent_id = "default"
    _seed(
        sm,
        agent_id,
        0,
        {"role": "user", "content": [_tool_result_block("tu-1", "already real")]},
    )

    agent = SimpleNamespace(agent_id=agent_id, messages=[])
    corrected = reconcile_frontend_tool_results(sm, agent, {"tu-1": ("boom", True)})

    assert corrected == set()
    block = sm.session_repository.list_messages(sm.session_id, agent_id)[0].message[
        "content"
    ][0]["toolResult"]
    assert block["status"] == "success"


@pytest.mark.parametrize(
    "stored",
    [
        pytest.param("native-xyz", id="string"),
        pytest.param(7, id="number"),
        pytest.param({"minted-1": "native-1"}, id="legacy-mapping"),
        pytest.param(["native-1", "", "  ", 4, None], id="list-with-junk"),
    ],
)
def test_recorded_call_ids_accepts_only_ids_this_adapter_wrote(stored):
    """A permissive read fabricates provenance out of whatever is stored.

    A bare string iterates one character per id, and every fabricated id is
    then written back by the emission path, so the damage outlives the turn.
    """
    agent = SimpleNamespace(
        state=SimpleNamespace(
            get=lambda key=None: (
                stored if key == AG_UI_FRONTEND_CALL_IDS_STATE_KEY else None
            )
        )
    )

    assert session_reconcile.recorded_frontend_call_ids(agent) == (
        ["native-1"] if isinstance(stored, list) else []
    )
