# src/endpoint.py

"""FastAPI endpoint for ADK middleware."""

import logging
import struct
import uuid
import warnings
from collections.abc import Sequence
from typing import Any, Awaitable, Callable, Coroutine, List, Mapping, Optional

from ag_ui.core import (
    AssistantMessage,
    EventType,
    Message,
    RunAgentInput,
    RunErrorEvent,
    ToolMessage,
)
from ag_ui.encoder import EventEncoder, AGUI_MEDIA_TYPE
from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

# Use ``sse-starlette`` for the SSE response so we can return a fully-formed
# ``EventSourceResponse`` (with built-in 15 s keep-alive pings and the
# ``Cache-Control: no-cache`` / ``X-Accel-Buffering: no`` headers) from inside
# a path operation that conditionally returns a different response type for
# non-SSE Accept values. ``fastapi.sse.EventSourceResponse`` (added in FastAPI
# 0.135) is intentionally a marker class -- its SSE encoding only applies when
# used via ``response_class=EventSourceResponse`` on a generator path operation,
# which is incompatible with branching on the request's ``Accept`` header.
# Pulling in ``sse-starlette`` keeps the ``fastapi`` floor at the long-standing
# ``>=0.115.2`` and avoids the more aggressive bump originally proposed.
from sse_starlette.sse import EventSourceResponse, ServerSentEvent

from .adk_agent import ADKAgent
from .event_translator import adk_events_to_messages

logger = logging.getLogger(__name__)

AgentResolver = Callable[[Request, RunAgentInput], Awaitable[ADKAgent | None]]


def resolve_agent_from_message_history(
    messages: Sequence[Message],
    agent_registry: Mapping[str, ADKAgent],
) -> ADKAgent | None:
    """Resolve a tool-result resumption to its originating agent.

    This helper treats ``AssistantMessage.name`` as an explicit agent registry
    key. It scopes routing to the latest ``ToolMessage``, matches its
    ``ToolMessage.tool_call_id`` value to prior
    ``AssistantMessage.tool_calls[].id`` values in the same message history,
    and returns the corresponding registry agent.

    ``None`` is returned when the latest message is not a tool result, the
    matching assistant message is absent, the assistant message has no
    registry key in ``name``, or the key is unknown. This keeps the helper
    conservative so the caller can safely fall back to its normal routing
    policy.
    """
    if not messages or not isinstance(messages[-1], ToolMessage):
        return None

    tool_message = messages[-1]
    for message in reversed(messages[:-1]):
        if not isinstance(message, AssistantMessage):
            continue

        tool_call_ids = {tool_call.id for tool_call in message.tool_calls or []}
        if tool_message.tool_call_id not in tool_call_ids:
            continue

        if not message.name:
            return None
        return agent_registry.get(message.name)

    return None


def _build_run_error(message: str, code: str) -> RunErrorEvent:
    """Construct a ``RunErrorEvent`` with the given message and code.

    Centralized so the SSE and legacy streaming paths build identical error
    events and so tests can patch ``ag_ui_adk.endpoint.RunErrorEvent`` to
    drive the error-encoding fallback path directly.
    """
    return RunErrorEvent(type=EventType.RUN_ERROR, message=message, code=code)


async def _merge_extractor_state(
    input_data: RunAgentInput,
    request: Request,
    extract_state_fn: Optional[
        Callable[[Request, RunAgentInput], Coroutine[dict[str, Any], Any, Any]]
    ],
) -> RunAgentInput:
    """Run the request extractor and merge returned state over input state."""
    if not extract_state_fn:
        return input_data

    extracted_state_dict = await extract_state_fn(request, input_data)
    if not extracted_state_dict:
        return input_data

    existing_state = input_data.state if isinstance(input_data.state, dict) else {}
    merged_state = {**existing_state, **extracted_state_dict}
    return input_data.model_copy(update={"state": merged_state})


async def _resolve_agent(
    default_agent: ADKAgent,
    request: Request,
    input_data: RunAgentInput,
    agent_resolver: Optional[AgentResolver],
) -> ADKAgent:
    """Resolve the request-scoped agent, falling back to the default agent."""
    if agent_resolver is None:
        return default_agent

    resolved_agent = await agent_resolver(request, input_data)
    if resolved_agent is None:
        return default_agent
    if not isinstance(resolved_agent, ADKAgent):
        raise TypeError("agent_resolver must return an ADKAgent instance or None")
    return resolved_agent


def _sse_event(raw_data: str, *, event: Optional[str] = None) -> ServerSentEvent:
    """Build a ``ServerSentEvent`` carrying ``raw_data`` byte-for-byte.

    ``sse_starlette``'s ``ServerSentEvent`` formats ``data=<str>`` as
    ``data: <str>\\n\\n`` without JSON-re-encoding, so passing the already
    JSON-serialized event through here preserves the pre-PR wire format
    exactly (``data: {json}\\n\\n``). The ``sep="\\n"`` keeps line endings as
    ``\\n`` rather than ``\\r\\n`` to match the byte-level format the existing
    test suite (and the prior ``EventEncoder`` output) uses.
    """
    if event is None:
        return ServerSentEvent(data=raw_data, sep="\n")
    return ServerSentEvent(data=raw_data, event=event, sep="\n")


async def _sse_stream(agent: "ADKAgent", input_data: RunAgentInput):
    """Yield ``ServerSentEvent``s for an SSE consumer.

    Wire format is byte-identical to the pre-PR ``EventEncoder`` output: each
    event becomes ``data: {json}\\n\\n``. The encoding error branch produces a
    ``RunErrorEvent`` (``code="ENCODING_ERROR"``) which is itself JSON-encoded
    and yielded; a final fallback frames a hard-coded JSON error so the client
    always sees a structured stream tail.
    """
    try:
        async for event in agent.run(input_data):
            try:
                encoded = event.model_dump_json(by_alias=True, exclude_none=True)
                logger.debug(f"HTTP Response: {encoded}")
                yield _sse_event(encoded)
            except Exception as encoding_error:
                logger.error(
                    f"❌ Event encoding error: {encoding_error}", exc_info=True
                )
                error_event = _build_run_error(
                    message=f"Event encoding failed: {str(encoding_error)}",
                    code="ENCODING_ERROR",
                )
                try:
                    yield _sse_event(
                        error_event.model_dump_json(by_alias=True, exclude_none=True)
                    )
                except Exception:
                    logger.error(
                        "Failed to encode error event, yielding basic SSE error"
                    )
                    yield _sse_event(
                        '{"error": "Event encoding failed"}', event="error"
                    )
                return
    except Exception as agent_error:
        logger.error(f"❌ ADKAgent error: {agent_error}", exc_info=True)
        try:
            error_event = _build_run_error(
                message=f"Agent execution failed: {str(agent_error)}",
                code="AGENT_ERROR",
            )
            yield _sse_event(
                error_event.model_dump_json(by_alias=True, exclude_none=True)
            )
        except Exception:
            logger.error("Failed to encode agent error event, yielding basic SSE error")
            yield _sse_event('{"error": "Agent execution failed"}', event="error")


async def _legacy_stream(
    agent: "ADKAgent", input_data: RunAgentInput, encoder: EventEncoder
):
    """Yield encoded events for a non-SSE ``StreamingResponse`` consumer.

    Used for the AG-UI **binary protocol** (``application/vnd.ag-ui.event+proto``)
    negotiated via the ``Accept`` header. Each event is protobuf-encoded by
    ``EventEncoder`` and framed with a **4-byte big-endian length prefix**
    (``struct.pack(">I", len(data)) + data``) — the framing the client's
    ``parseProtoStream`` expects (``getUint32(0, /*big-endian*/ false)``). The
    ``EventEncoder.encode`` output is the bare protobuf message (matching the TS
    ``@ag-ui/proto`` ``encode``), so the length prefix lives here in the
    transport layer.

    For any other negotiated content type the encoder falls back to SSE strings,
    which are yielded unframed.
    """
    is_proto = encoder.get_content_type() == AGUI_MEDIA_TYPE

    def _frame(encoded):
        # Length-prefix binary frames; pass SSE strings through untouched.
        if is_proto and isinstance(encoded, (bytes, bytearray)):
            return struct.pack(">I", len(encoded)) + bytes(encoded)
        return encoded

    try:
        async for event in agent.run(input_data):
            try:
                encoded = encoder.encode(event)
                yield _frame(encoded)
            except Exception as encoding_error:
                logger.error(
                    f"❌ Event encoding error: {encoding_error}", exc_info=True
                )
                error_event = _build_run_error(
                    message=f"Event encoding failed: {str(encoding_error)}",
                    code="ENCODING_ERROR",
                )
                try:
                    yield _frame(encoder.encode(error_event))
                except Exception:
                    logger.error("Failed to encode error event")
                    if not is_proto:
                        yield 'data: {"error": "Event encoding failed"}\n\n'
                return
    except Exception as agent_error:
        logger.error(f"❌ ADKAgent error: {agent_error}", exc_info=True)
        try:
            error_event = _build_run_error(
                message=f"Agent execution failed: {str(agent_error)}",
                code="AGENT_ERROR",
            )
            yield _frame(encoder.encode(error_event))
        except Exception:
            logger.error("Failed to encode agent error event")
            if not is_proto:
                yield 'data: {"error": "Agent execution failed"}\n\n'


class AgentStateRequest(BaseModel):
    """Request body for /agents/state endpoint.

    EXPERIMENTAL: This endpoint is subject to change in future versions.

    ``appName`` and ``userId`` are **deprecated** as primary identity inputs
    (ag-ui-protocol/ag-ui#1646). When ``extract_state_from_request`` is
    configured on the endpoint, identity is resolved from the extractor
    pipeline (matching the chat endpoint) and these body fields are ignored
    — a ``DeprecationWarning`` is emitted to surface the mismatch. They
    remain as a fallback only when no static value and no extractor produce
    an identity.
    """
    threadId: str
    appName: Optional[str] = None  # Deprecated fallback — see class docstring
    userId: Optional[str] = None   # Deprecated fallback — see class docstring
    name: Optional[str] = None
    properties: Optional[Any] = None


class AgentStateResponse(BaseModel):
    """Response body for /agents/state endpoint."""
    threadId: str
    threadExists: bool
    state: dict
    messages: list


def _header_to_key(header_name: str) -> str:
    """Convert header name to state key.

    Strips 'x-' prefix and converts hyphens to underscores.
    Example: 'x-user-id' -> 'user_id', 'x-tenant-id' -> 'tenant_id'
    """
    key = header_name.lower()
    if key.startswith("x-"):
        key = key[2:]
    return key.replace("-", "_")

def make_extract_headers(headers_to_extract: list[str]) -> Callable[[Request, RunAgentInput], Coroutine[dict[str,Any], Any, Any]]:
    """
    Replicate original extract_headers functionality via custom extractor
    Create an async function to extract specified headers into state.

    Args:
        headers_to_extract: List of HTTP header names to extract into state.
    Returns:
        Async function that extracts headers into state.
    """
    async def extract_headers(request: Request, input_data: RunAgentInput) -> dict[str, Any]:
        # Extract headers into state.headers if list provided
        if headers_to_extract:
            headers_dict = {}
            for header_name in headers_to_extract:
                value = request.headers.get(header_name)
                if value is not None:
                    state_key = _header_to_key(header_name)
                    headers_dict[state_key] = value

            if headers_dict:
                existing_state = input_data.state if isinstance(input_data.state, dict) else {}
                existing_headers = existing_state.get("headers", {}) if isinstance(existing_state.get("headers"), dict) else {}
                # Client headers take precedence over extracted headers
                merged_headers = {**headers_dict, **existing_headers}
                merged_state = {**existing_state, "headers": merged_headers}
                return merged_state

        return {}

    return extract_headers

def add_adk_fastapi_endpoint(
    app: FastAPI | APIRouter,
    agent: ADKAgent,
    path: str = "/",
    extract_headers: Optional[List[str]] = None,
    extract_state_from_request: Optional[Callable[[Request, RunAgentInput], Coroutine[dict[str,Any], Any, Any]]] = None,
    agent_resolver: Optional[AgentResolver] = None,
):
    """Add ADK middleware endpoint to FastAPI app.

    Args:
        app: FastAPI application instance
        agent: Configured ADKAgent instance
        path: API endpoint path
        extract_headers: Optional list of HTTP header names to extract into state. Cannot be used with extract_state_from_request.
        extract_state_from_request: Optional async function to extract values mapped from the request into state.
            State values returned from this function will override any existing state values. 
            The RunAgentInput is provided so conflicts can be identified and resolved appropriately.
            Cannot be used with extract_headers.
        agent_resolver: Optional async function that can select an ``ADKAgent``
            for the request after state extraction. Returning ``None`` uses
            the default agent.

    Note:
        This function also adds an experimental POST /agents/state endpoint for
        consumption by front-end frameworks that need to retrieve thread state and
        message history. This endpoint is subject to change in future versions.
        When ``agent_resolver`` is configured, routing is applied to the run
        endpoint, ``/capabilities``, and ``/agents/state`` after request state
        extraction. Routed agents should share a session backend when continuity
        across route switches is expected. During HITL or long-running tool
        resumption, the resolver is responsible for returning the same agent
        that originated the open tool call.

        A resolver can pin tool-result resumptions to the agent that emitted
        the matching tool call by treating ``AssistantMessage.name`` as the
        agent registry key. For this convention to work, the inbound message
        history must preserve the assistant message that created the tool call,
        with ``name`` set to that registry key. Histories built only from live
        reducer events may not include that key unless the client preserves it.

        .. code-block:: python

            from ag_ui_adk import resolve_agent_from_message_history

            AGENT_REGISTRY = {
                "supervisor": supervisor_agent,
                "subagent1": subagent1_agent,
            }

            async def agent_resolver(request, input_data):
                history_agent = resolve_agent_from_message_history(
                    input_data.messages,
                    AGENT_REGISTRY,
                )
                if history_agent is not None:
                    return history_agent

                state = input_data.state if isinstance(input_data.state, dict) else {}
                return AGENT_REGISTRY.get(state.get("to_agent"))
    """
    extract_state_fn = extract_state_from_request
    if extract_headers is not None:
        if extract_state_from_request is None:
            warnings.warn(
                "The 'extract_headers' parameter is deprecated and will be removed in future versions. "
                "Please use 'extract_state_from_request' instead. Example: extract_state_from_request = make_extract_headers(extract_headers)",
                DeprecationWarning
            )
            # Create extractor from headers list
            extract_state_fn = make_extract_headers(extract_headers)
        else:
            raise ValueError("Cannot use both 'extract_headers' and 'extract_state_from_request' parameters together.")

    default_agent = agent

    @app.post(path)
    async def adk_endpoint(input_data: RunAgentInput, request: Request):
        """ADK middleware endpoint.

        Negotiates the response framing on the request's ``Accept`` header via
        ``EventEncoder.get_content_type()``:

        * ``text/event-stream`` (the default for browsers / ``EventSource``
          consumers) is served via ``EventSourceResponse``, which adds a 15 s
          ``: ping`` keep-alive comment and sets ``Cache-Control: no-cache`` /
          ``X-Accel-Buffering: no`` headers so proxies (Cloud Run, AWS API
          Gateway, nginx ingress) and Node ``undici`` sockets don't drop idle
          streams during long-running tool calls.
        * Any other content type negotiated by ``EventEncoder`` (e.g. a future
          ``application/vnd.ag-ui.event+proto``) keeps the legacy
          ``StreamingResponse(encoder.encode(...))`` framing so binary clients
          continue to work without keep-alive pings (which are SSE-specific).
        """

        input_data = await _merge_extractor_state(input_data, request, extract_state_fn)
        agent = await _resolve_agent(
            default_agent, request, input_data, agent_resolver
        )

        # ``EventEncoder`` types ``accept`` as ``str`` (not ``Optional[str]``);
        # pass an empty string when the client didn't send an ``Accept`` header
        # so we still hit the default ``text/event-stream`` content type.
        accept_header = request.headers.get("accept", "")
        encoder = EventEncoder(accept=accept_header)
        content_type = encoder.get_content_type()

        if content_type == "text/event-stream":
            return EventSourceResponse(_sse_stream(agent, input_data))
        return StreamingResponse(
            _legacy_stream(agent, input_data, encoder),
            media_type=content_type,
        )

    capabilities_path = f"{path.rstrip('/')}/capabilities" if path != "/" else "/capabilities"

    @app.get(capabilities_path)
    async def capabilities_endpoint(request: Request):
        """Return the agent's declared capabilities.

        Allows frontend clients to discover what features the agent supports
        before initiating a run (e.g., predictive chips, suggested questions).
        The request extractor and resolver are applied with a fixed synthetic
        input so selection only depends on request/extractor context. Returns
        an empty object when no capabilities are configured.
        """
        try:
            synthetic_input = RunAgentInput(
                thread_id="capabilities",
                run_id="capabilities",
                state={},
                messages=[],
                tools=[],
                context=[],
                forwarded_props=None,
            )
            synthetic_input = await _merge_extractor_state(
                synthetic_input, request, extract_state_fn
            )
            agent = await _resolve_agent(
                default_agent, request, synthetic_input, agent_resolver
            )
            caps = agent.get_capabilities() or {}
            # Advertise the transports this endpoint serves: SSE always, and the
            # AG-UI binary protocol (protobuf over HTTP) negotiated via Accept.
            caps.setdefault("transport", {})
            caps["transport"].setdefault("streaming", True)
            caps["transport"]["httpBinary"] = True
            if not caps.get("transport") and len(caps) == 0:
                logger.debug("Capabilities endpoint called but no capabilities configured on agent")
            return JSONResponse(content=caps)
        except Exception as e:
            logger.error(f"Error in capabilities endpoint: {e}", exc_info=True)
            return JSONResponse(
                status_code=500,
                content={"error": f"Failed to retrieve capabilities: {str(e)}"}
            )

    @app.post("/agents/state")
    async def agents_state_endpoint(request_data: AgentStateRequest, request: Request):
        """EXPERIMENTAL: Retrieve thread state and message history.

        This endpoint allows front-end frameworks to retrieve the current state
        and message history for a thread without initiating a new agent run.

        WARNING: This is an experimental endpoint and is subject to change in
        future versions. It is provided to support front-end frameworks that
        require on-demand access to thread state.

        Identity resolution mirrors the chat endpoint so that
        ``extract_state_from_request`` (and the legacy ``extract_headers``)
        is not bypassed when used as an auth hook (#1646). A synthetic
        ``RunAgentInput`` is constructed from the request body and threaded
        through the same extractor pipeline; the resulting state is then
        consulted for ``app_name``/``user_id`` alongside the agent-level
        static values and extractors. Body ``appName``/``userId`` are kept
        as a documented fallback for deployments that configure neither.

        Args:
            request_data: Request containing threadId and optional name/properties
            request: Underlying FastAPI ``Request`` (used by the extractor pipeline)

        Returns:
            JSON response with threadId, threadExists, state, and messages
        """
        thread_id = request_data.threadId

        try:
            synthetic_input = RunAgentInput(
                thread_id=thread_id,
                run_id=f"agents-state-{uuid.uuid4()}",
                state={},
                messages=[],
                tools=[],
                context=[],
                forwarded_props=None,
            )

            if extract_state_fn:
                synthetic_input = await _merge_extractor_state(
                    synthetic_input, request, extract_state_fn
                )

            agent = await _resolve_agent(
                default_agent, request, synthetic_input, agent_resolver
            )

            extractor_state = (
                synthetic_input.state if isinstance(synthetic_input.state, dict) else {}
            )

            # Identity precedence (matches chat endpoint, then falls back to body):
            #   1. ADKAgent static value
            #   2. ADKAgent-level extractor against post-extractor state
            #   3. state["app_name"] / state["user_id"] written by extract_state_fn
            #      (so JWT-style hooks work without also wiring an ADKAgent extractor)
            #   4. Body field (deprecated when an extractor is configured)
            if agent._static_app_name:
                app_name = agent._static_app_name
            elif getattr(agent, "_app_name_extractor", None):
                app_name = agent._app_name_extractor(synthetic_input)
            elif "app_name" in extractor_state:
                app_name = extractor_state["app_name"]
            else:
                app_name = request_data.appName

            if agent._static_user_id:
                user_id = agent._static_user_id
            elif getattr(agent, "_user_id_extractor", None):
                user_id = agent._user_id_extractor(synthetic_input)
            elif "user_id" in extractor_state:
                user_id = extractor_state["user_id"]
            else:
                user_id = request_data.userId

            if extract_state_fn and (request_data.appName or request_data.userId):
                warnings.warn(
                    "appName/userId in the /agents/state request body are "
                    "deprecated when extract_state_from_request is configured. "
                    "Identity is resolved from the extractor pipeline; body "
                    "values are ignored unless the extractor produces neither. "
                    "See ag-ui-protocol/ag-ui#1646.",
                    DeprecationWarning,
                    stacklevel=2,
                )

            if not app_name or not user_id:
                return JSONResponse(content={
                    "threadId": thread_id,
                    "threadExists": False,
                    "state": "{}",
                    "messages": "[]",
                    "error": "appName and userId are required (either in request or as agent static values)"
                })

            session = None
            session_id = None

            # Fast path: check cache first
            metadata = agent._get_session_metadata(thread_id, user_id)
            if metadata:
                session_id, cached_app_name, cached_user_id = metadata
                session = await agent._session_manager._session_service.get_session(
                    session_id=session_id,
                    app_name=cached_app_name,
                    user_id=cached_user_id
                )
                # Use cached values for subsequent operations
                app_name = cached_app_name
                user_id = cached_user_id

            # Cache miss - search backend by thread_id
            if not session:
                # O(1) direct lookup when use_thread_id_as_session_id is enabled
                if getattr(agent._session_manager, '_use_thread_id_as_session_id', False) is True:
                    session = await agent._session_manager.get_session(
                        thread_id, app_name, user_id
                    )
                    if session:
                        session_id = session.id
                        agent._session_lookup_cache[(thread_id, user_id)] = (session_id, app_name, user_id)

                # Fallback to O(n) scan (always used when flag is False,
                # also used as legacy fallback when flag is True but direct lookup misses)
                if not session:
                    session = await agent._session_manager._find_session_by_thread_id(
                        app_name=app_name,
                        user_id=user_id,
                        thread_id=thread_id
                    )
                    if session:
                        # Found - cache for future lookups
                        session_id = session.id
                        agent._session_lookup_cache[(thread_id, user_id)] = (session_id, app_name, user_id)

                        # Reload session to populate events (list_sessions returns metadata only)
                        session = await agent._session_manager._session_service.get_session(
                            session_id=session_id,
                            app_name=app_name,
                            user_id=user_id
                        )

            thread_exists = session is not None

            # Get state
            state = {}
            if thread_exists:
                state = await agent._session_manager.get_session_state(
                    session_id=session_id,
                    app_name=app_name,
                    user_id=user_id
                ) or {}

            # Get messages from session events
            messages = []
            if thread_exists and hasattr(session, 'events') and session.events:
                messages = adk_events_to_messages(session.events)

            # Convert messages to dict format for JSON serialization
            messages_dict = [msg.model_dump(by_alias=True) for msg in messages]

            return JSONResponse(content={
                "threadId": thread_id,
                "threadExists": thread_exists,
                "state": state,
                "messages": messages_dict
            })

        except Exception as e:
            logger.error(f"Error in /agents/state endpoint: {e}", exc_info=True)
            return JSONResponse(
                status_code=500,
                content={
                    "threadId": thread_id,
                    "threadExists": False,
                    "state": {},
                    "messages": [],
                    "error": str(e)
                }
            )


def create_adk_app(
    agent: ADKAgent,
    path: str = "/",
    extract_headers: Optional[List[str]] = None,
    extract_state_from_request: Optional[Callable[[Request, RunAgentInput], Coroutine[dict[str,Any], Any, Any]]] = None,
    agent_resolver: Optional[AgentResolver] = None,
) -> FastAPI:
    """Create a FastAPI app with ADK middleware endpoint.

    Args:
        agent: Configured ADKAgent instance
        path: API endpoint path
        extract_headers: Optional list of HTTP header names to extract into state. Cannot be used with extract_state_from_request.
        extract_state_from_request: Optional async function to extract values mapped from the request into state.
            State values returned from this function will override any existing state values. 
            The RunAgentInput is provided so conflicts can be identified and resolved appropriately.
            Cannot be used with extract_headers.
        agent_resolver: Optional async function that can select an ``ADKAgent``
            for the request after state extraction. Returning ``None`` uses
            the default agent.

    Returns:
        FastAPI application instance
    """
    app = FastAPI(title="ADK Middleware for AG-UI Protocol")
    add_adk_fastapi_endpoint(
        app,
        agent,
        path,
        extract_headers=extract_headers,
        extract_state_from_request=extract_state_from_request,
        agent_resolver=agent_resolver,
    )
    return app
