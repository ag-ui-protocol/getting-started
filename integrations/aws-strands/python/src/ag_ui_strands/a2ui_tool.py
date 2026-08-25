"""A2UI subagent tool for AWS Strands agents — Python.

Thin adapter over ``ag-ui-a2ui-toolkit`` — the recovery loop, validation, op
builders, prompt assembly and output envelope all live in the toolkit. This
module owns only the Strands-specific glue (mirrors the TypeScript adapter's
``a2ui-tool.ts``):

  - ``get_a2ui_tools(params, glue=None)`` — explicit wiring: builds a Strands
    tool the dev adds to their agent's ``tools``. The tool runs the toolkit's
    validate->retry recovery loop, driving a sub-agent that calls
    ``render_a2ui``.
  - ``plan_a2ui_injection(...)`` — auto-injection: the pure per-run
    decision. Reads the runtime ``injectA2UITool`` flag, infers the model,
    resolves the catalog, threads the run's AG-UI messages + state, and returns
    the tool to register (+ the injected render tool to drop) — or ``None``.

Streaming: the sub-agent's ``render_a2ui`` call must STREAM to the AG-UI wire —
the a2ui middleware's "building" skeleton and progressive paint key off the
inner tool-call's arg deltas, not the final result. The toolkit recovery loop
is synchronous, so it runs in a worker thread; sub-agent stream events are
pushed onto an asyncio queue and re-yielded from the tool's ``stream()`` as
``ToolStreamEvent`` payloads under ``A2UI_STREAM_KEY``, which the adapter
translates into synthetic inner TOOL_CALL_START/ARGS/END events.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import uuid
from typing import Any, Callable, Optional

from strands.types._events import ToolResultEvent, ToolStreamEvent
from strands.types.tools import AgentTool, ToolSpec, ToolUse

from ag_ui.core import RunAgentInput
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

# Re-export the toolkit constants/types for callers that import them from this
# package — keeps the public surface aligned with the LangGraph adapter so
# consumers can type their params bag without depending on the toolkit directly.
# ``plan_a2ui_injection`` / ``is_auto_injected_a2ui_tool`` / ``A2UI_STREAM_KEY``
# are Strands-specific additions (the auto-injection machinery LG handles in its
# graph state merge instead).
__all__ = [
    "get_a2ui_tools",
    "plan_a2ui_injection",
    "is_auto_injected_a2ui_tool",
    "A2UI_STREAM_KEY",
    "A2UI_OPERATIONS_KEY",
    "A2UIToolParams",
    "A2UIGuidelines",
    "BASIC_CATALOG_ID",
]

logger = logging.getLogger("ag_ui_strands")

#: Default name of the render tool the A2UI middleware injects (and we drop).
RENDER_A2UI_TOOL_NAME: str = RENDER_A2UI_TOOL_DEF["function"]["name"]

#: Marker key on ``ToolStreamEvent`` data payloads carrying the sub-agent's
#: render_a2ui streaming progress out of the ``generate_a2ui`` tool. The
#: adapter translates these into synthetic inner TOOL_CALL_START/ARGS/END
#: events on the AG-UI wire. The marker key must match the TS adapter's
#: ``A2UI_STREAM_KEY``; payload field casing is adapter-local (snake_case
#: here, camelCase in TS — each adapter consumes only its own payloads).
A2UI_STREAM_KEY = "__a2uiRenderStream"

#: Attribute marking a ``generate_a2ui`` tool this adapter auto-injected
#: so the per-run hook can tell its OWN prior-turn injection (safe to
#: refresh) apart from a dev-wired tool (which always wins, never touched).
_A2UI_AUTOINJECT_ATTR = "_a2ui_auto_injected"

def _log_abandoned_recovery_result(future: "asyncio.Future") -> None:
    """Consume the recovery future's outcome after generator abandonment so a
    rethrown sub-agent error isn't silently dropped by asyncio."""
    try:
        exc = future.exception()
    except asyncio.CancelledError:
        return
    # The adapter's own between-attempt disconnect abort raises CancelledError
    # INSIDE the executor fn, so the future finishes with it as a stored
    # exception (FINISHED state, not CANCELLED) — intentional, don't warn.
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
    call — no recovery retries; Strands' tool executor surfaces it as a tool
    error (only BaseExceptions escape the run itself):

    - cancellation — retrying would defeat the cancel and burn MORE tokens;
    - programmer errors (TypeError/NameError = adapter bugs) — must surface
      loudly, not masquerade as a recoverable "failed attempt".

    ``"recoverable"`` is a genuine model/network error the recovery loop should
    record as a failed attempt (retry or tasteful hard-failure).
    """
    if aborted or isinstance(err, asyncio.CancelledError):
        return "rethrow"
    if isinstance(err, (TypeError, NameError)):
        # (TS asymmetry note: the TS twin exempts undici's exact
        # `TypeError: fetch failed` — Python transports never surface network
        # failures as TypeError, so no exemption is needed here.)
        return "rethrow"
    # Non-Exception BaseExceptions (SystemExit, KeyboardInterrupt, ...) signal
    # shutdown — retrying through them would fire more model calls during
    # interpreter teardown.
    if not isinstance(err, Exception):
        return "rethrow"
    return "recoverable"


# ---------------------------------------------------------------------------
# Message-shape helpers (Strands python message dicts)
# ---------------------------------------------------------------------------


def _has_tool_use_for(message: dict, tool_name: str) -> bool:
    content = message.get("content")
    if not isinstance(content, list):
        return False
    for block in content:
        if isinstance(block, dict):
            tool_use = block.get("toolUse")
            if isinstance(tool_use, dict) and tool_use.get("name") == tool_name:
                return True
    return False


def strip_in_flight_tool_call(messages: list, tool_name: str) -> list:
    """Drop the trailing in-flight ``tool_name`` call. When the model invokes
    the generate tool, the assistant turn carrying that toolUse is the last
    message with no matching toolResult yet — passing it to the sub-agent
    (which lacks the tool) is malformed. Only strips when the LAST message is
    that call, so a normal user turn at the tail is preserved. The WHOLE
    trailing message is dropped — any sibling text block in that assistant
    turn goes with it (the sub-agent prompt carries the request context)."""
    if messages:
        last = messages[-1]
        if (
            isinstance(last, dict)
            and last.get("role") == "assistant"
            and _has_tool_use_for(last, tool_name)
        ):
            return list(messages[:-1])
    return list(messages)


def _tool_result_text(content: Any) -> str:
    """Extract text from a Strands ``toolResult.content`` for A2UI detection.
    Handles raw strings, ``{"text": ...}`` and ``{"json": ...}`` blocks."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        if isinstance(block.get("text"), str):
            parts.append(block["text"])
        elif "json" in block:
            parts.append(json.dumps(block["json"]))
    return "".join(parts)


def strands_tool_results_to_agui(messages: list) -> list:
    """Reconstruct the AG-UI ``role:"tool"`` messages the toolkit's
    ``find_prior_surface`` needs (used only for ``intent:"update"``) from
    Strands history. Strands carries tool results as ``toolResult`` blocks
    nested in user turns; emit one AG-UI tool message per result whose content
    contains a prior ``a2ui_operations`` envelope."""
    out: list = []
    fallback_seq = 0
    for message in messages:
        if not isinstance(message, dict):
            continue
        content = message.get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            result = block.get("toolResult")
            if not isinstance(result, dict):
                continue
            text = _tool_result_text(result.get("content"))
            if not text or A2UI_OPERATIONS_KEY not in text:
                continue
            tool_call_id = result.get("toolUseId")
            if not tool_call_id:
                tool_call_id = f"a2ui-prior-{fallback_seq}"
                fallback_seq += 1
            out.append(
                {
                    "id": tool_call_id,
                    "role": "tool",
                    "tool_call_id": tool_call_id,
                    "content": text,
                }
            )
    return out


# ---------------------------------------------------------------------------
# Sub-agent invocation (streaming)
# ---------------------------------------------------------------------------


async def _stream_render_subagent(
    model: Any,
    prompt: str,
    messages: list,
    push: Callable[[dict], None],
    catalog_id: Optional[str] = None,
) -> Optional[dict]:
    """Run a SINGLE forced ``render_a2ui`` model call and return the captured
    args — or ``None`` if the model produced no call.

    Mirrors the LangGraph adapter's single forced structured-output turn
    (``bind_tools([RENDER_A2UI_TOOL_DEF], tool_choice="render_a2ui")`` + one
    ``astream``): we call the model DIRECTLY (not a Strands ``Agent``), so there
    is no agentic loop. The model emits exactly one ``render_a2ui`` tool call and
    we stop. A full ``Agent`` loop would EXECUTE the bound render tool and then
    fire a SECOND model call to continue the turn — and with the "render the
    surface" system prompt that continuation re-invokes render (or never settles
    on a terminal text turn). The sub-agent stream would then never end, so the
    outer ``generate_a2ui`` tool never returns its result and the run never emits
    RUN_FINISHED (the surface paints, but the call hangs). The forced single turn
    is the fix.

    Streams ``render_a2ui``'s arg fragments to the AG-UI wire (start / args
    deltas / end) via ``push`` so the a2ui middleware paints progressively.
    ``catalog_id`` (the host-resolved ``default_catalog_id``) is spliced into the
    first chunk: the model never emits ``catalogId`` (the render schema omits it
    and the host owns the catalog), so without it the progressive paint in
    ``@ag-ui/a2ui-middleware`` falls back to the basic catalog and the renderer
    throws "Catalog not found". The splice affects only the EMITTED delta, never
    the captured args — the committed envelope stamps the id via
    ``build_a2ui_envelope`` so the progressive and committed surfaces agree."""
    render_spec: ToolSpec = {
        "name": RENDER_A2UI_TOOL_NAME,
        "description": RENDER_A2UI_TOOL_DEF["function"]["description"],
        "inputSchema": {"json": RENDER_A2UI_TOOL_DEF["function"]["parameters"]},
    }

    captured: dict | None = None
    accumulated = ""
    live_call_id: Optional[str] = None
    # Whether the host ``catalog_id`` has been spliced into the streamed args
    # for the current call yet (reset per render-block start below).
    catalog_prefixed = False
    # Fallback id for providers that don't stamp a toolUseId on the start frame.
    fallback_call_id = f"a2ui-render-{uuid.uuid4().hex[:8]}"

    def _finish_call() -> None:
        # The model streams render_a2ui's args as a JSON string (partial
        # fragments reconstruct into the full object). Parse the accumulated raw
        # string — NOT the catalog-spliced stream — so the committed args are the
        # model's own (catalogId is stamped by build_a2ui_envelope).
        nonlocal captured
        try:
            captured = json.loads(accumulated) if accumulated.strip() else {}
        except (json.JSONDecodeError, TypeError):
            captured = {}

    try:
        async for event in model.stream(
            messages,
            tool_specs=[render_spec],
            system_prompt=prompt,
            tool_choice={"tool": {"name": RENDER_A2UI_TOOL_NAME}},
        ):
            if not isinstance(event, dict):
                continue

            block_start = event.get("contentBlockStart")
            if isinstance(block_start, dict):
                tool_use = (block_start.get("start") or {}).get("toolUse")
                if (
                    isinstance(tool_use, dict)
                    and tool_use.get("name") == RENDER_A2UI_TOOL_NAME
                ):
                    # New render block. Close any still-open one first so the
                    # synthetic stream never leaves an unclosed inner
                    # TOOL_CALL_START (mirrors the TS adapter's per-start reset).
                    if live_call_id is not None:
                        push({"kind": "end", "tool_call_id": live_call_id})
                    live_call_id = tool_use.get("toolUseId") or fallback_call_id
                    accumulated = ""
                    catalog_prefixed = False
                    push(
                        {
                            "kind": "start",
                            "tool_call_id": live_call_id,
                            "tool_call_name": RENDER_A2UI_TOOL_NAME,
                        }
                    )
                continue

            block_delta = event.get("contentBlockDelta")
            if isinstance(block_delta, dict) and live_call_id is not None:
                tool_use_delta = (block_delta.get("delta") or {}).get("toolUse")
                frag = (
                    tool_use_delta.get("input")
                    if isinstance(tool_use_delta, dict)
                    else None
                )
                if isinstance(frag, str) and frag:
                    accumulated += frag
                    # Splice the host catalog id into the FIRST chunk (right after
                    # the opening brace) so the streamed args read as
                    # ``{"catalogId": "<id>", ...}`` — valid JSON the middleware
                    # progressive paint reads the id from.
                    if catalog_id and not catalog_prefixed:
                        brace = frag.find("{")
                        if brace != -1:
                            frag = (
                                frag[: brace + 1]
                                + f'"catalogId": {json.dumps(catalog_id)}, '
                                + frag[brace + 1 :]
                            )
                            catalog_prefixed = True
                    push(
                        {
                            "kind": "args",
                            "tool_call_id": live_call_id,
                            "delta": frag,
                        }
                    )
                continue

            # `contentBlockStop` carries an (often empty) dict, so test for the
            # KEY, not truthiness.
            if "contentBlockStop" in event and live_call_id is not None:
                push({"kind": "end", "tool_call_id": live_call_id})
                _finish_call()
                live_call_id = None
                # Single forced turn: the render call is complete. Stop the
                # stream so no continuation model call ever fires.
                break
    except BaseException:
        # The provider stream died mid-call (model 429, network drop, ...):
        # close the live synthetic call before unwinding — an unclosed inner
        # TOOL_CALL_START is a wire-protocol violation, and the next recovery
        # attempt would open a fresh call on top of it.
        if live_call_id is not None:
            try:
                push({"kind": "end", "tool_call_id": live_call_id})
            except RuntimeError:
                # call_soon_threadsafe on a closing loop must not REPLACE the
                # original exception (e.g. a CancelledError) mid-unwind.
                pass
        raise

    # Stream ended without a per-block ``contentBlockStop`` for the live call
    # (some providers close the message without one): close + capture so the
    # middleware still sees the end and the recovery loop gets the args.
    if live_call_id is not None:
        push({"kind": "end", "tool_call_id": live_call_id})
        _finish_call()

    return captured


# ---------------------------------------------------------------------------
# The generate_a2ui tool
# ---------------------------------------------------------------------------


class _GenerateA2UITool(AgentTool):
    """Strands tool that delegates A2UI surface generation to a sub-agent
    running the toolkit recovery loop, streaming render progress as it goes."""

    def __init__(self, params: A2UIToolParams, glue: Optional[dict] = None) -> None:
        super().__init__()
        cfg = resolve_a2ui_tool_params(params)
        self._cfg = cfg
        self._glue = glue or {}
        self._spec: ToolSpec = {
            "name": cfg["tool_name"],
            "description": cfg["tool_description"],
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "intent": {
                            "type": "string",
                            "enum": ["create", "update"],
                            "description": GENERATE_A2UI_ARG_DESCRIPTIONS["intent"],
                        },
                        "target_surface_id": {
                            "type": "string",
                            "description": GENERATE_A2UI_ARG_DESCRIPTIONS["target_surface_id"],
                        },
                        "changes": {
                            "type": "string",
                            "description": GENERATE_A2UI_ARG_DESCRIPTIONS["changes"],
                        },
                    },
                }
            },
        }

    @property
    def tool_name(self) -> str:
        return self._spec["name"]

    @property
    def tool_spec(self) -> ToolSpec:
        return self._spec

    @property
    def tool_type(self) -> str:
        return "python"

    async def stream(self, tool_use: ToolUse, invocation_state: dict, **kwargs: Any):
        cfg = self._cfg
        glue = self._glue
        raw_input = tool_use.get("input")
        args = raw_input if isinstance(raw_input, dict) else {}
        intent = args.get("intent")
        target_surface_id = args.get("target_surface_id")
        changes = args.get("changes")

        # Strands history for the sub-agent, minus the in-flight generate_a2ui
        # call. Prefer the LIVE calling agent (execution-time history); fall
        # back to the per-thread agent captured at injection time.
        calling_agent = invocation_state.get("agent") or glue.get("strands_agent")
        strands_messages = strip_in_flight_tool_call(
            list(getattr(calling_agent, "messages", None) or []),
            self.tool_name,
        )

        # AG-UI history for the toolkit's find_prior_surface (update intent
        # only). MERGE the adapter-supplied glue snapshot (run-start history)
        # with the
        # live Strands-derived results: the snapshot alone misses a surface
        # created EARLIER IN THIS SAME RUN, so a same-run create-then-update
        # would error for a surface visibly on screen. Derived results go
        # last — find_prior_surface walks backwards, so same-run state wins.
        agui_messages = list(glue.get("agui_messages") or []) + (
            strands_tool_results_to_agui(strands_messages)
        )

        prep = prepare_a2ui_request(
            intent=intent,
            target_surface_id=target_surface_id,
            changes=changes,
            messages=agui_messages,
            # `RunAgentInput.state` is Any on the wire; a truthy non-dict must
            # degrade to empty state (generation proceeds without it) rather
            # than crash the tool before the recovery loop engages.
            state=(
                glue.get("state") if isinstance(glue.get("state"), dict) else {}
            ),
            guidelines=cfg["guidelines"],
        )

        if prep.get("error"):
            # The model still reads the envelope (it can self-correct), but
            # leave a server-side breadcrumb so these are countable.
            logger.warning("A2UI request prep failed: %s", prep["error"])
            envelope = wrap_error_envelope(prep["error"])
        else:
            # The sync recovery loop runs in a worker thread; sub-agent stream
            # progress is pushed onto this queue and re-yielded live.
            loop = asyncio.get_running_loop()
            queue: asyncio.Queue = asyncio.Queue()

            def _push(payload: dict) -> None:
                loop.call_soon_threadsafe(queue.put_nowait, payload)

            # Disconnect channel (the TS adapter's cancelSignal analog, scoped
            # to attempt boundaries): set when the consumer abandons this
            # generator so the recovery loop stops before firing further
            # sub-agent model calls nobody will drain. The in-flight attempt
            # still runs to completion (asyncio.run can't be aborted mid-call).
            disconnected = threading.Event()

            def _invoke_subagent(prompt: str, attempt: int) -> Optional[dict]:
                if disconnected.is_set() or loop.is_closed():
                    # Loop closure (process shutdown) would otherwise surface
                    # as a "recoverable" RuntimeError from _push and burn the
                    # remaining attempts against a dead consumer.
                    raise asyncio.CancelledError(
                        "consumer disconnected; abandoning A2UI recovery"
                    )
                # Worker thread: run the async sub-agent on its own loop.
                try:
                    return asyncio.run(
                        _stream_render_subagent(
                            cfg["model"],
                            prompt,
                            strands_messages,
                            _push,
                            catalog_id=cfg["default_catalog_id"],
                        )
                    )
                except BaseException as err:  # noqa: BLE001 — classified below
                    # `aborted=False`: mid-attempt cancellation still rethrows
                    # via asyncio.CancelledError; between-attempt disconnects
                    # are handled by the `disconnected` check above.
                    if classify_a2ui_subagent_error(err, False) == "rethrow":
                        raise
                    logger.warning(
                        "A2UI sub-agent invoke failed on attempt %d; treating as "
                        "a failed attempt: %s",
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

            future = loop.run_in_executor(
                None,
                lambda: run_a2ui_generation_with_recovery(
                    base_prompt=prep["prompt"],
                    catalog=cfg["catalog"],
                    config=cfg["recovery"],
                    on_attempt=cfg["on_a2ui_attempt"],
                    invoke_subagent=_invoke_subagent,
                    build_envelope=_build_envelope,
                ),
            )

            # Drain until the recovery future is done AND the queue is empty —
            # the same structural guarantee as the TS adapter's
            # `while (!settled || queue.length > 0)`. Relying on call_soon FIFO
            # ordering alone could drop pushes scheduled concurrently with the
            # future's completion callback.
            get_task: Optional[asyncio.Task] = None
            try:
                while not (future.done() and queue.empty()):
                    while not queue.empty():
                        yield ToolStreamEvent(
                            tool_use, {A2UI_STREAM_KEY: queue.get_nowait()}
                        )
                    if future.done():
                        continue  # re-check: a push may have landed during drain
                    get_task = asyncio.ensure_future(queue.get())
                    done, _ = await asyncio.wait(
                        {get_task, future}, return_when=asyncio.FIRST_COMPLETED
                    )
                    if get_task in done:
                        item = get_task.result()
                        get_task = None
                        yield ToolStreamEvent(tool_use, {A2UI_STREAM_KEY: item})
                    else:
                        get_task.cancel()
                        # asyncio sharp edge: a cancelled Queue.get() can have
                        # already consumed an item. Recover it instead of losing it.
                        try:
                            item = await get_task
                            get_task = None
                            yield ToolStreamEvent(tool_use, {A2UI_STREAM_KEY: item})
                        except asyncio.CancelledError:
                            get_task = None
                            # An OUTER task cancellation landing while we were
                            # suspended here is indistinguishable from our own
                            # get_task.cancel() — swallowing it would lose the
                            # cancel (it injects once). cancelling() is raised
                            # only for the enclosing task's cancellation.
                            task = asyncio.current_task()
                            if task is not None and task.cancelling():
                                raise
            except BaseException:
                # Unwinding abnormally (GeneratorExit on disconnect,
                # cancellation, or a bug above): stop the recovery loop before
                # its next attempt, and consume the future's eventual outcome
                # so a rethrown error isn't dropped as "exception was never
                # retrieved" — even when the future completed just before we
                # unwound.
                disconnected.set()
                future.add_done_callback(_log_abandoned_recovery_result)
                raise
            finally:
                # Generator abandonment (client disconnect -> GeneratorExit at
                # a suspension point) must not strand a pending Queue.get()
                # ("Task was destroyed but it is pending").
                if get_task is not None and not get_task.done():
                    get_task.cancel()
            # One final settle + drain: let any just-scheduled threadsafe
            # callbacks run, then flush. Same abandonment guard as the main
            # drain — a disconnect at THESE yields must still consume the
            # future's outcome (it can hold a rethrow-class exception).
            try:
                await asyncio.sleep(0)
                while not queue.empty():
                    yield ToolStreamEvent(
                        tool_use, {A2UI_STREAM_KEY: queue.get_nowait()}
                    )
            except BaseException:
                disconnected.set()
                future.add_done_callback(_log_abandoned_recovery_result)
                raise
            envelope = future.result()["envelope"]

        yield ToolResultEvent(
            {
                "toolUseId": tool_use["toolUseId"],
                "status": "success",
                "content": [{"text": envelope}],
            }
        )


def get_a2ui_tools(params: A2UIToolParams, glue: Optional[dict] = None) -> AgentTool:
    """Build a Strands tool that delegates A2UI surface generation to a
    sub-agent running the toolkit recovery loop. Add the returned tool to a
    Strands ``Agent``'s ``tools`` list yourself, or let ``plan_a2ui_injection``
    build it (auto-injection)."""
    if params.get("model") is None:
        # The TS factory enforces this at the type level; without it the
        # sub-agent would silently bind Strands' default Bedrock model.
        raise ValueError(
            "get_a2ui_tools requires a 'model' (the Strands model instance "
            "the render sub-agent runs on)."
        )
    recovery = params.get("recovery")
    if isinstance(recovery, dict):
        # The toolkit contract is camelCase; snake_case keys are otherwise
        # silently ignored (e.g. ``max_attempts`` vs ``maxAttempts``).
        for key in recovery:
            if isinstance(key, str) and "_" in key:
                logger.warning(
                    "a2ui recovery config key %r is ignored — the shared "
                    "toolkit reads camelCase keys (e.g. 'maxAttempts').",
                    key,
                )
    return _GenerateA2UITool(params, glue)


def is_auto_injected_a2ui_tool(tool: Any) -> bool:
    """True if ``tool`` is a ``generate_a2ui`` this adapter auto-injected."""
    return getattr(tool, _A2UI_AUTOINJECT_ATTR, False) is True


# ---------------------------------------------------------------------------
# Auto-inject decision
# ---------------------------------------------------------------------------


def plan_a2ui_injection(
    *,
    model: Any,
    input: RunAgentInput,
    existing_tool_names: list,
    config: Optional[dict] = None,
    log: Optional[logging.Logger] = None,
    strands_agent: Any = None,
    agui_state: Optional[dict] = None,
) -> Optional[dict]:
    """Decide whether to auto-inject ``generate_a2ui`` for this run, mirroring
    the LangGraph contract ("no injectA2UITool, no injection"):

    1. Off unless the runtime forwarded ``injectA2UITool`` (``True``, or a
       string naming the injected RENDER tool to drop) OR a backend
       ``config["inject_a2ui_tool"]`` override.
    2. USER PREVAILS — a dev-wired ``generate_a2ui`` is never
       double-injected. (The per-run hook removes our OWN marked tool before
       computing ``existing_tool_names``.) Deliberately, NOTHING else is
       touched in this branch: the dev opted out of adapter management, so any
       runtime-injected render tool stays too. Limitation: the check is
       name-based — a dev-wired tool under a custom ``tool_name`` is not
       recognized and auto-injection proceeds alongside it.
    3. No inferable model (Graph/Swarm orchestrators) -> warn + skip.
    4. Otherwise build the tool (threading the run's AG-UI messages + state +
       guidelines), using only an explicit ``config["catalog"]`` (mirrors the
       LangGraph adapter — no auto-resolution from context), and drop the
       injected render tool.

    ``agui_state`` is the run state the caller (``agent.py``) assembles with the
    A2UI component schema + remaining context lifted under ``state["ag-ui"]``
    (via the toolkit's ``split_a2ui_schema_context``), mirroring how the
    LangGraph adapter routes context into graph state. When provided it is
    threaded to the sub-agent so ``build_context_prompt`` emits the
    ``## Available Components`` block + context; absent it, the raw wire
    ``input.state`` is used and the sub-agent prompt carries neither.

    Returns ``{"tool", "tool_name", "drop_tool_names", "catalog"}`` or ``None``.
    """
    log = log or logger
    config = config or {}

    # `forwarded_props` is Any on the wire; tolerate non-dict shapes the same
    # way the context-entry handling does (exported API).
    forwarded = (
        input.forwarded_props if isinstance(input.forwarded_props, dict) else {}
    )
    flag = forwarded.get("injectA2UITool")
    if flag is None:
        # Nullish fallback, mirroring the TS adapter's `??`: an explicit
        # runtime `injectA2UITool: false` disables injection even when the
        # backend config opts in.
        flag = config.get("inject_a2ui_tool")
    if not flag:
        return None

    tool_name = GENERATE_A2UI_TOOL_NAME
    # USER PREVAILS: explicit dev wiring wins — never double-inject.
    if tool_name in existing_tool_names:
        return None

    if model is None:
        log.warning(
            "A2UI tool injection requested but no model could be inferred from "
            "the agent (multi-agent orchestrators have no model). Skipping "
            "auto-injection — wire get_a2ui_tools() explicitly."
        )
        return None

    render_tool_name = flag if isinstance(flag, str) else RENDER_A2UI_TOOL_NAME

    # Resolve the frontend-registered catalog from run state (the ``ag-ui``
    # ``a2ui_schema`` entry or an ``ag-ui.context`` "A2UI catalog" entry) so
    # surfaces bind to the host's catalog without the host hardcoding it —
    # mirrors the LangGraph adapter's auto-resolution. Backend config WINS when
    # set, so an explicit ``default_catalog_id`` / ``guidelines`` override still
    # applies.
    resolved = resolve_a2ui_catalog(agui_state) if agui_state is not None else None
    runtime_schema, runtime_catalog_id = resolved if resolved else (None, None)

    # Explicit ``config["catalog"]`` still feeds the semantic-validation catalog
    # (recovery stays structural-only when absent — catalog is never
    # auto-resolved from context for VALIDATION, only the id/guide below).
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
            "agui_messages": list(input.messages or []),
            "state": agui_state if agui_state is not None else input.state,
            "strands_agent": strands_agent,
        },
    )
    setattr(tool, _A2UI_AUTOINJECT_ATTR, True)

    return {
        "tool": tool,
        "tool_name": tool_name,
        "drop_tool_names": [render_tool_name],
        "catalog": catalog,
    }
