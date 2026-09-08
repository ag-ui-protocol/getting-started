# src/ag_ui_adk/client_proxy_tool.py

"""Client-side proxy tool implementation for AG-UI protocol tools."""

import asyncio
import json
import uuid
import inspect
from typing import Any, Optional, List, Dict, Set
import logging

from google.adk.tools import BaseTool, LongRunningFunctionTool
from google.genai import types
from ag_ui.core import Tool as AGUITool, EventType
from ag_ui.core import (
    ToolCallStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    CustomEvent,
)

from .config import PredictStateMapping
from .serialization import serialize_tool_args

logger = logging.getLogger(__name__)


# Build an allowlist of keys accepted by google.genai.types.Schema,
# including both snake_case field names and their camelCase aliases.
# This is more robust than a denylist — new JSON Schema fields that
# aren't in genai.Schema are automatically filtered without maintenance.
try:
    from google.genai._common import alias_generators
    _ALLOWED_SCHEMA_KEYS = frozenset(
        set(types.Schema.model_fields.keys())
        | {alias_generators.to_camel(f) for f in types.Schema.model_fields}
    )
except (ImportError, AttributeError):
    # Fallback if genai internals change — use a static allowlist
    _ALLOWED_SCHEMA_KEYS = frozenset({
        "type", "format", "description", "nullable", "enum", "example",
        "items", "properties", "required", "default", "title", "pattern",
        "minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength",
        "minProperties", "maxProperties", "anyOf",
        "ref", "defs", "propertyOrdering",
    })


# Keys that ``google.genai.types.Schema`` accepts as model fields (so the
# allowlist above keeps them) but the Gemini ``generateContent`` function-calling
# API rejects with a 400 ("Unknown name ... Cannot find field"). They must be
# stripped explicitly. ``zod-to-json-schema`` (used by CopilotKit / AG-UI
# frontend tools) emits ``additionalProperties: false`` on every object, so any
# client-supplied tool trips this — manifesting as a RUN_ERROR and no tool call
# reaching the UI. See ag-ui-protocol/ag-ui HITL dojo "nothing renders" report.
_GENAI_REJECTED_SCHEMA_KEYS = frozenset({
    "additionalProperties", "additional_properties",
})


def _clean_schema_for_genai(schema: Any) -> Any:
    """Recursively clean a JSON Schema dict for google.genai.types.Schema.

    Transformations:
    1. Strip ``$``-prefixed keys (``$schema``, ``$id``, ``$ref``, ``$defs``,
       ``$comment``) — these are JSON Schema infrastructure, never in genai.
    2. Map ``examples`` → ``example`` (first element only), ``const`` →
       ``enum`` (single-value list), and ``oneOf`` → ``anyOf`` (genai accepts
       ``anyOf`` but not ``oneOf``), preserving useful structure.
    3. Filter remaining keys to only those accepted by ``types.Schema``,
       using an allowlist derived from ``types.Schema.model_fields``.
    """
    if isinstance(schema, dict):
        result = {}
        for k, v in schema.items():
            # Always strip $-prefixed keys
            if k.startswith("$"):
                continue
            # Strip keys the Gemini API rejects even though genai.Schema accepts
            # them as model fields (e.g. additionalProperties from zod schemas).
            if k in _GENAI_REJECTED_SCHEMA_KEYS:
                continue
            # Map examples -> example (preserve first element as opaque data)
            if k == "examples" and isinstance(v, list) and v:
                result["example"] = v[0]
                continue
            # Map const -> enum (single-value list, stringified for genai)
            if k == "const":
                result["enum"] = [v if isinstance(v, str) else json.dumps(v)]
                continue
            # Map oneOf -> anyOf. genai.types.Schema accepts ``anyOf`` but not
            # ``oneOf``, so an unmapped ``oneOf`` would be dropped by the
            # allowlist below — silently erasing the structure of discriminated
            # unions (zod ``discriminatedUnion`` serializes to ``oneOf`` via
            # zod-to-json-schema, used by CopilotKit / AG-UI frontend tools).
            # For tool-argument schemas the distinction is immaterial: the model
            # emits exactly one branch either way.
            if k == "oneOf":
                result["anyOf"] = _clean_schema_for_genai(v)
                continue
            # Only keep keys that genai.types.Schema accepts
            if k not in _ALLOWED_SCHEMA_KEYS:
                continue
            # "properties" and "defs" are dict-of-schemas — recurse into
            # values but preserve the user-defined keys (property names).
            if k in ("properties", "defs") and isinstance(v, dict):
                result[k] = {
                    prop_name: _clean_schema_for_genai(prop_schema)
                    for prop_name, prop_schema in v.items()
                }
            # "default", "example", "enum" are opaque values — don't recurse
            elif k in ("default", "example", "enum"):
                result[k] = v
            else:
                result[k] = _clean_schema_for_genai(v)
        return result
    if isinstance(schema, list):
        return [_clean_schema_for_genai(item) for item in schema]
    return schema


class ClientProxyTool(BaseTool):
    """A proxy tool that bridges AG-UI protocol tools to ADK.

    This tool appears as a normal ADK tool to the agent, but when executed,
    it emits AG-UI protocol events and waits for the client to execute
    the actual tool and return results.

    Internally wraps LongRunningFunctionTool for proper ADK behavior.
    """

    def __init__(
        self,
        ag_ui_tool: AGUITool,
        event_queue: asyncio.Queue,
        predict_state_mappings: Optional[List[PredictStateMapping]] = None,
        emitted_predict_state: Optional[Set[str]] = None,
        accumulated_predict_state: Optional[Dict[str, Any]] = None,
        emitted_tool_call_ids: Optional[Set[str]] = None,
        translator_emitted_tool_call_ids: Optional[Set[str]] = None,
        long_running_tool_ids: Optional[Set[str]] = None,
        translator_lro_emitted_ids_by_name: Optional[Dict[str, List[str]]] = None,
        lro_finalized_by_name: Optional[Dict[str, int]] = None,
    ):
        """Initialize the client proxy tool.

        Args:
            ag_ui_tool: The AG-UI tool definition
            event_queue: Queue to emit AG-UI events
            predict_state_mappings: Configuration for predictive state updates.
                When provided and this tool has a matching mapping, a PredictState
                CustomEvent will be emitted before TOOL_CALL_START.
            emitted_predict_state: Shared set tracking which tools have had
                PredictState emitted. Typically owned by ClientProxyToolset.
            accumulated_predict_state: Shared dict for accumulating predictive state
                values from tool args. Merged into final STATE_SNAPSHOT.
            emitted_tool_call_ids: Shared set tracking tool call IDs that this proxy
                has already emitted TOOL_CALL events for. Used by EventTranslator to
                suppress duplicate emissions from ADK confirmed/LRO events.
            translator_emitted_tool_call_ids: Shared set of tool call IDs already
                emitted by EventTranslator. Checked before emitting to avoid duplicates.
            long_running_tool_ids: Shared set of tool call IDs that represent
                HITL (long-running) tool calls. Populated synchronously before
                TOOL_CALL_START is enqueued so the consumer can persist
                pending_tool_calls only for HITL IDs. See issue #1652.
        """
        # Initialize BaseTool with name and description
        # All client-side tools are long-running for architectural simplicity
        super().__init__(
            name=ag_ui_tool.name,
            description=ag_ui_tool.description,
            is_long_running=True
        )

        self.ag_ui_tool = ag_ui_tool
        self.event_queue = event_queue
        self.predict_state_mappings = predict_state_mappings or []
        self._emitted_predict_state = emitted_predict_state if emitted_predict_state is not None else set()
        self._accumulated_predict_state = accumulated_predict_state if accumulated_predict_state is not None else {}
        self._emitted_tool_call_ids = emitted_tool_call_ids if emitted_tool_call_ids is not None else set()
        self._translator_emitted_tool_call_ids = translator_emitted_tool_call_ids if translator_emitted_tool_call_ids is not None else set()
        self._long_running_tool_ids = long_running_tool_ids if long_running_tool_ids is not None else set()
        self._translator_lro_emitted_ids_by_name = translator_lro_emitted_ids_by_name if translator_lro_emitted_ids_by_name is not None else {}
        self._lro_finalized_by_name = lro_finalized_by_name if lro_finalized_by_name is not None else {}

        # Create dynamic function with proper parameter signatures for ADK inspection
        # This allows ADK to extract parameters from user requests correctly
        sig_params = []

        # Extract parameters from AG-UI tool schema
        parameters = ag_ui_tool.parameters
        if isinstance(parameters, dict) and 'properties' in parameters:
            for param_name in parameters['properties'].keys():
                # Create parameter with proper type annotation
                sig_params.append(
                    inspect.Parameter(
                        param_name,
                        inspect.Parameter.KEYWORD_ONLY,
                        default=None,
                        annotation=Any
                    )
                )

        # Create the async function that will be wrapped by LongRunningFunctionTool
        async def proxy_tool_func(**kwargs) -> Any:
            # Access the original args and tool_context that were stored in run_async
            original_args = getattr(self, '_current_args', kwargs)
            original_tool_context = getattr(self, '_current_tool_context', None)
            return await self._execute_proxy_tool(original_args, original_tool_context)

        # Set the function name, docstring, and signature to match the AG-UI tool
        proxy_tool_func.__name__ = ag_ui_tool.name
        proxy_tool_func.__doc__ = ag_ui_tool.description

        # Create new signature with extracted parameters
        if sig_params:
            proxy_tool_func.__signature__ = inspect.Signature(sig_params)

        # Create the internal LongRunningFunctionTool for proper behavior
        self._long_running_tool = LongRunningFunctionTool(proxy_tool_func)

    def _get_declaration(self) -> Optional[types.FunctionDeclaration]:
        """Create FunctionDeclaration from AG-UI tool parameters.

        We override this instead of delegating to the wrapped tool because
        the ADK's automatic function calling has difficulty parsing our
        dynamically created function signature without proper type annotations.
        """
        logger.debug(f"_get_declaration called for {self.name}")
        logger.debug(f"AG-UI tool parameters: {self.ag_ui_tool.parameters}")

        # Convert AG-UI parameters (JSON Schema) to ADK format
        parameters = self.ag_ui_tool.parameters


        # Ensure it's a proper object schema
        if not isinstance(parameters, dict):
            parameters = {"type": "object", "properties": {}}
            logger.warning(f"Tool {self.name} had non-dict parameters, using empty schema")

        # Clean JSON Schema for genai.types.Schema compatibility:
        # strips $-prefixed keys, maps examples->example and const->enum,
        # filters to only genai-accepted fields via allowlist.
        parameters = _clean_schema_for_genai(parameters)

        # Create FunctionDeclaration
        function_declaration = types.FunctionDeclaration(
            name=self.name,
            description=self.description,
            parameters=types.Schema.model_validate(parameters)
        )
        logger.debug(f"Created FunctionDeclaration for {self.name}: {function_declaration}")
        return function_declaration

    async def run_async(
        self,
        *,
        args: dict[str, Any],
        tool_context: Any
    ) -> Any:
        """Execute the tool by delegating to the internal LongRunningFunctionTool.

        Args:
            args: The arguments for the tool call
            tool_context: The ADK tool context

        Returns:
            None for long-running tools (client handles execution)
        """
        # Store args and context for proxy function access
        self._current_args = args
        self._current_tool_context = tool_context

        # Delegate to the wrapped long-running tool
        return await self._long_running_tool.run_async(args=args, tool_context=tool_context)

    async def _execute_proxy_tool(self, args: Dict[str, Any], tool_context: Any) -> Any:
        """Execute the proxy tool logic - emit events and return None.

        Args:
            args: Tool arguments from ADK
            tool_context: ADK tool context

        Returns:
            None for long-running tools
        """
        logger.debug(f"Proxy tool execution: {self.ag_ui_tool.name}")
        logger.debug(f"Arguments received: {args}")
        logger.debug(f"Tool context type: {type(tool_context)}")

        # Extract ADK-generated function call ID if available
        adk_function_call_id = None
        if tool_context and hasattr(tool_context, 'function_call_id'):
            adk_function_call_id = tool_context.function_call_id
            logger.debug(f"Using ADK function_call_id: {adk_function_call_id}")

        # Use ADK ID if available, otherwise fall back to generated ID
        tool_call_id = adk_function_call_id or f"call_{uuid.uuid4().hex[:8]}"
        if not adk_function_call_id:
            logger.warning(f"ADK function_call_id not available, generated: {tool_call_id}")

        try:
            # Skip emission if EventTranslator already emitted events for this tool call ID.
            # This happens when ADK emits the function call event before executing the tool —
            # the translator processes the event first, then ADK runs this proxy tool.
            if tool_call_id in self._translator_emitted_tool_call_ids:
                logger.debug(f"Skipping TOOL_CALL emission for {tool_call_id} — already emitted by EventTranslator")
                return None

            # Cross-path twin suppression: under SSE streaming the translator
            # emits this long-running call from the *partial* event with one ID
            # and ADK then invokes this proxy with a *different* ID (#1168), so
            # the ID guard above can't recognize them as the same logical call —
            # the dojo then renders the HITL card twice. Match this invocation to
            # an already-emitted partial by tool name, positionally (FIFO), so
            # genuinely parallel same-name calls each still emit once.
            emitted_partials = self._translator_lro_emitted_ids_by_name.get(self.name, [])
            finalized = self._lro_finalized_by_name.get(self.name, 0)
            if finalized < len(emitted_partials):
                self._lro_finalized_by_name[self.name] = finalized + 1
                logger.debug(
                    f"Skipping proxy TOOL_CALL emission for '{self.name}' — twin of "
                    f"streamed partial {emitted_partials[finalized]} (proxy id {tool_call_id})"
                )
                return None

            # Check if this tool has predictive state configuration
            # Emit PredictState CustomEvent BEFORE TOOL_CALL_START (once per tool name)
            mappings_for_tool = [m for m in self.predict_state_mappings if m.tool == self.name]
            logger.debug(f"PredictState check for '{self.name}': mappings_count={len(self.predict_state_mappings)}, matches={len(mappings_for_tool)}, already_emitted={self.name in self._emitted_predict_state}")
            if mappings_for_tool and self.name not in self._emitted_predict_state:
                predict_state_payload = [m.to_payload() for m in mappings_for_tool]
                predict_event = CustomEvent(
                    type=EventType.CUSTOM,
                    name="PredictState",
                    value=predict_state_payload
                )
                await self.event_queue.put(predict_event)
                self._emitted_predict_state.add(self.name)
                logger.debug(f"Emitted PredictState CustomEvent for tool '{self.name}': {predict_state_payload}")

            # Mark this tool call as HITL/long-running BEFORE enqueuing any
            # TOOL_CALL_* event so the consumer's gate sees it when it later
            # dequeues TOOL_CALL_END. All ClientProxyTool emissions are
            # long-running (is_long_running=True at construction). See #1652.
            self._long_running_tool_ids.add(tool_call_id)

            # Emit TOOL_CALL_START event
            start_event = ToolCallStartEvent(
                type=EventType.TOOL_CALL_START,
                tool_call_id=tool_call_id,
                tool_call_name=self.ag_ui_tool.name
            )
            await self.event_queue.put(start_event)
            logger.debug(f"Emitted TOOL_CALL_START for {tool_call_id}")

            # Emit TOOL_CALL_ARGS event
            args_json = serialize_tool_args(args)
            args_event = ToolCallArgsEvent(
                type=EventType.TOOL_CALL_ARGS,
                tool_call_id=tool_call_id,
                delta=args_json
            )
            await self.event_queue.put(args_event)
            logger.debug(f"Emitted TOOL_CALL_ARGS for {tool_call_id}")

            # Accumulate predictive state values from tool args
            # These are merged into the final STATE_SNAPSHOT to ensure they survive
            # (otherwise the final STATE_SNAPSHOT would overwrite all state)
            if mappings_for_tool:
                for mapping in mappings_for_tool:
                    if mapping.tool_argument and mapping.tool_argument in args:
                        self._accumulated_predict_state[mapping.state_key] = args[mapping.tool_argument]
                        logger.debug(f"Accumulated predict_state: {mapping.state_key}={type(args[mapping.tool_argument]).__name__}")
                    elif not mapping.tool_argument:
                        self._accumulated_predict_state[mapping.state_key] = args
                        logger.debug(f"Accumulated predict_state: {mapping.state_key}=<entire args>")

            # Emit TOOL_CALL_END event
            end_event = ToolCallEndEvent(
                type=EventType.TOOL_CALL_END,
                tool_call_id=tool_call_id
            )
            await self.event_queue.put(end_event)
            logger.debug(f"Emitted TOOL_CALL_END for {tool_call_id}")

            # Record this ID so EventTranslator can suppress duplicate emissions
            # from ADK's confirmed/LRO events for the same function call
            self._emitted_tool_call_ids.add(tool_call_id)

            # Return None for long-running tools - client handles the actual execution
            logger.debug(f"Returning None for long-running tool {tool_call_id}")
            return None

        except Exception as e:
            logger.error(f"Error in proxy tool execution for {tool_call_id}: {e}")
            raise

    def __repr__(self) -> str:
        """String representation of the proxy tool."""
        return f"ClientProxyTool(name='{self.name}', ag_ui_tool='{self.ag_ui_tool.name}')"