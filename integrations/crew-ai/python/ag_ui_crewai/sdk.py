"""
Streaming and state helpers (copilotkit_stream and related utilities) for the CrewAI AG-UI bridge.
"""

import uuid
from typing import List, Any, Optional, Mapping, Dict, Literal, TypedDict
from litellm.types.utils import (
  ModelResponse,
  Choices,
  Message as LiteLLMMessage,
  ChatCompletionMessageToolCall,
  Function as LiteLLMFunction
)
from litellm.litellm_core_utils.streaming_handler import CustomStreamWrapper
from crewai.flow.flow import FlowState
from crewai.utilities.events import crewai_event_bus
from pydantic import BaseModel, Field, TypeAdapter
from ag_ui.core import EventType, Message
from .context import flow_context
from .events import (
  BridgedTextMessageChunkEvent,
  BridgedToolCallChunkEvent,
  BridgedCustomEvent,
  BridgedStateSnapshotEvent
)
from .utils import yield_control

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

async def copilotkit_predict_state(
        config: Dict[str, PredictStateConfig]
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

    Parameters
    ----------
    config : Dict[str, CopilotKitPredictStateConfig]
        The configuration to predict the state.

    Returns
    -------
    Awaitable[bool]
        Always return True.
    """
    flow = flow_context.get(None)

    value = [
        {
            "state_key": k,
            "tool": v["tool_name"],
            "tool_argument": v["tool_argument"]
        } for k, v in config.items()
    ]
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

    To install the CopilotKit SDK, run:

    ```bash
    pip install copilotkit[crewai]
    ```

    ### Examples

    ```python
    from ag_ui_crewai import copilotkit_emit_state

    for i in range(10):
        await some_long_running_operation(i)
        await copilotkit_emit_state({"progress": i})
    ```

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
    crewai_event_bus.emit(
        flow,
        BridgedStateSnapshotEvent(
            type=EventType.STATE_SNAPSHOT,
            snapshot=state
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
    raise ValueError("Invalid response type")


async def _copilotkit_stream_custom_stream_wrapper(response: CustomStreamWrapper):
    flow = flow_context.get(None)

    message_id: Optional[str] = None
    tool_call_id: str = ""
    content = ""
    created = 0
    model = ""
    system_fingerprint = ""
    finish_reason=None
    all_tool_calls = []

    async for chunk in response:
        if message_id is None:
            message_id = chunk["id"]

        text_content = chunk["choices"][0]["delta"]["content"] or None

        # Stream text messages
        if text_content is not None:
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

        # Stream tool calls
        tool_calls = chunk["choices"][0]["delta"]["tool_calls"] or None
        tool_call_id = tool_calls[0].id if tool_calls is not None else None
        tool_call_arguments = tool_calls[0].function["arguments"] if tool_calls is not None else None
        tool_call_name = tool_calls[0].function["name"] if tool_calls is not None else None

        if tool_call_id is not None:
            all_tool_calls.append(
                {
                    "id": tool_call_id,
                    "name": tool_call_name,
                    "arguments": "",
                }
            )

        if tool_call_arguments is not None:
            # add to the current tool call
            all_tool_calls[-1]["arguments"] += tool_call_arguments
            crewai_event_bus.emit(
                flow,
                BridgedToolCallChunkEvent(
                    type=EventType.TOOL_CALL_CHUNK,
                    tool_call_id=tool_call_id,
                    tool_call_name=tool_call_name,
                    delta=tool_call_arguments,
                )
            )
            # yield control to the event loop
            await yield_control()

        # Stream finish reason
        finish_reason = chunk["choices"][0]["finish_reason"]
        created = chunk["created"]
        model = chunk["model"]
        system_fingerprint = chunk["system_fingerprint"]

        if finish_reason is not None:
            break

    tool_calls = [
        ChatCompletionMessageToolCall(
            function=LiteLLMFunction(
                arguments=tool_call["arguments"],
                name=tool_call["name"]
            ),
            id=tool_call["id"],
            type="function"
        )
        for tool_call in all_tool_calls
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
        if not "id" in message_dict:
            message_dict["id"] = str(uuid.uuid4())
        # remove all None values
        message_dict = {k: v for k, v in message_dict.items() if v is not None}

        if "tool_calls" in message_dict:
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