using System.Text.Json;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.ClaudeManagedAgents.Tests;

public sealed class ManagedAgentsDynamicToolsTest
{
    private const string IdleEndTurn =
        """{"type":"session.status_idle","id":"idle_1","stop_reason":{"type":"end_turn"}}""";

    [Fact]
    public async Task RemovesToolsThatAreAbsentFromTheNextRun()
    {
        var showChart = Tool("show_chart", "Render a chart");
        var fake = await RunToolTransitionAsync(
            [showChart, Tool("export_csv", "Export a CSV")],
            [showChart]);

        AssertUpdate(
            fake,
            """{"type":"custom","name":"show_chart","description":"Render a chart","input_schema":{"type":"object","properties":{}}}""");
    }

    [Fact]
    public async Task ClearsFrontendToolsWhenTheNextRunHasNone()
    {
        var fake = await RunToolTransitionAsync([Tool("show_chart", "Render a chart")], []);

        AssertUpdate(fake);
    }

    [Fact]
    public async Task UpdatesASameNamedToolWhenItsDefinitionChanges()
    {
        var fake = await RunToolTransitionAsync(
            [Tool("show_chart", "Render a chart", """{"title":{"type":"string"}}""")],
            [Tool("show_chart", "Render a visualization", """{"series":{"type":"array"}}""")]);

        AssertUpdate(
            fake,
            """{"type":"custom","name":"show_chart","description":"Render a visualization","input_schema":{"type":"object","properties":{"series":{"type":"array"}}}}""");
    }

    [Fact]
    public async Task DoesNotUpdateTheSessionWhenToolDefinitionsAreUnchanged()
    {
        var tools = new List<AGUITool>
        {
            Tool("show_chart", "Render a chart", """{"title":{"type":"string"}}"""),
        };
        var fake = await RunToolTransitionAsync(tools, tools);

        Assert.Empty(fake.Updates);
    }

    private static async Task<FakeManagedAgentsClient> RunToolTransitionAsync(
        IList<AGUITool> initialTools,
        IList<AGUITool> nextTools)
    {
        var fake = new FakeManagedAgentsClient([IdleEndTurn], [IdleEndTurn]);
        fake.AgentTools =
        [
            FakeManagedAgentsClient.Json(
                """{"type":"agent_toolset_20260401","configs":[],"default_config":{}}"""),
        ];
        var store = new InMemorySessionStore();
        var agent = new ManagedAgentsAgent(new ManagedAgentsAgentOptions
        {
            ManagedAgentId = "agent_1",
            EnvironmentId = "env_1",
            Client = fake,
            SessionStore = store,
        });

        await CollectAsync(agent, Input("run_1", "u1", initialTools));
        await CollectAsync(agent, Input("run_2", "u2", nextTools));
        return fake;
    }

    private static RunAgentInput Input(
        string runId,
        string messageId,
        IList<AGUITool> tools)
    {
        return new RunAgentInput
        {
            ThreadId = "thread_1",
            RunId = runId,
            State = JsonSerializer.SerializeToElement(new { }),
            Messages =
            [
                new AGUIUserMessage
                {
                    Id = messageId,
                    Content = messageId == "u1" ? "Hello" : "Follow-up",
                },
            ],
            Tools = tools,
        };
    }

    [Fact]
    public async Task PushesAConsoleEditToTheAgentsOwnToolsIntoAnOverrideSession()
    {
        // Regression: an override session's tool list is a full replacement frozen at the last
        // update. Fingerprinting only the custom tools called an unchanged frontend list a match,
        // so a Console edit to the agent's own tools never reached the session and it kept a stale
        // replacement list indefinitely.
        const string EditedBaseTool =
            """{"type":"agent_toolset_20260401","configs":[{"name":"bash"}],"default_config":{}}""";
        var showChart = Tool("show_chart", "Render a chart");
        var fake = new FakeManagedAgentsClient([IdleEndTurn], [IdleEndTurn])
        {
            AgentTools = [FakeManagedAgentsClient.Json("""{"type":"agent_toolset_20260401","configs":[],"default_config":{}}""")],
        };
        var agent = new ManagedAgentsAgent(new ManagedAgentsAgentOptions
        {
            ManagedAgentId = "agent_1",
            EnvironmentId = "env_1",
            Client = fake,
            SessionStore = new InMemorySessionStore(),
        });

        await CollectAsync(agent, Input("run_1", "u1", [showChart]));
        Assert.Empty(fake.Updates);

        // The agent's own tools change in the Console; the frontend list does not.
        fake.AgentTools = [FakeManagedAgentsClient.Json(EditedBaseTool)];
        await CollectAsync(agent, Input("run_2", "u2", [showChart]));

        var update = Assert.Single(fake.Updates);
        Assert.Equal(2, update.Count);
        AssertJson(EditedBaseTool, update[0]);
        AssertJson(
            """{"type":"custom","name":"show_chart","description":"Render a chart","input_schema":{"type":"object","properties":{}}}""",
            update[1]);
    }

    [Fact]
    public async Task DoesNotReReadTheAgentsToolsForASessionWithoutCustomTools()
    {
        // Such a session runs the agent as-is, so there is nothing to keep in step and no reason to
        // spend a call per run finding that out.
        var fake = new FakeManagedAgentsClient([IdleEndTurn], [IdleEndTurn]);
        var agent = new ManagedAgentsAgent(new ManagedAgentsAgentOptions
        {
            ManagedAgentId = "agent_1",
            EnvironmentId = "env_1",
            Client = fake,
            SessionStore = new InMemorySessionStore(),
        });

        await CollectAsync(agent, Input("run_1", "u1", []));
        await CollectAsync(agent, Input("run_2", "u2", []));

        Assert.Empty(fake.AgentToolReads);
        Assert.Empty(fake.Updates);
    }

    private static AGUITool Tool(
        string name,
        string description,
        string propertiesJson = "{}")
    {
        return new AGUITool
        {
            Name = name,
            Description = description,
            Parameters = FakeManagedAgentsClient.Json(
                $$"""{"type":"object","properties":{{propertiesJson}}}"""),
        };
    }

    private static async Task CollectAsync(
        ManagedAgentsAgent agent,
        RunAgentInput input)
    {
        await foreach (var _ in agent.RunAsync(input))
        {
        }
    }

    private static void AssertUpdate(
        FakeManagedAgentsClient fake,
        params string[] expectedCustomTools)
    {
        var update = Assert.Single(fake.Updates);
        Assert.Equal(1 + expectedCustomTools.Length, update.Count);
        AssertJson(
            """{"type":"agent_toolset_20260401","configs":[],"default_config":{}}""",
            update[0]);
        for (var i = 0; i < expectedCustomTools.Length; i++)
        {
            AssertJson(expectedCustomTools[i], update[i + 1]);
        }
    }

    private static void AssertJson(string expected, JsonElement actual)
    {
        var expectedElement = FakeManagedAgentsClient.Json(expected);
        Assert.True(
            JsonElement.DeepEquals(expectedElement, actual),
            $"Expected {expectedElement.GetRawText()}\nActual   {actual.GetRawText()}");
    }
}
