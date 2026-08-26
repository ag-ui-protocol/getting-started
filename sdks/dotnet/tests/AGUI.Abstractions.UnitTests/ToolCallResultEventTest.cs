using System.Text.Json;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class ToolCallResultEventTest
{
    [Fact]
    public void Serialize_IncludesTypeAndToolCallIdAndContent()
    {
        var evt = new ToolCallResultEvent
        {
            ToolCallId = "call-1",
            MessageId = "msg-1",
            Content = "{\"temp\":72}"
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ToolCallResultEvent);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.Equal("TOOL_CALL_RESULT", root.GetProperty("type").GetString());
        Assert.Equal("call-1", root.GetProperty("toolCallId").GetString());
        Assert.Equal("msg-1", root.GetProperty("messageId").GetString());
        Assert.Equal("{\"temp\":72}", root.GetProperty("content").GetString());
    }

    [Fact]
    public void Serialize_IncludesRole_WhenSet()
    {
        var evt = new ToolCallResultEvent
        {
            ToolCallId = "call-1",
            MessageId = "msg-1",
            Content = "result-data",
            Role = "tool"
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ToolCallResultEvent);
        using var doc = JsonDocument.Parse(json);

        Assert.Equal("tool", doc.RootElement.GetProperty("role").GetString());
    }

    [Fact]
    public void Serialize_OmitsRole_WhenNull()
    {
        var evt = new ToolCallResultEvent
        {
            ToolCallId = "call-1",
            MessageId = "msg-1",
            Content = "ok"
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ToolCallResultEvent);
        using var doc = JsonDocument.Parse(json);

        Assert.False(doc.RootElement.TryGetProperty("role", out _));
    }

    [Fact]
    public void Deserialize_RoundTrips()
    {
        var evt = new ToolCallResultEvent
        {
            ToolCallId = "call-2",
            MessageId = "msg-2",
            Content = "success",
            Role = "tool"
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ToolCallResultEvent);
        var deserialized = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.ToolCallResultEvent);

        Assert.NotNull(deserialized);
        Assert.Equal("call-2", deserialized.ToolCallId);
        Assert.Equal("msg-2", deserialized.MessageId);
        Assert.Equal("success", deserialized.Content);
        Assert.Equal("tool", deserialized.Role);
    }

    [Fact]
    public void Deserialize_ViaBaseEvent_ReturnsCorrectType()
    {
        var json = """{"type":"TOOL_CALL_RESULT","toolCallId":"call-3","messageId":"msg-3","content":"done"}""";
        var evt = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.BaseEvent);

        var typed = Assert.IsType<ToolCallResultEvent>(evt);
        Assert.Equal("call-3", typed.ToolCallId);
        Assert.Equal("msg-3", typed.MessageId);
        Assert.Equal("done", typed.Content);
    }

    // `Error` is the event-side twin of AGUIToolMessage.Error: set when the tool call
    // failed, so a consumer can render the failure from the live stream rather than
    // waiting for the messages snapshot that carries the finished message.

    [Fact]
    public void Serialize_IncludesError_WhenSet()
    {
        var evt = new ToolCallResultEvent
        {
            ToolCallId = "call-1",
            MessageId = "msg-1",
            Content = string.Empty,
            Error = "SearchTimeout: upstream did not respond within 30s"
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ToolCallResultEvent);
        using var doc = JsonDocument.Parse(json);

        Assert.Equal(
            "SearchTimeout: upstream did not respond within 30s",
            doc.RootElement.GetProperty("error").GetString());
    }

    [Fact]
    public void Serialize_OmitsError_WhenNull()
    {
        // Asserted against a populated sibling, because the omission on its own is
        // result-forced: a type that declared no error at all, or wrote it under some other
        // key, would satisfy "no 'error' property" just as well as one that honours null.
        // The populated event establishes that "error" is a key this type does write, so the
        // absence below is the serializer omitting a null rather than the key never existing.
        static string SerializeWithError(string? error) => JsonSerializer.Serialize(
            new ToolCallResultEvent
            {
                ToolCallId = "call-1",
                MessageId = "msg-1",
                Content = "ok",
                Error = error
            },
            AGUIJsonSerializerContext.Default.ToolCallResultEvent);

        using var populated = JsonDocument.Parse(SerializeWithError("boom"));
        Assert.True(populated.RootElement.TryGetProperty("error", out var written));
        Assert.Equal("boom", written.GetString());

        using var omitted = JsonDocument.Parse(SerializeWithError(null));
        Assert.False(omitted.RootElement.TryGetProperty("error", out _));
    }

    [Fact]
    public void Serialize_KeepsEmptyStringError()
    {
        // WhenWritingNull omits null, not empty — an empty string is a value the
        // producer chose to send, and dropping it would read as "the call succeeded".
        var evt = new ToolCallResultEvent
        {
            ToolCallId = "call-1",
            MessageId = "msg-1",
            Content = "ok",
            Error = string.Empty
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ToolCallResultEvent);
        using var doc = JsonDocument.Parse(json);

        Assert.True(doc.RootElement.TryGetProperty("error", out var error));
        Assert.Equal(string.Empty, error.GetString());
    }

    [Fact]
    public void Deserialize_RoundTripsError()
    {
        var evt = new ToolCallResultEvent
        {
            ToolCallId = "call-2",
            MessageId = "msg-2",
            Content = string.Empty,
            Role = "tool",
            Error = "boom"
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ToolCallResultEvent);

        // Pin the wire key before round-tripping. A round-trip through this SDK's own
        // serializer agrees with itself under any spelling — renaming the JSON property to
        // "err" leaves the round-trip green — so the key the other SDKs read is asserted
        // here explicitly rather than being assumed.
        using (var doc = JsonDocument.Parse(json))
        {
            Assert.Equal("boom", doc.RootElement.GetProperty("error").GetString());
        }

        var deserialized = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.ToolCallResultEvent);

        Assert.NotNull(deserialized);
        Assert.Equal("boom", deserialized.Error);
    }

    [Fact]
    public void Deserialize_ViaBaseEvent_CarriesError()
    {
        var json = """{"type":"TOOL_CALL_RESULT","toolCallId":"call-3","messageId":"msg-3","content":"","error":"boom"}""";
        var evt = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.BaseEvent);

        var typed = Assert.IsType<ToolCallResultEvent>(evt);
        Assert.Equal("boom", typed.Error);
    }

    [Fact]
    public void Deserialize_ExplicitNullError_ReadsAsAbsentAndIsOmittedOnReserialize()
    {
        // Documented on the property but pinned by nothing until now. Unlike the TypeScript
        // schema, which rejects an explicit null on every new optional field, this SDK reads
        // one back as `null` — as it does for every optional property here. What the
        // cross-language contract guarantees is not that a null is refused but that none is
        // ever WRITTEN, so re-serializing has to drop the key rather than echo the null.
        var json = """{"type":"TOOL_CALL_RESULT","toolCallId":"call-5","messageId":"msg-5","content":"ok","error":null}""";

        var evt = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.BaseEvent);

        var typed = Assert.IsType<ToolCallResultEvent>(evt);
        Assert.Null(typed.Error);

        var reserialized = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.BaseEvent);
        using var doc = JsonDocument.Parse(reserialized);
        Assert.False(doc.RootElement.TryGetProperty("error", out _));
        // ...and the rest of the event is untouched by the null having been there.
        Assert.Equal("ok", doc.RootElement.GetProperty("content").GetString());
        Assert.Equal("call-5", doc.RootElement.GetProperty("toolCallId").GetString());
    }

    [Theory]
    [InlineData("42")]
    [InlineData("{\"code\":\"SearchTimeout\"}")]
    [InlineData("[\"SearchTimeout\"]")]
    [InlineData("true")]
    public void Deserialize_NonStringError_Throws(string errorLiteral)
    {
        // The narrowing half of what the property documents. Declaring `error` as `string?`
        // means a producer that writes some other shape under this key does not quietly lose
        // the field — System.Text.Json refuses the payload outright.
        //
        // All three SDKs refuse a non-string, but each fails in its own currency and the
        // shape of the failure is what a consumer has to handle: Zod throws a ZodError,
        // pydantic raises a ValidationError, and .NET surfaces it as a System.Text.Json
        // JsonException from the reader itself. The assertions below are the observed
        // behaviour — a JsonException whose Path names `$.error` — rather than an assumption
        // about how the source-generated converter handles a type mismatch.
        var json = $$"""{"type":"TOOL_CALL_RESULT","toolCallId":"call-6","messageId":"msg-6","content":"","error":{{errorLiteral}}}""";

        var thrown = Assert.Throws<JsonException>(
            () => JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.BaseEvent));

        Assert.Equal("$.error", thrown.Path);
        Assert.Contains("could not be converted to System.String", thrown.Message);
    }

    [Fact]
    public void Deserialize_ExistingEventWithoutError_LeavesItNull()
    {
        // The additive guarantee: an event from before this field existed is
        // unchanged, and reads back with no error.
        var json = """{"type":"TOOL_CALL_RESULT","toolCallId":"call-4","messageId":"msg-4","content":"done","role":"tool"}""";
        var evt = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.BaseEvent);

        var typed = Assert.IsType<ToolCallResultEvent>(evt);
        Assert.Null(typed.Error);
    }
}
