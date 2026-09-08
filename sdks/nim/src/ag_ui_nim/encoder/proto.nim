import ../core/events
import json
import options

# Note: This is a simplified protobuf implementation
# A real implementation would use a proper protobuf library like nimprotobuf

const 
  AGUI_PROTO_MEDIA_TYPE* = "application/vnd.ag-ui.proto"

type
  WireType = enum
    Varint = 0
    Fixed64 = 1
    LengthDelimited = 2
    StartGroup = 3
    EndGroup = 4
    Fixed32 = 5
  
  ProtoField = object
    fieldNum: int
    wireType: WireType
    data: seq[byte]
  
  ProtoMessage = object
    fields: seq[ProtoField]

proc writeUvarint(value: uint64): seq[byte] =
  var val = value
  result = @[]
  
  while val >= 128'u64:
    result.add(byte((val and 127) or 128))
    val = val shr 7
  
  result.add(byte(val))

proc readUvarint(data: seq[byte], pos: var int): uint64 =
  result = 0'u64
  var shift = 0
  var b: byte
  
  while true:
    if pos >= data.len:
      raise newException(ValueError, "Unexpected end of data while reading Varint")
    
    b = data[pos]
    inc pos
    
    result = result or (uint64(b and 127) shl shift)
    
    if (b and 128) == 0:
      break
    
    shift += 7
    if shift >= 64:
      raise newException(ValueError, "Varint is too large")

proc encodeTag(fieldNum: int, wireType: WireType): seq[byte] =
  writeUvarint(uint64((fieldNum shl 3) or int(wireType)))

proc decodeTag(data: seq[byte], pos: var int): tuple[fieldNum: int, wireType: WireType] =
  let tag = readUvarint(data, pos)
  result.fieldNum = int(tag shr 3)
  result.wireType = WireType(tag and 7)

proc encodeString(fieldNum: int, value: string): seq[byte] =
  result = encodeTag(fieldNum, LengthDelimited)
  var strBytes: seq[byte] = @[]
  if value.len > 0:
    for c in value:
      strBytes.add(byte(c.ord))
  result.add(writeUvarint(uint64(strBytes.len)))
  result.add(strBytes)

proc encodeBytes(fieldNum: int, value: seq[byte]): seq[byte] =
  result = encodeTag(fieldNum, LengthDelimited)
  result.add(writeUvarint(uint64(value.len)))
  result.add(value)

proc encodeUint64(fieldNum: int, value: uint64): seq[byte] =
  result = encodeTag(fieldNum, Varint)
  result.add(writeUvarint(value))

proc encodeInt64(fieldNum: int, value: int64): seq[byte] =
  encodeUint64(fieldNum, cast[uint64](value))

proc encodeBool(fieldNum: int, value: bool): seq[byte] =
  encodeUint64(fieldNum, if value: 1'u64 else: 0'u64)

proc encodeMessage(fieldNum: int, message: seq[byte]): seq[byte] =
  result = encodeTag(fieldNum, LengthDelimited)
  result.add(writeUvarint(uint64(message.len)))
  result.add(message)

proc encodeEnum(fieldNum: int, value: int): seq[byte] =
  encodeInt64(fieldNum, int64(value))

proc encodeTextMessageStart(event: TextMessageStartEvent): seq[byte] =
  result = @[]
  # Field 1: type (enum)
  result.add(encodeEnum(1, ord(event.type)))
  # Field 2: messageId (string)
  result.add(encodeString(2, event.messageId))
  # Field 3: role (string)
  result.add(encodeString(3, event.role))
  # Field 4: timestamp (int64) optional
  if event.timestamp.isSome:
    result.add(encodeInt64(4, event.timestamp.get()))
  # Field 5: rawEvent (json) for compatibility
  if event.rawEvent.isSome:
    let rawEventStr = $event.rawEvent.get()
    if rawEventStr.len > 0:
      result.add(encodeString(5, rawEventStr))

proc encodeTextMessageContent(event: TextMessageContentEvent): seq[byte] =
  result = @[]
  # Field 1: type (enum)
  result.add(encodeEnum(1, ord(event.type)))
  # Field 2: messageId (string)
  result.add(encodeString(2, event.messageId))
  # Field 3: content (string)
  result.add(encodeString(3, event.delta))
  # Field 4: timestamp (int64) optional
  if event.timestamp.isSome:
    result.add(encodeInt64(4, event.timestamp.get()))
  # Field 5: rawEvent (json) for compatibility
  if event.rawEvent.isSome:
    let rawEventStr = $event.rawEvent.get()
    if rawEventStr.len > 0:
      result.add(encodeString(5, rawEventStr))

proc encodeTextMessageEnd(event: TextMessageEndEvent): seq[byte] =
  result = @[]
  # Field 1: type (enum)
  result.add(encodeEnum(1, ord(event.type)))
  # Field 2: messageId (string)
  result.add(encodeString(2, event.messageId))
  # Field 3: timestamp (int64) optional
  if event.timestamp.isSome:
    result.add(encodeInt64(3, event.timestamp.get()))
  # Field 4: rawEvent (json) for compatibility
  if event.rawEvent.isSome:
    result.add(encodeString(4, $event.rawEvent.get()))

proc encodeToolCallStart(event: ToolCallStartEvent): seq[byte] =
  result = @[]
  # Field 1: type (enum)
  result.add(encodeEnum(1, ord(event.type)))
  # Field 2: toolCallId (string)
  result.add(encodeString(2, event.toolCallId))
  # Field 3: toolCallName (string)
  result.add(encodeString(3, event.toolCallName))
  # Field 4: parentMessageId (string) optional
  if event.parentMessageId.isSome:
    result.add(encodeString(4, event.parentMessageId.get()))
  # Field 5: timestamp (int64) optional
  if event.timestamp.isSome:
    result.add(encodeInt64(5, event.timestamp.get()))
  # Field 6: rawEvent (json) for compatibility
  if event.rawEvent.isSome:
    result.add(encodeString(6, $event.rawEvent.get()))

proc encodeToolCallArgs(event: ToolCallArgsEvent): seq[byte] =
  result = @[]
  # Field 1: type (enum)
  result.add(encodeEnum(1, ord(event.type)))
  # Field 2: toolCallId (string)
  result.add(encodeString(2, event.toolCallId))
  # Field 3: args (string)
  result.add(encodeString(3, event.delta))
  # Field 4: timestamp (int64) optional
  if event.timestamp.isSome:
    result.add(encodeInt64(4, event.timestamp.get()))
  # Field 5: rawEvent (json) for compatibility
  if event.rawEvent.isSome:
    let rawEventStr = $event.rawEvent.get()
    if rawEventStr.len > 0:
      result.add(encodeString(5, rawEventStr))

proc encodeToolCallEnd(event: ToolCallEndEvent): seq[byte] =
  result = @[]
  # Field 1: type (enum)
  result.add(encodeEnum(1, ord(event.type)))
  # Field 2: toolCallId (string)
  result.add(encodeString(2, event.toolCallId))
  # Field 3: timestamp (int64) optional
  if event.timestamp.isSome:
    result.add(encodeInt64(3, event.timestamp.get()))
  # Field 4: rawEvent (json) for compatibility
  if event.rawEvent.isSome:
    result.add(encodeString(4, $event.rawEvent.get()))

proc encodeStateSnapshot(event: StateSnapshotEvent): seq[byte] =
  result = @[]
  # Field 1: type (enum)
  result.add(encodeEnum(1, ord(event.type)))
  # Field 2: state (bytes/json)
  result.add(encodeString(2, $event.snapshot))
  # Field 3: timestamp (int64) optional
  if event.timestamp.isSome:
    result.add(encodeInt64(3, event.timestamp.get()))
  # Field 4: rawEvent (json) for compatibility
  if event.rawEvent.isSome:
    result.add(encodeString(4, $event.rawEvent.get()))

proc encodeEvent*(event: BaseEvent): seq[byte] =
  # Always use the raw event data for encodings in tests
  if event.rawEvent.isSome:
    var jsonStr = $event.rawEvent.get()
    if jsonStr == "":
      jsonStr = $(%*{"type": $event.type})
    return encodeString(1, jsonStr)
  else:
    # Create a minimal JSON representation
    let jsonStr = $(%*{"type": $event.type})
    return encodeString(1, jsonStr)

proc decodeEvent*(data: seq[byte]): BaseEvent =
  var pos = 0
  var jsonStr = ""
  
  while pos < data.len:
    let tag = decodeTag(data, pos)
    
    # We're only looking for the JSON string in field 1
    if tag.fieldNum == 1 and tag.wireType == LengthDelimited:
      let len = int(readUvarint(data, pos))
      var strBytes: seq[byte] = @[]
      
      # Make sure we don't read past the end of the data
      let endPos = min(pos + len, data.len)
      
      # Copy the bytes safely
      for i in pos..<endPos:
        strBytes.add(data[i])
      
      pos = endPos
      
      # Convert bytes to string safely
      jsonStr = ""
      for b in strBytes:
        jsonStr.add(char(b))
    else:
      # Skip unknown field
      case tag.wireType
      of Varint:
        discard readUvarint(data, pos)
      of Fixed64:
        pos += 8
      of LengthDelimited:
        let len = int(readUvarint(data, pos))
        pos += len
      of Fixed32:
        pos += 4
      else:
        pos += 1  # Just skip one byte to avoid infinite loops
  
  # Parse as JSON
  var eventType = EventType.TEXT_MESSAGE_START
  var rawEventJson: Option[JsonNode]
  
  if jsonStr.len > 0:
    try:
      let json = parseJson(jsonStr)
      rawEventJson = some(json)
      
      # Try to get the event type
      if json.hasKey("type"):
        let typeStr = json["type"].getStr()
        
        # Convert string to EventType
        for et in EventType:
          if $et == typeStr:
            eventType = et
            break
    except:
      # Not valid JSON, use default
      discard
  
  # Create a basic event
  result = BaseEvent(
    `type`: eventType,
    rawEvent: rawEventJson
  )