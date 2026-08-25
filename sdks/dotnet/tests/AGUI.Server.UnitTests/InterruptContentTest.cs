using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace AGUI.Server.UnitTests;

public sealed class InterruptContentTest
{
    #region InterruptRequestContent

    [Fact]
    public void InterruptRequestContent_Constructor_SetsRequestId()
    {
        var content = new InterruptRequestContent("req-123");

        Assert.Equal("req-123", content.RequestId);
        Assert.Null(content.Reason);
        Assert.Null(content.Message);
        Assert.Null(content.ToolCallId);
        Assert.Null(content.ResponseSchema);
        Assert.Null(content.ExpiresAt);
        Assert.Null(content.Metadata);
    }

    [Fact]
    public void InterruptRequestContent_Properties_Roundtrip()
    {
        var metadata = JsonDocument.Parse("""{"key":"value"}""").RootElement;
        var schema = JsonDocument.Parse("""{"type":"string"}""").RootElement;
        var content = new InterruptRequestContent("req-456")
        {
            Reason = "input_required",
            Message = "Please provide input",
            ToolCallId = "call-1",
            ResponseSchema = schema,
            ExpiresAt = "2026-12-31T23:59:59Z",
            Metadata = metadata
        };

        Assert.Equal("req-456", content.RequestId);
        Assert.Equal("input_required", content.Reason);
        Assert.Equal("Please provide input", content.Message);
        Assert.Equal("call-1", content.ToolCallId);
        Assert.NotNull(content.ResponseSchema);
        Assert.Equal("string", content.ResponseSchema!.Value.GetProperty("type").GetString());
        Assert.Equal("2026-12-31T23:59:59Z", content.ExpiresAt);
        Assert.NotNull(content.Metadata);
        Assert.Equal("value", content.Metadata!.Value.GetProperty("key").GetString());
    }

    [Fact]
    public void InterruptRequestContent_IsInputRequestContent()
    {
        var content = new InterruptRequestContent("req-789");

        Assert.IsAssignableFrom<InputRequestContent>(content);
        Assert.IsAssignableFrom<AIContent>(content);
    }

    [Fact]
    public void InterruptRequestContent_NullRequestId_Throws()
    {
        Assert.Throws<ArgumentNullException>("requestId", () => new InterruptRequestContent(null!));
    }

    [Fact]
    public void InterruptRequestContent_EmptyRequestId_Throws()
    {
        Assert.Throws<ArgumentException>("requestId", () => new InterruptRequestContent(""));
        Assert.Throws<ArgumentException>("requestId", () => new InterruptRequestContent("   "));
    }

    #endregion

    #region InterruptResponseContent

    [Fact]
    public void InterruptResponseContent_Constructor_SetsRequestId()
    {
        var content = new InterruptResponseContent("req-123");

        Assert.Equal("req-123", content.RequestId);
        Assert.Null(content.Payload);
    }

    [Fact]
    public void InterruptResponseContent_Properties_Roundtrip()
    {
        var payload = JsonDocument.Parse("""{"approved":true}""").RootElement;
        var content = new InterruptResponseContent("req-456")
        {
            Payload = payload
        };

        Assert.Equal("req-456", content.RequestId);
        Assert.NotNull(content.Payload);
        Assert.True(content.Payload.Value.GetProperty("approved").GetBoolean());
    }

    [Fact]
    public void InterruptResponseContent_IsInputResponseContent()
    {
        var content = new InterruptResponseContent("req-789");

        Assert.IsAssignableFrom<InputResponseContent>(content);
        Assert.IsAssignableFrom<AIContent>(content);
    }

    [Fact]
    public void InterruptResponseContent_NullRequestId_Throws()
    {
        Assert.Throws<ArgumentNullException>("requestId", () => new InterruptResponseContent(null!));
    }

    [Fact]
    public void InterruptResponseContent_EmptyRequestId_Throws()
    {
        Assert.Throws<ArgumentException>("requestId", () => new InterruptResponseContent(""));
        Assert.Throws<ArgumentException>("requestId", () => new InterruptResponseContent("   "));
    }

    // Metadata on an incoming resume entry survives the hosting layer's translation to
    // MEAI content, so an inner pipeline reading InterruptResponseContent sees the
    // envelope data (signatures, routing keys) the client attached.
    [Fact]
    public void ResumeMetadata_SurvivesTranslationToInterruptResponseContent()
    {
        var input = new RunAgentInput
        {
            ThreadId = "t1",
            RunId = "r1",
            Resume =
            [
                new AGUIResume
                {
                    InterruptId = "generic-1",
                    Status = ResumeStatus.Resolved,
                    Payload = JsonDocument.Parse("""{"approved":true}""").RootElement,
                    Metadata = JsonDocument.Parse(
                        """{"definitionId":"review-plan","key":"afterModel-review"}""").RootElement,
                },
            ],
        };

        var context = input.ToChatRequestContext(AIJsonUtilities.DefaultOptions);

        var response = Assert.Single(context.Messages
            .SelectMany(m => m.Contents)
            .OfType<InterruptResponseContent>());
        Assert.Equal("generic-1", response.RequestId);
        Assert.NotNull(response.Metadata);
        Assert.Equal("review-plan", response.Metadata!.Value.GetProperty("definitionId").GetString());
        Assert.Equal("afterModel-review", response.Metadata!.Value.GetProperty("key").GetString());
    }

    // A resume entry without metadata translates to content without it.
    [Fact]
    public void ResumeWithoutMetadata_TranslatesWithoutIt()
    {
        var input = new RunAgentInput
        {
            ThreadId = "t1",
            RunId = "r1",
            Resume =
            [
                new AGUIResume { InterruptId = "generic-1", Status = ResumeStatus.Resolved },
            ],
        };

        var context = input.ToChatRequestContext(AIJsonUtilities.DefaultOptions);

        var response = Assert.Single(context.Messages
            .SelectMany(m => m.Contents)
            .OfType<InterruptResponseContent>());
        Assert.Null(response.Metadata);
    }

    #endregion

    #region JSON Serialization

    [Fact]
    public void InterruptRequestContent_SerializesAs_AIContent_WithDiscriminator()
    {
        var options = CreateOptionsWithInterruptTypes();

        var content = new InterruptRequestContent("req-1")
        {
            Reason = "tool_call",
            Message = "Approve tool call",
            Metadata = JsonDocument.Parse("""{"tool":"myTool"}""").RootElement
        };

        var json = SerializeJson<AIContent>(content, options);

        using var doc = JsonDocument.Parse(json);
        Assert.Equal("interruptRequest", doc.RootElement.GetProperty("$type").GetString());
        Assert.Equal("req-1", doc.RootElement.GetProperty("requestId").GetString());
        Assert.Equal("tool_call", doc.RootElement.GetProperty("reason").GetString());
    }

    [Fact]
    public void InterruptRequestContent_DeserializesFrom_AIContent()
    {
        var options = CreateOptionsWithInterruptTypes();

        var json = """
        {
            "$type": "interruptRequest",
            "requestId": "req-1",
            "reason": "input_required",
            "message": "Enter your name",
            "metadata": {"prompt": "Enter your name"}
        }
        """;

        var deserialized = DeserializeJson<AIContent>(json, options);

        Assert.NotNull(deserialized);
        var request = Assert.IsType<InterruptRequestContent>(deserialized);
        Assert.Equal("req-1", request.RequestId);
        Assert.Equal("input_required", request.Reason);
        Assert.Equal("Enter your name", request.Message);
        Assert.NotNull(request.Metadata);
        Assert.Equal("Enter your name", request.Metadata!.Value.GetProperty("prompt").GetString());
    }

    [Fact]
    public void InterruptRequestContent_DeserializesFrom_InputRequestContent()
    {
        var options = CreateOptionsWithInterruptTypes();

        var json = """
        {
            "$type": "interruptRequest",
            "requestId": "req-2",
            "reason": "custom_reason"
        }
        """;

        var deserialized = DeserializeJson<InputRequestContent>(json, options);

        Assert.NotNull(deserialized);
        var request = Assert.IsType<InterruptRequestContent>(deserialized);
        Assert.Equal("req-2", request.RequestId);
        Assert.Equal("custom_reason", request.Reason);
        Assert.Null(request.Metadata);
    }

    [Fact]
    public void InterruptResponseContent_SerializesAs_AIContent_WithDiscriminator()
    {
        var options = CreateOptionsWithInterruptTypes();

        var content = new InterruptResponseContent("req-1")
        {
            Payload = JsonDocument.Parse("""{"approved":true}""").RootElement
        };

        var json = SerializeJson<AIContent>(content, options);

        using var doc = JsonDocument.Parse(json);
        Assert.Equal("interruptResponse", doc.RootElement.GetProperty("$type").GetString());
        Assert.Equal("req-1", doc.RootElement.GetProperty("requestId").GetString());
    }

    [Fact]
    public void InterruptResponseContent_DeserializesFrom_AIContent()
    {
        var options = CreateOptionsWithInterruptTypes();

        var json = """
        {
            "$type": "interruptResponse",
            "requestId": "req-1",
            "payload": {"approved": false}
        }
        """;

        var deserialized = DeserializeJson<AIContent>(json, options);

        Assert.NotNull(deserialized);
        var response = Assert.IsType<InterruptResponseContent>(deserialized);
        Assert.Equal("req-1", response.RequestId);
        Assert.NotNull(response.Payload);
        Assert.False(response.Payload.Value.GetProperty("approved").GetBoolean());
    }

    [Fact]
    public void InterruptResponseContent_DeserializesFrom_InputResponseContent()
    {
        var options = CreateOptionsWithInterruptTypes();

        var json = """
        {
            "$type": "interruptResponse",
            "requestId": "req-2",
            "payload": {"data": 42}
        }
        """;

        var deserialized = DeserializeJson<InputResponseContent>(json, options);

        Assert.NotNull(deserialized);
        var response = Assert.IsType<InterruptResponseContent>(deserialized);
        Assert.Equal("req-2", response.RequestId);
        Assert.Equal(42, response.Payload!.Value.GetProperty("data").GetInt32());
    }

    [Fact]
    public void InterruptRequestContent_RoundTrips_ThroughAIContent()
    {
        var options = CreateOptionsWithInterruptTypes();

        var original = new InterruptRequestContent("req-rt")
        {
            Reason = "custom",
            Message = "Custom interrupt",
            Metadata = JsonDocument.Parse("""{"a":1,"b":"two"}""").RootElement
        };

        var json = SerializeJson<AIContent>(original, options);
        var deserialized = DeserializeJson<AIContent>(json, options);

        Assert.NotNull(deserialized);
        var roundtripped = Assert.IsType<InterruptRequestContent>(deserialized);
        Assert.Equal(original.RequestId, roundtripped.RequestId);
        Assert.Equal(original.Reason, roundtripped.Reason);
        Assert.Equal(original.Message, roundtripped.Message);
        Assert.Equal(1, roundtripped.Metadata!.Value.GetProperty("a").GetInt32());
        Assert.Equal("two", roundtripped.Metadata.Value.GetProperty("b").GetString());
    }

    [Fact]
    public void InterruptResponseContent_RoundTrips_ThroughAIContent()
    {
        var options = CreateOptionsWithInterruptTypes();

        var original = new InterruptResponseContent("req-rt")
        {
            Payload = JsonDocument.Parse("""{"status":"ok"}""").RootElement
        };

        var json = SerializeJson<AIContent>(original, options);
        var deserialized = DeserializeJson<AIContent>(json, options);

        Assert.NotNull(deserialized);
        var roundtripped = Assert.IsType<InterruptResponseContent>(deserialized);
        Assert.Equal(original.RequestId, roundtripped.RequestId);
        Assert.Equal("ok", roundtripped.Payload!.Value.GetProperty("status").GetString());
    }

    [Fact]
    public void InterruptRequestContent_NullFields_OmittedFromJson()
    {
        var options = CreateOptionsWithInterruptTypes();

        var content = new InterruptRequestContent("req-no-fields");

        var json = SerializeJson<AIContent>(content, options);

        Assert.DoesNotContain(""""metadata"""", json);
        Assert.DoesNotContain(""""reason"""", json);
        Assert.DoesNotContain(""""message"""", json);
        Assert.DoesNotContain(""""toolCallId"""", json);
    }

    [Fact]
    public void InterruptContent_InsideChatResponseUpdate_RoundTrips()
    {
        var options = CreateOptionsWithInterruptTypes();

        var update = new ChatResponseUpdate
        {
            Contents = [new InterruptRequestContent("req-in-update") { Reason = "pause" }]
        };

        var json = SerializeJson(update, options);
        var deserialized = DeserializeJson<ChatResponseUpdate>(json, options);

        Assert.NotNull(deserialized);
        Assert.Single(deserialized.Contents);
        var content = Assert.IsType<InterruptRequestContent>(deserialized.Contents[0]);
        Assert.Equal("req-in-update", content.RequestId);
        Assert.Equal("pause", content.Reason);
    }

    #endregion

    #region RegisterInterruptContentTypes

    [Fact]
    public void RegisterInterruptContentTypes_RegistersBothTypes()
    {
        var options = new JsonSerializerOptions
        {
            TypeInfoResolver = AIJsonUtilities.DefaultOptions.TypeInfoResolver
        };

        AGUIJsonUtilities.RegisterInterruptContentTypes(options);

        var aiContentInfo = options.GetTypeInfo(typeof(AIContent));
        Assert.NotNull(aiContentInfo.PolymorphismOptions);
        Assert.Contains(aiContentInfo.PolymorphismOptions.DerivedTypes,
            dt => dt.DerivedType == typeof(InterruptRequestContent));
        Assert.Contains(aiContentInfo.PolymorphismOptions.DerivedTypes,
            dt => dt.DerivedType == typeof(InterruptResponseContent));
    }

    [Fact]
    public void RegisterInterruptContentTypes_RegistersUnderInputRequestContent()
    {
        var options = new JsonSerializerOptions
        {
            TypeInfoResolver = AIJsonUtilities.DefaultOptions.TypeInfoResolver
        };

        AGUIJsonUtilities.RegisterInterruptContentTypes(options);

        var inputRequestInfo = options.GetTypeInfo(typeof(InputRequestContent));
        Assert.NotNull(inputRequestInfo.PolymorphismOptions);
        Assert.Contains(inputRequestInfo.PolymorphismOptions.DerivedTypes,
            dt => dt.DerivedType == typeof(InterruptRequestContent));
    }

    [Fact]
    public void RegisterInterruptContentTypes_RegistersUnderInputResponseContent()
    {
        var options = new JsonSerializerOptions
        {
            TypeInfoResolver = AIJsonUtilities.DefaultOptions.TypeInfoResolver
        };

        AGUIJsonUtilities.RegisterInterruptContentTypes(options);

        var inputResponseInfo = options.GetTypeInfo(typeof(InputResponseContent));
        Assert.NotNull(inputResponseInfo.PolymorphismOptions);
        Assert.Contains(inputResponseInfo.PolymorphismOptions.DerivedTypes,
            dt => dt.DerivedType == typeof(InterruptResponseContent));
    }

    #endregion

    #region Helpers

    private static JsonSerializerOptions CreateOptionsWithInterruptTypes()
    {
        var options = new JsonSerializerOptions(AIJsonUtilities.DefaultOptions);
        AGUIJsonUtilities.RegisterInterruptContentTypes(options);
        return options;
    }

    private static string SerializeJson<T>(T value, JsonSerializerOptions options) =>
        JsonSerializer.Serialize(value, (JsonTypeInfo<T>)options.GetTypeInfo(typeof(T)));

    private static T? DeserializeJson<T>(string json, JsonSerializerOptions options) =>
        JsonSerializer.Deserialize(json, (JsonTypeInfo<T>)options.GetTypeInfo(typeof(T)));

    #endregion
}
