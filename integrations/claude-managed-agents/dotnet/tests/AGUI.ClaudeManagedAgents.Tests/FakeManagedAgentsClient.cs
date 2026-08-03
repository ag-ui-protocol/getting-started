using System.Runtime.CompilerServices;
using System.Text.Json;
using Anthropic.Models.Beta.Sessions.Events;

namespace AGUI.ClaudeManagedAgents.Tests;

/// <summary>
/// A scripted stand-in for the Managed Agents client. Each stream call yields the next
/// scripted batch of session events, given as JSON.
/// </summary>
public sealed class FakeManagedAgentsClient : IManagedAgentsClient
{
    private readonly Queue<IReadOnlyList<string>> _streams;

    public FakeManagedAgentsClient(params IReadOnlyList<string>[] streams)
    {
        _streams = new Queue<IReadOnlyList<string>>(streams);
    }

    public string SessionId { get; set; } = "sesn_1";

    /// <summary>The tools the fake agent reports, as tool definition JSON.</summary>
    public IReadOnlyList<JsonElement> AgentTools { get; set; } =
        [Json("""{"type":"agent_toolset_20260401","configs":[],"default_config":{}}""")];

    public List<ManagedAgentSessionRequest> CreatedSessions { get; } = [];

    public List<IReadOnlyList<JsonElement>> Updates { get; } = [];

    /// <summary>The events posted into the session, one entry per send call.</summary>
    public List<IReadOnlyList<JsonElement>> Sent { get; } = [];

    /// <summary>When set, streams wait for this to complete before yielding their events.</summary>
    public TaskCompletionSource? Gate { get; set; }

    /// <summary>When set, a stream throws this after yielding its scripted events.</summary>
    public Exception? StreamFailure { get; set; }

    /// <summary>When set, <see cref="CreateSessionAsync"/> throws this instead of creating.</summary>
    public Exception? CreateFailure { get; set; }

    /// <summary>
    /// Optional hook consulted on every send: return an exception to make that send fail,
    /// or <see langword="null"/> to record it as sent.
    /// </summary>
    public Func<IReadOnlyList<JsonElement>, Exception?>? SendGuard { get; set; }

    public Task<string> CreateSessionAsync(ManagedAgentSessionRequest request, CancellationToken cancellationToken)
    {
        CreatedSessions.Add(request);
        return CreateFailure is not null ? Task.FromException<string>(CreateFailure) : Task.FromResult(SessionId);
    }

    public Task UpdateSessionToolsAsync(string sessionId, IReadOnlyList<JsonElement> tools, CancellationToken cancellationToken)
    {
        Updates.Add(tools);
        return Task.CompletedTask;
    }

    /// <summary>Every agent-tools read, as (managed agent id, pinned version).</summary>
    public List<(string ManagedAgentId, int? AgentVersion)> AgentToolReads { get; } = [];

    public Task<IReadOnlyList<JsonElement>> GetAgentToolsAsync(string managedAgentId, int? agentVersion, CancellationToken cancellationToken)
    {
        AgentToolReads.Add((managedAgentId, agentVersion));
        return Task.FromResult(AgentTools);
    }

    public Task SendEventsAsync(string sessionId, IReadOnlyList<JsonElement> events, CancellationToken cancellationToken)
    {
        SendAttempts.Add(events);
        SendTokens.Add(cancellationToken);

        // A send whose token is already cancelled never reaches the API. Modelling
        // that is what makes the "best-effort sends survive the run's abort"
        // contract observable: a send that reuses the run's cancelled token —
        // instead of its own bounded timeout — fails here rather than passing.
        if (cancellationToken.IsCancellationRequested)
        {
            return Task.FromCanceled(cancellationToken);
        }

        var failure = SendGuard?.Invoke(events);
        if (failure is not null)
        {
            return Task.FromException(failure);
        }

        Sent.Add(events);
        return Task.CompletedTask;
    }

    /// <summary>Every send call, including the ones scripted to fail.</summary>
    public List<IReadOnlyList<JsonElement>> SendAttempts { get; } = [];

    /// <summary>The cancellation token each send was made with, in call order.</summary>
    public List<CancellationToken> SendTokens { get; } = [];

    /// <summary>Every stream opened, as (session, streamDeltas).</summary>
    public List<(string SessionId, bool StreamDeltas)> StreamRequests { get; } = [];

    /// <summary>Every event that was posted, flattened across send calls.</summary>
    public IEnumerable<JsonElement> SentEvents => Sent.SelectMany(static batch => batch);

    /// <summary>The <c>type</c> of every posted event, in order.</summary>
    public IEnumerable<string?> SentTypes => SentEvents.Select(static evt => evt.GetProperty("type").GetString());

    public Task<ManagedAgentsEventStream> OpenEventStreamAsync(string sessionId, bool streamDeltas, CancellationToken cancellationToken)
    {
        StreamRequests.Add((sessionId, streamDeltas));
        var events = _streams.TryDequeue(out var scripted) ? scripted : [];
        return Task.FromResult(new ManagedAgentsEventStream(Enumerate(events, Gate, StreamFailure, cancellationToken)));
    }

    /// <summary>Parses a JSON literal into a detached element.</summary>
    public static JsonElement Json(string json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    private static async IAsyncEnumerable<BetaManagedAgentsStreamSessionEvents> Enumerate(
        IReadOnlyList<string> events,
        TaskCompletionSource? gate,
        Exception? failure,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        if (gate is not null)
        {
            await gate.Task.WaitAsync(cancellationToken);
        }

        foreach (var json in events)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await Task.Yield();
            yield return JsonSerializer.Deserialize<BetaManagedAgentsStreamSessionEvents>(json)
                ?? throw new InvalidOperationException($"Could not parse event: {json}");
        }

        if (failure is not null)
        {
            throw failure;
        }
    }
}
