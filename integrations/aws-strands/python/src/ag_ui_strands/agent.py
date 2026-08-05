"""AWS Strands Agent adapter for AG-UI.

Translates Strands streaming events into the AG-UI event protocol.
"""

import asyncio
import base64
import inspect
import json
import logging
import uuid
from typing import Any, AsyncIterator, Dict, List

from strands import Agent as StrandsAgentCore
from strands.session import SessionManager

# Params handled explicitly by StrandsAgent — excluded from auto-forwarding.
# "messages" is excluded: per-thread agents start with no history;
# AG-UI injects messages at runtime via RunAgentInput.
# "hooks" is excluded: Agent stores hooks as a HookRegistry after init, not
# the original list the constructor expects — forwarding it causes a TypeError.
# "session_manager" is excluded: it is supplied per-thread via
# StrandsAgentConfig.session_manager_provider (see run()). Forwarding a
# template-level session_manager would make every thread share one session_id.
_AGUI_EXPLICIT_PARAMS = {
    "self",
    "model",
    "system_prompt",
    "tools",
    "messages",
    "hooks",
    "session_manager",
}


def _extract_agent_kwargs(agent: StrandsAgentCore) -> dict:
    """Build kwargs for StrandsAgentCore by introspecting its constructor signature.

    Tries ``self.<name>`` first, falls back to ``self._<name>`` — Strands stores
    some init params with an underscore prefix (e.g. ``retry_strategy`` lives at
    ``self._retry_strategy``). This keeps the adapter forward-compatible with
    any future param that follows either naming convention.
    """
    kwargs = {}
    for name in inspect.signature(StrandsAgentCore.__init__).parameters:
        if name in _AGUI_EXPLICIT_PARAMS:
            continue
        if hasattr(agent, name):
            value = getattr(agent, name)
        elif hasattr(agent, f"_{name}"):
            value = getattr(agent, f"_{name}")
        else:
            continue
        if value is None:
            continue
        # state is an AgentState container; extract the underlying plain dict
        if name == "state" and hasattr(value, "get"):
            value = value.get()
        kwargs[name] = value
    return kwargs


# Upper bound on the per-agent wire->native map held in session state. Bounds
# growth from frontend calls that never receive a client result (abandoned HITL)
# and so are never consumed/pruned. Generous — a thread rarely has this many
# outstanding frontend calls at once.
_WIRE_MAP_MAX = 512


def _get_strands_session_manager(agent: Any) -> Any:
    """Return the agent's Strands ``SessionManager``, or ``None``.

    Strands stores it publicly as ``session_manager``; some versions keep a
    private ``_session_manager`` alias.
    """
    return getattr(agent, "session_manager", None) or getattr(
        agent, "_session_manager", None
    )


logger = logging.getLogger(__name__)
from ag_ui.core import (
    AssistantMessage,
    CustomEvent,
    EventType,
    FunctionCall,
    MessagesSnapshotEvent,
    ReasoningEncryptedValueEvent,
    ReasoningEndEvent,
    ReasoningMessageContentEvent,
    ReasoningMessageEndEvent,
    ReasoningMessageStartEvent,
    ReasoningStartEvent,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
    StateSnapshotEvent,
    StepFinishedEvent,
    StepStartedEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ToolCall,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
    ToolCallStartEvent,
    ToolMessage,
    UserMessage,
)

from ag_ui_a2ui_toolkit import split_a2ui_schema_context

from .a2ui_tool import (
    A2UI_STREAM_KEY,
    is_auto_injected_a2ui_tool,
    plan_a2ui_injection,
)
from .client_proxy_tool import sync_proxy_tools
from .session_reconcile import (
    AG_UI_WIRE_MAP_STATE_KEY,
    has_placeholder_results,
    reconcile_frontend_tool_results,
    resolve_native_ids,
)
from .config import (
    StrandsAgentConfig,
    ToolCallContext,
    ToolResultContext,
    maybe_await,
    normalize_predict_state,
)
from .utils import convert_agui_content_to_strands, flatten_content_to_text


def _coerce_text(content: Any) -> str:
    """Best-effort string view of an AG-UI message content field."""
    if isinstance(content, str):
        return content
    if content is None:
        return ""
    return str(content)


def _coerce_id(value: Any) -> str:
    """Return ``value`` if it is a non-empty string, else a fresh UUID."""
    return value if isinstance(value, str) and value else str(uuid.uuid4())


def _build_snapshot_messages(input_messages: List[Any]) -> List[Any]:
    """Convert ``RunAgentInput.messages`` to AG-UI message objects.

    Used to seed the running ``MessagesSnapshotEvent`` payload so each
    snapshot carries the full thread history (prior turns + whatever
    this turn produces).
    """
    out: List[Any] = []
    for msg in input_messages or []:
        role = getattr(msg, "role", None)
        if role not in ("user", "assistant", "tool"):
            continue
        msg_id = _coerce_id(getattr(msg, "id", None))
        if role == "user":
            out.append(UserMessage(id=msg_id, role="user", content=_coerce_text(msg.content)))
        elif role == "assistant":
            tool_calls_list = None
            raw_tool_calls = getattr(msg, "tool_calls", None)
            if raw_tool_calls:
                tool_calls_list = []
                for tc in raw_tool_calls:
                    fn = getattr(tc, "function", None)
                    if isinstance(fn, dict):
                        fn_name = fn.get("name") or "unknown"
                        fn_args = fn.get("arguments") or "{}"
                    else:
                        fn_name = getattr(fn, "name", None) or "unknown"
                        fn_args = getattr(fn, "arguments", None) or "{}"
                    tc_id = _coerce_id(getattr(tc, "id", None))
                    tool_calls_list.append(
                        ToolCall(
                            id=tc_id,
                            type="function",
                            function=FunctionCall(
                                name=str(fn_name),
                                arguments=str(fn_args),
                            ),
                        )
                    )
            out.append(
                AssistantMessage(
                    id=msg_id,
                    role="assistant",
                    content=_coerce_text(msg.content),
                    tool_calls=tool_calls_list,
                )
            )
        elif role == "tool":
            tool_call_id = getattr(msg, "tool_call_id", "")
            if not isinstance(tool_call_id, str):
                tool_call_id = ""
            out.append(
                ToolMessage(
                    id=msg_id,
                    role="tool",
                    content=_coerce_text(msg.content),
                    tool_call_id=tool_call_id,
                )
            )
    return out


def _build_strands_history(input_messages: List[Any]) -> List[Dict[str, Any]]:
    """Convert ``RunAgentInput.messages`` to Strands native ``Messages``.

    Strands has only ``user`` and ``assistant`` roles; tool calls and
    tool results live as ``toolUse`` / ``toolResult`` ContentBlocks.
    Reconciling the cached agent's ``self.messages`` with this list
    before invoking ``stream_async(None)`` ensures the LLM sees the
    real conversation state — including frontend tool results — rather
    than a fresh prompt that re-fires the same tool every turn.
    """
    out: List[Dict[str, Any]] = []
    pending_tool_results: List[Dict[str, Any]] = []

    def flush_tool_results() -> None:
        if not pending_tool_results:
            return
        out.append({"role": "user", "content": list(pending_tool_results)})
        pending_tool_results.clear()

    for msg in input_messages or []:
        role = getattr(msg, "role", None)
        if role == "tool":
            pending_tool_results.append(
                {
                    "toolResult": {
                        "toolUseId": getattr(msg, "tool_call_id", "") or "",
                        "content": [{"text": _coerce_text(msg.content)}],
                        "status": "success",
                    }
                }
            )
            continue

        flush_tool_results()

        if role == "user":
            content = msg.content
            if isinstance(content, list):
                has_media = any(
                    getattr(item, "type", None) in ("image", "audio", "video", "document")
                    for item in content
                )
                if has_media:
                    blocks = convert_agui_content_to_strands(content)
                    if isinstance(blocks, list) and blocks:
                        out.append({"role": "user", "content": blocks})
                        continue
                text = flatten_content_to_text(content) or ""
                out.append({"role": "user", "content": [{"text": text}]})
            else:
                out.append({"role": "user", "content": [{"text": _coerce_text(content)}]})
        elif role == "assistant":
            blocks: List[Dict[str, Any]] = []
            text = _coerce_text(msg.content)
            if text:
                blocks.append({"text": text})
            raw_tool_calls = getattr(msg, "tool_calls", None) or []
            for tc in raw_tool_calls:
                fn = getattr(tc, "function", None)
                if isinstance(fn, dict):
                    name = fn.get("name") or "unknown"
                    args = fn.get("arguments") or "{}"
                else:
                    name = getattr(fn, "name", None) or "unknown"
                    args = getattr(fn, "arguments", None) or "{}"
                try:
                    parsed = json.loads(args) if isinstance(args, str) else (args or {})
                except (json.JSONDecodeError, TypeError):
                    parsed = {}
                blocks.append(
                    {
                        "toolUse": {
                            "toolUseId": tc.id,
                            "name": name,
                            "input": parsed if isinstance(parsed, dict) else {},
                        }
                    }
                )
            if not blocks:
                blocks = [{"text": ""}]
            out.append({"role": "assistant", "content": blocks})

    flush_tool_results()
    return out


class StrandsAgent:
    """AWS Strands Agent wrapper for AG-UI integration."""

    def __init__(
        self,
        agent: StrandsAgentCore,
        name: str,
        description: str = "",
        config: "StrandsAgentConfig | None" = None,
        hooks: "list | None" = None,
    ):
        # Store template agent configuration for creating fresh instances
        self._model = agent.model
        self._system_prompt = agent.system_prompt
        self._tools = (
            list(agent.tool_registry.registry.values())
            if hasattr(agent, "tool_registry")
            else []
        )
        self._agent_kwargs = _extract_agent_kwargs(agent)

        # Hook providers forwarded to each per-thread StrandsAgentCore.
        #
        # Why a dedicated kwarg instead of reading them off the template?
        # Strands initializes ``Agent.hooks`` as a ``HookRegistry`` containing
        # only the registered callbacks — the original list of HookProvider
        # objects is not retained, and the registry also contains callbacks
        # bound to internal Strands objects (conversation manager, retry
        # strategy) that belong to the template and must not be cross-wired
        # into per-thread agents. We therefore take providers directly from
        # the caller and forward them to every per-thread instance so any
        # observability / loop-cap / policy-enforcement hook actually fires.
        self._hooks = list(hooks) if hooks else []

        self.name = name
        self.description = description
        self.config = config or StrandsAgentConfig()

        # Detect the common footgun: session_manager set on the template Agent
        # (stored as `_session_manager` by Strands) with no per-thread provider.
        # Forwarding it would make every AG-UI thread share one session_id.
        template_session_manager = getattr(agent, "_session_manager", None)
        if (
            template_session_manager is not None
            and self.config.session_manager_provider is None
        ):
            logger.warning(
                "session_manager was set on the template Agent but will be ignored: "
                "forwarding it would cause every AG-UI thread to share the same "
                "session_id. Construct per-thread session managers via "
                "StrandsAgentConfig.session_manager_provider instead."
            )

        # Dictionary to store agent instances per thread
        self._agents_by_thread: Dict[str, StrandsAgentCore] = {}
        # Track proxy tool names registered per thread
        self._proxy_tool_names_by_thread: Dict[str, set] = {}
        # Guards first-time thread initialization. The session_manager_provider
        # call introduces an async yield point between the "is this thread
        # new?" check and the dict assignment, so concurrent requests for the
        # same new thread_id could otherwise both create an agent and one
        # would clobber the other.
        self._thread_init_lock = asyncio.Lock()

    def _will_emit_tool_snapshot(self, behavior: Any, emit_snapshots: bool) -> bool:
        # ``emit_snapshots`` is the per-run gate (config flag AND not a
        # delta-only payload); callers pass it so snapshot emission stays
        # suppressed on delta payloads that would otherwise wipe prior turns.
        return emit_snapshots and not (
            behavior and behavior.skip_messages_snapshot
        )

    async def run(self, input_data: RunAgentInput) -> AsyncIterator[Any]:
        """Run the Strands agent and yield AG-UI events."""

        # Get or create agent instance for this thread. When a
        # session_manager_provider is configured, the SessionManager handles
        # conversation persistence; otherwise state is held in-memory per thread.
        thread_id = input_data.thread_id or "default"
        if thread_id not in self._agents_by_thread:
            async with self._thread_init_lock:
                # Double-check inside the lock: another coroutine may have
                # completed initialization while we were waiting.
                if thread_id not in self._agents_by_thread:
                    session_manager = None
                    if self.config.session_manager_provider:
                        try:
                            session_manager = await maybe_await(
                                self.config.session_manager_provider(input_data)
                            )
                        except Exception as e:
                            # ERROR (not WARNING): the run is being aborted.
                            # exc_info=True preserves the full traceback so
                            # programming errors (TypeError, NameError, ...)
                            # in the provider surface clearly rather than
                            # looking like an infrastructure problem.
                            logger.error(
                                f"session_manager_provider failed: {e}",
                                exc_info=True,
                            )
                            yield RunStartedEvent(
                                type=EventType.RUN_STARTED,
                                thread_id=input_data.thread_id,
                                run_id=input_data.run_id,
                            )
                            yield RunErrorEvent(
                                type=EventType.RUN_ERROR,
                                message=f"Failed to initialize session manager: {e}",
                                code="SESSION_MANAGER_ERROR",
                            )
                            return
                        # Validate the provider return type at the boundary —
                        # otherwise a forgotten call or wrong type surfaces
                        # deep inside Strands with a confusing traceback.
                        if session_manager is not None and not isinstance(
                            session_manager, SessionManager
                        ):
                            actual = type(session_manager).__name__
                            logger.error(
                                "session_manager_provider returned %s; "
                                "expected a SessionManager instance.",
                                actual,
                            )
                            yield RunStartedEvent(
                                type=EventType.RUN_STARTED,
                                thread_id=input_data.thread_id,
                                run_id=input_data.run_id,
                            )
                            yield RunErrorEvent(
                                type=EventType.RUN_ERROR,
                                message=(
                                    f"session_manager_provider returned {actual}; "
                                    "expected a SessionManager instance"
                                ),
                                code="SESSION_MANAGER_INVALID_TYPE",
                            )
                            return
                    if session_manager is None and self.config.session_manager_provider:
                        logger.warning(
                            f"session_manager_provider returned None for thread_id={thread_id}; "
                            "agent will run without session persistence"
                        )
                    # Only forward ``hooks`` when the caller actually
                    # supplied providers. Passing ``hooks=None`` or
                    # ``hooks=[]`` risks being interpreted differently by
                    # future StrandsAgentCore versions (e.g. as "disable
                    # default hooks"), so we omit the kwarg entirely when
                    # there's nothing to forward.
                    core_kwargs = dict(self._agent_kwargs)
                    if self._hooks:
                        core_kwargs["hooks"] = list(self._hooks)
                    self._agents_by_thread[thread_id] = StrandsAgentCore(
                        model=self._model,
                        system_prompt=self._system_prompt,
                        tools=self._tools,
                        session_manager=session_manager,
                        **core_kwargs,
                    )
        strands_agent = self._agents_by_thread[thread_id]

        # Forward ``RunAgentInput.context`` to the per-thread Strands agent's
        # state so user tools can read it (e.g. catalog/component schemas
        # injected by the CopilotKit FE for A2UI rendering). Mirrors the
        # langgraph integration where tools read ``runtime.state["copilotkit"]
        # ["context"]``. Stored as a plain list of ``{description, value}``
        # dicts to satisfy ``JSONSerializableDict`` validation.
        agui_context = []
        for ctx in (input_data.context or []):
            if isinstance(ctx, dict):
                agui_context.append(
                    {
                        "description": ctx.get("description", ""),
                        "value": ctx.get("value", ""),
                    }
                )
            else:
                agui_context.append(
                    {
                        "description": getattr(ctx, "description", "") or "",
                        "value": getattr(ctx, "value", "") or "",
                    }
                )
        try:
            strands_agent.state.set("agui_context", agui_context)
        except Exception as e:
            logger.warning(f"Failed to set agui_context on strands_agent.state: {e}")

        # Sync proxy tools from client-defined tools
        if input_data.tools:
            proxy_names = sync_proxy_tools(
                strands_agent.tool_registry,
                input_data.tools,
                self._proxy_tool_names_by_thread.get(thread_id, set()),
            )
            self._proxy_tool_names_by_thread[thread_id] = proxy_names
        elif self._proxy_tool_names_by_thread.get(thread_id):
            # Remove all stale proxy tools when no tools are sent
            sync_proxy_tools(
                strands_agent.tool_registry,
                [],
                self._proxy_tool_names_by_thread[thread_id],
            )
            self._proxy_tool_names_by_thread[thread_id] = set()

        # A2UI auto-injection. When the runtime forwards
        # ``injectA2UITool`` (or the host opts in via ``config.a2ui``), register
        # a ``generate_a2ui`` recovery tool bound to this agent's model and drop
        # the injected ``render_a2ui`` proxy so the model calls generate_a2ui
        # directly. Best-effort: a failure here logs and runs without A2UI
        # rather than crashing the turn.
        try:
            registry = strands_agent.tool_registry
            # Remove our OWN prior-turn auto-injected tool first, so (a) the
            # refreshed tool carries THIS turn's messages/state, and (b) the
            # USER-PREVAILS check only ever sees a dev-wired
            # generate_a2ui — not our own from a previous turn on this cached
            # agent. Without this, turn 2+ leaks the re-synced render_a2ui back
            # to the model.
            for name in [
                n for n, t in list(registry.registry.items())
                if is_auto_injected_a2ui_tool(t)
            ]:
                registry.registry.pop(name, None)
                getattr(registry, "dynamic_tools", {}).pop(name, None)
            # Lift the A2UI component schema + remaining context under
            # state["ag-ui"] so the generate_a2ui sub-agent prompt carries the
            # "## Available Components" block + context — same routing the
            # LangGraph adapter does in its state merge. Uses the shared toolkit
            # split so both adapters agree on the schema-context description.
            a2ui_schema_value, a2ui_regular_ctx = split_a2ui_schema_context(
                input_data.context
            )
            a2ui_state = (
                dict(input_data.state)
                if isinstance(input_data.state, dict)
                else {}
            )
            a2ui_ag_ui: dict = {"context": a2ui_regular_ctx}
            if a2ui_schema_value is not None:
                a2ui_ag_ui["a2ui_schema"] = a2ui_schema_value
            a2ui_state["ag-ui"] = a2ui_ag_ui

            a2ui_plan = plan_a2ui_injection(
                model=getattr(strands_agent, "model", None),
                input=input_data,
                existing_tool_names=list(registry.registry.keys()),
                config=self.config.a2ui,
                log=logger,
                strands_agent=strands_agent,
                agui_state=a2ui_state,
            )
            if a2ui_plan:
                # Register FIRST: if this raises, the except below degrades to
                # "render proxy leaks through" (middleware still paints,
                # unvalidated) instead of a turn with no A2UI path at all.
                registry.register_tool(a2ui_plan["tool"])
                for name in a2ui_plan["drop_tool_names"]:
                    registry.registry.pop(name, None)
                    getattr(registry, "dynamic_tools", {}).pop(name, None)
                    # Keep the proxy bookkeeping honest — the dropped render
                    # tool is no longer registered.
                    self._proxy_tool_names_by_thread.get(thread_id, set()).discard(name)
        except Exception as e:  # noqa: BLE001 — never crash the turn here
            # ERROR, not warning: the runtime explicitly requested injection
            # (injectA2UITool) and this turn runs without it.
            logger.error(
                "A2UI auto-injection failed; running without A2UI for this turn: %s",
                e,
                exc_info=True,
            )

        # Start run
        yield RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id=input_data.thread_id,
            run_id=input_data.run_id,
        )

        try:
            # Detect delta-only payloads (where the client sent fewer
            # messages than the session has — e.g. only the trailing
            # tool result, or only the new user message in a continued
            # chat). CopilotKit V2's MESSAGES_SNAPSHOT handler treats
            # the snapshot as authoritative: any existing client message
            # whose id is not in the snapshot gets dropped. Emitting a
            # partial snapshot on a delta payload would wipe prior turns
            # from the UI. The frontend already has the full history with
            # the original ids, so we suppress snapshot emission for this
            # run and let TEXT_MESSAGE_*/TOOL_CALL_* streaming events
            # reconcile naturally.
            session_msgs = getattr(strands_agent, "messages", None) or []
            is_delta_payload = (
                bool(session_msgs)
                and len(session_msgs) > len(input_data.messages or [])
            )
            emit_snapshots = (
                self.config.emit_messages_snapshot and not is_delta_payload
            )

            # Seed the running ``MessagesSnapshotEvent`` payload from the
            # full conversation history sent by the client. Each emitted
            # snapshot then carries prior turns + whatever this turn adds.
            snapshot_messages: List[Any] = (
                _build_snapshot_messages(input_data.messages)
                if emit_snapshots
                else []
            )

            # Emit state snapshot if provided
            if hasattr(input_data, "state") and input_data.state is not None:
                # Filter out messages from state to avoid "Unknown message role" errors
                # The frontend manages messages separately and doesn't recognize "tool" role
                state_snapshot = {
                    k: v for k, v in input_data.state.items() if k != "messages"
                }
                yield StateSnapshotEvent(
                    type=EventType.STATE_SNAPSHOT, snapshot=state_snapshot
                )

            # Splice point 1 of 4: emit the initial messages snapshot right
            # after ``RunStartedEvent`` / ``StateSnapshotEvent`` so the
            # frontend can render the seeded thread before any new content
            # streams in.
            if emit_snapshots and snapshot_messages:
                yield MessagesSnapshotEvent(
                    type=EventType.MESSAGES_SNAPSHOT,
                    messages=list(snapshot_messages),
                )

            # Extract frontend tool names from input_data.tools
            frontend_tool_names = set()
            if input_data.tools:
                for tool_def in input_data.tools:
                    tool_name = (
                        tool_def.get("name")
                        if isinstance(tool_def, dict)
                        else getattr(tool_def, "name", None)
                    )
                    if tool_name:
                        frontend_tool_names.add(tool_name)

            # Collect tool_call_ids that already have results in the message history
            # so we suppress duplicate TOOL_CALL_START events only for those specific calls
            pending_tool_result_ids: set[str] = set()
            if input_data.messages:
                for msg in reversed(input_data.messages):
                    if msg.role == "tool":
                        tool_call_id = getattr(msg, "tool_call_id", None)
                        if tool_call_id:
                            pending_tool_result_ids.add(tool_call_id)
                    else:
                        break
                if pending_tool_result_ids:
                    logger.debug(
                        f"Has pending tool results detected: tool_call_ids={pending_tool_result_ids}, thread_id={input_data.thread_id}"
                    )

            # Convert AG-UI messages to Strands format
            # Strands expects content as List[ContentBlock] for most messages
            # OpenAI requires tool messages to follow assistant messages with tool_calls
            strands_messages = []
            last_msg_had_tool_calls = False
            expected_tool_call_ids = set()  # Track which tool_call_ids are valid

            logger.debug(
                f"Converting {len(input_data.messages)} messages to Strands format, thread_id={input_data.thread_id}"
            )

            for i, msg in enumerate(input_data.messages):
                logger.debug(
                    f"Message {i}: role={msg.role}, has_tool_calls={hasattr(msg, 'tool_calls') and bool(msg.tool_calls)}, tool_call_id={getattr(msg, 'tool_call_id', None)}"
                )
                strands_msg: Dict[str, Any] = {"role": msg.role}

                # Handle assistant messages with tool_calls
                if (
                    msg.role == "assistant"
                    and hasattr(msg, "tool_calls")
                    and msg.tool_calls
                ):
                    # Convert tool calls to format expected by Strands/OpenAI
                    strands_msg["content"] = []
                    if msg.content:
                        if isinstance(msg.content, str):
                            strands_msg["content"].append({"text": msg.content})
                        elif isinstance(msg.content, list):
                            strands_msg["content"] = msg.content

                    strands_msg["tool_calls"] = []
                    expected_tool_call_ids.clear()  # Reset for this assistant message
                    for tc in msg.tool_calls:
                        expected_tool_call_ids.add(tc.id)  # Track this tool call ID
                        strands_msg["tool_calls"].append(
                            {
                                "id": tc.id,
                                "type": "function",
                                "function": {
                                    "name": tc.function.get("name")
                                    if isinstance(tc.function, dict)
                                    else tc.function.name,
                                    "arguments": tc.function.get("arguments")
                                    if isinstance(tc.function, dict)
                                    else tc.function.arguments,
                                },
                            }
                        )
                    last_msg_had_tool_calls = True
                    strands_messages.append(strands_msg)

                # Handle tool messages (must follow assistant message with tool_calls)
                elif msg.role == "tool":
                    # Skip tool messages that don't have a preceding assistant message
                    # with tool_calls — UNLESS this is a pending frontend tool result
                    # (delta-only payloads only contain the tool result, so the
                    # assistant message is absent but the result is still valid).
                    is_pending_frontend_result = (
                        msg.tool_call_id in pending_tool_result_ids
                    )
                    if (
                        not last_msg_had_tool_calls
                        or msg.tool_call_id not in expected_tool_call_ids
                    ) and not is_pending_frontend_result:
                        logger.debug(
                            f"Skipping orphaned tool message: tool_call_id={msg.tool_call_id}, last_msg_had_tool_calls={last_msg_had_tool_calls}, valid_ids={expected_tool_call_ids}, thread_id={input_data.thread_id}"
                        )
                        continue

                    # Include the tool message for OpenAI format compliance
                    strands_msg["tool_call_id"] = msg.tool_call_id
                    if isinstance(msg.content, str):
                        strands_msg["content"] = [{"text": msg.content}]
                    else:
                        strands_msg["content"] = msg.content

                    expected_tool_call_ids.discard(msg.tool_call_id)
                    if not expected_tool_call_ids:
                        last_msg_had_tool_calls = False
                    strands_messages.append(strands_msg)

                # Handle regular messages (user, assistant without tool_calls)
                else:
                    if isinstance(msg.content, str):
                        strands_msg["content"] = [{"text": msg.content}]
                    elif isinstance(msg.content, list):
                        strands_msg["content"] = msg.content
                    else:
                        strands_msg["content"] = [{"text": ""}]
                    last_msg_had_tool_calls = False
                    strands_messages.append(strands_msg)

            # Build a lookup of tool_call_id -> tool_name from the input messages
            # directly (the assistant message in Run 2 already carries the name).
            _tool_call_id_to_name: dict = {}
            for _msg in (input_data.messages or []):
                if _msg.role == "assistant" and hasattr(_msg, "tool_calls") and _msg.tool_calls:
                    for tc in _msg.tool_calls:
                        tc_name = tc.function.get("name") if isinstance(tc.function, dict) else tc.function.name
                        if tc.id and tc_name:
                            _tool_call_id_to_name[tc.id] = tc_name

            # On delta-only continuation payloads, the assistant message that
            # carries the tool_call is absent from input_data.messages, so the
            # lookup above misses. The session manager still holds the full
            # native history — scan its ``toolUse`` blocks so we resolve the
            # tool that actually executed rather than guessing.
            for _smsg in session_msgs:
                if not isinstance(_smsg, dict) or _smsg.get("role") != "assistant":
                    continue
                for _block in (_smsg.get("content") or []):
                    tool_use = _block.get("toolUse") if isinstance(_block, dict) else None
                    if tool_use:
                        tu_id = tool_use.get("toolUseId")
                        tu_name = tool_use.get("name")
                        if tu_id and tu_name and tu_id not in _tool_call_id_to_name:
                            _tool_call_id_to_name[tu_id] = tu_name

            # Get the latest user message for state context builder.
            # For continuation runs (has_pending_tool_result), derive a meaningful
            # message from the frontend tool that was just executed so the agent
            # understands the context and can generate a proper conclusion.
            user_message = ""
            if pending_tool_result_ids and input_data.messages:
                for msg in reversed(input_data.messages):
                    if msg.role == "tool" and hasattr(msg, "tool_call_id"):
                        tool_name = _tool_call_id_to_name.get(msg.tool_call_id)
                        if tool_name and tool_name in frontend_tool_names:
                            # Forward the ACTUAL frontend tool result so the model
                            # can act on the human's decision (e.g. an approval
                            # resolving to {"approved": false}). Previously this
                            # discarded ``msg.content`` and hardcoded a success
                            # string, silently breaking HITL — the model was told
                            # the tool "executed successfully with no return value"
                            # regardless of what the human actually returned.
                            # Only fall back to that synthetic acknowledgement when
                            # the result is genuinely empty.
                            result_text = (
                                msg.content
                                if isinstance(msg.content, str)
                                else flatten_content_to_text(msg.content)
                            )
                            if result_text and result_text.strip():
                                user_message = f"{tool_name} returned: {result_text}"
                            else:
                                user_message = f"{tool_name} executed successfully with no return value."
                        else:
                            # Could not resolve the executed tool's name from
                            # input messages or session history. Leave the
                            # continuation message empty rather than guessing:
                            # picking an arbitrary frontend tool would feed false
                            # context to the LLM when several frontend tools exist.
                            # Strands still has the real tool result in session
                            # history to conclude the round-trip from.
                            logger.warning(
                                f"Could not resolve tool name for tool_call_id={msg.tool_call_id} "
                                f"from input messages or session history (assistant message with "
                                f"tool_calls may be missing — delta-only payload). Leaving the "
                                f"continuation message empty."
                            )
                        break
            elif input_data.messages:
                for msg in reversed(input_data.messages):
                    if (msg.role == "user" or msg.role == "tool") and msg.content:
                        if isinstance(msg.content, list):
                            has_media = any(
                                getattr(item, "type", None) in ("image", "audio", "video", "document")
                                for item in msg.content
                            )
                            if has_media:
                                user_message = convert_agui_content_to_strands(msg.content)
                                if not user_message:
                                    # All content blocks failed conversion — fall back to text
                                    user_message = flatten_content_to_text(msg.content) or ""
                                    logger.warning("All media content blocks failed conversion, falling back to text")
                            else:
                                user_message = flatten_content_to_text(msg.content)
                        else:
                            user_message = msg.content
                        break

            # Optionally allow configuration to adjust the outgoing user message
            if self.config.state_context_builder:
                try:
                    text_for_builder = flatten_content_to_text(user_message) if isinstance(user_message, list) else user_message
                    builder_result = self.config.state_context_builder(
                        input_data, text_for_builder
                    )
                    if not isinstance(user_message, list):
                        user_message = builder_result
                    else:
                        logger.debug("state_context_builder result not applied to multimodal message — multimodal content preserved")
                    # If state_context_builder modifies the message, update the last user message
                    if not isinstance(user_message, list) and strands_messages and strands_messages[-1]["role"] == "user":
                        strands_messages[-1]["content"] = [{"text": user_message}]
                except Exception as e:
                    # If the builder fails, keep the original message
                    logger.warning(f"State context builder failed: {e}", exc_info=True)

            # Generate unique message ID
            message_id = str(uuid.uuid4())
            message_started = False
            accumulated_text = ""
            # Tracks the latest assistant text id that was actually emitted on
            # the wire. Tool calls use it only when no snapshot will expose the
            # tool-call AssistantMessage id.
            last_emitted_text_message_id: str | None = None
            tool_calls_seen = {}
            current_state = dict(input_data.state or {})  # Track state for final snapshot
            stop_text_streaming = False
            halt_event_stream = False
            pending_halt = False

            # Reasoning/thinking state tracking
            reasoning_started = False
            reasoning_message_id = None

            logger.debug(
                f"Starting agent run: thread_id={input_data.thread_id}, run_id={input_data.run_id}, pending_tool_result_ids={pending_tool_result_ids}, message_count={len(input_data.messages)}, strands_message_count={len(strands_messages)}"
            )

            # Collect the real results the client produced for proxied
            # frontend tools. These arrive in ``RunAgentInput.messages`` on the
            # continuation run and are used to reconcile the session-persisted
            # "Forwarded to client" placeholder. A tool result is a frontend
            # result when its tool name is client-declared, or (for delta-only
            # payloads that omit the assistant message) when its wire id was
            # recorded in the wire->native map when the call was emitted.
            session_manager = _get_strands_session_manager(strands_agent)
            # The durable wire->native map recorded at emission, read back from
            # session state (restored from the store on a fresh process).
            wire_to_native: Dict[str, str] = {}
            if session_manager is not None:
                wire_to_native = (
                    strands_agent.state.get(AG_UI_WIRE_MAP_STATE_KEY) or {}
                )
            # Scope to the TRAILING tool results (this continuation's just-
            # returned results). ``pending_tool_result_ids`` holds those ids;
            # without this, a multi-turn continuation re-sends already-reconciled
            # historical results, which can never be re-corrected and would force
            # the legacy fallback every turn.
            frontend_results: List[Dict[str, Any]] = []
            for msg in (input_data.messages or []):
                if getattr(msg, "role", None) != "tool":
                    continue
                wire_id = getattr(msg, "tool_call_id", None)
                if not wire_id or wire_id not in pending_tool_result_ids:
                    continue
                name = _tool_call_id_to_name.get(wire_id)
                if name not in frontend_tool_names and wire_id not in wire_to_native:
                    continue
                content = msg.content
                text = (
                    content
                    if isinstance(content, str)
                    else flatten_content_to_text(content)
                )
                frontend_results.append({"wire_id": wire_id, "text": text or ""})

            # Translate the client's wire tool_call_id back to the native
            # toolUseId Strands persisted (they differ for frontend tools — see
            # the fresh-uuid assignment in the streaming loop). Only reconcile
            # when there is at least one NON-EMPTY frontend result: a void tool
            # returns nothing, and the synthetic "executed successfully with no
            # return value" continuation message conveys that better than an
            # empty toolResult. When reconciling, void placeholders in the same
            # turn are still cleared (to "") so the literal "Forwarded to client"
            # is never fed to the model.
            resolved_native_results: Dict[str, str] = {}
            corrected_native_ids: set[str] = set()
            has_nonvoid_frontend_result = any(
                (r["text"] or "").strip() for r in frontend_results
            )
            if session_manager is not None and self.config.replay_history_into_strands:
                resolved_native_results = resolve_native_ids(
                    wire_to_native, frontend_results
                )

            # Reconcile Strands' internal conversation history with
            # ``RunAgentInput.messages``. Without this, frontend tool results
            # sent by the client never reach the LLM — Strands sees an open
            # ``toolUse`` from the prior turn and the LLM re-fires the same tool
            # every run, producing the "chart loops forever" symptom.
            #
            # No session manager: rebuild history in-memory and stream it.
            # With a session manager (which owns persistence): overwrite the
            # persisted placeholder toolResult(s) with the real client result
            # via the session repository, then continue from the corrected
            # native history — keeping a single source of truth rather than a
            # placeholder plus a synthetic "tool returned: X" message.
            replay_history = (
                self.config.replay_history_into_strands and session_manager is None
            )
            reconcile_session_results = (
                session_manager is not None
                and self.config.replay_history_into_strands
                and has_nonvoid_frontend_result
            )
            if replay_history:
                native_history = _build_strands_history(input_data.messages)
                # Apply ``state_context_builder`` to the last user-text
                # message in the reconciled history rather than to the
                # synthetic ``user_message`` string. This matches what the
                # builder is actually trying to enrich (the prompt the LLM
                # will see).
                if self.config.state_context_builder and native_history:
                    for native_msg in reversed(native_history):
                        if (
                            native_msg.get("role") == "user"
                            and native_msg.get("content")
                            and isinstance(native_msg["content"], list)
                            and "text" in native_msg["content"][0]
                        ):
                            try:
                                augmented = self.config.state_context_builder(
                                    input_data, native_msg["content"][0]["text"]
                                )
                                if isinstance(augmented, str):
                                    native_msg["content"][0]["text"] = augmented
                            except Exception as e:
                                logger.warning(
                                    f"state_context_builder failed: {e}", exc_info=True
                                )
                            break
                strands_agent.messages = native_history
                # ``stream_async(None)`` tells Strands to use existing
                # ``self.messages`` as-is. The LLM sees real tool results
                # (including ones produced by the frontend) and emits a
                # proper follow-up turn instead of re-calling the tool.
                agent_stream = strands_agent.stream_async(None)
            elif reconcile_session_results:
                try:
                    corrected_native_ids = reconcile_frontend_tool_results(
                        session_manager, strands_agent, resolved_native_results
                    )
                except Exception as e:  # noqa: BLE001 — degrade, don't crash the turn
                    logger.warning(
                        "Frontend tool result reconciliation failed; falling back to "
                        f"the legacy continuation path: {e}",
                        exc_info=True,
                    )
                # Continue from the corrected native history only when every
                # NON-EMPTY frontend result this turn resolved to a native id
                # (i.e. was present in the wire->native map) AND none of those
                # placeholders remain uncleared. The scan is scoped to this
                # turn's results so a stale placeholder from a prior (e.g. void)
                # turn doesn't force the legacy path. Any shortfall means
                # forwarding the real result as a synthetic user message is
                # safer than replaying a stub.
                non_void_results = [
                    r for r in frontend_results if (r["text"] or "").strip()
                ]
                resolved_non_void = {
                    native
                    for native, text in resolved_native_results.items()
                    if (text or "").strip()
                }
                all_non_void_resolved = len(resolved_non_void) == len(non_void_results)
                # Scan all of this turn's resolved native ids (void included, so a
                # resolved-but-uncleared void placeholder also blocks) — but not
                # unrelated historical placeholders.
                reconciled = all_non_void_resolved and not has_placeholder_results(
                    getattr(strands_agent, "messages", None) or [],
                    only_ids=set(resolved_native_results),
                )
                agent_stream = strands_agent.stream_async(
                    None if reconciled else user_message
                )
            else:
                # Legacy path: pass only the latest user message and trust
                # Strands (via session_manager) to track history.
                agent_stream = strands_agent.stream_async(user_message)

            # Drop only the entries whose placeholder was actually corrected
            # this turn — they won't recur. Entries that were NOT corrected
            # (unresolved, or a reconcile that raised) are kept so a later turn
            # can retry; pruning them would strand the persisted placeholder
            # forever. (Genuinely-abandoned entries are bounded by the size cap
            # applied at emission.)
            if wire_to_native and corrected_native_ids:
                remaining = {
                    wire: native
                    for wire, native in wire_to_native.items()
                    if native not in corrected_native_ids
                }
                if len(remaining) != len(wire_to_native):
                    strands_agent.state.set(AG_UI_WIRE_MAP_STATE_KEY, remaining)

            try:
                async for event in agent_stream:
                    # If we've halted, consume remaining events silently to allow proper cleanup
                    if halt_event_stream:
                        continue

                    logger.debug(f"Received event: {event}")

                    # Skip lifecycle events
                    if event.get("init_event_loop") or event.get("start_event_loop"):
                        continue
                    if event.get("complete") or event.get("force_stop"):
                        logger.debug(
                            f"Breaking event stream: received complete or force_stop event (thread_id={input_data.thread_id}, complete={event.get('complete')}, force_stop={event.get('force_stop')})"
                        )
                        # Generator will end naturally, no need to break
                        break

                    # Handle text streaming
                    if "data" in event and event["data"]:
                        if stop_text_streaming:
                            continue

                        if not message_started:
                            yield TextMessageStartEvent(
                                type=EventType.TEXT_MESSAGE_START,
                                message_id=message_id,
                                role="assistant",
                            )
                            message_started = True
                            last_emitted_text_message_id = message_id

                        text_chunk = str(event["data"])
                        accumulated_text += text_chunk
                        yield TextMessageContentEvent(
                            type=EventType.TEXT_MESSAGE_CONTENT,
                            message_id=message_id,
                            delta=text_chunk,
                        )

                    # Handle reasoning/thinking text streaming
                    elif "reasoningText" in event and event.get("reasoning"):
                        reasoning_text = event["reasoningText"]

                        if not reasoning_started:
                            reasoning_message_id = str(uuid.uuid4())

                            # Emit reasoning events
                            yield ReasoningStartEvent(
                                type=EventType.REASONING_START,
                                message_id=reasoning_message_id
                            )
                            yield ReasoningMessageStartEvent(
                                type=EventType.REASONING_MESSAGE_START,
                                message_id=reasoning_message_id,
                                role="reasoning"
                            )
                            reasoning_started = True

                        # Stream reasoning content
                        if reasoning_text:
                            yield ReasoningMessageContentEvent(
                                type=EventType.REASONING_MESSAGE_CONTENT,
                                message_id=reasoning_message_id,
                                delta=reasoning_text
                            )

                    # Handle encrypted/redacted reasoning content
                    elif "reasoningRedactedContent" in event and event.get("reasoning"):
                        redacted_content = event["reasoningRedactedContent"]

                        if redacted_content is None:
                            logger.debug(f"Ignoring reasoning event with None redacted content (thread_id={input_data.thread_id})")
                            continue

                        if not reasoning_started:
                            reasoning_message_id = str(uuid.uuid4())
                            yield ReasoningStartEvent(
                                type=EventType.REASONING_START,
                                message_id=reasoning_message_id
                            )
                            yield ReasoningMessageStartEvent(
                                type=EventType.REASONING_MESSAGE_START,
                                message_id=reasoning_message_id,
                                role="reasoning"
                            )
                            reasoning_started = True

                        # Encode bytes to base64 string for transport
                        if isinstance(redacted_content, bytes):
                            encrypted_value = base64.b64encode(redacted_content).decode()
                        elif isinstance(redacted_content, str):
                            encrypted_value = redacted_content
                        else:
                            logger.warning(f"Unexpected type for reasoningRedactedContent: {type(redacted_content)}, converting to str")
                            encrypted_value = str(redacted_content)

                        yield ReasoningEncryptedValueEvent(
                            type=EventType.REASONING_ENCRYPTED_VALUE,
                            subtype="message",
                            entity_id=reasoning_message_id,
                            encrypted_value=encrypted_value
                        )

                    # Handle reasoning signature (verification token) - typically not exposed to UI
                    elif "reasoning_signature" in event and event.get("reasoning"):
                        sig = event.get("reasoning_signature", "")
                        logger.debug(f"Received reasoning signature: {str(sig)[:20]}...")

                    # Handle multi-agent node start (maps to STEP_STARTED)
                    elif isinstance(event, dict) and event.get("type") == "multiagent_node_start":
                        node_id = event.get("node_id", "unknown")
                        node_type = event.get("node_type", "agent")
                        yield StepStartedEvent(
                            type=EventType.STEP_STARTED,
                            step_name=f"{node_type}:{node_id}"
                        )

                    # Handle multi-agent node stop (maps to STEP_FINISHED)
                    elif isinstance(event, dict) and event.get("type") == "multiagent_node_stop":
                        node_id = event.get("node_id", "unknown")
                        node_type = event.get("node_type", "agent")
                        yield StepFinishedEvent(
                            type=EventType.STEP_FINISHED,
                            step_name=f"{node_type}:{node_id}"
                        )

                    # Handle multi-agent handoff (emit as CUSTOM event)
                    elif isinstance(event, dict) and event.get("type") == "multiagent_handoff":
                        yield CustomEvent(
                            type=EventType.CUSTOM,
                            name="MultiAgentHandoff",
                            value={
                                "from_nodes": event.get("from_node_ids", []),
                                "to_nodes": event.get("to_node_ids", []),
                                "message": event.get("message")
                            }
                        )

                    # Handle tool streaming events for real-time state updates
                    # Strands tools can yield intermediate results as tool_stream_event
                    elif "tool_stream_event" in event:
                        tool_stream = event["tool_stream_event"]
                        stream_data = tool_stream.get("data", {})

                        # Emit state snapshot if tool yielded state
                        if isinstance(stream_data, dict) and "state" in stream_data:
                            yield StateSnapshotEvent(
                                type=EventType.STATE_SNAPSHOT,
                                snapshot=stream_data["state"],
                            )
                        # A2UI sub-agent streaming: re-emit the
                        # generate_a2ui tool's inner render_a2ui progress as
                        # synthetic TOOL_CALL events. The a2ui middleware's
                        # streaming path keys its "building" skeleton +
                        # progressive paint off these — without them the
                        # surface only paints in bulk from the final result.
                        elif (
                            isinstance(stream_data, dict)
                            and isinstance(stream_data.get(A2UI_STREAM_KEY), dict)
                        ):
                            a2ui_ev = stream_data[A2UI_STREAM_KEY]
                            kind = a2ui_ev.get("kind")
                            a2ui_call_id = a2ui_ev.get("tool_call_id", "")
                            if kind == "start":
                                yield ToolCallStartEvent(
                                    type=EventType.TOOL_CALL_START,
                                    tool_call_id=a2ui_call_id,
                                    tool_call_name=a2ui_ev.get(
                                        "tool_call_name", "render_a2ui"
                                    ),
                                )
                            elif kind == "args" and a2ui_ev.get("delta"):
                                yield ToolCallArgsEvent(
                                    type=EventType.TOOL_CALL_ARGS,
                                    tool_call_id=a2ui_call_id,
                                    delta=a2ui_ev["delta"],
                                )
                            elif kind == "end":
                                yield ToolCallEndEvent(
                                    type=EventType.TOOL_CALL_END,
                                    tool_call_id=a2ui_call_id,
                                )

                    # Handle tool results from Strands for backend tool rendering
                    elif "message" in event and event["message"].get("role") == "user":
                        if pending_halt:
                            halt_event_stream = True
                            continue
                        message_content = event["message"].get("content", [])
                        if not message_content or not isinstance(message_content, list):
                            continue

                        for item in message_content:
                            if not isinstance(item, dict) or "toolResult" not in item:
                                continue

                            tool_result = item["toolResult"]
                            result_tool_id = tool_result.get("toolUseId")
                            result_content = tool_result.get("content", [])

                            result_data = None
                            if result_content and isinstance(result_content, list):
                                for content_item in result_content:
                                    if (
                                        isinstance(content_item, dict)
                                        and "text" in content_item
                                    ):
                                        text_content = content_item["text"]
                                        try:
                                            result_data = json.loads(text_content)
                                        except json.JSONDecodeError:
                                            try:
                                                json_text = text_content.replace(
                                                    "'", '"'
                                                )
                                                result_data = json.loads(json_text)
                                            except Exception:
                                                result_data = text_content

                            if not result_tool_id or result_data is None:
                                continue

                            # Direct lookup works for backend tools (keyed by Strands ID).
                            # Frontend tools are keyed by a generated UUID, so we fall back
                            # to scanning by strands_tool_id when the direct lookup misses.
                            call_info = tool_calls_seen.get(result_tool_id, {})
                            if not call_info:
                                for _tid, _data in tool_calls_seen.items():
                                    if _data.get("strands_tool_id") == result_tool_id:
                                        call_info = _data
                                        break
                            tool_name = call_info.get("name")
                            tool_args = call_info.get("args")
                            tool_input = call_info.get("input")
                            behavior = (
                                self.config.tool_behaviors.get(tool_name)
                                if tool_name
                                else None
                            )

                            logger.debug(
                                f"Processing tool result: tool_name={tool_name}, result_tool_id={result_tool_id}, pending_tool_result_ids={pending_tool_result_ids}, thread_id={input_data.thread_id}"
                            )

                            # Skip emitting the placeholder result for forwarded/proxy tools
                            # – the real execution happens on the client side.
                            if tool_name and tool_name in frontend_tool_names:
                                continue

                            # Emit ToolCallResultEvent WITHOUT role field to complete the tool in UI
                            # but prevent it from being added to conversation history.
                            # A fresh message ID is used so CopilotKit creates a proper standalone
                            # ToolMessage and closes the spinner correctly.
                            tool_result_message_id = str(uuid.uuid4())
                            tool_result_content = json.dumps(result_data)
                            yield ToolCallResultEvent(
                                type=EventType.TOOL_CALL_RESULT,
                                tool_call_id=result_tool_id,
                                message_id=tool_result_message_id,
                                content=tool_result_content,
                                # role is intentionally omitted - without role="tool",
                                # the frontend won't add this to conversation history
                            )

                            # Splice point 3 of 4: append the ToolMessage
                            # carrying the backend tool result to the
                            # running snapshot so the frontend can pair
                            # call + result in the message tree.
                            if (
                                emit_snapshots
                                and not (
                                    behavior
                                    and behavior.skip_messages_snapshot
                                )
                            ):
                                snapshot_messages.append(
                                    ToolMessage(
                                        id=tool_result_message_id,
                                        role="tool",
                                        content=tool_result_content,
                                        tool_call_id=result_tool_id,
                                    )
                                )
                                yield MessagesSnapshotEvent(
                                    type=EventType.MESSAGES_SNAPSHOT,
                                    messages=list(snapshot_messages),
                                )

                            result_context = ToolResultContext(
                                input_data=input_data,
                                tool_name=tool_name or "",
                                tool_use_id=result_tool_id,
                                tool_input=tool_input,
                                args_str=tool_args or "{}",
                                result_data=result_data,
                                message_id=message_id,
                            )

                            if behavior and behavior.state_from_result:
                                try:
                                    snapshot = await maybe_await(
                                        behavior.state_from_result(result_context)
                                    )
                                    if snapshot:
                                        current_state.update(snapshot)
                                        yield StateSnapshotEvent(
                                            type=EventType.STATE_SNAPSHOT,
                                            snapshot=snapshot,
                                        )
                                except Exception as e:
                                    logger.warning(
                                        f"state_from_result failed for {tool_name}: {e}",
                                        exc_info=True,
                                    )

                            if behavior and behavior.custom_result_handler:
                                try:
                                    async for (
                                        custom_event
                                    ) in behavior.custom_result_handler(result_context):
                                        if custom_event is not None:
                                            yield custom_event
                                except Exception as e:
                                    logger.warning(
                                        f"custom_result_handler failed for {tool_name}: {e}",
                                        exc_info=True,
                                    )

                            if behavior and behavior.stop_streaming_after_result:
                                stop_text_streaming = True
                                if message_started:
                                    yield TextMessageEndEvent(
                                        type=EventType.TEXT_MESSAGE_END,
                                        message_id=message_id,
                                    )
                                    message_started = False
                                    # Splice point 4 of 4 (early-exit
                                    # variant): commit any accumulated
                                    # assistant text into the snapshot.
                                    if (
                                        emit_snapshots
                                        and accumulated_text
                                    ):
                                        snapshot_messages.append(
                                            AssistantMessage(
                                                id=message_id,
                                                role="assistant",
                                                content=accumulated_text,
                                            )
                                        )
                                        accumulated_text = ""
                                        yield MessagesSnapshotEvent(
                                            type=EventType.MESSAGES_SNAPSHOT,
                                            messages=list(snapshot_messages),
                                        )
                                halt_event_stream = True
                                logger.debug(
                                    f"Breaking event stream: stop_streaming_after_result behavior triggered (thread_id={input_data.thread_id}, tool_name={tool_name})"
                                )
                                # Break inner loop — no further results should be emitted
                                break

                    # Handle tool calls
                    elif "current_tool_use" in event and event["current_tool_use"]:
                        tool_use = event["current_tool_use"]
                        tool_name = tool_use.get("name")
                        strands_tool_id = tool_use.get("toolUseId")
                        _raw_in = tool_use.get("input", "")

                        # Generate unique ID for frontend tools (to avoid ID conflicts across requests)
                        # Use Strands' ID for backend tools (so result lookup works)
                        is_frontend_tool = tool_name in frontend_tool_names

                        # Check if we've already seen this tool (by Strands' internal ID)
                        existing_entry = None
                        for tid, data in tool_calls_seen.items():
                            if data.get("strands_tool_id") == strands_tool_id:
                                existing_entry = tid
                                break

                        if existing_entry:
                            # Reuse the existing ID
                            tool_use_id = existing_entry
                        elif is_frontend_tool:
                            # Generate new UUID for frontend tools
                            tool_use_id = str(uuid.uuid4())
                            # Record wire id -> Strands native id on the agent's
                            # SESSION STATE so a later continuation run — even on
                            # a different process — can reconcile the persisted
                            # placeholder (keyed by the native id) with the real
                            # client result (which arrives keyed by the wire id).
                            # Strands persists agent state durably at end of run.
                            # Only maintained when a session manager is actually
                            # active for this agent (matching the continuation
                            # read/prune gate); otherwise it would never be read.
                            if strands_tool_id and _get_strands_session_manager(
                                strands_agent
                            ):
                                _wire_map = dict(
                                    strands_agent.state.get(AG_UI_WIRE_MAP_STATE_KEY)
                                    or {}
                                )
                                _wire_map[tool_use_id] = strands_tool_id
                                # Bound growth: entries for frontend calls that
                                # never get a client result (abandoned/dismissed
                                # HITL) are never consumed/pruned. Keep only the
                                # most-recent ``_WIRE_MAP_MAX`` (insertion order).
                                if len(_wire_map) > _WIRE_MAP_MAX:
                                    for _stale in list(_wire_map)[
                                        : len(_wire_map) - _WIRE_MAP_MAX
                                    ]:
                                        _wire_map.pop(_stale, None)
                                strands_agent.state.set(
                                    AG_UI_WIRE_MAP_STATE_KEY, _wire_map
                                )
                        else:
                            # Use Strands' ID for backend tools
                            tool_use_id = strands_tool_id or str(uuid.uuid4())

                        logger.debug(
                            f"Tool call event received: tool_name={tool_name}, tool_use_id={tool_use_id}, strands_id={strands_tool_id}, is_frontend={is_frontend_tool}, already_seen={tool_use_id in tool_calls_seen}, thread_id={input_data.thread_id}"
                        )

                        # Update tool input as it streams in
                        tool_input_raw = tool_use.get("input", "")

                        # Raw string form is what FE incrementally parses for
                        # predict_state. Use it as-is for delta computation so
                        # the wire stream matches what the LLM actually emitted.
                        raw_str = (
                            tool_input_raw
                            if isinstance(tool_input_raw, str)
                            else json.dumps(tool_input_raw, default=str)
                        )

                        # Try to parse as JSON if it looks complete
                        tool_input = {}
                        if isinstance(tool_input_raw, str) and tool_input_raw:
                            try:
                                tool_input = json.loads(tool_input_raw)
                            except json.JSONDecodeError:
                                # Input is still streaming, keep as string
                                tool_input = tool_input_raw
                        elif isinstance(tool_input_raw, dict):
                            tool_input = tool_input_raw

                        args_str = (
                            json.dumps(tool_input)
                            if isinstance(tool_input, dict)
                            else str(tool_input)
                        )

                        # Track or update tool call as input streams in
                        is_new_tool_call = (
                            tool_name and tool_use_id not in tool_calls_seen
                        )
                        if is_new_tool_call:
                            is_pending_now = tool_use_id in pending_tool_result_ids
                            behavior_now = self.config.tool_behaviors.get(tool_name)
                            # Use the streaming path (emit ToolCallStart +
                            # PredictState now, ToolCallArgs on each growth,
                            # ToolCallEnd at contentBlockStop) unless the tool
                            # is a continuation (already-resolved) or supplies
                            # a custom args_streamer that wants to drive args
                            # emission itself at contentBlockStop.
                            use_streaming = not is_pending_now and not (
                                behavior_now and behavior_now.args_streamer
                            )
                            tool_calls_seen[tool_use_id] = {
                                "name": tool_name,
                                "args": args_str,
                                "input": tool_input,
                                "raw": raw_str,
                                "emitted": False,  # legacy flag (still used by contentBlockStop scan)
                                "start_emitted": False,
                                "end_emitted": False,
                                "last_emitted_raw_len": 0,
                                "is_pending": is_pending_now,
                                "is_frontend": is_frontend_tool,
                                "use_streaming": use_streaming,
                                "strands_tool_id": strands_tool_id,
                            }

                            if use_streaming:
                                # Close any open assistant text turn so the
                                # snapshot order matches the wire-event order
                                # and so message_id can rotate cleanly.
                                if message_started:
                                    yield TextMessageEndEvent(
                                        type=EventType.TEXT_MESSAGE_END,
                                        message_id=message_id,
                                    )
                                    if (
                                        emit_snapshots
                                        and accumulated_text
                                    ):
                                        snapshot_messages.append(
                                            AssistantMessage(
                                                id=message_id,
                                                role="assistant",
                                                content=accumulated_text,
                                            )
                                        )
                                        accumulated_text = ""
                                        yield MessagesSnapshotEvent(
                                            type=EventType.MESSAGES_SNAPSHOT,
                                            messages=list(snapshot_messages),
                                        )
                                    message_started = False
                                    message_id = str(uuid.uuid4())

                                # PredictState mapping must reach the FE BEFORE
                                # any args delta so the FE knows which tool
                                # argument feeds which state key while parsing
                                # incremental JSON.
                                if behavior_now:
                                    predict_state_payload = [
                                        mapping.to_payload()
                                        for mapping in normalize_predict_state(
                                            behavior_now.predict_state
                                        )
                                    ]
                                    if predict_state_payload:
                                        yield CustomEvent(
                                            type=EventType.CUSTOM,
                                            name="PredictState",
                                            value=predict_state_payload,
                                        )

                                # Must mirror the later tool snapshot emission condition.
                                tool_parent_message_id = (
                                    message_id
                                    if self._will_emit_tool_snapshot(behavior_now, emit_snapshots)
                                    else last_emitted_text_message_id
                                )
                                yield ToolCallStartEvent(
                                    type=EventType.TOOL_CALL_START,
                                    tool_call_id=tool_use_id,
                                    tool_call_name=tool_name,
                                    parent_message_id=tool_parent_message_id,
                                )
                                tool_calls_seen[tool_use_id]["start_emitted"] = True
                        elif tool_name and tool_use_id in tool_calls_seen:
                            # Update the input and args as they stream in
                            tool_calls_seen[tool_use_id]["input"] = tool_input
                            tool_calls_seen[tool_use_id]["args"] = args_str
                            tool_calls_seen[tool_use_id]["raw"] = raw_str

                        # Stream incremental ToolCallArgs deltas as the LLM
                        # produces more characters of the JSON args. The FE
                        # uses these to drive predictive state updates per the
                        # PredictState mapping that was just emitted.
                        entry = tool_calls_seen.get(tool_use_id)
                        if (
                            entry
                            and entry.get("start_emitted")
                            and entry.get("use_streaming")
                        ):
                            new_len = len(raw_str)
                            last_len = entry.get("last_emitted_raw_len", 0)
                            if new_len > last_len:
                                yield ToolCallArgsEvent(
                                    type=EventType.TOOL_CALL_ARGS,
                                    tool_call_id=tool_use_id,
                                    delta=raw_str[last_len:new_len],
                                )
                                entry["last_emitted_raw_len"] = new_len

                    # Handle content block stop - this signals tool input is complete
                    elif "event" in event and isinstance(event.get("event"), dict):
                        inner_event = event["event"]
                        if "contentBlockStop" in inner_event:
                            # Close reasoning events if active
                            if reasoning_started:
                                yield ReasoningMessageEndEvent(
                                    type=EventType.REASONING_MESSAGE_END,
                                    message_id=reasoning_message_id
                                )
                                yield ReasoningEndEvent(
                                    type=EventType.REASONING_END,
                                    message_id=reasoning_message_id
                                )
                                reasoning_started = False
                                reasoning_message_id = None

                            # Find the most recent tool call that hasn't been emitted yet
                            tool_name = None
                            tool_input = None
                            args_str = None
                            tool_use_id = None

                            for tid, tool_data in tool_calls_seen.items():
                                if not tool_data.get("emitted", True):
                                    tool_name = tool_data["name"]
                                    tool_input = tool_data["input"]
                                    args_str = tool_data["args"]
                                    tool_use_id = tid
                                    break  # Process one tool at a time

                            # Only process if we found a tool to emit
                            if tool_name and tool_use_id:
                                entry = tool_calls_seen[tool_use_id]
                                # Mark as emitted (legacy compat)
                                entry["emitted"] = True
                                entry["end_emitted"] = True

                                is_frontend_tool = entry.get("is_frontend", tool_name in frontend_tool_names)
                                behavior = self.config.tool_behaviors.get(tool_name)
                                is_pending = entry.get("is_pending", tool_use_id in pending_tool_result_ids)
                                use_streaming = entry.get("use_streaming", False)

                                logger.debug(
                                    f"contentBlockStop close: tool_name={tool_name}, tool_use_id={tool_use_id}, is_frontend_tool={is_frontend_tool}, is_pending={is_pending}, use_streaming={use_streaming}, thread_id={input_data.thread_id}"
                                )
                                call_context = ToolCallContext(
                                    input_data=input_data,
                                    tool_name=tool_name,
                                    tool_use_id=tool_use_id,
                                    tool_input=tool_input,
                                    args_str=args_str,
                                )

                                if use_streaming:
                                    # Streaming path: ToolCallStart, PredictState
                                    # and the args deltas have already been
                                    # emitted from the current_tool_use handler.
                                    # Flush any final delta the LLM tacked on
                                    # between the last current_tool_use update
                                    # and contentBlockStop, then close the call.
                                    raw_str = entry.get("raw", "") or ""
                                    last_len = entry.get("last_emitted_raw_len", 0)
                                    if len(raw_str) > last_len:
                                        yield ToolCallArgsEvent(
                                            type=EventType.TOOL_CALL_ARGS,
                                            tool_call_id=tool_use_id,
                                            delta=raw_str[last_len:],
                                        )
                                        entry["last_emitted_raw_len"] = len(raw_str)

                                    # Emit ``state_from_args`` BEFORE
                                    # ``ToolCallEnd``. CopilotKit v2 releases
                                    # the predict_state buffer at ToolCallEnd;
                                    # if the authoritative StateSnapshot lands
                                    # after that, the FE momentarily reverts
                                    # to the last server-confirmed state and
                                    # re-applies, producing a "re-stream"
                                    # animation. Delivering the snapshot first
                                    # means the FE has the real state in hand
                                    # at the moment prediction is released.
                                    if behavior and behavior.state_from_args:
                                        try:
                                            snapshot = await maybe_await(
                                                behavior.state_from_args(call_context)
                                            )
                                            if snapshot:
                                                current_state.update(snapshot)
                                                yield StateSnapshotEvent(
                                                    type=EventType.STATE_SNAPSHOT,
                                                    snapshot=snapshot,
                                                )
                                        except Exception as e:
                                            logger.warning(
                                                f"state_from_args failed for {tool_name}: {e}",
                                                exc_info=True,
                                            )

                                    yield ToolCallEndEvent(
                                        type=EventType.TOOL_CALL_END,
                                        tool_call_id=tool_use_id,
                                    )

                                    if self._will_emit_tool_snapshot(behavior, emit_snapshots):
                                        snapshot_messages.append(
                                            AssistantMessage(
                                                id=message_id,
                                                role="assistant",
                                                content="",
                                                tool_calls=[
                                                    ToolCall(
                                                        id=tool_use_id,
                                                        type="function",
                                                        function=FunctionCall(
                                                            name=tool_name or "unknown",
                                                            arguments=args_str or "{}",
                                                        ),
                                                    )
                                                ],
                                            )
                                        )
                                        yield MessagesSnapshotEvent(
                                            type=EventType.MESSAGES_SNAPSHOT,
                                            messages=list(snapshot_messages),
                                        )
                                        # Rotate so the next assistant message
                                        # in the snapshot (text or another
                                        # tool call) carries a distinct id —
                                        # CopilotKit v2 dedupes by id.
                                        message_id = str(uuid.uuid4())

                                    if is_frontend_tool and not (
                                        behavior
                                        and behavior.continue_after_frontend_call
                                    ):
                                        logger.debug(
                                            f"Deferring halt after frontend tool call: tool_name={tool_name}, tool_call_id={tool_use_id}, thread_id={input_data.thread_id}"
                                        )
                                        pending_halt = True
                                elif is_pending:
                                    # Continuation turn — tool already resolved
                                    # in conversation history. Don't re-emit any
                                    # wire events but still let state callbacks
                                    # fire so derived state stays consistent.
                                    if behavior and behavior.state_from_args:
                                        try:
                                            snapshot = await maybe_await(
                                                behavior.state_from_args(call_context)
                                            )
                                            if snapshot:
                                                current_state.update(snapshot)
                                                yield StateSnapshotEvent(
                                                    type=EventType.STATE_SNAPSHOT,
                                                    snapshot=snapshot,
                                                )
                                        except Exception as e:
                                            logger.warning(
                                                f"state_from_args failed for {tool_name}: {e}",
                                                exc_info=True,
                                            )
                                else:
                                    # Legacy path: behavior.args_streamer is
                                    # configured. Emit the full burst at
                                    # contentBlockStop using the custom
                                    # streamer so existing args_streamer
                                    # consumers keep working.
                                    if behavior and behavior.state_from_args:
                                        try:
                                            snapshot = await maybe_await(
                                                behavior.state_from_args(call_context)
                                            )
                                            if snapshot:
                                                current_state.update(snapshot)
                                                yield StateSnapshotEvent(
                                                    type=EventType.STATE_SNAPSHOT,
                                                    snapshot=snapshot,
                                                )
                                        except Exception as e:
                                            logger.warning(
                                                f"state_from_args failed for {tool_name}: {e}",
                                                exc_info=True,
                                            )

                                    if behavior:
                                        predict_state_payload = [
                                            mapping.to_payload()
                                            for mapping in normalize_predict_state(
                                                behavior.predict_state
                                            )
                                        ]
                                        if predict_state_payload:
                                            yield CustomEvent(
                                                type=EventType.CUSTOM,
                                                name="PredictState",
                                                value=predict_state_payload,
                                            )

                                    if message_started:
                                        yield TextMessageEndEvent(
                                            type=EventType.TEXT_MESSAGE_END, message_id=message_id
                                        )
                                        if (
                                            emit_snapshots
                                            and accumulated_text
                                        ):
                                            snapshot_messages.append(
                                                AssistantMessage(
                                                    id=message_id,
                                                    role="assistant",
                                                    content=accumulated_text,
                                                )
                                            )
                                            accumulated_text = ""
                                            yield MessagesSnapshotEvent(
                                                type=EventType.MESSAGES_SNAPSHOT,
                                                messages=list(snapshot_messages),
                                            )
                                        message_started = False
                                        message_id = str(uuid.uuid4())

                                    # Must mirror the later tool snapshot emission condition.
                                    tool_parent_message_id = (
                                        message_id
                                        if self._will_emit_tool_snapshot(behavior, emit_snapshots)
                                        else last_emitted_text_message_id
                                    )
                                    yield ToolCallStartEvent(
                                        type=EventType.TOOL_CALL_START,
                                        tool_call_id=tool_use_id,
                                        tool_call_name=tool_name,
                                        parent_message_id=tool_parent_message_id,
                                    )

                                    try:
                                        async for chunk in behavior.args_streamer(
                                            call_context
                                        ):
                                            if chunk is None:
                                                continue
                                            yield ToolCallArgsEvent(
                                                type=EventType.TOOL_CALL_ARGS,
                                                tool_call_id=tool_use_id,
                                                delta=str(chunk),
                                            )
                                    except Exception as e:
                                        logger.warning(
                                            f"args_streamer failed for {tool_name}, falling back to full args: {e}"
                                        )
                                        yield ToolCallArgsEvent(
                                            type=EventType.TOOL_CALL_ARGS,
                                            tool_call_id=tool_use_id,
                                            delta=args_str,
                                        )

                                    yield ToolCallEndEvent(
                                        type=EventType.TOOL_CALL_END,
                                        tool_call_id=tool_use_id,
                                    )

                                    if self._will_emit_tool_snapshot(behavior, emit_snapshots):
                                        snapshot_messages.append(
                                            AssistantMessage(
                                                id=message_id,
                                                role="assistant",
                                                content="",
                                                tool_calls=[
                                                    ToolCall(
                                                        id=tool_use_id,
                                                        type="function",
                                                        function=FunctionCall(
                                                            name=tool_name or "unknown",
                                                            arguments=args_str or "{}",
                                                        ),
                                                    )
                                                ],
                                            )
                                        )
                                        yield MessagesSnapshotEvent(
                                            type=EventType.MESSAGES_SNAPSHOT,
                                            messages=list(snapshot_messages),
                                        )
                                        message_id = str(uuid.uuid4())

                                    if is_frontend_tool and not (
                                        behavior
                                        and behavior.continue_after_frontend_call
                                    ):
                                        logger.debug(
                                            f"Deferring halt after frontend tool call: tool_name={tool_name}, tool_call_id={tool_use_id}, thread_id={input_data.thread_id}"
                                        )
                                        pending_halt = True
            finally:
                # Properly close the async generator to avoid context detachment errors
                # The generator should complete naturally when we consume all events,
                # but we still try to close it explicitly to be safe
                try:
                    # Check if generator is already closed/exhausted
                    if not agent_stream.ag_running:
                        # Generator is already closed, nothing to do
                        pass
                    else:
                        # Try to close gracefully, but suppress context-related errors
                        await agent_stream.aclose()
                except (
                    GeneratorExit,
                    ValueError,
                    RuntimeError,
                    StopAsyncIteration,
                ) as e:
                    # Suppress context detachment errors - they occur when the generator
                    # is closed in a different context, but don't affect functionality
                    # These errors are logged by Strands internally, we just prevent them from propagating
                    pass
                except AttributeError:
                    # Generator doesn't have ag_running attribute (older Python versions)
                    # Just try to close it
                    try:
                        await agent_stream.aclose()
                    except (
                        GeneratorExit,
                        ValueError,
                        RuntimeError,
                        StopAsyncIteration,
                    ):
                        pass
                except Exception as e:
                    # Log other errors but don't fail
                    logger.warning(f"Error closing agent stream: {e}")

            # Close reasoning if still open
            if reasoning_started:
                yield ReasoningMessageEndEvent(
                    type=EventType.REASONING_MESSAGE_END,
                    message_id=reasoning_message_id
                )
                yield ReasoningEndEvent(
                    type=EventType.REASONING_END,
                    message_id=reasoning_message_id
                )

            # End message if started
            if message_started:
                yield TextMessageEndEvent(
                    type=EventType.TEXT_MESSAGE_END, message_id=message_id
                )
                # Splice point 4 of 4 (terminal): commit the final
                # assistant text turn into the snapshot so the frontend
                # has the closing message in canonical history.
                if emit_snapshots and accumulated_text:
                    snapshot_messages.append(
                        AssistantMessage(
                            id=message_id,
                            role="assistant",
                            content=accumulated_text,
                        )
                    )
                    accumulated_text = ""
                    yield MessagesSnapshotEvent(
                        type=EventType.MESSAGES_SNAPSHOT,
                        messages=list(snapshot_messages),
                    )

            # Final state snapshot before finishing
            yield StateSnapshotEvent(
                type=EventType.STATE_SNAPSHOT,
                snapshot=current_state,
            )

            # Always finish the run - frontend handles keeping action executing
            yield RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
            )

        except Exception as e:
            import traceback

            traceback.print_exc()
            yield RunErrorEvent(
                type=EventType.RUN_ERROR, message=str(e), code="STRANDS_ERROR"
            )
