#!/usr/bin/env python
"""Black-box endpoint tests for minimal async agent resolution."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

from ag_ui.core import (
    AssistantMessage,
    EventType,
    FunctionCall,
    RunAgentInput,
    RunStartedEvent,
    ToolCall,
    ToolMessage,
    UserMessage,
)
from ag_ui_adk.adk_agent import ADKAgent
from ag_ui_adk.endpoint import (
    add_adk_fastapi_endpoint,
    create_adk_app,
    resolve_agent_from_message_history,
)
from fastapi import FastAPI
from fastapi.testclient import TestClient


def _run_input(
    *,
    thread_id: str = "thread-1",
    run_id: str = "run-1",
    messages=None,
    state=None,
) -> RunAgentInput:
    return RunAgentInput(
        thread_id=thread_id,
        run_id=run_id,
        messages=messages
        if messages is not None
        else [UserMessage(id="user-1", role="user", content="hello")],
        tools=[],
        context=[],
        state={} if state is None else state,
        forwarded_props={},
    )


def _agent(name: str, *, capabilities=None):
    agent = MagicMock(spec=ADKAgent)
    agent.name = name
    agent.get_capabilities.return_value = capabilities

    async def run(input_data):
        yield RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id=input_data.thread_id,
            run_id=input_data.run_id,
        )

    agent.run = MagicMock(side_effect=run)
    return agent


def _state_agent(name: str, state: dict):
    agent = _agent(name)
    adk_agent = MagicMock()
    adk_agent.name = name
    agent._adk_agent = adk_agent
    agent._static_app_name = f"{name}_app"
    agent._static_user_id = f"{name}_user"
    agent._session_lookup_cache = {}
    agent._get_session_metadata = MagicMock(
        return_value=(f"{name}_session", f"{name}_app", f"{name}_user")
    )
    agent._session_manager = MagicMock()
    agent._session_manager.get_session_state = AsyncMock(return_value=state)
    agent._session_manager._session_service = MagicMock()
    session = MagicMock()
    session.events = []
    agent._session_manager._session_service.get_session = AsyncMock(
        return_value=session
    )
    return agent


def _assistant_tool_message(
    *,
    message_id: str,
    name: str | None,
    tool_call_id: str,
) -> AssistantMessage:
    return AssistantMessage(
        id=message_id,
        role="assistant",
        name=name,
        content=None,
        tool_calls=[
            ToolCall(
                id=tool_call_id,
                function=FunctionCall(name="client_tool", arguments="{}"),
            )
        ],
    )


def _tool_result_message(
    *,
    message_id: str,
    tool_call_id: str,
) -> ToolMessage:
    return ToolMessage(
        id=message_id,
        role="tool",
        tool_call_id=tool_call_id,
        content='{"ok": true}',
    )


def _history_resolver_client(default_agent, agent_registry):
    async def resolver(request, input_data):
        history_agent = resolve_agent_from_message_history(
            input_data.messages, agent_registry
        )
        if history_agent is not None:
            return history_agent
        return agent_registry.get(input_data.state.get("agent"))

    app = FastAPI()
    add_adk_fastapi_endpoint(app, default_agent, path="/agent", agent_resolver=resolver)
    return TestClient(app)


def test_resolver_runs_after_extractor_and_can_fallback_to_default_agent():
    default_agent = _agent("default")
    selected_agent = _agent("selected")
    resolver_inputs = []

    async def extractor(request, input_data):
        return {"tenant": request.headers["x-tenant"], "from_extractor": True}

    async def resolver(request, input_data):
        resolver_inputs.append(input_data)
        if input_data.state["tenant"] == "selected":
            return selected_agent
        return None

    app = FastAPI()
    add_adk_fastapi_endpoint(
        app,
        default_agent,
        path="/agent",
        extract_state_from_request=extractor,
        agent_resolver=resolver,
    )
    client = TestClient(app)

    selected_response = client.post(
        "/agent",
        json=_run_input(state={"client_state": "preserved"}).model_dump(),
        headers={"x-tenant": "selected"},
    )
    fallback_response = client.post(
        "/agent",
        json=_run_input(run_id="run-2").model_dump(),
        headers={"x-tenant": "unknown"},
    )

    assert selected_response.status_code == 200
    assert fallback_response.status_code == 200
    assert selected_agent.run.call_count == 1
    assert default_agent.run.call_count == 1
    assert resolver_inputs[0].state == {
        "client_state": "preserved",
        "tenant": "selected",
        "from_extractor": True,
    }


def test_resolver_can_route_by_request_headers_and_query_params():
    default_agent = _agent("default")
    selected_agent = _agent("selected")

    async def resolver(request, input_data):
        if (
            request.headers.get("x-route-agent") == "selected"
            and request.query_params.get("region") == "west"
        ):
            return selected_agent
        return None

    app = FastAPI()
    add_adk_fastapi_endpoint(
        app, default_agent, path="/agent", agent_resolver=resolver
    )
    client = TestClient(app)

    response = client.post(
        "/agent?region=west",
        json=_run_input().model_dump(),
        headers={"x-route-agent": "selected"},
    )

    assert response.status_code == 200
    selected_agent.run.assert_called_once()
    default_agent.run.assert_not_called()


def test_create_adk_app_forwards_agent_resolver_functionally():
    default_agent = _agent("default")
    selected_agent = _agent("selected")

    async def resolver(request, input_data):
        return selected_agent if input_data.state.get("agent") == "selected" else None

    app = create_adk_app(default_agent, path="/agent", agent_resolver=resolver)
    client = TestClient(app)

    response = client.post(
        "/agent", json=_run_input(state={"agent": "selected"}).model_dump()
    )

    assert response.status_code == 200
    selected_agent.run.assert_called_once()
    default_agent.run.assert_not_called()


def test_capabilities_uses_resolver_after_extractor_and_defaults_on_none():
    default_agent = _agent("default", capabilities={"identity": {"name": "default"}})
    selected_agent = _agent(
        "selected", capabilities={"identity": {"name": "selected"}}
    )
    resolver_inputs = []

    async def extractor(request, input_data):
        if "x-capability-agent" in request.headers:
            return {"capability_agent": request.headers["x-capability-agent"]}
        return {}

    async def resolver(request, input_data):
        resolver_inputs.append(input_data)
        if input_data.state.get("capability_agent") == "selected":
            return selected_agent
        return None

    app = FastAPI()
    add_adk_fastapi_endpoint(
        app,
        default_agent,
        path="/agent",
        extract_state_from_request=extractor,
        agent_resolver=resolver,
    )
    client = TestClient(app)

    selected_response = client.get(
        "/agent/capabilities", headers={"x-capability-agent": "selected"}
    )
    fallback_response = client.get("/agent/capabilities")

    assert selected_response.status_code == 200
    assert selected_response.json()["identity"]["name"] == "selected"
    assert fallback_response.status_code == 200
    assert fallback_response.json()["identity"]["name"] == "default"
    assert resolver_inputs[0].state == {"capability_agent": "selected"}
    assert resolver_inputs[0].messages == []


def test_agents_state_uses_resolved_agent_after_extractor_merge():
    default_agent = _state_agent("default", {"source": "default"})
    selected_agent = _state_agent("selected", {"source": "selected"})
    resolver_inputs = []

    async def extractor(request, input_data):
        return {"state_agent": request.headers["x-state-agent"]}

    async def resolver(request, input_data):
        resolver_inputs.append(input_data)
        if input_data.state["state_agent"] == "selected":
            return selected_agent
        return None

    app = FastAPI()
    add_adk_fastapi_endpoint(
        app,
        default_agent,
        path="/",
        extract_state_from_request=extractor,
        agent_resolver=resolver,
    )
    client = TestClient(app)

    response = client.post(
        "/agents/state",
        json={"threadId": "thread-state"},
        headers={"x-state-agent": "selected"},
    )

    assert response.status_code == 200
    assert response.json()["state"] == {"source": "selected"}
    assert resolver_inputs[0].thread_id == "thread-state"
    assert resolver_inputs[0].state == {"state_agent": "selected"}
    selected_agent._session_manager.get_session_state.assert_awaited_once()
    default_agent._session_manager.get_session_state.assert_not_awaited()


def test_message_history_resolver_routes_by_assistant_name_and_ignores_conflicting_state():
    default_agent = _agent("default")
    originating_agent = _agent("originating")
    state_routed_agent = _agent("state-routed")
    agent_registry = {
        "originating": originating_agent,
        "state-routed": state_routed_agent,
    }
    client = _history_resolver_client(default_agent, agent_registry)

    response = client.post(
        "/agent",
        json=_run_input(
            state={"agent": "state-routed"},
            messages=[
                _assistant_tool_message(
                    message_id="assistant-1",
                    name="originating",
                    tool_call_id="tool-call-1",
                ),
                _tool_result_message(
                    message_id="tool-message-1",
                    tool_call_id="tool-call-1",
                ),
            ],
        ).model_dump(),
    )

    assert response.status_code == 200
    originating_agent.run.assert_called_once()
    state_routed_agent.run.assert_not_called()
    default_agent.run.assert_not_called()


def test_message_history_resolver_accepts_messages_directly():
    originating_agent = _agent("originating")
    agent_registry = {"originating": originating_agent}
    messages = [
        _assistant_tool_message(
            message_id="assistant-1",
            name="originating",
            tool_call_id="tool-call-1",
        ),
        _tool_result_message(
            message_id="tool-message-1",
            tool_call_id="tool-call-1",
        ),
    ]

    assert (
        resolve_agent_from_message_history(messages, agent_registry)
        is originating_agent
    )


def test_message_history_resolver_handles_latest_tool_result_from_same_agent_batch():
    originating_agent = _agent("originating")
    agent_registry = {"originating": originating_agent}
    input_data = _run_input(
        messages=[
            _assistant_tool_message(
                message_id="assistant-1",
                name="originating",
                tool_call_id="tool-call-1",
            ),
            _assistant_tool_message(
                message_id="assistant-2",
                name="originating",
                tool_call_id="tool-call-2",
            ),
            _tool_result_message(
                message_id="tool-message-1",
                tool_call_id="tool-call-1",
            ),
            _tool_result_message(
                message_id="tool-message-2",
                tool_call_id="tool-call-2",
            ),
        ],
    )

    assert (
        resolve_agent_from_message_history(input_data.messages, agent_registry)
        is originating_agent
    )


def test_message_history_resolver_ignores_prior_completed_tool_results():
    first_agent = _agent("first")
    second_agent = _agent("second")
    agent_registry = {"first": first_agent, "second": second_agent}
    input_data = _run_input(
        messages=[
            _assistant_tool_message(
                message_id="assistant-first",
                name="first",
                tool_call_id="tool-call-first",
            ),
            _tool_result_message(
                message_id="tool-message-first",
                tool_call_id="tool-call-first",
            ),
            _assistant_tool_message(
                message_id="assistant-second",
                name="second",
                tool_call_id="tool-call-second",
            ),
            _tool_result_message(
                message_id="tool-message-second",
                tool_call_id="tool-call-second",
            ),
        ],
    )

    assert (
        resolve_agent_from_message_history(input_data.messages, agent_registry)
        is second_agent
    )


def test_message_history_resolver_requires_latest_message_to_be_tool_result():
    originating_agent = _agent("originating")
    agent_registry = {"originating": originating_agent}
    input_data = _run_input(
        messages=[
            _assistant_tool_message(
                message_id="assistant-1",
                name="originating",
                tool_call_id="tool-call-1",
            ),
            _tool_result_message(
                message_id="tool-message-1",
                tool_call_id="tool-call-1",
            ),
            UserMessage(id="user-2", role="user", content="next turn"),
        ],
    )

    assert resolve_agent_from_message_history(input_data.messages, agent_registry) is None


def test_message_history_resolver_missing_history_falls_back_to_state_agent():
    default_agent = _agent("default")
    state_routed_agent = _agent("state-routed")
    agent_registry = {"state-routed": state_routed_agent}
    client = _history_resolver_client(default_agent, agent_registry)

    response = client.post(
        "/agent",
        json=_run_input(
            state={"agent": "state-routed"},
            messages=[
                _tool_result_message(
                    message_id="tool-message-1",
                    tool_call_id="tool-call-1",
                ),
            ],
        ).model_dump(),
    )

    assert response.status_code == 200
    state_routed_agent.run.assert_called_once()
    default_agent.run.assert_not_called()


def test_message_history_resolver_unknown_or_missing_name_falls_back_to_state_agent():
    default_agent = _agent("default")
    state_routed_agent = _agent("state-routed")
    agent_registry = {"state-routed": state_routed_agent}
    client = _history_resolver_client(default_agent, agent_registry)

    unknown_name_response = client.post(
        "/agent",
        json=_run_input(
            run_id="run-unknown-name",
            state={"agent": "state-routed"},
            messages=[
                _assistant_tool_message(
                    message_id="assistant-unknown",
                    name="unknown",
                    tool_call_id="tool-call-unknown",
                ),
                _tool_result_message(
                    message_id="tool-message-unknown",
                    tool_call_id="tool-call-unknown",
                ),
            ],
        ).model_dump(),
    )
    missing_name_response = client.post(
        "/agent",
        json=_run_input(
            run_id="run-missing-name",
            state={"agent": "state-routed"},
            messages=[
                _assistant_tool_message(
                    message_id="assistant-missing",
                    name=None,
                    tool_call_id="tool-call-missing",
                ),
                _tool_result_message(
                    message_id="tool-message-missing",
                    tool_call_id="tool-call-missing",
                ),
            ],
        ).model_dump(),
    )

    assert unknown_name_response.status_code == 200
    assert missing_name_response.status_code == 200
    assert state_routed_agent.run.call_count == 2
    default_agent.run.assert_not_called()


def test_message_history_resolver_uses_latest_tool_message_owner():
    default_agent = _agent("default")
    first_agent = _agent("first")
    second_agent = _agent("second")
    state_routed_agent = _agent("state-routed")
    agent_registry = {
        "first": first_agent,
        "second": second_agent,
        "state-routed": state_routed_agent,
    }
    client = _history_resolver_client(default_agent, agent_registry)

    response = client.post(
        "/agent",
        json=_run_input(
            state={"agent": "state-routed"},
            messages=[
                _assistant_tool_message(
                    message_id="assistant-first",
                    name="first",
                    tool_call_id="tool-call-first",
                ),
                _assistant_tool_message(
                    message_id="assistant-second",
                    name="second",
                    tool_call_id="tool-call-second",
                ),
                _tool_result_message(
                    message_id="tool-message-first",
                    tool_call_id="tool-call-first",
                ),
                _tool_result_message(
                    message_id="tool-message-second",
                    tool_call_id="tool-call-second",
                ),
            ],
        ).model_dump(),
    )

    assert response.status_code == 200
    second_agent.run.assert_called_once()
    first_agent.run.assert_not_called()
    state_routed_agent.run.assert_not_called()
    default_agent.run.assert_not_called()


def test_message_history_resolver_returns_none_without_inbound_tool_messages():
    originating_agent = _agent("originating")
    agent_registry = {"originating": originating_agent}
    input_data = _run_input(
        messages=[
            _assistant_tool_message(
                message_id="assistant-1",
                name="originating",
                tool_call_id="tool-call-1",
            )
        ],
    )

    assert resolve_agent_from_message_history(input_data.messages, agent_registry) is None


def test_message_history_resolver_is_exported_from_package():
    from ag_ui_adk import resolve_agent_from_message_history as package_export
    from ag_ui_adk.endpoint import resolve_agent_from_message_history as endpoint_export

    assert package_export is endpoint_export
