using System.Text.Json;
using Anthropic;
using Anthropic.Models.Beta.Agents;
using Anthropic.Models.Beta.Environments;

namespace AGUIDojoServer;

/// <summary>
/// Provisions the environment and one managed agent per example route.
/// </summary>
/// <remarks>
/// Idempotent: finds resources by name and only creates what is missing. Writes the resulting
/// IDs to <c>.managed-agents.json</c> for the server. Existing agents are not modified: to
/// apply prompt or model changes, archive the agent and re-run <c>setup</c>.
/// </remarks>
internal static class Provisioner
{
    internal static async Task RunAsync()
    {
        IAnthropicClient client = new AnthropicClient();
        var environmentId = await EnsureEnvironmentAsync(client);
        var existing = await ExistingAgentsByNameAsync(client);

        var ids = new ProvisionedIds { EnvironmentId = environmentId };
        foreach (var spec in AgentSpec.All)
        {
            ids.Agents[spec.Route] = await EnsureAgentAsync(client, existing, spec);
            Console.WriteLine($"  {spec.Route}: {ids.Agents[spec.Route]}");
        }

        ids.Save();
        Console.WriteLine($"Environment: {environmentId}");
        Console.WriteLine($"Wrote {ProvisionedIds.FilePath}");
    }

    private static async Task<string> EnsureEnvironmentAsync(IAnthropicClient client)
    {
        var page = await client.Beta.Environments.List();
        while (true)
        {
            foreach (var environment in page.Items)
            {
                if (string.Equals(environment.Name, AgentSpec.EnvironmentName, StringComparison.Ordinal))
                {
                    return environment.ID;
                }
            }

            if (!page.HasNext())
            {
                break;
            }

            page = await page.Next();
        }

        var created = await client.Beta.Environments.Create(new EnvironmentCreateParams
        {
            Name = AgentSpec.EnvironmentName,
            Config = new Config(JsonSerializer.SerializeToElement(new
            {
                type = "cloud",
                networking = new { type = "unrestricted" },
            })),
        });
        return created.ID;
    }

    private static async Task<Dictionary<string, string>> ExistingAgentsByNameAsync(IAnthropicClient client)
    {
        var byName = new Dictionary<string, string>(StringComparer.Ordinal);
        var page = await client.Beta.Agents.List();
        while (true)
        {
            foreach (var agent in page.Items)
            {
                byName[agent.Name] = agent.ID;
            }

            if (!page.HasNext())
            {
                break;
            }

            page = await page.Next();
        }

        return byName;
    }

    private static async Task<string> EnsureAgentAsync(
        IAnthropicClient client,
        Dictionary<string, string> existing,
        AgentSpec spec)
    {
        // Reuse by name. Existing agents are not modified: to apply prompt or model changes
        // from AgentSpecs, archive the agent and re-run setup.
        if (existing.TryGetValue(spec.AgentName, out var found))
        {
            return found;
        }

        var agent = await client.Beta.Agents.Create(new AgentCreateParams
        {
            Name = spec.AgentName,
            Model = new Model(JsonSerializer.SerializeToElement(AgentSpec.Model)),
            System = spec.System,
            // These routes drive tools from the frontend or the server, so the agent's
            // built-in toolset (bash, file editing, web) stays off.
            Tools =
            [
                new Tool(JsonSerializer.SerializeToElement(new
                {
                    type = "agent_toolset_20260401",
                    default_config = new { enabled = false },
                })),
            ],
        });
        return agent.ID;
    }
}
