using System.Text.Json;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class ReasoningEncryptedValueEventTest
{
    [Fact]
    public void Serialize_IncludesAllFields()
    {
        var evt = new ReasoningEncryptedValueEvent
        {
            Subtype = "tool-call",
            EntityId = "entity-1",
            EncryptedValue = "enc-abc123"
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ReasoningEncryptedValueEvent);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.Equal("REASONING_ENCRYPTED_VALUE", root.GetProperty("type").GetString());
        Assert.Equal("tool-call", root.GetProperty("subtype").GetString());
        Assert.Equal("entity-1", root.GetProperty("entityId").GetString());
        Assert.Equal("enc-abc123", root.GetProperty("encryptedValue").GetString());
    }

    [Fact]
    public void Deserialize_RoundTrips()
    {
        var evt = new ReasoningEncryptedValueEvent
        {
            Subtype = "message",
            EntityId = "entity-2",
            EncryptedValue = "enc-xyz789"
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ReasoningEncryptedValueEvent);
        var deserialized = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.ReasoningEncryptedValueEvent);

        Assert.NotNull(deserialized);
        Assert.Equal("message", deserialized.Subtype);
        Assert.Equal("entity-2", deserialized.EntityId);
        Assert.Equal("enc-xyz789", deserialized.EncryptedValue);
    }

    [Fact]
    public void Deserialize_ViaBaseEvent_ReturnsCorrectType()
    {
        var json = """{"type":"REASONING_ENCRYPTED_VALUE","subtype":"tool-call","entityId":"e1","encryptedValue":"val"}""";
        var evt = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.BaseEvent);

        var encrypted = Assert.IsType<ReasoningEncryptedValueEvent>(evt);
        Assert.Equal("tool-call", encrypted.Subtype);
        Assert.Equal("e1", encrypted.EntityId);
        Assert.Equal("val", encrypted.EncryptedValue);
    }
}
