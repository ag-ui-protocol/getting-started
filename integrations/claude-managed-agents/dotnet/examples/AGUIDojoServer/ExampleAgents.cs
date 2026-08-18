using System.Text.Json;
using AGUI.ClaudeManagedAgents;

namespace AGUIDojoServer;

/// <summary>
/// Builds one <see cref="ManagedAgentsAgent"/> per example route from the provisioned IDs.
/// </summary>
internal static class ExampleAgents
{
    /// <summary>Server-executed tools per route.</summary>
    private static readonly IReadOnlyDictionary<string, IReadOnlyList<ManagedAgentsBackendTool>> s_backendTools =
        new Dictionary<string, IReadOnlyList<ManagedAgentsBackendTool>>
        {
            ["backend_tool_rendering"] = [GetWeather()],
        };

    /// <summary>
    /// Constructs the agents that have provisioned IDs, keyed by route. Missing configuration is
    /// logged and skipped so the server always starts.
    /// </summary>
    internal static Dictionary<string, ManagedAgentsAgent> Build()
    {
        var agents = new Dictionary<string, ManagedAgentsAgent>(StringComparer.Ordinal);
        var ids = ProvisionedIds.Load();
        if (ids is null)
        {
            Console.Error.WriteLine(
                $"No provisioned agents ({ProvisionedIds.FilePath} missing); run `dotnet run -- setup`. Serving no routes.");
            return agents;
        }

        if (string.IsNullOrEmpty(ids.EnvironmentId))
        {
            Console.Error.WriteLine(
                $"No environmentId in {ProvisionedIds.FilePath}; re-run setup. Serving no routes.");
            return agents;
        }

        foreach (var spec in AgentSpec.All)
        {
            if (!ids.Agents.TryGetValue(spec.Route, out var agentId) || string.IsNullOrEmpty(agentId))
            {
                Console.Error.WriteLine($"No agent provisioned for {spec.Route}; skipping. Re-run setup.");
                continue;
            }

            var options = new ManagedAgentsAgentOptions
            {
                ManagedAgentId = agentId,
                EnvironmentId = ids.EnvironmentId,
            };
            if (s_backendTools.TryGetValue(spec.Route, out var tools))
            {
                foreach (var tool in tools)
                {
                    options.BackendTools.Add(tool);
                }
            }

            agents[spec.Route] = new ManagedAgentsAgent(options);
        }

        return agents;
    }

    private static ManagedAgentsBackendTool GetWeather()
    {
        return new ManagedAgentsBackendTool
        {
            Name = "get_weather",
            Description = "Get the current weather for a location.",
            Parameters = JsonSerializer.SerializeToElement(new
            {
                type = "object",
                properties = new
                {
                    location = new { type = "string", description = "City name" },
                },
                required = new[] { "location" },
            }),
            Handler = input =>
            {
                var location = input.ValueKind == JsonValueKind.Object
                    && input.TryGetProperty("location", out var value)
                    && value.ValueKind == JsonValueKind.String
                        ? value.GetString() ?? "somewhere"
                        : "somewhere";
                var weather = new
                {
                    location,
                    temperature = 21,
                    conditions = "sunny",
                    humidity = 48,
                    windSpeed = 12,
                };
                return Task.FromResult(JsonSerializer.Serialize(weather));
            },
        };
    }
}
