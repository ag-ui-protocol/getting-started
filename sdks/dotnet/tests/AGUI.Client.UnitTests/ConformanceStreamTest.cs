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
/// Runs the conformance lane on its own, with nothing else in this assembly
/// running beside it.
/// </summary>
/// <remarks>
/// <see cref="Trace.Listeners"/> is a process-global collection: there is no
/// per-test, per-thread or per-async-context scope in the Trace API to attach a
/// listener to. A test class running concurrently with this one would therefore
/// have its trace output captured as if a fixture had produced it. Taking the
/// collection out of the parallel pool is the tightest scope the API allows —
/// and it is why the listener additionally filters on the SDK's own
/// <c>[ag-ui]</c> prefix, so the residual risk is bounded to code that both runs
/// concurrently and impersonates the SDK's message prefix.
/// </remarks>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class ConformanceStreamCollection
{
    public const string Name = "conformance-streams";
}

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
[Collection(ConformanceStreamCollection.Name)]
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

        /// <summary>
        /// The AG-UI event types that reached application code, in order.
        /// </summary>
        /// <remarks>
        /// Read off each <see cref="ChatResponseUpdate.RawRepresentation"/>,
        /// which is the only place a consumer of the .NET client sees the
        /// underlying event. That is a narrower window than the TypeScript
        /// client's subscriber, which is handed every event: the builder-only
        /// events — TEXT_MESSAGE_START and TEXT_MESSAGE_END among them — update
        /// converter state and yield no update, so they are legitimately missing
        /// here even though the client processed them. A fixture whose
        /// `eventTypes` names one of those needs a dotnet override saying so;
        /// `eventTypesAbsent` is the weaker and safer key on this lane.
        ///
        /// `eventPaths` and `eventAbsentPaths` index into this same list, so a
        /// fixture that numbers its paths against the TypeScript delivery order
        /// needs its indices restated in a dotnet override — and where the index
        /// names a builder-only event, restating it is impossible: there is no
        /// index for an event that produced no update.
        /// </remarks>
        public List<string> EventTypes { get; } = [];

        /// <summary>
        /// The same delivered events as <see cref="EventTypes"/>, index for
        /// index, re-serialized to JSON so `eventPaths` and `eventAbsentPaths`
        /// can be read off them.
        /// </summary>
        /// <remarks>
        /// Re-serialized rather than kept as the fixture's own JSON on purpose:
        /// what a fixture asserts about a delivered event is what the CLIENT
        /// hands the application, and on this lane that is a typed model. Echoing
        /// the wire bytes back would assert nothing about the client at all —
        /// every `eventAbsentPaths` entry would fail and every `eventPaths` entry
        /// would pass whatever the models did with the payload.
        ///
        /// The round trip is faithful in the directions these keys care about:
        /// AG-UI types omit a property that has no value (see
        /// AGUIJsonUtilities), so an absent member stays absent rather than
        /// reappearing as an explicit null, and the open-by-design members —
        /// `delta`, `snapshot`, `metadata`, `rawEvent`, `value` — are held as
        /// <see cref="JsonElement"/> and come back verbatim.
        /// </remarks>
        public JsonArray Events { get; } = [];

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
                if (update.RawRepresentation is BaseEvent delivered)
                {
                    result.EventTypes.Add(delivered.Type);
                    result.Events.Add(JsonSerializer.SerializeToNode(
                        delivered, s_options.GetTypeInfo(typeof(BaseEvent))));
                }

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

        // ContainsKey, not a null test on the node. The schema leaves
        // forwardedProps as any JSON value, null included, and JsonNode
        // represents an absent key and an explicit JSON null identically — so
        // reading the node turned a fixture that deliberately forwards `null`
        // into one that forwards nothing at all, which is a different request
        // on the wire and the opposite of what such a fixture states. Asking
        // the object for the key is the only way to keep the two apart.
        if (fixtureInput.ContainsKey("forwardedProps"))
        {
            using var forwarded = JsonDocument.Parse(
                fixtureInput["forwardedProps"]?.ToJsonString() ?? "null");
            // Cloned because the JsonElement outlives the document it is read
            // from; a null value clones to a JsonValueKind.Null element, which
            // the property then writes as an explicit null.
            input.ForwardedProperties = forwarded.RootElement.Clone();
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

        if (expectation["eventTypes"] is JsonArray expectedEventTypes)
        {
            var expectedTypes = expectedEventTypes.Select(type => (string?)type ?? string.Empty).ToList();
            Assert.True(
                expectedTypes.SequenceEqual(result.EventTypes, StringComparer.Ordinal),
                $"[{name}] the events delivered to application code did not match:"
                + $"\nexpected [{string.Join(", ", expectedTypes)}]"
                + $"\nactual [{string.Join(", ", result.EventTypes)}]" + context);
        }

        if (expectation["eventTypesAbsent"] is JsonArray absentEventTypes)
        {
            foreach (var absent in absentEventTypes)
            {
                var type = (string?)absent ?? string.Empty;
                Assert.False(
                    result.EventTypes.Contains(type, StringComparer.Ordinal),
                    $"[{name}] {type} must not reach application code; delivered: "
                    + (result.EventTypes.Count == 0 ? "(none)" : string.Join(", ", result.EventTypes)));
            }
        }

        // Keyed "<index>.<dotted path>" into the delivered events, the same list
        // `eventTypes` is built from — so an index here means the same event it
        // means there. Mirrors pathExists + readPath in the TypeScript runner.
        if (expectation["eventPaths"] is JsonObject eventPaths)
        {
            foreach (var (path, expectedValue) in eventPaths)
            {
                Assert.True(
                    PathExists(result.Events, path),
                    $"[{name}] {path} must exist in the events delivered to application code: "
                    + result.Events.ToJsonString() + context);
                var actual = ReadPath(result.Events, path);
                Assert.True(
                    JsonNode.DeepEquals(actual, expectedValue),
                    $"[{name}] the delivered event at {path} did not match:"
                    + $"\nexpected {expectedValue?.ToJsonString() ?? "null"}"
                    + $"\nactual {actual?.ToJsonString() ?? "null"}" + context);
            }
        }

        if (expectation["eventAbsentPaths"] is JsonArray eventAbsentPaths)
        {
            foreach (var absent in eventAbsentPaths)
            {
                var path = (string?)absent ?? string.Empty;
                Assert.False(
                    PathExists(result.Events, path),
                    $"[{name}] {path} must NOT exist in the events delivered to application code — "
                    + "an explicit null is still the member being delivered: "
                    + result.Events.ToJsonString() + context);
            }
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
                Assert.False(
                    PathExists(result.Request, path),
                    $"[{name}] {path} must be absent from the request the client sent — "
                    + "an explicit null is still the member being sent: "
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
    /// <remarks>
    /// "Present" is checked by asking the object for the key, not by reading it:
    /// an absent property and one written as JSON <c>null</c> both read back as
    /// a null <see cref="JsonNode"/>, so reading would have let an expected
    /// <c>null</c> be satisfied by a key the client never sent — the opposite of
    /// what naming the key means.
    /// </remarks>
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
                    actualObject.TryGetPropertyValue(entry.Key, out var value)
                    && MatchesSubset(value, entry.Value));
        }

        if (expected is null)
        {
            return actual is null;
        }

        return actual is not null && JsonNode.DeepEquals(actual, expected);
    }

    /// <summary>JSON-quotes a string for a failure message.</summary>
    private static string Quote(string? value) => JsonValue.Create(value)?.ToJsonString() ?? "null";

    /// <summary>
    /// Whether a dot/index path exists at all — in the sent request, or in the
    /// delivered events.
    /// </summary>
    /// <remarks>
    /// Presence, not value: a member written as JSON <c>null</c> is present. It
    /// has to be, because <c>requestAbsentPaths</c> says a peer that predates a
    /// field never receives that member — and a peer sent
    /// <c>"protocolVersion": null</c> has received it, whatever the value is.
    /// Returning the node would have made the two indistinguishable, since
    /// <see cref="JsonNode"/> represents an absent key and a JSON null the same
    /// way. <c>eventAbsentPaths</c> turns on exactly the same distinction: a
    /// client that "removed" a property by nulling it has not removed it.
    /// </remarks>
    private static bool PathExists(JsonNode? node, string path)
    {
        foreach (var segment in path.Split('.'))
        {
            switch (node)
            {
                case JsonObject obj when obj.ContainsKey(segment):
                    node = obj[segment];
                    break;
                case JsonArray array when int.TryParse(segment, NumberStyles.Integer, CultureInfo.InvariantCulture, out var index)
                    && index >= 0 && index < array.Count:
                    node = array[index];
                    break;
                default:
                    return false;
            }
        }

        return true;
    }

    /// <summary>
    /// The value at a dot/index path, or null when the path does not resolve.
    /// Only meaningful once <see cref="PathExists"/> has said the path is there,
    /// which is why the two are always called as a pair.
    /// </summary>
    private static JsonNode? ReadPath(JsonNode? node, string path)
    {
        foreach (var segment in path.Split('.'))
        {
            node = node switch
            {
                JsonObject obj => obj[segment],
                JsonArray array when int.TryParse(segment, NumberStyles.Integer, CultureInfo.InvariantCulture, out var index)
                    && index >= 0 && index < array.Count => array[index],
                _ => null,
            };

            if (node is null)
            {
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
    /// <remarks>
    /// <para>
    /// Only <see cref="TraceEventType.Warning"/> is recorded. An error trace is
    /// not a warning, and treating it as one made `noWarnings` — the assertion
    /// that a conformant stream leaves a client quiet — fail on trace output
    /// that says nothing about the client's tolerance.
    /// </para>
    /// <para>
    /// <see cref="Trace.Listeners"/> has no narrower scope than the process, so
    /// this listener also sees whatever else traces while it is attached. Two
    /// things bound that: the lane runs in a collection that is excluded from
    /// parallelization (see <see cref="ConformanceStreamCollection"/>), so
    /// nothing else in this assembly is running; and only messages carrying the
    /// SDK's own <c>[ag-ui]</c> prefix are recorded. What remains uncovered is
    /// trace output from a background thread this test never started that also
    /// writes that prefix — accepted, because the Trace API offers no way to
    /// attribute an event to the code that raised it.
    /// </para>
    /// </remarks>
    private sealed class WarningTraceListener : TraceListener
    {
        /// <summary>The prefix every warning the AG-UI SDK emits starts with.</summary>
        private const string AGUIPrefix = "[ag-ui]";

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
            if (eventType != TraceEventType.Warning
                || message is null
                || !message.Contains(AGUIPrefix, StringComparison.Ordinal))
            {
                return;
            }

            lock (_warnings)
            {
                _warnings.Add(message);
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
