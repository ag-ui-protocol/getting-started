using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using AGUI.Abstractions;
using AGUI.Client;
using AGUI.Formatting;
using AGUI.Protobuf;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.DependencyInjection;
using VerifyTests;
using VerifyXunit;
using Xunit;

namespace AGUI.Server.IntegrationTests;

public abstract class IntegrationTestBase<TEntryPoint> : IClassFixture<WebApplicationFactory<TEntryPoint>>
    where TEntryPoint : class
{
    private readonly WebApplicationFactory<TEntryPoint> _factory;

    protected WebApplicationFactory<TEntryPoint> Factory => _factory;

    protected IntegrationTestBase(WebApplicationFactory<TEntryPoint> factory)
    {
        _factory = factory;
    }

    protected static async Task<List<ChatResponseUpdate>> CollectUpdates(
        AGUIChatClient client, IList<ChatMessage> messages, ChatOptions? options = null)
    {
        var updates = new List<ChatResponseUpdate>();
        await foreach (var update in client.GetStreamingResponseAsync(messages, options).ConfigureAwait(false))
        {
            updates.Add(update);
        }

        return updates;
    }

    protected static string ExtractText(List<ChatResponseUpdate> updates)
    {
        return string.Concat(updates
            .Where(u => !string.IsNullOrEmpty(u.Text))
            .Select(u => u.Text));
    }

    protected static async IAsyncEnumerable<ChatResponseUpdate> EmitEmptyResponse(
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        await Task.CompletedTask.ConfigureAwait(false);
        yield break;
    }

    protected static async IAsyncEnumerable<ChatResponseUpdate> EmitTextResponse(
        string text,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        yield return new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            MessageId = Guid.NewGuid().ToString("N"),
            Contents = [new TextContent(text)]
        };
        await Task.CompletedTask.ConfigureAwait(false);
    }

    protected static async IAsyncEnumerable<ChatResponseUpdate> EmitToolCallResponse(
        string toolCallId, string toolCallName, IDictionary<string, object?>? arguments,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        yield return new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            Contents = [new FunctionCallContent(toolCallId, toolCallName, arguments)],
            FinishReason = ChatFinishReason.ToolCalls
        };
        await Task.CompletedTask.ConfigureAwait(false);
    }

    protected static async IAsyncEnumerable<ChatResponseUpdate> EmitToolCallWithResultResponse(
        string toolCallId, string toolCallName, IDictionary<string, object?>? arguments, object? result,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        yield return new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            Contents = [new FunctionCallContent(toolCallId, toolCallName, arguments)],
            FinishReason = ChatFinishReason.ToolCalls
        };
        yield return new ChatResponseUpdate
        {
            Contents = [new FunctionResultContent(toolCallId, result)]
        };
        await Task.CompletedTask.ConfigureAwait(false);
    }

    protected static AGUITool CreateToolDeclaration(string name, string? description = null)
    {
        return new AGUITool
        {
            Name = name,
            Description = description ?? $"Tool {name}",
            Parameters = System.Text.Json.JsonSerializer.SerializeToElement(new { type = "object" })
        };
    }

    // Per-turn capture object shape produced by the sample tests:
    //   { client: { chatMessages, runAgentInput, events, chatResponseUpdates },
    //     server: { runAgentInput, chatMessages, chatResponseUpdates, events } }
    // The eight capture points are written as one Verify baseline file each, named
    // Turn_{NN}.{CC}.{Request|Response}.{Client|Server}.{AGUI|NET}, so a reviewer can
    // read the full round-trip in order:
    //   01 Request  Client NET   client.chatMessages         (app -> AGUIChatClient)
    //   02 Request  Client AGUI  client.runAgentInput        (client -> wire)
    //   03 Request  Server AGUI  server.runAgentInput        (wire -> endpoint)
    //   04 Request  Server NET   server.chatMessages         (endpoint -> LLM)
    //   05 Response Server NET   server.chatResponseUpdates  (LLM -> endpoint)
    //   06 Response Server AGUI  server.events               (endpoint -> wire)
    //   07 Response Client AGUI  client.events               (wire -> client)
    //   08 Response Client NET   client.chatResponseUpdates  (client -> app)
    private static readonly Regex s_idScrubber = new(
        @"(?<![a-zA-Z_])(chatcmpl-|thread_|run_|call_|msg_|approval_|ficc_)[A-Za-z0-9_]+"
            + @"|\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"
            + @"|\b[0-9a-f]{32}\b",
        RegexOptions.Compiled);

    private static readonly JsonSerializerOptions s_indentedNodeOptions = new() { WriteIndented = true };

    private static readonly (string Cc, string Direction, string Side, string Format, string SideKey, string FieldKey)[] s_capturePoints =
    [
        ("01", "Request",  "Client", "NET",  "client", "chatMessages"),
        ("02", "Request",  "Client", "AGUI", "client", "runAgentInput"),
        ("03", "Request",  "Server", "AGUI", "server", "runAgentInput"),
        ("04", "Request",  "Server", "NET",  "server", "chatMessages"),
        ("05", "Response", "Server", "NET",  "server", "chatResponseUpdates"),
        ("06", "Response", "Server", "AGUI", "server", "events"),
        ("07", "Response", "Client", "AGUI", "client", "events"),
        ("08", "Response", "Client", "NET",  "client", "chatResponseUpdates"),
    ];

    /// <summary>
    /// Writes one Verify baseline file per capture point under
    /// <c>Samples/GettingStarted/baselines/{SampleName}/</c>, splitting the combined
    /// per-turn capture list into the eight <c>{TestMethod}#Turn_{NN}.{CC}.…</c> files
    /// described above (Verify joins the file-name prefix and target name with <c>#</c>).
    /// All capture points are verified in a single call so one run reports every diff.
    /// </summary>
    /// <param name="turns">Per-turn anonymous objects with <c>client</c> and (optionally) <c>server</c> sub-objects.</param>
    /// <param name="testName">The calling test method name (used as the file-name prefix).</param>
    /// <param name="jsonOptions">Serializer options used to render the capture objects.</param>
    protected async Task VerifyCaptures(
        IReadOnlyList<object> turns,
        string testName,
        JsonSerializerOptions jsonOptions)
    {
        var targets = new List<Target>();
        for (var t = 0; t < turns.Count; t++)
        {
            var turnJson = JsonSerializer.Serialize(turns[t], jsonOptions);
            if (JsonNode.Parse(turnJson) is not JsonObject turnNode)
            {
                continue;
            }

            var nn = (t + 1).ToString("D2", CultureInfo.InvariantCulture);
            foreach (var cp in s_capturePoints)
            {
                if (turnNode[cp.SideKey] is not JsonObject sideObj
                    || sideObj[cp.FieldKey] is not { } field)
                {
                    continue;
                }

                var clone = field.DeepClone();
                RemoveMembersRecursive(clone, "createdAt", "totalTokenCount");
                var json = clone.ToJsonString(s_indentedNodeOptions);
                targets.Add(new Target(
                    "json",
                    json,
                    $"Turn_{nn}.{cp.Cc}.{cp.Direction}.{cp.Side}.{cp.Format}"));
            }
        }

        var idMaps = new Dictionary<string, Dictionary<string, int>>(StringComparer.Ordinal);
        var settings = new VerifySettings();
        settings.UseDirectory(GetBaselineDirectory());
        settings.UseFileName(testName);
        settings.DontScrubGuids();
        settings.AddScrubber(builder => ScrubIds(builder, idMaps));

        await Verifier.Verify(targets, settings);
    }

    /// <summary>
    /// Projects a <see cref="ChatOptions"/> into a serializable shape for the NET request
    /// capture points, surfacing the protocol-relevant fields (tools, instructions, and any
    /// additional properties). The internal AG-UI <see cref="RunAgentInput"/> stashed under
    /// <c>AdditionalProperties["agui_input"]</c> is omitted because it is already captured
    /// verbatim at the AGUI request capture points (and would otherwise be circular/huge).
    /// </summary>
    protected static object? DescribeChatOptions(ChatOptions? options)
    {
        if (options is null)
        {
            return null;
        }

        var tools = options.Tools?
            .Select(t => new { type = t.GetType().Name, name = t.Name, description = t.Description })
            .ToList();

        Dictionary<string, object?>? additionalProperties = null;
        if (options.AdditionalProperties is { Count: > 0 })
        {
            foreach (var kvp in options.AdditionalProperties)
            {
                if (kvp.Value is RunAgentInput)
                {
                    continue;
                }

                additionalProperties ??= new Dictionary<string, object?>(StringComparer.Ordinal);
                additionalProperties[kvp.Key] = kvp.Value;
            }
        }

        var hasTools = tools is { Count: > 0 };
        if (options.Instructions is null && !hasTools && additionalProperties is null)
        {
            // Nothing protocol-relevant beyond the (excluded) AG-UI input; omit to avoid noise.
            return null;
        }

        return new
        {
            instructions = options.Instructions,
            tools = hasTools ? tools : null,
            additionalProperties,
        };
    }

    private static void ScrubIds(System.Text.StringBuilder builder, Dictionary<string, Dictionary<string, int>> idMaps)
    {
        var text = builder.ToString();
        builder.Clear();
        builder.Append(s_idScrubber.Replace(text, match =>
        {
            string label;
            string suffix;
            if (match.Groups[1].Success)
            {
                label = match.Groups[1].Value;
                suffix = match.Value[label.Length..];
            }
            else
            {
                // A GUID (hyphenated or 32-char "N" format).
                label = "guid_";
                suffix = match.Value;
            }

            if (!idMaps.TryGetValue(label, out var map))
            {
                map = new Dictionary<string, int>(StringComparer.Ordinal);
                idMaps[label] = map;
            }

            if (!map.TryGetValue(suffix, out var index))
            {
                index = map.Count + 1;
                map[suffix] = index;
            }

            return $"{label}Id_{index}";
        }));
    }

    private string GetSampleName()
    {
        var name = GetType().Name;
        return name.EndsWith("Test", StringComparison.Ordinal)
            ? name[..^"Test".Length]
            : name;
    }

    private string GetBaselineDirectory()
    {
        return Path.Combine(
            AttributeReader.GetProjectDirectory(),
            "Samples",
            "GettingStarted",
            "baselines",
            GetSampleName());
    }

    private string GetFixtureDirectory()
    {
        return Path.Combine(
            AttributeReader.GetProjectDirectory(),
            "Samples",
            "GettingStarted",
            "fixtures",
            GetSampleName());
    }

    /// <summary>
    /// Resolves the recorded <see cref="ChatResponseUpdate"/> replay file for a test under
    /// <c>Samples/GettingStarted/fixtures/{SampleName}/{testName}.recording.json</c>.
    /// </summary>
    protected string GetRecordingPath(string testName)
    {
        return Path.Combine(GetFixtureDirectory(), $"{testName}.recording.json");
    }

    /// <summary>Loads a recorded per-turn <see cref="ChatResponseUpdate"/> sequence, or an empty list if none exists.</summary>
    internal List<List<ChatResponseUpdate>> LoadRecording(string testName, JsonSerializerOptions jsonOptions)
    {
        var path = GetRecordingPath(testName);
        if (!File.Exists(path))
        {
            return [];
        }

        var json = File.ReadAllText(path);
        return JsonSerializer.Deserialize<List<List<ChatResponseUpdate>>>(json, jsonOptions) ?? [];
    }

    /// <summary>Saves the server's captured per-turn <see cref="ChatResponseUpdate"/> sequence as a replay fixture.</summary>
    internal void SaveRecording(string testName, CapturingChatClient server, JsonSerializerOptions jsonOptions)
    {
        var turns = server.Calls.Select(c => c.Updates).ToList();
        var json = JsonSerializer.Serialize(turns, jsonOptions);
        var path = GetRecordingPath(testName);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, json);
    }

    private static void RemoveMembersRecursive(JsonNode? node, params string[] memberNames)
    {
        switch (node)
        {
            case JsonObject obj:
                foreach (var name in memberNames)
                {
                    obj.Remove(name);
                }

                foreach (var property in obj.ToList())
                {
                    RemoveMembersRecursive(property.Value, memberNames);
                }

                break;
            case JsonArray array:
                foreach (var item in array)
                {
                    RemoveMembersRecursive(item, memberNames);
                }

                break;
        }
    }
}

public abstract class IntegrationTestBase : IntegrationTestBase<Program>
{
    protected IntegrationTestBase(WebApplicationFactory<Program> factory)
        : base(factory)
    {
        Environment.SetEnvironmentVariable(
            "ASPNETCORE_TEST_CONTENTROOT_AGUI_HOSTING_ASPNETCORE_INTEGRATIONTESTS",
            AppContext.BaseDirectory);
    }

    protected AGUIChatClient CreateClient(
        Func<IEnumerable<ChatMessage>, ChatOptions?, CancellationToken, IAsyncEnumerable<ChatResponseUpdate>> handler)
    {
        return CreateClient(handler, TransportFormat.Json);
    }

    /// <summary>
    /// Creates an <see cref="AGUIChatClient"/> backed by the test server, negotiating the given
    /// wire <paramref name="format"/>. For <see cref="TransportFormat.Json"/> the client uses the
    /// default SSE transport (no negotiation handler). For <see cref="TransportFormat.Protobuf"/>
    /// an <see cref="AGUIEventStreamHandler"/> advertising <c>[protobuf, sse]</c> is inserted into
    /// the client pipeline, so the request prefers protobuf and the response is decoded
    /// accordingly. The decoded <see cref="ChatResponseUpdate"/> stream is identical either way.
    /// </summary>
    protected AGUIChatClient CreateClient(
        Func<IEnumerable<ChatMessage>, ChatOptions?, CancellationToken, IAsyncEnumerable<ChatResponseUpdate>> handler,
        TransportFormat format)
    {
        var configuredFactory = Factory.WithWebHostBuilder(builder =>
        {
            builder.ConfigureTestServices(services =>
            {
                services.AddSingleton(sp =>
                {
                    var client = new DelegatingStreamingChatClient();
                    client.SetHandler(handler);
                    return client;
                });
            });
        });

        HttpClient httpClient;
        if (format == TransportFormat.Protobuf)
        {
            var streamHandler = new AGUIEventStreamHandler(
                new IAGUIEventStreamFormatter[]
                {
                    new ProtobufEventStreamFormatter(),
                    new SseEventStreamFormatter(),
                });
            httpClient = configuredFactory.CreateDefaultClient(streamHandler);
        }
        else
        {
            httpClient = configuredFactory.CreateClient();
        }

        return new AGUIChatClient(new(httpClient, "/agui"));
    }
}
