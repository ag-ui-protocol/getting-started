# src/adk_agent.py

"""Main ADKAgent implementation for bridging AG-UI Protocol with Google ADK."""
from ag_ui_adk.agui_toolset import AGUIToolset

import copy
from typing import Optional, Dict, Callable, Any, AsyncGenerator, List, Iterable, Set, TYPE_CHECKING, Tuple, Union

if TYPE_CHECKING:
    from google.adk.apps import App
import time
import json
import asyncio
import inspect
from datetime import datetime

from ag_ui.core import (
    RunAgentInput, BaseEvent, EventType,
    RunStartedEvent, RunFinishedEvent, RunErrorEvent,
    ToolCallEndEvent, SystemMessage, ToolCallResultEvent,
    MessagesSnapshotEvent, Interrupt, RunFinishedInterruptOutcome
)

from google.adk import Runner
from google.adk.agents import BaseAgent, LlmAgent, RunConfig as ADKRunConfig

# Feature detect ADK's invocation_id override.
#
# Runner._resolve_invocation_id() was added somewhere between google-adk 1.24
# and 1.28 and is present on every version since (including 1.30.0, the release
# whose failing tests motivated ag-ui-protocol/ag-ui#1534). It inspects
# new_message and — if it contains a FunctionResponse — forcibly substitutes
# the caller-supplied invocation_id with the one on the matching FunctionCall
# event, then routes the run through the resumed-invocation path. For
# standalone LlmAgent roots that previously emitted end_of_agent=True on the
# function_call event, that path early-returns without calling the LLM, so
# HITL resumption silently produces zero content events.
#
# When this override is present we reshape the tool-result submission so that
# new_message does NOT contain a FunctionResponse: the FunctionResponse is
# pre-appended to the session as its own event, and new_message becomes a
# minimal placeholder that short-circuits _resolve_invocation_id.
_ADK_OVERRIDES_INVOCATION_ID = hasattr(Runner, "_resolve_invocation_id")
from google.adk.agents.run_config import StreamingMode
from google.adk.agents.llm_agent import InstructionProvider, ToolUnion
from google.adk.sessions import BaseSessionService, InMemorySessionService
from google.adk.sessions.session import Event
from google.adk.sessions.state import State as _ADKState
from google.adk.artifacts import BaseArtifactService, InMemoryArtifactService
from google.adk.memory import BaseMemoryService, InMemoryMemoryService
from google.adk.auth.credential_service.base_credential_service import BaseCredentialService
from google.adk.auth.credential_service.in_memory_credential_service import InMemoryCredentialService
from google.genai import types

from .event_translator import EventTranslator, adk_events_to_messages
from .session_manager import (
    SessionManager, CONTEXT_STATE_KEY, INVOCATION_ID_STATE_KEY,
    THREAD_ID_STATE_KEY, APP_NAME_STATE_KEY, USER_ID_STATE_KEY,
)

# Session-state keys managed exclusively by the backend.  These must never be
# overwritten by stale ``input.state`` values sent back from the frontend,
# otherwise internal metadata (e.g. LRO ID remaps) is lost between requests.
_INTERNAL_STATE_KEYS = frozenset({
    "lro_tool_call_id_remap",
    CONTEXT_STATE_KEY,
    THREAD_ID_STATE_KEY,
    APP_NAME_STATE_KEY,
    USER_ID_STATE_KEY,
    INVOCATION_ID_STATE_KEY,
})
from .execution_state import ExecutionState
from .client_proxy_toolset import ClientProxyToolset
from .a2ui_tool import A2UISubAgentTool, plan_a2ui_injection
from .config import PredictStateMapping
from .request_state_service import RequestStateSessionService
from .utils.converters import convert_message_content_to_parts

import logging
logger = logging.getLogger(__name__)


class _HitlDeferringQueue(asyncio.Queue):
    """``asyncio.Queue`` that defers HITL ``ToolCallEndEvent``s.

    Why: writing ``pending_tool_calls`` to ``session.state`` while ADK's
    Runner still owns its in-memory session trips
    ``DatabaseSessionService``'s OCC check on ADK >= 1.27 (issue #1732).
    PR #1735 fixed that by making the consumer ``await execution.task``
    before persisting, but that approach buffers every event after the
    first HITL ``TOOL_CALL_END`` in ``event_queue`` until the producer
    exits — losing streaming fidelity for non-HITL events that arrive
    afterwards (parallel tool calls, post-LRO text, backend tool
    results in resumable HITL).

    This queue defers ONLY the HITL ``ToolCallEndEvent`` itself. All
    other events stream live. The producer flushes the deferred TCEs
    once it has persisted the matching IDs to ``session.state`` — see
    ``_run_adk_in_background``. Putting the completion sentinel
    (``None``) implicitly flushes any remaining deferred TCEs, so the
    consumer sees them before the stream ends.

    The release-on-result branch handles the edge case of a tool that
    is marked HITL but resolves in-stream: when a ``ToolCallResultEvent``
    for a deferred id arrives, the buffered TCE is released
    immediately (preserving TCE→Result ordering on the wire) and
    removed from the deferred set so it is not persisted at flush time.
    """

    def __init__(self, long_running_tool_ids: Set[str]) -> None:
        super().__init__()
        self._long_running_tool_ids = long_running_tool_ids
        self._deferred_hitl_ends: Dict[str, "ToolCallEndEvent"] = {}

    async def put(self, item):  # type: ignore[override]
        # ``None`` is the completion sentinel; release any remaining
        # deferred TCEs first so the consumer sees them before the
        # stream ends.
        if item is None:
            await self.flush_deferred()
            await super().put(item)
            return

        # Defer HITL TOOL_CALL_END events until the producer has
        # persisted the corresponding ``pending_tool_calls`` entry.
        if isinstance(item, ToolCallEndEvent) and (
            item.tool_call_id in self._long_running_tool_ids
        ):
            self._deferred_hitl_ends[item.tool_call_id] = item
            return

        # Tools marked HITL but resolving in-stream: release the
        # buffered TCE first so the client sees TCE→Result in order,
        # and remove the id from the deferred set so it is not
        # persisted at flush time (the result implies no client-side
        # continuation, so the cross-pod handoff invariant from #1581
        # is moot for this id).
        if isinstance(item, ToolCallResultEvent) and (
            item.tool_call_id in self._deferred_hitl_ends
        ):
            deferred_end = self._deferred_hitl_ends.pop(item.tool_call_id)
            await super().put(deferred_end)

        await super().put(item)

    @property
    def deferred_hitl_ids(self) -> List[str]:
        """Tool call IDs still buffered (not yet released)."""
        return list(self._deferred_hitl_ends.keys())

    async def flush_deferred(self) -> None:
        """Release all buffered HITL TCEs onto the underlying queue."""
        for event in list(self._deferred_hitl_ends.values()):
            await super().put(event)
        self._deferred_hitl_ends.clear()


class ADKAgent:
    """Middleware to bridge AG-UI Protocol with Google ADK agents.
    
    This agent translates between the AG-UI protocol events and Google ADK events,
    managing sessions, state, and the lifecycle of ADK agents.
    """
    
    def __init__(
        self,
        # ADK Agent instance
        adk_agent: BaseAgent,

        # App identification
        app_name: Optional[str] = None,
        session_timeout_seconds: Optional[int] = 1200,
        app_name_extractor: Optional[Callable[[RunAgentInput], str]] = None,

        # User identification
        user_id: Optional[str] = None,
        user_id_extractor: Optional[Callable[[RunAgentInput], str]] = None,

        # ADK Services
        session_service: Optional[BaseSessionService] = None,
        session_manager: Optional[SessionManager] = None,
        artifact_service: Optional[BaseArtifactService] = None,
        memory_service: Optional[BaseMemoryService] = None,
        credential_service: Optional[BaseCredentialService] = None,

        # Configuration
        run_config_factory: Optional[Callable[[RunAgentInput], ADKRunConfig]] = None,
        use_in_memory_services: bool = True,

        # Tool configuration
        execution_timeout_seconds: int = 600,  # 10 minutes
        tool_timeout_seconds: int = 300,  # 5 minutes
        max_concurrent_executions: int = 10,

        # Session cleanup configuration
        cleanup_interval_seconds: int = 300,  # 5 minutes default
        max_sessions_per_user: Optional[int] = None,    # No limit by default
        delete_session_on_cleanup: bool = True,
        save_session_to_memory_on_cleanup: bool = True,
        hitl_max_wait_seconds: Optional[int] = None,    # No limit by default

        # Predictive state configuration
        predict_state: Optional[Iterable[PredictStateMapping]] = None,

        # Message snapshot configuration
        emit_messages_snapshot: bool = False,

        # Surface HITL pauses as AG-UI interrupts on RUN_FINISHED.outcome
        emit_interrupts: bool = False,

        # Streaming function call arguments (Gemini 3+ via Vertex AI)
        streaming_function_call_arguments: bool = False,

        # Session identity
        use_thread_id_as_session_id: bool = False,

        capabilities: Optional[Dict[str, Any]] = None,

        # A2UI auto-injection
        a2ui: Optional[Dict[str, Any]] = None,
    ):
        """Initialize the ADKAgent.

        Args:
            adk_agent: The ADK agent instance to use
            app_name: Static application name for all requests
            app_name_extractor: Function to extract app name dynamically from input
            user_id: Static user ID for all requests
            user_id_extractor: Function to extract user ID dynamically from input
            session_service: Session management service (defaults to InMemorySessionService).
                When provided, this ADKAgent gets a dedicated SessionManager wrapping
                the service, so multiple ADKAgents with distinct services no longer
                collide (see GitHub issue #1601).
            session_manager: Pre-constructed SessionManager to use. When provided,
                ``session_service`` and the session-cleanup configuration arguments
                are ignored (configure the manager directly instead). Useful when
                multiple ADKAgents should share a manager for consolidated cleanup
                and per-user session limits.
            artifact_service: File/artifact storage service
            memory_service: Conversation memory and search service (also enables automatic session memory)
            credential_service: Authentication credential storage
            run_config_factory: Function to create RunConfig per request
            use_in_memory_services: Use in-memory implementations for unspecified services
            execution_timeout_seconds: Timeout for entire execution
            tool_timeout_seconds: Timeout for individual tool calls
            max_concurrent_executions: Maximum concurrent background executions
            cleanup_interval_seconds: Interval for session cleanup
            max_sessions_per_user: Maximum concurrent sessions per user (None = unlimited)
            delete_session_on_cleanup: Whether to delete sessions from the adk SessionService on session cache cleanup
            save_session_to_memory_on_cleanup: Whether to save sessions to the adk MemoryService on session cache cleanup
            hitl_max_wait_seconds: Maximum time (in seconds) to preserve expired sessions
                that have pending HITL tool calls before force-deleting them. None (default)
                means no limit — sessions with pending tool calls are preserved indefinitely.
                Set this to automatically clean up abandoned HITL sessions.
            predict_state: Configuration for predictive state updates. When provided,
                the agent will emit PredictState CustomEvents for matching tool calls,
                enabling the UI to show state changes in real-time as tool arguments
                are streamed. Use PredictStateMapping to define which tool arguments
                map to which state keys.
            emit_messages_snapshot: Whether to emit a MessagesSnapshotEvent at the end
                of each run containing the full conversation history. Defaults to False
                to preserve existing behavior. Set to True for clients that need the
                full message history (e.g., for client-side persistence or AG-UI
                protocol compliance). Note: Clients using CopilotKit can use the
                /agents/state endpoint instead for on-demand history retrieval.
            emit_interrupts: Whether to surface HITL pauses as AG-UI interrupts.
                Defaults to False. When True, a run that pauses awaiting a
                human/long-running (frontend) tool call finishes with a
                ``RunFinishedInterruptOutcome`` on ``RunFinishedEvent.outcome``,
                carrying one ``Interrupt`` per unresolved tool call (``id`` and
                ``tool_call_id`` set to the pending tool call id). This lets
                spec-compliant AG-UI clients populate ``pendingInterrupts``.
                Opt-in so existing CopilotKit-style resume flows (which resume via
                a tool-result message) are unaffected.
            streaming_function_call_arguments: Whether to enable streaming of function
                call arguments from Gemini 3+ models via Vertex AI. When enabled,
                TOOL_CALL_ARGS events are emitted incrementally as the model streams
                partial arguments, allowing the UI to show progressive updates.
                Requires google-adk >= 1.24.0 and stream_function_call_arguments=True
                in the model's GenerateContentConfig. Defaults to False.
            use_thread_id_as_session_id: When True, use the AG-UI thread_id directly
                as the ADK session_id instead of letting the backend generate one.
                Eliminates the O(n) list_sessions scan for session recovery after
                middleware restarts. Defaults to False for backward compatibility.
            capabilities: Optional dictionary of agent capabilities conforming to
                the AG-UI AgentCapabilities schema. When provided, the capabilities
                are returned from the GET /capabilities endpoint, enabling frontend
                clients to discover agent features before initiating a run. Use the
                "custom" key for application-specific feature flags (e.g.,
                {"custom": {"predictiveChips": True, "suggestedQuestions": True}}).
            a2ui: A2UI auto-injection config — everything A2UI-related in one place
                (mirrors ``StrandsAgentConfig.a2ui``). When the CopilotKit runtime
                forwards ``injectA2UITool`` (or ``a2ui["inject_a2ui_tool"]`` opts in
                on a host that doesn't), the adapter injects a ``generate_a2ui``
                recovery tool onto the root ``LlmAgent`` and infers the sub-agent
                model from that agent's ``canonical_model`` — no manual
                ``get_a2ui_tool()`` wiring needed. Keys:

                - ``inject_a2ui_tool`` — opt in without the runtime flag; a string
                  also names the injected render tool to drop from the frontend
                  tools.
                - ``default_catalog_id`` — catalog id stamped into auto-injected
                  surfaces (must match the host renderer's catalog).
                - ``guidelines`` — ``{"composition_guide": ...}`` teaches the
                  sub-agent the catalog's components; required for a real model to
                  compose them.
                - ``catalog`` — inline catalog override for catalog-aware recovery
                  (otherwise resolved from the run's schema context / session state).
                - ``recovery`` — recovery loop config (camelCase keys per the shared
                  toolkit contract, e.g. ``{"maxAttempts": 5}``).

            Note:
            If delete_session_on_cleanup=False but save_session_to_memory_on_cleanup=True, sessions will accumulate in SessionService but still be saved to memory on cleanup.
        """
        if app_name and app_name_extractor:
            raise ValueError("Cannot specify both 'app_name' and 'app_name_extractor'")
        
        # app_name, app_name_extractor, or neither (use agent name as default)
        
        if user_id and user_id_extractor:
            raise ValueError("Cannot specify both 'user_id' and 'user_id_extractor'")

        if capabilities is not None:
            if not isinstance(capabilities, dict):
                raise TypeError(f"capabilities must be a dict, got {type(capabilities).__name__}")
            try:
                json.dumps(capabilities)
            except (TypeError, ValueError) as e:
                raise ValueError(f"capabilities must be JSON-serializable: {e}") from e

        self._adk_agent = adk_agent
        self._static_app_name = app_name
        self._app_name_extractor = app_name_extractor
        self._static_user_id = user_id
        self._user_id_extractor = user_id_extractor
        self._run_config_factory = run_config_factory or self._default_run_config
        
        # Initialize services with intelligent defaults
        if use_in_memory_services:
            self._artifact_service = artifact_service or InMemoryArtifactService()
            self._memory_service = memory_service or InMemoryMemoryService()
            self._credential_service = credential_service or InMemoryCredentialService()
        else:
            # Require explicit services for production
            self._artifact_service = artifact_service
            self._memory_service = memory_service
            self._credential_service = credential_service
        
        
        # Session lifecycle management. Three construction modes:
        #   1. session_manager= passed in -> use it as-is (escape hatch for
        #      callers who want explicit sharing across multiple ADKAgents).
        #   2. session_service= passed in -> dedicated SessionManager wrapping
        #      that service. Fixes https://github.com/ag-ui-protocol/ag-ui/issues/1601
        #      where distinct services were silently collapsed onto the first
        #      ADKAgent's manager.
        #   3. Neither -> shared process-wide default. Preserves the historical
        #      behavior where multiple ADKAgents constructed with no explicit
        #      service share one manager (and therefore one cleanup loop and
        #      one set of per-user session limits).
        if session_manager is not None and session_service is not None:
            raise ValueError(
                "Cannot specify both 'session_manager' and 'session_service'. "
                "Configure the session service via the SessionManager you pass in."
            )

        if session_manager is not None:
            self._session_manager = session_manager
        elif session_service is not None:
            # Wrap the session service so we can inject `temp:`-prefixed state into
            # the session that ADK's Runner fetches at invocation time. See
            # https://github.com/ag-ui-protocol/ag-ui/issues/1571 for context.
            if not isinstance(session_service, RequestStateSessionService):
                session_service = RequestStateSessionService(session_service)
            self._session_manager = SessionManager(
                session_service=session_service,
                memory_service=self._memory_service,
                session_timeout_seconds=session_timeout_seconds,
                cleanup_interval_seconds=cleanup_interval_seconds,
                max_sessions_per_user=max_sessions_per_user,
                delete_session_on_cleanup=delete_session_on_cleanup,
                save_session_to_memory_on_cleanup=save_session_to_memory_on_cleanup,
                use_thread_id_as_session_id=use_thread_id_as_session_id,
                hitl_max_wait_seconds=hitl_max_wait_seconds,
            )
        else:
            self._session_manager = SessionManager.get_default(
                memory_service=self._memory_service,
                session_timeout_seconds=session_timeout_seconds,
                cleanup_interval_seconds=cleanup_interval_seconds,
                max_sessions_per_user=max_sessions_per_user,
                delete_session_on_cleanup=delete_session_on_cleanup,
                save_session_to_memory_on_cleanup=save_session_to_memory_on_cleanup,
                use_thread_id_as_session_id=use_thread_id_as_session_id,
                hitl_max_wait_seconds=hitl_max_wait_seconds,
            )

        # The shared default and externally-supplied managers may not yet have
        # their session service wrapped. Ensure the wrapper is in place so
        # `temp:` state injection works regardless of construction path.
        active_service = self._session_manager._session_service
        if not isinstance(active_service, RequestStateSessionService):
            active_service = RequestStateSessionService(active_service)
            self._session_manager._session_service = active_service
        self._request_state_service: RequestStateSessionService = active_service

        # Tool execution tracking — keyed by (thread_id, user_id) to avoid cross-user collisions
        self._active_executions: Dict[Tuple[str, str], ExecutionState] = {}
        self._execution_timeout = execution_timeout_seconds
        self._tool_timeout = tool_timeout_seconds
        self._max_concurrent = max_concurrent_executions
        self._execution_lock = asyncio.Lock()

        # Session lookup cache for efficient (thread_id, user_id) to session metadata mapping
        # Maps (thread_id, user_id) -> (session_id, app_name, user_id)
        self._session_lookup_cache: Dict[Tuple[str, str], Tuple[str, str, str]] = {}
        # Keys where hydration already scanned DB and found nothing (avoids redundant scan)
        self._cache_checked_keys: set = set()
        # Keys where _ensure_session_exists has verified pending tool calls on this instance
        self._sessions_verified_locally: set = set()

        # Predictive state configuration for real-time state updates
        self._predict_state = predict_state
        # Message snapshot configuration
        self._emit_messages_snapshot = emit_messages_snapshot
        # Surface HITL pauses as AG-UI interrupts on RUN_FINISHED.outcome (opt-in)
        self._emit_interrupts = emit_interrupts
        self._capabilities = capabilities
        # A2UI auto-injection config (mirrors StrandsAgentConfig.a2ui). None
        # disables auto-injection unless the runtime forwards injectA2UITool.
        self._a2ui_config = a2ui

        # Streaming function call arguments (Gemini 3+ via Vertex AI)
        if streaming_function_call_arguments and not self._adk_supports_streaming_fc_args():
            import warnings
            warnings.warn(
                "streaming_function_call_arguments=True requires google-adk >= 1.24.0. "
                "The feature will be disabled. Upgrade with: pip install 'google-adk>=1.24.0'",
                UserWarning,
                stacklevel=2,
            )
            self._streaming_function_call_arguments = False
        else:
            self._streaming_function_call_arguments = streaming_function_call_arguments

        # App-based configuration (set by from_app() classmethod)
        self._app: Optional["App"] = None
        self._plugin_close_timeout: float = 5.0

        # Event translator will be created per-session for thread safety

        # Cleanup is managed by the session manager
        # Will start when first async operation runs

    def _is_adk_resumable(self) -> bool:
        """Check if ADK's native resumability is enabled via App.

        When using ADK's ResumabilityConfig(is_resumable=True), the Runner
        automatically persists FunctionCall events before pausing. This allows
        us to let ADK handle the pause/resume flow naturally instead of
        returning early at LRO tool calls.

        Returns:
            True if using from_app() with ResumabilityConfig.is_resumable=True
        """
        if self._app is None:
            return False
        resumability_config = getattr(self._app, 'resumability_config', None)
        if resumability_config is None:
            return False
        return getattr(resumability_config, 'is_resumable', False)

    def _root_agent_is_workflow(self) -> bool:
        """Return True if the root agent is an ADK 2.0 ``Workflow``.

        Workflows rehydrate from ``new_message.parts`` exclusively
        (``Workflow._run_impl`` calls ``_extract_resume_inputs(new_message)``).
        The #1534 pre-append workaround for LlmAgent roots — which replaces
        ``new_message`` with an empty placeholder — strands Workflow roots
        because there's no ``function_response`` in the placeholder for
        the Workflow to resume from. See ag-ui#1669.

        We detect the Workflow class by attribute lookup so this stays
        compatible with ADK 1.x (where the class doesn't exist) without
        importing it at module top level. The import is wrapped in
        try/except so ADK 1.x continues to load.

        Returns:
            True iff the root agent (or App.root_agent) is an instance of
            ``google.adk.workflow.Workflow``. False on ADK 1.x or any
            non-Workflow root.
        """
        try:
            from google.adk.workflow import Workflow  # type: ignore[import-not-found]
        except ImportError:
            # ADK 1.x has no workflow module — no Workflow roots possible.
            return False

        root = self._adk_agent
        if root is None and self._app is not None:
            root = getattr(self._app, 'root_agent', None)
        if root is None:
            return False
        return isinstance(root, Workflow)

    def _root_agent_needs_invocation_id(self) -> bool:
        """Check if the agent topology requires invocation_id for HITL resumption.

        Composite orchestrators (SequentialAgent, LoopAgent) store internal
        state (e.g. current_sub_agent position) that can only be restored via
        populate_invocation_agent_states(), which requires invocation_id.

        This returns True when:
        - The root agent itself is a composite orchestrator, OR
        - Any agent in the sub-agent tree is a composite orchestrator
          (e.g. LlmAgent → LlmAgent → SequentialAgent).

        Standalone LlmAgents (including those with only LlmAgent transfer
        targets) do NOT need invocation_id. Passing it triggers
        _get_subagent_to_resume() which raises ValueError.

        Returns:
            True if the topology contains a composite orchestrator
        """
        from google.adk.agents import LoopAgent, SequentialAgent
        composite_types = (SequentialAgent, LoopAgent)

        root = self._adk_agent
        if root is None and self._app is not None:
            root = getattr(self._app, 'root_agent', None)
        if root is None:
            return False
        if isinstance(root, composite_types):
            return True

        def _has_composite_descendant(agent):
            for sub in getattr(agent, 'sub_agents', None) or []:
                if isinstance(sub, composite_types):
                    return True
                if _has_composite_descendant(sub):
                    return True
            return False

        return _has_composite_descendant(root)

    @staticmethod
    def _find_function_call_invocation_id(session, tool_call_id: str) -> Optional[str]:
        """Find the invocation_id of the event that authored a FunctionCall.

        ADK 1.30+ derives the effective invocation_id for tool-result submissions
        by looking up the matching FunctionCall event in session history. We read
        the same attribute here so that any FunctionResponse we pre-append carries
        a consistent invocation_id with the upstream FunctionCall.

        Returns None if no matching FunctionCall event is found.
        """
        events = getattr(session, "events", None) or []
        for event in events:
            content = getattr(event, "content", None)
            parts = getattr(content, "parts", None) if content else None
            if not parts:
                continue
            for part in parts:
                fc = getattr(part, "function_call", None)
                fc_id = getattr(fc, "id", None) if fc else None
                if fc_id and fc_id == tool_call_id:
                    return getattr(event, "invocation_id", None)
        return None

    @classmethod
    def from_app(
        cls,
        app: "App",
        # User identification (still needed - not in App)
        user_id: Optional[str] = None,
        user_id_extractor: Optional[Callable[[RunAgentInput], str]] = None,
        # ADK Services (App does NOT contain these - still passed to Runner separately)
        session_service: Optional[BaseSessionService] = None,
        session_manager: Optional[SessionManager] = None,
        artifact_service: Optional[BaseArtifactService] = None,
        memory_service: Optional[BaseMemoryService] = None,
        credential_service: Optional[BaseCredentialService] = None,
        # Configuration
        run_config_factory: Optional[Callable[[RunAgentInput], ADKRunConfig]] = None,
        use_in_memory_services: bool = True,
        plugin_close_timeout: float = 5.0,
        # Execution limits
        execution_timeout_seconds: int = 600,
        tool_timeout_seconds: int = 300,
        max_concurrent_executions: int = 10,
        # Session management
        session_timeout_seconds: Optional[int] = 1200,
        cleanup_interval_seconds: int = 300,
        max_sessions_per_user: Optional[int] = None,    # No limit by default
        delete_session_on_cleanup: bool = True,
        save_session_to_memory_on_cleanup: bool = True,
        # AG-UI specific
        predict_state: Optional[Iterable[PredictStateMapping]] = None,
        emit_messages_snapshot: bool = False,
        emit_interrupts: bool = False,
        streaming_function_call_arguments: bool = False,
        # Session identity
        use_thread_id_as_session_id: bool = False,
        # Agent capabilities
        capabilities: Optional[Dict[str, Any]] = None,
    ) -> "ADKAgent":
        """Create ADKAgent from an ADK App instance.

        This is the recommended way to create an ADKAgent when you want access to
        App-level features like resumability, context caching, and plugins.

        The App object bundles together the root agent, plugins, and configuration
        that would otherwise need to be passed separately. Using from_app() enables:
        - Plugin support (logging, tracing, custom plugins)
        - Resumability configuration for pause/resume workflows
        - Context caching configuration for LLM optimization
        - Events compaction configuration

        Args:
            app: The ADK App instance containing the root agent and configuration
            user_id: Static user ID for all requests
            user_id_extractor: Function to extract user ID dynamically from input
            session_service: Session management service (defaults to InMemorySessionService).
                See ADKAgent.__init__ for details.
            session_manager: Pre-constructed SessionManager to use. When provided,
                ``session_service`` and the session-cleanup configuration arguments
                are ignored. See ADKAgent.__init__ for details.
            artifact_service: File/artifact storage service
            memory_service: Conversation memory and search service
            credential_service: Authentication credential storage
            run_config_factory: Function to create RunConfig per request
            use_in_memory_services: Use in-memory implementations for unspecified services
            plugin_close_timeout: Timeout for plugin close methods (requires ADK 1.19+)
            execution_timeout_seconds: Timeout for entire execution
            tool_timeout_seconds: Timeout for individual tool calls
            max_concurrent_executions: Maximum concurrent background executions
            session_timeout_seconds: Session timeout in seconds
            cleanup_interval_seconds: Interval for session cleanup
            predict_state: Configuration for predictive state updates
            emit_messages_snapshot: Whether to emit MessagesSnapshotEvent at end of runs
            streaming_function_call_arguments: Whether to enable streaming of function
                call arguments from Gemini 3+ models. Requires google-adk >= 1.24.0.
            use_thread_id_as_session_id: When True, use the AG-UI thread_id directly
                as the ADK session_id. See ADKAgent.__init__ for details.
            capabilities: Optional dictionary of agent capabilities conforming to
                the AG-UI AgentCapabilities schema. See ADKAgent.__init__ for details.

        Returns:
            ADKAgent instance configured to use the App

        Example:
            from google.adk.apps import App
            from google.adk.agents import Agent

            app = App(
                name="my_assistant",
                root_agent=Agent(name="assistant", model="gemini-3.5-flash", ...),
                plugins=[LoggingPlugin()],
            )
            agent = ADKAgent.from_app(app, user_id="demo_user")
        """
        # Import App at runtime to avoid circular imports
        from google.adk.apps import App as AppClass

        if not isinstance(app, AppClass):
            raise TypeError(f"Expected App instance, got {type(app).__name__}")

        instance = cls(
            adk_agent=app.root_agent,
            app_name=app.name,
            user_id=user_id,
            user_id_extractor=user_id_extractor,
            session_service=session_service,
            session_manager=session_manager,
            artifact_service=artifact_service,
            memory_service=memory_service,
            credential_service=credential_service,
            run_config_factory=run_config_factory,
            use_in_memory_services=use_in_memory_services,
            execution_timeout_seconds=execution_timeout_seconds,
            tool_timeout_seconds=tool_timeout_seconds,
            max_concurrent_executions=max_concurrent_executions,
            session_timeout_seconds=session_timeout_seconds,
            cleanup_interval_seconds=cleanup_interval_seconds,
            max_sessions_per_user=max_sessions_per_user,
            delete_session_on_cleanup=delete_session_on_cleanup,
            save_session_to_memory_on_cleanup=save_session_to_memory_on_cleanup,
            predict_state=predict_state,
            emit_messages_snapshot=emit_messages_snapshot,
            emit_interrupts=emit_interrupts,
            streaming_function_call_arguments=streaming_function_call_arguments,
            use_thread_id_as_session_id=use_thread_id_as_session_id,
            capabilities=capabilities,
        )
        # Store App for per-request App creation with modified agents
        instance._app = app
        instance._plugin_close_timeout = plugin_close_timeout
        return instance

    def get_capabilities(self) -> Optional[Dict[str, Any]]:
        """Return a copy of the agent's declared capabilities, or None if not configured.

        These capabilities conform to the AG-UI AgentCapabilities schema and are
        served by the GET /capabilities endpoint when using add_adk_fastapi_endpoint().
        """
        if self._capabilities is None:
            return None
        return copy.deepcopy(self._capabilities)

    def _get_session_metadata(self, thread_id: str, user_id: str) -> Optional[Tuple[str, str, str]]:
        """Get session metadata for a (thread_id, user_id) pair efficiently.

        Args:
            thread_id: The AG-UI thread_id to lookup
            user_id: The user identifier to scope the lookup (use "" only when explicitly anonymous)

        Returns:
            Tuple of (session_id, app_name, user_id) or None if not found
        """
        return self._session_lookup_cache.get((thread_id, user_id))

    def _get_backend_session_id(self, thread_id: str, user_id: str) -> Optional[str]:
        """Get the backend session_id for a (thread_id, user_id) pair.

        Args:
            thread_id: The AG-UI thread_id to lookup
            user_id: The user identifier to scope the lookup (use "" only when explicitly anonymous)

        Returns:
            The backend session_id or None if not found
        """
        metadata = self._session_lookup_cache.get((thread_id, user_id))
        return metadata[0] if metadata else None
    
    def _get_app_name(self, input: RunAgentInput) -> str:
        """Resolve app name with clear precedence."""
        if self._static_app_name:
            return self._static_app_name
        elif self._app_name_extractor:
            return self._app_name_extractor(input)
        else:
            return self._default_app_extractor(input)
    
    def _default_app_extractor(self, input: RunAgentInput) -> str:
        """Default app extraction logic - use agent name directly."""
        # Use the ADK agent's name as app name
        try:
            return self._adk_agent.name
        except Exception as e:
            logger.warning(f"Could not get agent name for app_name, using default: {e}")
            return "AG-UI ADK Agent"
    
    def _get_user_id(self, input: RunAgentInput) -> str:
        """Resolve user ID with clear precedence."""
        if self._static_user_id:
            return self._static_user_id
        elif self._user_id_extractor:
            return self._user_id_extractor(input)
        else:
            return self._default_user_extractor(input)
    
    def _default_user_extractor(self, input: RunAgentInput) -> str:
        """Default user extraction logic."""
        # Use thread_id as default (assumes thread per user)
        return f"thread_user_{input.thread_id}"
    
    async def _finalize_hitl_buffer(
        self,
        event_queue,
        thread_id: str,
        app_name: str,
        user_id: str,
    ) -> None:
        """Persist any HITL pending_tool_calls IDs buffered in the queue.

        Used by ``_run_adk_in_background`` to flush HITL persistence work
        right before signalling completion or returning early. The matching
        deferred ``ToolCallEndEvent`` instances stay in the queue's buffer
        until a subsequent ``put(None)`` (or explicit ``flush_deferred``)
        releases them onto the underlying queue — that ordering preserves
        PR #1581's invariant ("persist before the client sees the event").

        Idempotent: safe to call multiple times. No-op when ``event_queue``
        is not a :class:`_HitlDeferringQueue` or has no deferred events.
        See issue #1755.
        """
        if not isinstance(event_queue, _HitlDeferringQueue):
            return
        for hitl_tool_call_id in list(event_queue.deferred_hitl_ids):
            try:
                await self._add_pending_tool_call_with_context(
                    thread_id, hitl_tool_call_id, app_name, user_id
                )
            except Exception as persist_error:
                logger.error(
                    f"Failed to persist HITL pending_tool_call "
                    f"{hitl_tool_call_id} for thread {thread_id}: "
                    f"{persist_error}"
                )

    async def _add_pending_tool_call_with_context(self, thread_id: str, tool_call_id: str, app_name: str, user_id: str):
        """Add a tool call to the session's pending list for HITL tracking.

        Args:
            thread_id: The AG-UI thread_id
            tool_call_id: The tool call ID to track
            app_name: App name (for session lookup)
            user_id: User ID (for session lookup)
        """
        # Get the backend session_id from cache
        metadata = self._get_session_metadata(thread_id, user_id)
        if not metadata:
            logger.warning(f"No session metadata for thread {thread_id}, cannot add pending tool call")
            return

        session_id, _, _ = metadata
        logger.debug(f"Adding pending tool call {tool_call_id} for thread {thread_id} (session {session_id})")
        try:
            # Get current pending calls using SessionManager
            pending_calls = await self._session_manager.get_state_value(
                session_id=session_id,
                app_name=app_name,
                user_id=user_id,
                key="pending_tool_calls",
                default=[]
            )

            # Add new tool call if not already present
            if tool_call_id not in pending_calls:
                pending_calls.append(tool_call_id)

                # Update the state using SessionManager
                success = await self._session_manager.set_state_value(
                    session_id=session_id,
                    app_name=app_name,
                    user_id=user_id,
                    key="pending_tool_calls",
                    value=pending_calls
                )

                if success:
                    logger.info(f"Added tool call {tool_call_id} to thread {thread_id} pending list")
        except Exception as e:
            logger.error(f"Failed to add pending tool call {tool_call_id} to thread {thread_id}: {e}")

    async def _remove_pending_tool_call(self, thread_id: str, tool_call_id: str, user_id: str):
        """Remove a tool call from the session's pending list.

        Args:
            thread_id: The AG-UI thread_id
            tool_call_id: The tool call ID to remove
            user_id: The user identifier to scope the lookup (use "" only when explicitly anonymous)
        """
        try:
            # Use efficient session metadata lookup
            metadata = self._get_session_metadata(thread_id, user_id)

            if metadata:
                session_id, app_name, user_id = metadata

                # Get current pending calls using SessionManager
                pending_calls = await self._session_manager.get_state_value(
                    session_id=session_id,
                    app_name=app_name,
                    user_id=user_id,
                    key="pending_tool_calls",
                    default=[]
                )

                # Remove tool call if present
                if tool_call_id in pending_calls:
                    pending_calls.remove(tool_call_id)

                    # Update the state using SessionManager
                    success = await self._session_manager.set_state_value(
                        session_id=session_id,
                        app_name=app_name,
                        user_id=user_id,
                        key="pending_tool_calls",
                        value=pending_calls
                    )

                    if success:
                        logger.info(f"Removed tool call {tool_call_id} from thread {thread_id} pending list")
        except Exception as e:
            logger.error(f"Failed to remove pending tool call {tool_call_id} from thread {thread_id}: {e}")
    
    async def _get_pending_tool_call_ids(self, thread_id: str, user_id: str) -> Optional[List[str]]:
        """Fetch the pending tool call identifiers tracked for a thread."""
        try:
            metadata = self._get_session_metadata(thread_id, user_id)

            if metadata:
                session_id, app_name, user_id = metadata
                pending_calls = await self._session_manager.get_state_value(
                    session_id=session_id,
                    app_name=app_name,
                    user_id=user_id,
                    key="pending_tool_calls",
                    default=[],
                )

                if pending_calls is None:
                    return []

                return list(pending_calls)
        except Exception as e:
            logger.error(f"Failed to fetch pending tool calls for thread {thread_id}: {e}")

        return None

    async def _has_pending_tool_calls(self, thread_id: str, user_id: str) -> bool:
        """Check if thread has pending tool calls (HITL scenario).

        Args:
            thread_id: The AG-UI thread_id
            user_id: The user identifier to scope the lookup (use "" only when explicitly anonymous)

        Returns:
            True if thread has pending tool calls
        """
        pending_calls = await self._get_pending_tool_call_ids(thread_id, user_id)
        if pending_calls is None:
            return False

        return len(pending_calls) > 0

    def _extract_lro_id_remap(
        self,
        adk_event,
        event_translator: 'EventTranslator',
    ) -> Dict[str, str]:
        """Extract ID remapping from a non-partial event's LRO function calls.

        When SSE streaming is enabled, ADK's ``populate_client_function_call_id``
        generates different UUIDs for the same function call across partial and
        final events.  This method builds a mapping from the ID the client
        received (emitted from the partial event) to the ID ADK persisted (from
        the final event), so that tool-result submissions can use the correct ID.

        Returns:
            Dict mapping client-facing IDs to ADK-persisted IDs.
        """
        remap: Dict[str, str] = {}
        if not adk_event.content or not hasattr(adk_event.content, 'parts'):
            return remap

        # Track consumption index per tool name so that parallel calls to the
        # same tool (e.g. 5 × create_item) are matched by position (FIFO).
        consumed: Dict[str, int] = {}

        for part in (adk_event.content.parts or []):
            fc = getattr(part, 'function_call', None)
            if not fc:
                continue
            final_id = getattr(fc, 'id', None)
            fc_name = getattr(fc, 'name', None)
            if not final_id or not fc_name:
                continue

            emitted_ids = event_translator.lro_emitted_ids_by_name.get(fc_name, [])
            idx = consumed.get(fc_name, 0)
            if idx < len(emitted_ids):
                emitted_id = emitted_ids[idx]
                consumed[fc_name] = idx + 1
                if emitted_id != final_id:
                    remap[emitted_id] = final_id
                    logger.info(
                        f"LRO ID remap: client_id={emitted_id} -> persisted_id={final_id} "
                        f"(tool={fc_name})"
                    )

        return remap

    async def _store_lro_id_remap(
        self,
        remap: Dict[str, str],
        session_id: str,
        app_name: str,
        user_id: str,
    ) -> None:
        """Persist an LRO ID remapping in session state.

        Merges *remap* into the existing ``lro_tool_call_id_remap`` stored in
        the session so that multiple LRO tool calls can accumulate mappings.
        """
        try:
            existing: Dict[str, str] = await self._session_manager.get_state_value(
                session_id=session_id,
                app_name=app_name,
                user_id=user_id,
                key="lro_tool_call_id_remap",
                default={},
            )
            existing.update(remap)
            await self._session_manager.set_state_value(
                session_id=session_id,
                app_name=app_name,
                user_id=user_id,
                key="lro_tool_call_id_remap",
                value=existing,
            )
            logger.debug(f"Stored LRO ID remap in session state: {remap}")
        except Exception as e:
            logger.warning(f"Failed to store LRO ID remap: {e}")

    async def _get_lro_id_remap(
        self,
        session_id: str,
        app_name: str,
        user_id: str,
    ) -> Dict[str, str]:
        """Retrieve the LRO ID remapping from session state."""
        try:
            return await self._session_manager.get_state_value(
                session_id=session_id,
                app_name=app_name,
                user_id=user_id,
                key="lro_tool_call_id_remap",
                default={},
            )
        except Exception as e:
            logger.warning(f"Failed to retrieve LRO ID remap: {e}")
            return {}

    async def _consume_lro_id_remap(
        self,
        tool_call_id: str,
        session_id: str,
        app_name: str,
        user_id: str,
    ) -> str:
        """Look up and consume (remove) a single LRO ID remap entry.

        Returns the remapped ID if one exists, otherwise returns *tool_call_id*
        unchanged.
        """
        remap = await self._get_lro_id_remap(session_id, app_name, user_id)
        if tool_call_id not in remap:
            return tool_call_id

        remapped_id = remap.pop(tool_call_id)
        logger.info(
            f"Remapped tool_call_id {tool_call_id} -> {remapped_id} for FunctionResponse"
        )
        # Persist the reduced remap (entry consumed)
        try:
            await self._session_manager.set_state_value(
                session_id=session_id,
                app_name=app_name,
                user_id=user_id,
                key="lro_tool_call_id_remap",
                value=remap,
            )
        except Exception as e:
            logger.warning(f"Failed to update LRO ID remap after consumption: {e}")

        return remapped_id

    def _default_run_config(self, input: RunAgentInput) -> ADKRunConfig:
        """Create default RunConfig with SSE streaming enabled.

        Context from RunAgentInput is always stored in session state under the
        '_ag_ui_context' key (CONTEXT_STATE_KEY), making it accessible to both
        tools (via tool_context.state) and instruction providers (via ctx.state).

        Additionally, for ADK 1.22.0+, context is also included in RunConfig's
        custom_metadata field, providing an alternative access pattern via
        ctx.run_config.custom_metadata['ag_ui_context'].
        """
        config_kwargs = {
            'streaming_mode': StreamingMode.SSE,
            'save_input_blobs_as_artifacts': False,
        }

        # For ADK 1.22.0+, also include context in custom_metadata
        if self._run_config_supports_custom_metadata() and input.context:
            config_kwargs['custom_metadata'] = {
                'ag_ui_context': [
                    {"description": ctx.description, "value": ctx.value}
                    for ctx in input.context
                ]
            }

        return ADKRunConfig(**config_kwargs)

    def _run_config_supports_custom_metadata(self) -> bool:
        """Check if the installed ADK version supports custom_metadata in RunConfig.

        The custom_metadata parameter was added to RunConfig in ADK 1.22.0.
        This method checks for its presence to maintain backward compatibility.

        Returns:
            True if RunConfig accepts custom_metadata, False otherwise
        """
        sig = inspect.signature(ADKRunConfig.__init__)
        return 'custom_metadata' in sig.parameters

    def _runner_supports_plugin_close_timeout(self) -> bool:
        """Check if the installed ADK version supports plugin_close_timeout.

        The plugin_close_timeout parameter was added to Runner in ADK 1.19.0.
        This method checks for its presence to maintain backward compatibility.

        Returns:
            True if Runner accepts plugin_close_timeout, False otherwise
        """
        sig = inspect.signature(Runner.__init__)
        return 'plugin_close_timeout' in sig.parameters

    @staticmethod
    def _adk_supports_streaming_fc_args() -> bool:
        """Check if google-adk supports reliable streaming function call arguments.

        Streaming FC args requires google-adk >= 1.24.0 where the
        StreamingResponseAggregator bugs (google/adk-python#4311) are fixed.
        We detect this by checking for partial_args on FunctionCall.

        Returns:
            True if streaming FC args is supported, False otherwise
        """
        try:
            from google.genai import types
            if hasattr(types.FunctionCall, 'model_fields'):
                return 'partial_args' in types.FunctionCall.model_fields
            return hasattr(types.FunctionCall, 'partial_args')
        except Exception:
            return False

    def _create_runner(self, adk_agent: BaseAgent, user_id: str, app_name: str) -> Runner:
        """Create a new runner instance.

        If an App was provided via from_app(), creates a per-request App copy
        with the modified agent to preserve App-level configurations (plugins,
        resumability, context caching, etc.).

        Args:
            adk_agent: The (potentially modified) agent to run
            user_id: User ID for the session
            app_name: Application name for the session

        Returns:
            Configured Runner instance
        """
        # Build common kwargs for services
        service_kwargs = {
            'session_service': self._session_manager._session_service,
            'artifact_service': self._artifact_service,
            'memory_service': self._memory_service,
            'credential_service': self._credential_service,
        }

        # Add plugin_close_timeout if supported by this ADK version
        if self._runner_supports_plugin_close_timeout():
            service_kwargs['plugin_close_timeout'] = self._plugin_close_timeout

        if self._app is not None:
            # Create per-request App copy with modified agent (preserves all App configs)
            request_app = self._app.model_copy(update={'root_agent': adk_agent})
            return Runner(app=request_app, **service_kwargs)
        else:
            # Old style: component-based (no plugins support - use from_app() for that)
            return Runner(
                app_name=app_name,
                agent=adk_agent,
                **service_kwargs,
            )
    
    async def run(self, input: RunAgentInput) -> AsyncGenerator[BaseEvent, None]:
        """Run the ADK agent with client-side tool support.

        All client-side tools are long-running. For tool result submissions,
        we continue existing executions. For new requests, we start new executions.
        ADK sessions handle conversation continuity and tool result processing.

        Args:
            input: The AG-UI run input

        Yields:
            AG-UI protocol events
        """

        # Multi-instance: hydrate in-memory session cache from DB on startup/switch.
        # Ensures pending tool calls are detected across load-balanced instances
        # so user messages are not dispatched before tool results (prevents LLM errors).
        user_id = self._get_user_id(input)
        cache_key = (input.thread_id, user_id)
        if cache_key not in self._session_lookup_cache:
            app_name = self._get_app_name(input)
            session = await self._session_manager._find_session_by_thread_id(
                app_name, user_id, input.thread_id
            )
            if session:
                self._session_lookup_cache[cache_key] = (
                    session.id, app_name, user_id
                )
                logger.info(
                    "Hydrated session cache from DB for thread %s (session %s)",
                    input.thread_id, session.id,
                )
            else:
                # Record that we already checked DB — _ensure_session_exists
                # can skip the redundant _find_session_by_thread_id scan.
                self._cache_checked_keys.add(cache_key)

        unseen_messages = await self._get_unseen_messages(input)

        if not unseen_messages:
            # Nothing new to act on. Terminate cleanly rather than starting an execution:
            # with no unseen message there is nothing to pass as `new_message`, and
            # `_start_new_execution` would recover one by reverse-scanning `input.messages`
            # for the latest user message (see `_convert_latest_message`) — re-answering a
            # question that was already answered, and appending a duplicate user event to
            # the session. Clients re-send their whole history on every run, so "everything
            # already processed" is the normal steady state, not a request for a turn.
            logger.info(
                "No unseen messages for thread %s; emitting an empty terminal pair.",
                input.thread_id,
            )
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=input.thread_id,
                run_id=input.run_id,
            )
            yield RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=input.thread_id,
                run_id=input.run_id,
            )
            return

        index = 0
        total_unseen = len(unseen_messages)
        app_name = self._get_app_name(input)
        skip_tool_message_batch = False

        # Check if there are pending tool calls AND tool results in unseen messages
        user_id = self._get_user_id(input)
        has_pending_tools = await self._has_pending_tool_calls(input.thread_id, user_id)
        has_tool_results_in_unseen = any(getattr(msg, "role", None) == "tool" for msg in unseen_messages)

        if has_pending_tools and has_tool_results_in_unseen:
            # HITL/Frontend tool scenario: skip to the tool results first
            # Get backend session_id (should exist since we have pending tools)
            backend_session_id = self._get_backend_session_id(input.thread_id, user_id)
            for i, msg in enumerate(unseen_messages):
                if getattr(msg, "role", None) == "tool":
                    # Mark all messages before the tool result as processed (they're already in the ADK session)
                    skipped_ids = []
                    for j in range(i):
                        msg_id = getattr(unseen_messages[j], "id", None)
                        if msg_id:
                            skipped_ids.append(msg_id)
                    if skipped_ids:
                        self._session_manager.mark_messages_processed(app_name, input.thread_id, skipped_ids)
                    index = i
                    break

        logger.debug(f"[RUN_LOOP] Starting message loop for thread={input.thread_id}, total_unseen={total_unseen}, starting_index={index}")

        # Every path out of this loop must leave the client with a terminal event. The
        # loop can skip every batch (orphaned tool results, assistant-only batches, a
        # non-tool batch whose following tool batch is skipped), in which case nothing
        # below dispatches and the generator would otherwise yield nothing at all.
        # Tracked on the yield rather than on the call so the post-loop check means
        # literally "this run emitted nothing", independent of whether a dispatcher
        # can ever complete without yielding.
        emitted_any = False

        while index < total_unseen:
            current = unseen_messages[index]
            role = getattr(current, "role", None)

            if role == "tool":
                tool_batch: List[Any] = []
                while index < total_unseen and getattr(unseen_messages[index], "role", None) == "tool":
                    tool_batch.append(unseen_messages[index])
                    index += 1

                tool_call_ids = [
                    getattr(message, "tool_call_id", None)
                    for message in tool_batch
                    if getattr(message, "tool_call_id", None)
                ]
                pending_tool_call_ids = await self._get_pending_tool_call_ids(input.thread_id, user_id)

                should_process_tool_batch = True
                if pending_tool_call_ids is not None:
                    if tool_call_ids:
                        pending_tool_call_id_set = set(pending_tool_call_ids)
                        should_process_tool_batch = any(
                            tool_call_id in pending_tool_call_id_set
                            for tool_call_id in tool_call_ids
                        )
                    else:
                        should_process_tool_batch = len(pending_tool_call_ids) > 0

                if not should_process_tool_batch:
                    logger.info(
                        "Skipping tool result batch for thread %s - no matching pending tool calls",
                        input.thread_id,
                    )
                    message_ids = self._collect_message_ids(tool_batch)
                    if message_ids:
                        self._session_manager.mark_messages_processed(
                            app_name,
                            input.thread_id,
                            message_ids,
                        )
                    skip_tool_message_batch = False
                    continue

                # Peek ahead: if there's a non-tool message following, collect it too
                # This allows sending FunctionResponse + user message in ONE invocation
                trailing_messages: List[Any] = []
                trailing_assistant_ids: List[str] = []
                temp_index = index

                # Collect all trailing non-tool messages (skip assistant messages, collect user/system)
                while temp_index < total_unseen and getattr(unseen_messages[temp_index], "role", None) != "tool":
                    candidate = unseen_messages[temp_index]
                    candidate_role = getattr(candidate, "role", None)

                    if candidate_role == "assistant":
                        message_id = getattr(candidate, "id", None)
                        if message_id:
                            trailing_assistant_ids.append(message_id)
                    else:
                        trailing_messages.append(candidate)

                    temp_index += 1

                # If we found trailing messages, advance index and mark assistants as processed
                if trailing_messages or trailing_assistant_ids:
                    index = temp_index

                    if trailing_assistant_ids:
                        self._session_manager.mark_messages_processed(
                            app_name,
                            input.thread_id,
                            trailing_assistant_ids,
                        )

                async for event in self._handle_tool_result_submission(
                    input,
                    tool_messages=tool_batch,
                    trailing_messages=trailing_messages if trailing_messages else None,
                    include_message_batch=not skip_tool_message_batch,
                ):
                    emitted_any = True
                    yield event
                skip_tool_message_batch = False
            else:
                message_batch: List[Any] = []
                assistant_message_ids: List[str] = []

                while index < total_unseen and getattr(unseen_messages[index], "role", None) != "tool":
                    candidate = unseen_messages[index]
                    candidate_role = getattr(candidate, "role", None)

                    if candidate_role == "assistant":
                        message_id = getattr(candidate, "id", None)
                        if message_id:
                            assistant_message_ids.append(message_id)
                    else:
                        message_batch.append(candidate)

                    index += 1

                if assistant_message_ids:
                    self._session_manager.mark_messages_processed(
                        app_name,
                        input.thread_id,
                        assistant_message_ids,
                    )

                if not message_batch:
                    if assistant_message_ids:
                        skip_tool_message_batch = True
                    continue
                else:
                    skip_tool_message_batch = False

                # Check if there's an upcoming tool batch that will be skipped
                # If so, this non-tool batch is part of historical backend tool interaction
                # and should also be skipped
                upcoming_tool_batch_skipped = False
                if index < total_unseen and getattr(unseen_messages[index], "role", None) == "tool":
                    # Peek at the upcoming tool batch
                    peek_idx = index
                    upcoming_tool_call_ids = []
                    while peek_idx < total_unseen and getattr(unseen_messages[peek_idx], "role", None) == "tool":
                        tool_call_id = getattr(unseen_messages[peek_idx], "tool_call_id", None)
                        if tool_call_id:
                            upcoming_tool_call_ids.append(tool_call_id)
                        peek_idx += 1

                    if upcoming_tool_call_ids:
                        pending_ids = await self._get_pending_tool_call_ids(input.thread_id, user_id)
                        if pending_ids is not None:
                            pending_set = set(pending_ids)
                            # If NONE of the upcoming tool results match pending, they're historical
                            if not any(tc_id in pending_set for tc_id in upcoming_tool_call_ids):
                                upcoming_tool_batch_skipped = True

                if upcoming_tool_batch_skipped:
                    # Skip this message batch - it's part of historical backend tool interaction
                    # Mark the messages as processed
                    logger.debug(f"[RUN_LOOP] Skipping message batch (upcoming tool batch will be skipped)")
                    batch_ids = self._collect_message_ids(message_batch)
                    if batch_ids:
                        self._session_manager.mark_messages_processed(app_name, input.thread_id, batch_ids)
                    continue

                logger.debug(f"[RUN_LOOP] Calling _start_new_execution with message_batch of {len(message_batch)} messages")
                async for event in self._start_new_execution(input, message_batch=message_batch):
                    emitted_any = True
                    yield event

        if not emitted_any:
            # Every batch was skipped, so there is no new work to run — but the AG-UI
            # protocol still requires this run to terminate. Emit a bare terminal pair
            # rather than falling through to _start_new_execution(input): that path
            # re-answers the latest message in input.messages (via
            # _convert_latest_message), which would turn a no-op request into a
            # duplicate agent turn.
            logger.info(
                "All message batches were skipped for thread %s (%d unseen message(s)); "
                "emitting an empty terminal pair so the run does not hang the client.",
                input.thread_id,
                total_unseen,
            )
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=input.thread_id,
                run_id=input.run_id,
            )
            yield RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=input.thread_id,
                run_id=input.run_id,
            )

    async def _ensure_session_exists(self, app_name: str, user_id: str, thread_id: str, initial_state: dict) -> Tuple[Any, str]:
        """Ensure a session exists, creating it if necessary via session manager.

        Args:
            app_name: Application name
            user_id: User identifier
            thread_id: The AG-UI thread_id (client-provided identifier)
            initial_state: Initial state for new sessions

        Returns:
            Tuple of (session, backend_session_id)
        """
        cache_key = (thread_id, user_id)
        cached = self._session_lookup_cache.get(cache_key)
        if cached:
            session_id, cached_app_name, cached_user_id = cached
            # Verify session still exists
            session = await self._session_manager.get_session(session_id, cached_app_name, cached_user_id)
            if session:
                logger.debug(f"Session cache hit for thread {thread_id}, user {user_id}: {session_id}")
                await self._verify_pending_tool_calls(cache_key, session_id, cached_app_name, cached_user_id)
                return session, session_id

        # Cache miss or stale — resolve via SessionManager.
        # If run() already scanned DB for this key and found nothing,
        # pass skip_find to avoid a redundant list_sessions call.
        already_scanned = cache_key in self._cache_checked_keys
        self._cache_checked_keys.discard(cache_key)

        try:
            session, backend_session_id = await self._session_manager.get_or_create_session(
                thread_id=thread_id,
                app_name=app_name,
                user_id=user_id,
                initial_state=initial_state,
                skip_find=already_scanned,
            )

            self._session_lookup_cache[cache_key] = (backend_session_id, app_name, user_id)
            await self._verify_pending_tool_calls(cache_key, backend_session_id, app_name, user_id)

            logger.debug(f"Session ready for thread {thread_id}: {backend_session_id}")
            return session, backend_session_id
        except Exception as e:
            logger.error(f"Failed to ensure session for thread {thread_id}: {e}")
            raise

    async def _verify_pending_tool_calls(
        self, cache_key: Tuple[str, str],
        session_id: str, app_name: str, user_id: str,
    ) -> None:
        """On first local access of a session, clear stale pending tool calls.

        Runs once per instance per session. Pending calls are stale when no
        active execution exists to fulfill them (e.g. after a middleware restart).
        In multi-instance deployments where another instance has an active
        execution, pending calls are preserved because the incoming run() will
        carry tool result messages that satisfy them.
        """
        if cache_key in self._sessions_verified_locally:
            return
        self._sessions_verified_locally.add(cache_key)

        existing_pending = await self._session_manager.get_state_value(
            session_id=session_id,
            app_name=app_name,
            user_id=user_id,
            key="pending_tool_calls",
            default=[],
        )
        if not existing_pending:
            return

        # If there's an active execution on this instance waiting for tool
        # results, these calls aren't stale.
        execution = self._active_executions.get(cache_key)
        if execution and not execution.is_complete:
            return

        logger.info(
            "Clearing %d stale pending tool calls for thread %s "
            "(session %s, no active execution on this instance)",
            len(existing_pending), cache_key[0], session_id,
        )
        await self._session_manager.set_state_value(
            session_id=session_id,
            app_name=app_name,
            user_id=user_id,
            key="pending_tool_calls",
            value=[],
        )

    async def _convert_latest_message(
        self,
        input: RunAgentInput,
        messages: Optional[List[Any]] = None,
    ) -> Optional[types.Content]:
        """Convert the latest user message to ADK Content format."""
        target_messages = messages if messages is not None else input.messages

        if not target_messages:
            return None

        # Get the latest user message
        for message in reversed(target_messages):
            if getattr(message, "role", None) == "user" and getattr(message, "content", None):
                parts = convert_message_content_to_parts(getattr(message, "content", None))
                if not parts:
                    return None
                return types.Content(role="user", parts=parts)

        return None
    
    
    async def _get_unseen_messages(self, input: RunAgentInput) -> List[Any]:
        """Return messages that have not yet been processed for this session.

        Filters out ALL processed messages, not just stopping at the first one.
        This handles out-of-order message processing (e.g., LRO tool results arriving
        after subsequent user messages).
        """
        if not input.messages:
            return []

        app_name = self._get_app_name(input)
        session_id = input.thread_id
        processed_ids = self._session_manager.get_processed_message_ids(app_name, session_id)

        # Filter out all processed messages, maintaining chronological order
        unseen: List[Any] = []
        for message in input.messages:
            message_id = getattr(message, "id", None)
            if message_id and message_id in processed_ids:
                continue
            # For ToolMessages, also check if tool_call_id is processed (fixes #437 replay bug)
            # Backend tool results mark their tool_call_id as processed when completed
            tool_call_id = getattr(message, "tool_call_id", None)
            if tool_call_id and tool_call_id in processed_ids:
                continue
            unseen.append(message)

        return unseen

    def _collect_message_ids(self, messages: List[Any]) -> List[str]:
        """Extract message IDs from messages, skipping those without IDs."""
        return [getattr(message, "id") for message in messages if getattr(message, "id", None)]

    async def _is_tool_result_submission(
        self,
        input: RunAgentInput,
        unseen_messages: Optional[List[Any]] = None,
    ) -> bool:
        """Check if this request contains tool results.

        Args:
            input: The run input
            unseen_messages: Optional list of unseen messages to inspect

        Returns:
            True if all unseen messages are tool results
        """
        unseen_messages = unseen_messages if unseen_messages is not None else await self._get_unseen_messages(input)

        if not unseen_messages:
            return False

        last_message = unseen_messages[-1]
        return getattr(last_message, "role", None) == "tool"

    async def _handle_tool_result_submission(
        self,
        input: RunAgentInput,
        *,
        tool_messages: Optional[List[Any]] = None,
        trailing_messages: Optional[List[Any]] = None,
        include_message_batch: bool = True,
    ) -> AsyncGenerator[BaseEvent, None]:
        """Handle tool result submission for existing execution.

        Args:
            input: The run input containing tool results
            tool_messages: Optional pre-filtered tool messages to consider
            trailing_messages: Optional messages that follow the tool batch (e.g., user message)
            include_message_batch: Whether to forward the candidate messages to the execution

        Yields:
            AG-UI events from continued execution
        """
        thread_id = input.thread_id
        app_name = self._get_app_name(input)

        # Extract tool results that are sent by the frontend
        # Note: _extract_tool_results filters out 'confirm_changes' synthetic tool results
        candidate_messages = tool_messages if tool_messages is not None else await self._get_unseen_messages(input)
        tool_results = await self._extract_tool_results(input, candidate_messages)

        # Check if there were actual tool messages that were filtered out
        # (i.e., synthetic confirm_changes tool results)
        actual_tool_messages = [
            msg for msg in candidate_messages
            if hasattr(msg, 'role') and msg.role == "tool"
        ]

        # If all tool results were filtered out (e.g., only confirm_changes messages),
        # we still need to mark those messages as processed and continue with trailing messages
        if not tool_results and actual_tool_messages:
            # Mark the tool messages as processed (they were confirm_changes results)
            tool_message_ids = self._collect_message_ids(actual_tool_messages)
            if tool_message_ids:
                self._session_manager.mark_messages_processed(app_name, thread_id, tool_message_ids)
                logger.debug(
                    "Marked %d synthetic tool result messages as processed for thread %s",
                    len(tool_message_ids),
                    thread_id,
                )

            # If we have trailing messages (e.g., a follow-up user request after confirming changes),
            # process them as a new execution
            if trailing_messages:
                logger.debug(
                    "All tool results were synthetic (confirm_changes); processing %d trailing messages",
                    len(trailing_messages),
                )
                async for event in self._start_new_execution(
                    input,
                    tool_results=None,
                    message_batch=trailing_messages,
                ):
                    yield event
                return

            # No tool results and no trailing messages - nothing to do
            # This is not an error; the user just approved/rejected changes without sending a follow-up.
            # We still need to emit RUN_STARTED/RUN_FINISHED so the client receives a
            # valid, terminal-event-bearing stream (prevents INCOMPLETE_STREAM errors).
            logger.debug(
                "All tool results were synthetic (confirm_changes) with no trailing messages for thread %s",
                thread_id,
            )
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=thread_id,
                run_id=input.run_id,
            )
            yield RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=thread_id,
                run_id=input.run_id,
            )
            return

        # If there were no actual tool messages at all, this is an error
        if not tool_results:
            logger.error(f"Tool result submission without tool results for thread {thread_id}")
            yield RunErrorEvent(
                type=EventType.RUN_ERROR,
                message="No tool results found in submission",
                code="NO_TOOL_RESULTS"
            )
            return

        try:
            user_id = self._get_user_id(input)

            # Snapshot the turn's pending long-running calls BEFORE marking any
            # of the arriving results answered. ``still_pending_after`` is what
            # would remain outstanding once this submission's results apply —
            # used by both the guard immediately below and the "all-results"
            # buffer gate further down.
            pending_before = set(
                await self._get_pending_tool_call_ids(thread_id, user_id) or []
            )
            arriving_ids = {tr["message"].tool_call_id for tr in tool_results}
            still_pending_after = pending_before - arriving_ids

            # ``pending_tool_calls`` is thread-global, so a leaked/orphaned entry
            # from an earlier turn — e.g. a call the model re-issued under a fresh
            # id, orphaning the original (observed on main) — would otherwise gate
            # EVERY future submission forever: the model silently stops resuming.
            # Scope the gate to THIS model turn: a leftover pending call only
            # blocks the resume if it shares the arriving results' invocation_id,
            # i.e. it is a genuine sibling long-running call of the same turn.
            # pending/arriving ids are client-facing while session FunctionCall
            # events store ADK-persisted ids, so apply the LRO id remap before
            # each lookup. If the backend session or the arriving turn can't be
            # resolved, fall back to the unscoped set (preserves the multi-LRO
            # gate rather than risking a premature resume).
            if still_pending_after:
                gate_backend_session_id = self._get_backend_session_id(
                    thread_id, user_id
                )
                gate_session = (
                    await self._session_manager.get_session(
                        gate_backend_session_id, app_name, user_id
                    )
                    if gate_backend_session_id
                    else None
                )
                if gate_session is not None:
                    gate_remap = await self._get_lro_id_remap(
                        gate_backend_session_id, app_name, user_id
                    )
                    arriving_invocations = {
                        self._find_function_call_invocation_id(
                            gate_session, gate_remap.get(aid, aid)
                        )
                        for aid in arriving_ids
                    }
                    arriving_invocations.discard(None)
                    if arriving_invocations:
                        same_turn = {
                            pid
                            for pid in still_pending_after
                            if self._find_function_call_invocation_id(
                                gate_session, gate_remap.get(pid, pid)
                            )
                            in arriving_invocations
                        }
                        orphaned = still_pending_after - same_turn
                        if orphaned:
                            logger.warning(
                                "Thread %s: ignoring %d pending tool call(s) %s "
                                "outside the arriving turn (invocation(s) %s) — "
                                "likely leaked/orphaned pending state; they will "
                                "not gate this resume.",
                                thread_id,
                                len(orphaned),
                                sorted(orphaned),
                                sorted(arriving_invocations),
                            )
                        still_pending_after = same_turn

            # Guard: a trailing user/system message accompanied these results
            # while OTHER long-running calls from the same turn are still
            # unanswered. We can neither resume nor silently absorb it:
            #   - Resuming replays a turn whose function-call parts outnumber its
            #     function-response parts, which the provider 400s (see the
            #     "All-results" gate below).
            #   - The pre-fix behavior forwarded that under-answered turn anyway;
            #     it marked the message processed *before* the model ran, so the
            #     400 surfaced as an opaque provider error AND the user's message
            #     was silently dropped (never re-delivered).
            # There is no correct middleware-only merge — the message is wedged
            # between unanswered calls and may even be directed at the open
            # widget rather than the conversation; that is a client-side concern
            # (answer/cancel the pending call before sending text). So fail
            # loudly and mutate NOTHING: leave pending_tool_calls and every
            # message untouched, returning a clear, dedicated error so the client
            # can resolve or cancel the outstanding call(s) and resubmit. Once
            # all of the turn's results arrive together the message rides along
            # normally (``still_pending_after`` is then empty). A trailing
            # message with no other call pending is the legitimate
            # "FunctionResponse + follow-up message in one turn" case and is not
            # gated. See PR_multi_lro_resume_gating.md ("user message while a
            # call is still pending") and google/adk-python discussion #2739.
            if still_pending_after and trailing_messages:
                logger.warning(
                    "Rejecting tool-result submission for thread %s: a trailing "
                    "message arrived while %d long-running call(s) from the same "
                    "turn are still pending %s. The client must submit their "
                    "results (or cancel them) before sending a new message.",
                    thread_id,
                    len(still_pending_after),
                    sorted(still_pending_after),
                )
                yield RunErrorEvent(
                    type=EventType.RUN_ERROR,
                    message=(
                        "Cannot start a new message while long-running tool "
                        f"call(s) {sorted(still_pending_after)} from the current "
                        "turn are still pending. Submit their results or cancel "
                        "them before sending another message."
                    ),
                    code="PENDING_TOOL_CALLS",
                )
                return

            # "All-results" gate for a turn with multiple long-running calls.
            # The client returns each long-running result independently (an
            # instant frontend tool resolves before a HITL one, etc.). Resuming
            # the model on a partial set would replay a turn whose
            # function-call parts outnumber its function-response parts, which
            # the provider rejects (Gemini: "number of function response parts
            # [must] equal the number of function call parts of the function
            # call turn"). So if any long-running call from this turn is still
            # unanswered, persist what we just received and stop here without
            # resuming; the buffered responses are merged with the remaining
            # ones (ADK's _rearrange_events_for_latest_function_response) once
            # the final result arrives. (The trailing-message variant of this
            # situation was already rejected by the guard above, so reaching here
            # with calls still pending implies there was no trailing message.)
            # Reuse the turn-scoped snapshot from above. A fresh global re-read
            # here would resurrect leaked/orphaned entries the scope check
            # already excluded, re-introducing the buffer-forever stall.
            if still_pending_after:
                logger.info(
                    "Buffering %d tool result(s) for thread %s; %d long-running "
                    "call(s) from the same turn still pending %s — deferring "
                    "model resume until the turn is complete.",
                    len(tool_results),
                    thread_id,
                    len(still_pending_after),
                    sorted(still_pending_after),
                )
                # Persist FIRST, then advance bookkeeping only on success. Until
                # the append lands, the arriving calls are still pending and
                # their messages still unprocessed, so a persistence failure
                # surfaces a dedicated RUN_ERROR and mutates NOTHING — the client
                # can simply resubmit. (Doing the pending-removal / mark-processed
                # before persisting could leave the turn unable to ever balance
                # while the result was silently dropped.)
                try:
                    await self._buffer_tool_results(input, tool_results)
                except Exception as buffer_error:
                    logger.error(
                        "Failed to buffer tool result(s) for thread %s: %s",
                        thread_id,
                        buffer_error,
                        exc_info=True,
                    )
                    yield RunErrorEvent(
                        type=EventType.RUN_ERROR,
                        message=(
                            "Failed to persist tool result(s) while waiting for "
                            f"the rest of the turn: {buffer_error}. No state was "
                            "changed; resubmit the result(s)."
                        ),
                        code="TOOL_RESULT_BUFFER_ERROR",
                    )
                    return
                # Persisted: now it is safe to remove the arriving calls from the
                # pending set and mark their messages processed so they aren't
                # re-extracted when the turn finally resumes.
                for tool_result in tool_results:
                    tool_call_id = tool_result["message"].tool_call_id
                    if await self._has_pending_tool_calls(thread_id, user_id):
                        await self._remove_pending_tool_call(
                            thread_id, tool_call_id, user_id
                        )
                buffered_message_ids = self._collect_message_ids(
                    [tr["message"] for tr in tool_results]
                )
                if buffered_message_ids:
                    self._session_manager.mark_messages_processed(
                        app_name, thread_id, buffered_message_ids
                    )
                yield RunStartedEvent(
                    type=EventType.RUN_STARTED,
                    thread_id=thread_id,
                    run_id=input.run_id,
                )
                yield RunFinishedEvent(
                    type=EventType.RUN_FINISHED,
                    thread_id=thread_id,
                    run_id=input.run_id,
                )
                return

            # All of this turn's long-running calls are answered: remove them
            # from the pending set, then resume the model with the results. Use
            # trailing_messages if provided, otherwise fall back to
            # candidate_messages.
            for tool_result in tool_results:
                tool_call_id = tool_result["message"].tool_call_id
                if await self._has_pending_tool_calls(thread_id, user_id):
                    await self._remove_pending_tool_call(thread_id, tool_call_id, user_id)

            message_batch = trailing_messages if trailing_messages else (candidate_messages if include_message_batch else None)

            async for event in self._start_new_execution(
                input,
                tool_results=tool_results,
                message_batch=message_batch,
            ):
                yield event

        except Exception as e:
            logger.error(f"Error handling tool results: {e}", exc_info=True)
            yield RunErrorEvent(
                type=EventType.RUN_ERROR,
                message=f"Failed to process tool results: {str(e)}",
                code="TOOL_RESULT_PROCESSING_ERROR"
            )
    
    def _build_function_response_parts(
        self,
        tool_results: List[Dict],
        lro_id_remap: Dict[str, str],
    ) -> List[types.Part]:
        """Convert AG-UI tool-result messages into ADK FunctionResponse parts.

        Shared by the resume path (``_run_async_impl``) and the buffer path
        (``_buffer_tool_results``). Applies the client->ADK LRO id remap and
        parses each result's content as JSON when possible, falling back to
        wrapping the raw string; empty content becomes an empty success.
        """
        function_response_parts: List[types.Part] = []
        for tool_result in tool_results:
            tool_call_id = tool_result["message"].tool_call_id
            # Apply LRO ID remap: convert client-facing ID to ADK-persisted ID.
            tool_call_id = lro_id_remap.get(tool_call_id, tool_call_id)
            content = tool_result["message"].content

            logger.debug(
                f"Received tool result for call {tool_call_id}: "
                f"content='{content}', type={type(content)}"
            )

            # Parse content - try JSON first, fall back to plain string.
            try:
                if content and content.strip():
                    try:
                        result = json.loads(content)
                    except json.JSONDecodeError:
                        # Not valid JSON - treat as plain string result.
                        result = {"success": True, "result": content, "status": "completed"}
                        logger.debug(
                            f"Tool result for {tool_call_id} is plain string, "
                            "wrapped in result object"
                        )
                else:
                    # Handle empty content as a success with empty result.
                    result = {"success": True, "result": None, "status": "completed"}
                    logger.warning(
                        f"Empty tool result content for tool call {tool_call_id}, "
                        "using empty success result"
                    )
            except Exception as e:
                # Handle any other error.
                result = {"success": True, "result": str(content) if content else None, "status": "completed"}
                logger.warning(
                    f"Error processing tool result for {tool_call_id}: {e}, "
                    "using string fallback"
                )

            function_response_parts.append(
                types.Part(
                    function_response=types.FunctionResponse(
                        id=tool_call_id,
                        name=tool_result["tool_name"],
                        response=result,
                    )
                )
            )
        return function_response_parts

    async def _buffer_tool_results(
        self,
        input: RunAgentInput,
        tool_results: List[Dict],
    ) -> None:
        """Persist FunctionResponse(s) for resolved long-running calls WITHOUT
        resuming the model.

        Used by the "all-results" gate in ``_handle_tool_result_submission``
        when a model turn emitted multiple long-running tool calls and only some
        have results so far. The responses are appended to the ADK session —
        tagged with the originating FunctionCall's invocation_id, exactly like
        the resume path — so they persist and are merged with the remaining
        responses when the turn completes, instead of running the model on a
        partially-answered turn.
        """
        user_id = self._get_user_id(input)
        app_name = self._get_app_name(input)
        backend_session_id = self._get_backend_session_id(input.thread_id, user_id)
        session = (
            await self._session_manager.get_session(
                backend_session_id, app_name, user_id
            )
            if backend_session_id
            else None
        )
        if session is None:
            # Raise rather than silently no-op. The caller (the buffer gate)
            # advances pending/processed bookkeeping only AFTER this returns, so
            # a silent drop here would wedge the turn — it could never balance —
            # while the result vanished. Surfacing it lets the caller emit a
            # RUN_ERROR and leave state untouched for a clean resubmit.
            raise RuntimeError(
                f"Cannot buffer tool results for thread {input.thread_id}: "
                "no backend session."
            )

        # Same client->ADK id remap the resume path uses: with SSE streaming the
        # partial and final events can carry different function-call ids.
        lro_id_remap = await self._get_lro_id_remap(
            backend_session_id, app_name, user_id
        )

        # Mirror the resume path's parsing (JSON when possible, else wrap the
        # raw string; empty content becomes an empty success).
        function_response_parts = self._build_function_response_parts(
            tool_results, lro_id_remap
        )

        # Tag with the originating FunctionCall event's invocation_id so ADK
        # pairs this response with its call (and DatabaseSessionService receives
        # a non-null invocation_id — see #957).
        invocation_id = (
            self._find_function_call_invocation_id(
                session, function_response_parts[0].function_response.id
            )
            or input.run_id
        )
        await self._session_manager._session_service.append_event(
            session,
            Event(
                timestamp=time.time(),
                author="user",
                content=types.Content(parts=function_response_parts, role="user"),
                invocation_id=invocation_id,
            ),
        )
        # Mirror the resume path (see the append_event calls in _run_async_impl):
        # drop the cached session snapshot so a later read in the same execution
        # observes this just-appended FunctionResponse rather than a stale
        # pre-append copy.
        self._session_manager.invalidate_session(
            backend_session_id, app_name, user_id
        )
        logger.debug(
            "Buffered %d FunctionResponse(s) for thread %s (invocation_id=%s) "
            "without resuming the model.",
            len(function_response_parts),
            input.thread_id,
            invocation_id,
        )

    async def _extract_tool_results(
        self,
        input: RunAgentInput,
        candidate_messages: Optional[List[Any]] = None,
    ) -> List[Dict]:
        """Extract tool messages with their names from input.

        Only extracts tool messages provided in candidate_messages. When no
        candidates are supplied, all messages are considered.

        IMPORTANT: This method filters out 'confirm_changes' tool results.
        'confirm_changes' is a synthetic tool call emitted by the middleware
        to trigger the frontend's confirmation UI dialog. ADK never actually
        called this tool, so we must NOT send its result back to ADK - doing
        so would cause "No function call event found for function responses ids"
        errors because ADK's session has no matching FunctionCall.

        Args:
            input: The run input
            candidate_messages: Optional subset of messages to inspect

        Returns:
            List of dicts containing tool name and message ordered chronologically
        """
        # Create a mapping of tool_call_id to tool name
        tool_call_map = {}
        for message in input.messages:
            if hasattr(message, 'tool_calls') and message.tool_calls:
                for tool_call in message.tool_calls:
                    tool_call_map[tool_call.id] = tool_call.function.name

        messages_to_check = candidate_messages or input.messages
        extracted_results: List[Dict] = []

        for message in messages_to_check:
            if hasattr(message, 'role') and message.role == "tool":
                tool_name = tool_call_map.get(getattr(message, 'tool_call_id', None), "unknown")

                # Skip 'confirm_changes' tool results - this is a synthetic tool call
                # emitted by the middleware to trigger the frontend confirmation dialog.
                # ADK never called this tool, so we must not send its result to ADK.
                if tool_name == "confirm_changes":
                    logger.debug(
                        "Skipping confirm_changes tool result (synthetic tool): tool_call_id=%s",
                        getattr(message, 'tool_call_id', None),
                    )
                    continue

                logger.debug(
                    "Extracted ToolMessage: role=%s, tool_call_id=%s, content='%s'",
                    getattr(message, 'role', None),
                    getattr(message, 'tool_call_id', None),
                    getattr(message, 'content', None),
                )
                extracted_results.append({
                    'tool_name': tool_name,
                    'message': message
                })

        return extracted_results

    async def _stream_events(
        self, 
        execution: ExecutionState
    ) -> AsyncGenerator[BaseEvent, None]:
        """Stream events from execution queue.
        
        Args:
            execution: The execution state
            
        Yields:
            AG-UI events from the queue
        """
        logger.debug(f"Starting _stream_events for thread {execution.thread_id}, queue ID: {id(execution.event_queue)}")
        event_count = 0
        timeout_count = 0
        
        while True:
            try:
                logger.debug(f"Waiting for event from queue (thread {execution.thread_id}, queue size: {execution.event_queue.qsize()})")
                
                # Wait for event with timeout
                event = await asyncio.wait_for(
                    execution.event_queue.get(),
                    timeout=1.0  # Check every second
                )
                
                event_count += 1
                logger.debug(f"Got event #{event_count} from queue: {type(event).__name__ if event else 'None'} (thread {execution.thread_id})")

                if event is None:
                    # Execution complete
                    execution.is_complete = True
                    logger.debug(f"Execution complete for thread {execution.thread_id} after {event_count} events")
                    break
                
                logger.debug(f"Streaming event #{event_count}: {type(event).__name__} (thread {execution.thread_id})")
                yield event
                
            except asyncio.TimeoutError:
                timeout_count += 1
                logger.debug(f"Timeout #{timeout_count} waiting for events (thread {execution.thread_id}, task done: {execution.task.done()}, queue size: {execution.event_queue.qsize()})")
                
                # Check if execution is stale
                if execution.is_stale(self._execution_timeout):
                    logger.error(f"Execution timed out for thread {execution.thread_id}")
                    yield RunErrorEvent(
                        type=EventType.RUN_ERROR,
                        message="Execution timed out",
                        code="EXECUTION_TIMEOUT"
                    )
                    break
                
                # Check if task is done
                if execution.task.done():
                    # Task completed but didn't send None
                    execution.is_complete = True
                    try:
                        task_result = execution.task.result()
                        logger.debug(f"Task completed with result: {task_result} (thread {execution.thread_id})")
                    except Exception as e:
                        logger.debug(f"Task completed with exception: {e} (thread {execution.thread_id})")
                    
                    # Wait a bit more in case there are events still coming
                    logger.debug(f"Task done but no None signal - checking queue one more time (thread {execution.thread_id}, queue size: {execution.event_queue.qsize()})")
                    if execution.event_queue.qsize() > 0:
                        logger.debug(f"Found {execution.event_queue.qsize()} events in queue after task completion, continuing...")
                        continue
                    
                    logger.debug(f"Task completed without sending None signal (thread {execution.thread_id})")
                    break
    
    @staticmethod
    def _build_interrupt_outcome(
        pending_tool_call_ids: List[str],
        *,
        emit_interrupts: bool,
    ) -> Optional[RunFinishedInterruptOutcome]:
        """Build a ``RunFinishedInterruptOutcome`` from unresolved tool calls.

        Returns ``None`` (→ legacy ``outcome``-less ``RUN_FINISHED``) when the
        feature is disabled or the run didn't pause on any tool call. Otherwise
        one ``Interrupt`` per pending tool call, with both ``id`` and
        ``tool_call_id`` set to the tool call id so the client can correlate and
        address it in the ``resume`` array of the next ``RunAgentInput``.
        """
        if not (emit_interrupts and pending_tool_call_ids):
            return None
        return RunFinishedInterruptOutcome(
            interrupts=[
                Interrupt(id=tcid, reason="tool_call", tool_call_id=tcid)
                for tcid in pending_tool_call_ids
            ]
        )

    async def _start_new_execution(
        self,
        input: RunAgentInput,
        *,
        tool_results: Optional[List[Dict]] = None,
        message_batch: Optional[List[Any]] = None,
    ) -> AsyncGenerator[BaseEvent, None]:
        """Start a new ADK execution with tool support.

        Args:
            input: The run input

        Yields:
            AG-UI events from the execution
        """
        # Log execution context for debugging
        tool_result_ids = [tr['message'].tool_call_id for tr in tool_results] if tool_results else []
        message_batch_len = len(message_batch) if message_batch else 0
        exec_type = "HITL_RESUME" if tool_results else "NEW_RUN"
        logger.info(f"[EXEC] {exec_type} - thread={input.thread_id}, run={input.run_id}, tool_results={tool_result_ids}, message_batch_len={message_batch_len}")

        user_id = self._get_user_id(input)
        exec_key = (input.thread_id, user_id)
        session_cache_token = self._session_manager.start_session_read_cache()

        try:
            # Emit RUN_STARTED
            logger.debug(f"Emitting RUN_STARTED for thread {input.thread_id}, run {input.run_id}")
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=input.thread_id,
                run_id=input.run_id
            )
            
            # Check concurrent execution limit
            async with self._execution_lock:
                if len(self._active_executions) >= self._max_concurrent:
                    # Clean up stale executions
                    await self._cleanup_stale_executions()
                    
                    if len(self._active_executions) >= self._max_concurrent:
                        raise RuntimeError(
                            f"Maximum concurrent executions ({self._max_concurrent}) reached"
                        )
                
                # Check if there's an existing execution for this thread+user and wait for it
                existing_execution = self._active_executions.get(exec_key)

            # If there was an existing execution, wait for it to complete
            if existing_execution and not existing_execution.is_complete:
                logger.debug(f"Waiting for existing execution to complete for thread {input.thread_id}")
                try:
                    await existing_execution.task
                except Exception as e:
                    logger.debug(f"Previous execution completed with error: {e}")
            
            # Start background execution
            execution = await self._start_background_execution(
                input,
                tool_results=tool_results,
                message_batch=message_batch,
            )
            
            # Store execution (replacing any previous one)
            async with self._execution_lock:
                self._active_executions[exec_key] = execution
            
            # Stream events and track tool calls
            logger.debug(f"Starting to stream events for execution {execution.thread_id}")
            app_name = self._get_app_name(input)

            logger.debug(f"About to iterate over _stream_events for execution {execution.thread_id}")
            # Track whether a terminal event already flowed through the queue.
            # The background producer surfaces failures as a RUN_ERROR data
            # event (see _run_adk_in_background) rather than by raising, so the
            # loop below completes normally and would otherwise fall through to
            # the unconditional RUN_FINISHED. The AG-UI spec allows at most one
            # terminal event per run, and @ag-ui/client's state machine rejects
            # a RUN_FINISHED that follows a RUN_ERROR. See issue #1892.
            run_errored = False
            # Track tool calls that end without a result within this run. A
            # frontend / long-running (HITL) tool call emits TOOL_CALL_START/
            # ARGS/END but no TOOL_CALL_RESULT, so whatever remains here at
            # RUN_FINISHED is the set the run is paused on. Only used when
            # emit_interrupts is enabled.
            pending_tool_call_ids: List[str] = []
            async for event in self._stream_events(execution):
                # HITL pending_tool_calls persistence happens on the producer
                # side via _HitlDeferringQueue: HITL TOOL_CALL_END events are
                # buffered until the producer's persistence write completes
                # after runner.run_async exits. By the time the consumer
                # observes a ToolCallEndEvent here, the corresponding
                # pending_tool_calls entry is already in session.state (or
                # the event was a non-HITL TCE that doesn't need persistence
                # at all). See issues #1581, #1652, #1732, and #1755.

                # Always mark tool_call_id as processed when its result is
                # observed, so replay logic skips it on resumption (fixes #437
                # replay bug). This is in-memory bookkeeping; it does NOT
                # touch session.state or any DB marker.
                if isinstance(event, ToolCallEndEvent):
                    if event.tool_call_id not in pending_tool_call_ids:
                        pending_tool_call_ids.append(event.tool_call_id)

                if isinstance(event, ToolCallResultEvent):
                    logger.info(f"Detected ToolCallResultEvent with id: {event.tool_call_id}")
                    self._session_manager.mark_messages_processed(
                        app_name, execution.thread_id, [event.tool_call_id]
                    )
                    # Resolved in-stream (backend tool) — not a pending interrupt.
                    if event.tool_call_id in pending_tool_call_ids:
                        pending_tool_call_ids.remove(event.tool_call_id)

                if isinstance(event, RunErrorEvent):
                    run_errored = True

                logger.debug(f"Yielding event: {type(event).__name__}")
                yield event

            logger.debug(f"Finished iterating over _stream_events for execution {execution.thread_id}")
            logger.debug(f"Finished streaming events for execution {execution.thread_id}")

            # Emit RUN_FINISHED only if the run did not already terminate with a
            # RUN_ERROR from the queue path (issue #1892).
            if run_errored:
                logger.debug(
                    f"Skipping RUN_FINISHED for thread {input.thread_id}, run {input.run_id}: "
                    "run already terminated with RUN_ERROR"
                )
            else:
                logger.debug(f"Emitting RUN_FINISHED for thread {input.thread_id}, run {input.run_id}")
                # If the run paused on HITL/long-running tool calls, surface them
                # as AG-UI interrupts on the outcome (opt-in). See issue for the
                # resume-consumption follow-up.
                outcome = self._build_interrupt_outcome(
                    pending_tool_call_ids, emit_interrupts=self._emit_interrupts
                )
                if outcome is not None:
                    logger.debug(
                        f"RUN_FINISHED with {len(pending_tool_call_ids)} interrupt(s) "
                        f"for thread {input.thread_id}"
                    )
                yield RunFinishedEvent(
                    type=EventType.RUN_FINISHED,
                    thread_id=input.thread_id,
                    run_id=input.run_id,
                    outcome=outcome,
                )
            
        except Exception as e:
            logger.error(f"Error in new execution: {e}", exc_info=True)
            yield RunErrorEvent(
                type=EventType.RUN_ERROR,
                message=str(e),
                code="EXECUTION_ERROR"
            )
        finally:
            try:
                # The ADK runner can mutate session state without going
                # through SessionManager, so the parent context's pre-run read
                # cache is stale by the time this cleanup guard runs.
                self._session_manager.disable_session_read_cache()
                # Clean up execution if complete and no pending tool calls (HITL scenarios)
                async with self._execution_lock:
                    if exec_key in self._active_executions:
                        execution = self._active_executions[exec_key]
                        execution.is_complete = True

                        # Check if session has pending tool calls before cleanup
                        has_pending = await self._has_pending_tool_calls(input.thread_id, user_id)
                        if not has_pending:
                            del self._active_executions[exec_key]
            finally:
                self._session_manager.stop_session_read_cache(session_cache_token)
    
    @staticmethod
    def _collect_output_schema_agent_names(agent: Any, result: Optional[set] = None) -> set:
        """Walk the agent tree and collect names of LlmAgents with output_schema.

        These agents produce structured output (e.g. a classifier returning
        "CHAT") that should not appear as user-visible text messages in the
        chat UI.  The returned set is passed to EventTranslator so it can
        suppress TextMessageEvents from these authors.  (GitHub #1390)
        """
        if result is None:
            result = set()
        if isinstance(agent, LlmAgent) and getattr(agent, 'output_schema', None):
            result.add(agent.name)
        sub_agents = getattr(agent, 'sub_agents', None)
        if isinstance(sub_agents, (list, tuple)):
            for sub in sub_agents:
                ADKAgent._collect_output_schema_agent_names(sub, result)
        graph = getattr(agent, 'graph', None)
        graph_nodes = getattr(graph, 'nodes', None)
        if isinstance(graph_nodes, (list, tuple)):
            for node in graph_nodes:
                ADKAgent._collect_output_schema_agent_names(node, result)
        return result

    @staticmethod
    def _shallow_copy_agent_tree(agent: Any) -> Any:
        """Shallow-copy an agent and its sub-agent tree.

        Creates new model instances so that fields like ``instruction``,
        ``tools``, and ``sub_agents`` can be reassigned per-execution without
        mutating the originals.  Tool objects themselves are shared by
        reference, which avoids errors with non-deep-copyable tools (e.g.
        ADK ``McpToolset`` whose ``errlog`` field holds an unpicklable
        ``TextIOWrapper``).
        """
        try:
            copied = agent.model_copy(deep=False)
        except AttributeError:
            # Agent is not a Pydantic model (e.g. a Mock in tests);
            # return as-is since it cannot be shallow-copied.
            return agent

        tools = getattr(copied, 'tools', None)
        if isinstance(tools, (list, tuple)):
            copied.tools = list(tools)

        sub_agents = getattr(copied, 'sub_agents', None)
        if isinstance(sub_agents, (list, tuple)):
            copied_subs = [ADKAgent._shallow_copy_agent_tree(sa) for sa in sub_agents]
            # Re-parent each copied sub-agent so parent_agent points at the
            # copied parent rather than the original.  Without this, ADK's
            # transfer_to_agent walks parent_agent up to the original (stale)
            # tree, escaping the per-run copy whose tools were replaced.
            # Skip the early-return case where the sub-agent could not be
            # copied and was returned as-is (e.g. non-Pydantic test mocks) —
            # mutating its parent_agent would leak into the original tree.
            for sub, original in zip(copied_subs, sub_agents):
                if isinstance(sub, BaseAgent) and sub is not original:
                    sub.parent_agent = copied
            copied.sub_agents = copied_subs

        return copied

    async def _start_background_execution(
        self,
        input: RunAgentInput,
        *,
        tool_results: Optional[List[Dict]] = None,
        message_batch: Optional[List[Any]] = None,
    ) -> ExecutionState:
        """Start ADK execution in background with tool support.

        Args:
            input: The run input

        Returns:
            ExecutionState tracking the background execution
        """
        # Shared set of HITL (long-running) tool call IDs. Populated by the
        # producer side (EventTranslator's LRO branch in
        # _run_adk_in_background and ClientProxyTool) BEFORE TOOL_CALL_END is
        # enqueued, so the deferring queue (next line) can identify HITL
        # ends at put time. See issues #1652 and #1755.
        long_running_tool_ids: set[str] = set()

        # Wrap the inner asyncio.Queue with _HitlDeferringQueue so HITL
        # ToolCallEndEvents are held back until the producer has persisted
        # the matching pending_tool_calls IDs. Non-HITL events stream
        # through unblocked, restoring the streaming fidelity that PR
        # #1735's consumer-side gate sacrificed. See issue #1755.
        event_queue: _HitlDeferringQueue = _HitlDeferringQueue(long_running_tool_ids)
        logger.debug(f"Created event queue {id(event_queue)} for thread {input.thread_id}")
        # Extract necessary information
        user_id = self._get_user_id(input)
        app_name = self._get_app_name(input)

        # Shallow-copy the agent tree so we can modify instruction/tools
        # per-execution without mutating the original.  Tool objects are
        # shared by reference (not deep-copied) to avoid errors with
        # non-picklable tools such as ADK McpToolset.
        adk_agent = self._shallow_copy_agent_tree(self._adk_agent)

        # Handle SystemMessage if it's the first message - append to agent instructions
        if input.messages and isinstance(input.messages[0], SystemMessage):
            system_content = input.messages[0].content
            if system_content and isinstance(adk_agent, LlmAgent):
                current_instruction = adk_agent.instruction

                if callable(current_instruction):
                    # Handle instructions provider
                    if inspect.iscoroutinefunction(current_instruction):
                        # Async instruction provider
                        async def instruction_provider_wrapper_async(*args, **kwargs):
                            instructions = system_content
                            original_instructions = await current_instruction(*args, **kwargs) or ''
                            if original_instructions:
                                instructions = f"{original_instructions}\n\n{instructions}"
                            return instructions
                        new_instruction = instruction_provider_wrapper_async
                    else:
                        # Sync instruction provider
                        def instruction_provider_wrapper_sync(*args, **kwargs):
                            instructions = system_content
                            original_instructions = current_instruction(*args, **kwargs) or ''
                            if original_instructions:
                                instructions = f"{original_instructions}\n\n{instructions}"
                            return instructions
                        new_instruction = instruction_provider_wrapper_sync

                    logger.debug(
                        f"Will wrap callable InstructionProvider and append SystemMessage: '{system_content[:100]}...'")
                else:
                    # Handle string instructions
                    if current_instruction:
                        new_instruction = f"{current_instruction}\n\n{system_content}"
                    else:
                        new_instruction = system_content
                    logger.debug(f"Will append SystemMessage to string instructions: '{system_content[:100]}...'")

                adk_agent.instruction = new_instruction

        # A2UI auto-injection (mirrors the Strands adapter). When the runtime
        # forwards ``injectA2UITool`` (or the host opts in via the ``a2ui``
        # config), inject a ``generate_a2ui`` recovery tool onto the root
        # ``LlmAgent``, infer the sub-agent model from its ``canonical_model``,
        # and drop the injected ``render_a2ui`` frontend proxy so the model calls
        # generate_a2ui directly. Best-effort: a failure here logs and the run
        # proceeds without A2UI rather than crashing the turn.
        a2ui_plan: Optional[dict] = None
        frontend_tools = input.tools
        try:
            forwarded = (
                input.forwarded_props
                if isinstance(input.forwarded_props, dict)
                else {}
            )
            flag = forwarded.get("injectA2UITool")
            if flag is None and self._a2ui_config:
                flag = self._a2ui_config.get("inject_a2ui_tool")
            if flag:
                # Resolve the model + existing tool names from the per-run root
                # only when injection is actually requested — avoids touching the
                # LLM registry on every unrelated run. A non-LlmAgent root has no
                # inferable model; pass None so the planner warns and skips.
                root_model = None
                existing_tool_names: list[str] = []
                if isinstance(adk_agent, LlmAgent):
                    try:
                        root_model = adk_agent.canonical_model
                    except Exception as e:  # noqa: BLE001 — degrade, don't crash
                        logger.warning(
                            "A2UI auto-inject: could not resolve the agent's "
                            "model; skipping injection: %s",
                            e,
                        )
                    existing_tool_names = [
                        name
                        for tool in (adk_agent.tools or [])
                        if (name := getattr(tool, "name", None))
                    ]
                a2ui_plan = plan_a2ui_injection(
                    model=root_model,
                    input=input,
                    existing_tool_names=existing_tool_names,
                    config=self._a2ui_config,
                    log=logger,
                )
                if a2ui_plan:
                    drop = set(a2ui_plan["drop_tool_names"])
                    frontend_tools = [
                        t
                        for t in (input.tools or [])
                        if (
                            t.get("name")
                            if isinstance(t, dict)
                            else getattr(t, "name", None)
                        )
                        not in drop
                    ]
        except Exception as e:  # noqa: BLE001 — never crash the turn here
            logger.error(
                "A2UI auto-injection planning failed; running without A2UI for "
                "this turn: %s",
                e,
                exc_info=True,
            )
            a2ui_plan = None
            frontend_tools = input.tools

        # Log tools available from frontend
        tool_names = [t.name for t in frontend_tools] if frontend_tools else []
        logger.info(f"Tools from frontend: {tool_names}")

        # Track all ClientProxyToolset instances for collecting accumulated predictive state
        client_proxy_toolsets: list[ClientProxyToolset] = []

        def _update_agent_tools_recursive(agent: Any) -> None:
            """Replace every ``AGUIToolset`` placeholder with a per-run
            ``ClientProxyToolset`` in the agent tree.

            The placeholder carries no client info; this builds a concrete
            ``ClientProxyToolset`` from ``input.tools`` (with this run's
            ``event_queue``) and swaps it into the per-run agent's ``tools``
            list. Because ``_shallow_copy_agent_tree`` gave this agent its own
            ``tools`` list and the construction-time placeholder is never
            mutated, concurrent runs are fully isolated. (An earlier
            ``AGUIToolset.bind()`` delegation stored the per-run toolset on the
            shared placeholder and was not concurrency-safe; replacement restores
            per-run isolation. ADK 2.0 GA reads ``agent.tools`` fresh per
            invocation, so the swap is picked up — see
            ``tests/test_agui_toolset_concurrency.py``.)

            Args:
                agent: Agent instance to process recursively.
            """
            nonlocal client_proxy_toolsets
            logger.info(f"[TOOL_SETUP] Processing agent: {agent.name} (type: {type(agent).__name__})")

            if isinstance(agent, LlmAgent) and hasattr(agent, "tools"):
                tool_count = len(agent.tools) if agent.tools else 0
                logger.info(f"[TOOL_SETUP] Agent {agent.name} has {tool_count} tools before replacement")

                new_tools: list[ToolUnion] = []
                for tool in agent.tools:
                    if isinstance(tool, AGUIToolset):
                        logger.info(
                            f"[TOOL_SETUP] Agent {agent.name}: Found AGUIToolset with "
                            f"filter={tool.tool_filter}; replacing with per-run ClientProxyToolset"
                        )
                        proxy_toolset = ClientProxyToolset(
                            ag_ui_tools=frontend_tools,
                            event_queue=event_queue,
                            tool_filter=tool.tool_filter,
                            tool_name_prefix=tool.tool_name_prefix,
                            predict_state=self._predict_state,
                        )
                        client_proxy_toolsets.append(proxy_toolset)
                        # Swap the placeholder for a fresh per-run
                        # ClientProxyToolset in THIS run's tools list.
                        # _shallow_copy_agent_tree gave this agent its own list,
                        # so concurrent runs never share a proxy (each carries
                        # its own input.tools + event_queue) and the
                        # construction-time AGUIToolset is never mutated.
                        tool = proxy_toolset
                    elif isinstance(tool, A2UISubAgentTool):
                        # Per-run swap: give this run's A2UI subagent tool its own
                        # event_queue so it can emit the nested render_a2ui
                        # tool-call stream onto THIS run's stream — without mutating
                        # the shared construction-time instance (concurrency-safe,
                        # mirrors the ClientProxyToolset replacement above).
                        tool = tool.for_run(event_queue)
                    new_tools.append(tool)

                # Auto-inject the A2UI ``generate_a2ui`` tool onto the ROOT
                # LlmAgent only (the planning agent — mirrors the Strands
                # adapter's single-agent injection). ``plan_a2ui_injection``
                # already honored USER-PREVAILS (a dev-wired generate_a2ui makes
                # the plan None), so this never double-adds. Bind this run's
                # event_queue via ``for_run`` exactly like the dev-wired branch.
                if a2ui_plan is not None and agent is adk_agent:
                    new_tools.append(a2ui_plan["tool"].for_run(event_queue))
                    logger.info(
                        f"[TOOL_SETUP] Agent {agent.name}: auto-injected "
                        f"'{a2ui_plan['tool_name']}' (dropped frontend "
                        f"{a2ui_plan['drop_tool_names']})"
                    )

                agent.tools = new_tools
                logger.info(f"[TOOL_SETUP] Agent {agent.name} now has {len(new_tools)} tools after replacement")

            # Recursively process sub-agents if they exist
            # This handles SequentialAgent, LoopAgent, and other composite agents
            sub_agents = getattr(agent, "sub_agents", None)
            if sub_agents and isinstance(sub_agents, (list, tuple)):
                logger.info(f"[TOOL_SETUP] Agent {agent.name} has {len(sub_agents)} sub-agents")
                for sub_agent in sub_agents:
                    _update_agent_tools_recursive(sub_agent)

        _update_agent_tools_recursive(adk_agent)

        # Create background task
        logger.debug(f"Creating background task for thread {input.thread_id}")
        run_kwargs = {
            "input": input,
            "adk_agent": adk_agent,
            "user_id": user_id,
            "app_name": app_name,
            "event_queue": event_queue,
            "client_proxy_toolsets": client_proxy_toolsets,
            "long_running_tool_ids": long_running_tool_ids,
        }

        if tool_results is not None:
            run_kwargs["tool_results"] = tool_results

        if message_batch is not None:
            run_kwargs["message_batch"] = message_batch

        task = asyncio.create_task(self._run_adk_in_background(**run_kwargs))
        logger.debug(f"Background task created for thread {input.thread_id}: {task}")

        return ExecutionState(
            task=task,
            thread_id=input.thread_id,
            event_queue=event_queue,
            long_running_tool_ids=long_running_tool_ids,
        )
    
    async def _run_adk_in_background(
        self,
        input: RunAgentInput,
        adk_agent: BaseAgent,
        user_id: str,
        app_name: str,
        event_queue: asyncio.Queue,
        client_proxy_toolsets: List[ClientProxyToolset],
        long_running_tool_ids: Optional[Set[str]] = None,
        tool_results: Optional[List[Dict]] = None,
        message_batch: Optional[List[Any]] = None,
    ):
        """Run ADK agent in background, emitting events to queue.

        Args:
            input: The run input
            adk_agent: The ADK agent to run (already prepared with tools and SystemMessage)
            user_id: User ID
            app_name: App name
            event_queue: Queue for emitting events
            long_running_tool_ids: Shared set of HITL tool call IDs. Populated
                by this producer (from ADK Event.long_running_tool_ids) and by
                ClientProxyTool before TOOL_CALL_END events are enqueued, so the
                consumer can gate session.state writes on HITL membership.
                See issue #1652.
        """
        # Default for older call paths / tests that don't supply the set.
        if long_running_tool_ids is None:
            long_running_tool_ids = set()
        runner: Optional[Runner] = None
        backend_session_id: Optional[str] = None
        # Buffer LRO ID remap updates discovered during the runner loop.
        # Flushed once in the finally block AFTER runner.run_async has
        # finished, so the mid-runner session-state write that would
        # otherwise trip DatabaseSessionService's OCC check on ADK >= 1.27
        # never happens. See issue #1754 (same shape as #1732, different
        # writer that PR #1735's consumer-side fix can't reach).
        pending_lro_id_remap: Dict[str, str] = {}
        logger.debug(f"[BG_EXEC] _run_adk_in_background called for thread={input.thread_id}")
        logger.debug(f"[BG_EXEC]   tool_results={len(tool_results) if tool_results else 0}, message_batch={len(message_batch) if message_batch else 0}")
        try:
            # Agent is already prepared with tools and SystemMessage instructions (if any)
            # from _start_background_execution, so no additional agent copying needed here

            # Create runner
            runner = self._create_runner(
                adk_agent=adk_agent,
                user_id=user_id,
                app_name=app_name
            )

            # Create RunConfig
            run_config = self._run_config_factory(input)

            # Prepare state with context included
            # Context from RunAgentInput is stored under _ag_ui_context key,
            # making it accessible via tool_context.state['_ag_ui_context']
            state_with_context = dict(input.state) if input.state else {}
            # Strip backend-managed keys so stale frontend state cannot
            # overwrite internal metadata (e.g. lro_tool_call_id_remap).
            # See: https://github.com/ag-ui-protocol/ag-ui/issues/1168
            for key in _INTERNAL_STATE_KEYS:
                state_with_context.pop(key, None)

            # Split `temp:`-prefixed keys from the persisted state. Every stock
            # ADK session service strips `temp:` keys before writing, so if we
            # passed them through the normal persistence path they would not
            # reach `tool_context.state` at tool-invocation time. The wrapper
            # registered on the session service (RequestStateSessionService)
            # re-injects them when the Runner fetches the session.
            # See: https://github.com/ag-ui-protocol/ag-ui/issues/1571
            temp_state: Dict[str, Any] = {}
            persistent_state: Dict[str, Any] = {}
            for k, v in state_with_context.items():
                if isinstance(k, str) and k.startswith(_ADKState.TEMP_PREFIX):
                    temp_state[k] = v
                else:
                    persistent_state[k] = v
            if input.context:
                persistent_state[CONTEXT_STATE_KEY] = [
                    {"description": ctx.description, "value": ctx.value}
                    for ctx in input.context
                ]

            # Ensure session exists and get backend session_id
            session, backend_session_id = await self._ensure_session_exists(
                app_name, user_id, input.thread_id, persistent_state
            )

            # Register any `temp:` state so it gets merged into the session
            # that ADK's Runner fetches for this invocation. Cleared in the
            # finally-block below regardless of success / failure.
            self._request_state_service.set_pending_temp_state(
                app_name=app_name,
                user_id=user_id,
                session_id=backend_session_id,
                temp_state=temp_state,
            )

            # this will always update the backend states with the frontend states
            # Recipe Demo Example: if there is a state "salt" in the ingredients state and in frontend user remove this salt state using UI from the ingredients list then our backend should also update these state changes as well to sync both the states
            await self._session_manager.update_session_state(backend_session_id, app_name, user_id, persistent_state)

            # Refresh session to get updated last_update_time after state update
            # This prevents "stale session" errors when using DatabaseSessionService
            # See: https://github.com/ag-ui-protocol/ag-ui/issues/957
            refreshed_session = await self._session_manager.get_session(backend_session_id, app_name, user_id)
            if refreshed_session:
                session = refreshed_session
            else:
                logger.warning(
                    f"Failed to refresh session {backend_session_id} after state update. "
                    "Continuing with potentially stale session."
                )

            # Read invocation_id stored during a previous LRO pause.
            # Used to tag FunctionResponse events and passed to run_async
            # for composite agents (SequentialAgent, LoopAgent).
            stored_invocation_id: Optional[str] = None
            try:
                current_state = await self._session_manager.get_session_state(
                    backend_session_id, app_name, user_id
                )
                if current_state:
                    stored_invocation_id = current_state.get(INVOCATION_ID_STATE_KEY)
                    if stored_invocation_id:
                        logger.debug(
                            f"Retrieved stored invocation_id for resumption: {stored_invocation_id}"
                        )
            except Exception as e:
                logger.warning(f"Failed to retrieve stored invocation_id: {e}")

            # Convert messages
            unseen_messages = message_batch if message_batch is not None else await self._get_unseen_messages(input)

            active_tool_results: Optional[List[Dict]] = tool_results
            if active_tool_results is None and await self._is_tool_result_submission(input, unseen_messages):
                active_tool_results = await self._extract_tool_results(input, unseen_messages)

            if active_tool_results:
                tool_messages = [result["message"] for result in active_tool_results]
                message_ids = self._collect_message_ids(tool_messages)
                if message_ids:
                    self._session_manager.mark_messages_processed(app_name, input.thread_id, message_ids)
            elif unseen_messages:
                message_ids = self._collect_message_ids(unseen_messages)
                if message_ids:
                    self._session_manager.mark_messages_processed(app_name, input.thread_id, message_ids)

            # Convert user messages first (if any)
            # Note: We pass unseen_messages which is already set from message_batch or _get_unseen_messages
            # The original code had a bug: `if message_batch else None` would skip conversion when
            # message_batch was None but unseen_messages contained valid user messages
            user_message = await self._convert_latest_message(input, unseen_messages)

            # Track invocation_id for tool-only submissions (when new_message will be None)
            tool_only_invocation_id: Optional[str] = None

            # Load LRO ID remapping for tool-result submissions.
            # When SSE streaming is active, the partial and final events may
            # carry different function-call IDs for the same logical call.
            # The remap converts client-facing IDs back to the IDs ADK persisted.
            lro_id_remap: Dict[str, str] = {}
            if active_tool_results:
                lro_id_remap = await self._get_lro_id_remap(
                    backend_session_id, app_name, user_id
                )

            # if there is a tool response submission by the user, add FunctionResponse to session first
            if active_tool_results and user_message:
                # We have BOTH tool results AND a user message
                # Add FunctionResponse as a separate event to the session, then send user message
                function_response_parts = self._build_function_response_parts(
                    active_tool_results, lro_id_remap
                )

                # Add FunctionResponse as separate event to session
                # (session was already obtained from _ensure_session_exists above)
                function_response_content = types.Content(parts=function_response_parts, role='user')
                # Tag FunctionResponse with the original invocation_id so ADK can
                # match it to the function_call in session events
                resume_invocation_id = stored_invocation_id or input.run_id
                function_response_event = Event(
                    timestamp=time.time(),
                    author='user',
                    content=function_response_content,
                    invocation_id=resume_invocation_id,
                )
                logger.debug(f"Creating FunctionResponse event with invocation_id={resume_invocation_id}")

                await self._session_manager._session_service.append_event(session, function_response_event)
                self._session_manager.invalidate_session(
                    backend_session_id, app_name, user_id
                )

                # Mark user messages from message_batch as processed
                if message_batch:
                    user_message_ids = self._collect_message_ids(message_batch)
                    if user_message_ids:
                        self._session_manager.mark_messages_processed(app_name, input.thread_id, user_message_ids)

                # Use ONLY the user message as new_message
                new_message = user_message

            elif active_tool_results:
                # Tool results WITHOUT user message - send FunctionResponse alone
                function_response_parts = self._build_function_response_parts(
                    active_tool_results, lro_id_remap
                )

                function_response_content = types.Content(parts=function_response_parts, role='user')

                # ag-ui#1839: HITL confirmation responses must be the LAST
                # user event in the session so ADK's
                # _RequestConfirmationLlmRequestProcessor — which reverse-scans
                # for the last user event and returns on the first one lacking
                # function_responses — can re-execute the original tool. The
                # pre-append + empty-text-placeholder workaround below makes the
                # placeholder the trailing user event, which blinds that
                # processor (the FunctionResponse it needs sits one event
                # earlier). ``adk_request_confirmation`` is a long-running tool
                # that PAUSES (not ends) the invocation, so routing it through
                # the direct ``new_message`` path does NOT hit the
                # ``end_of_agent`` early-return in _resolve_invocation_id's
                # resume path that motivated the #1534 workaround for
                # turn-ending client/frontend tools.
                is_confirmation_resume = any(
                    part.function_response is not None
                    and part.function_response.name == 'adk_request_confirmation'
                    for part in function_response_parts
                )

                # ag-ui#1669: the #1534 pre-append workaround is correct for
                # LlmAgent roots (and composite orchestrators built from
                # LlmAgent), but breaks ADK 2.0 ``Workflow`` roots. Workflows
                # rehydrate from ``new_message.parts`` only — the empty-text
                # placeholder we substitute below contains no
                # ``function_response``, so ``Workflow._run_impl`` cannot
                # resume from the interrupt and falls back to a fresh START.
                # Skip the workaround for Workflow roots and pass the
                # FunctionResponse directly in ``new_message`` (the ADK
                # 1.x-style path), which Workflow consumes correctly.
                if (
                    _ADK_OVERRIDES_INVOCATION_ID
                    and self._is_adk_resumable()
                    and not self._root_agent_is_workflow()
                    and not is_confirmation_resume
                ):
                    # ADK with _resolve_invocation_id (~1.28+) routing, non-Workflow root:
                    #
                    # When new_message contains a FunctionResponse, Runner._resolve_invocation_id()
                    # looks up the matching FunctionCall event in session history and forces the
                    # invocation_id to that event's invocation_id, sending the run down the
                    # _setup_context_for_resumed_invocation() path. For standalone LlmAgent roots
                    # (whose function_call events were emitted with end_of_agent=True), that path
                    # then early-returns in run_async() because populate_invocation_agent_states()
                    # sets end_of_agents[agent] = True — so the LLM is never invoked and the run
                    # emits zero content events (see ag-ui #1534).
                    #
                    # To avoid that, we pre-append the FunctionResponse as its own session event
                    # (mirroring the "tool_results + user_message" branch above) and pass a
                    # minimal placeholder as new_message that carries NO FunctionResponse. That
                    # makes _resolve_invocation_id short-circuit on the "no function_responses"
                    # branch and preserves whatever invocation_id handling run_kwargs already
                    # encodes (new-invocation path for standalone LlmAgent; resume path with
                    # stored_invocation_id for composite orchestrators).
                    #
                    # Workflow roots are explicitly excluded from this branch (see #1669
                    # comment above) — they take the else branch and receive the
                    # FunctionResponse directly in new_message.
                    first_tool_call_id = active_tool_results[0]['message'].tool_call_id
                    first_tool_call_id = lro_id_remap.get(first_tool_call_id, first_tool_call_id)
                    fc_event_invocation_id = self._find_function_call_invocation_id(
                        session, first_tool_call_id
                    )
                    # Prefer the matching FunctionCall event's invocation_id so ADK's own
                    # persistence/lookup contract stays consistent; fall back through
                    # stored_invocation_id and input.run_id so DatabaseSessionService still
                    # receives a non-null value (GitHub #957).
                    resume_invocation_id = (
                        fc_event_invocation_id or stored_invocation_id or input.run_id
                    )
                    function_response_event = Event(
                        timestamp=time.time(),
                        author='user',
                        content=function_response_content,
                        invocation_id=resume_invocation_id,
                    )
                    logger.debug(
                        "Pre-appending FunctionResponse for _resolve_invocation_id-capable ADK "
                        f"tool-only submission with invocation_id={resume_invocation_id}"
                    )
                    await self._session_manager._session_service.append_event(
                        session, function_response_event
                    )
                    self._session_manager.invalidate_session(
                        backend_session_id, app_name, user_id
                    )

                    # Placeholder trigger: a single empty text part. _append_new_message_to_session
                    # requires at least one part, and _get_function_responses_from_content returns
                    # [] for a text-only Content — which is exactly what we need.
                    new_message = types.Content(
                        role='user',
                        parts=[types.Part(text='')],
                    )
                    # Don't force a caller-supplied invocation_id from here. Composite-agent
                    # resumption still gets stored_invocation_id via the run_kwargs logic below;
                    # standalone LlmAgents correctly take the new-invocation path.
                    tool_only_invocation_id = None
                else:
                    # Direct-new_message path. Used in three cases:
                    #
                    # 1. ADK without _resolve_invocation_id (<1.28): older ADK
                    #    honors the caller-supplied invocation_id and treats
                    #    every tool submission as a fresh invocation, so the
                    #    LLM is invoked on the updated history.
                    # 2. Non-resumable apps (no ResumabilityConfig): same as
                    #    above; we're not in the resume path.
                    # 3. ADK 2.0 Workflow roots (ag-ui#1669): Workflow rehydrates
                    #    from new_message.parts exclusively, so the
                    #    FunctionResponse MUST land in new_message — otherwise
                    #    Workflow._extract_resume_inputs returns None and the
                    #    workflow restarts from START.
                    #
                    # In all three cases we pass the FunctionResponse as
                    # new_message with the AG-UI run_id as the invocation_id.
                    # This preserves the #1074 fix (no duplicate
                    # FunctionResponse events) by avoiding the pre-append.
                    new_message = function_response_content
                    tool_only_invocation_id = input.run_id
            else:
                # No tool results, just use the user message
                # If user_message is None (e.g., unseen_messages was empty because all were
                # already processed), fall back to extracting the latest user message from input.messages
                if user_message is None and input.messages:
                    user_message = await self._convert_latest_message(input, input.messages)
                new_message = user_message

            # Create a single shared set for tracking tool call IDs emitted by ClientProxyTool.
            # All ClientProxyToolsets in this run reference this set so the EventTranslator
            # sees IDs added by any proxy tool during execution (the set is mutated in-place).
            client_emitted_ids: set[str] = set()
            for toolset in client_proxy_toolsets:
                toolset._emitted_tool_call_ids = client_emitted_ids

            # Share the per-execution HITL tool-call set with proxy toolsets so
            # ClientProxyTool can register IDs synchronously before its
            # TOOL_CALL_START is enqueued. See issue #1652.
            for toolset in client_proxy_toolsets:
                toolset._long_running_tool_ids = long_running_tool_ids

            # Collect client-side tool names from proxy toolsets
            client_tool_names: set[str] = set()
            for toolset in client_proxy_toolsets:
                for tool in toolset.ag_ui_tools:
                    client_tool_names.add(tool.name)

            # Create event translator with predictive state configuration
            output_schema_names = self._collect_output_schema_agent_names(adk_agent)
            event_translator = EventTranslator(
                predict_state=self._predict_state,
                client_emitted_tool_call_ids=client_emitted_ids,
                client_tool_names=client_tool_names,
                is_resumable=self._is_adk_resumable(),
                streaming_function_call_arguments=self._streaming_function_call_arguments,
                output_schema_agent_names=output_schema_names,
            )

            # Share the translator's emitted IDs set with proxy toolsets so
            # ClientProxyTool can skip emission when the translator already handled it.
            # Also share the translator's name→[partial IDs] ledger so the proxy can
            # suppress the cross-path twin when SSE streaming gives the partial event
            # and the proxy invocation different IDs (#1168) — matched by tool name.
            for toolset in client_proxy_toolsets:
                toolset._translator_emitted_tool_call_ids = event_translator.emitted_tool_call_ids
                toolset._translator_lro_emitted_ids_by_name = event_translator.lro_emitted_ids_by_name

            try:
                # Session was already obtained from _ensure_session_exists above
                # Check session events (ADK stores conversation in events)
                events = getattr(session, 'events', [])
                logger.info(f"[SESSION_DEBUG] Session has {len(events)} events")

                # If sending FunctionResponse, look for the original FunctionCall in session
                if active_tool_results:
                    # Session FunctionCall events store the ADK-persisted id, so
                    # apply the same client->ADK remap the resume path uses below
                    # before searching. Without it this check reports "NOT FOUND"
                    # (and the misleading "ADK will fail") on every SSE-remapped
                    # resume — including ones that actually succeed.
                    client_tool_call_id = active_tool_results[0]['message'].tool_call_id
                    tool_call_id = lro_id_remap.get(client_tool_call_id, client_tool_call_id)
                    logger.info(
                        f"[SESSION_DEBUG] Looking for FunctionCall with id={tool_call_id}"
                        + (
                            f" (remapped from client id {client_tool_call_id})"
                            if tool_call_id != client_tool_call_id
                            else ""
                        )
                    )

                    # Log all function calls in session for debugging
                    all_function_call_ids = []
                    found_call = False
                    for evt_idx, evt in enumerate(events):
                        evt_content = getattr(evt, 'content', None)
                        evt_author = getattr(evt, 'author', 'unknown')
                        evt_inv_id = getattr(evt, 'invocation_id', 'none')
                        if evt_content:
                            evt_parts = getattr(evt_content, 'parts', [])
                            for part in evt_parts:
                                if hasattr(part, 'function_call') and part.function_call:
                                    fc = part.function_call
                                    fc_id = getattr(fc, 'id', 'no_id')
                                    fc_name = getattr(fc, 'name', 'no_name')
                                    all_function_call_ids.append(f"{fc_name}:{fc_id}")
                                    if fc_id == tool_call_id:
                                        found_call = True
                                        logger.info(f"[SESSION_DEBUG] FOUND matching FunctionCall at event[{evt_idx}], author={evt_author}, invocation_id={evt_inv_id}")
                        if found_call:
                            break

                    logger.info(f"[SESSION_DEBUG] All FunctionCalls in session: {all_function_call_ids}")
                    if not found_call:
                        logger.warning(f"[SESSION_DEBUG] FunctionCall NOT FOUND for id={tool_call_id}! ADK will fail with 'No function call event found'")
            except Exception as e:
                logger.error(f"[SESSION_DEBUG] Error checking session events: {e}")

            # Run ADK agent
            is_long_running_tool = False
            lro_invocation_id: Optional[str] = None
            lro_draining_for_persistence = False
            run_kwargs = {
                "user_id": user_id,
                "session_id": backend_session_id,  # Use backend session_id, not thread_id
                "new_message": new_message,
                "run_config": run_config
            }

            # Conditionally pass invocation_id based on root agent type and scenario.
            # Composite agents (SequentialAgent, LoopAgent) — whether as root or
            # as sub-agents of an LlmAgent root — need it so ADK calls
            # populate_invocation_agent_states() to restore internal state.
            # For tool responses on ADK < 1.30, we pass tool_only_invocation_id
            # (input.run_id) so ADK uses the client's run_id instead of
            # auto-generating an e-xxx ID. On ADK 1.30+, the tool-only branch
            # above leaves tool_only_invocation_id unset because the runner
            # forcibly overrides caller-supplied invocation_ids when a
            # FunctionResponse is present — we work around that by pre-appending
            # the FunctionResponse and passing a text-only placeholder instead.
            if stored_invocation_id and self._is_adk_resumable() and self._root_agent_needs_invocation_id():
                run_kwargs["invocation_id"] = stored_invocation_id
                logger.debug(f"HITL resumption with invocation_id: {stored_invocation_id}")
            elif tool_only_invocation_id and self._is_adk_resumable():
                # Tool response case (ADK < 1.30): use client's run_id as invocation_id
                run_kwargs["invocation_id"] = tool_only_invocation_id
                logger.debug(f"Tool response with explicit invocation_id: {tool_only_invocation_id}")

            logger.debug(f"Calling runner.run_async with session_id={backend_session_id}, has_message={new_message is not None}")

            self._session_manager.disable_session_read_cache()
            async for adk_event in runner.run_async(**run_kwargs):
                event_invocation_id = getattr(adk_event, 'invocation_id', None)
                event_author = getattr(adk_event, 'author', 'unknown')
                event_partial = getattr(adk_event, 'partial', False)
                event_turn_complete = getattr(adk_event, 'turn_complete', None)

                # Log which agent is producing events
                content_preview = ""
                if adk_event.content and hasattr(adk_event.content, 'parts') and adk_event.content.parts:
                    for part in adk_event.content.parts:
                        if hasattr(part, 'text') and part.text:
                            content_preview = part.text[:100].replace('\n', ' ')
                            break
                        elif hasattr(part, 'function_call') and part.function_call:
                            content_preview = f"[FunctionCall: {part.function_call.name}]"
                            break
                logger.info(f"[ADK_EVENT] author={event_author}, partial={event_partial}, turn_complete={event_turn_complete}, content={content_preview[:80]}...")

                # LRO persistence fix: if we're draining events after LRO detection,
                # only translate text content and wait for non-partial event
                if lro_draining_for_persistence:
                    # Translate any text content so the frontend receives it
                    has_remaining_content = (
                        adk_event.content and
                        hasattr(adk_event.content, 'parts') and
                        adk_event.content.parts
                    )
                    if has_remaining_content:
                        async for ag_ui_event in event_translator.translate_text_only(
                            adk_event, input.thread_id, input.run_id
                        ):
                            await event_queue.put(ag_ui_event)
                            logger.debug(
                                f"Event queued (LRO drain): {type(ag_ui_event).__name__} "
                                f"(thread {input.thread_id})"
                            )
                    
                    # Check if we got a non-partial event (persistence complete)
                    if not event_partial:
                        # Capture LRO ID remapping: the final (persisted) event
                        # may carry different function-call IDs than the partial
                        # event we already emitted to the client. Buffer here
                        # and flush in finally; writing mid-runner would bump
                        # the session row's storage marker and trip OCC on
                        # ADK's next ``append_event`` (issue #1754).
                        lro_remap = self._extract_lro_id_remap(adk_event, event_translator)
                        if lro_remap:
                            pending_lro_id_remap.update(lro_remap)

                        logger.info(
                            f"Received non-partial event during LRO drain, persistence complete "
                            f"(thread={input.thread_id})"
                        )
                        # #1755: persist any buffered HITL pending_tool_calls
                        # IDs, then signal completion so the deferring queue
                        # flushes the deferred TCE(s) onto the underlying
                        # queue before the consumer exits.
                        await self._finalize_hitl_buffer(
                            event_queue, input.thread_id, app_name, user_id
                        )
                        await event_queue.put(None)
                        return
                    else:
                        # Still partial, keep draining
                        continue

                final_response = adk_event.is_final_response()
                has_content = adk_event.content and hasattr(adk_event.content, 'parts') and adk_event.content.parts

                # Check if this is a streaming chunk that needs regular processing
                is_streaming_chunk = (
                    getattr(adk_event, 'partial', False) or  # Explicitly marked as partial
                    (not getattr(adk_event, 'turn_complete', True)) or  # Live streaming not complete
                    (not final_response)  # Not marked as final by is_final_response()
                )

                # Prefer LRO routing when a long-running tool call is present
                has_lro_function_call = False
                try:
                    lro_ids = set(getattr(adk_event, 'long_running_tool_ids', []) or [])
                    # Mark every LRO id from the ADK event as HITL on the
                    # shared execution set. Synchronous mutation before any
                    # downstream `await event_queue.put(...)` of this event's
                    # TOOL_CALL_END, so the consumer's gate sees the id at
                    # dequeue time. See issue #1652.
                    if lro_ids:
                        long_running_tool_ids.update(lro_ids)
                    if lro_ids and adk_event.content and getattr(adk_event.content, 'parts', None):
                        for part in adk_event.content.parts:
                            func = getattr(part, 'function_call', None)
                            func_id = getattr(func, 'id', None) if func else None
                            if func_id and func_id in lro_ids:
                                has_lro_function_call = True
                                break
                except Exception:
                    # Be conservative: if detection fails, do not block streaming path
                    has_lro_function_call = False

                # Check if event has function responses (e.g., backend tool results)
                # This is needed for skip_summarization scenarios where there's no text
                # content but we still need to emit ToolCallResultEvent (GitHub #765)
                has_function_responses = (
                    hasattr(adk_event, 'get_function_responses') and
                    adk_event.get_function_responses()
                )

                # Process as streaming if it's a chunk OR if it has content OR has function responses,
                # but only when there is no LRO function call present (LRO takes precedence)
                # Note: We don't exclude based on finish_reason - final responses with content
                # (e.g., after backend tool completion) must still be translated.
                if (not has_lro_function_call) and (is_streaming_chunk or has_content or has_function_responses):
                    # Regular translation path
                    async for ag_ui_event in event_translator.translate(
                        adk_event,
                        input.thread_id,
                        input.run_id
                    ):

                        logger.debug(f"Emitting event to queue: {type(ag_ui_event).__name__} (thread {input.thread_id}, queue size before: {event_queue.qsize()})")
                        await event_queue.put(ag_ui_event)
                        logger.debug(f"Event queued: {type(ag_ui_event).__name__} (thread {input.thread_id}, queue size after: {event_queue.qsize()})")
                else:
                    # LongRunning Tool events are usually emitted in final response

                    # CRITICAL FIX (GitHub #906): Process text content BEFORE LRO tool calls
                    # In non-streaming mode, text and tool calls may arrive in the same event.
                    # We must emit TEXT_MESSAGE events before TOOL_CALL events.
                    if has_content:
                        async for ag_ui_event in event_translator.translate_text_only(
                            adk_event, input.thread_id, input.run_id
                        ):
                            await event_queue.put(ag_ui_event)
                            logger.debug(f"Event queued (LRO text): {type(ag_ui_event).__name__} (thread {input.thread_id})")

                    # Ensure any active streaming text message is closed BEFORE tool calls
                    async for end_event in event_translator.force_close_streaming_message():
                        await event_queue.put(end_event)
                        logger.debug(f"Event queued (forced close): {type(end_event).__name__} (thread {input.thread_id}, queue size after: {event_queue.qsize()})")

                    # Set flag based on LRO detection directly — the translator may
                    # skip client tools to avoid duplicate emission, but we still
                    # need to know an LRO pause happened for invocation_id management.
                    if has_lro_function_call:
                        is_long_running_tool = True
                        lro_invocation_id = event_invocation_id

                    async for ag_ui_event in event_translator.translate_lro_function_calls(
                        adk_event
                    ):
                        await event_queue.put(ag_ui_event)
                        if ag_ui_event.type == EventType.TOOL_CALL_END:
                            is_long_running_tool = True
                        logger.debug(f"Event queued: {type(ag_ui_event).__name__} (thread {input.thread_id}, queue size after: {event_queue.qsize()})")

                    # Capture LRO ID remapping from non-partial events.
                    # The final (persisted) event may carry different function-call
                    # IDs than the partial event we already emitted to the client.
                    # Buffer here and flush in finally; writing mid-runner would
                    # bump the session row's storage marker and trip OCC on ADK's
                    # next ``append_event`` (issue #1754).
                    if has_lro_function_call and not event_partial:
                        lro_remap = self._extract_lro_id_remap(adk_event, event_translator)
                        if lro_remap:
                            pending_lro_id_remap.update(lro_remap)

                    # Hard stop the execution if we find any long running tool
                    # AND the agent is NOT using ADK's native resumability.
                    # With ResumabilityConfig, ADK handles the pause/resume flow
                    # natively — we don't need to stop the loop early.
                    if is_long_running_tool and not self._is_adk_resumable():
                        import warnings
                        warnings.warn(
                            "Non-resumable HITL (fire-and-forget) is deprecated and will be removed "
                            "in a future version. Use ADKAgent.from_app() with "
                            "ResumabilityConfig(is_resumable=True) for human-in-the-loop workflows. "
                            "See USAGE.md for migration instructions.",
                            DeprecationWarning,
                            stacklevel=2,
                        )
                        # FIX for GitHub issue: LRO events not persisted with SSE streaming.
                        #
                        # With SSE streaming enabled (default), ADK yields events in two phases:
                        # 1. partial=True events (streaming chunks) - NOT persisted by ADK
                        # 2. partial=False event (final aggregated) - IS persisted by ADK
                        #
                        # ADK's persistence happens BEFORE yielding the non-partial event.
                        # Previously, we returned immediately after detecting the LRO tool,
                        # which abandoned the runner's async generator before the final
                        # non-partial event was consumed. This meant ADK never persisted
                        # the agent's response, causing lost session history.
                        #
                        # Fix: If the current event is partial, set a flag to drain the
                        # remaining events until we receive a non-partial event. The flag
                        # is checked at the START of each loop iteration.
                        current_partial = getattr(adk_event, 'partial', False)
                        if current_partial:
                            logger.info(
                                f"LRO detected with partial=True, will drain until persistence completes "
                                f"(thread={input.thread_id})"
                            )
                            # Set flag to continue draining - checked at loop start
                            lro_draining_for_persistence = True
                            continue  # Continue the OUTER loop to get more events
                        else:
                            # Already non-partial, ADK has already persisted
                            logger.info(
                                f"LRO detected with partial=False, persistence already complete "
                                f"(thread={input.thread_id})"
                            )
                            # #1755: persist any buffered HITL
                            # pending_tool_calls IDs, then signal
                            # completion so the deferring queue flushes
                            # deferred TCE(s) before the consumer exits.
                            await self._finalize_hitl_buffer(
                                event_queue,
                                input.thread_id,
                                app_name,
                                user_id,
                            )
                            await event_queue.put(None)
                            return

            # Force close any streaming messages
            async for ag_ui_event in event_translator.force_close_streaming_message():
                await event_queue.put(ag_ui_event)

            # Manage invocation_id lifecycle for resumable agents.
            # Composite agents: store after LRO pause so the next resume can
            # pass it to run_async for populate_invocation_agent_states().
            # All agents: clear stale IDs after normal completion.
            if self._is_adk_resumable():
                if is_long_running_tool and lro_invocation_id and self._root_agent_needs_invocation_id():
                    try:
                        await self._session_manager.update_session_state(
                            backend_session_id, app_name, user_id,
                            {INVOCATION_ID_STATE_KEY: lro_invocation_id}
                        )
                        logger.debug(f"Stored invocation_id for HITL resumption: {lro_invocation_id}")
                    except Exception as e:
                        logger.warning(f"Failed to store invocation_id: {e}")
                elif stored_invocation_id and not is_long_running_tool:
                    try:
                        await self._session_manager.update_session_state(
                            backend_session_id, app_name, user_id,
                            {INVOCATION_ID_STATE_KEY: None}
                        )
                        logger.debug("Cleared stale invocation_id after completed run")
                    except Exception as e:
                        logger.warning(f"Failed to clear invocation_id: {e}")

            # moving states snapshot events after the text event clousure to avoid this error https://github.com/Contextable/ag-ui/issues/28
            final_state = await self._session_manager.get_session_state(backend_session_id, app_name, user_id)

            # `temp:` keys are ephemeral invocation state (see issue #1571) —
            # they're visible to tools during the run but must not leak into
            # the client-facing STATE_SNAPSHOT.
            if final_state:
                final_state = {
                    k: v for k, v in final_state.items()
                    if not (isinstance(k, str) and k.startswith(_ADKState.TEMP_PREFIX))
                }

            # Merge accumulated predictive state from all ClientProxyToolset instances
            # This ensures values set during HITL tool calls survive the final STATE_SNAPSHOT
            accumulated_predict_state = {}
            for toolset in client_proxy_toolsets:
                accumulated_predict_state.update(toolset.get_accumulated_predict_state())

            if accumulated_predict_state:
                logger.debug(f"Merging accumulated predict_state into final state: {list(accumulated_predict_state.keys())}")
                # Merge: accumulated predict_state values take priority over session state
                # (the session state may use different keys like 'approved_plan' vs 'plan')
                if final_state:
                    merged_state = {**final_state, **accumulated_predict_state}
                else:
                    merged_state = accumulated_predict_state
                ag_ui_event = event_translator._create_state_snapshot_event(merged_state)
                await event_queue.put(ag_ui_event)
            elif final_state:
                ag_ui_event = event_translator._create_state_snapshot_event(final_state)
                await event_queue.put(ag_ui_event)

            # Emit MESSAGES_SNAPSHOT if configured
            if self._emit_messages_snapshot:
                try:
                    # Refresh session to get latest events
                    session = await self._session_manager.get_session(backend_session_id, app_name, user_id)
                    if session and hasattr(session, 'events') and session.events:
                        messages = adk_events_to_messages(session.events)
                        if messages:
                            messages_snapshot_event = MessagesSnapshotEvent(
                                type=EventType.MESSAGES_SNAPSHOT,
                                messages=messages
                            )
                            await event_queue.put(messages_snapshot_event)
                            logger.debug(f"Emitted MESSAGES_SNAPSHOT with {len(messages)} messages for thread {input.thread_id}")
                except Exception as snapshot_error:
                    logger.warning(f"Failed to emit MESSAGES_SNAPSHOT for thread {input.thread_id}: {snapshot_error}")

            # Emit any deferred confirm_changes events, followed by a state
            # snapshot.  The extra StateSnapshotEvent creates a processing gap
            # between the confirm_changes TOOL_CALL_END and RUN_FINISHED, giving
            # the CopilotKit frontend time to render the HITL dialog in
            # "executing" status before the run completes.  (This mirrors what
            # LangGraph does — it also emits StateSnapshot + MessagesSnapshot
            # between the last TOOL_CALL_END and RUN_FINISHED.)
            deferred_events = event_translator.get_and_clear_deferred_confirm_events()
            for deferred_event in deferred_events:
                logger.debug(f"Emitting deferred confirm_changes event: {type(deferred_event).__name__}")
                await event_queue.put(deferred_event)

            if deferred_events:
                # Re-emit state snapshot after confirm_changes events for timing
                if final_state or accumulated_predict_state:
                    state_for_snapshot = {**(final_state or {}), **accumulated_predict_state}
                    await event_queue.put(
                        event_translator._create_state_snapshot_event(state_for_snapshot)
                    )
                    logger.debug("Emitted post-confirm StateSnapshotEvent for timing separation")

            # Persist HITL pending_tool_calls IDs that the deferring queue
            # has buffered, then signal completion. The put(None) below
            # triggers an implicit flush via _HitlDeferringQueue.put so
            # the consumer sees the deferred TCEs before the stream ends.
            # See issue #1755.
            await self._finalize_hitl_buffer(
                event_queue, input.thread_id, app_name, user_id
            )
            logger.debug(f"Background task sending completion signal for thread {input.thread_id}")
            await event_queue.put(None)
            logger.debug(f"Background task completion signal sent for thread {input.thread_id}")
            
        except Exception as e:
            logger.error(f"Background execution error: {e}", exc_info=True)
            # Put error in queue
            await event_queue.put(
                RunErrorEvent(
                    type=EventType.RUN_ERROR,
                    message=str(e),
                    code="BACKGROUND_EXECUTION_ERROR"
                )
            )
            await event_queue.put(None)
        finally:
            # Background task cleanup completed
            # Ensure the ADK runner releases any resources (e.g. toolsets)
            if runner is not None:
                close_method = getattr(runner, "close", None)
                if close_method is not None:
                    try:
                        close_result = close_method()
                        if inspect.isawaitable(close_result):
                            await close_result
                    except Exception as close_error:
                        logger.warning(
                            "Error while closing ADK runner for thread %s: %s",
                            input.thread_id,
                            close_error,
                        )

            # Flush any LRO ID remap captured during the runner loop. This
            # runs after the runner has been closed, so the
            # ``update_session_state`` write can't trip OCC against ADK's
            # in-memory ``invocation_context.session``. See issue #1754.
            if pending_lro_id_remap and backend_session_id is not None:
                try:
                    await self._store_lro_id_remap(
                        pending_lro_id_remap,
                        backend_session_id,
                        app_name,
                        user_id,
                    )
                except Exception as flush_error:
                    logger.warning(
                        "Failed to flush LRO ID remap on runner exit "
                        "(thread=%s): %s",
                        input.thread_id,
                        flush_error,
                    )

            # Drop any pending per-invocation `temp:` state so a later run on
            # the same session does not inherit stale values (e.g. a rotated
            # bearer token).
            if backend_session_id is not None:
                self._request_state_service.clear_pending_temp_state(
                    app_name=app_name,
                    user_id=user_id,
                    session_id=backend_session_id,
                )
    
    async def _cleanup_stale_executions(self):
        """Clean up stale executions."""
        stale_keys: List[Tuple[str, str]] = []

        for exec_key, execution in self._active_executions.items():
            if execution.is_stale(self._execution_timeout):
                stale_keys.append(exec_key)

        for exec_key in stale_keys:
            execution = self._active_executions.pop(exec_key)
            await execution.cancel()
            thread_id, _uid = exec_key
            logger.info(f"Cleaned up stale execution for thread {thread_id}")

    async def close(self):
        """Clean up resources including active executions."""
        # Cancel all active executions
        async with self._execution_lock:
            for execution in self._active_executions.values():
                await execution.cancel()
            self._active_executions.clear()

        # Clear session lookup cache and related tracking sets
        self._session_lookup_cache.clear()
        self._cache_checked_keys.clear()
        self._sessions_verified_locally.clear()

        # Stop session manager cleanup task
        await self._session_manager.stop_cleanup_task()
