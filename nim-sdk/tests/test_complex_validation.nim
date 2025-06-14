import unittest, json, options
import ../src/ag_ui_nim/core/[types, events, validation]

suite "Complex Validation Tests":
  test "JsonSchema validation success":
    let schema = %*{
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "age": {
          "type": "integer"
        }
      },
      "required": ["name"]
    }
    
    let result = validateJsonSchema(schema, "schema")
    check result.kind == JObject
    check result["type"].getStr() == "object"
  
  test "JsonSchema validation with invalid type":
    var schema = %*{
      "properties": {
        "name": {
          "type": "string"
        }
      }
    }
    
    schema["type"] = %123  # Type should be a string or array
    
    expect ValidationError:
      discard validateJsonSchema(schema, "schema")
  
  test "JsonPatch validation success":
    let patch = %*[
      {"op": "add", "path": "/name", "value": "John"},
      {"op": "replace", "path": "/age", "value": 30}
    ]
    
    let result = validateJsonPatch(patch, "patch")
    check result.len == 2
    check result[0]["op"].getStr() == "add"
    check result[1]["op"].getStr() == "replace"
  
  test "JsonPatch validation with invalid op":
    let patch = %*[
      {"op": "invalid", "path": "/name", "value": "John"}
    ]
    
    expect ValidationError:
      discard validateJsonPatch(patch, "patch")
  
  test "FunctionCall validation success":
    let functionCall = %*{
      "name": "search",
      "arguments": "{\"query\": \"test\"}"
    }
    
    let result = validateFunctionCall(functionCall, "functionCall")
    check result.name == "search"
    check result.arguments == "{\"query\": \"test\"}"
  
  test "FunctionCall validation with invalid JSON arguments":
    let functionCall = %*{
      "name": "search",
      "arguments": "{invalid json}"
    }
    
    expect ValidationError:
      discard validateFunctionCall(functionCall, "functionCall")