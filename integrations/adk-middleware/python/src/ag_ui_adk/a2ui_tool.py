"""A2UI subagent tool factory for Google ADK agents (OSS-158).

Thin adapter over ``ag-ui-a2ui-toolkit`` — the heavy lifting (op builders,
prompt assembly, history walkers, output envelope, and the validate→retry
recovery loop) lives in the toolkit. This adapter owns only the ADK-specific
glue: the ``BaseTool`` decorator, runtime/state access, model bind + invoke,
and — unlike LangGraph, which gets it free via langchain's ``astream_events`` —
explicit emission of the nested ``render_a2ui`` tool-call stream onto the run's
event queue so the middleware paint gate and client see progressive components.

Mirrors the LangGraph ``get_a2ui_tools`` factory: it takes the shared
``A2UIToolParams`` so a new toolkit knob reaches this adapter with no signature
change.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import Any, Optional

from google.adk.models.llm_request import LlmRequest
from google.adk.tools import BaseTool
from google.genai import types

from ag_ui.core import (
    EventType,
    RunAgentInput,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallStartEvent,
    ToolMessage,
)

from ag_ui_a2ui_toolkit import (
    A2UI_OPERATIONS_KEY,
    A2UIToolParams,
    GENERATE_A2UI_TOOL_NAME,
    RENDER_A2UI_TOOL_DEF,
    build_a2ui_envelope,
    prepare_a2ui_request,
    resolve_a2ui_tool_params,
    run_a2ui_generation_with_recovery,
    wrap_error_envelope,
)

from .a2ui_google_sdk import (
    heal_json_arg,
    normalize_catalog_dict,
    render_catalog_instructions,
)
from .event_translator import adk_events_to_messages
from .session_manager import CONTEXT_STATE_KEY

logger = logging.getLogger("ag_ui_adk")

# The inner structured-output tool the subagent is forced to call.
_RENDER_A2UI_NAME = "render_a2ui"

#: Default name of the render tool the A2UI middleware injects as a frontend
#: tool (and that auto-injection drops, so the model calls ``generate_a2ui``
#: directly instead of the bare render proxy). Sourced from the shared toolkit
#: contract so a rename upstream propagates here.
RENDER_A2UI_TOOL_NAME: str = RENDER_A2UI_TOOL_DEF["function"]["name"]

#: Attribute marking a ``generate_a2ui`` tool this adapter auto-injected, so the
#: per-run wiring can tell its OWN injection apart from a dev-wired tool (which
#: always wins — see the USER-PREVAILS branch in ``plan_a2ui_injection``).
_A2UI_AUTOINJECT_ATTR = "_a2ui_auto_injected"

# Description the A2UI middleware stamps on the schema context entry. MUST stay
# byte-identical to the middleware's exported A2UI_SCHEMA_CONTEXT_DESCRIPTION
# (middlewares/a2ui-middleware/src/index.ts) and the LangGraph adapter's copy —
# exact-equality match routes the schema into state["ag-ui"]["a2ui_schema"]
# instead of leaking it into generic context. Any drift silently misroutes it.
A2UI_SCHEMA_CONTEXT_DESCRIPTION = (
    "A2UI Component Schema — available components for generating UI surfaces. "
    "Use these component names and properties when creating A2UI operations."
)


class A2UISubAgentTool(BaseTool):
    """ADK tool that delegates A2UI surface generation to a forced-tool-call
    subagent invocation and drives the toolkit recovery loop.

    The recovery loop (``run_a2ui_generation_with_recovery``) is synchronous; the
    model stream and event-queue emission are async. ``run_async`` bridges the
    two by running the loop on a worker thread (``asyncio.to_thread``) whose
    synchronous ``invoke_subagent`` callback drives the async per-attempt stream
    back on the run's event loop (``run_coroutine_threadsafe``). This keeps the
    published toolkit untouched.
    """

    def __init__(self, cfg: dict):
        super().__init__(
            name=cfg["tool_name"],
            description=cfg["tool_description"],
            is_long_running=False,
        )
        self._cfg = cfg
        self._model = cfg["model"]
        self._guidelines = cfg["guidelines"]
        self._default_surface_id = cfg["default_surface_id"]
        self._default_catalog_id = cfg["default_catalog_id"]
        self._catalog = cfg["catalog"]
        self._recovery = cfg["recovery"]
        self._on_a2ui_attempt = cfg["on_a2ui_attempt"]
        # Injected per-run by ADKAgent so the tool can emit nested tool-call
        # events onto the active run's stream.
        self.event_queue = None

    def for_run(self, event_queue: Any) -> "A2UISubAgentTool":
        """Return a per-run clone bound to ``event_queue``.

        The construction-time tool is shared across concurrent runs; ADKAgent
        swaps in this clone per run so each emits onto its own stream without
        mutating the shared instance (mirrors the ClientProxyToolset swap).
        """
        clone = A2UISubAgentTool(self._cfg)
        clone.event_queue = event_queue
        # Preserve the auto-inject marker so a per-run clone of an auto-injected
        # tool is still recognized as auto-injected (parity with the dev-wired
        # path, which carries no marker).
        if getattr(self, _A2UI_AUTOINJECT_ATTR, False):
            setattr(clone, _A2UI_AUTOINJECT_ATTR, True)
        return clone

    def _get_declaration(self) -> Optional[types.FunctionDeclaration]:
        """Declare ``generate_a2ui`` to the parent agent's planner."""
        return types.FunctionDeclaration(
            name=self.name,
            description=self.description,
            parameters=types.Schema(
                type=types.Type.OBJECT,
                properties={
                    "intent": types.Schema(
                        type=types.Type.STRING,
                        description=(
                            "'create' to render a new surface, or 'update' to "
                            "modify a surface already rendered in this conversation."
                        ),
                    ),
                    "target_surface_id": types.Schema(
                        type=types.Type.STRING,
                        description="Surface id to modify when intent='update'.",
                    ),
                    "changes": types.Schema(
                        type=types.Type.STRING,
                        description="Natural-language changes to apply on update.",
                    ),
                },
            ),
        )

    async def run_async(self, *, args: dict[str, Any], tool_context: Any) -> Any:
        """Generate or edit an A2UI surface, returning the operations envelope."""
        intent = args.get("intent", "create")
        target_surface_id = args.get("target_surface_id")
        changes = args.get("changes")

        events = self._session_events(tool_context)
        # AG-UI messages drive prepare_a2ui_request's prior-surface lookup
        # (intent="update"); the genai conversation drives the subagent call.
        messages = self._normalize_a2ui_tool_results(adk_events_to_messages(events))
        conversation = self._conversation_contents(events)
        state, schema_value = self._state_view(tool_context)

        # Single catalog, client-sourced (no drift): prefer a host-supplied catalog
        # param, else the middleware-injected schema. Render it via Google's
        # render_as_llm_instructions (server-to-client envelope + common-types
        # DEFINITIONS the injected catalog only references + components) into the
        # prompt slot — richer than dumping the raw catalog. Render is best-effort
        # and tolerates the client's non-conformant catalog; on failure we leave the
        # raw schema text in the slot (today's behavior).
        catalog_source = self._catalog or schema_value
        instructions = render_catalog_instructions(
            catalog_source, default_catalog_id=self._default_catalog_id
        )
        if instructions is not None:
            state.setdefault("ag-ui", {})["a2ui_schema"] = instructions

        prep = prepare_a2ui_request(
            intent=intent,
            target_surface_id=target_surface_id,
            changes=changes,
            messages=messages,
            state=state,
            guidelines=self._guidelines,
        )
        if prep.get("error"):
            return self._as_tool_return(wrap_error_envelope(prep["error"]))

        # Validate with the toolkit's structural/lenient validator against the SAME
        # client catalog (membership; it does not strict-resolve $refs, so the
        # non-conformant catalog is fine) — parity with the LangGraph/Declarative
        # A2UI demos. None → pure structural validation.
        validation_catalog = normalize_catalog_dict(
            catalog_source, default_catalog_id=self._default_catalog_id
        )

        # One stable nested tool-call id, reused across every recovery attempt so
        # the middleware/client swap the in-progress surface in place rather than
        # stacking N tool calls.
        surface_tool_call_id = f"a2ui-render-{uuid.uuid4().hex[:8]}"
        loop = asyncio.get_running_loop()

        def _invoke_subagent(prompt: str, attempt: int) -> Optional[dict]:
            future = asyncio.run_coroutine_threadsafe(
                self._stream_one_attempt(
                    prompt, attempt, surface_tool_call_id, conversation
                ),
                loop,
            )
            return future.result()

        def _build_envelope(generated: dict) -> str:
            return build_a2ui_envelope(
                args=generated,
                is_update=prep["is_update"],
                target_surface_id=target_surface_id,
                prior=prep.get("prior"),
                default_surface_id=self._default_surface_id,
                default_catalog_id=self._default_catalog_id,
            )

        result = await asyncio.to_thread(
            run_a2ui_generation_with_recovery,
            base_prompt=prep["prompt"],
            catalog=validation_catalog,
            config=self._recovery,
            invoke_subagent=_invoke_subagent,
            build_envelope=_build_envelope,
            on_attempt=self._on_a2ui_attempt,
        )
        return self._as_tool_return(result["envelope"])

    @staticmethod
    def _as_tool_return(envelope: str) -> Any:
        """Return the toolkit envelope in the shape the A2UI middleware can read.

        The toolkit hands back a JSON *string* (an ``a2ui_operations`` envelope on
        success, or an ``a2ui_recovery_exhausted`` / ``error`` envelope otherwise).
        ADK wraps a non-dict tool return as ``{"result": <string>}``, which buries
        those top-level keys so the middleware's ``tryParseA2UIOperations`` /
        ``tryParseRecoveryFailure`` never see them — silently dropping the
        hard-failure UI on exhaustion. Returning the parsed dict makes ADK
        serialize the bare envelope JSON, matching how LangGraph delivers the
        tool result. Valid surfaces still paint via the streamed render_a2ui
        events; the middleware dedups the outer result against the inner surface
        by tool-call id, so this does not double-paint.
        """
        try:
            parsed = json.loads(envelope)
        except (ValueError, TypeError):
            return envelope
        return parsed if isinstance(parsed, dict) else envelope

    async def _stream_one_attempt(
        self, prompt: str, attempt: int, tool_call_id: str, conversation: list
    ) -> Optional[dict]:
        """Invoke the subagent once, streaming its ``render_a2ui`` call onto the
        run queue as nested ``TOOL_CALL_*`` events; return the generated args."""
        await self.event_queue.put(
            ToolCallStartEvent(
                type=EventType.TOOL_CALL_START,
                tool_call_id=tool_call_id,
                tool_call_name=_RENDER_A2UI_NAME,
            )
        )

        llm_request = self._build_llm_request(prompt, conversation)
        final_args: Optional[dict] = None
        async for response in self._model.generate_content_async(
            llm_request, stream=True
        ):
            fc = self._extract_render_fc(response)
            if fc is not None and getattr(fc, "args", None):
                final_args = self._coerce_freeform_args(dict(fc.args))

        # Atomic per-attempt paint: emit the complete args once. (Real per-delta
        # streaming for Gemini-3 partial_args is layered on separately.)
        if final_args is not None:
            await self.event_queue.put(
                ToolCallArgsEvent(
                    type=EventType.TOOL_CALL_ARGS,
                    tool_call_id=tool_call_id,
                    delta=json.dumps(final_args),
                )
            )

        await self.event_queue.put(
            ToolCallEndEvent(
                type=EventType.TOOL_CALL_END,
                tool_call_id=tool_call_id,
            )
        )
        return final_args

    def _build_llm_request(self, prompt: str, conversation: list) -> LlmRequest:
        """Build the forced-``render_a2ui`` request, mirroring the LangGraph
        adapter's ``[SystemMessage(prompt), *messages]``: the assembled subagent
        prompt rides as ``system_instruction`` and the real conversation turns are
        the request ``contents``.
        """
        # Free-form payload schema (vs the shared RENDER_A2UI_TOOL_DEF's typed
        # `components: array<object>`): Gemini's function-calling fills typed args
        # STRICTLY and emits empty `{}` for a property-less array-of-object. So we
        # declare components/data as STRING — the model writes the full A2UI JSON
        # free-form (guided by the system prompt), exactly the payload shape the
        # ADK reference (a2ui rizzcharts) uses. _coerce_freeform_args parses it back
        # into the structured dict the toolkit validates. The shared
        # RENDER_A2UI_TOOL_DEF stays typed for LangGraph/OpenAI, which fill loose
        # schemas from the prose; this string shape is ADK/Gemini-specific glue.
        declaration = types.FunctionDeclaration(
            name=_RENDER_A2UI_NAME,
            description=RENDER_A2UI_TOOL_DEF["function"]["description"],
            parameters=types.Schema(
                type=types.Type.OBJECT,
                properties={
                    "surfaceId": types.Schema(
                        type=types.Type.STRING,
                        description="Unique surface identifier.",
                    ),
                    "components": types.Schema(
                        type=types.Type.STRING,
                        description=(
                            "The A2UI v0.9 component array as a JSON string, e.g. "
                            '\'[{"id":"root","component":"Text","text":"Hi"}]\'. '
                            "The root component must have id 'root'."
                        ),
                    ),
                    "data": types.Schema(
                        type=types.Type.STRING,
                        description=(
                            "Optional surface data model as a JSON string, e.g. "
                            "'{\"items\":[...]}'. Use '{}' when there is none."
                        ),
                    ),
                },
                required=["surfaceId", "components"],
            ),
        )
        config = types.GenerateContentConfig(
            system_instruction=prompt,
            tools=[types.Tool(function_declarations=[declaration])],
            tool_config=types.ToolConfig(
                function_calling_config=types.FunctionCallingConfig(
                    mode=types.FunctionCallingConfigMode.ANY,
                    allowed_function_names=[_RENDER_A2UI_NAME],
                )
            ),
        )
        # Fall back to carrying the prompt as the user turn only when there is no
        # conversation (defensive — a real run always has the triggering message).
        contents = (
            list(conversation)
            if conversation
            else [types.Content(role="user", parts=[types.Part(text=prompt)])]
        )
        return LlmRequest(
            model=getattr(self._model, "model", None),
            contents=contents,
            config=config,
        )

    @staticmethod
    def _coerce_freeform_args(args: dict) -> dict:
        """Heal + parse the free-form JSON-string ``components``/``data`` Gemini
        returns into the structured list/dict the toolkit validates and emits.

        Uses the Google SDK's ``parse_and_fix`` (smart quotes, trailing commas,
        single-object→list wrap) rather than a bare ``json.loads`` — Gemini's
        free-form JSON often needs that healing. A model may also return them
        already-structured (inline) — those are left untouched. On a hard parse
        failure the value is left as the original string, so the toolkit validator
        rejects it (non-list / non-dict) and the recovery loop retries rather than
        committing garbage."""
        for key, expect in (("components", "list"), ("data", "dict")):
            value = args.get(key)
            if isinstance(value, str):
                try:
                    args[key] = heal_json_arg(value, expect=expect)
                except ValueError:
                    pass
        return args

    @staticmethod
    def _extract_render_fc(response: Any) -> Any:
        """Return the ``render_a2ui`` FunctionCall part of an LlmResponse, if any."""
        content = getattr(response, "content", None)
        if content is None:
            return None
        for part in getattr(content, "parts", None) or []:
            fc = getattr(part, "function_call", None)
            if fc is not None and getattr(fc, "name", None) == _RENDER_A2UI_NAME:
                return fc
        return None

    @staticmethod
    def _session_events(tool_context: Any) -> list:
        """The ADK session's event list, accessed defensively across context shapes."""
        session = getattr(tool_context, "session", None)
        if session is None:
            ctx = getattr(tool_context, "_invocation_context", None)
            session = getattr(ctx, "session", None)
        return list(getattr(session, "events", None) or [])

    @staticmethod
    def _extract_envelope(content: str) -> Optional[dict]:
        """Pull an ``a2ui_operations`` envelope out of an ADK tool-result string,
        unwrapping the layers ADK adds.

        ``run_async`` now returns the envelope as a dict, which the translator
        ``json.dumps`` straight into the canonical ``{"a2ui_operations": ...}``
        string. Older sessions (or a string-returning tool) can still have the
        envelope nested under ``result`` (ADK wraps a string tool return as
        ``{"result": <string>}``) and/or double-encoded — so peel up to a few
        layers until an envelope dict surfaces, staying backward compatible."""
        payload: Any = content
        for _ in range(3):
            if isinstance(payload, str):
                try:
                    payload = json.loads(payload)
                except (ValueError, TypeError):
                    return None
            if isinstance(payload, dict):
                if A2UI_OPERATIONS_KEY in payload:
                    return payload
                inner = payload.get("result")
                if isinstance(inner, (str, dict)):
                    payload = inner
                    continue
            return None
        return None

    @classmethod
    def _normalize_a2ui_tool_results(cls, messages: list) -> list:
        """Rewrite A2UI tool-result messages so their content is the canonical
        envelope JSON string the toolkit's ``find_prior_surface`` expects (it does
        ``json.loads(content)`` and looks for ``a2ui_operations``). Non-A2UI tool
        results pass through unchanged."""
        out: list = []
        for msg in messages:
            role = getattr(msg, "role", None)
            content = getattr(msg, "content", None)
            if role == "tool" and isinstance(content, str):
                envelope = cls._extract_envelope(content)
                if envelope is not None:
                    msg = ToolMessage(
                        id=getattr(msg, "id", None) or str(uuid.uuid4()),
                        role="tool",
                        content=json.dumps(envelope),
                        tool_call_id=getattr(msg, "tool_call_id", None) or "",
                    )
            out.append(msg)
        return out

    @staticmethod
    def _conversation_contents(events: list) -> list:
        """The conversational genai ``Content`` turns to forward to the subagent.

        Mirrors LangGraph's ``*messages``: user/model text turns in order, skipping
        partial chunks and the tool-call/function-response machinery (the in-flight
        generate_a2ui call and any tool results) so the subagent sees the request,
        not the plumbing."""
        contents: list = []
        for ev in events:
            if getattr(ev, "partial", False):
                continue
            content = getattr(ev, "content", None)
            parts = getattr(content, "parts", None)
            if not parts:
                continue
            has_text = any(getattr(p, "text", None) for p in parts)
            has_calls = (
                bool(ev.get_function_calls())
                if hasattr(ev, "get_function_calls")
                else False
            )
            has_responses = (
                bool(ev.get_function_responses())
                if hasattr(ev, "get_function_responses")
                else False
            )
            if has_text and not has_calls and not has_responses:
                contents.append(content)
        return contents

    def _state_view(self, tool_context: Any) -> tuple[dict, Optional[str]]:
        """Remap ADK session context into the ``state['ag-ui']`` shape the
        toolkit's ``build_context_prompt`` expects, and return the raw A2UI schema
        value alongside it.

        The ADK middleware stores AG-UI context (a flat ``{description, value}``
        list) under ``CONTEXT_STATE_KEY``. The A2UI schema entry (matched by its
        exact description) is routed to ``ag-ui.a2ui_schema`` so it renders as
        the "Available Components" section rather than generic context — mirrors
        the LangGraph adapter's remap. The raw schema value is also returned so
        ``run_async`` can try to build a Google SDK catalog from it (the hybrid
        path overrides ``a2ui_schema`` with the rendered schema block).
        """
        state = getattr(tool_context, "state", None)
        raw_context: Any = []
        if state is not None:
            try:
                raw_context = state.get(CONTEXT_STATE_KEY) or []
            except Exception:
                raw_context = []

        regular_context: list = []
        schema_value: Optional[str] = None
        for entry in raw_context:
            if isinstance(entry, dict):
                desc = entry.get("description", "")
                value = entry.get("value", "")
            else:
                desc = getattr(entry, "description", "")
                value = getattr(entry, "value", "")
            if desc == A2UI_SCHEMA_CONTEXT_DESCRIPTION:
                schema_value = value
            else:
                regular_context.append(entry)

        ag_ui: dict = {"context": regular_context}
        if schema_value is not None:
            ag_ui["a2ui_schema"] = schema_value
        return {"ag-ui": ag_ui}, schema_value


def get_a2ui_tool(params: A2UIToolParams) -> BaseTool:
    """Build an ADK tool that delegates A2UI surface generation to a subagent.

    Args:
        params: Shared ``A2UIToolParams`` (``model`` + behavior knobs). The
            toolkit owns the shape and fills defaults via
            ``resolve_a2ui_tool_params``; every framework adapter takes this
            exact params type, so a new knob reaches this adapter with no
            signature change. ``model`` is the ADK ``BaseLlm`` the subagent
            invokes for structured A2UI output.

    Returns:
        An ADK ``BaseTool`` ready to add to an ``LlmAgent``'s ``tools`` list.
    """
    cfg = resolve_a2ui_tool_params(params)
    return A2UISubAgentTool(cfg)


def is_auto_injected_a2ui_tool(tool: Any) -> bool:
    """True if ``tool`` is a ``generate_a2ui`` this adapter auto-injected."""
    return getattr(tool, _A2UI_AUTOINJECT_ATTR, False) is True


# ---------------------------------------------------------------------------
# Auto-inject decision
# ---------------------------------------------------------------------------


def _resolve_catalog_from_context(input: RunAgentInput) -> Optional[dict]:
    """Pull the A2UI catalog the middleware stamped into ``RunAgentInput.context``.

    Matches the schema entry by its exact description (the same byte-identical
    contract ``_state_view`` uses) and parses its JSON value. Returns ``None``
    when absent/unparseable — auto-injection then proceeds with a ``None``
    catalog (the tool also resolves the catalog from live session state at
    run time, so this is parity glue with the Strands adapter rather than the
    sole catalog source).
    """
    for entry in input.context or []:
        # Entries are pydantic Context models on the validated path, but this is
        # exported API — tolerate dict-shaped entries too (mirrors the adapter's
        # own context normalization).
        if isinstance(entry, dict):
            description = entry.get("description")
            value = entry.get("value")
        else:
            description = getattr(entry, "description", None)
            value = getattr(entry, "value", None)
        if description != A2UI_SCHEMA_CONTEXT_DESCRIPTION:
            continue
        if not value:
            logger.warning(
                "A2UI schema context entry has an empty value; "
                "catalog-aware recovery disabled."
            )
            continue
        if isinstance(value, dict):
            return value
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError) as err:
            logger.warning(
                "A2UI schema context entry present but unparseable; "
                "catalog-aware recovery disabled: %s",
                err,
            )
            continue
        if isinstance(parsed, dict):
            return parsed
        logger.warning(
            "A2UI schema context entry is valid JSON but not an object; "
            "catalog-aware recovery disabled (got %s)",
            type(parsed).__name__,
        )
    return None


def plan_a2ui_injection(
    *,
    model: Any,
    input: RunAgentInput,
    existing_tool_names: list,
    config: Optional[dict] = None,
    log: Optional[logging.Logger] = None,
) -> Optional[dict]:
    """Decide whether to auto-inject ``generate_a2ui`` for this run.

    Mirrors the Strands adapter's ``plan_a2ui_injection`` (and the LangGraph
    "no injectA2UITool, no injection" contract):

    1. Off unless the runtime forwarded ``injectA2UITool`` (``True``, or a
       string naming the injected RENDER tool to drop) OR a backend
       ``config["inject_a2ui_tool"]`` override.
    2. USER PREVAILS — a dev-wired ``generate_a2ui`` (already in
       ``existing_tool_names``) is never double-injected.
    3. No inferable model (e.g. a non-LlmAgent orchestrator root) -> warn + skip.
    4. Otherwise build the tool (threading the catalog + guidelines) and report
       the injected render proxy to drop from the frontend tools.

    ``model`` is the already-resolved framework model the sub-agent invokes (the
    ADKAgent passes the root ``LlmAgent.canonical_model``) — kept out of this
    pure decision so it stays framework-agnostic.

    Returns ``{"tool", "tool_name", "drop_tool_names", "catalog"}`` or ``None``.
    """
    log = log or logger
    config = config or {}

    # `forwarded_props` is Any on the wire; tolerate non-dict shapes.
    forwarded = (
        input.forwarded_props if isinstance(input.forwarded_props, dict) else {}
    )
    flag = forwarded.get("injectA2UITool")
    if flag is None:
        # Nullish fallback, mirroring the TS adapter's `??`: an explicit runtime
        # `injectA2UITool: false` disables injection even when the backend
        # config opts in.
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
            "the agent (a non-LlmAgent orchestrator root has no model). Skipping "
            "auto-injection — wire get_a2ui_tool() onto an LlmAgent explicitly."
        )
        return None

    render_tool_name = flag if isinstance(flag, str) else RENDER_A2UI_TOOL_NAME
    # Nullish (not falsy) fallback, mirroring the TS adapter's `??`.
    catalog = config.get("catalog")
    if catalog is None:
        catalog = _resolve_catalog_from_context(input)

    tool = get_a2ui_tool(
        {
            "model": model,
            "tool_name": tool_name,
            "catalog": catalog,
            "default_catalog_id": config.get("default_catalog_id"),
            "guidelines": config.get("guidelines"),
            "recovery": config.get("recovery"),
        }
    )
    setattr(tool, _A2UI_AUTOINJECT_ATTR, True)

    return {
        "tool": tool,
        "tool_name": tool_name,
        "drop_tool_names": [render_tool_name],
        "catalog": catalog,
    }
