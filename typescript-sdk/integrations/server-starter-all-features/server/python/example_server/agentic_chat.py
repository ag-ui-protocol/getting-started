"""
Agentic chat endpoint for the AG-UI protocol.
"""

import uuid
import asyncio
import json
from fastapi import Request
from fastapi.responses import StreamingResponse
from ag_ui.core import (
    RunAgentInput,
    EventType,
    RunStartedEvent,
    RunFinishedEvent,
    TextMessageStartEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    ToolCallStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    MessagesSnapshotEvent,
    ToolMessage,
    ToolCall,
    AssistantMessage
)
from ag_ui.core.events import TextMessageChunkEvent
from ag_ui.encoder import EventEncoder

async def agentic_chat_endpoint(input_data: RunAgentInput, request: Request):
    """Agentic chat endpoint"""
    # Get the accept header from the request
    accept_header = request.headers.get("accept")

    # Create an event encoder to properly format SSE events
    encoder = EventEncoder(accept=accept_header)

    async def event_generator():
        # Get the last message content for conditional logic
        last_message_content = None
        last_message_role = None
        if input_data.messages and len(input_data.messages) > 0:
            last_message = input_data.messages[-1]
            last_message_content = last_message.content
            last_message_role = getattr(last_message, 'role', None)

        # Send run started event
        yield encoder.encode(
            RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id
            ),
        )

        # Conditional logic based on last message
        if last_message_role == "tool":
            async for event in send_tool_result_message_events():
                yield encoder.encode(event)
        elif last_message_content == "tool":
            async for event in send_tool_call_events():
                yield encoder.encode(event)
        elif last_message_content == "backend_tool":
            async for event in send_backend_tool_call_events(input_data.messages):
                yield encoder.encode(event)
        else:
            async for event in send_text_message_events():
                yield encoder.encode(event)

        # Send run finished event
        yield encoder.encode(
            RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id
            ),
        )

    return StreamingResponse(
        event_generator(),
        media_type=encoder.get_content_type()
    )


async def send_text_message_events():
    """Send text message events with countdown"""
    message_id = str(uuid.uuid4())

    # Start of message
    yield TextMessageStartEvent(
        type=EventType.TEXT_MESSAGE_START,
        message_id=message_id,
        role="assistant"
    )

    # Initial content chunk
    yield TextMessageContentEvent(
        type=EventType.TEXT_MESSAGE_CONTENT,
        message_id=message_id,
        delta="counting down: "
    )

    # Countdown from 10 to 1
    for count in range(10, 0, -1):
        yield TextMessageContentEvent(
            type=EventType.TEXT_MESSAGE_CONTENT,
            message_id=message_id,
            delta=f"{count}  "
        )
        # Sleep for 300ms
        await asyncio.sleep(0.3)

    # Final checkmark
    yield TextMessageContentEvent(
        type=EventType.TEXT_MESSAGE_CONTENT,
        message_id=message_id,
        delta="✓"
    )

    # End of message
    yield TextMessageEndEvent(
        type=EventType.TEXT_MESSAGE_END,
        message_id=message_id
    )


async def send_tool_result_message_events():
    """Send message for tool result"""
    message_id = str(uuid.uuid4())

    # Start of message
    yield TextMessageStartEvent(
        type=EventType.TEXT_MESSAGE_START,
        message_id=message_id,
        role="assistant"
    )

    # Content
    yield TextMessageContentEvent(
        type=EventType.TEXT_MESSAGE_CONTENT,
        message_id=message_id,
        delta="background changed ✓"
    )

    # End of message
    yield TextMessageEndEvent(
        type=EventType.TEXT_MESSAGE_END,
        message_id=message_id
    )


async def send_tool_call_events():
    """Send tool call events"""
    tool_call_id = str(uuid.uuid4())
    tool_call_name = "change_background"
    tool_call_args = {
        "background": "linear-gradient(135deg, #667eea 0%, #764ba2 100%)"
    }

    # Tool call start
    yield ToolCallStartEvent(
        type=EventType.TOOL_CALL_START,
        tool_call_id=tool_call_id,
        tool_call_name=tool_call_name
    )

    # Tool call args
    yield ToolCallArgsEvent(
        type=EventType.TOOL_CALL_ARGS,
        tool_call_id=tool_call_id,
        delta=json.dumps(tool_call_args)
    )

    # Tool call end
    yield ToolCallEndEvent(
        type=EventType.TOOL_CALL_END,
        tool_call_id=tool_call_id
    )

async def send_backend_tool_call_events(messages):
    """Send backend tool call events"""
    tool_call_id = str(uuid.uuid4())

    new_message = AssistantMessage(
        id=str(uuid.uuid4()),
        role="assistant",
        tool_calls=[
            ToolCall(
                id=tool_call_id,
                type="function",
                function={
                    "name": "lookup_weather",
                    "arguments": json.dumps({"city": "San Francisco", "weather": "sunny"})
                }
            )
        ]
    )

    result_message = ToolMessage(
        id=str(uuid.uuid4()),
        role="tool",
        content="The weather in San Francisco is sunny.",
        tool_call_id=tool_call_id
    )

    all_messages = list(messages) + [new_message, result_message]

    # Send messages snapshot event
    yield MessagesSnapshotEvent(
        type=EventType.MESSAGES_SNAPSHOT,
        messages=all_messages
    )
