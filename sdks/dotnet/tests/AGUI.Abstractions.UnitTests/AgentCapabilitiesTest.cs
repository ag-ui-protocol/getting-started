using System.Text.Json;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class AgentCapabilitiesTest
{
    private static readonly JsonElement EmptyObjectElement =
        JsonDocument.Parse("{}").RootElement.Clone();

    [Fact]
    public void RoundTrips_FullCapabilities()
    {
        var capabilities = new AgentCapabilities
        {
            Identity = new IdentityCapabilities
            {
                Name = "TestAgent",
                Type = "ag-ui-dotnet",
                Description = "A test agent",
                Version = "1.0.0",
                Provider = "TestOrg",
                DocumentationUrl = "https://example.com/docs"
            },
            Transport = new TransportCapabilities
            {
                Streaming = true,
                Websocket = false,
                HttpBinary = false,
                PushNotifications = false,
                Resumable = true
            },
            Tools = new ToolsCapabilities
            {
                Supported = true,
                ParallelCalls = true,
                ClientProvided = true,
                Items = new List<AGUITool>
                {
                    new AGUITool { Name = "search", Description = "Search the web", Parameters = EmptyObjectElement }
                }
            },
            Output = new OutputCapabilities
            {
                StructuredOutput = true,
                SupportedMimeTypes = new List<string> { "text/plain", "application/json" }
            },
            State = new StateCapabilities
            {
                Snapshots = true,
                Deltas = true,
                Memory = false,
                PersistentState = true
            },
            MultiAgent = new MultiAgentCapabilities
            {
                Supported = true,
                Delegation = true,
                Handoffs = false,
                SubAgents = new List<SubAgentInfo>
                {
                    new SubAgentInfo { Name = "helper", Description = "A helper agent" }
                }
            },
            Reasoning = new ReasoningCapabilities
            {
                Supported = true,
                Streaming = true,
                Encrypted = false
            },
            Multimodal = new MultimodalCapabilities
            {
                Input = new MultimodalInputCapabilities
                {
                    Image = true,
                    Audio = false,
                    Video = false,
                    Pdf = true,
                    File = true
                },
                Output = new MultimodalOutputCapabilities
                {
                    Image = true,
                    Audio = false
                }
            },
            Execution = new ExecutionCapabilities
            {
                CodeExecution = true,
                Sandboxed = true,
                MaxIterations = 10,
                MaxExecutionTime = 30000
            },
            HumanInTheLoop = new HumanInTheLoopCapabilities
            {
                Supported = true,
                Approvals = true,
                Interventions = false,
                Feedback = true
            }
        };

        var json = JsonSerializer.Serialize(capabilities, AGUIJsonSerializerContext.Default.AgentCapabilities);
        var result = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.AgentCapabilities);

        Assert.NotNull(result);
        Assert.Equal("TestAgent", result.Identity?.Name);
        Assert.Equal("ag-ui-dotnet", result.Identity?.Type);
        Assert.Equal("A test agent", result.Identity?.Description);
        Assert.Equal("1.0.0", result.Identity?.Version);
        Assert.Equal("TestOrg", result.Identity?.Provider);
        Assert.Equal("https://example.com/docs", result.Identity?.DocumentationUrl);

        Assert.True(result.Transport?.Streaming);
        Assert.False(result.Transport?.Websocket);
        Assert.True(result.Transport?.Resumable);

        Assert.True(result.Tools?.Supported);
        Assert.True(result.Tools?.ParallelCalls);
        Assert.True(result.Tools?.ClientProvided);
        Assert.Single(result.Tools!.Items!);
        Assert.Equal("search", result.Tools.Items![0].Name);

        Assert.True(result.Output?.StructuredOutput);
        Assert.Equal(2, result.Output?.SupportedMimeTypes?.Count);

        Assert.True(result.State?.Snapshots);
        Assert.True(result.State?.Deltas);
        Assert.False(result.State?.Memory);
        Assert.True(result.State?.PersistentState);

        Assert.True(result.MultiAgent?.Supported);
        Assert.True(result.MultiAgent?.Delegation);
        Assert.False(result.MultiAgent?.Handoffs);
        Assert.Single(result.MultiAgent!.SubAgents!);
        Assert.Equal("helper", result.MultiAgent.SubAgents![0].Name);

        Assert.True(result.Reasoning?.Supported);
        Assert.True(result.Reasoning?.Streaming);
        Assert.False(result.Reasoning?.Encrypted);

        Assert.True(result.Multimodal?.Input?.Image);
        Assert.False(result.Multimodal?.Input?.Audio);
        Assert.True(result.Multimodal?.Input?.Pdf);
        Assert.True(result.Multimodal?.Output?.Image);
        Assert.False(result.Multimodal?.Output?.Audio);

        Assert.True(result.Execution?.CodeExecution);
        Assert.True(result.Execution?.Sandboxed);
        Assert.Equal(10, result.Execution?.MaxIterations);
        Assert.Equal(30000, result.Execution?.MaxExecutionTime);

        Assert.True(result.HumanInTheLoop?.Supported);
        Assert.True(result.HumanInTheLoop?.Approvals);
        Assert.False(result.HumanInTheLoop?.Interventions);
        Assert.True(result.HumanInTheLoop?.Feedback);
    }

    [Fact]
    public void Serialize_UsesCamelCase()
    {
        var capabilities = new AgentCapabilities
        {
            Identity = new IdentityCapabilities { DocumentationUrl = "https://example.com" },
            HumanInTheLoop = new HumanInTheLoopCapabilities { Supported = true },
            MultiAgent = new MultiAgentCapabilities { Supported = true }
        };

        var json = JsonSerializer.Serialize(capabilities, AGUIJsonSerializerContext.Default.AgentCapabilities);

        Assert.Contains("documentationUrl", json);
        Assert.Contains("humanInTheLoop", json);
        Assert.Contains("multiAgent", json);
        Assert.DoesNotContain("DocumentationUrl", json);
        Assert.DoesNotContain("HumanInTheLoop", json);
        Assert.DoesNotContain("MultiAgent", json);
    }

    [Fact]
    public void Serialize_OmitsNullCategories()
    {
        var capabilities = new AgentCapabilities
        {
            Identity = new IdentityCapabilities { Name = "Agent" }
        };

        var json = JsonSerializer.Serialize(capabilities, AGUIJsonSerializerContext.Default.AgentCapabilities);

        Assert.Contains("identity", json);
        Assert.DoesNotContain("transport", json);
        Assert.DoesNotContain("tools", json);
        Assert.DoesNotContain("state", json);
        Assert.DoesNotContain("reasoning", json);
        Assert.DoesNotContain("multimodal", json);
        Assert.DoesNotContain("execution", json);
        Assert.DoesNotContain("humanInTheLoop", json);
    }

    [Fact]
    public void Serialize_OmitsNullProperties()
    {
        var capabilities = new AgentCapabilities
        {
            Transport = new TransportCapabilities
            {
                Streaming = true
            }
        };

        var json = JsonSerializer.Serialize(capabilities, AGUIJsonSerializerContext.Default.AgentCapabilities);
        using var doc = JsonDocument.Parse(json);
        var transport = doc.RootElement.GetProperty("transport");

        Assert.True(transport.GetProperty("streaming").GetBoolean());
        Assert.False(transport.TryGetProperty("websocket", out _));
        Assert.False(transport.TryGetProperty("httpBinary", out _));
        Assert.False(transport.TryGetProperty("pushNotifications", out _));
        Assert.False(transport.TryGetProperty("resumable", out _));
    }

    [Fact]
    public void Deserialize_FromTypeScriptPayload()
    {
        var json = """
        {
            "identity": {
                "name": "my-agent",
                "type": "langgraph",
                "description": "A custom agent",
                "version": "1.2.0",
                "provider": "Acme Corp",
                "documentationUrl": "https://docs.example.com"
            },
            "transport": {
                "streaming": true,
                "websocket": false
            },
            "tools": {
                "supported": true,
                "items": [
                    {
                        "name": "search",
                        "description": "Search tool",
                        "parameters": {}
                    }
                ],
                "parallelCalls": true,
                "clientProvided": false
            },
            "output": {
                "structuredOutput": true,
                "supportedMimeTypes": ["text/plain", "application/json"]
            },
            "state": {
                "snapshots": true,
                "deltas": false,
                "memory": true,
                "persistentState": true
            },
            "multiAgent": {
                "supported": true,
                "delegation": true,
                "handoffs": false,
                "subAgents": [
                    { "name": "sub-1", "description": "Sub agent 1" }
                ]
            },
            "reasoning": {
                "supported": true,
                "streaming": true,
                "encrypted": false
            },
            "multimodal": {
                "input": {
                    "image": true,
                    "audio": false,
                    "video": false,
                    "pdf": true,
                    "file": true
                },
                "output": {
                    "image": true,
                    "audio": false
                }
            },
            "execution": {
                "codeExecution": true,
                "sandboxed": true,
                "maxIterations": 25,
                "maxExecutionTime": 60000
            },
            "humanInTheLoop": {
                "supported": true,
                "approvals": true,
                "interventions": false,
                "feedback": true
            }
        }
        """;

        var result = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.AgentCapabilities);

        Assert.NotNull(result);

        Assert.Equal("my-agent", result.Identity?.Name);
        Assert.Equal("langgraph", result.Identity?.Type);

        Assert.True(result.Transport?.Streaming);
        Assert.False(result.Transport?.Websocket);

        Assert.True(result.Tools?.Supported);
        Assert.Single(result.Tools!.Items!);
        Assert.Equal("search", result.Tools.Items![0].Name);
        Assert.True(result.Tools.ParallelCalls);
        Assert.False(result.Tools.ClientProvided);

        Assert.True(result.Output?.StructuredOutput);
        Assert.Equal(new[] { "text/plain", "application/json" }, result.Output!.SupportedMimeTypes);

        Assert.True(result.State?.Snapshots);
        Assert.False(result.State?.Deltas);
        Assert.True(result.State?.Memory);

        Assert.True(result.MultiAgent?.Supported);
        Assert.Equal("sub-1", result.MultiAgent!.SubAgents![0].Name);

        Assert.True(result.Reasoning?.Supported);
        Assert.True(result.Reasoning?.Streaming);
        Assert.False(result.Reasoning?.Encrypted);

        Assert.True(result.Multimodal?.Input?.Image);
        Assert.True(result.Multimodal?.Input?.Pdf);
        Assert.True(result.Multimodal?.Output?.Image);

        Assert.Equal(25, result.Execution?.MaxIterations);
        Assert.Equal(60000, result.Execution?.MaxExecutionTime);

        Assert.True(result.HumanInTheLoop?.Approvals);
        Assert.True(result.HumanInTheLoop?.Feedback);
    }

    [Fact]
    public void EmptyCapabilities_SerializesToEmptyObject()
    {
        var capabilities = new AgentCapabilities();
        var json = JsonSerializer.Serialize(capabilities, AGUIJsonSerializerContext.Default.AgentCapabilities);

        Assert.Equal("{}", json);
    }

    [Fact]
    public void Deserialize_CustomField_RoundTrips()
    {
        var json = """{"identity":{"name":"test"},"custom":{"rateLimit":42}}""";

        var result = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.AgentCapabilities);

        Assert.NotNull(result);
        Assert.Equal("test", result.Identity?.Name);
        Assert.NotNull(result.Custom);
        Assert.True(result.Custom!.ContainsKey("rateLimit"));
    }
}
