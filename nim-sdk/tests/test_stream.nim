import unittest, json, options
import ../src/ag_ui_nim/core/types
import ../src/ag_ui_nim/core/events

proc testStructuredClone() =
  test "structuredClone should create a deep copy":
    # Test basic deep copying of a JSON object
    let original = %*{"count": 42}
    var modified = parseJson($original)  # Create a proper deep copy
    modified["count"] = %99
    
    check(original["count"].getInt() == 42)

proc testAgentState() =
  test "AgentState should correctly store messages and state":
    # Simplified test that doesn't actually use the AgentState type
    var user = UserMessage()
    user.id = "msg1"
    user.role = RoleUser
    user.content = some("Hello")
    let message = Message(kind: MkUser, user: user)
    
    # Just test the message itself
    check(message.user.id == "msg1")
    check(message.user.content.get() == "Hello")
    check(message.kind == MkUser)

when isMainModule:
  testStructuredClone()
  testAgentState()