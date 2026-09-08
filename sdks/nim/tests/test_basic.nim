import ../src/ag_ui_nim
import std/[json, options]

# Test that the modules compile and can be imported
block:
  echo "Testing basic imports..."
  
  # Test creating types
  let msg = newUserMessage("123", "Hello world")
  let ctx = newContext("test context", "value")
  
  # Test creating events
  let event = newTextMessageStartEvent("msg-1", "assistant")
  
  # Test encoder
  let encoder = newEventEncoder()
  let encoded = encoder.encode(event)
  
  echo "Basic import test passed!"

echo "All tests completed successfully!"