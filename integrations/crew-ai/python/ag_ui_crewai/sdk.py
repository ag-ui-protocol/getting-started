"""
Streaming and state helpers (copilotkit_stream and related utilities) for the CrewAI AG-UI bridge.
"""

import copy
import logging
import uuid
from dataclasses import dataclass
from typing import (
  List,
  Any,
  Optional,
  Mapping,
  Dict,
  Literal,
  Sequence,
  TypedDict,
  Union,
)
from litellm.types.utils import (
  ModelResponse,
  Choices,
  Message as LiteLLMMessage,
  ChatCompletionMessageToolCall,
  Function as LiteLLMFunction
)
from litellm.litellm_core_utils.streaming_handler import CustomStreamWrapper
from crewai.flow.flow import FlowState
# The event bus moved from ``crewai.utilities.events`` (0.x) to
# ``crewai.events`` (1.x); ``_capabilities`` resolves whichever exists.
from ._capabilities import crewai_event_bus
from pydantic import BaseModel, Field, TypeAdapter
from ag_ui.core import EventType, Message
from .context import flow_context
from .events import (
  BridgedTextMessageChunkEvent,
  BridgedToolCallChunkEvent,
  BridgedToolCallResultEvent,
  BridgedCustomEvent,
  BridgedStateSnapshotEvent,
  BridgedReasoningStartEvent,
  BridgedReasoningMessageStartEvent,
  BridgedReasoningMessageContentEvent,
  BridgedReasoningMessageEndEvent,
  BridgedReasoningEndEvent,
  BridgedReasoningEncryptedValueEvent,
)
from ._reasoning import reasoning_from_delta
from .utils import yield_control, convert_litellm_multimodal_to_agui

_LOGGER = logging.getLogger(__name__)

class CopilotKitProperties(BaseModel):
    """CopilotKit properties"""
    actions: List[Any] = Field(default_factory=list)

class CopilotKitState(FlowState):
    """CopilotKit state"""
    messages: List[Any] = Field(default_factory=list)
    copilotkit: CopilotKitProperties = Field(default_factory=CopilotKitProperties)

class PredictStateConfig(TypedDict):
    """
    Predict State Config
    """
    tool_name: str
    tool_argument: Optional[str]


@dataclass(frozen=True)
class StateItem:
    """A predicted-state binding: stream ``tool``'s ``tool_argument`` into ``state_key``.

    ``tool_argument=None`` streams the whole tool-call argument object. Mirrors
    the LangGraph ``StateItem`` vocabulary.
    """
    state_key: str
    tool: str
    tool_argument: Optional[str] = None


# Per-node suppression flags stashed on the running Flow (visible via
# flow_context in the hooks and as ``source`` in the endpoint listener).
# Underscore-prefixed to avoid clashing with real Flow fields.
_PREDICT_STATE_TOOLS_ATTR = "_ag_ui_predict_state_tools"
_PREDICTED_TOOL_STREAMED_ATTR = "_ag_ui_predicted_tool_streamed"
_MANUAL_STATE_EMITTED_ATTR = "_ag_ui_manual_state_emitted"


def _record_predicted_tools(flow: Any, tools: "set[str]") -> None:
    """Record the tools that predict state for this node.

    Unions so two predict_state calls in one node both take effect.
    """
    if flow is not None:
        existing = getattr(flow, _PREDICT_STATE_TOOLS_ATTR, None) or set()
        setattr(flow, _PREDICT_STATE_TOOLS_ATTR, existing | set(tools))


def _mark_predicted_tool_streamed(flow: Any, tool_name: Optional[str]) -> None:
    """Flag that a predicted tool actually streamed.

    Suppression only fires when the tool is genuinely invoked, so a node that
    declared predict_state but took another branch still emits its snapshot.
    """
    if flow is None or not tool_name:
        return
    predicted = getattr(flow, _PREDICT_STATE_TOOLS_ATTR, None)
    if predicted and tool_name in predicted:
        setattr(flow, _PREDICTED_TOOL_STREAMED_ATTR, True)


def _mark_manual_state_emitted(flow: Any) -> None:
    """Flag that ``copilotkit_emit_state`` published an authoritative snapshot."""
    if flow is not None:
        setattr(flow, _MANUAL_STATE_EMITTED_ATTR, True)


def reset_node_snapshot_suppression(flow: Any) -> None:
    """Clear the per-node suppression flags at node entry.

    Guards against a node that declared predict_state then raised (leaving a
    stale tool set) suppressing the next node's snapshot. Flags live on the
    single flow, so under parallel fan-out branches they are best-effort; the
    terminal FlowFinished snapshot still guarantees a correct final state.
    """
    if flow is None:
        return
    setattr(flow, _PREDICTED_TOOL_STREAMED_ATTR, False)
    setattr(flow, _MANUAL_STATE_EMITTED_ATTR, False)
    setattr(flow, _PREDICT_STATE_TOOLS_ATTR, set())


def consume_node_exit_snapshot_suppression(flow: Any) -> bool:
    """Whether this node's auto STATE_SNAPSHOT should be suppressed; resets the flags.

    Suppressed when a predicted tool streamed or a manual snapshot was emitted,
    so the node-exit rebuild from flow.state doesn't wipe what the client is
    already showing. A later node's snapshot, or the terminal FlowFinished
    snapshot, still delivers the authoritative flow.state.
    """
    if flow is None:
        return False
    predicted = getattr(flow, _PREDICTED_TOOL_STREAMED_ATTR, False)
    manual = getattr(flow, _MANUAL_STATE_EMITTED_ATTR, False)
    setattr(flow, _PREDICTED_TOOL_STREAMED_ATTR, False)
    setattr(flow, _MANUAL_STATE_EMITTED_ATTR, False)
    setattr(flow, _PREDICT_STATE_TOOLS_ATTR, set())
    return bool(predicted or manual)


def _normalize_predict_state(
        config: Union[Mapping[str, PredictStateConfig], Sequence[StateItem]]
    ) -> List[Dict[str, Any]]:
    """Normalize either supported ``predict_state`` shape to the wire form.

    Accepts the historical mapping form (``{state_key: {tool_name, tool_argument}}``)
    and a sequence of :class:`StateItem`. ``tool_argument`` is optional in
    both shapes.
    """
    if isinstance(config, Mapping):
        return [
            {
                "state_key": k,
                "tool": v["tool_name"],
                "tool_argument": v.get("tool_argument"),
            }
            for k, v in config.items()
        ]
    return [
        {
            "state_key": item.state_key,
            "tool": item.tool,
            "tool_argument": item.tool_argument,
        }
        for item in config
    ]


async def copilotkit_predict_state(
        config: Union[Mapping[str, PredictStateConfig], Sequence[StateItem]]
    ) -> Literal[True]:
    """
    Stream tool calls as state to CopilotKit.

    To emit a tool call as streaming CrewAI state, pass the destination key in state,
    the tool name and optionally the tool argument. (If you don't pass the argument name,
    all arguments are emitted under the state key.)

    ```python
    from ag_ui_crewai import copilotkit_predict_state

    await copilotkit_predict_state(
        {
            "steps": {
                "tool_name": "SearchTool",
                "tool_argument": "steps",
            },
        }
    )
    ```

    ``copilotkit_predict_state`` must be called inside the same flow node
    that streams the predicted tool call; the prediction binding is scoped to
    that node.

    A sequence of :class:`StateItem` is also accepted, matching the LangGraph
    shared-state vocabulary:

    ```python
    await copilotkit_predict_state([
        StateItem(state_key="steps", tool="SearchTool", tool_argument="steps"),
    ])
    ```

    Parameters
    ----------
    config : Mapping[str, PredictStateConfig] | Sequence[StateItem]
        The configuration to predict the state.

    Returns
    -------
    Awaitable[bool]
        Always return True.
    """
    flow = flow_context.get(None)

    value = _normalize_predict_state(config)

    # So the streaming layer can tell when a predicted tool actually fires.
    _record_predicted_tools(flow, {item["tool"] for item in value})

    crewai_event_bus.emit(
        flow,
        BridgedCustomEvent(
            type=EventType.CUSTOM,
            name="PredictState",
            value=value
        )
    )

    await yield_control()

    return True

async def copilotkit_emit_state(state: Any) -> Literal[True]:
    """
    Emits intermediate state to CopilotKit.
    Useful if you have a longer running node and you want to update the user with the current state of the node.

    ### Examples

    ```python
    from ag_ui_crewai import copilotkit_emit_state

    for i in range(10):
        await some_long_running_operation(i)
        await copilotkit_emit_state({"progress": i})
    ```

    The emitted payload streams to the client immediately and the node-exit
    snapshot is suppressed so it is not clobbered mid-run. At run end the state
    is rebuilt from ``flow.state``, so anything that must persist beyond the run
    should be written there, not only emitted.

    Parameters
    ----------
    state : Any
        The state to emit (Must be JSON serializable).

    Returns
    -------
    Awaitable[bool]
        Always return True.

    """
    flow = flow_context.get(None)

    # Suppress the node-exit snapshot so this payload is not clobbered mid-run.
    _mark_manual_state_emitted(flow)

    # Deep-copy: callers often emit the live flow state and keep mutating it, so
    # snapshot a point-in-time copy before it is queued.
    crewai_event_bus.emit(
        flow,
        BridgedStateSnapshotEvent(
            type=EventType.STATE_SNAPSHOT,
            snapshot=copy.deepcopy(state)
        )
    )

    await yield_control()

    return True

async def copilotkit_stream(response):
    """
    Stream litellm responses token by token to CopilotKit.

    ```python
    response = await copilotkit_stream(
        await acompletion(
            model="openai/gpt-4o",
            messages=messages,
            tools=tools,
            stream=True # this must be set to True for streaming
        )
    )
    ```
    """
    if isinstance(response, ModelResponse):
        return _copilotkit_stream_response(response)
    if isinstance(response, CustomStreamWrapper):
        return await _copilotkit_stream_custom_stream_wrapper(response)
    raise ValueError(
        f"Invalid response type {type(response)!r}; "
        f"expected {ModelResponse.__name__} or {CustomStreamWrapper.__name__}"
    )


async def _copilotkit_stream_custom_stream_wrapper(response: CustomStreamWrapper):
    flow = flow_context.get(None)

    message_id: Optional[str] = None
    content = ""
    created = 0
    model = ""
    system_fingerprint = ""
    finish_reason=None
    # Route tool-call deltas by their OpenAI ``.index`` so parallel calls stay
    # separate; keyed in arrival order so the final reassembly preserves it.
    # A provider that omits ``.index`` falls back to last-call routing below.
    tool_calls_by_index: Dict[Any, Dict[str, Any]] = {}
    last_tool_key: Any = None
    auto_key = 0

    # Reasoning lifecycle. Reasoning tokens (delta.reasoning_content /
    # delta.thinking_blocks) precede the answer; open a reasoning message on the
    # first reasoning delta and close it once the model emits answer text or a
    # tool call (or the stream ends).
    reasoning_message_id: Optional[str] = None
    reasoning_open = False

    def _close_reasoning():
        nonlocal reasoning_open, reasoning_message_id
        if not reasoning_open:
            return
        crewai_event_bus.emit(
            flow,
            BridgedReasoningMessageEndEvent(
                type=EventType.REASONING_MESSAGE_END,
                message_id=reasoning_message_id,
            ),
        )
        crewai_event_bus.emit(
            flow,
            BridgedReasoningEndEvent(
                type=EventType.REASONING_END,
                message_id=reasoning_message_id,
            ),
        )
        reasoning_open = False
        reasoning_message_id = None

    try:
      async for chunk in response:
        if message_id is None:
            message_id = chunk["id"]

        # Providers (Azure, or an ``include_usage`` final chunk) can emit a
        # trailing chunk with an empty ``choices`` list; skip it rather than
        # IndexError on ``choices[0]``.
        choices = chunk["choices"] or None
        if choices is None:
            continue
        choice = choices[0]
        delta = choice["delta"]

        # Stream reasoning tokens (provider-agnostic via litellm normalisation).
        reasoning = reasoning_from_delta(delta)
        if reasoning:
            if not reasoning_open:
                reasoning_message_id = str(uuid.uuid4())
                crewai_event_bus.emit(
                    flow,
                    BridgedReasoningStartEvent(
                        type=EventType.REASONING_START,
                        message_id=reasoning_message_id,
                    ),
                )
                crewai_event_bus.emit(
                    flow,
                    BridgedReasoningMessageStartEvent(
                        type=EventType.REASONING_MESSAGE_START,
                        message_id=reasoning_message_id,
                        role="reasoning",
                    ),
                )
                reasoning_open = True
            if reasoning.text:
                crewai_event_bus.emit(
                    flow,
                    BridgedReasoningMessageContentEvent(
                        type=EventType.REASONING_MESSAGE_CONTENT,
                        message_id=reasoning_message_id,
                        delta=reasoning.text,
                    ),
                )
            for value in reasoning.encrypted:
                crewai_event_bus.emit(
                    flow,
                    BridgedReasoningEncryptedValueEvent(
                        type=EventType.REASONING_ENCRYPTED_VALUE,
                        subtype="message",
                        entity_id=reasoning_message_id,
                        encrypted_value=value,
                    ),
                )
            await yield_control()

        text_content = delta["content"] or None

        # Stream text messages
        if text_content is not None:
            # Reasoning is done once the answer starts.
            _close_reasoning()
            # add to the current text message
            content += text_content
            crewai_event_bus.emit(
                flow,
                BridgedTextMessageChunkEvent(
                    type=EventType.TEXT_MESSAGE_CHUNK,
                    message_id=message_id,
                    role="assistant",
                    delta=text_content,
                )
            )
            # yield control to the event loop
            await yield_control()

        # Stream tool calls (index-routed, one bridged chunk per arg delta)
        tool_calls = delta["tool_calls"] or None
        if tool_calls is not None:
            # Reasoning is done once the model calls a tool.
            _close_reasoning()
            for tool_call in tool_calls:
                delta_id = getattr(tool_call, "id", None)
                delta_name = tool_call.function["name"]
                delta_arguments = tool_call.function["arguments"]

                # Resolve which accumulating call this delta belongs to.
                index = getattr(tool_call, "index", None)
                last_entry = tool_calls_by_index.get(last_tool_key)
                if index is not None:
                    existing = tool_calls_by_index.get(index)
                    if (
                        delta_id is not None
                        and existing is not None
                        and existing.get("id") not in (None, delta_id)
                    ):
                        # A different id reusing this index is a NEW call, not a
                        # continuation: keep the calls separate so neither is
                        # overwritten and their arguments do not merge.
                        key = ("auto", auto_key)
                        auto_key += 1
                    else:
                        key = index
                elif delta_id is not None and last_entry is not None \
                        and last_entry.get("id") == delta_id:
                    # No index, but this delta re-echoes the current call's id:
                    # a continuation, not a new call.
                    key = last_tool_key
                elif delta_id is not None and (
                    last_entry is None or last_entry.get("id") is not None
                ):
                    # No index, a new id: a genuinely new call.
                    key = ("auto", auto_key)
                    auto_key += 1
                else:
                    # No index, no new id: continue the current call. Covers
                    # argument-only deltas and the id-bearing delta of a call
                    # whose args streamed first (empty accumulator, no IndexError).
                    key = last_tool_key
                last_tool_key = key

                entry = tool_calls_by_index.get(key)
                if entry is None:
                    entry = {
                        "id": delta_id, "name": delta_name,
                        "arguments": "", "streamed": False,
                    }
                    tool_calls_by_index[key] = entry
                else:
                    # id/name can arrive on a later delta than the first.
                    if delta_id is not None:
                        entry["id"] = delta_id
                    if delta_name is not None:
                        entry["name"] = delta_name

                # Mark on whichever delta carries the name (some providers stream
                # id and name separately), not only the id-bearing one.
                if delta_name is not None:
                    _mark_predicted_tool_streamed(flow, delta_name)

                if delta_arguments is not None:
                    entry["arguments"] += delta_arguments

                # Emit only once the call has BOTH an id and a name: the triples
                # shaper needs both to open a TOOL_CALL_START, and it stamps the
                # accumulated id/name on every chunk so a provider that streams
                # identity or arguments out of order still produces a valid stream.
                if entry["id"] is None or entry["name"] is None:
                    continue
                if not entry["streamed"]:
                    # First wire chunk for this call: stream the arguments
                    # accumulated so far (fragments that arrived before the
                    # id/name), so the live TOOL_CALL_ARGS match the final
                    # ModelResponse instead of losing the prefix.
                    entry["streamed"] = True
                    delta_out = entry["arguments"] or None
                elif delta_arguments is not None:
                    delta_out = delta_arguments
                else:
                    # Identity-only continuation with no new args: nothing to send.
                    continue
                crewai_event_bus.emit(
                    flow,
                    BridgedToolCallChunkEvent(
                        type=EventType.TOOL_CALL_CHUNK,
                        tool_call_id=entry["id"],
                        tool_call_name=entry["name"],
                        # Associate the streamed tool call with THIS assistant
                        # message so the client keeps it in place when the terminal
                        # MESSAGES_SNAPSHOT re-sends the message.
                        parent_message_id=message_id,
                        delta=delta_out,
                    )
                )
                # yield control to the event loop
                await yield_control()

        # Stream finish reason
        finish_reason = choice["finish_reason"]
        created = chunk["created"]
        model = chunk["model"]
        system_fingerprint = chunk["system_fingerprint"]

        if finish_reason is not None:
            break
    finally:
        # Close a reasoning message left open by a stream that carried only
        # reasoning, ended before any answer text / tool call, or raised
        # mid-reasoning.
        _close_reasoning()

    incomplete = [
        e for e in tool_calls_by_index.values()
        if e["id"] is None or e["name"] is None
    ]
    if incomplete:
        _LOGGER.error(
            "ag-ui-crewai dropped %d incomplete tool call(s) that never received "
            "both an id and a name",
            len(incomplete),
        )
    tool_calls = [
        ChatCompletionMessageToolCall(
            function=LiteLLMFunction(
                arguments=tool_call["arguments"],
                name=tool_call["name"]
            ),
            id=tool_call["id"],
            type="function"
        )
        # Insertion order preserves the provider's ordering; keys are
        # heterogeneous so are not sortable. Skip any call that never received both
        # an id and a name (it never reached the wire either).
        for tool_call in tool_calls_by_index.values()
        if tool_call["id"] is not None and tool_call["name"] is not None
    ]
    return ModelResponse(
        id=message_id,
        created=created,
        model=model,
        object='chat.completion',
        system_fingerprint=system_fingerprint,
        choices=[
            Choices(
                finish_reason=finish_reason,
                index=0,
                message=LiteLLMMessage(
                    content=content,
                    role='assistant',
                    tool_calls=tool_calls if len(tool_calls) > 0 else None,
                    function_call=None
                )
            )
        ]
    )

def _copilotkit_stream_response(response: ModelResponse):
    return response


message_adapter = TypeAdapter(Message)

def litellm_messages_to_ag_ui_messages(messages: List[LiteLLMMessage]) -> List[Message]:
    """
    Converts a list of LiteLLM messages to a list of ag_ui messages.
    """
    ag_ui_messages: List[Message] = []
    for message in messages:
        message_dict = message.model_dump() if not isinstance(message, Mapping) else message

        # whitelist the fields we want to keep
        whitelist = ["content", "role", "tool_calls", "id", "name", "tool_call_id"]
        message_dict = {k: v for k, v in message_dict.items() if k in whitelist}
        # Backfill when id is absent OR explicitly None: the None-strip below
        # would drop a None id, and pydantic Message validation requires one.
        if message_dict.get("id") is None:
            message_dict["id"] = str(uuid.uuid4())
        # remove all None values
        message_dict = {k: v for k, v in message_dict.items() if v is not None}

        # List content is stored in LiteLLM's image_url shape; convert back to
        # AG-UI parts so the Message validator accepts it (else the snapshot drops).
        if isinstance(message_dict.get("content"), list):
            message_dict["content"] = convert_litellm_multimodal_to_agui(message_dict["content"])

        if "tool_calls" in message_dict:
            # The whitelist comprehension is a shallow copy, so this list and
            # its dicts are still the caller's (e.g. the flow-state) objects.
            # Deep-copy before stamping ``type`` so we don't mutate them in place.
            message_dict["tool_calls"] = copy.deepcopy(message_dict["tool_calls"])
            for tool_call in message_dict["tool_calls"]:
                if "type" not in tool_call:
                    tool_call["type"] = "function"

        ag_ui_message = message_adapter.validate_python(message_dict)
        ag_ui_messages.append(ag_ui_message)

    return ag_ui_messages


async def copilotkit_exit() -> Literal[True]:
    """
    Exits the current agent after the run completes. Calling copilotkit_exit() will
    not immediately stop the agent. Instead, it signals to CopilotKit to stop the agent after
    the run completes.

    ### Examples

    ```python
    from ag_ui_crewai.sdk import copilotkit_exit

    async def my_function():
        await copilotkit_exit()
        return state
    ```

    Returns
    -------
    Awaitable[bool]
        Always return True.
    """

    flow = flow_context.get(None)

    crewai_event_bus.emit(
        flow,
        BridgedCustomEvent(
            type=EventType.CUSTOM,
            name="Exit",
            value=""
        )
    )

    await yield_control()

    return True


async def copilotkit_emit_tool_result(
    tool_call_id: str,
    content: str,
    *,
    message_id: Optional[str] = None,
) -> Literal[True]:
    """Emit a TOOL_CALL_RESULT event for a tool the flow executed itself.

    ``copilotkit_stream`` streams the model's tool CALL (chunks); it does not
    emit the RESULT of a backend tool the flow runs. Middlewares that key off
    TOOL_CALL_RESULT (e.g. the A2UI middleware detecting an ``a2ui_operations``
    envelope, or closing an outer tool call in render order) need it, so a flow
    node calls this right after it appends the tool-result message to state.
    """
    flow = flow_context.get(None)

    crewai_event_bus.emit(
        flow,
        BridgedToolCallResultEvent(
            type=EventType.TOOL_CALL_RESULT,
            message_id=message_id or str(uuid.uuid4()),
            tool_call_id=tool_call_id,
            content=content,
            role="tool",
        ),
    )

    await yield_control()

    return True