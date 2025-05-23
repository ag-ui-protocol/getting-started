# Protocol Buffer Support in AG-UI Nim SDK

This document outlines the Protocol Buffer support implementation in the AG-UI Nim SDK.

## Overview

Protocol Buffers provide a compact binary serialization format for AG-UI events, offering reduced bandwidth usage and faster parsing compared to the default JSON-based SSE format. The AG-UI Nim SDK implements a simplified Protocol Buffer encoder and decoder that supports all standard AG-UI event types.

## Implementation Details

### 1. Core Components

- **Binary Encoding**: The encoder implements the Protocol Buffer wire format with support for:
  - Variable-length integer encoding (Varint)
  - Length-delimited strings and nested messages
  - Fixed-size 32-bit and 64-bit values

- **Event Mapping**: Each AG-UI event type has a specific Protocol Buffer field mapping that preserves all required and optional fields.

- **Content Negotiation**: The HTTP agent supports Protocol Buffer format through content type negotiation, using the `application/vnd.ag-ui.proto` MIME type.

### 2. Architecture

The Protocol Buffer implementation is organized into three main components:

1. **Encoder Core** (`encoder/proto.nim`):
   - Handles serialization of AG-UI events to Protocol Buffer binary format
   - Implements wire format encoding and decoding
   - Provides fallback mechanisms for unknown event types

2. **Stream Transformation** (`client/transform/proto.nim`):
   - Parses Protocol Buffer streams into event sequences
   - Handles fragmented messages and length prefixes
   - Integrates with the Observable pattern for event streaming

3. **Media Type Integration** (`encoder.nim`):
   - Manages content type negotiation
   - Selects the appropriate encoder based on client preferences

## Usage

To use Protocol Buffer encoding in requests:

```nim
# When creating an HTTP agent, specify proto support
let agent = newHttpAgent(
  baseUrl = "https://api.example.com",
  mediaType = AGUI_PROTO_MEDIA_TYPE  # Use Protocol Buffer format
)

# The client will automatically encode events using Protocol Buffers
await agent.sendTextMessage("Hello, world!")
```

When receiving Protocol Buffer events:

```nim
# Create a stream and subscribe to events
let events = agent.streamEvents()
events.subscribe(proc(event: BaseEvent) =
  # Events are automatically decoded from Protocol Buffers
  echo "Received event: ", event.type
)
```

## Benefits and Limitations

**Benefits:**
- Reduced bandwidth usage (typically 30-50% smaller than JSON)
- More efficient parsing for large event sequences
- Type-safe serialization with explicit field mapping

**Limitations:**
- Current implementation is simplified and may not handle all edge cases
- Performance optimizations are still needed for very large payloads
- Limited test coverage compared to other components

## Future Enhancements

1. Integration with a mature Protocol Buffer library
2. Schema generation from Protocol Buffer definitions
3. More efficient binary encoding for large state snapshots
4. Improved streaming parser with predictive buffer allocation
5. Compression support for large payloads

## Testing

Basic test coverage is provided in `tests/test_proto.nim`, which verifies:
- Basic event encoding and decoding
- Protocol Buffer stream parsing
- Field preservation during serialization rounds

For production use, additional testing is recommended, especially for complex event sequences and error cases.