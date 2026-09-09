using System.Text.Json;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class DefaultSerializationOmissionTest
{
    [Fact]
    public void RunAgentInput_UnsetOptionalPropertiesAreOmitted()
    {
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(new RunAgentInput
        {
            ThreadId = "thread_1",
            RunId = "run_1",
        }));

        Assert.Equal("thread_1", json.RootElement.GetProperty("threadId").GetString());
        Assert.Equal("run_1", json.RootElement.GetProperty("runId").GetString());
        Assert.Equal(JsonValueKind.Array, json.RootElement.GetProperty("messages").ValueKind);
        AssertOmitted(json.RootElement, "protocolVersion", "parentRunId", "state", "tools", "context", "forwardedProps", "resume");
    }

    [Fact]
    public void Tool_UnsetParametersAreOmittedWhenNestedInARun()
    {
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(new RunAgentInput
        {
            Tools = [new AGUITool { Name = "search", Description = "Search" }],
        }));

        var tool = json.RootElement.GetProperty("tools")[0];
        Assert.Equal("search", tool.GetProperty("name").GetString());
        AssertOmitted(tool, "parameters");
    }

    [Fact]
    public void TextMessageStart_UnsetRoleIsOmitted()
    {
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(new TextMessageStartEvent { MessageId = "message_1" }));

        Assert.Equal("TEXT_MESSAGE_START", json.RootElement.GetProperty("type").GetString());
        AssertOmitted(json.RootElement, "role");
    }

    [Fact]
    public void RunStarted_UnsetProtocolVersionIsOmitted()
    {
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(new RunStartedEvent { ThreadId = "thread_1", RunId = "run_1" }));

        Assert.Equal("RUN_STARTED", json.RootElement.GetProperty("type").GetString());
        AssertOmitted(json.RootElement, "protocolVersion");
    }

    [Fact]
    public void TextMessageChunk_UnsetPropertiesAreOmitted()
    {
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(new TextMessageChunkEvent()));

        Assert.Equal("TEXT_MESSAGE_CHUNK", json.RootElement.GetProperty("type").GetString());
        AssertOmitted(json.RootElement, "subagentRunId", "messageId", "role", "delta", "name", "timestamp", "rawEvent", "metadata");
    }

    [Fact]
    public void ToolCallChunk_UnsetPropertiesAreOmitted()
    {
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(new ToolCallChunkEvent()));

        Assert.Equal("TOOL_CALL_CHUNK", json.RootElement.GetProperty("type").GetString());
        AssertOmitted(json.RootElement, "subagentRunId", "toolCallId", "toolCallName", "parentMessageId", "delta", "timestamp", "rawEvent", "metadata");
    }

    [Theory]
    [InlineData("ordinary")]
    [InlineData("context")]
    [InlineData("resolver")]
    public void OptionalOpaqueJson_WholeNullAndUndefinedAreOmitted(string serializer)
    {
        var jsonNull = JsonSerializer.Deserialize<JsonElement>("null");
        foreach (var absent in new JsonElement?[] { null, jsonNull, default(JsonElement) })
        {
            using var input = Serialize(new RunAgentInput
            {
                State = absent,
                ForwardedProperties = absent,
                Tools = [new AGUITool { Name = "search", Parameters = absent }],
            }, serializer);
            using var chunk = Serialize(new TextMessageChunkEvent { RawEvent = absent, Metadata = absent }, serializer);

            AssertOmitted(input.RootElement, "state", "forwardedProps");
            AssertOmitted(input.RootElement.GetProperty("tools")[0], "parameters");
            AssertOmitted(chunk.RootElement, "rawEvent", "metadata");
        }
    }

    [Theory]
    [InlineData("context")]
    [InlineData("resolver")]
    public void OptionalOpaqueJson_AssignedNullIsAbsentAcrossModelFamilies(string serializer)
    {
        var jsonNull = JsonSerializer.Deserialize<JsonElement>("null");
        using var message = Serialize(new AGUIAssistantMessage { Metadata = jsonNull }, serializer);
        using var content = Serialize(new AGUIImageInputContent
        {
            Source = new AGUIInputContentUrlSource { Value = "https://example.com/image.png" },
            Metadata = jsonNull,
        }, serializer);
        using var interrupt = Serialize(new AGUIInterrupt { ResponseSchema = jsonNull }, serializer);

        AssertOmitted(message.RootElement, "metadata");
        AssertOmitted(content.RootElement, "metadata");
        AssertOmitted(interrupt.RootElement, "responseSchema");
    }

    [Theory]
    [InlineData("ordinary")]
    [InlineData("context")]
    [InlineData("resolver")]
    public void OptionalOpaqueJson_NestedNullAndNonNullValuesArePreserved(string serializer)
    {
        foreach (var payload in new[] { "{\"selectedId\":null,\"items\":[null,1]}", "[null,1]", "false", "0", "\"\"" })
        {
            var value = JsonSerializer.Deserialize<JsonElement>(payload);
            using var input = Serialize(new RunAgentInput
            {
                State = value,
                ForwardedProperties = value,
                Tools = [new AGUITool { Name = "search", Parameters = value }],
            }, serializer);

            Assert.True(JsonElement.DeepEquals(value, input.RootElement.GetProperty("state")));
            Assert.True(JsonElement.DeepEquals(value, input.RootElement.GetProperty("forwardedProps")));
            Assert.True(JsonElement.DeepEquals(value, input.RootElement.GetProperty("tools")[0].GetProperty("parameters")));
        }
    }

    [Theory]
    [InlineData("ordinary")]
    [InlineData("context")]
    [InlineData("resolver")]
    public void RequiredOpaqueJson_WholeNullIsPreserved(string serializer)
    {
        var jsonNull = JsonSerializer.Deserialize<JsonElement>("null");
        using var snapshot = Serialize(new StateSnapshotEvent { Snapshot = jsonNull }, serializer);
        using var custom = Serialize(new CustomEvent { Name = "empty", Value = null }, serializer);

        Assert.Equal(JsonValueKind.Null, snapshot.RootElement.GetProperty("snapshot").ValueKind);
        Assert.Equal(JsonValueKind.Null, custom.RootElement.GetProperty("value").ValueKind);
    }

    [Fact]
    public void Chunk_DefaultValuedDataIsPreserved()
    {
        using var text = JsonDocument.Parse(JsonSerializer.Serialize(new TextMessageChunkEvent { Delta = "", Timestamp = 0 }));
        using var tool = JsonDocument.Parse(JsonSerializer.Serialize(new ToolCallChunkEvent { Delta = "", Timestamp = 0 }));

        Assert.Equal("", text.RootElement.GetProperty("delta").GetString());
        Assert.Equal(0, text.RootElement.GetProperty("timestamp").GetInt64());
        Assert.Equal("", tool.RootElement.GetProperty("delta").GetString());
        Assert.Equal(0, tool.RootElement.GetProperty("timestamp").GetInt64());
    }

    private static JsonDocument Serialize<T>(T value, string serializer)
    {
        if (serializer == "ordinary")
        {
            return JsonDocument.Parse(JsonSerializer.Serialize(value));
        }

        var options = serializer == "context"
            ? AGUIJsonSerializerContext.Default.Options
            : new JsonSerializerOptions { TypeInfoResolver = AGUIJsonUtilities.DefaultTypeInfoResolver };
        return JsonDocument.Parse(JsonSerializer.Serialize(value, options));
    }

    private static void AssertOmitted(JsonElement value, params string[] names)
    {
        foreach (var name in names)
        {
            Assert.False(value.TryGetProperty(name, out _), $"Expected {name} to be omitted from {value}.");
        }
    }
}
