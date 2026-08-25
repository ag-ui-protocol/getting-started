using System.Linq;
using System.Runtime.CompilerServices;
using System.Text.Json;
using AGUI.Abstractions;
using AGUI.Client;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Server.IntegrationTests;

public sealed class StateManagementIntegrationTest : IntegrationTestBase
{
    public StateManagementIntegrationTest(WebApplicationFactory<Program> factory)
        : base(factory)
    {
    }

    [Theory]
    [InlineData(TransportFormat.Json)]
    [InlineData(TransportFormat.Protobuf)]
    public async Task PostRun_StateSnapshot_MapsToUpdateWithRawRepresentation(TransportFormat format)
    {
        var client = CreateClient((messages, options, ct) => EmitStateSnapshotResponse(ct), format);

        var updates = await CollectUpdates(client, [new ChatMessage(ChatRole.User, "Hi")]);

        // Expect: RunStarted, StateSnapshot, RunFinished
        Assert.Equal(3, updates.Count);

        var stateUpdate = updates[1];
        Assert.Equal(ChatRole.Assistant, stateUpdate.Role);
        var snapshot = Assert.IsType<StateSnapshotEvent>(stateUpdate.RawRepresentation);
        Assert.Equal(0, snapshot.Snapshot.GetProperty("counter").GetInt32());
    }

    [Theory]
    [InlineData(TransportFormat.Json)]
    [InlineData(TransportFormat.Protobuf)]
    public async Task PostRun_StateDelta_MapsToUpdateWithRawRepresentation(TransportFormat format)
    {
        var client = CreateClient((messages, options, ct) => EmitStateWithDeltaResponse(ct), format);

        var updates = await CollectUpdates(client, [new ChatMessage(ChatRole.User, "Hi")]);

        // Expect: RunStarted, StateSnapshot, StateDelta, RunFinished
        Assert.Equal(4, updates.Count);

        // Check snapshot update
        var snapshotUpdate = updates[1];
        Assert.IsType<StateSnapshotEvent>(snapshotUpdate.RawRepresentation);

        // Check delta update
        var deltaUpdate = updates[2];
        Assert.Equal(ChatRole.Assistant, deltaUpdate.Role);
        var delta = Assert.IsType<StateDeltaEvent>(deltaUpdate.RawRepresentation);
        Assert.Equal(2, delta.Delta.GetArrayLength());
        Assert.Equal("replace", delta.Delta[0].GetProperty("op").GetString());
        Assert.Equal("add", delta.Delta[1].GetProperty("op").GetString());
    }

    [Theory]
    [InlineData(TransportFormat.Json)]
    [InlineData(TransportFormat.Protobuf)]
    public async Task PostRun_StateEvents_ShareResponseId(TransportFormat format)
    {
        var client = CreateClient((messages, options, ct) => EmitStateWithDeltaResponse(ct), format);

        var updates = await CollectUpdates(client, [new ChatMessage(ChatRole.User, "Hi")]);

        // AGUIChatClient is stateless: it never surfaces a ConversationId (issue #4869).
        // Updates are correlated by ResponseId instead.
        Assert.All(updates, u =>
        {
            Assert.Null(u.ConversationId);
            Assert.NotNull(u.ResponseId);
        });

        var responseId = updates[0].ResponseId;
        Assert.All(updates, u => Assert.Equal(responseId, u.ResponseId));
    }

    [Theory]
    [InlineData(TransportFormat.Json)]
    [InlineData(TransportFormat.Protobuf)]
    public async Task PostRun_WithStateInRawRepresentationFactory_StateArrivesOnServer(TransportFormat format)
    {
        RunAgentInput? capturedInput = null;
        var client = CreateClient((messages, options, ct) =>
        {
            options?.TryGetRunAgentInput(out capturedInput);
            return EmitEmptyResponse(ct);
        }, format);

        var state = JsonSerializer.SerializeToElement(new { counter = 5, name = "test" });
        var chatOptions = new ChatOptions
        {
            RawRepresentationFactory = _ => new RunAgentInput
            {
                ThreadId = "state-thread",
                RunId = "state-run",
                State = state
            }
        };

        await CollectUpdates(client, [new ChatMessage(ChatRole.User, "Hi")], chatOptions);

        Assert.NotNull(capturedInput);
        Assert.NotNull(capturedInput!.State);
        Assert.Equal(5, capturedInput.State!.Value.GetProperty("counter").GetInt32());
        Assert.Equal("test", capturedInput.State!.Value.GetProperty("name").GetString());
    }

    [Theory]
    [InlineData(TransportFormat.Json)]
    [InlineData(TransportFormat.Protobuf)]
    public async Task PostRun_WithNullState_ServerReceivesNullState(TransportFormat format)
    {
        RunAgentInput? capturedInput = null;
        var client = CreateClient((messages, options, ct) =>
        {
            options?.TryGetRunAgentInput(out capturedInput);
            return EmitEmptyResponse(ct);
        }, format);

        var chatOptions = new ChatOptions
        {
            RawRepresentationFactory = _ => new RunAgentInput
            {
                ThreadId = "no-state-thread",
                RunId = "no-state-run"
            }
        };

        await CollectUpdates(client, [new ChatMessage(ChatRole.User, "Hi")], chatOptions);

        Assert.NotNull(capturedInput);
        Assert.Null(capturedInput!.State);
    }

    [Theory]
    [InlineData(TransportFormat.Json)]
    [InlineData(TransportFormat.Protobuf)]
    public async Task PostRun_WithStateRoundTrip_ServerReceivesAndEchoesState(TransportFormat format)
    {
        var client = CreateClient((messages, options, ct) =>
        {
            RunAgentInput? input = null;
            options?.TryGetRunAgentInput(out input);
            return EmitStateSnapshotFromInput(input?.State, ct);
        }, format);

        var state = JsonSerializer.SerializeToElement(new { counter = 42 });
        var chatOptions = new ChatOptions
        {
            RawRepresentationFactory = _ => new RunAgentInput
            {
                ThreadId = "roundtrip-thread",
                RunId = "roundtrip-run",
                State = state
            }
        };

        var updates = await CollectUpdates(client, [new ChatMessage(ChatRole.User, "Hi")], chatOptions);

        // Expect: RunStarted, StateSnapshot (echoing input state), RunFinished
        Assert.Equal(3, updates.Count);
        var snapshot = Assert.IsType<StateSnapshotEvent>(updates[1].RawRepresentation);
        Assert.Equal(42, snapshot.Snapshot.GetProperty("counter").GetInt32());
    }

    private static async IAsyncEnumerable<ChatResponseUpdate> EmitStateSnapshotResponse(
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        yield return new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            RawRepresentation = new StateSnapshotEvent
            {
                Snapshot = JsonSerializer.SerializeToElement(new { counter = 0, items = (string[])[] })
            }
        };
        await Task.CompletedTask.ConfigureAwait(false);
    }

    private static async IAsyncEnumerable<ChatResponseUpdate> EmitStateWithDeltaResponse(
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        yield return new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            RawRepresentation = new StateSnapshotEvent
            {
                Snapshot = JsonSerializer.SerializeToElement(new { counter = 0, items = (string[])[] })
            }
        };
        yield return new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            RawRepresentation = new StateDeltaEvent
            {
                Delta = JsonSerializer.SerializeToElement(new object[]
                {
                    new { op = "replace", path = "/counter", value = 1 },
                    new { op = "add", path = "/items/-", value = "item1" }
                })
            }
        };
        await Task.CompletedTask.ConfigureAwait(false);
    }

    private static async IAsyncEnumerable<ChatResponseUpdate> EmitStateSnapshotFromInput(
        JsonElement? state,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        if (state is not null)
        {
            yield return new ChatResponseUpdate
            {
                Role = ChatRole.Assistant,
                RawRepresentation = new StateSnapshotEvent
                {
                    Snapshot = state.Value
                }
            };
        }

        await Task.CompletedTask.ConfigureAwait(false);
    }
}
