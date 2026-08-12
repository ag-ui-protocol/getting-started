"""A2UI subagent tool for CrewAI flows.

Thin adapter over ``ag-ui-a2ui-toolkit`` - the recovery loop, validation, op
builders, prompt assembly and output envelope all live in the toolkit. This
module owns only the CrewAI-specific glue (mirrors the AWS Strands adapter's
``a2ui_tool.py``):

  - ``get_a2ui_tools(params, glue=None)`` - builds an ``A2UITool`` a flow node
    runs. The tool drives the toolkit's validate->retry recovery loop, calling a
    forced-``render_a2ui`` sub-agent (a second litellm completion) and streaming
    its render progress to the wire as it goes.
  - ``plan_a2ui_injection(...)`` - the pure per-run auto-inject decision: reads
    the ``injectA2UITool`` runtime flag (surfaced under ``state["ag-ui"]`` by the
    endpoint), resolves the frontend catalog, and returns the tool to register
    (+ the injected render tool to drop) - or ``None``.
  - ``apply_a2ui_plan_to_tools(actions, plan)`` - swaps a plan into a flow's
    tool list (drop the injected render proxy, add ``generate_a2ui``).

Streaming: the sub-agent's forced ``render_a2ui`` call streams to the AG-UI wire
as ``TOOL_CALL_CHUNK`` events (the CrewAI bridge's native tool-call shape) - the
client normalizes these into the ``TOOL_CALL_START`` / ``TOOL_CALL_ARGS`` the
a2ui middleware keys its "building" skeleton and progressive paint off. The
toolkit recovery loop is synchronous, so it runs in a worker thread; sub-agent
stream events are pushed onto an asyncio queue and re-emitted from the calling
flow node's event loop (where ``flow_context`` is set) as bridged tool-call
chunks.
"""

from __future__ import annotations

import asyncio
import contextvars
from collections.abc import Mapping
import json
import logging
import threading
import uuid
from typing import Any, Callable, Optional

from litellm import acompletion

from ag_ui.core import EventType
from ag_ui_a2ui_toolkit import (
    A2UI_OPERATIONS_KEY,
    A2UIGuidelines,
    A2UIToolParams,
    BASIC_CATALOG_ID,
    GENERATE_A2UI_ARG_DESCRIPTIONS,
    GENERATE_A2UI_TOOL_NAME,
    RENDER_A2UI_TOOL_DEF,
    build_a2ui_envelope,
    prepare_a2ui_request,
    resolve_a2ui_catalog,
    resolve_a2ui_tool_params,
    run_a2ui_generation_with_recovery,
    wrap_error_envelope,
)

from ._capabilities import crewai_event_bus
from .context import flow_context
from .events import BridgedToolCallChunkEvent, BridgedToolCallResultEvent
from .utils import yield_control

# Re-export the toolkit constants/types callers type their params bag against,
# alongside the CrewAI-specific auto-injection surface - keeps the public
# surface aligned with the LangGraph / Strands adapters.
__all__ = [
    "get_a2ui_tools",
    "plan_a2ui_injection",
    "apply_a2ui_plan_to_tools",
    "is_auto_injected_a2ui_tool",
    "A2UITool",
    "A2UI_STREAM_KEY",
    "A2UI_OPERATIONS_KEY",
    "A2UIToolParams",
    "A2UIGuidelines",
    "BASIC_CATALOG_ID",
]

logger = logging.getLogger("ag_ui_crewai")

#: Name of the render tool the A2UI middleware injects (and we drop).
RENDER_A2UI_TOOL_NAME: str = RENDER_A2UI_TOOL_DEF["function"]["name"]

#: Stream-key constant kept for public-surface parity with the Strands adapter,
#: which wraps its sub-agent render payloads under this key for a separate
#: translation step. The CrewAI adapter consumes the payloads inline in
#: ``A2UITool.run`` (they carry ``kind`` / ``tool_call_id`` / ``delta``), so this
#: key is exported for API alignment but does not tag the payloads here.
A2UI_STREAM_KEY = "__a2uiRenderStream"

#: Attribute flag marking an ``A2UITool`` this adapter auto-injected.
_A2UI_AUTOINJECT_ATTR = "_a2ui_auto_injected"


def _log_abandoned_recovery_result(future: "asyncio.Future") -> None:
    """Consume the recovery future's outcome after the caller abandons the run
    so a rethrown sub-agent error isn't dropped as "never retrieved"."""
    try:
        exc = future.exception()
    except asyncio.CancelledError:
        return
    if exc is None or isinstance(exc, asyncio.CancelledError):
        return
    logger.warning(
        "A2UI recovery loop failed after the consumer disconnected: %s",
        exc,
        exc_info=exc,
    )


# ---------------------------------------------------------------------------
# Sub-agent error classification
# ---------------------------------------------------------------------------


def classify_a2ui_subagent_error(err: BaseException, aborted: bool) -> str:
    """Classify a sub-agent invoke error. ``"rethrow"`` must unwind the tool
    call - no recovery retries:

    - cancellation - retrying defeats the cancel and burns more tokens;
    - programmer errors (TypeError/NameError = adapter bugs) - surface loudly.

    ``"recoverable"`` is a genuine model/network error the recovery loop records
    as a failed attempt (retry or tasteful hard-failure).
    """
    if aborted or isinstance(err, asyncio.CancelledError):
        return "rethrow"
    if isinstance(err, (TypeError, NameError)):
        return "rethrow"
    # SystemExit / KeyboardInterrupt and friends signal shutdown.
    if not isinstance(err, Exception):
        return "rethrow"
    return "recoverable"


# ---------------------------------------------------------------------------
# Message-shape helpers (litellm / OpenAI chat message dicts)
# ---------------------------------------------------------------------------


def _to_message_dict(message: Any) -> dict:
    """Coerce a litellm ``Message`` (or already-dict) into a plain dict."""
    if isinstance(message, dict):
        return message
    dump = getattr(message, "model_dump", None)
    if callable(dump):
        return dump()
    return {}


def _normalize_messages(messages: Optional[list]) -> list[dict]:
    """Normalize a flow's ``state["messages"]`` (mixed litellm objects + dicts)
    into plain dicts so the sub-agent completion and the prior-surface walker
    see a uniform shape."""
    return [_to_message_dict(m) for m in (messages or [])]


def _message_tool_call_names(message: dict) -> list[str]:
    calls = message.get("tool_calls")
    if not isinstance(calls, list):
        return []
    names: list[str] = []
    for call in calls:
        if isinstance(call, dict):
            fn = call.get("function")
            if isinstance(fn, dict) and isinstance(fn.get("name"), str):
                names.append(fn["name"])
    return names


def strip_in_flight_tool_call(messages: list[dict], tool_name: str) -> list[dict]:
    """Drop a trailing in-flight ``tool_name`` assistant call. When the model
    invokes the generate tool, the assistant turn carrying that call is the last
    message with no matching tool result yet - passing it to the sub-agent
    (which lacks the tool) is malformed. Only strips when the LAST message is
    that call, so a normal user turn at the tail is preserved."""
    if messages:
        last = messages[-1]
        if (
            isinstance(last, dict)
            and last.get("role") == "assistant"
            and tool_name in _message_tool_call_names(last)
        ):
            return list(messages[:-1])
    return list(messages)


# ---------------------------------------------------------------------------
# Model resolution
# ---------------------------------------------------------------------------

# Connection fields lifted off a model object (e.g. a crewai ``LLM``) so a
# resolved model's endpoint/credentials reach the sub-agent completion.
_MODEL_CONNECTION_ATTRS = ("api_key", "base_url", "api_base", "api_version")


def _normalize_model(model: Any) -> Optional[dict]:
    """Resolve ``model`` into ``acompletion`` connection kwargs.

    Accepts a litellm model id string, a full kwargs dict, or an object exposing
    a ``.model`` attribute (e.g. a crewai ``LLM`` - its connection fields are
    lifted so a self-hosted / Azure endpoint is honored). Returns ``None`` for
    ``None`` so the caller can enforce the required-model contract.
    """
    if model is None:
        return None
    if isinstance(model, str):
        return {"model": model}
    if isinstance(model, dict):
        return dict(model)
    model_id = getattr(model, "model", None)
    if isinstance(model_id, str) and model_id:
        kwargs: dict = {"model": model_id}
        for attr in _MODEL_CONNECTION_ATTRS:
            value = getattr(model, attr, None)
            if value is not None and value != [] and value != {}:
                kwargs[attr] = value
        return kwargs
    raise ValueError(
        "A2UI 'model' must be a litellm model id string, an acompletion kwargs "
        "dict, or an object exposing a '.model' attribute."
    )


# ---------------------------------------------------------------------------
# Sub-agent invocation (streaming)
# ---------------------------------------------------------------------------


def _defer_catalog_comma(text: str, pending: bool) -> tuple[str, bool]:
    """Insert the comma owed after a spliced ``catalogId`` before the model's
    first real content, so the emitted stream stays valid JSON no matter how the
    fragments split.

    Returns ``(text, still_pending)``. While only whitespace has arrived the
    comma keeps waiting; a leading ``}`` means empty args (``{"catalogId":"x"}``,
    no comma); any other content gets the comma prepended once.
    """
    if not pending:
        return text, False
    stripped = text.lstrip()
    if not stripped:
        return text, True
    if stripped[0] == "}":
        return text, False
    lead = text[: len(text) - len(stripped)]
    return lead + ", " + stripped, False


async def _stream_render_subagent(
    model_kwargs: dict,
    prompt: str,
    messages: list[dict],
    push: Callable[[dict], None],
    catalog_id: Optional[str] = None,
) -> Optional[dict]:
    """Run a SINGLE forced ``render_a2ui`` completion and return the captured
    args - or ``None`` if the model produced no call.

    Mirrors the Strands / LangGraph adapters' single forced structured-output
    turn: a lone ``acompletion`` with ``tool_choice`` pinned to ``render_a2ui``.
    The model emits exactly one render call and we stop.

    Streams ``render_a2ui``'s arg fragments (start / args deltas / end) via
    ``push`` so the a2ui middleware paints progressively. ``catalog_id`` is
    spliced into the FIRST emitted fragment (the render schema omits ``catalogId``
    and the host owns the catalog) so the progressive paint binds to the right
    catalog; the splice affects only the EMITTED delta, never the captured args
    (``build_a2ui_envelope`` stamps the id on the committed envelope).
    """
    captured: Optional[dict] = None
    accumulated = ""
    live_call_id: Optional[str] = None
    catalog_prefixed = False
    # Whether a separating comma is still owed after the spliced ``catalogId``.
    # Deferred until the model's first real content arrives (which may be a
    # later fragment) so empty ``{}`` args never emit a trailing comma.
    catalog_pending_comma = False
    fallback_call_id = f"a2ui-render-{uuid.uuid4().hex[:8]}"

    def _finish_call() -> None:
        nonlocal captured
        try:
            captured = json.loads(accumulated) if accumulated.strip() else {}
        except (json.JSONDecodeError, TypeError):
            captured = {}

    response = await acompletion(
        **model_kwargs,
        messages=[{"role": "system", "content": prompt}, *messages],
        tools=[RENDER_A2UI_TOOL_DEF],
        tool_choice={"type": "function", "function": {"name": RENDER_A2UI_TOOL_NAME}},
        parallel_tool_calls=False,
        stream=True,
    )
    try:
        async for chunk in response:
            choices = chunk["choices"]
            # Providers (Azure, or an ``include_usage`` final chunk) can emit a
            # chunk with no choices; skip it rather than IndexError out of the
            # attempt and burn a recovery retry on otherwise-valid output.
            if not choices:
                continue
            choice = choices[0]
            delta = choice["delta"]
            tool_calls = delta["tool_calls"] or None
            if tool_calls:
                call = tool_calls[0]
                if live_call_id is None:
                    live_call_id = getattr(call, "id", None) or fallback_call_id
                    catalog_prefixed = False
                    catalog_pending_comma = False
                    push(
                        {
                            "kind": "start",
                            "tool_call_id": live_call_id,
                            "tool_call_name": RENDER_A2UI_TOOL_NAME,
                        }
                    )
                frag = call.function["arguments"]
                if frag:
                    accumulated += frag
                    emit_frag = frag
                    # Splice the host catalog id into the FIRST chunk (right
                    # after the opening brace) so the streamed args read as
                    # ``{"catalogId": "<id>", ...}`` - valid JSON the middleware
                    # progressive paint reads the id from. The separating comma
                    # is deferred (see catalog_pending_comma) so empty ``{}``
                    # args stay valid even when ``{`` and ``}`` arrive in
                    # separate fragments.
                    if catalog_id and not catalog_prefixed:
                        brace = frag.find("{")
                        if brace != -1:
                            catalog_prefixed = True
                            catalog_pending_comma = True
                            head = (
                                frag[: brace + 1]
                                + f'"catalogId": {json.dumps(catalog_id)}'
                            )
                            tail, catalog_pending_comma = _defer_catalog_comma(
                                frag[brace + 1 :], catalog_pending_comma
                            )
                            emit_frag = head + tail
                    elif catalog_pending_comma:
                        emit_frag, catalog_pending_comma = _defer_catalog_comma(
                            frag, catalog_pending_comma
                        )
                    push(
                        {
                            "kind": "args",
                            "tool_call_id": live_call_id,
                            "delta": emit_frag,
                        }
                    )
            if choice["finish_reason"] is not None:
                break
    except BaseException:
        # The provider stream died mid-call: close the live synthetic call
        # before unwinding so the next recovery attempt does not open a fresh
        # call on top of an unclosed one. Guard the push: on a closed loop
        # (consumer gone) call_soon_threadsafe raises RuntimeError, which would
        # mask the original exception being unwound.
        if live_call_id is not None:
            try:
                push({"kind": "end", "tool_call_id": live_call_id})
            except RuntimeError:
                pass
        raise

    if live_call_id is not None:
        push({"kind": "end", "tool_call_id": live_call_id})
        _finish_call()

    return captured


# ---------------------------------------------------------------------------
# The generate_a2ui tool
# ---------------------------------------------------------------------------


class A2UITool:
    """CrewAI A2UI tool: exposes the ``generate_a2ui`` completion schema and runs
    A2UI surface generation via a sub-agent driving the toolkit recovery loop,
    streaming render progress to the wire as it goes.

    A flow node adds ``tool.schema`` to its ``acompletion`` tools; when the model
    calls ``generate_a2ui``, the node ``await``s ``tool.run(args)`` and appends
    the returned envelope as a ``role="tool"`` message.
    """

    def __init__(self, params: A2UIToolParams, glue: Optional[dict] = None) -> None:
        resolved = resolve_a2ui_tool_params(params)
        self._cfg = dict(resolved)
        self._cfg["model_kwargs"] = _normalize_model(resolved["model"])
        self._glue = glue or {}

    @property
    def tool_name(self) -> str:
        return self._cfg["tool_name"]

    @property
    def schema(self) -> dict:
        """OpenAI/litellm function schema for the outer ``generate_a2ui`` tool."""
        return {
            "type": "function",
            "function": {
                "name": self._cfg["tool_name"],
                "description": self._cfg["tool_description"],
                "parameters": {
                    "type": "object",
                    "properties": {
                        "intent": {
                            "type": "string",
                            "enum": ["create", "update"],
                            "description": GENERATE_A2UI_ARG_DESCRIPTIONS["intent"],
                        },
                        "target_surface_id": {
                            "type": "string",
                            "description": GENERATE_A2UI_ARG_DESCRIPTIONS[
                                "target_surface_id"
                            ],
                        },
                        "changes": {
                            "type": "string",
                            "description": GENERATE_A2UI_ARG_DESCRIPTIONS["changes"],
                        },
                    },
                },
            },
        }

    async def _emit_chunk(self, flow: Any, payload: dict, name_state: dict) -> None:
        """Translate one sub-agent stream payload into a bridged TOOL_CALL_CHUNK.

        ``start`` stashes the render tool name/id; the first following ``args``
        emits it (OpenAI streaming convention: the name rides the opening chunk,
        later chunks carry deltas only); ``end`` needs no wire event on the
        chunk shape (the client closes the call at the next tool call / result).
        """
        kind = payload.get("kind")
        if kind == "start":
            name_state["pending_name"] = payload.get(
                "tool_call_name", RENDER_A2UI_TOOL_NAME
            )
            name_state["call_id"] = payload.get("tool_call_id", "")
            return
        if kind == "args" and payload.get("delta"):
            crewai_event_bus.emit(
                flow,
                BridgedToolCallChunkEvent(
                    type=EventType.TOOL_CALL_CHUNK,
                    tool_call_id=payload.get("tool_call_id")
                    or name_state.get("call_id", ""),
                    tool_call_name=name_state.pop("pending_name", None),
                    delta=payload["delta"],
                ),
            )
            await yield_control()

    def _emit_tool_result(
        self,
        flow: Any,
        tool_call_id: Optional[str],
        envelope: str,
        message_id: Optional[str] = None,
    ) -> None:
        """Emit the TOOL_CALL_RESULT for this generate_a2ui call so the a2ui
        middleware closes the outer call and can commit / hard-fail from the
        envelope. Emitted here (not left to the caller) so a flow that forgets
        cannot leave an exhausted recovery stuck at "building"."""
        if not tool_call_id:
            return
        crewai_event_bus.emit(
            flow,
            BridgedToolCallResultEvent(
                type=EventType.TOOL_CALL_RESULT,
                message_id=message_id or str(uuid.uuid4()),
                tool_call_id=tool_call_id,
                content=envelope,
                role="tool",
            ),
        )

    async def run(
        self,
        args: Optional[dict],
        *,
        tool_call_id: Optional[str] = None,
        result_message_id: Optional[str] = None,
        flow: Any = None,
    ) -> str:
        """Generate (or update) an A2UI surface and return the operations
        envelope (a JSON string a flow node appends as the tool result).

        Pass ``tool_call_id`` (the outer generate_a2ui call id) so this emits its
        own TOOL_CALL_RESULT; the middleware needs it to close the call and, on
        exhaustion, paint the tasteful hard-failure. Streams the sub-agent's
        ``render_a2ui`` progress to the wire; on validation failure the toolkit
        recovery loop retries, each attempt re-streaming render so the middleware
        shows building -> retrying -> paint.

        ``result_message_id`` is the id to stream that result under. Pass the id
        the caller stamps onto the tool message it persists, so the terminal
        MESSAGES_SNAPSHOT updates that message in place; left unset, the streamed
        result and the persisted one carry different ids and the client remounts
        the surface card from the snapshot.
        """
        flow = flow if flow is not None else flow_context.get(None)
        if flow is None:
            logger.warning(
                "A2UITool.run has no flow (call it inside a flow node so "
                "flow_context is set, or pass flow=); render progress and the "
                "tool result will not reach the wire."
            )
        cfg = self._cfg
        args = args if isinstance(args, dict) else {}
        intent = args.get("intent")
        target_surface_id = args.get("target_surface_id")
        changes = args.get("changes")

        messages = strip_in_flight_tool_call(
            _normalize_messages(self._glue.get("messages")), self.tool_name
        )
        # AG-UI history for find_prior_surface (update intent): prior turns'
        # ``role="tool"`` messages carry the a2ui_operations envelopes.
        agui_messages = messages

        glue_state = self._glue.get("state")
        prep = prepare_a2ui_request(
            intent=intent,
            target_surface_id=target_surface_id,
            changes=changes,
            messages=agui_messages,
            state=dict(glue_state) if isinstance(glue_state, Mapping) else {},
            guidelines=cfg["guidelines"],
        )

        if prep.get("error"):
            logger.warning("A2UI request prep failed: %s", prep["error"])
            envelope = wrap_error_envelope(prep["error"])
            self._emit_tool_result(flow, tool_call_id, envelope, result_message_id)
            return envelope

        if cfg["model_kwargs"] is None:
            # get_a2ui_tools enforces this, but guard so a hand-built tool never
            # reaches the sub-agent with no model.
            raise ValueError("A2UITool.run requires a resolved model.")

        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()
        # Set when the caller abandons the run so the sync recovery loop stops
        # before firing further sub-agent completions nobody will drain.
        disconnected = threading.Event()

        def _push(payload: dict) -> None:
            loop.call_soon_threadsafe(queue.put_nowait, payload)

        def _invoke_subagent(prompt: str, attempt: int) -> Optional[dict]:
            if disconnected.is_set() or loop.is_closed():
                raise asyncio.CancelledError(
                    "consumer disconnected; abandoning A2UI recovery"
                )
            try:
                return asyncio.run(
                    _stream_render_subagent(
                        cfg["model_kwargs"],
                        prompt,
                        messages,
                        _push,
                        catalog_id=cfg["default_catalog_id"],
                    )
                )
            except BaseException as err:  # noqa: BLE001 - classified below
                if classify_a2ui_subagent_error(err, False) == "rethrow":
                    raise
                logger.warning(
                    "A2UI sub-agent invoke failed on attempt %d; treating as a "
                    "failed attempt: %s",
                    attempt,
                    err,
                    exc_info=True,
                )
                return None

        def _build_envelope(render_args: dict) -> str:
            return build_a2ui_envelope(
                args=render_args,
                is_update=prep["is_update"],
                target_surface_id=target_surface_id,
                prior=prep.get("prior"),
                default_surface_id=cfg["default_surface_id"],
                default_catalog_id=cfg["default_catalog_id"],
            )

        # Run the recovery on a COPY of the caller's context. ``run_in_executor``
        # does not propagate ``contextvars`` into the worker thread, so without
        # this the request-scoped state the subagent reads (``flow_context`` and
        # the litellm/bus context an ``acompletion`` turn resolves) is ``None``
        # there -- which drops the a2ui-recovery surface. Mirrors the conversational
        # stream worker (``_conversation.SyncStreamSessionAdapter``), which copies
        # the context onto its thread for the same reason.
        recovery_context = contextvars.copy_context()
        future = loop.run_in_executor(
            None,
            lambda: recovery_context.run(
                run_a2ui_generation_with_recovery,
                base_prompt=prep["prompt"],
                catalog=cfg["catalog"],
                config=cfg["recovery"],
                on_attempt=cfg["on_a2ui_attempt"],
                invoke_subagent=_invoke_subagent,
                build_envelope=_build_envelope,
            ),
        )

        name_state: dict = {}
        get_task: Optional[asyncio.Task] = None
        try:
            # Drain until the recovery future is done AND the queue is empty
            # (the same structural guarantee as the TS/Strands adapters' drain).
            while not (future.done() and queue.empty()):
                while not queue.empty():
                    await self._emit_chunk(flow, queue.get_nowait(), name_state)
                if future.done():
                    continue
                get_task = asyncio.ensure_future(queue.get())
                done, _ = await asyncio.wait(
                    {get_task, future}, return_when=asyncio.FIRST_COMPLETED
                )
                if get_task in done:
                    payload = get_task.result()
                    get_task = None
                    await self._emit_chunk(flow, payload, name_state)
                else:
                    get_task.cancel()
                    try:
                        payload = await get_task
                        get_task = None
                        await self._emit_chunk(flow, payload, name_state)
                    except asyncio.CancelledError:
                        get_task = None
                        # ``Task.cancelling()`` is 3.11+; the package floors at
                        # 3.10, so probe via getattr (mirrors the endpoint's
                        # uncancel guards). On 3.10 the attr is absent and an
                        # outer cancel simply is not distinguished here.
                        task = asyncio.current_task()
                        cancelling = getattr(task, "cancelling", None)
                        if callable(cancelling) and cancelling():
                            raise
        except BaseException:
            disconnected.set()
            future.add_done_callback(_log_abandoned_recovery_result)
            raise
        finally:
            if get_task is not None and not get_task.done():
                get_task.cancel()
        # Final settle + drain: let any just-scheduled threadsafe callbacks run.
        try:
            await asyncio.sleep(0)
            while not queue.empty():
                await self._emit_chunk(flow, queue.get_nowait(), name_state)
        except BaseException:
            disconnected.set()
            future.add_done_callback(_log_abandoned_recovery_result)
            raise

        envelope = future.result()["envelope"]
        self._emit_tool_result(flow, tool_call_id, envelope, result_message_id)
        return envelope


def get_a2ui_tools(params: A2UIToolParams, glue: Optional[dict] = None) -> A2UITool:
    """Build an ``A2UITool`` that generates A2UI surfaces via a sub-agent running
    the toolkit recovery loop. Add ``tool.schema`` to a flow node's completion
    tools yourself, or let ``plan_a2ui_injection`` build it (auto-injection)."""
    if params.get("model") is None:
        raise ValueError(
            "get_a2ui_tools requires a 'model' (the litellm model the render "
            "sub-agent completion runs on)."
        )
    recovery = params.get("recovery")
    if isinstance(recovery, dict):
        # The toolkit contract is camelCase; snake_case keys are otherwise
        # silently ignored (e.g. ``max_attempts`` vs ``maxAttempts``).
        for key in recovery:
            if isinstance(key, str) and "_" in key:
                logger.warning(
                    "a2ui recovery config key %r is ignored - the shared "
                    "toolkit reads camelCase keys (e.g. 'maxAttempts').",
                    key,
                )
    return A2UITool(params, glue)


def is_auto_injected_a2ui_tool(tool: Any) -> bool:
    """True if ``tool`` is an ``A2UITool`` this adapter auto-injected."""
    return getattr(tool, _A2UI_AUTOINJECT_ATTR, False) is True


def _tool_schema_name(tool: Any) -> Optional[str]:
    if isinstance(tool, dict):
        fn = tool.get("function")
        if isinstance(fn, dict):
            return fn.get("name")
    return None


def apply_a2ui_plan_to_tools(actions: Optional[list], plan: Optional[dict]) -> list:
    """Return a new tool list with the plan applied: drop the injected render
    proxy, append the ``generate_a2ui`` schema. A no-op copy when ``plan`` is
    ``None`` (A2UI off), so a flow node can call it unconditionally."""
    result = list(actions or [])
    if not plan:
        return result
    drop = set(plan.get("drop_tool_names") or [])
    result = [a for a in result if _tool_schema_name(a) not in drop]
    result.append(plan["tool"].schema)
    return result


# ---------------------------------------------------------------------------
# Auto-inject decision
# ---------------------------------------------------------------------------


def plan_a2ui_injection(
    *,
    model: Any,
    state: dict,
    existing_tool_names: list,
    config: Optional[dict] = None,
    log: Optional[logging.Logger] = None,
) -> Optional[dict]:
    """Decide whether to auto-inject ``generate_a2ui`` for this run (mirrors the
    LangGraph / Strands contract - "no injectA2UITool, no injection"):

    1. Off unless the runtime forwarded ``injectA2UITool`` (surfaced under
       ``state["ag-ui"]["inject_a2ui_tool"]`` by the endpoint) OR a backend
       ``config["inject_a2ui_tool"]`` override.
    2. USER PREVAILS - a dev-wired ``generate_a2ui`` (already in
       ``existing_tool_names``) is never double-injected.
    3. No model -> warn + skip.
    4. Otherwise build the tool (threading the run's messages + state + resolved
       catalog) and drop the injected render tool.

    ``state`` is the flow state; the endpoint lifts the A2UI component schema +
    the inject flag under ``state["ag-ui"]`` so ``resolve_a2ui_catalog`` and this
    function read them from one canonical place.

    Returns ``{"tool", "tool_name", "drop_tool_names", "catalog"}`` or ``None``.
    """
    log = log or logger
    config = config or {}
    ag_ui = state.get("ag-ui") if isinstance(state, Mapping) else None
    ag_ui = ag_ui if isinstance(ag_ui, dict) else {}

    flag = ag_ui.get("inject_a2ui_tool")
    if flag is None:
        # Nullish fallback: an explicit runtime ``injectA2UITool: false`` disables
        # injection even when the backend config opts in.
        flag = config.get("inject_a2ui_tool")
    if not flag:
        return None

    tool_name = config.get("tool_name") or GENERATE_A2UI_TOOL_NAME
    if tool_name in (existing_tool_names or []):
        return None

    if model is None:
        log.warning(
            "A2UI tool injection requested but no model was provided. Skipping "
            "auto-injection - pass the flow node's model to plan_a2ui_injection."
        )
        return None

    render_tool_name = flag if isinstance(flag, str) else RENDER_A2UI_TOOL_NAME

    resolved = resolve_a2ui_catalog(state) if isinstance(state, Mapping) else None
    runtime_schema, runtime_catalog_id = resolved if resolved else (None, None)

    catalog = config.get("catalog")
    default_catalog_id = config.get("default_catalog_id") or runtime_catalog_id
    guidelines = config.get("guidelines")
    if guidelines is None and runtime_schema:
        guidelines = {"composition_guide": runtime_schema}

    tool = get_a2ui_tools(
        {
            "model": model,
            "tool_name": tool_name,
            "tool_description": config.get("tool_description"),
            "catalog": catalog,
            "default_catalog_id": default_catalog_id,
            "default_surface_id": config.get("default_surface_id"),
            "guidelines": guidelines,
            "recovery": config.get("recovery"),
            "on_a2ui_attempt": config.get("on_a2ui_attempt"),
        },
        glue={
            "messages": list(state.get("messages") or [])
            if isinstance(state, Mapping)
            else [],
            "state": dict(state) if isinstance(state, Mapping) else {},
        },
    )
    setattr(tool, _A2UI_AUTOINJECT_ATTR, True)

    return {
        "tool": tool,
        "tool_name": tool_name,
        "drop_tool_names": [render_tool_name],
        "catalog": catalog,
    }
