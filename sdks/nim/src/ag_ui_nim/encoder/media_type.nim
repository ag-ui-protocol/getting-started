import strutils
import tables
import sequtils
import strformat

type
  MediaType* = object
    `type`*: string
    subtype*: string
    params*: Table[string, string]
    q*: float
    i*: int
  
  Priority* = object
    o*: int
    q*: float
    s*: int
    i*: int

proc splitMediaTypes(accept: string): seq[string] =
  ## Split Accept header into media types
  result = @[]
  var parts = accept.split(',')
  
  # Handle quoted parts
  var i = 0
  while i < parts.len:
    var part = parts[i]
    var quoteCount = part.count('"')
    
    # If odd quotes, join with next part
    while quoteCount mod 2 == 1 and i + 1 < parts.len:
      i += 1
      part &= "," & parts[i]
      quoteCount = part.count('"')
    
    result.add(part)
    i += 1

proc splitParameters(param: string): seq[string] =
  ## Split parameters by semicolons
  result = param.split(';')
  
  # Handle quoted parameters
  var i = 0
  while i < result.len:
    var part = result[i]
    var quoteCount = part.count('"')
    
    # If odd quotes, join with next part
    while quoteCount mod 2 == 1 and i + 1 < result.len:
      i += 1
      part &= ";" & result[i]
      quoteCount = part.count('"')
    
    result[i] = part
    i += 1
  
  # Trim each part
  for i in 0..<result.len:
    result[i] = result[i].strip()

proc parseMediaType(str: string, i: int): MediaType =
  ## Parse a media type
  var params = initTable[string, string]()
  var q = 1.0
  
  # Simple regex equivalent for media type
  let parts = str.strip().split(';', 1)
  let mediaTypeParts = parts[0].strip().split('/', 2)
  
  if mediaTypeParts.len != 2:
    raise newException(ValueError, fmt"Invalid media type: {str}")
  
  let mtype = mediaTypeParts[0].strip()
  let subtype = mediaTypeParts[1].strip()
  
  # Parse parameters if any
  if parts.len > 1:
    let paramStr = parts[1]
    let paramParts = splitParameters(paramStr)
    
    for paramPart in paramParts:
      let kv = paramPart.split('=', 1)
      if kv.len == 2:
        let key = kv[0].strip().toLowerAscii()
        var value = kv[1].strip()
        
        # Unwrap quotes
        if value.len >= 2 and value[0] == '"' and value[^1] == '"':
          value = value[1..^2]
        
        if key == "q":
          try:
            q = parseFloat(value)
          except:
            q = 1.0
        else:
          params[key] = value
  
  result = MediaType(
    `type`: mtype,
    subtype: subtype,
    params: params,
    q: q,
    i: i
  )

proc parseAccept(accept: string): seq[MediaType] =
  ## Parse Accept header into media types
  result = @[]
  let mediaTypes = splitMediaTypes(accept)
  
  for i, mediaType in mediaTypes:
    try:
      result.add(parseMediaType(mediaType, i))
    except:
      # Skip invalid media types
      discard

proc getFullType(mediaType: MediaType): string =
  ## Get the full type string
  result = mediaType.`type` & "/" & mediaType.subtype

proc specify(typeStr: string, spec: MediaType, index: int): Priority =
  ## Get specificity of media type
  var s = 0
  
  try:
    let p = parseMediaType(typeStr, 0)
    
    # Type match
    if spec.`type`.toLowerAscii() == p.`type`.toLowerAscii():
      s = s or 4
    elif spec.`type` != "*":
      return Priority()
    
    # Subtype match
    if spec.subtype.toLowerAscii() == p.subtype.toLowerAscii():
      s = s or 2
    elif spec.subtype != "*":
      return Priority()
    
    # Parameter match
    let keys = toSeq(spec.params.keys)
    if keys.len > 0:
      var allMatch = true
      for k in keys:
        if spec.params[k] != "*" and (not p.params.hasKey(k) or 
           spec.params[k].toLowerAscii() != p.params[k].toLowerAscii()):
          allMatch = false
          break
      
      if allMatch:
        s = s or 1
      else:
        return Priority()
    
    result = Priority(
      o: spec.i,
      q: spec.q,
      s: s,
      i: index
    )
  except:
    return Priority()

proc compareSpecs(a, b: Priority): int =
  ## Compare two priorities
  if b.q != a.q:
    return if b.q > a.q: 1 else: -1
  
  if b.s != a.s:
    return if b.s > a.s: 1 else: -1
  
  if a.o != b.o:
    return if a.o < b.o: 1 else: -1
  
  if a.i != b.i:
    return if a.i < b.i: 1 else: -1
  
  return 0

proc getMediaTypePriority(typeStr: string, accepted: seq[MediaType], index: int): Priority =
  ## Get priority of media type
  result = Priority(o: -1, q: 0, s: 0)
  
  for i, spec in accepted:
    let priority = specify(typeStr, spec, index)
    if priority.s > 0 and (result.s < priority.s or 
       (result.s == priority.s and result.q < priority.q) or
       (result.s == priority.s and result.q == priority.q and result.o > priority.o)):
      result = priority

proc preferredMediaTypes*(accept: string, provided: seq[string] = @[]): seq[string] =
  ## Get preferred media types from Accept header
  let acceptVal = if accept.len == 0: "*/*" else: accept
  let accepts = parseAccept(acceptVal)
  
  if provided.len == 0:
    # Return all accepted types sorted by priority
    result = accepts
      .filter(proc(m: MediaType): bool = m.q > 0)
      .sorted(proc(a, b: MediaType): int =
        if b.q != a.q: (if b.q > a.q: 1 else: -1)
        else: (if b.i < a.i: 1 else: -1))
      .map(getFullType)
    return
  
  # Get priorities for provided types
  var priorities: seq[Priority] = @[]
  for i, typeStr in provided:
    priorities.add(getMediaTypePriority(typeStr, accepts, i))
  
  # Sort by priority
  var sortedIndices = toSeq(0..<priorities.len)
    .filter(proc(i: int): bool = priorities[i].q > 0)
    .sorted(proc(a, b: int): int = compareSpecs(priorities[a], priorities[b]))
  
  # Map back to media types
  for i in sortedIndices:
    result.add(provided[i])