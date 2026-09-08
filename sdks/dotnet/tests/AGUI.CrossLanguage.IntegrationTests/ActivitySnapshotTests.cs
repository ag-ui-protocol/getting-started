using AGUI.Abstractions;
using AGUI.Client;
using Microsoft.Extensions.AI;

namespace AGUI.CrossLanguage.IntegrationTests;

[Collection(nameof(TsServerCollection))]
public sealed class ActivitySnapshotTests
{
    private readonly TsServerFixture _fixture;

    public ActivitySnapshotTests(TsServerFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task ActivitySnapshot_RoundTripsWithStructuredContent()
    {
        // ACTIVITY_SNAPSHOT was added as part of the .NET wire-format sync
        // work (AGUIActivityMessage). The fake agent emits one carrying a
        // structured plan; the C# client must surface it on the update's
        // RawRepresentation with all fields intact (messageId, activityType,
        // content with the nested steps array, replace flag).
        using HttpClient http = new() { Timeout = TimeSpan.FromSeconds(10) };
        AGUIChatClient client = new(new(http, $"{_fixture.BaseUrl}/activity_snapshot"));
        using CancellationTokenSource cts = new(TimeSpan.FromSeconds(20));

        List<ChatResponseUpdate> updates = [];
        await foreach (ChatResponseUpdate update in client
            .GetStreamingResponseAsync(
                [new(ChatRole.User, "Show me the plan")],
                cancellationToken: cts.Token))
        {
            updates.Add(update);
        }

        ActivitySnapshotEvent? activity = updates
            .Select(u => u.RawRepresentation)
            .OfType<ActivitySnapshotEvent>()
            .FirstOrDefault();
        Assert.NotNull(activity);
        Assert.Equal("PLAN", activity!.ActivityType);
        Assert.True(activity.Replace);

        string contentJson = activity.Content.ToString();
        Assert.Contains("Gather ingredients", contentJson);
        Assert.Contains("Cook pasta", contentJson);
        Assert.Contains("Serve and enjoy", contentJson);
    }
}
