using System.Text.Json;
using System.Text.Json.Serialization;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

/// <summary>
/// Pins the exact JSON <see cref="AgentCapabilities"/> puts on the wire.
/// </summary>
/// <remarks>
/// <para>
/// The capability types are generated from the shared JSON Schema, so the C# property
/// names and the wire keys are two different things and only the wire keys are the
/// contract. Everything here goes through the source-generated
/// <see cref="AGUIJsonSerializerContext"/> — the AOT path the SSE formatter, the protobuf
/// formatter and the HTTP transport all use — and through
/// <see cref="AGUIJsonUtilities.DefaultTypeInfoResolver"/>, never through reflection-based
/// serialization, so a metadata-only regression cannot hide behind a reflection fallback.
/// </para>
/// <para>
/// The canonical document below is meant to be diffed against the TypeScript and Python
/// SDKs' output for the same capability object.
/// </para>
/// </remarks>
public sealed class AgentCapabilitiesWireContractTest
{
    /// <summary>
    /// The exact bytes <see cref="BuildFullyPopulated"/> serializes to. Every group is
    /// populated so that no key can go missing unnoticed; key order is the declaration
    /// order of the generated types.
    /// </summary>
    private const string CanonicalJson =
        """{"identity":{"name":"TestAgent","type":"ag-ui-dotnet","description":"A test agent","version":"1.0.0","provider":"TestOrg","documentationUrl":"https://example.com/docs","metadata":{"region":"eu-central-1","tier":3}},"transport":{"streaming":true,"websocket":false,"httpBinary":true,"pushNotifications":true,"resumable":true},"tools":{"supported":true,"items":[{"name":"search","description":"Search the web","parameters":{}}],"parallelCalls":true,"clientProvided":true},"output":{"structuredOutput":true,"supportedMimeTypes":["text/plain","application/json"]},"state":{"snapshots":true,"deltas":true,"memory":false,"persistentState":true},"multiAgent":{"supported":true,"delegation":true,"handoffs":false,"subagents":[{"name":"helper","description":"A helper agent"}]},"reasoning":{"supported":true,"streaming":true,"encrypted":false},"multimodal":{"input":{"image":true,"audio":false,"video":false,"pdf":true,"file":true},"output":{"image":true,"audio":false}},"execution":{"codeExecution":true,"sandboxed":true,"maxIterations":10,"maxExecutionTime":30000},"humanInTheLoop":{"supported":true,"approvals":true,"interventions":false,"feedback":true,"interrupts":true,"approveWithEdits":true},"custom":{"rateLimit":42}}""";

    /// <summary>
    /// Every wire key whose spelling differs from a naive camel-casing of the C# property
    /// name, or that is new in the generated surface, plus the two container keys that
    /// have historically been mis-cased.
    /// </summary>
    private static readonly string[] LoadBearingWireKeys =
    [
        "documentationUrl",
        "httpBinary",
        "pushNotifications",
        "structuredOutput",
        "supportedMimeTypes",
        "persistentState",
        "parallelCalls",
        "clientProvided",
        "codeExecution",
        "maxIterations",
        "maxExecutionTime",
        "approveWithEdits",
        "multiAgent",
        "humanInTheLoop",
        "subagents",
        "metadata",
        "custom",
    ];

    private static AgentCapabilities BuildFullyPopulated() => new()
    {
        Identity = new IdentityCapabilities
        {
            Name = "TestAgent",
            Type = "ag-ui-dotnet",
            Description = "A test agent",
            Version = "1.0.0",
            Provider = "TestOrg",
            DocumentationUrl = "https://example.com/docs",
            Metadata = ParseElement("""{"region":"eu-central-1","tier":3}"""),
        },
        Transport = new TransportCapabilities
        {
            Streaming = true,
            Websocket = false,
            HttpBinary = true,
            PushNotifications = true,
            Resumable = true,
        },
        Tools = new ToolsCapabilities
        {
            Supported = true,
            Items =
            [
                new AGUITool
                {
                    Name = "search",
                    Description = "Search the web",
                    Parameters = ParseElement("{}"),
                },
            ],
            ParallelCalls = true,
            ClientProvided = true,
        },
        Output = new OutputCapabilities
        {
            StructuredOutput = true,
            SupportedMimeTypes = ["text/plain", "application/json"],
        },
        State = new StateCapabilities
        {
            Snapshots = true,
            Deltas = true,
            Memory = false,
            PersistentState = true,
        },
        MultiAgent = new MultiAgentCapabilities
        {
            Supported = true,
            Delegation = true,
            Handoffs = false,
            Subagents = [new SubagentInfo { Name = "helper", Description = "A helper agent" }],
        },
        Reasoning = new ReasoningCapabilities
        {
            Supported = true,
            Streaming = true,
            Encrypted = false,
        },
        Multimodal = new MultimodalCapabilities
        {
            Input = new MultimodalInputCapabilities
            {
                Image = true,
                Audio = false,
                Video = false,
                Pdf = true,
                File = true,
            },
            Output = new MultimodalOutputCapabilities { Image = true, Audio = false },
        },
        Execution = new ExecutionCapabilities
        {
            CodeExecution = true,
            Sandboxed = true,
            MaxIterations = 10,
            MaxExecutionTime = 30000,
        },
        HumanInTheLoop = new HumanInTheLoopCapabilities
        {
            Supported = true,
            Approvals = true,
            Interventions = false,
            Feedback = true,
            Interrupts = true,
            ApproveWithEdits = true,
        },
        Custom = ParseElement("""{"rateLimit":42}"""),
    };

    private static JsonElement ParseElement(string json) =>
        JsonDocument.Parse(json).RootElement.Clone();

    /// <summary>
    /// Caller-owned options that resolve AG-UI types through the source-generated context.
    /// <see cref="JsonSerializerOptions.TypeInfoResolver"/> is set to the AG-UI resolver and
    /// nothing else, so a type the context does not know about throws instead of silently
    /// falling back to reflection.
    /// </summary>
    private static JsonSerializerOptions AGUIOptions()
    {
        var options = new JsonSerializerOptions { TypeInfoResolver = AGUIJsonUtilities.DefaultTypeInfoResolver };
        options.MakeReadOnly();
        return options;
    }

    [Fact]
    public void FullyPopulated_SerializesToTheCanonicalWireDocument()
    {
        var json = JsonSerializer.Serialize(
            BuildFullyPopulated(),
            AGUIJsonSerializerContext.Default.AgentCapabilities);

        Assert.Equal(CanonicalJson, json);
    }

    [Fact]
    public void FullyPopulated_ThroughAGUIJsonUtilities_MatchesTheContextByteForByte()
    {
        // AGUIJsonUtilities.DefaultTypeInfoResolver is the supported way to compose AG-UI
        // types into caller-owned options; it must produce the same document as serializing
        // straight through the context, otherwise the null-omission rule has been lost.
        var json = JsonSerializer.Serialize(BuildFullyPopulated(), typeof(AgentCapabilities), AGUIOptions());

        Assert.Equal(CanonicalJson, json);
    }

    [Fact]
    public void FullyPopulated_EmitsEveryLoadBearingWireKey()
    {
        var json = JsonSerializer.Serialize(
            BuildFullyPopulated(),
            AGUIJsonSerializerContext.Default.AgentCapabilities);

        using var document = JsonDocument.Parse(json);
        var present = new HashSet<string>(StringComparer.Ordinal);
        CollectPropertyNames(document.RootElement, present);

        foreach (var key in LoadBearingWireKeys)
        {
            Assert.Contains(key, present);
        }
    }

    [Fact]
    public void UnsetMembers_AreOmittedRatherThanWrittenAsNull()
    {
        // Only two leaves are set; everything else must vanish from the document rather
        // than appear as null, which is what the other SDKs reject.
        var sparse = new AgentCapabilities
        {
            Identity = new IdentityCapabilities { Name = "sparse" },
            MultiAgent = new MultiAgentCapabilities { Supported = true },
        };

        var json = JsonSerializer.Serialize(sparse, AGUIJsonSerializerContext.Default.AgentCapabilities);

        Assert.Equal("""{"identity":{"name":"sparse"},"multiAgent":{"supported":true}}""", json);
        Assert.DoesNotContain("null", json, StringComparison.Ordinal);

        using var document = JsonDocument.Parse(json);
        Assert.Empty(FindNullValuedProperties(document.RootElement));
    }

    [Fact]
    public void CanonicalDocument_RoundTripsBackToAnEquivalentObject()
    {
        var result = JsonSerializer.Deserialize(
            CanonicalJson,
            AGUIJsonSerializerContext.Default.AgentCapabilities);

        Assert.NotNull(result);

        // Re-serializing the deserialized object reproduces the same bytes: nothing was
        // dropped on the way in and nothing was invented on the way out.
        var reserialized = JsonSerializer.Serialize(result, AGUIJsonSerializerContext.Default.AgentCapabilities);
        Assert.Equal(CanonicalJson, reserialized);

        // Spot-check the members that are new or renamed in the generated surface.
        Assert.Equal("eu-central-1", result.Identity!.Metadata!.Value.GetProperty("region").GetString());
        Assert.Equal(3, result.Identity.Metadata!.Value.GetProperty("tier").GetInt32());
        Assert.Equal(42, result.Custom!.Value.GetProperty("rateLimit").GetInt32());
        var subagent = Assert.Single(result.MultiAgent!.Subagents!);
        Assert.Equal("helper", subagent.Name);
        Assert.Equal("A helper agent", subagent.Description);
        Assert.Equal(10L, result.Execution!.MaxIterations);
        Assert.Equal(30000L, result.Execution.MaxExecutionTime);
        Assert.True(result.HumanInTheLoop!.ApproveWithEdits);
    }

    [Fact]
    public void LegacySubAgentsKey_IsIgnored_NotMappedOntoSubagents()
    {
        // Clean break: the pre-1.0 .NET SDK spelled this key "subAgents" and there is
        // deliberately no back-compat alias. System.Text.Json ignores unknown members by
        // default, so a producer still sending the old key silently loses the subagent
        // list rather than erroring — assert that actual behaviour so a future change to
        // JsonUnmappedMemberHandling.Disallow shows up here as a failing test rather than
        // as a surprise in the field.
        var legacy = """
        {"multiAgent":{"supported":true,"subAgents":[{"name":"helper","description":"A helper agent"}]}}
        """;

        var result = JsonSerializer.Deserialize(legacy, AGUIJsonSerializerContext.Default.AgentCapabilities);

        Assert.NotNull(result);
        Assert.True(result.MultiAgent!.Supported);
        Assert.Null(result.MultiAgent.Subagents);

        // The current-spelling key does populate it, so the assertion above is about the
        // key name and not about the property being unreadable.
        var current = """
        {"multiAgent":{"supported":true,"subagents":[{"name":"helper","description":"A helper agent"}]}}
        """;

        var currentResult = JsonSerializer.Deserialize(current, AGUIJsonSerializerContext.Default.AgentCapabilities);

        Assert.Equal("helper", Assert.Single(currentResult!.MultiAgent!.Subagents!).Name);
    }

    private static void CollectPropertyNames(JsonElement element, HashSet<string> into)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                foreach (var property in element.EnumerateObject())
                {
                    into.Add(property.Name);
                    CollectPropertyNames(property.Value, into);
                }

                break;

            case JsonValueKind.Array:
                foreach (var item in element.EnumerateArray())
                {
                    CollectPropertyNames(item, into);
                }

                break;
        }
    }

    private static List<string> FindNullValuedProperties(JsonElement element)
    {
        var found = new List<string>();
        Walk(element, string.Empty, found);
        return found;

        static void Walk(JsonElement current, string path, List<string> found)
        {
            switch (current.ValueKind)
            {
                case JsonValueKind.Null:
                    found.Add(path);
                    break;

                case JsonValueKind.Object:
                    foreach (var property in current.EnumerateObject())
                    {
                        Walk(property.Value, $"{path}/{property.Name}", found);
                    }

                    break;

                case JsonValueKind.Array:
                    var index = 0;
                    foreach (var item in current.EnumerateArray())
                    {
                        Walk(item, $"{path}/{index++}", found);
                    }

                    break;
            }
        }
    }
}
