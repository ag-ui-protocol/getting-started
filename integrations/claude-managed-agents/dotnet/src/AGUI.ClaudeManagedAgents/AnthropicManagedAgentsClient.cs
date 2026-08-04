using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anthropic;
using Anthropic.Models.Beta.Agents;
using Anthropic.Models.Beta.Sessions;
using Anthropic.Models.Beta.Sessions.Events;

namespace AGUI.ClaudeManagedAgents;

/// <summary>
/// The default <see cref="IManagedAgentsClient"/>, backed by the Anthropic C# SDK. Requests
/// carry the <c>managed-agents-2026-04-01</c> beta header, which the SDK's session and agent
/// services add on their own.
/// </summary>
public sealed class AnthropicManagedAgentsClient : IManagedAgentsClient
{
    private readonly IAnthropicClient _client;

    /// <summary>
    /// Initializes a new instance of the <see cref="AnthropicManagedAgentsClient"/> class over an
    /// existing SDK client.
    /// </summary>
    /// <param name="client">The Anthropic client. It reads <c>ANTHROPIC_API_KEY</c> (or
    /// <c>ANTHROPIC_AUTH_TOKEN</c>) from the environment unless configured otherwise.</param>
    public AnthropicManagedAgentsClient(IAnthropicClient client)
    {
        ArgumentNullException.ThrowIfNull(client);
        _client = client;
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="AnthropicManagedAgentsClient"/> class over a
    /// default <see cref="AnthropicClient"/>, which reads its API key from the environment.
    /// </summary>
    public AnthropicManagedAgentsClient()
        : this(new AnthropicClient())
    {
    }

    /// <inheritdoc />
    public async Task<string> CreateSessionAsync(ManagedAgentSessionRequest request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);

        var parameters = new SessionCreateParams
        {
            Agent = new Agent(AgentReference(request)),
            EnvironmentID = request.EnvironmentId,
            Title = request.Title,
            // Left unset rather than sent empty, so the payload matches the other two ports.
            VaultIds = request.VaultIds is { Count: > 0 } ? [.. request.VaultIds] : null,
        };

        var session = await _client.Beta.Sessions.Create(parameters, cancellationToken).ConfigureAwait(false);
        return session.ID;
    }

    /// <inheritdoc />
    public async Task UpdateSessionToolsAsync(string sessionId, IReadOnlyList<JsonElement> tools, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(sessionId);
        ArgumentNullException.ThrowIfNull(tools);

        var agentUpdate = new Dictionary<string, JsonElement>(StringComparer.Ordinal)
        {
            ["tools"] = ToArrayElement(tools),
        };
        var parameters = new SessionUpdateParams
        {
            SessionID = sessionId,
            Agent = new BetaManagedAgentsSessionAgentUpdate(agentUpdate),
        };

        await _client.Beta.Sessions.Update(parameters, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async Task<IReadOnlyList<JsonElement>> GetAgentToolsAsync(string managedAgentId, int? agentVersion, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(managedAgentId);

        AgentRetrieveParams? parameters = agentVersion is null ? null : new AgentRetrieveParams { Version = agentVersion };
        var agent = await _client.Beta.Agents.Retrieve(managedAgentId, parameters, cancellationToken).ConfigureAwait(false);

        // The read shape is structurally compatible with the tool params shape, so its JSON
        // can be sent back as an override entry unchanged.
        return agent.Tools.Select(static tool => tool.Json).ToList();
    }

    /// <inheritdoc />
    public async Task SendEventsAsync(string sessionId, IReadOnlyList<JsonElement> events, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(sessionId);
        ArgumentNullException.ThrowIfNull(events);

        var parameters = new EventSendParams
        {
            SessionID = sessionId,
            Events = events.Select(static json => new BetaManagedAgentsEventParams(json)).ToList(),
        };

        await _client.Beta.Sessions.Events.Send(parameters, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async Task<ManagedAgentsEventStream> OpenEventStreamAsync(string sessionId, bool streamDeltas, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(sessionId);

        var parameters = new EventStreamParams { SessionID = sessionId };
        if (streamDeltas)
        {
            // "agent.thinking" opts into the live thinking indicator (event_start); thinking
            // carries no text deltas today.
            parameters = parameters with
            {
                EventDeltas = [BetaManagedAgentsDeltaType.AgentMessage, BetaManagedAgentsDeltaType.AgentThinking],
            };
        }

        // Awaiting the raw response establishes the connection before the caller posts events,
        // so nothing the session emits in reply can be missed.
        var response = await _client
            .WithRawResponse.Beta.Sessions.Events
            .StreamStreaming(parameters, cancellationToken)
            .ConfigureAwait(false);

        return new ManagedAgentsEventStream(Enumerate(response, cancellationToken), () =>
        {
            response.Dispose();
            return default;
        });
    }

    private static async IAsyncEnumerable<BetaManagedAgentsStreamSessionEvents> Enumerate(
        Anthropic.Core.StreamingHttpResponse<BetaManagedAgentsStreamSessionEvents> response,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        await foreach (var streamEvent in response.Enumerate(cancellationToken).ConfigureAwait(false))
        {
            yield return streamEvent;
        }
    }

    private static JsonElement AgentReference(ManagedAgentSessionRequest request)
    {
        var agent = new JsonObject
        {
            ["type"] = request.OverrideTools is null ? "agent" : "agent_with_overrides",
            ["id"] = request.ManagedAgentId,
        };

        if (request.AgentVersion is int version)
        {
            agent["version"] = version;
        }

        if (request.OverrideTools is not null)
        {
            var tools = new JsonArray();
            foreach (var tool in request.OverrideTools)
            {
                tools.Add(JsonNode.Parse(tool.GetRawText()));
            }

            agent["tools"] = tools;
        }

        return JsonSerializer.SerializeToElement(agent);
    }

    private static JsonElement ToArrayElement(IReadOnlyList<JsonElement> items)
    {
        var array = new JsonArray();
        foreach (var item in items)
        {
            array.Add(JsonNode.Parse(item.GetRawText()));
        }

        return JsonSerializer.SerializeToElement(array);
    }
}
