namespace AGUIDojoServer;

/// <summary>
/// The managed agent behind each example route. <see cref="Provisioner"/> creates them;
/// <see cref="ExampleAgents"/> serves them. Add a route by adding an entry here.
/// </summary>
internal sealed class AgentSpec
{
    internal AgentSpec(string route, string agentName, string system)
    {
        Route = route;
        AgentName = agentName;
        System = system;
    }

    /// <summary>Route name and feature id.</summary>
    internal string Route { get; }

    /// <summary>Managed agent name (used to find or create it idempotently).</summary>
    internal string AgentName { get; }

    /// <summary>The agent's system prompt.</summary>
    internal string System { get; }

    /// <summary>The model the agents are created on. Override with <c>MANAGED_AGENTS_MODEL</c>.</summary>
    internal static string Model =>
        Environment.GetEnvironmentVariable("MANAGED_AGENTS_MODEL") is { Length: > 0 } model ? model : "claude-sonnet-5";

    /// <summary>The name of the environment the agents run in.</summary>
    internal const string EnvironmentName = "ag-ui-dojo";

    internal static IReadOnlyList<AgentSpec> All { get; } =
    [
        new AgentSpec(
            "agentic_chat",
            "ag-ui-dojo-agentic-chat",
            "You are a helpful assistant. Keep replies concise."),
        new AgentSpec(
            "backend_tool_rendering",
            "ag-ui-dojo-backend-tool-rendering",
            "You are a helpful assistant. When the user asks about the weather, call the " +
            "get_weather tool and then summarize the result in a sentence."),
        new AgentSpec(
            "human_in_the_loop",
            "ag-ui-dojo-human-in-the-loop",
            "You are a task planning assistant. For every request, IMMEDIATELY call the " +
            "generate_task_steps tool with about 10 steps, each an object with `description` " +
            "(brief imperative) and `status` set to \"enabled\". Do not repeat the steps as text; " +
            "the UI shows them. After the user approves steps via the tool result, confirm briefly."),
        new AgentSpec(
            "tool_based_generative_ui",
            "ag-ui-dojo-tool-based-generative-ui",
            "You are a haiku assistant. When asked, call the generate_haiku tool with the " +
            "haiku's lines in Japanese and English. Keep any other text short."),
    ];
}
