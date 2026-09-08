#!/usr/bin/env python
"""Tests for FastAPI endpoint functionality."""
from fastapi.exceptions import RequestValidationError

import pytest
from unittest.mock import MagicMock, patch, AsyncMock
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request

from ag_ui.core import RunAgentInput, UserMessage, RunStartedEvent, RunErrorEvent, EventType
from ag_ui_adk.endpoint import add_adk_fastapi_endpoint, create_adk_app, make_extract_headers
from ag_ui_adk.adk_agent import ADKAgent


class TestAddADKFastAPIEndpoint:
    """Tests for add_adk_fastapi_endpoint function."""

    @pytest.fixture
    def mock_agent(self):
        """Create a mock ADKAgent."""
        agent = MagicMock(spec=ADKAgent)
        return agent

    @pytest.fixture(
        params=[FastAPI, APIRouter]
    )
    def app(self, request):
        """Create a FastAPI app or APIRouter."""
        return request.param()

    def get_test_app(self, app):
        """Return app suitable for TestClient (wrap APIRouter in FastAPI if needed).

        Note: This must be called AFTER routes are added to the router,
        since include_router copies routes at the time of inclusion.
        """
        if isinstance(app, APIRouter):
            fastapi_app = FastAPI()
            fastapi_app.include_router(app)
            return fastapi_app
        return app

    @pytest.fixture
    def sample_input(self):
        """Create sample RunAgentInput."""
        return RunAgentInput(
            thread_id="test_thread",
            run_id="test_run",
            messages=[
                UserMessage(id="1", role="user", content="Hello")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

    def test_add_endpoint_default_path(self, app, mock_agent):
        """Test adding endpoint with default path."""
        add_adk_fastapi_endpoint(app, mock_agent)

        # Check that endpoint was added
        routes = [route.path for route in app.routes]
        assert "/" in routes

    def test_add_endpoint_custom_path(self, app, mock_agent):
        """Test adding endpoint with custom path."""
        add_adk_fastapi_endpoint(app, mock_agent, path="/custom")

        # Check that endpoint was added
        routes = [route.path for route in app.routes]
        assert "/custom" in routes

    def test_endpoint_method_is_post(self, app, mock_agent):
        """Test that endpoint accepts POST requests."""
        add_adk_fastapi_endpoint(app, mock_agent, path="/test")

        # Find the route
        route = next(route for route in app.routes if route.path == "/test")
        assert "POST" in route.methods

    def test_endpoint_agent_id_extraction(self, app, mock_agent, sample_input):
        """Test that agent_id is extracted from path."""
        # Mock agent to return an event
        mock_event = RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id="test_thread",
            run_id="test_run"
        )
        mock_agent.run = AsyncMock(return_value=AsyncMock(__aiter__=AsyncMock(return_value=iter([mock_event]))))

        add_adk_fastapi_endpoint(app, mock_agent, path="/agent123")

        client = TestClient(self.get_test_app(app))
        response = client.post("/agent123", json=sample_input.model_dump())

        # Agent should be called with just the input data
        mock_agent.run.assert_called_once_with(sample_input)
        assert response.status_code == 200

    def test_endpoint_root_path_agent_id(self, app, mock_agent, sample_input):
        """Test agent_id extraction for root path."""
        # Mock agent to return an event
        mock_event = RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id="test_thread",
            run_id="test_run"
        )
        mock_agent.run = AsyncMock(return_value=AsyncMock(__aiter__=AsyncMock(return_value=iter([mock_event]))))

        add_adk_fastapi_endpoint(app, mock_agent, path="/")

        client = TestClient(self.get_test_app(app))
        response = client.post("/", json=sample_input.model_dump())

        # Agent should be called with just the input data
        mock_agent.run.assert_called_once_with(sample_input)
        assert response.status_code == 200

    @patch('ag_ui_adk.endpoint.logger')
    def test_endpoint_successful_event_streaming(self, mock_logger, app, mock_agent, sample_input):
        """Test successful event streaming."""
        # Mock agent to return multiple events
        mock_event1 = RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id="test_thread",
            run_id="test_run"
        )
        mock_event2 = RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id="test_thread",
            run_id="test_run"
        )

        async def mock_agent_run(input_data):
            yield mock_event1
            yield mock_event2

        mock_agent.run = mock_agent_run

        add_adk_fastapi_endpoint(app, mock_agent, path="/test")

        client = TestClient(self.get_test_app(app))
        response = client.post("/test", json=sample_input.model_dump())

        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")

        # Check that both events were serialized and logged as HTTP Response debug lines
        assert mock_logger.debug.call_count == 2
        # Each yielded event produces a `data: {json}\n\n` frame in the SSE wire format
        assert response.text.count("data: ") == 2

    @patch('ag_ui_adk.endpoint.logger')
    def test_endpoint_encoding_error_handling(self, mock_logger, app, mock_agent, sample_input):
        """Test handling of encoding errors."""
        # Mock event whose first model_dump_json call raises. The RunErrorEvent
        # that the endpoint creates after catching the failure is a real
        # Pydantic model and will serialize normally.
        mock_event = MagicMock()
        mock_event.model_dump_json.side_effect = ValueError("Encoding failed")

        async def mock_agent_run(input_data):
            yield mock_event

        mock_agent.run = mock_agent_run

        add_adk_fastapi_endpoint(app, mock_agent, path="/test")

        client = TestClient(self.get_test_app(app))
        response = client.post("/test", json=sample_input.model_dump())

        assert response.status_code == 200

        # Should log encoding error
        mock_logger.error.assert_called_once()
        assert "Event encoding error" in str(mock_logger.error.call_args)

        # Stream should contain a RUN_ERROR event with ENCODING_ERROR code
        assert '"code":"ENCODING_ERROR"' in response.text
        assert "Event encoding failed" in response.text

    @patch('ag_ui_adk.endpoint.RunErrorEvent')
    @patch('ag_ui_adk.endpoint.logger')
    def test_endpoint_encoding_error_double_failure(self, mock_logger, mock_run_error_event_cls, app, mock_agent, sample_input):
        """Test handling when both event and error event encoding fail."""
        # First, make the initial event's model_dump_json fail so the endpoint
        # enters the error-handling branch, then make the RunErrorEvent
        # constructed inside that branch also fail to serialize, exercising
        # the basic SSE error fallback.
        mock_event = MagicMock()
        mock_event.model_dump_json.side_effect = ValueError("Always fails")

        mock_error_event_instance = MagicMock()
        mock_error_event_instance.model_dump_json.side_effect = ValueError("Also fails")
        mock_run_error_event_cls.return_value = mock_error_event_instance

        async def mock_agent_run(input_data):
            yield mock_event

        mock_agent.run = mock_agent_run

        add_adk_fastapi_endpoint(app, mock_agent, path="/test")

        client = TestClient(self.get_test_app(app))
        response = client.post("/test", json=sample_input.model_dump())

        assert response.status_code == 200

        # Should log both encoding errors
        assert mock_logger.error.call_count == 2
        assert "Event encoding error" in str(mock_logger.error.call_args_list[0])
        assert "Failed to encode error event" in str(mock_logger.error.call_args_list[1])

        # Should yield basic SSE error
        response_text = response.text
        assert 'event: error\ndata: {"error": "Event encoding failed"}\n\n' in response_text

    @patch('ag_ui_adk.endpoint.logger')
    def test_endpoint_agent_error_handling(self, mock_logger, app, mock_agent, sample_input):
        """Test handling of agent execution errors."""
        # Mock agent to raise an error
        async def mock_agent_run(input_data):
            raise RuntimeError("Agent failed")
            yield  # pragma: no cover - unreachable, makes this an async generator

        mock_agent.run = mock_agent_run

        add_adk_fastapi_endpoint(app, mock_agent, path="/test")

        client = TestClient(self.get_test_app(app))
        response = client.post("/test", json=sample_input.model_dump())

        assert response.status_code == 200

        # Should log agent error
        mock_logger.error.assert_called_once()
        assert "ADKAgent error" in str(mock_logger.error.call_args)

        # Stream should contain a RUN_ERROR event with AGENT_ERROR code
        assert '"code":"AGENT_ERROR"' in response.text
        assert "Agent execution failed" in response.text

    @patch('ag_ui_adk.endpoint.RunErrorEvent')
    @patch('ag_ui_adk.endpoint.logger')
    def test_endpoint_agent_error_encoding_failure(self, mock_logger, mock_run_error_event_cls, app, mock_agent, sample_input):
        """Test handling when agent error event encoding fails."""
        mock_error_event_instance = MagicMock()
        mock_error_event_instance.model_dump_json.side_effect = ValueError("Encoding failed")
        mock_run_error_event_cls.return_value = mock_error_event_instance

        # Mock agent to raise an error
        async def mock_agent_run(input_data):
            raise RuntimeError("Agent failed")
            yield  # pragma: no cover - unreachable, makes this an async generator

        mock_agent.run = mock_agent_run

        add_adk_fastapi_endpoint(app, mock_agent, path="/test")

        client = TestClient(self.get_test_app(app))
        response = client.post("/test", json=sample_input.model_dump())

        assert response.status_code == 200

        # Should log both errors
        assert mock_logger.error.call_count == 2
        assert "ADKAgent error" in str(mock_logger.error.call_args_list[0])
        assert "Failed to encode agent error event" in str(mock_logger.error.call_args_list[1])

        # Should yield basic SSE error
        response_text = response.text
        assert 'event: error\ndata: {"error": "Agent execution failed"}\n\n' in response_text

    def test_endpoint_returns_event_source_response(self, app, mock_agent, sample_input):
        """Test that endpoint returns an EventSourceResponse with SSE keep-alive headers."""
        # Mock agent to return an event
        mock_event = RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id="test_thread",
            run_id="test_run"
        )

        async def mock_agent_run(input_data):
            yield mock_event

        mock_agent.run = mock_agent_run

        add_adk_fastapi_endpoint(app, mock_agent, path="/test")

        client = TestClient(self.get_test_app(app))
        response = client.post("/test", json=sample_input.model_dump())

        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        # The SSE response sets these headers so proxies and Node undici
        # sockets don't buffer/close idle streams. ``Cache-Control`` may be
        # either ``no-cache`` or ``no-store`` -- both prevent caches from
        # holding/replaying the stream; sse-starlette defaults to ``no-store``
        # which is the stricter, semantically more correct directive for SSE.
        assert response.headers["cache-control"] in {"no-cache", "no-store"}
        assert response.headers.get("x-accel-buffering") == "no"

    def test_endpoint_proto_accept_uses_streaming_response(self, app, mock_agent, sample_input):
        """Test that a non-SSE Accept header routes through the legacy StreamingResponse path.

        Locks in the Accept-header content negotiation regression mitigation
        from PR #1566 review: when ``EventEncoder.get_content_type()`` returns
        a non-``text/event-stream`` value (e.g. a future binary framing under
        ``application/vnd.ag-ui.event+proto``), the endpoint must fall back to
        ``StreamingResponse(encoder.encode(...))`` instead of
        ``EventSourceResponse``. We patch ``EventEncoder`` itself so we can
        simulate the future binary encoder without depending on the SDK
        actually shipping one.
        """
        mock_event = RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id="test_thread",
            run_id="test_run",
        )

        async def mock_agent_run(input_data):
            yield mock_event

        mock_agent.run = mock_agent_run

        proto_media_type = "application/vnd.ag-ui.event+proto"
        encoded_payload = b"\x00binary-proto-payload\x01"

        mock_encoder_instance = MagicMock()
        mock_encoder_instance.get_content_type.return_value = proto_media_type
        mock_encoder_instance.encode.return_value = encoded_payload

        with patch("ag_ui_adk.endpoint.EventEncoder", return_value=mock_encoder_instance) as mock_encoder_cls:
            add_adk_fastapi_endpoint(app, mock_agent, path="/test")

            client = TestClient(self.get_test_app(app))
            response = client.post(
                "/test",
                json=sample_input.model_dump(),
                headers={"accept": proto_media_type},
            )

        assert response.status_code == 200
        assert response.headers["content-type"].startswith(proto_media_type)
        # SSE-only headers must not be present on the legacy streaming path;
        # in particular keep-alive pings (which are SSE comments) would corrupt
        # a binary stream, so the response goes through plain StreamingResponse.
        assert "x-accel-buffering" not in {k.lower() for k in response.headers.keys()}
        # Encoder was constructed with the request's Accept header and used to
        # encode the streamed event, confirming the legacy path is in play.
        mock_encoder_cls.assert_called_once_with(accept=proto_media_type)
        mock_encoder_instance.encode.assert_called_with(mock_event)
        assert encoded_payload in response.content

    def test_endpoint_input_validation(self, app, mock_agent):
        """Test that endpoint validates input as RunAgentInput."""
        add_adk_fastapi_endpoint(app, mock_agent, path="/test")

        client = TestClient(self.get_test_app(app))

        # Send invalid JSON - both FastAPI and APIRouter (wrapped in FastAPI) return 422
        response = client.post("/test", json={"invalid": "data"})

        # Should return 422 for validation error
        assert response.status_code == 422

    def test_endpoint_no_accept_header(self, app, mock_agent, sample_input):
        """Test endpoint behavior when no accept header is provided.

        With the native ``EventSourceResponse`` the endpoint no longer branches
        on the ``Accept`` header (FastAPI's SSE layer always emits
        ``text/event-stream``), so this test just verifies the endpoint still
        succeeds when the client sends TestClient's default ``*/*`` accept.
        """
        mock_event = RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id="test_thread",
            run_id="test_run"
        )

        async def mock_agent_run(input_data):
            yield mock_event

        mock_agent.run = mock_agent_run

        add_adk_fastapi_endpoint(app, mock_agent, path="/test")

        client = TestClient(self.get_test_app(app))
        response = client.post("/test", json=sample_input.model_dump())

        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")


class TestCreateADKApp:
    """Tests for create_adk_app function."""

    @pytest.fixture
    def mock_agent(self):
        """Create a mock ADKAgent."""
        return MagicMock(spec=ADKAgent)

    def test_create_app_basic(self, mock_agent):
        """Test creating app with basic configuration."""
        app = create_adk_app(mock_agent)

        assert isinstance(app, FastAPI)
        assert app.title == "ADK Middleware for AG-UI Protocol"

        # Check that endpoint was added
        routes = [route.path for route in app.routes]
        assert "/" in routes

    def test_create_app_custom_path(self, mock_agent):
        """Test creating app with custom path."""
        app = create_adk_app(mock_agent, path="/custom")

        assert isinstance(app, FastAPI)

        # Check that endpoint was added with custom path
        routes = [route.path for route in app.routes]
        assert "/custom" in routes

    @patch('ag_ui_adk.endpoint.add_adk_fastapi_endpoint')
    def test_create_app_calls_add_endpoint(self, mock_add_endpoint, mock_agent):
        """Test that create_adk_app calls add_adk_fastapi_endpoint."""
        app = create_adk_app(mock_agent, path="/test")

        # Should call add_adk_fastapi_endpoint with correct parameters
        mock_add_endpoint.assert_called_once_with(
            app, mock_agent, "/test", extract_headers = None, extract_state_from_request=None, agent_resolver=None
        )

    @patch('ag_ui_adk.endpoint.add_adk_fastapi_endpoint')
    def test_create_app_passes_extract_headers(self, mock_add_endpoint, mock_agent):
        """Test that create_adk_app passes extract_headers to add_adk_fastapi_endpoint."""
        async def extract_headers(request, input_data):
            return {}
        app = create_adk_app(mock_agent, path="/test",extract_headers = ['Authorization'], extract_state_from_request=extract_headers)

        # Should call add_adk_fastapi_endpoint with extract_headers
        mock_add_endpoint.assert_called_once_with(
            app, mock_agent, "/test", extract_headers = ['Authorization'], extract_state_from_request=extract_headers, agent_resolver=None
        )

    def test_create_app_default_path(self, mock_agent):
        """Test creating app with default path."""
        app = create_adk_app(mock_agent)

        routes = [route.path for route in app.routes]
        assert "/" in routes

    def test_create_app_functional_test(self, mock_agent):
        """Test that created app is functional."""
        # Mock agent to return an event
        mock_event = RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id="test_thread",
            run_id="test_run"
        )

        async def mock_agent_run(input_data):
            yield mock_event

        mock_agent.run = mock_agent_run

        app = create_adk_app(mock_agent)

        client = TestClient(app)
        sample_input = RunAgentInput(
            thread_id="test_thread",
            run_id="test_run",
            messages=[UserMessage(id="1", role="user", content="Hello")],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

        response = client.post("/", json=sample_input.model_dump())

        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")


class TestEndpointIntegration:
    """Integration tests for endpoint functionality."""

    @pytest.fixture
    def mock_agent(self):
        """Create a mock ADKAgent."""
        return MagicMock(spec=ADKAgent)

    @pytest.fixture
    def sample_input(self):
        """Create sample RunAgentInput."""
        return RunAgentInput(
            thread_id="integration_thread",
            run_id="integration_run",
            messages=[
                UserMessage(id="1", role="user", content="Integration test message")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

    def test_full_endpoint_flow(self, mock_agent, sample_input):
        """Test complete endpoint flow from request to response."""
        # Mock agent to return multiple events
        events = [
            RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id="integration_thread",
                run_id="integration_run"
            ),
            RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id="integration_thread",
                run_id="integration_run"
            )
        ]

        call_args = []

        async def mock_agent_run(input_data):
            call_args.append(input_data)
            for event in events:
                yield event

        mock_agent.run = mock_agent_run

        app = create_adk_app(mock_agent, path="/integration")

        client = TestClient(app)
        response = client.post(
            "/integration",
            json=sample_input.model_dump(),
            headers={"accept": "text/event-stream"}
        )

        # Verify response
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")

        # Verify agent was called correctly
        assert len(call_args) == 1
        assert call_args[0] == sample_input

        # Verify each event produced its own SSE `data: {json}\n\n` frame
        assert response.text.count("data: ") == len(events)

    def test_endpoint_with_different_http_methods(self, mock_agent):
        """Test that endpoint only accepts POST requests."""
        app = create_adk_app(mock_agent, path="/test")

        client = TestClient(app)

        # POST should work
        response = client.post("/test", json={})
        assert response.status_code in [200, 422]  # 422 for validation error

        # GET should not work
        response = client.get("/test")
        assert response.status_code == 405  # Method not allowed

        # PUT should not work
        response = client.put("/test", json={})
        assert response.status_code == 405

        # DELETE should not work
        response = client.delete("/test")
        assert response.status_code == 405

    def test_endpoint_with_long_running_stream(self, mock_agent, sample_input):
        """Test endpoint with long-running event stream."""
        # Mock agent to return many events
        async def mock_agent_run(input_data):
            for i in range(10):
                yield RunStartedEvent(
                    type=EventType.RUN_STARTED,
                    thread_id=f"thread_{i}",
                    run_id=f"run_{i}"
                )

        mock_agent.run = mock_agent_run

        app = create_adk_app(mock_agent, path="/long_stream")

        client = TestClient(app)
        response = client.post("/long_stream", json=sample_input.model_dump())

        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")

        # Each of the 10 events produces one SSE `data: {json}\n\n` frame
        assert response.text.count("data: ") == 10

class TestExtractHeaders:
    """Tests for extract_headers functionality."""

    @pytest.fixture
    def mock_agent(self):
        """Create a mock ADKAgent."""
        return MagicMock(spec=ADKAgent)

    @pytest.fixture
    def sample_input(self):
        """Create sample RunAgentInput."""
        return RunAgentInput(
            thread_id="test_thread",
            run_id="test_run",
            messages=[UserMessage(id="1", role="user", content="Hello")],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

    def test_extract_headers_into_nested_state(self, mock_agent, sample_input):
        """Test that headers are extracted into state.headers."""
        captured_input = []

        async def mock_agent_run(input_data):
            captured_input.append(input_data)
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id="test_thread",
                run_id="test_run"
            )

        mock_agent.run = mock_agent_run

        app = FastAPI()
        add_adk_fastapi_endpoint(
            app, mock_agent, "/test",
            extract_state_from_request=make_extract_headers(["x-user-id", "x-tenant-id"])
        )

        client = TestClient(app)
        response = client.post(
            "/test",
            json=sample_input.model_dump(),
            headers={"x-user-id": "user123", "x-tenant-id": "tenant456"}
        )

        assert response.status_code == 200
        assert len(captured_input) == 1
        # Headers should be in nested state.headers
        assert captured_input[0].state["headers"]["user_id"] == "user123"
        assert captured_input[0].state["headers"]["tenant_id"] == "tenant456"

    def test_extract_headers_strips_x_prefix(self, mock_agent, sample_input):
        """Test that x- prefix is stripped from header names."""
        captured_input = []

        async def mock_agent_run(input_data):
            captured_input.append(input_data)
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id="test_thread",
                run_id="test_run"
            )

        mock_agent.run = mock_agent_run

        app = FastAPI()
        add_adk_fastapi_endpoint(
            app, mock_agent, "/test",
            extract_state_from_request=make_extract_headers(["x-user-id"])
        )

        client = TestClient(app)
        response = client.post(
            "/test",
            json=sample_input.model_dump(),
            headers={"x-user-id": "user123"}
        )

        assert response.status_code == 200
        assert len(captured_input) == 1
        # x- prefix should be stripped: x-user-id -> user_id
        assert "user_id" in captured_input[0].state["headers"]
        assert "x-user-id" not in captured_input[0].state["headers"]

    def test_extract_headers_converts_hyphens_to_underscores(self, mock_agent, sample_input):
        """Test that hyphens are converted to underscores in key names."""
        captured_input = []

        async def mock_agent_run(input_data):
            captured_input.append(input_data)
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id="test_thread",
                run_id="test_run"
            )

        mock_agent.run = mock_agent_run

        app = FastAPI()
        add_adk_fastapi_endpoint(
            app, mock_agent, "/test",
            extract_state_from_request=make_extract_headers(["x-some-long-header-name"])
        )

        client = TestClient(app)
        response = client.post(
            "/test",
            json=sample_input.model_dump(),
            headers={"x-some-long-header-name": "value123"}
        )

        assert response.status_code == 200
        assert len(captured_input) == 1
        # Hyphens should be converted: x-some-long-header-name -> some_long_header_name
        assert captured_input[0].state["headers"]["some_long_header_name"] == "value123"

    def test_extract_headers_missing_headers_skipped(self, mock_agent, sample_input):
        """Test that missing headers are silently skipped."""
        captured_input = []

        async def mock_agent_run(input_data):
            captured_input.append(input_data)
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id="test_thread",
                run_id="test_run"
            )

        mock_agent.run = mock_agent_run

        app = FastAPI()
        add_adk_fastapi_endpoint(
            app, mock_agent, "/test",
            extract_state_from_request=make_extract_headers(["x-user-id", "x-tenant-id"])
        )

        client = TestClient(app)
        # Only send x-user-id, not x-tenant-id
        response = client.post(
            "/test",
            json=sample_input.model_dump(),
            headers={"x-user-id": "user123"}
        )

        assert response.status_code == 200
        assert len(captured_input) == 1
        assert captured_input[0].state["headers"]["user_id"] == "user123"
        assert "tenant_id" not in captured_input[0].state["headers"]

    def test_extract_headers_client_state_preserved(self, mock_agent):
        """Test that client-provided top-level state is preserved."""
        captured_input = []

        async def mock_agent_run(input_data):
            captured_input.append(input_data)
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id="test_thread",
                run_id="test_run"
            )

        mock_agent.run = mock_agent_run

        app = FastAPI()
        add_adk_fastapi_endpoint(
            app, mock_agent, "/test",
            extract_state_from_request=make_extract_headers(["x-user-id"])
        )

        # Input with existing state
        input_with_state = RunAgentInput(
            thread_id="test_thread",
            run_id="test_run",
            messages=[UserMessage(id="1", role="user", content="Hello")],
            tools=[],
            context=[],
            state={"existing_key": "existing_value", "another_key": "another_value"},
            forwarded_props={}
        )

        client = TestClient(app)
        response = client.post(
            "/test",
            json=input_with_state.model_dump(),
            headers={"x-user-id": "user123"}
        )

        assert response.status_code == 200
        assert len(captured_input) == 1
        # Header value should be in nested headers
        assert captured_input[0].state["headers"]["user_id"] == "user123"
        # Client state should be preserved at top level
        assert captured_input[0].state["existing_key"] == "existing_value"
        assert captured_input[0].state["another_key"] == "another_value"

    def test_extract_headers_client_headers_take_precedence(self, mock_agent):
        """Test that client-provided state.headers takes precedence over extracted headers."""
        captured_input = []

        async def mock_agent_run(input_data):
            captured_input.append(input_data)
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id="test_thread",
                run_id="test_run"
            )

        mock_agent.run = mock_agent_run

        app = FastAPI()
        add_adk_fastapi_endpoint(
            app, mock_agent, "/test",
            extract_state_from_request=make_extract_headers(["x-user-id"])
        )

        # Input with state.headers that conflicts with HTTP header
        input_with_conflicting_headers = RunAgentInput(
            thread_id="test_thread",
            run_id="test_run",
            messages=[UserMessage(id="1", role="user", content="Hello")],
            tools=[],
            context=[],
            state={"headers": {"user_id": "client_user"}},
            forwarded_props={}
        )

        client = TestClient(app)
        response = client.post(
            "/test",
            json=input_with_conflicting_headers.model_dump(),
            headers={"x-user-id": "header_user"}
        )

        assert response.status_code == 200
        assert len(captured_input) == 1
        # Client state.headers should take precedence
        assert captured_input[0].state["headers"]["user_id"] == "client_user"

    def test_no_extract_headers_backward_compatible(self, mock_agent, sample_input):
        """Test that omitting extract_headers works as before."""
        captured_input = []

        async def mock_agent_run(input_data):
            captured_input.append(input_data)
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id="test_thread",
                run_id="test_run"
            )

        mock_agent.run = mock_agent_run

        app = FastAPI()
        # No extract_headers parameter
        add_adk_fastapi_endpoint(app, mock_agent, "/test")

        client = TestClient(app)
        response = client.post(
            "/test",
            json=sample_input.model_dump(),
            headers={"x-user-id": "user123"}
        )

        assert response.status_code == 200
        assert len(captured_input) == 1
        # State should remain empty (headers not extracted)
        assert captured_input[0].state == {}

    def test_extract_headers_with_non_dict_state(self, mock_agent):
        """Test header extraction when input.state is not a dict."""
        captured_input = []

        async def mock_agent_run(input_data):
            captured_input.append(input_data)
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id="test_thread",
                run_id="test_run"
            )

        mock_agent.run = mock_agent_run

        app = FastAPI()
        add_adk_fastapi_endpoint(
            app, mock_agent, "/test",
            extract_state_from_request=make_extract_headers(["x-user-id"])
        )

        # Input with None state
        input_with_none_state = RunAgentInput(
            thread_id="test_thread",
            run_id="test_run",
            messages=[UserMessage(id="1", role="user", content="Hello")],
            tools=[],
            context=[],
            state=None,
            forwarded_props={}
        )

        client = TestClient(app)
        response = client.post(
            "/test",
            json=input_with_none_state.model_dump(),
            headers={"x-user-id": "user123"}
        )

        assert response.status_code == 200
        assert len(captured_input) == 1
        # Should create new state dict with headers
        assert captured_input[0].state["headers"]["user_id"] == "user123"

    def test_extract_headers_case_insensitive(self, mock_agent, sample_input):
        """Test that header names are case-insensitive (HTTP standard)."""
        captured_input = []

        async def mock_agent_run(input_data):
            captured_input.append(input_data)
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id="test_thread",
                run_id="test_run"
            )

        mock_agent.run = mock_agent_run

        app = FastAPI()
        add_adk_fastapi_endpoint(
            app, mock_agent, "/test",
            extract_state_from_request=make_extract_headers(["x-user-id"])
        )

        client = TestClient(app)
        # Client sends mixed-case header (HTTP headers are case-insensitive)
        response = client.post(
            "/test",
            json=sample_input.model_dump(),
            headers={"X-User-Id": "user123"}
        )

        assert response.status_code == 200
        assert len(captured_input) == 1
        # Should extract header regardless of case
        assert captured_input[0].state["headers"]["user_id"] == "user123"

    def test_create_adk_app_with_extract_headers(self, mock_agent, sample_input):
        """Test create_adk_app with extract_headers parameter."""
        captured_input = []

        async def mock_agent_run(input_data):
            captured_input.append(input_data)
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id="test_thread",
                run_id="test_run"
            )

        mock_agent.run = mock_agent_run

        app = create_adk_app(
            mock_agent,
            extract_state_from_request=make_extract_headers(["x-user-id"])
        )

        client = TestClient(app)
        response = client.post(
            "/",
            json=sample_input.model_dump(),
            headers={"x-user-id": "user123"}
        )

        assert response.status_code == 200
        assert len(captured_input) == 1
        assert captured_input[0].state["headers"]["user_id"] == "user123"

    def test_extract_headers_non_x_prefix_header(self, mock_agent, sample_input):
        """Test extracting headers that don't have x- prefix."""
        captured_input = []

        async def mock_agent_run(input_data):
            captured_input.append(input_data)
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id="test_thread",
                run_id="test_run"
            )

        mock_agent.run = mock_agent_run

        app = FastAPI()
        add_adk_fastapi_endpoint(
            app, mock_agent, "/test",
            extract_state_from_request=make_extract_headers(["authorization", "custom-header"])
        )

        client = TestClient(app)
        response = client.post(
            "/test",
            json=sample_input.model_dump(),
            headers={"authorization": "Bearer token123", "custom-header": "custom_value"}
        )

        assert response.status_code == 200
        assert len(captured_input) == 1
        # Non x- headers should just have hyphens converted to underscores
        assert captured_input[0].state["headers"]["authorization"] == "Bearer token123"
        assert captured_input[0].state["headers"]["custom_header"] == "custom_value"

    def test_fail_with_both_extraction_options(self):
        """Test that extract_headers and extract_state_from_request cannot be used together."""
        with pytest.raises(ValueError):
            create_adk_app(
                MagicMock(spec=ADKAgent),
                extract_headers=["x-user-id"],
                extract_state_from_request=make_extract_headers(["x-user-id"]),
            )

    def test_legacy_extract_headers_parameter(self, sample_input):
        """Test that legacy extract_headers parameter is used to make an extract_state_from_request by calling make_extract_headers and that the created function works as expected."""
        app = create_adk_app(
            MagicMock(spec=ADKAgent),
            extract_headers=["x-user-id", "x-tenant-id"]
        )

        # Mock the inner function created by make_extract_headers
        mock_inner_extract_headers_fn = AsyncMock(return_value={})

        # Patch make_extract_headers to return the mock_inner_extract_headers_fn
        with patch('ag_ui_adk.endpoint.make_extract_headers') as mock_make_extract_headers:
            mock_make_extract_headers.return_value = mock_inner_extract_headers_fn

            extract_headers = ["x-user-id", "x-tenant-id"]
            app = create_adk_app(
                MagicMock(spec=ADKAgent),
                extract_headers=extract_headers
            )

            # Ensure make_extract_headers was called with extract_headers list
            mock_make_extract_headers.assert_called_once_with(extract_headers)

            client = TestClient(app)
            response = client.post(
                "/",
                json=sample_input.model_dump(),
                headers={"x-user-id": "user123"}
            )
            assert response.status_code == 200

            # Ensure the inner extract_headers function was called with correct parameters
            request = mock_inner_extract_headers_fn.call_args.args[0]
            assert isinstance(request, Request)
            assert request.headers["x-user-id"] == "user123"

            input= mock_inner_extract_headers_fn.call_args.args[1]
            assert isinstance(input, RunAgentInput)
            assert input == sample_input
