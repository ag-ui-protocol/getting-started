using System.Runtime.CompilerServices;
using System.Text.Json;
using AGUI.Abstractions;
using AGUI.Client;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Server.IntegrationTests;

public sealed class ActivityIntegrationTest : IntegrationTestBase
{
    public ActivityIntegrationTest(WebApplicationFactory<Program> factory)
        : base(factory)
    {
    }

    [Fact]
    public async Task PostRun_ActivitySnapshot_MapsToUpdateWithRawRepresentation()
    {
        var client = CreateClient((messages, options, ct) => EmitActivitySnapshotResponse(ct));

        var updates = await CollectUpdates(client, [new ChatMessage(ChatRole.User, "Hi")]);

        // Expect: RunStarted, ActivitySnapshot, RunFinished
        Assert.Equal(3, updates.Count);

        var activityUpdate = updates[1];
        Assert.Equal(ChatRole.Assistant, activityUpdate.Role);
        var snapshot = Assert.IsType<ActivitySnapshotEvent>(activityUpdate.RawRepresentation);
        Assert.Equal("msg_activity", snapshot.MessageId);
        Assert.Equal("PLAN", snapshot.ActivityType);
        Assert.Equal(1, snapshot.Content.GetProperty("tasks").GetArrayLength());
    }

    [Fact]
    public async Task PostRun_ActivityDelta_MapsToUpdateWithRawRepresentation()
    {
        var client = CreateClient((messages, options, ct) => EmitActivityWithDeltaResponse(ct));

        var updates = await CollectUpdates(client, [new ChatMessage(ChatRole.User, "Hi")]);

        // Expect: RunStarted, ActivitySnapshot, ActivityDelta, RunFinished
        Assert.Equal(4, updates.Count);

        var deltaUpdate = updates[2];
        Assert.Equal(ChatRole.Assistant, deltaUpdate.Role);
        var delta = Assert.IsType<ActivityDeltaEvent>(deltaUpdate.RawRepresentation);
        Assert.Equal("msg_activity", delta.MessageId);
        Assert.Equal("PLAN", delta.ActivityType);
        Assert.Equal(1, delta.Patch.GetArrayLength());
        Assert.Equal("replace", delta.Patch[0].GetProperty("op").GetString());
    }

    [Fact]
    public async Task PostRun_ActivityEvents_ShareResponseId()
    {
        var client = CreateClient((messages, options, ct) => EmitActivityWithDeltaResponse(ct));

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

    [Fact]
    public async Task PostRun_ActivitySnapshotWithReplace_PreservesReplaceFlag()
    {
        var client = CreateClient((messages, options, ct) => EmitActivitySnapshotWithReplaceResponse(ct));

        var updates = await CollectUpdates(client, [new ChatMessage(ChatRole.User, "Hi")]);

        Assert.Equal(3, updates.Count);
        var snapshot = Assert.IsType<ActivitySnapshotEvent>(updates[1].RawRepresentation);
        Assert.False(snapshot.Replace);
    }

    private static async IAsyncEnumerable<ChatResponseUpdate> EmitActivitySnapshotResponse(
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        yield return new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            RawRepresentation = new ActivitySnapshotEvent
            {
                MessageId = "msg_activity",
                ActivityType = "PLAN",
                Content = JsonSerializer.SerializeToElement(new { tasks = new[] { "search" } }),
                Replace = true
            }
        };
        await Task.CompletedTask.ConfigureAwait(false);
    }

    private static async IAsyncEnumerable<ChatResponseUpdate> EmitActivityWithDeltaResponse(
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        yield return new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            RawRepresentation = new ActivitySnapshotEvent
            {
                MessageId = "msg_activity",
                ActivityType = "PLAN",
                Content = JsonSerializer.SerializeToElement(new { tasks = new[] { "search" } })
            }
        };
        yield return new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            RawRepresentation = new ActivityDeltaEvent
            {
                MessageId = "msg_activity",
                ActivityType = "PLAN",
                Patch = JsonSerializer.SerializeToElement(new[]
                {
                    new { op = "replace", path = "/tasks/0", value = "✓ search" }
                })
            }
        };
        await Task.CompletedTask.ConfigureAwait(false);
    }

    private static async IAsyncEnumerable<ChatResponseUpdate> EmitActivitySnapshotWithReplaceResponse(
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        yield return new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            RawRepresentation = new ActivitySnapshotEvent
            {
                MessageId = "msg_activity",
                ActivityType = "PLAN",
                Content = JsonSerializer.SerializeToElement(new { tasks = new[] { "search" } }),
                Replace = false
            }
        };
        await Task.CompletedTask.ConfigureAwait(false);
    }
}
