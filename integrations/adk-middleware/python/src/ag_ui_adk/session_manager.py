# src/session_manager.py

"""Session manager that adds production features to ADK's native session service."""

from contextvars import ContextVar
from typing import Dict, Optional, Set, Any, Union, Iterable, Tuple
import asyncio
import logging
import time

logger = logging.getLogger(__name__)

# Keys used to store AG-UI metadata in session state for recovery after restart
THREAD_ID_STATE_KEY = "_ag_ui_thread_id"
APP_NAME_STATE_KEY = "_ag_ui_app_name"
USER_ID_STATE_KEY = "_ag_ui_user_id"
CONTEXT_STATE_KEY = "_ag_ui_context"
INVOCATION_ID_STATE_KEY = "_ag_ui_invocation_id"

_SESSION_READ_CACHE: ContextVar[Optional[Dict[Tuple[str, str, str], Any]]] = (
    ContextVar("ag_ui_adk_session_read_cache", default=None)
)


class SessionManager:
    """Session manager that wraps ADK's session service.

    Adds essential production features:
    - Timeout monitoring based on ADK's lastUpdateTime
    - Cross-user/app session enumeration
    - Per-user session limits
    - Automatic cleanup of expired sessions
    - Optional automatic session memory on deletion
    - State management and updates

    Construction model:
    - ``SessionManager(...)`` builds a regular, isolated instance.
    - ``SessionManager.get_default(...)`` returns a process-wide shared instance,
      lazily constructed on first call. ``ADKAgent`` uses this when no explicit
      session service is supplied, preserving the historical default behavior
      where multiple agents share one manager.
    """

    _default: Optional["SessionManager"] = None

    def __init__(
        self,
        session_service=None,
        memory_service=None,
        session_timeout_seconds: int = 1200,  # 20 minutes default
        cleanup_interval_seconds: int = 300,  # 5 minutes
        max_sessions_per_user: Optional[int] = None,
        delete_session_on_cleanup: bool = True,
        save_session_to_memory_on_cleanup: bool = True,
        use_thread_id_as_session_id: bool = False,
        hitl_max_wait_seconds: Optional[int] = None,
    ):
        """Initialize the session manager.

        Args:
            session_service: ADK session service (defaults to InMemorySessionService)
            memory_service: Optional ADK memory service for automatic session memory
            session_timeout_seconds: Time before a session is considered expired
            cleanup_interval_seconds: Interval between cleanup cycles
            max_sessions_per_user: Maximum concurrent sessions per user (None = unlimited)
            delete_session_on_cleanup: Whether to delete sessions on cleanup
            save_session_to_memory_on_cleanup: Whether to save sessions to memory on cleanup
            use_thread_id_as_session_id: When True, use the AG-UI thread_id directly as
                the ADK session_id instead of letting the backend generate one. This
                eliminates the O(n) list_sessions scan needed to recover thread-to-session
                mappings after middleware restarts, replacing it with a direct O(1) lookup.
                Recommended for InMemorySessionService and backends that accept
                caller-provided session IDs.
            hitl_max_wait_seconds: Maximum time (in seconds) to preserve expired sessions
                that have pending HITL tool calls. None (default) means sessions with
                pending tool calls are preserved indefinitely. Set this to automatically
                clean up abandoned HITL sessions after the specified duration.
        """
        if session_service is None:
            from google.adk.sessions import InMemorySessionService
            session_service = InMemorySessionService()

        self._session_service = session_service
        self._memory_service = memory_service
        self._timeout = session_timeout_seconds
        self._cleanup_interval = cleanup_interval_seconds
        self._max_per_user = max_sessions_per_user
        self._delete_session_on_cleanup = delete_session_on_cleanup
        self._save_session_to_memory_on_cleanup = save_session_to_memory_on_cleanup
        self._use_thread_id_as_session_id = use_thread_id_as_session_id
        self._hitl_max_wait = hitl_max_wait_seconds

        # Minimal tracking: just keys and user counts
        self._session_keys: Set[str] = set()  # "app_name:session_id" keys
        self._user_sessions: Dict[str, Set[str]] = {}  # user_id -> set of session_keys
        self._processed_message_ids: Dict[str, Set[str]] = {}
        self._hitl_preserved_since: Dict[str, float] = {}  # session_key -> first preservation timestamp

        self._cleanup_task: Optional[asyncio.Task] = None

        logger.info(
            f"Initialized SessionManager - "
            f"timeout: {session_timeout_seconds}s, "
            f"cleanup: {cleanup_interval_seconds}s, "
            f"max/user: {max_sessions_per_user or 'unlimited'}, "
            f"memory: {'enabled' if memory_service else 'disabled'}, "
            f"thread_id_as_session_id: {use_thread_id_as_session_id}, "
            f"hitl_max_wait: {hitl_max_wait_seconds or 'unlimited'}s"
        )

    def start_session_read_cache(self):
        """Start a short-lived cache for repeated session reads in one execution."""
        return _SESSION_READ_CACHE.set({})

    def stop_session_read_cache(self, token) -> None:
        _SESSION_READ_CACHE.reset(token)

    def disable_session_read_cache(self) -> None:
        """Disable session caching for the remainder of the current context."""
        _SESSION_READ_CACHE.set(None)

    def _cache_key(
        self,
        session_id: str,
        app_name: str,
        user_id: str,
    ) -> Tuple[str, str, str]:
        return (session_id, app_name, user_id)

    def _cache_session(
        self,
        session_id: str,
        app_name: str,
        user_id: str,
        session: Any,
    ) -> None:
        cache = _SESSION_READ_CACHE.get()
        if cache is not None and session is not None:
            cache[self._cache_key(session_id, app_name, user_id)] = session

    def invalidate_session(
        self,
        session_id: str,
        app_name: str,
        user_id: str,
    ) -> None:
        cache = _SESSION_READ_CACHE.get()
        if cache is not None:
            cache.pop(self._cache_key(session_id, app_name, user_id), None)

    @classmethod
    def get_default(cls, **kwargs) -> "SessionManager":
        """Return the process-wide default SessionManager.

        Constructed lazily on first call. ``kwargs`` are honored only on that
        first call; subsequent calls return the existing instance regardless
        of arguments.
        """
        if cls._default is None:
            cls._default = cls(**kwargs)
        return cls._default

    @classmethod
    def reset_default(cls):
        """Reset the process-wide default SessionManager (intended for tests)."""
        if cls._default is not None:
            task = cls._default._cleanup_task
            if task:
                try:
                    task.cancel()
                except RuntimeError:
                    pass
        cls._default = None

    # Backward-compatible aliases for callers from before the singleton was
    # removed. Prefer ``get_default``/``reset_default`` in new code.
    get_instance = get_default
    reset_instance = reset_default
    
    async def get_or_create_session(
        self,
        thread_id: str,
        app_name: str,
        user_id: str,
        initial_state: Optional[Dict[str, Any]] = None,
        skip_find: bool = False,
    ) -> Tuple[Any, str]:
        """Get existing session or create new one.

        Args:
            thread_id: The AG-UI thread_id (client-provided identifier)
            app_name: Application name
            user_id: User identifier
            initial_state: Optional initial state for new sessions
            skip_find: If True, skip _find_session_by_thread_id in the scan
                path (caller already confirmed no session exists). No effect
                on the thread_id-as-session_id path (O(1) lookup is cheap).

        Returns:
            Tuple of (session, backend_session_id). The backend_session_id may differ
            from thread_id (e.g., VertexAI generates numeric IDs). The thread_id is
            stored in session state for recovery after middleware restarts.
        """
        # Check user limits before creating
        if self._max_per_user:
            user_count = len(self._user_sessions.get(user_id, set()))
            if user_count >= self._max_per_user:
                # Remove oldest session for this user
                await self._remove_oldest_user_session(user_id)

        if self._use_thread_id_as_session_id:
            session, backend_session_id = await self._get_or_create_by_thread_id(
                thread_id=thread_id,
                app_name=app_name,
                user_id=user_id,
                initial_state=initial_state,
            )
        else:
            session, backend_session_id = await self._get_or_create_by_scan(
                thread_id=thread_id,
                app_name=app_name,
                user_id=user_id,
                initial_state=initial_state,
                skip_find=skip_find,
            )

        session_key = self._make_session_key(app_name, backend_session_id)
        self._track_session(session_key, user_id)

        # Start cleanup
        if not self._cleanup_task:
            self._start_cleanup_task()

        return session, backend_session_id

    async def _get_or_create_by_thread_id(
        self,
        thread_id: str,
        app_name: str,
        user_id: str,
        initial_state: Optional[Dict[str, Any]] = None,
    ) -> Tuple[Any, str]:
        """Direct O(1) lookup: use thread_id as session_id.

        Tries get_session(session_id=thread_id) first. If the session does not
        exist, creates one with session_id=thread_id. Handles race conditions
        where two concurrent requests both attempt to create the same session.
        """
        # Direct lookup - O(1)
        session = await self.get_session(thread_id, app_name, user_id)
        if session:
            logger.debug(f"Direct lookup hit for thread {thread_id}")
            return session, thread_id

        # Create with thread_id as session_id
        state = {
            **(initial_state or {}),
            THREAD_ID_STATE_KEY: thread_id,
            APP_NAME_STATE_KEY: app_name,
            USER_ID_STATE_KEY: user_id,
        }

        try:
            session = await self._session_service.create_session(
                user_id=user_id,
                app_name=app_name,
                state=state,
                session_id=thread_id,
            )
            self._cache_session(thread_id, app_name, user_id, session)
            logger.info(f"Created session with thread_id as session_id: {thread_id}")
            return session, thread_id
        except Exception as e:
            # Race condition: another request created the session first
            logger.debug(f"Create failed (likely race), retrying lookup: {e}")
            session = await self.get_session(thread_id, app_name, user_id)
            if session:
                return session, thread_id
            raise

    async def _get_or_create_by_scan(
        self,
        thread_id: str,
        app_name: str,
        user_id: str,
        initial_state: Optional[Dict[str, Any]] = None,
        skip_find: bool = False,
    ) -> Tuple[Any, str]:
        """Original O(n) scan path: search state for matching thread_id."""
        # Try to find existing session by thread_id in state
        if not skip_find:
            session = await self._find_session_by_thread_id(app_name, user_id, thread_id)
            if session:
                logger.debug(f"Retrieved existing session for thread {thread_id}: {session.id}")
                return session, session.id

        # Create new session - let backend generate session_id
        state = {
            **(initial_state or {}),
            THREAD_ID_STATE_KEY: thread_id,
            APP_NAME_STATE_KEY: app_name,
            USER_ID_STATE_KEY: user_id,
        }

        session = await self._session_service.create_session(
            user_id=user_id,
            app_name=app_name,
            state=state,
        )
        self._cache_session(session.id, app_name, user_id, session)
        logger.info(f"Created new session for thread {thread_id}: {session.id}")
        return session, session.id

    async def _find_session_by_thread_id(
        self,
        app_name: str,
        user_id: str,
        thread_id: str
    ) -> Optional[Any]:
        """Find existing session by thread_id stored in session state.

        This is the recovery path after middleware restart. Since we always let
        the backend generate session_id, we can only find existing sessions by
        searching their state for _ag_ui_thread_id.

        Args:
            app_name: Application name
            user_id: User identifier
            thread_id: The AG-UI thread_id to search for

        Returns:
            Session object if found, None otherwise
        """
        if hasattr(self._session_service, 'list_sessions'):
            try:
                response = await self._session_service.list_sessions(
                    app_name=app_name,
                    user_id=user_id
                )
                # list_sessions returns ListSessionsResponse with .sessions attribute
                for session in response.sessions:
                    if session.state and session.state.get(THREAD_ID_STATE_KEY) == thread_id:
                        self._cache_session(session.id, app_name, user_id, session)
                        return session
            except Exception as e:
                logger.error(f"Error listing sessions for thread_id lookup: {e}")

        return None

    async def get_session(
        self,
        session_id: str,
        app_name: str,
        user_id: str
    ) -> Optional[Any]:
        """Get a session by its backend session_id.

        Args:
            session_id: The backend session ID
            app_name: Application name
            user_id: User identifier

        Returns:
            Session object if found, None otherwise
        """
        try:
            cache = _SESSION_READ_CACHE.get()
            cache_key = self._cache_key(session_id, app_name, user_id)
            if cache is not None and cache_key in cache:
                return cache[cache_key]

            session = await self._session_service.get_session(
                session_id=session_id,
                app_name=app_name,
                user_id=user_id
            )
            self._cache_session(session_id, app_name, user_id, session)
            return session
        except Exception as e:
            logger.error(f"Error getting session {session_id}: {e}")
            return None
    
    # ===== STATE MANAGEMENT METHODS =====
    
    async def update_session_state(
        self,
        session_id: str,
        app_name: str,
        user_id: str,
        state_updates: Dict[str, Any],
        merge: bool = True
    ) -> bool:
        """Update session state with new values.
        
        Args:
            session_id: Session identifier
            app_name: Application name
            user_id: User identifier
            state_updates: Dictionary of state key-value pairs to update
            merge: If True, merge with existing state; if False, replace completely
            
        Returns:
            True if successful, False otherwise
        """
        try:
            session = await self.get_session(
                session_id=session_id,
                app_name=app_name,
                user_id=user_id
            )
            
            if not session:
                logger.debug(f"Session not found for update: {app_name}:{session_id} - this may be normal if session is still being created")
                return False
            
            if not state_updates:
                logger.debug(f"No state updates provided for session: {app_name}:{session_id}")
                return False
            
            # Apply state updates using EventActions
            from google.adk.events import Event, EventActions
            
            # Prepare state delta
            if merge:
                # Merge with existing state
                state_delta = state_updates
            else:
                # Replace entire state
                state_delta = state_updates
                # Note: Complete replacement might need clearing existing keys
                # This depends on ADK's behavior - may need to explicitly clear
            
            # Create event with state changes
            # Use "user" as author since state updates come from the frontend
            # Note: Using "system" causes ADK runner warnings in _find_agent_to_run
            actions = EventActions(state_delta=state_delta)
            event = Event(
                invocation_id=f"state_update_{int(time.time())}",
                author="user",
                actions=actions,
                timestamp=time.time()
            )
            
            # Apply changes through ADK's event system
            await self._session_service.append_event(session, event)
            self.invalidate_session(session_id, app_name, user_id)
            
            logger.info(f"Updated state for session {app_name}:{session_id}")
            logger.debug(f"State updates: {state_updates}")
            
            return True
            
        except Exception as e:
            logger.error(f"Failed to update session state: {e}", exc_info=True)
            return False
    
    async def get_session_state(
        self,
        session_id: str,
        app_name: str,
        user_id: str
    ) -> Optional[Dict[str, Any]]:
        """Get current session state.

        Args:
            session_id: Session identifier
            app_name: Application name
            user_id: User identifier

        Returns:
            Session state dictionary or None if session not found
        """
        try:
            session = await self.get_session(
                session_id=session_id,
                app_name=app_name,
                user_id=user_id
            )

            if not session:
                logger.debug(f"Session not found when getting state: {app_name}:{session_id}")
                return None

            # Return state as dictionary
            if hasattr(session.state, 'to_dict'):
                return session.state.to_dict()
            else:
                # Fallback for dict-like state objects
                return dict(session.state)

        except Exception as e:
            logger.error(f"Failed to get session state: {e}", exc_info=True)
            return None
    
    async def get_state_value(
        self,
        session_id: str,
        app_name: str,
        user_id: str,
        key: str,
        default: Any = None
    ) -> Any:
        """Get a specific value from session state.
        
        Args:
            session_id: Session identifier
            app_name: Application name
            user_id: User identifier
            key: State key to retrieve
            default: Default value if key not found
            
        Returns:
            Value for the key or default
        """
        try:
            session = await self.get_session(
                session_id=session_id,
                app_name=app_name,
                user_id=user_id
            )
            
            if not session:
                logger.debug(f"Session not found when getting state value: {app_name}:{session_id}")
                return default
            
            if hasattr(session.state, 'get'):
                return session.state.get(key, default)
            else:
                return session.state.get(key, default) if key in session.state else default
                
        except Exception as e:
            logger.error(f"Failed to get state value: {e}", exc_info=True)
            return default
    
    async def set_state_value(
        self,
        session_id: str,
        app_name: str,
        user_id: str,
        key: str,
        value: Any
    ) -> bool:
        """Set a specific value in session state.
        
        Args:
            session_id: Session identifier
            app_name: Application name
            user_id: User identifier
            key: State key to set
            value: Value to set
            
        Returns:
            True if successful, False otherwise
        """
        return await self.update_session_state(
            session_id=session_id,
            app_name=app_name,
            user_id=user_id,
            state_updates={key: value}
        )
    
    async def remove_state_keys(
        self,
        session_id: str,
        app_name: str,
        user_id: str,
        keys: Union[str, list]
    ) -> bool:
        """Remove specific keys from session state.
        
        Args:
            session_id: Session identifier
            app_name: Application name
            user_id: User identifier
            keys: Single key or list of keys to remove
            
        Returns:
            True if successful, False otherwise
        """
        try:
            if isinstance(keys, str):
                keys = [keys]
            
            # Get current state
            current_state = await self.get_session_state(session_id, app_name, user_id)
            if not current_state:
                return False
            
            # Create state delta to remove keys (set to None for removal)
            state_delta = {key: None for key in keys if key in current_state}
            
            if not state_delta:
                logger.info(f"No keys to remove from session {app_name}:{session_id}")
                return True
            
            return await self.update_session_state(
                session_id=session_id,
                app_name=app_name,
                user_id=user_id,
                state_updates=state_delta
            )
            
        except Exception as e:
            logger.error(f"Failed to remove state keys: {e}", exc_info=True)
            return False
    
    async def clear_session_state(
        self,
        session_id: str,
        app_name: str,
        user_id: str,
        preserve_prefixes: Optional[list] = None
    ) -> bool:
        """Clear session state, optionally preserving certain prefixes.
        
        Args:
            session_id: Session identifier
            app_name: Application name
            user_id: User identifier
            preserve_prefixes: List of prefixes to preserve (e.g., ['user:', 'app:'])
            
        Returns:
            True if successful, False otherwise
        """
        try:
            current_state = await self.get_session_state(session_id, app_name, user_id)
            if not current_state:
                return False
            
            preserve_prefixes = preserve_prefixes or []
            
            # Determine which keys to remove
            keys_to_remove = []
            for key in current_state.keys():
                should_preserve = any(key.startswith(prefix) for prefix in preserve_prefixes)
                if not should_preserve:
                    keys_to_remove.append(key)
            
            if keys_to_remove:
                return await self.remove_state_keys(
                    session_id=session_id,
                    app_name=app_name,
                    user_id=user_id,
                    keys=keys_to_remove
                )
            
            return True
            
        except Exception as e:
            logger.error(f"Failed to clear session state: {e}", exc_info=True)
            return False
    
    async def initialize_session_state(
        self,
        session_id: str,
        app_name: str,
        user_id: str,
        initial_state: Dict[str, Any],
        overwrite_existing: bool = False
    ) -> bool:
        """Initialize session state with default values.
        
        Args:
            session_id: Session identifier
            app_name: Application name
            user_id: User identifier
            initial_state: Initial state values
            overwrite_existing: Whether to overwrite existing values
            
        Returns:
            True if successful, False otherwise
        """
        try:
            if not overwrite_existing:
                # Only set values that don't already exist
                current_state = await self.get_session_state(session_id, app_name, user_id)
                if current_state:
                    # Filter out keys that already exist
                    filtered_state = {
                        key: value for key, value in initial_state.items()
                        if key not in current_state
                    }
                    if not filtered_state:
                        logger.info(f"No new state values to initialize for session {app_name}:{session_id}")
                        return True
                    initial_state = filtered_state
            
            return await self.update_session_state(
                session_id=session_id,
                app_name=app_name,
                user_id=user_id,
                state_updates=initial_state
            )
            
        except Exception as e:
            logger.error(f"Failed to initialize session state: {e}", exc_info=True)
            return False
    
    # ===== BULK STATE OPERATIONS =====
    
    async def bulk_update_user_state(
        self,
        user_id: str,
        state_updates: Dict[str, Any],
        app_name_filter: Optional[str] = None
    ) -> Dict[str, bool]:
        """Update state across all sessions for a user.
        
        Args:
            user_id: User identifier
            state_updates: State updates to apply
            app_name_filter: Optional filter for specific app
            
        Returns:
            Dictionary mapping session_key to success status
        """
        results = {}
        
        if user_id not in self._user_sessions:
            logger.info(f"No sessions found for user {user_id}")
            return results
        
        for session_key in self._user_sessions[user_id]:
            app_name, session_id = session_key.split(':', 1)
            
            # Apply filter if specified
            if app_name_filter and app_name != app_name_filter:
                continue
            
            success = await self.update_session_state(
                session_id=session_id,
                app_name=app_name,
                user_id=user_id,
                state_updates=state_updates
            )
            
            results[session_key] = success
        
        return results
    
    # ===== EXISTING METHODS (unchanged) =====
    
    def _track_session(self, session_key: str, user_id: str):
        """Track a session key for enumeration."""
        self._session_keys.add(session_key)

        if user_id not in self._user_sessions:
            self._user_sessions[user_id] = set()
        self._user_sessions[user_id].add(session_key)

    def _untrack_session(self, session_key: str, user_id: str):
        """Remove session tracking."""
        self._session_keys.discard(session_key)
        self._processed_message_ids.pop(session_key, None)
        self._hitl_preserved_since.pop(session_key, None)

        if user_id in self._user_sessions:
            self._user_sessions[user_id].discard(session_key)
            if not self._user_sessions[user_id]:
                del self._user_sessions[user_id]

    def _make_session_key(self, app_name: str, session_id: str) -> str:
        return f"{app_name}:{session_id}"

    def get_processed_message_ids(self, app_name: str, session_id: str) -> Set[str]:
        session_key = self._make_session_key(app_name, session_id)
        return set(self._processed_message_ids.get(session_key, set()))

    def mark_messages_processed(
        self,
        app_name: str,
        session_id: str,
        message_ids: Iterable[str],
    ) -> None:
        session_key = self._make_session_key(app_name, session_id)
        processed_ids = self._processed_message_ids.setdefault(session_key, set())

        for message_id in message_ids:
            if message_id:
                processed_ids.add(message_id)
    
    async def _remove_oldest_user_session(self, user_id: str):
        """Remove the oldest session for a user based on lastUpdateTime."""
        if user_id not in self._user_sessions:
            return
        
        oldest_session = None
        oldest_time = float('inf')
        
        # Find oldest session by checking ADK's lastUpdateTime
        for session_key in self._user_sessions[user_id]:
            app_name, session_id = session_key.split(':', 1)
            try:
                session = await self._session_service.get_session(
                    session_id=session_id,
                    app_name=app_name,
                    user_id=user_id
                )
                if session and hasattr(session, 'last_update_time'):
                    update_time = session.last_update_time
                    if update_time < oldest_time:
                        oldest_time = update_time
                        oldest_session = session
            except Exception as e:
                logger.error(f"Error checking session {session_key}: {e}")
        
        if oldest_session:
            session_key = self._make_session_key(oldest_session.app_name, oldest_session.id)
            await self._delete_session(oldest_session)
            logger.info(f"Removed oldest session for user {user_id}: {session_key}")
    
    async def _delete_session(self, session):
        """Delete a session using the session object directly.
        
        Args:
            session: The ADK session object to delete
        """
        if not session:
            logger.warning("Cannot delete None session")
            return
            
        session_key = f"{session.app_name}:{session.id}"
        
        # If memory service is available, add session to memory before deletion
        logger.debug(f"Deleting session {session_key}, memory_service: {self._memory_service is not None}")
        if self._memory_service and self._save_session_to_memory_on_cleanup:
            try:
                await self._memory_service.add_session_to_memory(session)
                logger.debug(f"Added session {session_key} to memory before deletion")
            except Exception as e:
                logger.error(f"Failed to add session {session_key} to memory: {e}")
        
        if self._delete_session_on_cleanup:
            try:
                await self._session_service.delete_session(
                    session_id=session.id,
                    app_name=session.app_name,
                    user_id=session.user_id
                )
                logger.debug(f"Deleted session: {session_key}")
            except Exception as e:
                logger.error(f"Failed to delete session {session_key}: {e}")
        
        self.invalidate_session(session.id, session.app_name, session.user_id)
        self._untrack_session(session_key, session.user_id)
    
    def _start_cleanup_task(self):
        """Start the cleanup task if not already running."""
        try:
            loop = asyncio.get_running_loop()
            self._cleanup_task = loop.create_task(self._cleanup_loop())
            logger.debug(f"Started session cleanup task {id(self._cleanup_task)} for SessionManager {id(self)}")
        except RuntimeError:
            logger.debug("No event loop, cleanup will start later")
    
    async def _cleanup_loop(self):
        """Periodically clean up expired sessions."""
        logger.debug(f"Cleanup loop started for SessionManager {id(self)}")
        while True:
            try:
                await asyncio.sleep(self._cleanup_interval)
                logger.debug(f"Running cleanup on SessionManager {id(self)}")
                await self._cleanup_expired_sessions()
            except asyncio.CancelledError:
                logger.info("Cleanup task cancelled")
                break
            except Exception as e:
                logger.error(f"Cleanup error: {e}", exc_info=True)
    
    async def _cleanup_expired_sessions(self):
        """Find and remove expired sessions based on lastUpdateTime."""
        current_time = time.time()
        expired_count = 0
        
        # Check all tracked sessions
        for session_key in list(self._session_keys):  # Copy to avoid modification during iteration
            app_name, session_id = session_key.split(':', 1)
            
            # Find user_id for this session
            user_id = None
            for uid, keys in self._user_sessions.items():
                if session_key in keys:
                    user_id = uid
                    break
            
            if not user_id:
                continue
            
            try:
                session = await self._session_service.get_session(
                    session_id=session_id,
                    app_name=app_name,
                    user_id=user_id
                )
                
                if session and hasattr(session, 'last_update_time'):
                    age = current_time - session.last_update_time
                    if age > self._timeout:
                        # Check for pending tool calls before deletion (HITL scenarios)
                        pending_calls = session.state.get("pending_tool_calls", []) if session.state else []
                        has_pending = len(pending_calls) > 0
                        if has_pending:
                            # Track when we first started preserving this session
                            if session_key not in self._hitl_preserved_since:
                                self._hitl_preserved_since[session_key] = current_time

                            hitl_age = current_time - self._hitl_preserved_since[session_key]
                            if self._hitl_max_wait is not None and hitl_age > self._hitl_max_wait:
                                logger.info(
                                    f"Force-deleting expired HITL session {session_key} - "
                                    f"preserved for {hitl_age:.0f}s (limit: {self._hitl_max_wait}s)"
                                )
                                self._hitl_preserved_since.pop(session_key, None)
                                await self._delete_session(session)
                                expired_count += 1
                            else:
                                logger.info(f"Preserving expired session {session_key} - has {len(pending_calls)} pending tool calls (HITL)")
                        else:
                            await self._delete_session(session)
                            expired_count += 1
                elif not session:
                    # Session doesn't exist, just untrack it
                    self._untrack_session(session_key, user_id)
                    
            except Exception as e:
                logger.error(f"Error checking session {session_key}: {e}")
        
        if expired_count > 0:
            logger.info(f"Cleaned up {expired_count} expired sessions")
    
    def get_session_count(self) -> int:
        """Get total number of tracked sessions."""
        return len(self._session_keys)
    
    def get_user_session_count(self, user_id: str) -> int:
        """Get number of sessions for a user."""
        return len(self._user_sessions.get(user_id, set()))
    
    async def stop_cleanup_task(self):
        """Stop the cleanup task."""
        if self._cleanup_task:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
            self._cleanup_task = None
