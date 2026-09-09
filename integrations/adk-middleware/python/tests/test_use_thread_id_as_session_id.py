# tests/test_use_thread_id_as_session_id.py

"""Tests for the use_thread_id_as_session_id feature."""

import pytest
from unittest.mock import Mock, AsyncMock, patch
from types import SimpleNamespace

from ag_ui_adk import ADKAgent, SessionManager
from ag_ui_adk.session_manager import THREAD_ID_STATE_KEY, APP_NAME_STATE_KEY, USER_ID_STATE_KEY
from ag_ui.core import RunAgentInput, UserMessage
from google.adk.agents import Agent
from google.adk.sessions import InMemorySessionService


class TestSessionManagerDirectLookup:
    """Tests for SessionManager with use_thread_id_as_session_id=True."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        """Reset session manager before each test."""
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def session_service(self):
        return InMemorySessionService()

    @pytest.fixture
    def manager(self, session_service):
        return SessionManager(
            session_service=session_service,
            use_thread_id_as_session_id=True,
        )

    @pytest.fixture
    def manager_scan(self, session_service):
        """Manager with the default scan-based lookup (for comparison)."""
        SessionManager.reset_instance()
        return SessionManager(
            session_service=session_service,
            use_thread_id_as_session_id=False,
        )

    @pytest.mark.asyncio
    async def test_create_session_uses_thread_id(self, manager, session_service):
        """Session is created with session_id == thread_id."""
        session, backend_id = await manager.get_or_create_session(
            thread_id="thread-abc",
            app_name="app1",
            user_id="user1",
        )
        assert backend_id == "thread-abc"
        assert session.id == "thread-abc"

    @pytest.mark.asyncio
    async def test_get_existing_session_direct_lookup(self, manager, session_service):
        """Second call returns the same session via direct O(1) lookup."""
        session1, id1 = await manager.get_or_create_session(
            thread_id="thread-abc",
            app_name="app1",
            user_id="user1",
        )
        session2, id2 = await manager.get_or_create_session(
            thread_id="thread-abc",
            app_name="app1",
            user_id="user1",
        )
        assert id1 == id2 == "thread-abc"

    @pytest.mark.asyncio
    async def test_does_not_call_list_sessions(self, manager, session_service):
        """Direct lookup path should never call list_sessions."""
        with patch.object(session_service, "list_sessions", wraps=session_service.list_sessions) as spy:
            await manager.get_or_create_session(
                thread_id="thread-no-scan",
                app_name="app1",
                user_id="user1",
            )
            # Second call — should be a direct get, not a scan
            await manager.get_or_create_session(
                thread_id="thread-no-scan",
                app_name="app1",
                user_id="user1",
            )
            spy.assert_not_called()

    @pytest.mark.asyncio
    async def test_find_session_by_thread_id_uses_direct_lookup(
        self, manager, session_service
    ):
        """Cold-cache recovery should look up the thread ID without scanning."""
        await manager.get_or_create_session(
            thread_id="thread-cold-cache",
            app_name="app1",
            user_id="user1",
        )

        with (
            patch.object(
                session_service,
                "get_session",
                wraps=session_service.get_session,
            ) as get_session,
            patch.object(
                session_service,
                "list_sessions",
                wraps=session_service.list_sessions,
            ) as list_sessions,
            patch.object(
                manager,
                "_cache_session",
                wraps=manager._cache_session,
            ) as cache_session,
        ):
            session = await manager._find_session_by_thread_id(
                app_name="app1",
                user_id="user1",
                thread_id="thread-cold-cache",
            )

        assert session is not None
        assert session.id == "thread-cold-cache"
        get_session.assert_awaited_once_with(
            session_id="thread-cold-cache",
            app_name="app1",
            user_id="user1",
        )
        list_sessions.assert_not_called()
        cache_session.assert_called_once_with(
            "thread-cold-cache",
            "app1",
            "user1",
            session,
        )

    @pytest.mark.asyncio
    async def test_stores_thread_id_in_state(self, manager, session_service):
        """Even with direct lookup, thread_id metadata is stored in state."""
        session, _ = await manager.get_or_create_session(
            thread_id="thread-meta",
            app_name="app1",
            user_id="user1",
        )
        assert session.state.get(THREAD_ID_STATE_KEY) == "thread-meta"
        assert session.state.get(APP_NAME_STATE_KEY) == "app1"
        assert session.state.get(USER_ID_STATE_KEY) == "user1"

    @pytest.mark.asyncio
    async def test_initial_state_preserved(self, manager, session_service):
        """Initial state is merged with metadata keys."""
        session, _ = await manager.get_or_create_session(
            thread_id="thread-state",
            app_name="app1",
            user_id="user1",
            initial_state={"user_pref": "dark"},
        )
        assert session.state.get("user_pref") == "dark"
        assert session.state.get(THREAD_ID_STATE_KEY) == "thread-state"

    @pytest.mark.asyncio
    async def test_multiple_threads_independent(self, manager, session_service):
        """Different thread_ids create independent sessions."""
        _, id1 = await manager.get_or_create_session(
            thread_id="thread-1",
            app_name="app1",
            user_id="user1",
        )
        _, id2 = await manager.get_or_create_session(
            thread_id="thread-2",
            app_name="app1",
            user_id="user1",
        )
        assert id1 == "thread-1"
        assert id2 == "thread-2"
        assert id1 != id2

    @pytest.mark.asyncio
    async def test_session_tracking(self, manager):
        """Sessions are tracked for cleanup/enumeration."""
        await manager.get_or_create_session(
            thread_id="thread-track",
            app_name="app1",
            user_id="user1",
        )
        assert manager.get_session_count() == 1
        assert manager.get_user_session_count("user1") == 1

    @pytest.mark.asyncio
    async def test_race_condition_retry(self, manager, session_service):
        """If create_session fails (race), retries with get_session."""
        # First, create a session normally
        await manager.get_or_create_session(
            thread_id="thread-race",
            app_name="app1",
            user_id="user1",
        )

        # Simulate race: get_session returns None first, create fails, retry succeeds
        original_get = session_service.get_session
        original_create = session_service.create_session

        call_count = {"get": 0}

        async def flaky_get(**kwargs):
            call_count["get"] += 1
            if call_count["get"] == 1:
                return None  # First get misses
            return await original_get(**kwargs)

        async def failing_create(**kwargs):
            raise Exception("Already exists")

        # Reset instance to test the _get_or_create_by_thread_id path directly
        SessionManager.reset_instance()
        manager2 = SessionManager(
            session_service=session_service,
            use_thread_id_as_session_id=True,
        )

        with patch.object(session_service, "get_session", side_effect=flaky_get), \
             patch.object(session_service, "create_session", side_effect=failing_create):
            session, sid = await manager2.get_or_create_session(
                thread_id="thread-race",
                app_name="app1",
                user_id="user1",
            )
            assert sid == "thread-race"


class TestSessionManagerScanPath:
    """Verify default scan path still works when flag is False."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def session_service(self):
        return InMemorySessionService()

    @pytest.fixture
    def manager(self, session_service):
        return SessionManager(
            session_service=session_service,
            use_thread_id_as_session_id=False,
        )

    @pytest.mark.asyncio
    async def test_default_lets_backend_generate_id(self, manager, session_service):
        """Default mode lets backend generate session_id (different from thread_id)."""
        session, backend_id = await manager.get_or_create_session(
            thread_id="thread-scan",
            app_name="app1",
            user_id="user1",
        )
        # InMemorySessionService generates its own IDs
        # The session should have thread_id in state, but session.id may differ
        assert session.state.get(THREAD_ID_STATE_KEY) == "thread-scan"

    @pytest.mark.asyncio
    async def test_scan_finds_existing_session(self, manager, session_service):
        """Scan path can recover existing sessions via list_sessions."""
        session1, id1 = await manager.get_or_create_session(
            thread_id="thread-find",
            app_name="app1",
            user_id="user1",
        )
        session2, id2 = await manager.get_or_create_session(
            thread_id="thread-find",
            app_name="app1",
            user_id="user1",
        )
        assert id1 == id2


class TestADKAgentWithThreadIdAsSessionId:
    """Tests for ADKAgent with use_thread_id_as_session_id=True."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def mock_agent(self):
        agent = Mock(spec=Agent)
        agent.name = "test_agent"
        agent.instruction = "Test instruction"
        agent.tools = []
        return agent

    @pytest.fixture
    def adk_agent(self, mock_agent):
        return ADKAgent(
            adk_agent=mock_agent,
            app_name="test_app",
            user_id="test_user",
            use_in_memory_services=True,
            use_thread_id_as_session_id=True,
        )

    @pytest.fixture
    def sample_input(self):
        return RunAgentInput(
            thread_id="direct-thread-123",
            run_id="run_001",
            messages=[
                UserMessage(id="msg1", role="user", content="Hello")
            ],
            context=[],
            state={},
            tools=[],
            forwarded_props={},
        )

    @pytest.mark.asyncio
    async def test_ensure_session_uses_thread_id_as_session_id(self, adk_agent, sample_input):
        """_ensure_session_exists creates session with thread_id as session_id."""
        session, backend_id = await adk_agent._ensure_session_exists(
            app_name="test_app",
            user_id="test_user",
            thread_id="direct-thread-123",
            initial_state={},
        )
        assert backend_id == "direct-thread-123"
        assert session.id == "direct-thread-123"

    @pytest.mark.asyncio
    async def test_cache_populated_after_session_creation(self, adk_agent, sample_input):
        """Session lookup cache should be populated after session creation."""
        await adk_agent._ensure_session_exists(
            app_name="test_app",
            user_id="test_user",
            thread_id="cached-thread",
            initial_state={},
        )
        cached = adk_agent._session_lookup_cache.get(("cached-thread", "test_user"))
        assert cached is not None
        assert cached[0] == "cached-thread"  # session_id == thread_id

    @pytest.mark.asyncio
    async def test_second_call_uses_cache(self, adk_agent):
        """Second call to _ensure_session_exists should use cache, not re-create."""
        await adk_agent._ensure_session_exists(
            app_name="test_app",
            user_id="test_user",
            thread_id="reuse-thread",
            initial_state={},
        )
        # Second call
        session2, id2 = await adk_agent._ensure_session_exists(
            app_name="test_app",
            user_id="test_user",
            thread_id="reuse-thread",
            initial_state={},
        )
        assert id2 == "reuse-thread"

    @pytest.mark.asyncio
    async def test_full_run_with_direct_lookup(self, adk_agent, sample_input):
        """Full run() call works end-to-end with use_thread_id_as_session_id=True."""
        with patch.object(adk_agent, '_create_runner') as mock_create_runner:
            mock_runner = AsyncMock()
            mock_runner.close = AsyncMock()

            async def mock_run_async(*args, **kwargs):
                mock_event = Mock()
                mock_event.id = "event1"
                mock_event.author = "test_agent"
                mock_event.content = Mock()
                mock_event.content.parts = [Mock(text="Response")]
                mock_event.partial = False
                mock_event.actions = None
                mock_event.get_function_calls = Mock(return_value=[])
                mock_event.get_function_responses = Mock(return_value=[])
                yield mock_event

            mock_runner.run_async = mock_run_async
            mock_create_runner.return_value = mock_runner

            events = [event async for event in adk_agent.run(sample_input)]

        # Should have events (at minimum RUN_STARTED + some content + RUN_FINISHED)
        assert len(events) > 0
        # Verify the session was created with thread_id as session_id
        cached = adk_agent._session_lookup_cache.get(("direct-thread-123", "test_user"))
        assert cached is not None
        assert cached[0] == "direct-thread-123"

    @pytest.mark.asyncio
    async def test_parameter_defaults_to_false(self):
        """use_thread_id_as_session_id defaults to False."""
        SessionManager.reset_instance()
        agent = Mock(spec=Agent)
        agent.name = "test"
        adk = ADKAgent(
            adk_agent=agent,
            app_name="app",
            user_id="user",
        )
        assert adk._session_manager._use_thread_id_as_session_id is False


class TestAgentsStateEndpointWithDirectLookup:
    """Tests for /agents/state endpoint with use_thread_id_as_session_id=True."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def mock_agent(self):
        agent = Mock(spec=Agent)
        agent.name = "test_agent"
        agent.instruction = "Test instruction"
        agent.tools = []
        return agent

    @pytest.fixture
    def adk_agent(self, mock_agent):
        return ADKAgent(
            adk_agent=mock_agent,
            app_name="test_app",
            user_id="test_user",
            use_in_memory_services=True,
            use_thread_id_as_session_id=True,
        )

    @pytest.fixture
    def app(self, adk_agent):
        from fastapi import FastAPI
        from ag_ui_adk import add_adk_fastapi_endpoint
        app = FastAPI()
        add_adk_fastapi_endpoint(app, adk_agent)
        return app

    @pytest.fixture
    def client(self, app):
        from starlette.testclient import TestClient
        return TestClient(app)

    @pytest.mark.asyncio
    async def test_agents_state_uses_direct_lookup(self, adk_agent, client):
        """When use_thread_id_as_session_id=True, /agents/state uses O(1) lookup."""
        # Create a session first via the session manager
        session, sid = await adk_agent._session_manager.get_or_create_session(
            thread_id="state-thread-123",
            app_name="test_app",
            user_id="test_user",
        )
        assert sid == "state-thread-123"

        # Ensure the cache is clear so endpoint must look up from backend
        adk_agent._session_lookup_cache.clear()

        # Spy on list_sessions to verify it's NOT called
        with patch.object(
            adk_agent._session_manager._session_service,
            "list_sessions",
            wraps=adk_agent._session_manager._session_service.list_sessions,
        ) as spy:
            response = client.post(
                "/agents/state",
                json={"threadId": "state-thread-123"},
            )
            assert response.status_code == 200
            data = response.json()
            assert data["threadExists"] is True
            assert data["threadId"] == "state-thread-123"
            # The key assertion: list_sessions should NOT be called
            spy.assert_not_called()

    @pytest.mark.asyncio
    async def test_agents_state_nonexistent_thread(self, adk_agent, client):
        """/agents/state returns threadExists=False for unknown thread."""
        response = client.post(
            "/agents/state",
            json={"threadId": "nonexistent-thread"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["threadExists"] is False
