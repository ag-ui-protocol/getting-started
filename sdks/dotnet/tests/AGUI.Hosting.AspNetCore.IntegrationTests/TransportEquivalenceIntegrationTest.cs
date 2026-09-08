using System.Linq;
using System.Runtime.CompilerServices;
using System.Text.Json;
using AGUI.Abstractions;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Server.IntegrationTests;

/// <summary>
/// Asserts that running the same scenario over the JSON (SSE) and protobuf transports yields
/// identical decoded <see cref="ChatResponseUpdate"/> sequences. This is the property that lets
/// every other integration test share a single set of Verify baselines across both formats: the
/// request is always JSON and every capture point records decoded events, so only the wire
/// encoding differs.
/// </summary>
public sealed class TransportEquivalenceIntegrationTest : IntegrationTestBase
{
    public TransportEquivalenceIntegrationTest(WebApplicationFactory<Program> factory)
        : base(factory)
    {
    }

    [Fact]
    public async Task TextScenario_JsonAndProtobuf_ProduceIdenticalDecodedUpdates()
    {
        var json = await RunAsync(TransportFormat.Json);
        var proto = await RunAsync(TransportFormat.Protobuf);

        Assert.Equal(Describe(json), Describe(proto));

        async Task<List<ChatResponseUpdate>> RunAsync(TransportFormat format)
        {
            var client = CreateClient((messages, options, ct) =>
                EmitTextResponse("Identical across transports!", ct), format);
            return await CollectUpdates(client, [new ChatMessage(ChatRole.User, "Hi")]).ConfigureAwait(false);
        }
    }

    [Fact]
    public async Task StateScenario_JsonAndProtobuf_ProduceIdenticalDecodedUpdates()
    {
        var json = await RunAsync(TransportFormat.Json);
        var proto = await RunAsync(TransportFormat.Protobuf);

        Assert.Equal(Describe(json), Describe(proto));

        async Task<List<ChatResponseUpdate>> RunAsync(TransportFormat format)
        {
            var client = CreateClient((messages, options, ct) => EmitStateFlow(ct), format);
            return await CollectUpdates(client, [new ChatMessage(ChatRole.User, "Hi")]).ConfigureAwait(false);
        }
    }

    // Projects updates to a transport- and run-independent shape: per-update event type, role,
    // text, and the JSON of any dynamic event payload. Server-generated ids (RunId/MessageId)
    // are intentionally excluded because they are random per request, not per transport.
    private static List<string> Describe(IReadOnlyList<ChatResponseUpdate> updates)
    {
        return updates.Select(u =>
        {
            var eventType = u.RawRepresentation?.GetType().Name ?? "<none>";
            string payload = u.RawRepresentation switch
            {
                StateSnapshotEvent s => s.Snapshot.GetRawText(),
                StateDeltaEvent d => d.Delta.GetRawText(),
                TextMessageContentEvent t => t.Delta,
                _ => string.Empty,
            };
            return $"{eventType}|{u.Role}|{u.Text}|{payload}";
        }).ToList();
    }

    private static async IAsyncEnumerable<ChatResponseUpdate> EmitStateFlow(
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        yield return new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            RawRepresentation = new StateSnapshotEvent
            {
                Snapshot = JsonSerializer.SerializeToElement(new { counter = 0 })
            }
        };
        yield return new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            RawRepresentation = new StateDeltaEvent
            {
                Delta = JsonSerializer.SerializeToElement(new object[]
                {
                    new { op = "replace", path = "/counter", value = 1 }
                })
            }
        };
        await Task.CompletedTask.ConfigureAwait(false);
    }
}
