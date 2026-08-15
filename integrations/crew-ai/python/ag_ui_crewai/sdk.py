"""
Streaming and state helpers (copilotkit_stream and related utilities) for the CrewAI AG-UI bridge.
"""

import copy
import inspect
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
from ._reasoning import (
  DeltaReasoning,
  reasoning_from_delta,
  reasoning_from_responses_event,
  responses_event_type,
)
from ._responses import (
  copilotkit_responses,
  is_responses_stream,
  is_sync_responses_stream,
  iter_responses_events,
  responses_channel_available,
)
# The event ``type`` discriminators the driver below branches on live next to the
# ROLE each one plays for this bridge, which is what decides the cost of losing
# one (see ``_responses_events``).
from ._responses_events import (
  RESPONSES_COMPLETED,
  RESPONSES_CREATED,
  RESPONSES_ERROR,
  RESPONSES_FAILED,
  RESPONSES_FUNCTION_CALL_ARGS_DELTA,
  RESPONSES_INCOMPLETE,
  RESPONSES_OUTPUT_ITEM_ADDED,
  RESPONSES_OUTPUT_TEXT_DELTA,
  RESPONSES_TERMINAL,
)
from .utils import yield_control, convert_litellm_multimodal_to_agui

_LOGGER = logging.getLogger(__name__)

class CopilotKitProperties(BaseModel):
    """CopilotKit properties"""
    actions: List[Any] = Field(default_factory=list)

class CopilotKitState(FlowState):
    """CopilotKit state"""
    messages: List[Any] = Field(default_factory=list)
    copilotkit: CopilotKitProperties = Field(default_factory=CopilotKitProperties)
    # CrewAI's experimental conversational runtime writes these fields while a
    # turn is being routed. Exclude them from AG-UI state snapshots so enabling
    # the runtime contract does not change regular Flow wire state.
    current_user_message: Optional[str] = Field(default=None, exclude=True)
    last_user_message: Optional[str] = Field(default=None, exclude=True)
    last_intent: Optional[str] = Field(default=None, exclude=True)
    ended: bool = Field(default=False, exclude=True)
    events: List[Any] = Field(default_factory=list, exclude=True)
    agent_threads: Dict[str, List[Any]] = Field(default_factory=dict, exclude=True)
    session_ready: bool = Field(default=False, exclude=True)

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

class _ReasoningChannel:
    """The REASONING_* lifecycle for one streamed assistant turn.

    Both streaming drivers project their provider payload onto
    :class:`DeltaReasoning` and hand it here, so the lifecycle is defined once:
    a reasoning message opens lazily on the first reasoning payload and closes
    on the first answer token, the first tool call, or the end of the stream. A
    model that interleaves thinking with tool calls therefore gets one reasoning
    message per thinking block.
    """

    def __init__(self, flow: Any):
        self._flow = flow
        self.message_id: Optional[str] = None
        self.open = False
        # Whether a reasoning message has already opened and closed this turn.
        self.closed_once = False

    async def emit(self, reasoning: DeltaReasoning) -> None:
        """Emit one reasoning payload, opening the message if needed.

        A payload carrying reasoning TEXT always opens a message when none is
        open, so a genuine later thinking block still surfaces in full.

        An id-less encrypted-only payload may open the FIRST message of a turn
        (an Anthropic ``redacted_thinking`` block is entirely encrypted), but is
        dropped after a prior block closes to avoid an empty second trace. A
        Responses payload is different: its provider ID either attaches late
        continuation state to that closed item or identifies a new empty item
        that must remain replayable.
        """
        if not reasoning:
            return
        if (
            self.open
            and reasoning.item_id is not None
            and reasoning.item_id != self.message_id
        ):
            raise RuntimeError(
                "OpenAI Responses changed reasoning item id while one reasoning "
                f"message was open: {self.message_id!r} -> {reasoning.item_id!r}"
            )
        if not self.open:
            if self.closed_once and not reasoning.text:
                if reasoning.item_id is None:
                    _LOGGER.debug(
                        "Dropping an encrypted-only reasoning blob that arrived "
                        "after its reasoning message closed"
                    )
                    return
                if reasoning.item_id == self.message_id:
                    # Responses may deliver the completed item after answer/tool
                    # output already closed its visible summary. Attach opaque
                    # continuation state to that provider-owned message without
                    # inventing a second empty lifecycle.
                    for value in reasoning.encrypted:
                        crewai_event_bus.emit(
                            self._flow,
                            BridgedReasoningEncryptedValueEvent(
                                type=EventType.REASONING_ENCRYPTED_VALUE,
                                subtype="message",
                                entity_id=self.message_id,
                                encrypted_value=value,
                            ),
                        )
                    if reasoning.encrypted:
                        await yield_control()
                    return
            self.message_id = reasoning.item_id or str(uuid.uuid4())
            crewai_event_bus.emit(
                self._flow,
                BridgedReasoningStartEvent(
                    type=EventType.REASONING_START,
                    message_id=self.message_id,
                ),
            )
            crewai_event_bus.emit(
                self._flow,
                BridgedReasoningMessageStartEvent(
                    type=EventType.REASONING_MESSAGE_START,
                    message_id=self.message_id,
                    role="reasoning",
                ),
            )
            self.open = True
        if reasoning.text:
            crewai_event_bus.emit(
                self._flow,
                BridgedReasoningMessageContentEvent(
                    type=EventType.REASONING_MESSAGE_CONTENT,
                    message_id=self.message_id,
                    delta=reasoning.text,
                ),
            )
        for value in reasoning.encrypted:
            crewai_event_bus.emit(
                self._flow,
                BridgedReasoningEncryptedValueEvent(
                    type=EventType.REASONING_ENCRYPTED_VALUE,
                    subtype="message",
                    entity_id=self.message_id,
                    encrypted_value=value,
                ),
            )
        await yield_control()

    def close(self) -> None:
        """Close an open reasoning message. A no-op when nothing is open.

        Retains the last message ID so late Responses continuation state can
        still attach to the provider-owned item after its visible lifecycle ends.
        """
        if not self.open:
            return
        crewai_event_bus.emit(
            self._flow,
            BridgedReasoningMessageEndEvent(
                type=EventType.REASONING_MESSAGE_END,
                message_id=self.message_id,
            ),
        )
        crewai_event_bus.emit(
            self._flow,
            BridgedReasoningEndEvent(
                type=EventType.REASONING_END,
                message_id=self.message_id,
            ),
        )
        self.open = False
        self.closed_once = True


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

    Also consumes an OpenAI Responses-API stream opened by
    ``copilotkit_responses``, and returns the same chat-shaped
    ``ModelResponse`` either way so a flow node's code is identical on both
    channels. That stream must be the ASYNC one: a synchronous Responses
    iterator raises the ``ValueError`` below, naming the async entrypoint.

    Raises
    ------
    ValueError
        For any response this helper cannot consume, so an unusable response is
        one clear caller error rather than a failure deep inside a driver.
    """
    if isinstance(response, ModelResponse):
        return _copilotkit_stream_response(response)
    if isinstance(response, CustomStreamWrapper):
        return await _copilotkit_stream_custom_stream_wrapper(response)
    if is_responses_stream(response):
        return await _copilotkit_stream_responses(response)
    if is_sync_responses_stream(response):
        # A recognisable Responses stream, just the synchronous one: the drivers
        # here are async-only. Same ValueError as any other unusable type, with
        # the fix named rather than left to a missing-__aiter__ AttributeError.
        raise ValueError(
            f"Invalid response type {type(response)!r}: this is a synchronous "
            f"Responses-API streaming iterator, which cannot be consumed "
            f"asynchronously. Open the stream with "
            f"'await copilotkit_responses(...)' (litellm's async 'aresponses' "
            f"entrypoint) instead of the synchronous one"
        )
    raise ValueError(
        f"Invalid response type {type(response)!r}; expected "
        f"{ModelResponse.__name__}, {CustomStreamWrapper.__name__} or an async "
        f"Responses-API streaming iterator"
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
    reasoning = _ReasoningChannel(flow)

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
        await reasoning.emit(reasoning_from_delta(delta))

        text_content = delta["content"] or None

        # Stream text messages
        if text_content is not None:
            # Reasoning is done once the answer starts.
            reasoning.close()
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
            reasoning.close()
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
        reasoning.close()

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

async def _copilotkit_stream_responses(response):
    """Stream an OpenAI Responses-API call to CopilotKit.

    The behavioural twin of ``_copilotkit_stream_custom_stream_wrapper`` for the
    Responses channel: it emits the SAME ``Bridged*`` events (so both transports
    carry them unchanged) and returns the SAME chat-shaped ``ModelResponse``, so
    a flow node reads ``response.choices[0].message`` either way.

    The channel exists because OpenAI's reasoning models stream their reasoning
    summaries here and NOWHERE on chat-completions. Event ``type`` values are
    read as strings (see ``_responses``) so a litellm build that predates an
    event still delivers it via ``GenericEvent``.
    """
    flow = flow_context.get(None)

    message_id: Optional[str] = None
    content = ""
    created = 0
    model = ""
    failure: Optional[str] = None
    # Set when the turn ends on ``response.incomplete``: the assistant message
    # was CUT OFF, and reporting a clean "stop" would make a truncated turn
    # indistinguishable from a finished one.
    truncated_finish_reason: Optional[str] = None
    # Function calls keyed by the Responses ``item_id``, which every argument
    # delta for that call carries. Insertion order is the provider's order.
    calls_by_item: Dict[str, Dict[str, Any]] = {}

    reasoning = _ReasoningChannel(flow)

    def _message_id_for(event: Any) -> Optional[str]:
        """The assistant message id for this turn, resolved once then reused.

        Reads whichever id this event shape actually carries (see
        ``_responses_item_id``), falling back to a uuid when it carries none, so
        the streamed message has ONE stable id across the turn either way.
        ``response.created`` normally wins because the caller records its
        ``response.id`` before any output item arrives.
        """
        nonlocal message_id
        if message_id is None:
            message_id = _responses_item_id(event) or str(uuid.uuid4())
        return message_id

    events = iter_responses_events(response)
    try:
        async for event in events:
            event_type = responses_event_type(event)
            if event_type is None:
                continue

            # Reasoning summaries + the encrypted reasoning blob.
            await reasoning.emit(reasoning_from_responses_event(event))

            if event_type == RESPONSES_CREATED:
                # ``response.id`` is the stable id for this turn; use it as the
                # assistant message id (parity with the chat path's chunk id).
                created_response = getattr(event, "response", None)
                if message_id is None:
                    message_id = _responses_attr(created_response, "id")
                model = _responses_attr(created_response, "model") or model
                created = _responses_created_timestamp(
                    _responses_attr(created_response, "created_at"), created
                )
                continue

            if event_type == RESPONSES_OUTPUT_ITEM_ADDED:
                # ``item`` is a dict on some builds and a
                # ``BaseLiteLLMOpenAIResponseObject`` on real OpenAI, so read it
                # shape-agnostically -- gating on ``dict`` alone dropped every
                # function call the model made against a live Responses stream.
                item = getattr(event, "item", None)
                if item is None or _responses_attr(item, "type") != "function_call":
                    continue
                item_id = _responses_attr(item, "id")
                # ``call_id`` is what a later ``function_call_output`` must
                # reference, so it is the tool call's identity on the wire.
                call_id = _responses_attr(item, "call_id") or item_id
                name = _responses_attr(item, "name")
                if not item_id or not call_id or not name:
                    _LOGGER.error(
                        "ag-ui-crewai dropped a Responses function_call item with "
                        "no id, call_id or name: %r",
                        item,
                    )
                    continue
                # Reasoning is done once the model calls a tool.
                reasoning.close()
                # A predicted tool that actually streams suppresses the node-exit
                # STATE_SNAPSHOT, which would otherwise rebuild from flow.state and
                # clobber the predicted state the client is already rendering.
                _mark_predicted_tool_streamed(flow, name)
                seeded_arguments = _responses_attr(item, "arguments") or ""
                calls_by_item[item_id] = {
                    "id": call_id,
                    "name": name,
                    # ``item.arguments`` on the ADDED item is a complete-value
                    # snapshot, not a prefix: OpenAI sends "" here and streams the
                    # arguments as deltas. So it is provisional -- the first delta
                    # REPLACES it instead of appending, which is what stops a
                    # provider that populates both from counting them twice. It is
                    # not put on the wire yet either; a call that never receives a
                    # delta flushes its arguments after the loop.
                    "arguments": seeded_arguments,
                    "provisional": bool(seeded_arguments),
                    "streamed": False,
                }
                crewai_event_bus.emit(
                    flow,
                    BridgedToolCallChunkEvent(
                        type=EventType.TOOL_CALL_CHUNK,
                        tool_call_id=call_id,
                        tool_call_name=name,
                        parent_message_id=_message_id_for(event),
                        delta=None,
                    ),
                )
                await yield_control()
                continue

            if event_type == RESPONSES_OUTPUT_TEXT_DELTA:
                delta = getattr(event, "delta", None)
                if not isinstance(delta, str) or not delta:
                    continue
                # Reasoning is done once the answer starts.
                reasoning.close()
                content += delta
                crewai_event_bus.emit(
                    flow,
                    BridgedTextMessageChunkEvent(
                        type=EventType.TEXT_MESSAGE_CHUNK,
                        message_id=_message_id_for(event),
                        role="assistant",
                        delta=delta,
                    ),
                )
                await yield_control()
                continue

            if event_type == RESPONSES_FUNCTION_CALL_ARGS_DELTA:
                delta = getattr(event, "delta", None)
                item_id = getattr(event, "item_id", None)
                entry = calls_by_item.get(item_id)
                if entry is None or not isinstance(delta, str) or not delta:
                    continue
                if entry["provisional"]:
                    # The added item already carried the whole call and the
                    # provider is streaming it as well: the deltas are
                    # authoritative, and nothing seeded reached the wire.
                    entry["arguments"] = ""
                    entry["provisional"] = False
                entry["arguments"] += delta
                entry["streamed"] = True
                crewai_event_bus.emit(
                    flow,
                    BridgedToolCallChunkEvent(
                        type=EventType.TOOL_CALL_CHUNK,
                        tool_call_id=entry["id"],
                        tool_call_name=entry["name"],
                        parent_message_id=message_id,
                        delta=delta,
                    ),
                )
                await yield_control()
                continue

            if event_type in RESPONSES_TERMINAL:
                if event_type in (RESPONSES_ERROR, RESPONSES_FAILED):
                    failure = _responses_failure_message(event)
                if event_type in (RESPONSES_COMPLETED, RESPONSES_INCOMPLETE):
                    terminal = getattr(event, "response", None)
                    model = _responses_attr(terminal, "model") or model
                    created = _responses_created_timestamp(
                        _responses_attr(terminal, "created_at"), created
                    )
                if event_type == RESPONSES_INCOMPLETE:
                    truncated_finish_reason = _responses_incomplete_finish_reason(event)
                break
    finally:
        # Close a reasoning message left open by a stream that carried only
        # reasoning, ended before any answer text / tool call, or raised
        # mid-reasoning.
        reasoning.close()
        # The terminal-event ``break`` above leaves both this generator and
        # litellm's iterator suspended, so release them rather than waiting for
        # the garbage collector to drop the open response.
        await _release_responses_stream(response, events)

    if failure is not None:
        # Surfaced as a RUN_ERROR by the drivers' exception taxonomy rather than
        # returned as a silently empty message.
        raise RuntimeError(f"OpenAI Responses stream failed: {failure}")

    # A call whose arguments arrived complete on its output item and never streamed
    # a delta: put them on the wire now, so the streamed TOOL_CALL_ARGS still match
    # the returned ModelResponse (the chat driver's invariant). This holds while
    # the flush reaches the shaper before any answer text; a provider that emitted
    # the complete-args item and THEN streamed text would have this tool call
    # already closed by the shaper (see _frames.py) and this flush dropped (logged
    # at ERROR). Real OpenAI does not order it that way, so it is not reachable
    # today -- but the match is conditional on that ordering, not absolute.
    for entry in calls_by_item.values():
        if entry["streamed"] or not entry["arguments"]:
            continue
        crewai_event_bus.emit(
            flow,
            BridgedToolCallChunkEvent(
                type=EventType.TOOL_CALL_CHUNK,
                tool_call_id=entry["id"],
                tool_call_name=entry["name"],
                parent_message_id=message_id,
                delta=entry["arguments"],
            ),
        )
        await yield_control()

    tool_calls = [
        ChatCompletionMessageToolCall(
            function=LiteLLMFunction(
                arguments=entry["arguments"],
                name=entry["name"],
            ),
            id=entry["id"],
            type="function",
        )
        for entry in calls_by_item.values()
    ]
    return ModelResponse(
        id=message_id,
        created=created,
        model=model,
        object='chat.completion',
        choices=[
            Choices(
                # Truncation outranks ``tool_calls``: a cut-off turn's arguments are
                # partial, so reporting a clean tool call would misdescribe it.
                finish_reason=truncated_finish_reason
                or ("tool_calls" if tool_calls else "stop"),
                index=0,
                message=LiteLLMMessage(
                    content=content,
                    role='assistant',
                    tool_calls=tool_calls or None,
                    function_call=None
                )
            )
        ]
    )


def _responses_attr(response_object: Any, key: str) -> Any:
    """Read ``key`` off a Responses payload that may be a model or a dict."""
    if response_object is None:
        return None
    if isinstance(response_object, dict):
        return response_object.get(key)
    return getattr(response_object, key, None)


def _responses_created_timestamp(value: Any, current: int) -> int:
    """Project a Responses ``created_at`` onto ``ModelResponse.created``.

    ``ResponsesAPIResponse.created_at`` is typed ``float`` while
    ``ModelResponse.created`` is a strict ``int``: pydantic coerces an integral
    float but REJECTS a fractional one, and it would raise only at the end, after
    the whole turn had already streamed to the client. Truncate to whole seconds,
    and keep the previous value for anything non-numeric.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return current
    try:
        return int(value)
    except (ValueError, OverflowError):  # NaN / infinity
        return current


#: ``incomplete_details.reason`` onto the chat-completions ``finish_reason``
#: vocabulary, so a truncated turn reads the same on both channels.
_RESPONSES_INCOMPLETE_FINISH_REASONS = {
    "max_output_tokens": "length",
    "content_filter": "content_filter",
}


def _responses_incomplete_finish_reason(event: Any) -> str:
    """The chat ``finish_reason`` for a ``response.incomplete`` terminal event.

    A truncated turn must not read as a clean ``stop``: the assistant message is
    partial and any tool-call arguments in it are likely unparseable. Also logs
    the reason, which is otherwise lost entirely.
    """
    details = _responses_attr(getattr(event, "response", None), "incomplete_details")
    reason = _responses_attr(details, "reason")
    finish_reason = _RESPONSES_INCOMPLETE_FINISH_REASONS.get(reason, "length")
    _LOGGER.warning(
        "The OpenAI Responses turn ended incomplete (reason=%r): the assistant "
        "message is truncated and is reported with finish_reason=%r",
        reason,
        finish_reason,
    )
    return finish_reason


async def _close_quietly(candidate: Any) -> bool:
    """Best-effort ``aclose()`` / ``close()`` on ``candidate``; True when one ran.

    Feature-detected, never assumed: litellm's Responses iterator exposes neither
    (nor ``__aenter__`` / ``__aexit__``), and a closer that raises must not mask a
    turn that already streamed.
    """
    for name in ("aclose", "close"):
        closer = getattr(candidate, name, None)
        if not callable(closer):
            continue
        try:
            outcome = closer()
            if inspect.isawaitable(outcome):
                await outcome
        except Exception:  # noqa: BLE001 - releasing must never void the turn
            _LOGGER.debug(
                "Could not release the Responses stream via %s()", name, exc_info=True
            )
            continue
        return True
    return False


async def _release_responses_stream(response: Any, events: Any) -> None:
    """Release a Responses stream the driver stopped reading.

    The driver breaks on the terminal event instead of draining to
    ``StopAsyncIteration``, so neither the wrapping generator nor litellm's
    iterator is ever asked to clean up, and that is the happy path for every run.
    litellm's iterator exposes no closer of its own and holds the live httpx
    response, so probe the iterator first and fall back to the response object it
    carries.
    """
    await _close_quietly(events)
    for candidate in (response, getattr(response, "response", None)):
        if candidate is not None and await _close_quietly(candidate):
            return


def _responses_item_id(event: Any) -> Optional[str]:
    """The output-item id a Responses stream event carries, if any.

    Text and function-call argument deltas expose it flat as ``item_id``, while
    ``output_item.added`` defines no such field and carries the id inside
    ``item``. Reading both shapes is what keeps a stream that skipped
    ``response.created`` on a real id from the stream instead of a minted uuid.
    """
    item_id = getattr(event, "item_id", None)
    if isinstance(item_id, str) and item_id:
        return item_id
    nested = _responses_attr(getattr(event, "item", None), "id")
    return nested if isinstance(nested, str) and nested else None


def _responses_failure_message(event: Any) -> str:
    """Best-effort human-readable reason from a failed/error Responses event."""
    message = getattr(event, "message", None)
    if isinstance(message, str) and message:
        return message
    error = _responses_attr(getattr(event, "response", None), "error")
    error_message = _responses_attr(error, "message")
    if isinstance(error_message, str) and error_message:
        return error_message
    return responses_event_type(event) or "unknown error"


def _copilotkit_stream_response(response: ModelResponse):
    return response


message_adapter = TypeAdapter(Message)

def litellm_messages_to_ag_ui_messages(messages: List[LiteLLMMessage]) -> List[Message]:
    """
    Converts CrewAI/LiteLLM state messages for an AG-UI ``MESSAGES_SNAPSHOT``.

    Reasoning is intentionally omitted. This adapter streams reasoning directly
    and does not persist the current turn's complete reasoning set in CrewAI
    state, so claiming the partial state is authoritative would make the client
    replace (and lose) its complete client-owned reasoning history.
    """
    ag_ui_messages: List[Message] = []
    for message in messages:
        message_dict = message.model_dump() if not isinstance(message, Mapping) else message

        if message_dict.get("role") == "reasoning":
            continue

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
