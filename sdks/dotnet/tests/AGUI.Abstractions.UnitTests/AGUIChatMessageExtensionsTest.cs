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

        var aguiMessages = chatMessages.AsAGUIMessages(AGUIJsonSerializerContext.Default.Options).ToList();

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

        var aguiMessages = chatMessages.AsAGUIMessages(AGUIJsonSerializerContext.Default.Options).ToList();

        Assert.Single(aguiMessages);
        var userMsg = Assert.IsType<AGUIUserMessage>(aguiMessages[0]);
        Assert.Null(userMsg.Name);
    }

    [Fact]
    public void RoundTrip_UserMessageWithName_PreservesName()
    {
        var original = new ChatMessage(ChatRole.User, "Hello") { AuthorName = "Charlie", MessageId = "msg-1" };

        var aguiMessages = new[] { original }.AsAGUIMessages(AGUIJsonSerializerContext.Default.Options).ToList();
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

        var aguiMessages = chatMessages.AsAGUIMessages(AGUIJsonSerializerContext.Default.Options).ToList();

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

        var aguiMessages = chatMessages
            .AsAGUIMessages(AGUIJsonSerializerContext.Default.Options)
            .OfType<AGUIToolMessage>()
            .ToList();

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

        var roundTripped = chatMessages
            .AsAGUIMessages(AGUIJsonSerializerContext.Default.Options)
            .AsChatMessages()
            .ToList();

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

        var aguiMessages = chatMessages.AsAGUIMessages(AGUIJsonSerializerContext.Default.Options).ToList();

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

        var aguiMessages = chatMessages.AsAGUIMessages(AGUIJsonSerializerContext.Default.Options).ToList();

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

        var aguiMessages = original.AsAGUIMessages(AGUIJsonSerializerContext.Default.Options).ToList();
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

    // https://github.com/ag-ui-protocol/ag-ui/issues/2447
    [Fact]
    public void RunAgentInput_CanonicalMultimodalContent_DeserializesAndMapsInOrder()
    {
        var json = """
            {
              "threadId": "thread-1",
              "runId": "run-1",
              "messages": [
                {
                  "id": "m1",
                  "role": "user",
                  "name": "Alice",
                  "content": [
                    { "type": "text", "text": "Compare these files." },
                    {
                      "type": "image",
                      "source": {
                        "type": "url",
                        "value": "https://example.com/image.png",
                        "mimeType": "image/png"
                      },
                      "metadata": { "detail": "high" }
                    },
                    {
                      "type": "audio",
                      "source": {
                        "type": "data",
                        "value": "AQIDBA==",
                        "mimeType": "audio/wav"
                      }
                    },
                    {
                      "type": "video",
                      "source": {
                        "type": "url",
                        "value": "https://example.com/video.mp4"
                      }
                    },
                    {
                      "type": "document",
                      "source": {
                        "type": "data",
                        "value": "JVBERg==",
                        "mimeType": "application/pdf"
                      },
                      "metadata": {
                        "filename": "report.pdf",
                        "providerHint": { "quality": "high" }
                      }
                    }
                  ]
                }
              ],
              "context": []
            }
            """;

        var input = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.RunAgentInput);

        Assert.NotNull(input);
        var chatMessage = Assert.Single(input.Messages.AsChatMessages());
        Assert.Equal(ChatRole.User, chatMessage.Role);
        Assert.Equal("m1", chatMessage.MessageId);
        Assert.Equal("Alice", chatMessage.AuthorName);
        Assert.Collection(
            chatMessage.Contents,
            content => Assert.Equal("Compare these files.", Assert.IsType<TextContent>(content).Text),
            content =>
            {
                var uri = Assert.IsType<UriContent>(content);
                Assert.Equal("https://example.com/image.png", uri.Uri.ToString());
                Assert.Equal("image/png", uri.MediaType);
                var metadata = Assert.IsType<JsonElement>(uri.AdditionalProperties?["metadata"]);
                Assert.Equal("high", metadata.GetProperty("detail").GetString());
            },
            content =>
            {
                var data = Assert.IsType<DataContent>(content);
                Assert.Equal("audio/wav", data.MediaType);
                Assert.Equal(System.Convert.FromBase64String("AQIDBA=="), data.Data.ToArray());
            },
            content =>
            {
                var uri = Assert.IsType<UriContent>(content);
                Assert.Equal("https://example.com/video.mp4", uri.Uri.ToString());
                Assert.Equal("video/mp4", uri.MediaType);
            },
            content =>
            {
                var data = Assert.IsType<DataContent>(content);
                Assert.Equal("application/pdf", data.MediaType);
                Assert.Equal(System.Convert.FromBase64String("JVBERg=="), data.Data.ToArray());
                Assert.Equal("report.pdf", data.Name);
                var metadata = Assert.IsType<JsonElement>(data.AdditionalProperties?["metadata"]);
                Assert.Equal("report.pdf", metadata.GetProperty("filename").GetString());
                var providerHint = metadata.GetProperty("providerHint");
                Assert.Equal("high", providerHint.GetProperty("quality").GetString());
            });

        var roundTripped = Assert.IsType<AGUIUserMessage>(
            Assert.Single(new[] { chatMessage }.AsAGUIMessages(AGUIJsonSerializerContext.Default.Options)));
        var roundTrippedImage = Assert.IsType<AGUIImageInputContent>(roundTripped.Content[1]);
        Assert.Equal("high", roundTrippedImage.Metadata?.GetProperty("detail").GetString());
        var roundTrippedDocument = Assert.IsType<AGUIDocumentInputContent>(roundTripped.Content[4]);
        Assert.Equal("report.pdf", roundTrippedDocument.Metadata?.GetProperty("filename").GetString());
        Assert.Equal(
            "high",
            roundTrippedDocument.Metadata?.GetProperty("providerHint").GetProperty("quality").GetString());
    }

    [Theory]
    [InlineData("image", "url", "image/png")]
    [InlineData("image", "data", "image/png")]
    [InlineData("audio", "url", "audio/wav")]
    [InlineData("audio", "data", "audio/wav")]
    [InlineData("video", "url", "video/mp4")]
    [InlineData("video", "data", "video/mp4")]
    [InlineData("document", "url", "application/pdf")]
    [InlineData("document", "data", "application/pdf")]
    public void AsChatMessages_CanonicalMediaTypes_MapBothSourceTypes(
        string mediaType,
        string sourceType,
        string mimeType)
    {
        var url = $"https://example.com/content.{GetExtension(mediaType)}";
        AGUIInputContentSource source = sourceType == "data"
            ? new AGUIInputContentDataSource { Value = "AQIDBA==", MimeType = mimeType }
            : new AGUIInputContentUrlSource
            {
                Value = url,
                MimeType = mimeType
            };
        var message = new AGUIUserMessage
        {
            Id = "message-1",
            Content = [CreateMediaInputContent(mediaType, source)]
        };

        var chatMessage = Assert.Single(new[] { message }.AsChatMessages());
        var content = Assert.Single(chatMessage.Contents);

        if (sourceType == "data")
        {
            var data = Assert.IsType<DataContent>(content);
            Assert.Equal(mimeType, data.MediaType);
            Assert.Equal(System.Convert.FromBase64String("AQIDBA=="), data.Data.ToArray());
        }
        else
        {
            var uri = Assert.IsType<UriContent>(content);
            Assert.Equal(mimeType, uri.MediaType);
            Assert.Equal(url, uri.Uri.ToString());
        }
    }

    [Theory]
    [InlineData("image", "image/*")]
    [InlineData("audio", "audio/*")]
    [InlineData("video", "video/*")]
    [InlineData("document", "application/octet-stream")]
    public void AsChatMessages_CanonicalUrlWithoutMimeTypeOrExtension_PreservesModality(
        string mediaType,
        string expectedMimeType)
    {
        var message = new AGUIUserMessage
        {
            Content =
            [
                CreateMediaInputContent(
                    mediaType,
                    new AGUIInputContentUrlSource { Value = "https://example.com/content" })
            ]
        };

        var chatMessage = Assert.Single(new[] { message }.AsChatMessages());
        var content = Assert.IsType<UriContent>(Assert.Single(chatMessage.Contents));

        Assert.Equal(expectedMimeType, content.MediaType);
    }

    [Fact]
    public void AsChatMessages_CanonicalMediaWithNonObjectMetadata_PreservesMetadataValue()
    {
        var message = new AGUIUserMessage
        {
            Content =
            [
                new AGUIImageInputContent
                {
                    Source = new AGUIInputContentDataSource
                    {
                        Value = "AQIDBA==",
                        MimeType = "image/png"
                    },
                    Metadata = JsonSerializer.SerializeToElement("provider-specific")
                }
            ]
        };

        var chatMessage = Assert.Single(new[] { message }.AsChatMessages());
        var data = Assert.IsType<DataContent>(Assert.Single(chatMessage.Contents));
        var metadata = Assert.IsType<JsonElement>(data.AdditionalProperties?["metadata"]);
        Assert.Equal("provider-specific", metadata.GetString());
    }

    [Theory]
    [InlineData("image/png", typeof(AGUIImageInputContent))]
    [InlineData("IMAGE/PNG", typeof(AGUIImageInputContent))]
    [InlineData("audio/wav", typeof(AGUIAudioInputContent))]
    [InlineData("video/mp4", typeof(AGUIVideoInputContent))]
    [InlineData("video/mp4; codecs=avc1", typeof(AGUIVideoInputContent))]
    [InlineData("application/pdf", typeof(AGUIDocumentInputContent))]
    public void AsAGUIMessages_DataContent_MapsAdditionalPropertiesToCanonicalMetadata(
        string mimeType,
        Type expectedContentType)
    {
        var content = new DataContent(System.Convert.FromBase64String("AQIDBA=="), mimeType)
        {
            Name = "content.bin",
            AdditionalProperties = new AdditionalPropertiesDictionary
            {
                ["providerHint"] = "high",
                ["nested"] = JsonSerializer.SerializeToElement(new { quality = "original" })
            }
        };
        var message = new ChatMessage(ChatRole.User, [content]);

        var aguiMessage = Assert.IsType<AGUIUserMessage>(
            Assert.Single(new[] { message }.AsAGUIMessages(AGUIJsonSerializerContext.Default.Options)));
        var media = Assert.IsAssignableFrom<AGUIMediaInputContent>(Assert.Single(aguiMessage.Content));

        Assert.IsType(expectedContentType, media);
        var source = Assert.IsType<AGUIInputContentDataSource>(media.Source);
        Assert.Equal(mimeType, source.MimeType);
        Assert.Equal("AQIDBA==", source.Value);
        Assert.Equal("high", media.Metadata?.GetProperty("providerHint").GetString());
        Assert.Equal("original", media.Metadata?.GetProperty("nested").GetProperty("quality").GetString());
        Assert.Equal("content.bin", media.Metadata?.GetProperty("filename").GetString());
    }

    [Fact]
    public void AsAGUIMessages_DataContentWithPreservedMetadata_MergesNameAsFilename()
    {
        var content = new DataContent(System.Convert.FromBase64String("AQIDBA=="), "image/png")
        {
            Name = "content.png",
            AdditionalProperties = new AdditionalPropertiesDictionary
            {
                ["metadata"] = JsonSerializer.SerializeToElement(new { detail = "high" })
            }
        };
        var message = new ChatMessage(ChatRole.User, [content]);

        var aguiMessage = Assert.IsType<AGUIUserMessage>(
            Assert.Single(new[] { message }.AsAGUIMessages(AGUIJsonSerializerContext.Default.Options)));
        var image = Assert.IsType<AGUIImageInputContent>(Assert.Single(aguiMessage.Content));

        Assert.Equal("high", image.Metadata?.GetProperty("detail").GetString());
        Assert.Equal("content.png", image.Metadata?.GetProperty("filename").GetString());
        Assert.False(image.Metadata?.TryGetProperty("metadata", out _) ?? true);
    }

    [Fact]
    public void AsAGUIMessages_DataContentWithPreservedFilename_DoesNotOverwriteFilename()
    {
        var content = new DataContent(System.Convert.FromBase64String("AQIDBA=="), "image/png")
        {
            Name = "content.png",
            AdditionalProperties = new AdditionalPropertiesDictionary
            {
                ["metadata"] = JsonSerializer.SerializeToElement(new { filename = "original.png" })
            }
        };
        var message = new ChatMessage(ChatRole.User, [content]);

        var aguiMessage = Assert.IsType<AGUIUserMessage>(
            Assert.Single(new[] { message }.AsAGUIMessages(AGUIJsonSerializerContext.Default.Options)));
        var image = Assert.IsType<AGUIImageInputContent>(Assert.Single(aguiMessage.Content));

        Assert.Equal("original.png", image.Metadata?.GetProperty("filename").GetString());
    }

    [Fact]
    public void AsAGUIMessages_UriContent_MapsAdditionalPropertiesToCanonicalMetadata()
    {
        var content = new UriContent(new Uri("https://example.com/image.png"), "image/png")
        {
            AdditionalProperties = new AdditionalPropertiesDictionary
            {
                ["detail"] = "high"
            }
        };
        var message = new ChatMessage(ChatRole.User, [content]);

        var aguiMessage = Assert.IsType<AGUIUserMessage>(
            Assert.Single(new[] { message }.AsAGUIMessages(AGUIJsonSerializerContext.Default.Options)));
        var image = Assert.IsType<AGUIImageInputContent>(Assert.Single(aguiMessage.Content));
        var source = Assert.IsType<AGUIInputContentUrlSource>(image.Source);

        Assert.Equal("https://example.com/image.png", source.Value);
        Assert.Equal("image/png", source.MimeType);
        Assert.Equal("high", image.Metadata?.GetProperty("detail").GetString());
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

        var aguiMessage = Assert.Single(
            new[] { chatMessage }.AsAGUIMessages(AGUIJsonSerializerContext.Default.Options));
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

    private static AGUIMediaInputContent CreateMediaInputContent(
        string mediaType,
        AGUIInputContentSource source)
    {
        return mediaType switch
        {
            "image" => new AGUIImageInputContent { Source = source },
            "audio" => new AGUIAudioInputContent { Source = source },
            "video" => new AGUIVideoInputContent { Source = source },
            "document" => new AGUIDocumentInputContent { Source = source },
            _ => throw new InvalidOperationException($"Unexpected media type '{mediaType}'.")
        };
    }

    private static string GetExtension(string mediaType)
    {
        return mediaType switch
        {
            "image" => "png",
            "audio" => "wav",
            "video" => "mp4",
            "document" => "pdf",
            _ => throw new InvalidOperationException($"Unexpected media type '{mediaType}'.")
        };
    }
}
