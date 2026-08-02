using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class AGUIChatMessageExtensionsTest
{
    [Fact]
    public void AsChatMessages_UserMessageWithName_SetsAuthorName()
    {
        var aguiMessages = new AGUIMessage[]
        {
            new AGUIUserMessage
            {
                Id = "msg-1",
                Name = "Alice",
                Content = [new AGUITextInputContent { Text = "Hello" }]
            }
        };

        var chatMessages = aguiMessages.AsChatMessages().ToList();

        Assert.Single(chatMessages);
        Assert.Equal("Alice", chatMessages[0].AuthorName);
        Assert.Equal(ChatRole.User, chatMessages[0].Role);
    }

    [Fact]
    public void AsChatMessages_UserMessageWithoutName_AuthorNameIsNull()
    {
        var aguiMessages = new AGUIMessage[]
        {
            new AGUIUserMessage
            {
                Id = "msg-1",
                Content = [new AGUITextInputContent { Text = "Hello" }]
            }
        };

        var chatMessages = aguiMessages.AsChatMessages().ToList();

        Assert.Single(chatMessages);
        Assert.Null(chatMessages[0].AuthorName);
    }

    [Fact]
    public void AsAGUIMessages_UserWithAuthorName_SetsName()
    {
        var chatMessages = new ChatMessage[]
        {
            new ChatMessage(ChatRole.User, "Hello") { AuthorName = "Bob" }
        };

        var aguiMessages = chatMessages.AsAGUIMessages().ToList();

        Assert.Single(aguiMessages);
        var userMsg = Assert.IsType<AGUIUserMessage>(aguiMessages[0]);
        Assert.Equal("Bob", userMsg.Name);
    }

    [Fact]
    public void AsAGUIMessages_UserWithoutAuthorName_NameIsNull()
    {
        var chatMessages = new ChatMessage[]
        {
            new ChatMessage(ChatRole.User, "Hello")
        };

        var aguiMessages = chatMessages.AsAGUIMessages().ToList();

        Assert.Single(aguiMessages);
        var userMsg = Assert.IsType<AGUIUserMessage>(aguiMessages[0]);
        Assert.Null(userMsg.Name);
    }

    [Fact]
    public void RoundTrip_UserMessageWithName_PreservesName()
    {
        var original = new ChatMessage(ChatRole.User, "Hello") { AuthorName = "Charlie", MessageId = "msg-1" };

        var aguiMessages = new[] { original }.AsAGUIMessages().ToList();
        var roundTripped = aguiMessages.AsChatMessages().ToList();

        Assert.Single(roundTripped);
        Assert.Equal("Charlie", roundTripped[0].AuthorName);
        Assert.Equal("msg-1", roundTripped[0].MessageId);
    }

    [Fact]
    public void AsChatMessages_ToolMessageWithToolCallId_CreatesFunctionResultContent()
    {
        var aguiMessages = new AGUIMessage[]
        {
            new AGUIToolMessage
            {
                Id = "tool-msg-1",
                ToolCallId = "tc_1",
                Content = "72°F, sunny"
            }
        };

        var chatMessages = aguiMessages.AsChatMessages().ToList();

        Assert.Single(chatMessages);
        Assert.Equal(ChatRole.Tool, chatMessages[0].Role);
        var resultContent = Assert.Single(chatMessages[0].Contents.OfType<FunctionResultContent>());
        Assert.Equal("tc_1", resultContent.CallId);
        Assert.Equal("72°F, sunny", resultContent.Result as string);
    }

    [Fact]
    public void AsAGUIMessages_ToolMessage_CreatesAGUIToolMessage()
    {
        var chatMessages = new ChatMessage[]
        {
            new ChatMessage(ChatRole.Tool, [new FunctionResultContent("tc_1", "72°F, sunny")])
            {
                MessageId = "tool-msg-1"
            }
        };

        var aguiMessages = chatMessages.AsAGUIMessages().ToList();

        Assert.Single(aguiMessages);
        var toolMsg = Assert.IsType<AGUIToolMessage>(aguiMessages[0]);
        Assert.Equal("tc_1", toolMsg.ToolCallId);
        Assert.Equal("72°F, sunny", toolMsg.Content);
        // Tool messages are keyed on the tool call id in both directions (the response side
        // likewise sets TOOL_CALL_RESULT.messageId = toolCallId), so the AG-UI message id is the
        // call id rather than the dropped/echoed ChatMessage.MessageId.
        Assert.Equal("tc_1", toolMsg.Id);
    }

    [Fact]
    public void AsAGUIMessages_ToolMessageWithMultipleResults_EmitsOneMessagePerResult()
    {
        // MEAI batches parallel tool results into a single tool ChatMessage carrying multiple
        // FunctionResultContents. The conversion must emit one AGUIToolMessage per result —
        // dropping the extras (the old FirstOrDefault behavior) loses tool output.
        var chatMessages = new ChatMessage[]
        {
            new ChatMessage(ChatRole.Tool,
            [
                new FunctionResultContent("call_weather", "Paris: 22°C, sunny"),
                new FunctionResultContent("call_time", "Asia/Tokyo: 2026-06-18 18:30")
            ])
            {
                MessageId = "tool-msg-batch"
            }
        };

        var aguiMessages = chatMessages.AsAGUIMessages().OfType<AGUIToolMessage>().ToList();

        Assert.Equal(2, aguiMessages.Count);

        var weather = Assert.Single(aguiMessages, m => m.ToolCallId == "call_weather");
        var time = Assert.Single(aguiMessages, m => m.ToolCallId == "call_time");

        // Each message is keyed on its own call id (distinct), never on the shared MessageId.
        Assert.Equal("call_weather", weather.Id);
        Assert.Equal("call_time", time.Id);
        Assert.Equal("Paris: 22°C, sunny", weather.Content);
        Assert.Equal("Asia/Tokyo: 2026-06-18 18:30", time.Content);
    }

    [Fact]
    public void AsChatMessages_MultipleToolMessages_MapToOneFunctionResultEach()
    {
        // AG-UI models each tool result as a separate ToolMessage on the wire. Mapping them
        // 1:1 to tool ChatMessages (one FunctionResultContent each) is the OpenAI-valid shape:
        // the provider emits one tool message per tool_call_id, so no grouping is required.
        var aguiMessages = new AGUIMessage[]
        {
            new AGUIToolMessage { Id = "call_weather", ToolCallId = "call_weather", Content = "Paris: 22°C, sunny" },
            new AGUIToolMessage { Id = "call_time", ToolCallId = "call_time", Content = "Asia/Tokyo: 2026-06-18 18:30" },
        };

        var chatMessages = aguiMessages.AsChatMessages().ToList();

        Assert.Equal(2, chatMessages.Count);
        Assert.All(chatMessages, m =>
        {
            Assert.Equal(ChatRole.Tool, m.Role);
            Assert.Single(m.Contents.OfType<FunctionResultContent>());
        });
        Assert.Equal("call_weather", chatMessages[0].Contents.OfType<FunctionResultContent>().Single().CallId);
        Assert.Equal("call_time", chatMessages[1].Contents.OfType<FunctionResultContent>().Single().CallId);
    }

    [Fact]
    public void AsAGUIMessages_ParallelToolResults_RoundTripPreservesBothResults()
    {
        // Full parallel roundtrip: a single tool ChatMessage with two results -> two AG-UI tool
        // messages -> two tool ChatMessages, with both call ids preserved end to end.
        var chatMessages = new ChatMessage[]
        {
            new ChatMessage(ChatRole.Tool,
            [
                new FunctionResultContent("call_weather", "Paris: 22°C, sunny"),
                new FunctionResultContent("call_time", "Asia/Tokyo: 2026-06-18 18:30")
            ])
        };

        var roundTripped = chatMessages.AsAGUIMessages().AsChatMessages().ToList();

        var callIds = roundTripped
            .SelectMany(m => m.Contents.OfType<FunctionResultContent>())
            .Select(r => r.CallId)
            .OrderBy(id => id, System.StringComparer.Ordinal)
            .ToList();
        Assert.Equal(["call_time", "call_weather"], callIds);
    }

    [Fact]
    public void AsAGUIMessages_ToolResultObjectContent_SerializesToJson()
    {
        var resultObject = new Dictionary<string, object?> { ["temperature"] = 72, ["condition"] = "sunny" };
        var chatMessages = new ChatMessage[]
        {
            new ChatMessage(ChatRole.Tool, [new FunctionResultContent("tc_1", resultObject)])
        };

        var aguiMessages = chatMessages.AsAGUIMessages().ToList();

        var toolMsg = Assert.IsType<AGUIToolMessage>(aguiMessages[0]);
        Assert.Equal("tc_1", toolMsg.ToolCallId);

        // Verify the content is valid JSON, not a type name
        var parsed = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(toolMsg.Content);
        Assert.NotNull(parsed);
        Assert.Equal("sunny", parsed!["condition"].GetString());
    }

    [Fact]
    public void AsChatMessages_AssistantMessageWithToolCalls_CreatesFunctionCallContent()
    {
        var aguiMessages = new AGUIMessage[]
        {
            new AGUIAssistantMessage
            {
                Id = "asst-1",
                Content = string.Empty,
                ToolCalls = new List<AGUIToolCall>
                {
                    new AGUIToolCall
                    {
                        Id = "tc_1",
                        Type = "function",
                        Function = new AGUIToolCallFunction
                        {
                            Name = "get_weather",
                            Arguments = "{\"city\":\"NYC\"}"
                        }
                    }
                }
            }
        };

        var chatMessages = aguiMessages.AsChatMessages().ToList();

        Assert.Single(chatMessages);
        Assert.Equal(ChatRole.Assistant, chatMessages[0].Role);
        var functionCall = Assert.Single(chatMessages[0].Contents.OfType<FunctionCallContent>());
        Assert.Equal("tc_1", functionCall.CallId);
        Assert.Equal("get_weather", functionCall.Name);
        Assert.NotNull(functionCall.Arguments);
        Assert.Equal("NYC", functionCall.Arguments!["city"]!.ToString());
    }

    [Fact]
    public void AsAGUIMessages_AssistantWithFunctionCallContent_CreatesToolCalls()
    {
        var chatMessages = new ChatMessage[]
        {
            new ChatMessage(ChatRole.Assistant,
            [
                new FunctionCallContent("tc_1", "get_weather",
                    new Dictionary<string, object?> { ["city"] = "NYC" })
            ])
        };

        var aguiMessages = chatMessages.AsAGUIMessages().ToList();

        var assistantMsg = Assert.IsType<AGUIAssistantMessage>(aguiMessages[0]);
        Assert.NotNull(assistantMsg.ToolCalls);
        var toolCall = Assert.Single(assistantMsg.ToolCalls!);
        Assert.Equal("tc_1", toolCall.Id);
        Assert.Equal("function", toolCall.Type);
        Assert.Equal("get_weather", toolCall.Function.Name);
        Assert.Contains("NYC", toolCall.Function.Arguments);
    }

    [Fact]
    public void RoundTrip_MultiTurnToolCallConversation_PreservesStructure()
    {
        // Simulate: User -> Assistant(toolCall) -> Tool(result) -> Assistant(response)
        var original = new ChatMessage[]
        {
            new ChatMessage(ChatRole.User, "What's the weather?") { MessageId = "msg-1" },
            new ChatMessage(ChatRole.Assistant,
            [
                new FunctionCallContent("tc_1", "get_weather",
                    new Dictionary<string, object?> { ["city"] = "NYC" })
            ]) { MessageId = "msg-2" },
            new ChatMessage(ChatRole.Tool,
            [
                new FunctionResultContent("tc_1", "72°F, sunny")
            ]) { MessageId = "msg-3" },
            new ChatMessage(ChatRole.Assistant, "The weather in NYC is 72°F and sunny!") { MessageId = "msg-4" }
        };

        var aguiMessages = original.AsAGUIMessages().ToList();
        var roundTripped = aguiMessages.AsChatMessages().ToList();

        Assert.Equal(4, roundTripped.Count);

        // User message
        Assert.Equal(ChatRole.User, roundTripped[0].Role);

        // Assistant with tool call
        Assert.Equal(ChatRole.Assistant, roundTripped[1].Role);
        var functionCall = Assert.Single(roundTripped[1].Contents.OfType<FunctionCallContent>());
        Assert.Equal("tc_1", functionCall.CallId);
        Assert.Equal("get_weather", functionCall.Name);

        // Tool result
        Assert.Equal(ChatRole.Tool, roundTripped[2].Role);
        var functionResult = Assert.Single(roundTripped[2].Contents.OfType<FunctionResultContent>());
        Assert.Equal("tc_1", functionResult.CallId);
        Assert.Equal("72°F, sunny", functionResult.Result as string);

        // Final assistant response
        Assert.Equal(ChatRole.Assistant, roundTripped[3].Role);
        Assert.Equal("The weather in NYC is 72°F and sunny!", roundTripped[3].Text);
    }

    [Fact]
    public void RoundTrip_ToolMessageJsonSerialization_PreservesContent()
    {
        var options = AGUIJsonSerializerContext.Default.Options;

        var toolMessage = new AGUIToolMessage
        {
            Id = "tool-1",
            ToolCallId = "tc_1",
            Content = "plain string result"
        };

        var json = JsonSerializer.Serialize<AGUIMessage>(toolMessage, options);
        var deserialized = JsonSerializer.Deserialize<AGUIMessage>(json, options);

        var roundTripped = Assert.IsType<AGUIToolMessage>(deserialized);
        Assert.Equal("tool", roundTripped.Role);
        Assert.Equal("tc_1", roundTripped.ToolCallId);
        Assert.Equal("plain string result", roundTripped.Content);
    }

    [Fact]
    public void RoundTrip_AssistantMessageWithToolCalls_JsonSerialization()
    {
        var options = AGUIJsonSerializerContext.Default.Options;

        var assistantMessage = new AGUIAssistantMessage
        {
            Id = "asst-1",
            Content = string.Empty,
            ToolCalls = new List<AGUIToolCall>
            {
                new AGUIToolCall
                {
                    Id = "tc_1",
                    Type = "function",
                    Function = new AGUIToolCallFunction
                    {
                        Name = "get_weather",
                        Arguments = "{\"city\":\"NYC\"}"
                    }
                }
            }
        };

        var json = JsonSerializer.Serialize<AGUIMessage>(assistantMessage, options);
        var deserialized = JsonSerializer.Deserialize<AGUIMessage>(json, options);

        var roundTripped = Assert.IsType<AGUIAssistantMessage>(deserialized);
        Assert.NotNull(roundTripped.ToolCalls);
        var toolCall = Assert.Single(roundTripped.ToolCalls!);
        Assert.Equal("tc_1", toolCall.Id);
        Assert.Equal("get_weather", toolCall.Function.Name);
        Assert.Equal("{\"city\":\"NYC\"}", toolCall.Function.Arguments);
    }

    // https://github.com/microsoft/agent-framework/issues/3365
    [Fact]
    public void AsChatMessages_ToolMessageWithJsonContent_PreservesMessageId()
    {
        AGUIMessage[] aguiMessages =
        [
            new AGUIToolMessage
            {
                Id = "msg1",
                Content = """{"status":"success","value":42}""",
                ToolCallId = "call_abc"
            }
        ];

        var chatMessage = Assert.Single(aguiMessages.AsChatMessages().ToList());

        Assert.Equal(ChatRole.Tool, chatMessage.Role);
        Assert.Equal("msg1", chatMessage.MessageId);
    }

    // https://github.com/microsoft/agent-framework/issues/4342
    [Fact]
    public void AsChatMessages_ToolMessageWithPlainTextContent_PreservesMessageId()
    {
        AGUIMessage[] aguiMessages =
        [
            new AGUIToolMessage
            {
                Id = "tool-msg-1",
                Content = "72°F, sunny",
                ToolCallId = "tc_1"
            }
        ];

        var chatMessage = Assert.Single(aguiMessages.AsChatMessages().ToList());

        Assert.Equal(ChatRole.Tool, chatMessage.Role);
        Assert.Equal("tool-msg-1", chatMessage.MessageId);
    }

    // https://github.com/microsoft/agent-framework/issues/3729
    [Fact]
    public void RunAgentInput_MultimodalUserMessageContentArray_DeserializesAndMapsToChatContents()
    {
        var json = """
            {
              "threadId": "thread-1",
              "runId": "run-1",
              "messages": [
                {
                  "id": "m1",
                  "role": "user",
                  "content": [
                    { "type": "text", "text": "What is in this image?" },
                    {
                      "type": "binary",
                      "mimeType": "image/png",
                      "filename": "pixel.png",
                      "data": "AQIDBA=="
                    }
                  ]
                }
              ],
              "context": []
            }
            """;

        var input = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.RunAgentInput);

        Assert.NotNull(input);
        var userMessage = Assert.IsType<AGUIUserMessage>(Assert.Single(input.Messages));
        Assert.Equal(2, userMessage.Content.Count);
        Assert.IsType<AGUITextInputContent>(userMessage.Content[0]);
        var binaryContent = Assert.IsType<AGUIBinaryInputContent>(userMessage.Content[1]);
        Assert.Equal("image/png", binaryContent.MimeType);

        var chatMessage = Assert.Single(input.Messages.AsChatMessages().ToList());
        Assert.Equal(ChatRole.User, chatMessage.Role);
        Assert.IsType<TextContent>(chatMessage.Contents[0]);
        var dataContent = Assert.IsType<DataContent>(chatMessage.Contents[1]);
        Assert.Equal("image/png", dataContent.MediaType);
        Assert.Equal("pixel.png", dataContent.AdditionalProperties?["filename"]);
        Assert.Equal(System.Convert.FromBase64String("AQIDBA=="), dataContent.Data.ToArray());
    }

    // https://github.com/microsoft/agent-framework/issues/2699
    // When a client (e.g. @ag-ui/client) splits parallel tool calls into separate assistant
    // messages, AsChatMessages coalesces them into a single assistant message so the
    // reconstructed OpenAI tool_call history is valid.
    [Fact]
    public void AsChatMessages_ParallelToolCalls_CoalescedIntoSingleAssistantMessage()
    {
        var aguiMessages = new AGUIMessage[]
        {
            new AGUIAssistantMessage
            {
                Id = "asst-1",
                Content = string.Empty,
                ToolCalls = new List<AGUIToolCall>
                {
                    new AGUIToolCall { Id = "tc_1", Type = "function", Function = new AGUIToolCallFunction { Name = "get_weather", Arguments = "{}" } },
                },
            },
            new AGUIAssistantMessage
            {
                Id = "asst-2",
                Content = string.Empty,
                ToolCalls = new List<AGUIToolCall>
                {
                    new AGUIToolCall { Id = "tc_2", Type = "function", Function = new AGUIToolCallFunction { Name = "get_user_location", Arguments = "{}" } },
                },
            },
        };

        var chatMessages = aguiMessages.AsChatMessages().ToList();

        var assistantMessages = chatMessages.Where(m => m.Role == ChatRole.Assistant).ToList();
        Assert.Single(assistantMessages);
        Assert.Equal(2, assistantMessages[0].Contents.OfType<FunctionCallContent>().Count());
    }

    [Fact]
    public void DeveloperMessage_RoundTripsThroughChatMessageAndBack()
    {
        var developerRole = new ChatRole("developer");
        var chatMessage = new ChatMessage(developerRole, "follow the rules") { MessageId = "dev-1" };

        var aguiMessage = Assert.Single(new[] { chatMessage }.AsAGUIMessages());
        var developer = Assert.IsType<AGUIDeveloperMessage>(aguiMessage);
        Assert.Equal("dev-1", developer.Id);
        Assert.Equal("follow the rules", developer.Content);

        var roundTripped = Assert.Single(new[] { developer }.AsChatMessages());
        Assert.Equal(developerRole, roundTripped.Role);
        Assert.Equal("follow the rules", roundTripped.Text);
    }

    // https://github.com/microsoft/agent-framework/issues/2699
    // The coalesced assistant message must be followed by the tool results, so a full split
    // parallel turn reconstructs as a valid provider history:
    //   assistant(tc_1, tc_2), tool(tc_1), tool(tc_2).
    [Fact]
    public void AsChatMessages_ParallelToolCalls_FollowedByResults_ProducesValidOrder()
    {
        var aguiMessages = new AGUIMessage[]
        {
            new AGUIAssistantMessage { Id = "asst-1", Content = string.Empty, ToolCalls = new List<AGUIToolCall> { new AGUIToolCall { Id = "tc_1", Type = "function", Function = new AGUIToolCallFunction { Name = "get_weather", Arguments = "{}" } } } },
            new AGUIAssistantMessage { Id = "asst-2", Content = string.Empty, ToolCalls = new List<AGUIToolCall> { new AGUIToolCall { Id = "tc_2", Type = "function", Function = new AGUIToolCallFunction { Name = "get_user_location", Arguments = "{}" } } } },
            new AGUIToolMessage { Id = "tool-1", ToolCallId = "tc_1", Content = "sunny" },
            new AGUIToolMessage { Id = "tool-2", ToolCallId = "tc_2", Content = "Paris" },
        };

        var chatMessages = aguiMessages.AsChatMessages().ToList();

        Assert.Equal(3, chatMessages.Count);
        Assert.Equal(ChatRole.Assistant, chatMessages[0].Role);
        var calls = chatMessages[0].Contents.OfType<FunctionCallContent>().Select(c => c.CallId).ToList();
        Assert.Equal(new[] { "tc_1", "tc_2" }, calls);
        Assert.Equal(ChatRole.Tool, chatMessages[1].Role);
        Assert.Equal("tc_1", chatMessages[1].Contents.OfType<FunctionResultContent>().Single().CallId);
        Assert.Equal(ChatRole.Tool, chatMessages[2].Role);
        Assert.Equal("tc_2", chatMessages[2].Contents.OfType<FunctionResultContent>().Single().CallId);
    }

    // https://github.com/microsoft/agent-framework/issues/2699
    // Legitimate sequential tool calls (each assistant call already followed by its result) must
    // NOT be merged; they are already valid.
    [Fact]
    public void AsChatMessages_SequentialToolCalls_NotMerged()
    {
        var aguiMessages = new AGUIMessage[]
        {
            new AGUIAssistantMessage { Id = "asst-1", Content = string.Empty, ToolCalls = new List<AGUIToolCall> { new AGUIToolCall { Id = "tc_1", Type = "function", Function = new AGUIToolCallFunction { Name = "step_a", Arguments = "{}" } } } },
            new AGUIToolMessage { Id = "tool-1", ToolCallId = "tc_1", Content = "a" },
            new AGUIAssistantMessage { Id = "asst-2", Content = string.Empty, ToolCalls = new List<AGUIToolCall> { new AGUIToolCall { Id = "tc_2", Type = "function", Function = new AGUIToolCallFunction { Name = "step_b", Arguments = "{}" } } } },
            new AGUIToolMessage { Id = "tool-2", ToolCallId = "tc_2", Content = "b" },
        };

        var chatMessages = aguiMessages.AsChatMessages().ToList();

        var assistantMessages = chatMessages.Where(m => m.Role == ChatRole.Assistant).ToList();
        Assert.Equal(2, assistantMessages.Count);
        Assert.All(assistantMessages, m => Assert.Single(m.Contents.OfType<FunctionCallContent>()));
    }

    // https://github.com/ag-ui-protocol/ag-ui/issues/2290
    // Reasoning messages are "meant to be sent back to the agent for further processing on
    // subsequent turns", so a conforming client re-sends them and every turn after the first
    // must keep working.
    [Fact]
    public void AsChatMessages_ReasoningMessage_MapsToAssistantReasoningContent()
    {
        var aguiMessages = new AGUIMessage[]
        {
            new AGUIReasoningMessage { Id = "reason-1", Content = "Counting the objectives." }
        };

        var chatMessage = Assert.Single(aguiMessages.AsChatMessages());

        Assert.Equal(ChatRole.Assistant, chatMessage.Role);
        Assert.Equal("reason-1", chatMessage.MessageId);
        var reasoning = Assert.IsType<TextReasoningContent>(Assert.Single(chatMessage.Contents));
        Assert.Equal("Counting the objectives.", reasoning.Text);
        Assert.Null(reasoning.ProtectedData);
    }

    // encryptedValue is the whole point of round-tripping reasoning (store:false / ZDR), so it
    // must survive as ProtectedData -- MEAI's home for opaque provider blobs.
    [Fact]
    public void AsChatMessages_ReasoningMessageWithEncryptedValue_PreservesProtectedData()
    {
        var aguiMessages = new AGUIMessage[]
        {
            new AGUIReasoningMessage
            {
                Id = "reason-1",
                Content = "Redacted summary.",
                EncryptedValue = "gAAAAABn-opaque-blob"
            }
        };

        var chatMessage = Assert.Single(aguiMessages.AsChatMessages());

        var reasoning = Assert.IsType<TextReasoningContent>(Assert.Single(chatMessage.Contents));
        Assert.Equal("Redacted summary.", reasoning.Text);
        Assert.Equal("gAAAAABn-opaque-blob", reasoning.ProtectedData);
    }

    // Activity is frontend-only ("never forwarded to the agent"), so a client that sends one
    // anyway should be ignored rather than 500.
    [Fact]
    public void AsChatMessages_ActivityMessage_IsSkipped()
    {
        var aguiMessages = new AGUIMessage[]
        {
            new AGUIUserMessage { Id = "m1", Content = "Hello" },
            new AGUIActivityMessage
            {
                Id = "act-1",
                ActivityType = "search",
                Content = JsonDocument.Parse("""{"query":"objectives"}""").RootElement
            },
            new AGUIUserMessage { Id = "m2", Content = "Still there?" }
        };

        var chatMessages = aguiMessages.AsChatMessages().ToList();

        Assert.Equal(2, chatMessages.Count);
        Assert.Equal(new[] { "m1", "m2" }, chatMessages.Select(m => m.MessageId));
    }

    // A skipped activity message must be fully transparent: it cannot split a run of parallel
    // tool calls that AsChatMessages is coalescing, or the reconstructed history goes invalid.
    [Fact]
    public void AsChatMessages_ActivityBetweenParallelToolCalls_DoesNotSplitRun()
    {
        var aguiMessages = new AGUIMessage[]
        {
            new AGUIAssistantMessage { Id = "asst-1", Content = string.Empty, ToolCalls = new List<AGUIToolCall> { new AGUIToolCall { Id = "tc_1", Type = "function", Function = new AGUIToolCallFunction { Name = "get_weather", Arguments = "{}" } } } },
            new AGUIActivityMessage { Id = "act-1", ActivityType = "thinking", Content = JsonDocument.Parse("{}").RootElement },
            new AGUIAssistantMessage { Id = "asst-2", Content = string.Empty, ToolCalls = new List<AGUIToolCall> { new AGUIToolCall { Id = "tc_2", Type = "function", Function = new AGUIToolCallFunction { Name = "get_user_location", Arguments = "{}" } } } },
        };

        var chatMessage = Assert.Single(aguiMessages.AsChatMessages());

        Assert.Equal(ChatRole.Assistant, chatMessage.Role);
        Assert.Equal(new[] { "tc_1", "tc_2" }, chatMessage.Contents.OfType<FunctionCallContent>().Select(c => c.CallId));
    }

    [Fact]
    public void MapChatRole_Reasoning_MapsToAssistant()
    {
        Assert.Equal(ChatRole.Assistant, AGUIChatMessageExtensions.MapChatRole(AGUIRoles.Reasoning));
    }

    // The exact turn-2 payload from #2290: a conforming client echoes the reasoning message it
    // was streamed, which used to fail the whole run with "Unknown chat role: reasoning".
    [Fact]
    public void RunAgentInput_WithReasoningMessage_DeserializesAndConverts()
    {
        var json = """
            {
              "threadId": "t-1",
              "runId": "r-2",
              "messages": [
                { "id": "1", "role": "user",      "content": "How many objectives are listed?" },
                { "id": "2", "role": "reasoning", "content": "**Counting objectives** ... 4 items." },
                { "id": "3", "role": "assistant", "content": "There are 4 objectives listed." },
                { "id": "4", "role": "user",      "content": "How many agreed actions are listed?" }
              ],
              "context": []
            }
            """;

        var input = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.RunAgentInput);

        Assert.NotNull(input);
        Assert.IsType<AGUIReasoningMessage>(input.Messages[1]);

        var chatMessages = input.Messages.AsChatMessages().ToList();

        Assert.Equal(4, chatMessages.Count);
        var reasoning = Assert.IsType<TextReasoningContent>(Assert.Single(chatMessages[1].Contents));
        Assert.Equal("**Counting objectives** ... 4 items.", reasoning.Text);
    }

    // Drift guard: AGUIRoles, AGUIMessageJsonConverter and AsChatMessages are three separate
    // lists that must agree. Anything the converter can deserialize, AsChatMessages must
    // consume without throwing -- that gap is what #2290 was.
    [Theory]
    [InlineData(AGUIRoles.System, """{ "id": "m", "role": "system", "content": "be brief" }""")]
    [InlineData(AGUIRoles.User, """{ "id": "m", "role": "user", "content": "hi" }""")]
    [InlineData(AGUIRoles.Assistant, """{ "id": "m", "role": "assistant", "content": "hello" }""")]
    [InlineData(AGUIRoles.Developer, """{ "id": "m", "role": "developer", "content": "note" }""")]
    [InlineData(AGUIRoles.Tool, """{ "id": "m", "role": "tool", "toolCallId": "tc_1", "content": "done" }""")]
    [InlineData(AGUIRoles.Activity, """{ "id": "m", "role": "activity", "activityType": "search", "content": {} }""")]
    [InlineData(AGUIRoles.Reasoning, """{ "id": "m", "role": "reasoning", "content": "thinking" }""")]
    public void AsChatMessages_EveryDeserializableRole_DoesNotThrow(string role, string messageJson)
    {
        var json = $$"""
            { "threadId": "t", "runId": "r", "messages": [ {{messageJson}} ], "context": [] }
            """;

        var input = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.RunAgentInput);

        Assert.NotNull(input);
        Assert.Equal(role, Assert.Single(input.Messages).Role);

        // Must not throw. Activity is intentionally dropped; every other role yields a message.
        var chatMessages = input.Messages.AsChatMessages().ToList();

        Assert.Equal(role == AGUIRoles.Activity ? 0 : 1, chatMessages.Count);
    }
}
