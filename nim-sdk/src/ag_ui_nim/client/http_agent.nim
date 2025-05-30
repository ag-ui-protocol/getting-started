import std/[options, asyncdispatch, httpclient, json, strutils, streams]
import ./agent
import ../core/[types, events]
import ../encoder/encoder

type
  HttpAgent* = ref object of AbstractAgent
    url*: string
    headers*: HttpHeaders
    httpClient*: AsyncHttpClient
    abortSignal*: bool

proc newHttpAgent*(
  url: string,
  headers: HttpHeaders = newHttpHeaders(),
  agentId: string = "",
  description: string = "",
  threadId: Option[string] = none(string),
  initialMessages: seq[Message] = @[],
  initialState: State = newJNull()
): HttpAgent =
  result = HttpAgent()
  result.url = url
  result.headers = headers
  result.httpClient = newAsyncHttpClient()
  result.abortSignal = false
  result.agentId = agentId
  result.description = description
  result.threadId = threadId
  result.messages = initialMessages
  result.state = initialState

proc requestInit*(self: HttpAgent, input: RunAgentInput): (HttpMethod, string, HttpHeaders) =
  var headers = self.headers
  headers["Content-Type"] = "application/json"
  headers["Accept"] = "text/event-stream"
  
  let body = $input.toJson()
  return (HttpPost, body, headers)

proc parseSSEEvent(data: string): Option[Event] =
  if data.startsWith("data: "):
    let jsonStr = data[6..^1].strip()
    if jsonStr.len > 0:
      try:
        let jsonData = parseJson(jsonStr)
        # Parse the event based on type field
        if jsonData.hasKey("type"):
          let eventType = jsonData["type"].getStr()
          case eventType:
          of "TEXT_MESSAGE_START":
            var event = Event(kind: EkTextMessageStart)
            event.textMessageStart = TextMessageStartEvent()
            event.textMessageStart.`type` = TEXT_MESSAGE_START
            event.textMessageStart.messageId = jsonData["messageId"].getStr()
            event.textMessageStart.role = jsonData["role"].getStr()
            return some(event)
          of "TEXT_MESSAGE_CONTENT":
            var event = Event(kind: EkTextMessageContent)
            event.textMessageContent = TextMessageContentEvent()
            event.textMessageContent.`type` = TEXT_MESSAGE_CONTENT
            event.textMessageContent.messageId = jsonData["messageId"].getStr()
            event.textMessageContent.delta = jsonData["delta"].getStr()
            return some(event)
          of "TEXT_MESSAGE_END":
            var event = Event(kind: EkTextMessageEnd)
            event.textMessageEnd = TextMessageEndEvent()
            event.textMessageEnd.`type` = TEXT_MESSAGE_END
            event.textMessageEnd.messageId = jsonData["messageId"].getStr()
            return some(event)
          # Add more event types as needed
          else:
            discard
      except:
        discard
  return none(Event)

method run*(self: HttpAgent, input: RunAgentInput): Future[EventStream] {.async.} =
  let (httpMethod, body, headers) = self.requestInit(input)
  
  var events: seq[Event] = @[]
  
  try:
    # Make the HTTP request
    let response = await self.httpClient.request(
      self.url,
      httpMethod = httpMethod,
      body = body,
      headers = headers
    )
    
    if response.code != Http200:
      raise newException(ValueError, "HTTP request failed with status: " & $response.code)
    
    # Read the response body
    let responseBody = await response.body
    var buffer = ""
    
    # Parse SSE events from the response
    for line in responseBody.splitLines():
      if line.startsWith("data: "):
        let event = parseSSEEvent(line)
        if event.isSome:
          events.add(event.get)
      elif line == "":
        # Empty line separates events
        buffer = ""
    
  except Exception as e:
    # Add error event
    var errorEvent = Event(kind: EkRunError)
    errorEvent.runError = newRunErrorEvent(e.msg)
    events.add(errorEvent)
  
  # Return an iterator that yields the collected events
  return iterator: Event {.closure.} =
    for event in events:
      yield event

method abortRun*(self: HttpAgent) =
  self.abortSignal = true
  # Cancel the HTTP request if possible
  if self.httpClient != nil:
    self.httpClient.close()
    self.httpClient = newAsyncHttpClient()

proc runAgent*(self: HttpAgent, parameters: JsonNode = %*{}): Future[EventPipeline] {.async.} =
  # Reset abort signal
  self.abortSignal = false
  
  # Call parent implementation
  result = await procCall AbstractAgent(self).runAgent(parameters)

proc clone*(self: HttpAgent): HttpAgent =
  result = newHttpAgent(
    url = self.url,
    headers = self.headers,
    agentId = self.agentId,
    description = self.description,
    threadId = self.threadId,
    initialMessages = self.messages,
    initialState = self.state.copy()
  )

export HttpAgent, newHttpAgent