using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Client.UnitTests;

/// <summary>
/// The .NET conformance lane: every shared fixture stream in
/// <c>spec/draft/conformance/streams</c>, replayed as raw SSE bytes into the
/// real consumer — the SSE formatter, the sequence verifier and the
/// chunk/message assembly in <see cref="EventStreamConverter"/> — and asserted
/// against the outcome the specification requires.
/// </summary>
/// <remarks>
/// The same files drive the TypeScript lane. Where the two clients legitimately
/// differ, the fixture carries an <c>expectOverrides.dotnet</c> block whose
/// keys replace the base ones here; the reason lives in that block's
/// <c>intentional</c> field, so a divergence is never silent.
///
/// The events are written to the response body verbatim from the fixture JSON,
/// never round-tripped through the typed models: the point of many fixtures is
/// to send a shape the models reject, which a typed round-trip would repair
/// before the client ever saw it.
/// </remarks>
public sealed class ConformanceStreamTest
{
    private static readonly JsonSerializerOptions s_options = AGUIJsonSerializerContext.Default.Options;

    // Walked up from the test binary rather than taken from [CallerFilePath]:
    // CI turns on deterministic source paths, which rewrite a caller path to
    // "/_/..." — a directory that exists on no machine. Same reason as
    // SchemaCorpusTest.RepoRoot.
    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null &&
               !Directory.Exists(Path.Combine(dir.FullName, "spec", "draft", "conformance", "streams")))
        {
            dir = dir.Parent;
        }

        return dir?.FullName
            ?? throw new DirectoryNotFoundException(
                $"No repository root above '{AppContext.BaseDirectory}' carries spec/draft/conformance/streams.");
    }

    private static readonly string s_streamsDir =
        Path.Combine(RepoRoot(), "spec", "draft", "conformance", "streams");

    public static TheoryData<string> Fixtures()
    {
        var data = new TheoryData<string>();
        foreach (var path in Directory.GetFiles(s_streamsDir, "*.json").OrderBy(p => p, StringComparer.Ordinal))
        {
            data.Add(Path.GetFileNameWithoutExtension(path));
        }

        return data;
    }

    [Fact]
    public void HasFixturesToRun()
    {
        Assert.NotEmpty(Directory.GetFiles(s_streamsDir, "*.json"));
    }

    [Theory]
    [MemberData(nameof(Fixtures))]
    public async Task Fixture(string name)
    {
        var path = Path.Combine(s_streamsDir, name + ".json");
        var fixture = JsonNode.Parse(File.ReadAllText(path))?.AsObject()
            ?? throw new InvalidOperationException($"Fixture '{name}' is not a JSON object.");

        Assert.Equal(name, (string?)fixture["name"]);

        var result = await ReplayAsync(fixture);
        AssertExpectation(name, result, ResolveExpectation(fixture));
    }

    // ────────────────────────────────────────────────
    // Expectation resolution
    // ────────────────────────────────────────────────

    /// <summary>
    /// The base expectation with this lane's overrides applied: a key the
    /// override names replaces the same key in <c>expect</c>, everything else
    /// still applies. Mirrors resolveExpectation in fixture.ts.
    /// </summary>
    private static JsonObject ResolveExpectation(JsonObject fixture)
    {
        var resolved = fixture["expect"]?.AsObject().DeepClone().AsObject() ?? new JsonObject();
        if (fixture["expectOverrides"]?["dotnet"] is not JsonObject dotnet)
        {
            return resolved;
        }

        Assert.False(
            string.IsNullOrWhiteSpace((string?)dotnet["intentional"]),
            "a dotnet override must state why the divergence is deliberate");

        foreach (var (key, value) in dotnet)
        {
            if (key == "intentional")
            {
                continue;
            }

            resolved[key] = value?.DeepClone();
        }

        return resolved;
    }

    // ────────────────────────────────────────────────
    // Replay
    // ────────────────────────────────────────────────

    private sealed class ReplayResult
    {
        public string Outcome { get; set; } = "completed";
        public string? Error { get; set; }
        public List<string> Warnings { get; } = [];
        public JsonArray Messages { get; set; } = [];
        public JsonNode? Request { get; set; }

        /// <summary>
        /// The failures the run reported itself, through RUN_ERROR. Distinct
        /// from <see cref="Error"/>, which is the client refusing the stream.
        /// </summary>
        public List<string> RunErrors { get; } = [];

        /// <summary>
        /// Parts of a fixture's input the .NET models cannot represent, so the
        /// run was started without them. Reported in an assertion failure
        /// because it changes what the request assertions can mean.
        /// </summary>
        public List<string> UnrepresentableInput { get; } = [];
    }

    private static async Task<ReplayResult> ReplayAsync(JsonObject fixture)
    {
        var result = new ReplayResult();

        var stream = fixture["stream"]?.AsArray() ?? [];
        var body = new StringBuilder();
        foreach (var evt in stream)
        {
            // Verbatim: these are the bytes a producer would have sent,
            // including the ones no conforming producer would.
            body.Append(CultureInfo.InvariantCulture, $"data: {evt?.ToJsonString() ?? "null"}\n\n");
        }

        string? requestBody = null;
        var handler = new TestDelegatingHandler(async (request, cancellationToken) =>
        {
            if (request.Content is not null)
            {
                requestBody = await request.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            }

            return new HttpResponseMessage
            {
                StatusCode = HttpStatusCode.OK,
                Content = new StringContent(body.ToString(), Encoding.UTF8, "text/event-stream"),
            };
        });

        using var httpClient = new HttpClient(handler);
        var transport = new AGUIHttpTransport(httpClient, "http://localhost/agent");
        var input = BuildInput(fixture, result);

        var listener = new WarningTraceListener(result.Warnings);
        Trace.Listeners.Add(listener);
        try
        {
            var updates = new List<ChatResponseUpdate>();
            try
            {
                await foreach (var update in EventStreamConverter
                    .AsChatResponseUpdates(transport.SendAsync(input, CancellationToken.None), s_options)
                    .ConfigureAwait(false))
                {
                    updates.Add(update);
                }
            }
            catch (Exception thrown)
            {
                result.Outcome = "failed";
                result.Error = thrown.Message;
            }

            // A producer-sent RUN_ERROR is a well-formed stream the client
            // accepts: EventStreamConverter reports it as an ErrorContent
            // update rather than throwing, which is the .NET surface for "the
            // run reported its own failure".
            foreach (var update in updates)
            {
                if (update.RawRepresentation is RunErrorEvent runError)
                {
                    foreach (var error in update.Contents.OfType<ErrorContent>())
                    {
                        result.RunErrors.Add(error.Message ?? runError.Message ?? string.Empty);
                    }
                }
            }

            // Projected through the SDK's own AsAGUIMessages, which is how a
            // consumed run is handed back to the producer on the next turn.
            // That is the .NET surface comparable to the TypeScript client's
            // `agent.messages`, and it is the AG-UI wire shape the fixtures
            // state their expectations in.
            result.Messages = ProjectMessages(updates);
        }
        finally
        {
            Trace.Listeners.Remove(listener);
        }

        result.Request = requestBody is null ? null : JsonNode.Parse(requestBody);
        return result;
    }

    private static JsonArray ProjectMessages(List<ChatResponseUpdate> updates)
    {
        var projected = new JsonArray();
        if (updates.Count == 0)
        {
            return projected;
        }

        var response = updates.ToChatResponse();

        // Only the messages the conversation actually holds. Every AG-UI event
        // the converter passes through — RUN_STARTED, RAW, CUSTOM, STATE_*,
        // ACTIVITY_*, SUBAGENT_* — becomes a content-free assistant update, and
        // ToChatResponse coalesces those into a placeholder ChatMessage that
        // carries no message material at all. RUN_ERROR adds an ErrorContent,
        // which is protocol signalling rather than something the agent said.
        // Neither is a message in the TypeScript client's `agent.messages`
        // either, so counting them here would compare unlike things.
        var held = response.Messages.Where(message => message.Contents.Any(IsMessageMaterial));

        foreach (var message in held.AsAGUIMessages(s_options))
        {
            projected.Add(JsonSerializer.SerializeToNode(message, s_options.GetTypeInfo(typeof(AGUIMessage))));
        }

        return projected;
    }

    private static bool IsMessageMaterial(AIContent content) =>
        content is TextContent or TextReasoningContent or FunctionCallContent
            or FunctionResultContent or DataContent or UriContent;

    /// <summary>
    /// The RunAgentInput the run starts from. A fixture's input is stated in
    /// the wire shape, so anything the .NET models cannot represent is recorded
    /// rather than silently dropped.
    /// </summary>
    private static RunAgentInput BuildInput(JsonObject fixture, ReplayResult result)
    {
        var opener = fixture["stream"]?.AsArray().FirstOrDefault() as JsonObject;
        var input = new RunAgentInput
        {
            ThreadId = (string?)opener?["threadId"] ?? "conformance-thread",
            RunId = (string?)opener?["runId"] ?? "conformance-run",
        };

        if (fixture["input"] is not JsonObject fixtureInput)
        {
            return input;
        }

        if (fixtureInput["messages"] is JsonArray messages)
        {
            foreach (var message in messages)
            {
                try
                {
                    if (JsonSerializer.Deserialize(
                            message?.ToJsonString() ?? "null",
                            s_options.GetTypeInfo(typeof(AGUIMessage))) is AGUIMessage parsed)
                    {
                        input.Messages.Add(parsed);
                    }
                }
                catch (JsonException thrown)
                {
                    result.UnrepresentableInput.Add($"messages: {thrown.Message}");
                }
            }
        }

        if (fixtureInput["tools"] is JsonArray tools)
        {
            input.Tools = [];
            foreach (var tool in tools)
            {
                try
                {
                    if (JsonSerializer.Deserialize(
                            tool?.ToJsonString() ?? "null",
                            s_options.GetTypeInfo(typeof(AGUITool))) is AGUITool parsed)
                    {
                        input.Tools.Add(parsed);
                    }
                }
                catch (JsonException thrown)
                {
                    result.UnrepresentableInput.Add($"tools: {thrown.Message}");
                }
            }
        }

        if (fixtureInput["context"] is JsonArray context)
        {
            input.Context = [];
            foreach (var entry in context)
            {
                try
                {
                    if (JsonSerializer.Deserialize(
                            entry?.ToJsonString() ?? "null",
                            s_options.GetTypeInfo(typeof(AGUIContext))) is AGUIContext parsed)
                    {
                        input.Context.Add(parsed);
                    }
                }
                catch (JsonException thrown)
                {
                    result.UnrepresentableInput.Add($"context: {thrown.Message}");
                }
            }
        }

        if (fixtureInput["forwardedProps"] is { } forwarded)
        {
            input.ForwardedProperties = (JsonElement?)JsonSerializer.Deserialize(
                forwarded.ToJsonString(), s_options.GetTypeInfo(typeof(JsonElement)));
        }

        return input;
    }

    // ────────────────────────────────────────────────
    // Assertions
    // ────────────────────────────────────────────────

    private static void AssertExpectation(string name, ReplayResult result, JsonObject expectation)
    {
        var context = result.UnrepresentableInput.Count == 0
            ? string.Empty
            : $"\ninput the .NET models rejected: {string.Join("; ", result.UnrepresentableInput)}";

        if ((string?)expectation["outcome"] is { } outcome)
        {
            Assert.True(
                result.Outcome == outcome,
                $"[{name}] expected the run to be {outcome}, it was {result.Outcome}"
                + (result.Error is null ? string.Empty : $" — {result.Error}")
                + context);
        }

        if ((string?)expectation["errorContains"] is { } errorContains)
        {
            Assert.Contains(errorContains, result.Error ?? string.Empty, StringComparison.Ordinal);
        }

        if (expectation["runError"] is JsonValue runErrorValue)
        {
            if (runErrorValue.TryGetValue<bool>(out var anyRunError))
            {
                Assert.True(
                    anyRunError == result.RunErrors.Count > 0,
                    $"[{name}] expected the run {(anyRunError ? "to" : "not to")} report its own failure; saw: "
                    + (result.RunErrors.Count == 0 ? "(none)" : string.Join(", ", result.RunErrors)));
            }
            else
            {
                var substring = runErrorValue.GetValue<string>();
                Assert.True(
                    result.RunErrors.Any(e => e.Contains(substring, StringComparison.Ordinal)),
                    $"[{name}] expected a reported run failure containing {Quote(substring)}; saw: "
                    + (result.RunErrors.Count == 0 ? "(none)" : string.Join(", ", result.RunErrors)));
            }
        }

        if (expectation["warnings"] is JsonArray warnings)
        {
            foreach (var expected in warnings)
            {
                var substring = (string?)expected ?? string.Empty;
                Assert.True(
                    result.Warnings.Any(w => w.Contains(substring, StringComparison.Ordinal)),
                    $"[{name}] expected a warning containing {Quote(substring)}; saw: "
                    + (result.Warnings.Count == 0
                        ? "(none)"
                        : string.Join(", ", result.Warnings.Select(Quote))));
            }
        }

        if ((bool?)expectation["noWarnings"] == true)
        {
            Assert.True(
                result.Warnings.Count == 0,
                $"[{name}] a conformant stream must not make a client complain; saw: "
                + string.Join(", ", result.Warnings.Select(Quote)));
        }

        if ((int?)expectation["messageCount"] is { } messageCount)
        {
            Assert.True(
                result.Messages.Count == messageCount,
                $"[{name}] expected {messageCount} message(s), got {result.Messages.Count}: "
                + result.Messages.ToJsonString() + context);
        }

        if (expectation["messages"] is JsonArray expectedMessages)
        {
            Assert.True(
                MatchesSubset(result.Messages, expectedMessages),
                $"[{name}] messages did not match:\nexpected subset {expectedMessages.ToJsonString()}"
                + $"\nactual {result.Messages.ToJsonString()}" + context);
        }

        // `state` is deliberately not asserted: the .NET client carries no state
        // store. STATE_SNAPSHOT and STATE_DELTA reach a consumer only as
        // RawRepresentation on a pass-through update, and nothing in the SDK
        // reduces them, so there is no reduced state to observe. Reducing them
        // here would test this file rather than the client.

        if (expectation["request"] is JsonObject expectedRequest)
        {
            Assert.True(
                MatchesSubset(result.Request, expectedRequest),
                $"[{name}] the request the client sent did not match:"
                + $"\nexpected subset {expectedRequest.ToJsonString()}"
                + $"\nactual {result.Request?.ToJsonString() ?? "(none)"}" + context);
        }

        if (expectation["requestAbsentPaths"] is JsonArray absentPaths)
        {
            foreach (var absent in absentPaths)
            {
                var path = (string?)absent ?? string.Empty;
                Assert.True(
                    ReadPath(result.Request, path) is null,
                    $"[{name}] {path} must be absent from the request the client sent: "
                    + (result.Request?.ToJsonString() ?? "(none)"));
            }
        }
    }

    /// <summary>
    /// Deep subset match: every key the expectation names must be present and
    /// equal, and keys it does not name are ignored. Expectations state what
    /// the specification requires, not every incidental field a client happens
    /// to carry. Mirrors matchesSubset in the TypeScript runner, arrays
    /// included: an expected array must have the same length as the actual one.
    /// </summary>
    private static bool MatchesSubset(JsonNode? actual, JsonNode? expected)
    {
        if (expected is JsonArray expectedArray)
        {
            if (actual is not JsonArray actualArray || actualArray.Count != expectedArray.Count)
            {
                return false;
            }

            for (var index = 0; index < expectedArray.Count; index++)
            {
                if (!MatchesSubset(actualArray[index], expectedArray[index]))
                {
                    return false;
                }
            }

            return true;
        }

        if (expected is JsonObject expectedObject)
        {
            return actual is JsonObject actualObject
                && expectedObject.All(entry =>
                    MatchesSubset(actualObject.TryGetPropertyValue(entry.Key, out var value) ? value : null, entry.Value));
        }

        if (expected is null)
        {
            return actual is null;
        }

        return actual is not null && JsonNode.DeepEquals(actual, expected);
    }

    /// <summary>JSON-quotes a string for a failure message.</summary>
    private static string Quote(string? value) => JsonValue.Create(value)?.ToJsonString() ?? "null";

    /// <summary>Reads a dot/index path, for asserting a field is absent.</summary>
    private static JsonNode? ReadPath(JsonNode? node, string path)
    {
        foreach (var segment in path.Split('.'))
        {
            switch (node)
            {
                case JsonObject obj when obj.TryGetPropertyValue(segment, out var next):
                    node = next;
                    break;
                case JsonArray array when int.TryParse(segment, NumberStyles.Integer, CultureInfo.InvariantCulture, out var index)
                    && index >= 0 && index < array.Count:
                    node = array[index];
                    break;
                default:
                    return null;
            }
        }

        return node;
    }

    // ────────────────────────────────────────────────
    // Plumbing
    // ────────────────────────────────────────────────

    /// <summary>
    /// The .NET SDK has no logger: its only warnings are
    /// <see cref="Trace.TraceWarning(string)"/> calls, so the `warnings` and
    /// `noWarnings` expectations are read off a listener attached for the
    /// duration of one replay.
    /// </summary>
    private sealed class WarningTraceListener : TraceListener
    {
        private readonly List<string> _warnings;

        public WarningTraceListener(List<string> warnings) => _warnings = warnings;

        public override void Write(string? message)
        {
            // The header a base TraceListener writes around an event; the
            // message itself arrives through TraceEvent below.
        }

        public override void WriteLine(string? message)
        {
        }

        public override void TraceEvent(
            TraceEventCache? eventCache, string source, TraceEventType eventType, int id, string? message)
        {
            Record(eventType, message);
        }

        public override void TraceEvent(
            TraceEventCache? eventCache, string source, TraceEventType eventType, int id, string? format, params object?[]? args)
        {
            Record(
                eventType,
                format is null || args is null
                    ? format
                    : string.Format(CultureInfo.InvariantCulture, format, args));
        }

        private void Record(TraceEventType eventType, string? message)
        {
            if (message is not null && (eventType == TraceEventType.Warning || eventType == TraceEventType.Error))
            {
                lock (_warnings)
                {
                    _warnings.Add(message);
                }
            }
        }
    }

    private sealed class TestDelegatingHandler : DelegatingHandler
    {
        private readonly Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> _handler;

        public TestDelegatingHandler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> handler)
        {
            _handler = handler;
        }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return _handler(request, cancellationToken);
        }
    }
}
