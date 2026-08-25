# ag-ui-protocol

Python SDK for the **Agent-User Interaction (AG-UI) Protocol**.

`ag-ui-protocol` provides Python developers with strongly-typed data structures and event encoding for building AG-UI compatible agent servers. Built on Pydantic for robust validation and automatic camelCase serialization for seamless frontend integration.

## Installation

```bash
pip install ag-ui-protocol
poetry add ag-ui-protocol
pipenv install ag-ui-protocol
```

## Features

- 🐍 **Python-native** – Idiomatic Python APIs with full type hints and validation
- 📋 **Pydantic models** – Runtime validation and automatic JSON serialization
- 🔄 **Streaming events** – 16 core event types for real-time agent communication
- ⚡ **High performance** – Efficient event encoding for Server-Sent Events

## Quick example

```python
from ag_ui.core import TextMessageContentEvent, EventType
from ag_ui.encoder import EventEncoder

# Create a streaming text event
event = TextMessageContentEvent(
    type=EventType.TEXT_MESSAGE_CONTENT,
    message_id="msg_123",
    delta="Hello from Python!"
)

# Encode for HTTP streaming
encoder = EventEncoder()
sse_data = encoder.encode(event)
# Output: data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"msg_123","delta":"Hello from Python!"}\n\n
```

### Multimodal user message

```python
from ag_ui.core import UserMessage, TextInputContent, ImageInputPart, InputContentUrlSource

message = UserMessage(
    id="user-123",
    content=[
        TextInputContent(text="Please describe this image"),
        ImageInputPart(
            source=InputContentUrlSource(
                value="https://example.com/cat.png",
                mime_type="image/png",
            )
        ),
    ],
)

payload = message.model_dump(by_alias=True)
# {"id": "user-123", "role": "user", "content": [...]}
```

> `BinaryInputContent` is deprecated. Use modality-specific input parts (`ImageInputPart`, `AudioInputPart`, `VideoInputPart`, `DocumentInputPart`) with `InputContentDataSource` or `InputContentUrlSource`.

### Optional fields with no value are left out

Serializing an AG-UI type omits every optional field that has no value instead of writing it as
`null` — matching what a TypeScript producer puts on the wire. This is built into the base model, so
it holds on every path (`model_dump`, `model_dump_json`, nesting inside another model, the
`EventEncoder`) and you do not need to pass `exclude_none=True`:

```python
from ag_ui.core import ToolCallStartEvent

ToolCallStartEvent(tool_call_id="tc_1", tool_call_name="search").model_dump_json(by_alias=True)
# {"type":"TOOL_CALL_START","toolCallId":"tc_1","toolCallName":"search"}
# note: no "parentMessageId": null
```

`null` as an actual value is untouched: a required field holding `None`, a `None` inside a `dict` or
`list` (an individual metadata value, a JSON Patch `replace` with `null`), and any extra field all
serialize as `null`.

## Packages

- **`ag_ui.core`** – Types, events, and data models for AG-UI protocol
- **`ag_ui.encoder`** – Event encoding utilities for HTTP streaming

## Documentation

- Concepts & architecture: [`docs/concepts`](https://docs.ag-ui.com/concepts/architecture)
- Full API reference: [`docs/sdk/python`](https://docs.ag-ui.com/sdk/python/core/overview)

## Contributing

Bug reports and pull requests are welcome! Please read our [contributing guide](https://docs.ag-ui.com/development/contributing) first.

## License

MIT © 2025 AG-UI Protocol Contributors
