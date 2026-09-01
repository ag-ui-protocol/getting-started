package com.agui.tests

import com.agui.core.types.AgUiJson
import com.agui.core.types.*
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.*
import kotlin.test.*

@OptIn(ExperimentalSerializationApi::class)
class MessageProtocolComplianceTest {

    private val json = AgUiJson

    // Test that messages follow AG-UI protocol format

    @Test
    fun testUserMessageProtocolCompliance() {
        val message = UserMessage(
            id = "msg_user_123",
            content = "What's the weather like?"
        )

        val jsonString = json.encodeToString<Message>(message)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject

        // AG-UI protocol compliance checks
        assertEquals("msg_user_123", jsonObj["id"]?.jsonPrimitive?.content)
        assertEquals("user", jsonObj["role"]?.jsonPrimitive?.content)
        assertEquals("What's the weather like?", jsonObj["content"]?.jsonPrimitive?.content)

        // Ensure no 'type' field (AG-UI uses 'role' only)
        assertFalse(jsonObj.containsKey("type"))

        // Verify optional fields
        assertFalse(jsonObj.containsKey("name")) // null name should not be included

        val decoded = json.decodeFromString<Message>(jsonString)
        assertTrue(decoded is UserMessage)
        assertEquals(message, decoded)
    }

    @Test
    fun testUserMessageWithName() {
        val message = UserMessage(
            id = "msg_user_456",
            content = "Hello!",
            name = "John Doe"
        )

        val jsonString = json.encodeToString<Message>(message)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject

        assertEquals("John Doe", jsonObj["name"]?.jsonPrimitive?.content)

        val decoded = json.decodeFromString<Message>(jsonString)
        assertTrue(decoded is UserMessage)
        assertEquals("John Doe", decoded.name)
    }

    @Test
    fun testAssistantMessageProtocolCompliance() {
        val message = AssistantMessage(
            id = "msg_asst_789",
            content = "I can help you with that."
        )

        val jsonString = json.encodeToString<Message>(message)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject

        assertEquals("msg_asst_789", jsonObj["id"]?.jsonPrimitive?.content)
        assertEquals("assistant", jsonObj["role"]?.jsonPrimitive?.content)
        assertEquals("I can help you with that.", jsonObj["content"]?.jsonPrimitive?.content)

        // No toolCalls field when null
        assertFalse(jsonObj.containsKey("toolCalls"))

        val decoded = json.decodeFromString<Message>(jsonString)
        assertTrue(decoded is AssistantMessage)
        assertEquals(message, decoded)
    }

    @Test
    fun testAssistantMessageWithToolCalls() {
        val toolCalls = listOf(
            ToolCall(
                id = "call_abc123",
                function = FunctionCall(
                    name = "get_weather",
                    arguments = """{"location": "New York", "unit": "fahrenheit"}"""
                )
            ),
            ToolCall(
                id = "call_def456",
                function = FunctionCall(
                    name = "get_time",
                    arguments = """{"timezone": "EST"}"""
                )
            )
        )

        val message = AssistantMessage(
            id = "msg_asst_tools",
            content = "Let me check that for you.",
            toolCalls = toolCalls
        )

        val jsonString = json.encodeToString<Message>(message)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject

        // Verify tool calls structure
        val toolCallsArray = jsonObj["toolCalls"]?.jsonArray
        assertNotNull(toolCallsArray)
        assertEquals(2, toolCallsArray.size)

        // Check first tool call
        val firstCall = toolCallsArray[0].jsonObject
        assertEquals("call_abc123", firstCall["id"]?.jsonPrimitive?.content)
        assertEquals("function", firstCall["type"]?.jsonPrimitive?.content)

        val functionObj = firstCall["function"]?.jsonObject
        assertNotNull(functionObj)
        assertEquals("get_weather", functionObj["name"]?.jsonPrimitive?.content)
        assertEquals(
            """{"location": "New York", "unit": "fahrenheit"}""",
            functionObj["arguments"]?.jsonPrimitive?.content
        )

        val decoded = json.decodeFromString<Message>(jsonString)
        assertTrue(decoded is AssistantMessage)
        assertEquals(message.toolCalls?.size, decoded.toolCalls?.size)
    }

    @Test
    fun testAssistantMessageWithNullContent() {
        // Assistant messages can have null content when using tools
        val message = AssistantMessage(
            id = "msg_asst_null",
            content = null,
            toolCalls = listOf(
                ToolCall(
                    id = "call_123",
                    function = FunctionCall(name = "action", arguments = "{}")
                )
            )
        )

        val jsonString = json.encodeToString<Message>(message)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject

        // content field should not be present when null
        assertFalse(jsonObj.containsKey("content"))
        assertTrue(jsonObj.containsKey("toolCalls"))

        val decoded = json.decodeFromString<Message>(jsonString)
        assertTrue(decoded is AssistantMessage)
        assertNull(decoded.content)
    }

    @Test
    fun testSystemMessageProtocolCompliance() {
        val message = SystemMessage(
            id = "msg_sys_001",
            content = "You are a helpful assistant."
        )

        val jsonString = json.encodeToString<Message>(message)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject

        assertEquals("msg_sys_001", jsonObj["id"]?.jsonPrimitive?.content)
        assertEquals("system", jsonObj["role"]?.jsonPrimitive?.content)
        assertEquals("You are a helpful assistant.", jsonObj["content"]?.jsonPrimitive?.content)

        val decoded = json.decodeFromString<Message>(jsonString)
        assertTrue(decoded is SystemMessage)
        assertEquals(message, decoded)
    }

    @Test
    fun testToolMessageProtocolCompliance() {
        val message = ToolMessage(
            id = "msg_tool_result",
            content = """{"temperature": 72, "condition": "sunny"}""",
            toolCallId = "call_abc123"
        )

        val jsonString = json.encodeToString<Message>(message)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject

        assertEquals("msg_tool_result", jsonObj["id"]?.jsonPrimitive?.content)
        assertEquals("tool", jsonObj["role"]?.jsonPrimitive?.content)
        assertEquals("""{"temperature": 72, "condition": "sunny"}""", jsonObj["content"]?.jsonPrimitive?.content)
        assertEquals("call_abc123", jsonObj["toolCallId"]?.jsonPrimitive?.content)

        val decoded = json.decodeFromString<Message>(jsonString)
        assertTrue(decoded is ToolMessage)
        assertEquals(message, decoded)
    }

    @Test
    fun testDeveloperMessageProtocolCompliance() {
        val message = DeveloperMessage(
            id = "msg_dev_debug",
            content = "Debug: Processing started",
            name = "debugger"
        )

        val jsonString = json.encodeToString<Message>(message)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject

        assertEquals("msg_dev_debug", jsonObj["id"]?.jsonPrimitive?.content)
        assertEquals("developer", jsonObj["role"]?.jsonPrimitive?.content)
        assertEquals("Debug: Processing started", jsonObj["content"]?.jsonPrimitive?.content)
        assertEquals("debugger", jsonObj["name"]?.jsonPrimitive?.content)

        val decoded = json.decodeFromString<Message>(jsonString)
        assertTrue(decoded is DeveloperMessage)
        assertEquals(message, decoded)
    }

    @Test
    fun testMessageListPolymorphicSerialization() {
        val messages: List<Message> = listOf(
            SystemMessage(id = "1", content = "System initialized"),
            UserMessage(id = "2", content = "Hello"),
            AssistantMessage(
                id = "3",
                content = "Hi! I'll help you.",
                toolCalls = listOf(
                    ToolCall(
                        id = "tc1",
                        function = FunctionCall("greet", "{}")
                    )
                )
            ),
            ToolMessage(id = "4", content = "Greeting sent", toolCallId = "tc1"),
            DeveloperMessage(id = "5", content = "Log entry")
        )

        val jsonString = json.encodeToString(messages)
        val jsonArray = json.parseToJsonElement(jsonString).jsonArray

        assertEquals(5, jsonArray.size)

        // Verify each message maintains correct role
        assertEquals("system", jsonArray[0].jsonObject["role"]?.jsonPrimitive?.content)
        assertEquals("user", jsonArray[1].jsonObject["role"]?.jsonPrimitive?.content)
        assertEquals("assistant", jsonArray[2].jsonObject["role"]?.jsonPrimitive?.content)
        assertEquals("tool", jsonArray[3].jsonObject["role"]?.jsonPrimitive?.content)
        assertEquals("developer", jsonArray[4].jsonObject["role"]?.jsonPrimitive?.content)

        val decoded: List<Message> = json.decodeFromString(jsonString)
        assertEquals(messages.size, decoded.size)

        // Verify type preservation
        assertTrue(decoded[0] is SystemMessage)
        assertTrue(decoded[1] is UserMessage)
        assertTrue(decoded[2] is AssistantMessage)
        assertTrue(decoded[3] is ToolMessage)
        assertTrue(decoded[4] is DeveloperMessage)
    }

    @Test
    fun testMessageContentWithSpecialCharacters() {
        val specialContent = """
            Special characters test:
            - Quotes: "double" and 'single'
            - Newlines: 
            Line 1
            Line 2
            - Tabs:	Tab1	Tab2
            - Backslashes: \path\to\file
            - Unicode: 🚀 ñ © ™
            - JSON in content: {"key": "value"}
        """.trimIndent()

        val message = UserMessage(
            id = "msg_special",
            content = specialContent
        )

        val jsonString = json.encodeToString<Message>(message)
        val decoded = json.decodeFromString<Message>(jsonString)

        assertTrue(decoded is UserMessage)
        assertEquals(specialContent, decoded.content)
    }

    @Test
    fun testToolCallArgumentsSerialization() {
        // Test various argument formats
        val testCases = listOf(
            "{}",
            """{"simple": "value"}""",
            """{"nested": {"key": "value"}}""",
            """{"array": [1, 2, 3]}""",
            """{"mixed": {"str": "text", "num": 42, "bool": true, "null": null}}""",
            """{"escaped": "line1\nline2\ttab"}"""
        )

        testCases.forEach { args ->
            val toolCall = ToolCall(
                id = "test_call",
                function = FunctionCall(
                    name = "test_function",
                    arguments = args
                )
            )

            val message = AssistantMessage(
                id = "test_msg",
                content = null,
                toolCalls = listOf(toolCall)
            )

            val jsonString = json.encodeToString<Message>(message)
            try {
                val decoded = json.decodeFromString<Message>(jsonString)
                assertTrue(decoded is AssistantMessage)
                assertEquals(args, decoded.toolCalls?.first()?.function?.arguments)
            } catch (e: Exception) {
                fail("Failed to serialize/deserialize tool call with arguments: $args - ${e.message}")
            }
        }
    }

    @Test
    fun testMessageIdFormats() {
        // Test various ID formats that might be used
        val idFormats = listOf(
            "simple_id",
            "msg_123456789",
            "00000000-0000-0000-0000-000000000000", // UUID
            "msg_2024_01_15_12_30_45_123",
            "a1b2c3d4e5f6",
            "MESSAGE#USER#12345"
        )

        idFormats.forEach { id ->
            val message = UserMessage(id = id, content = "Test")
            val jsonString = json.encodeToString<Message>(message)
            val decoded = json.decodeFromString<Message>(jsonString)

            assertEquals(id, decoded.id)
        }
    }

    @Test
    fun testRoleEnumCoverage() {
        // Ensure all Role enum values can be used in messages
        val roles = mapOf(
            Role.USER to UserMessage(id = "1", content = "test"),
            Role.ASSISTANT to AssistantMessage(id = "2", content = "test"),
            Role.SYSTEM to SystemMessage(id = "3", content = "test"),
            Role.TOOL to ToolMessage(id = "4", content = "test", toolCallId = "tc"),
            Role.DEVELOPER to DeveloperMessage(id = "5", content = "test")
        )

        roles.forEach { (expectedRole, message) ->
            assertEquals(expectedRole, message.messageRole)

            val jsonString = json.encodeToString<Message>(message)
            val decoded = json.decodeFromString<Message>(jsonString)

            assertEquals(expectedRole, decoded.messageRole)
        }
    }

    @Test
    fun testEmptyContentHandling() {
        // Test messages with empty content (different from null)
        val emptyContentMessage = UserMessage(
            id = "empty_content",
            content = ""
        )

        val jsonString = json.encodeToString<Message>(emptyContentMessage)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject

        // Empty string should be preserved
        assertEquals("", jsonObj["content"]?.jsonPrimitive?.content)

        val decoded = json.decodeFromString<Message>(jsonString)
        assertTrue(decoded is UserMessage)
        assertEquals("", decoded.content)
    }

    @Test
    fun testToolCallTypeAlwaysFunction() {
        // Test that ToolCall.callType is always "function" when deserializing
        val toolCall = ToolCall(
            id = "call_test",
            function = FunctionCall(
                name = "test_function",
                arguments = "{\"param\": \"value\"}"
            )
        )

        val message = AssistantMessage(
            id = "msg_test",
            content = null,
            toolCalls = listOf(toolCall)
        )

        val jsonString = json.encodeToString<Message>(message)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject
        
        // Verify callType is "function" in JSON
        val toolCallsArray = jsonObj["toolCalls"]?.jsonArray
        assertNotNull(toolCallsArray)
        val firstToolCall = toolCallsArray[0].jsonObject
        assertEquals("function", firstToolCall["type"]?.jsonPrimitive?.content)

        // Verify callType is "function" after deserialization
        val decoded = json.decodeFromString<Message>(jsonString)
        assertTrue(decoded is AssistantMessage)
        val decodedToolCall = decoded.toolCalls?.first()
        assertNotNull(decodedToolCall)
        assertEquals("function", decodedToolCall.callType)
    }

    @Test
    fun testSystemMessageRequiredContentField() {
        // Test that SystemMessage requires content to be provided
        val message = SystemMessage(
            id = "sys_required",
            content = "Required system message content"
        )

        val jsonString = json.encodeToString<Message>(message)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject

        // Content field must be present and non-null for system messages
        assertTrue(jsonObj.containsKey("content"))
        assertEquals("Required system message content", jsonObj["content"]?.jsonPrimitive?.content)

        val decoded = json.decodeFromString<Message>(jsonString)
        assertTrue(decoded is SystemMessage)
        assertEquals("Required system message content", decoded.content)
    }

    @Test
    fun testMessageRoleValidation() {
        // Test that each message type has the correct role
        val messages = listOf(
            UserMessage(id = "1", content = "user") to "user",
            AssistantMessage(id = "2", content = "assistant") to "assistant", 
            SystemMessage(id = "3", content = "system") to "system",
            ToolMessage(id = "4", content = "tool", toolCallId = "tc1") to "tool",
            DeveloperMessage(id = "5", content = "developer") to "developer"
        )

        messages.forEach { (message, expectedRole) ->
            val jsonString = json.encodeToString<Message>(message)
            val jsonObj = json.parseToJsonElement(jsonString).jsonObject
            
            assertEquals(expectedRole, jsonObj["role"]?.jsonPrimitive?.content)
            
            val decoded = json.decodeFromString<Message>(jsonString)
            assertEquals(expectedRole, decoded.messageRole.name.lowercase())
        }
    }

    @Test
    fun testLargeMessageHandling() {
        // Test handling of very large message content
        val largeContent = "A".repeat(10000) // 10KB string
        
        val message = UserMessage(
            id = "large_msg",
            content = largeContent
        )

        val jsonString = json.encodeToString<Message>(message)
        val decoded = json.decodeFromString<Message>(jsonString)
        
        assertTrue(decoded is UserMessage)
        assertEquals(largeContent, decoded.content)
        assertEquals(10000, decoded.content.length)
    }

    @Test
    fun testToolCallWithComplexArguments() {
        // Test tool calls with nested JSON arguments
        val complexArgs = """
        {
            "query": "search term",
            "filters": {
                "date_range": {
                    "start": "2024-01-01",
                    "end": "2024-12-31"
                },
                "categories": ["tech", "science"],
                "price_range": {
                    "min": 0,
                    "max": 1000
                }
            },
            "sort": ["relevance", "date"],
            "limit": 25,
            "include_metadata": true
        }
        """.trimIndent()

        val toolCall = ToolCall(
            id = "complex_call",
            function = FunctionCall(
                name = "advanced_search",
                arguments = complexArgs
            )
        )

        val message = AssistantMessage(
            id = "complex_msg",
            content = "Let me search for that",
            toolCalls = listOf(toolCall)
        )

        val jsonString = json.encodeToString<Message>(message)
        val decoded = json.decodeFromString<Message>(jsonString)
        
        assertTrue(decoded is AssistantMessage)
        val decodedToolCall = decoded.toolCalls?.first()
        assertNotNull(decodedToolCall)
        assertEquals("complex_call", decodedToolCall.id)
        assertEquals("advanced_search", decodedToolCall.function.name)
        
        // Verify the arguments can be parsed as valid JSON
        val parsedArgs = json.parseToJsonElement(decodedToolCall.function.arguments)
        assertTrue(parsedArgs.jsonObject.containsKey("query"))
        assertTrue(parsedArgs.jsonObject.containsKey("filters"))
    }

    @Test
    fun testMessageWithUnicodeContent() {
        // Test messages with various Unicode characters
        val unicodeContent = """
            🚀 Emojis: 😀 😂 🤔 💡 ⚡ 🌟
            Symbols: © ® ™ ℃ ℉ ± × ÷ ∞
            Languages: English, Español, Français, Deutsch, 中文, 日本語, العربية, Русский
            Math: ∫ ∑ ∏ √ ∂ ∇ α β γ δ ε ζ η θ
            Special: \u0000 \u001F \u007F \u0080 \u009F
        """.trimIndent()

        val message = UserMessage(
            id = "unicode_msg",
            content = unicodeContent
        )

        val jsonString = json.encodeToString<Message>(message)
        val decoded = json.decodeFromString<Message>(jsonString)
        
        assertTrue(decoded is UserMessage)
        assertEquals(unicodeContent, decoded.content)
    }

    @Test
    fun testMessageNameFieldHandling() {
        // Test optional name field behavior across message types
        val messagesWithNames = listOf(
            UserMessage(id = "u1", content = "test", name = "user_name"),
            AssistantMessage(id = "a1", content = "test", name = "assistant_name"),
            SystemMessage(id = "s1", content = "test", name = "system_name"),
            ToolMessage(id = "t1", content = "test", toolCallId = "tc1", name = "tool_name"),
            DeveloperMessage(id = "d1", content = "test", name = "dev_name")
        )

        messagesWithNames.forEach { message ->
            val jsonString = json.encodeToString<Message>(message)
            val jsonObj = json.parseToJsonElement(jsonString).jsonObject
            
            assertTrue(jsonObj.containsKey("name"))
            assertNotNull(jsonObj["name"]?.jsonPrimitive?.content)
            
            val decoded = json.decodeFromString<Message>(jsonString)
            assertNotNull(decoded.name)
        }

        // Test messages without names
        val messagesWithoutNames = listOf(
            UserMessage(id = "u2", content = "test"),
            AssistantMessage(id = "a2", content = "test"),
            SystemMessage(id = "s2", content = "test"),
            ToolMessage(id = "t2", content = "test", toolCallId = "tc2"),
            DeveloperMessage(id = "d2", content = "test")
        )

        messagesWithoutNames.forEach { message ->
            val jsonString = json.encodeToString<Message>(message)
            val jsonObj = json.parseToJsonElement(jsonString).jsonObject
            
            // name field should not be present when null
            assertFalse(jsonObj.containsKey("name"))
            
            val decoded = json.decodeFromString<Message>(jsonString)
            assertNull(decoded.name)
        }
    }

    // ============== New Protocol Sync Tests ==============

    @Test
    fun testActivityMessageProtocolCompliance() {
        val activityContent = buildJsonObject {
            put("operations", buildJsonArray { })
        }

        val message = ActivityMessage(
            id = "activity_123",
            activityType = "a2ui-surface",
            activityContent = activityContent
        )

        val jsonString = json.encodeToString<Message>(message)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject

        // AG-UI protocol compliance checks
        assertEquals("activity_123", jsonObj["id"]?.jsonPrimitive?.content)
        assertEquals("activity", jsonObj["role"]?.jsonPrimitive?.content)
        assertEquals("a2ui-surface", jsonObj["activityType"]?.jsonPrimitive?.content)
        assertNotNull(jsonObj["activityContent"])

        // Activity messages should not have "type" field (uses "role")
        assertFalse(jsonObj.containsKey("type"))

        val decoded = json.decodeFromString<Message>(jsonString)
        assertTrue(decoded is ActivityMessage)
        val decodedActivity = decoded as ActivityMessage
        assertEquals("activity_123", decodedActivity.id)
        assertEquals("a2ui-surface", decodedActivity.activityType)
        assertEquals(Role.ACTIVITY, decodedActivity.messageRole)
    }

    @Test
    fun testMultimodalUserMessage() {
        val parts = listOf(
            TextInputContent(text = "What's in this image?"),
            BinaryInputContent(
                mimeType = "image/png",
                url = "https://example.com/image.png"
            )
        )

        val message = UserMessage.multimodal(
            id = "multimodal_123",
            parts = parts
        )

        assertTrue(message.isMultimodal)
        assertEquals("", message.content) // Content is empty for multimodal
        assertNotNull(message.contentParts)
        assertEquals(2, message.contentParts?.size)

        val jsonString = json.encodeToString<Message>(message)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject

        // Content should be an array for multimodal
        val contentElement = jsonObj["content"]
        assertTrue(contentElement is JsonArray)
        val contentArray = contentElement.jsonArray
        assertEquals(2, contentArray.size)

        // Verify first part is text
        val firstPart = contentArray[0].jsonObject
        assertEquals("text", firstPart["type"]?.jsonPrimitive?.content)
        assertEquals("What's in this image?", firstPart["text"]?.jsonPrimitive?.content)

        // Verify second part is binary
        val secondPart = contentArray[1].jsonObject
        assertEquals("binary", secondPart["type"]?.jsonPrimitive?.content)
        assertEquals("image/png", secondPart["mimeType"]?.jsonPrimitive?.content)

        // Deserialize and verify
        val decoded = json.decodeFromString<Message>(jsonString)
        assertTrue(decoded is UserMessage)
        val decodedUser = decoded as UserMessage
        assertTrue(decodedUser.isMultimodal)
        assertEquals(2, decodedUser.contentParts?.size)
    }

    @Test
    fun testToolMessageWithError() {
        val message = ToolMessage(
            id = "tool_error_123",
            content = "Error occurred",
            toolCallId = "call_abc",
            error = "Connection timeout"
        )

        val jsonString = json.encodeToString<Message>(message)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject

        assertEquals("tool_error_123", jsonObj["id"]?.jsonPrimitive?.content)
        assertEquals("tool", jsonObj["role"]?.jsonPrimitive?.content)
        assertEquals("Connection timeout", jsonObj["error"]?.jsonPrimitive?.content)

        val decoded = json.decodeFromString<Message>(jsonString)
        assertTrue(decoded is ToolMessage)
        val decodedTool = decoded as ToolMessage
        assertEquals("Connection timeout", decodedTool.error)
    }

    @Test
    fun testRoleActivityEnum() {
        assertEquals("activity", Role.ACTIVITY.name.lowercase())

        val activityMessage = ActivityMessage(
            id = "test",
            activityType = "test-type",
            activityContent = buildJsonObject { }
        )
        assertEquals(Role.ACTIVITY, activityMessage.messageRole)
    }

    @Test
    fun testImageInputContentWithDataSource() {
        val parts = listOf(
            TextInputContent(text = "What's in this image?"),
            ImageInputContent(source = InputContentDataSource(value = "base64data==", mimeType = "image/png"))
        )
        val message = UserMessage.multimodal(id = "msg_1", parts = parts)

        val jsonString = json.encodeToString<Message>(message)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject
        val contentArray = jsonObj["content"]!!.jsonArray

        val imagePart = contentArray[1].jsonObject
        assertEquals("image", imagePart["type"]?.jsonPrimitive?.content)
        val source = imagePart["source"]!!.jsonObject
        assertEquals("data", source["type"]?.jsonPrimitive?.content)
        assertEquals("base64data==", source["value"]?.jsonPrimitive?.content)
        assertEquals("image/png", source["mimeType"]?.jsonPrimitive?.content)

        val decoded = json.decodeFromString<Message>(jsonString)
        assertTrue(decoded is UserMessage)
        val imagePart2 = (decoded as UserMessage).contentParts!![1]
        assertTrue(imagePart2 is ImageInputContent)
        val src = (imagePart2 as ImageInputContent).source
        assertTrue(src is InputContentDataSource)
        assertEquals("base64data==", (src as InputContentDataSource).value)
        assertEquals("image/png", src.mimeType)
    }

    @Test
    fun testDocumentInputContentWithUrlSource() {
        val parts = listOf(
            DocumentInputContent(source = InputContentUrlSource(value = "https://example.com/doc.pdf"))
        )
        val message = UserMessage.multimodal(id = "msg_2", parts = parts)

        val jsonString = json.encodeToString<Message>(message)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject
        val contentArray = jsonObj["content"]!!.jsonArray

        val docPart = contentArray[0].jsonObject
        assertEquals("document", docPart["type"]?.jsonPrimitive?.content)
        val source = docPart["source"]!!.jsonObject
        assertEquals("url", source["type"]?.jsonPrimitive?.content)
        assertEquals("https://example.com/doc.pdf", source["value"]?.jsonPrimitive?.content)

        val decoded = json.decodeFromString<Message>(jsonString)
        assertTrue(decoded is UserMessage)
        val docPart2 = (decoded as UserMessage).contentParts!![0]
        assertTrue(docPart2 is DocumentInputContent)
        val src = (docPart2 as DocumentInputContent).source
        assertTrue(src is InputContentUrlSource)
        assertEquals("https://example.com/doc.pdf", (src as InputContentUrlSource).value)
    }

    @Test
    fun testAllMediaInputContentTypes() {
        val source = InputContentDataSource(value = "data==", mimeType = "application/octet-stream")
        val parts = listOf(
            ImageInputContent(source = source),
            AudioInputContent(source = source),
            VideoInputContent(source = source),
            DocumentInputContent(source = source),
        )
        val message = UserMessage.multimodal(id = "msg_3", parts = parts)

        val jsonString = json.encodeToString<Message>(message)
        val contentArray = json.parseToJsonElement(jsonString).jsonObject["content"]!!.jsonArray

        assertEquals("image", contentArray[0].jsonObject["type"]?.jsonPrimitive?.content)
        assertEquals("audio", contentArray[1].jsonObject["type"]?.jsonPrimitive?.content)
        assertEquals("video", contentArray[2].jsonObject["type"]?.jsonPrimitive?.content)
        assertEquals("document", contentArray[3].jsonObject["type"]?.jsonPrimitive?.content)

        val decoded = json.decodeFromString<Message>(jsonString) as UserMessage
        assertTrue(decoded.contentParts!![0] is ImageInputContent)
        assertTrue(decoded.contentParts!![1] is AudioInputContent)
        assertTrue(decoded.contentParts!![2] is VideoInputContent)
        assertTrue(decoded.contentParts!![3] is DocumentInputContent)
    }
}