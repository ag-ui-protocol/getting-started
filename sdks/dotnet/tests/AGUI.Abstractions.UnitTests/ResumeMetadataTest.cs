using System.Text.Json;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

/// <summary>
/// Metadata on <see cref="AGUIResume"/> follows the same conventions as the
/// metadata object on events and messages (see <see cref="MetadataTest"/>):
/// open by key, any JSON value including null under a key, the object itself
/// absent or an object but never null on the wire, and an explicit null read
/// back as absent. It is envelope data about the response — signatures,
/// routing keys — as opposed to <see cref="AGUIResume.Payload"/>, which is the
/// answer the agent asked for.
/// </summary>
public sealed class ResumeMetadataTest
{
    // Every JSON shape the protocol promises survives a round trip.
    private const string ValueShapesJson = """
        {
          "nullValue": null,
          "string": "afterModel-review",
          "number": 42,
          "float": 1.5,
          "boolean": true,
          "emptyArray": [],
          "array": [1, "two", null, { "nested": true }],
          "emptyObject": {},
          "nested": { "signature": { "alg": "ed25519", "hash": "abc" }, "tags": ["a", "b"] }
        }
        """;

    private static JsonElement ValueShapes() => JsonDocument.Parse(ValueShapesJson).RootElement.Clone();

    [Fact]
    public void Resume_RoundTripsEveryValueShape()
    {
        var resume = new AGUIResume
        {
            InterruptId = "int-1",
            Status = ResumeStatus.Resolved,
            Metadata = ValueShapes(),
        };

        var json = JsonSerializer.Serialize(resume, AGUIJsonSerializerContext.Default.AGUIResume);
        var restored = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.AGUIResume);

        Assert.NotNull(restored);
        Assert.NotNull(restored!.Metadata);
        Assert.Equal(
            JsonSerializer.Serialize(ValueShapes()),
            JsonSerializer.Serialize(restored.Metadata!.Value));
    }

    [Fact]
    public void Resume_OmitsAbsentMetadataFromTheWire()
    {
        // An absent object must not become "metadata": null — AG-UI never puts a
        // null on the wire in place of the object.
        var resume = new AGUIResume { InterruptId = "int-1", Status = ResumeStatus.Resolved };

        var json = JsonSerializer.Serialize(resume, AGUIJsonSerializerContext.Default.AGUIResume);
        using var doc = JsonDocument.Parse(json);

        Assert.False(doc.RootElement.TryGetProperty("metadata", out _));
    }

    [Fact]
    public void Resume_ReadsExplicitNullAsAbsent()
    {
        // Producers that serialize unset optionals as null must still round-trip,
        // matching the TypeScript and Python schemas.
        const string json = """{"interruptId":"int-1","status":"resolved","metadata":null}""";

        var restored = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.AGUIResume);

        Assert.NotNull(restored);
        Assert.Null(restored!.Metadata);
    }

    [Fact]
    public void Resume_DistinguishesEmptyObjectFromAbsent()
    {
        const string json = """{"interruptId":"int-1","status":"resolved","metadata":{}}""";

        var restored = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.AGUIResume);

        Assert.NotNull(restored);
        Assert.NotNull(restored!.Metadata);
        Assert.Equal(JsonValueKind.Object, restored.Metadata!.Value.ValueKind);
        Assert.Empty(restored.Metadata!.Value.EnumerateObject());
    }

    [Fact]
    public void Resume_CarriesMetadataOnCancelledEntries()
    {
        const string json = """{"interruptId":"int-1","status":"cancelled","metadata":{"reason":"timeout"}}""";

        var restored = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.AGUIResume);

        Assert.NotNull(restored?.Metadata);
        Assert.Equal("timeout", restored!.Metadata!.Value.GetProperty("reason").GetString());
    }

    [Fact]
    public void Resume_MetadataReachesTheServerThroughRunAgentInput()
    {
        // The shape a client posts: a server handler reads the metadata off the
        // resume entry it was sent.
        const string json = """
            {
              "threadId": "t-1",
              "runId": "r-1",
              "messages": [],
              "resume": [
                {
                  "interruptId": "generic-1",
                  "status": "resolved",
                  "payload": { "approved": true },
                  "metadata": {
                    "ag-ui": {},
                    "definitionId": "review-plan",
                    "key": "afterModel-review"
                  }
                }
              ]
            }
            """;

        var input = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.RunAgentInput);

        Assert.NotNull(input?.Resume);
        var entry = Assert.Single(input!.Resume!);
        Assert.NotNull(entry.Metadata);
        Assert.Equal("review-plan", entry.Metadata!.Value.GetProperty("definitionId").GetString());
        Assert.Equal("afterModel-review", entry.Metadata!.Value.GetProperty("key").GetString());
        Assert.Equal(
            JsonValueKind.Object,
            entry.Metadata!.Value.GetProperty(AGUIMetadata.ReservedKey).ValueKind);
    }
}
