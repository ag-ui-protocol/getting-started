import unittest, json, options, asyncdispatch, httpclient, strutils
import ../src/ag_ui_nim/client/http_agent
import ../src/ag_ui_nim/client/agent  # For EventStream
import ../src/ag_ui_nim/core/[types, events]

# Simple mock for HTTP testing
type
  MockHttpAgent* = ref object of HttpAgent
    mockResponseCode*: HttpCode
    mockResponseBody*: string
    lastRequestBody*: string
    requestCount*: int

proc newMockHttpAgent*(url: string): MockHttpAgent =
  result = MockHttpAgent()
  result.url = url
  result.headers = newHttpHeaders()
  result.mockResponseCode = Http200
  result.mockResponseBody = ""
  result.requestCount = 0
  result.abortSignal = false
  result.httpClient = nil  # Don't use actual HTTP client

method run*(self: MockHttpAgent, input: RunAgentInput): Future[EventStream] {.async.} =
  self.lastRequestBody = $input.toJson()
  self.requestCount += 1
  
  if self.mockResponseCode == Http404:
    return iterator: Event {.closure.} =
      var errorEvent = Event(kind: EkRunError)
      errorEvent.runError = newRunErrorEvent("404 error")
      yield errorEvent
  
  # Parse mock SSE response
  var events: seq[Event] = @[]
  for line in self.mockResponseBody.splitLines():
    if line.startsWith("data: "):
      let jsonStr = line[6..^1].strip()
      if jsonStr.len > 0:
        try:
          let jsonData = parseJson(jsonStr)
          if jsonData.hasKey("type"):
            case jsonData["type"].getStr():
            of "TEXT_MESSAGE_START":
              var event = Event(kind: EkTextMessageStart)
              event.textMessageStart = newTextMessageStartEvent(
                jsonData["messageId"].getStr(),
                jsonData["role"].getStr()
              )
              events.add(event)
            of "TEXT_MESSAGE_CONTENT":
              var event = Event(kind: EkTextMessageContent)
              event.textMessageContent = newTextMessageContentEvent(
                jsonData["messageId"].getStr(),
                jsonData["delta"].getStr()
              )
              events.add(event)
            of "TEXT_MESSAGE_END":
              var event = Event(kind: EkTextMessageEnd)
              event.textMessageEnd = newTextMessageEndEvent(
                jsonData["messageId"].getStr()
              )
              events.add(event)
            else:
              discard
        except:
          discard
  
  return iterator: Event {.closure.} =
    for event in events:
      yield event

suite "HTTP Agent Tests":
  test "HttpAgent creation":
    let headers = newHttpHeaders({"Authorization": "Bearer token"})
    let agent = newHttpAgent(
      url = "https://api.example.com/agent",
      headers = headers,
      agentId = "http-agent",
      description = "Test HTTP agent"
    )
    
    check agent.url == "https://api.example.com/agent"
    check agent.headers["Authorization"] == "Bearer token"
    check agent.agentId == "http-agent"
    check agent.description == "Test HTTP agent"
    check agent.abortSignal == false
  
  test "requestInit":
    let agent = newHttpAgent("https://api.example.com")
    let input = newRunAgentInput(
      threadId = "thread-123",
      runId = "run-456",
      state = %*{},
      messages = @[],
      tools = @[],
      context = @[],
      forwardedProps = %*{}
    )
    
    let (httpMethod, body, headers) = agent.requestInit(input)
    
    check httpMethod == HttpPost
    check headers["Content-Type"] == "application/json"
    check headers["Accept"] == "text/event-stream"
    
    let bodyJson = parseJson(body)
    check bodyJson["threadId"].getStr() == "thread-123"
    check bodyJson["runId"].getStr() == "run-456"
  
  test "run - successful response":
    let agent = newMockHttpAgent("https://api.example.com")
    agent.mockResponseBody = """data: {"type":"TEXT_MESSAGE_START","messageId":"m1","role":"assistant"}
data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"Hello"}
data: {"type":"TEXT_MESSAGE_END","messageId":"m1"}"""
    
    let input = newRunAgentInput("t1", "r1", %*{}, @[], @[], @[], %*{})
    let stream = waitFor agent.run(input)
    
    var events: seq[Event] = @[]
    for event in stream():
      events.add(event)
    
    check events.len == 3
    check events[0].kind == EkTextMessageStart
    check events[1].kind == EkTextMessageContent
    check events[2].kind == EkTextMessageEnd
    check agent.requestCount == 1
  
  test "run - error response":
    let agent = newMockHttpAgent("https://api.example.com")
    agent.mockResponseCode = Http404
    
    let input = newRunAgentInput("t1", "r1", %*{}, @[], @[], @[], %*{})
    let stream = waitFor agent.run(input)
    
    var events: seq[Event] = @[]
    for event in stream():
      events.add(event)
    
    check events.len == 1
    check events[0].kind == EkRunError
    check events[0].runError.message == "404 error"
  
  test "abortRun":
    let agent = newHttpAgent("https://api.example.com")
    check agent.abortSignal == false
    
    agent.abortRun()
    
    check agent.abortSignal == true
  
  test "clone":
    let headers = newHttpHeaders({"X-Test": "value"})
    let agent = newHttpAgent(
      url = "https://api.example.com",
      headers = headers,
      agentId = "original",
      threadId = some("thread-123")
    )
    
    let cloned = agent.clone()
    
    check cloned.url == agent.url
    check cloned.headers["X-Test"] == "value"
    check cloned.agentId == agent.agentId
    check cloned.threadId == agent.threadId
  
  test "runAgent integration":
    let agent = newMockHttpAgent("https://api.example.com")
    agent.mockResponseBody = """data: {"type":"TEXT_MESSAGE_START","messageId":"m1","role":"assistant"}
data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"Test"}
data: {"type":"TEXT_MESSAGE_END","messageId":"m1"}"""
    
    # Initialize the agent state to avoid nil issues
    agent.state = %*{}
    agent.messages = @[]
    
    let params = %*{
      "tools": [{"name": "test", "description": "Test tool", "parameters": {}}]
    }
    
    let pipeline = waitFor agent.runAgent(params)
    
    check pipeline.error.isNone
    # Should have original events + run started/finished
    check pipeline.events.len >= 3
    check pipeline.events[0].kind == EkRunStarted
    check pipeline.events[^1].kind == EkRunFinished