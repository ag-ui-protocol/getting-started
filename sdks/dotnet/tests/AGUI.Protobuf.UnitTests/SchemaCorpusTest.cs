using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using AGUI.Abstractions;
using Xunit;
using Proto = AGUI.ProtocolBuffers;

namespace AGUI.Protobuf.UnitTests;

/// <summary>
/// The fixture corpus is the behavioural contract, and the binary transport
/// must carry the same protocol as the JSON path: every valid event fixture
/// round-trips through encode/decode to the same materialised event. The
/// committed TypeScript byte fixtures prove cross-runtime readability in one
/// direction; the .NET byte fixtures written here prove the other.
/// </summary>
public sealed class SchemaCorpusTest
{
    private static readonly JsonSerializerOptions s_options = AGUIJsonSerializerContext.Default.Options;

    private static string RepoRoot([CallerFilePath] string path = "")
        => Path.GetFullPath(Path.Combine(Path.GetDirectoryName(path)!, "..", "..", "..", ".."));

    private static readonly string s_fixturesDir =
        Path.Combine(RepoRoot(), "spec", "draft", "fixtures");

    private static readonly string s_typeScriptBytesDir = Path.Combine(
        RepoRoot(), "sdks", "typescript", "packages", "proto", "__tests__", "__fixtures__", "bytes");

    private static string DotnetBytesDir([CallerFilePath] string path = "")
        => Path.Combine(Path.GetDirectoryName(path)!, "Fixtures", "bytes-dotnet");

    public static TheoryData<string, string> ValidEventFixtures()
    {
        var data = new TheoryData<string, string>();
        foreach (var anchorDir in Directory.GetDirectories(s_fixturesDir).OrderBy(d => d))
        {
            var anchor = Path.GetFileName(anchorDir);
            if (!anchor.EndsWith("Event", StringComparison.Ordinal))
            {
                continue;
            }

            var valid = Path.Combine(anchorDir, "valid");
            if (!Directory.Exists(valid))
            {
                continue;
            }

            foreach (var file in Directory.GetFiles(valid, "*.json").OrderBy(f => f))
            {
                data.Add(anchor, file);
            }
        }

        return data;
    }

    private static BaseEvent ParseFixture(string path)
    {
        var json = File.ReadAllText(path);
        return JsonSerializer.Deserialize<BaseEvent>(json, s_options)
            ?? throw new InvalidOperationException($"fixture {path} deserialised to null");
    }

    private static JsonNode? ToNode(BaseEvent evt)
    {
        var node = JsonNode.Parse(JsonSerializer.Serialize(evt, s_options));
        // The .NET JSON models collapse an explicit null into an absent
        // property on re-serialisation (JsonElement? deserialises JSON null to
        // C# null, and nulls are not written), while the binary decoders
        // materialise a wire null as a null-kind JsonElement. Both mean the
        // same thing to the models, so the comparison treats a root-level
        // null as absent.
        if (node is JsonObject obj)
        {
            foreach (var key in obj.Where(pair => pair.Value is null).Select(pair => pair.Key).ToList())
            {
                obj.Remove(key);
            }
        }

        return node;
    }

    /// <summary>
    /// The wire cannot distinguish an absent repeated field from an empty
    /// one, so decoding always materialises the optional RunAgentInput lists
    /// — the same recorded normalisation the TypeScript byte tests carry.
    /// </summary>
    private static void MaterialiseWireArrays(BaseEvent evt)
    {
        if (evt is RunStartedEvent { Input: { } input })
        {
            input.Tools ??= [];
            input.Resume ??= [];
            input.Context ??= [];
        }
    }

    [Theory]
    [MemberData(nameof(ValidEventFixtures))]
    public void ValidFixture_RoundTripsOverTheBinaryTransport(string anchor, string path)
    {
        var expected = ParseFixture(path);
        var decoded = AGUIProtobuf.Decode(AGUIProtobuf.Encode(expected));
        MaterialiseWireArrays(expected);
        Assert.True(
            JsonNode.DeepEquals(ToNode(expected), ToNode(decoded)),
            $"{Path.GetFileName(path)}: binary round trip changed the event.\nexpected: {JsonSerializer.Serialize(expected, s_options)}\nactual:   {JsonSerializer.Serialize(decoded, s_options)}");
    }

    [Theory]
    [MemberData(nameof(ValidEventFixtures))]
    public void TypeScriptBytes_AreReadable(string anchor, string path)
    {
        var name = $"{anchor}__{Path.GetFileName(path)}.bin";
        var bytesPath = Path.Combine(s_typeScriptBytesDir, name);

        // TypeScript writes bytes for the complete corpus, so a missing file
        // is a broken path or a stale checkout — never a silent skip.
        Assert.True(
            File.Exists(bytesPath),
            $"{bytesPath} missing — regenerate with WRITE_PROTO_BYTE_FIXTURES=1 in the proto package");

        var bytes = File.ReadAllBytes(bytesPath);
        var decoded = AGUIProtobuf.Decode(bytes);

        // The TS bytes carry the TS materialisation (its validation applies
        // the schema-documented defaults); normalise the .NET expectation the
        // same way before comparing.
        var expected = ParseFixture(path);
        MaterialiseWireArrays(expected);
        if (expected is TextMessageStartEvent start && start.Role.Length == 0)
        {
            start.Role = "assistant";
        }

        if (expected is ActivitySnapshotEvent snapshot)
        {
            snapshot.Replace ??= true;
        }

        Assert.True(
            JsonNode.DeepEquals(ToNode(expected), ToNode(decoded)),
            $"{name}: TypeScript bytes decoded to a different event.\nexpected: {JsonSerializer.Serialize(expected, s_options)}\nactual:   {JsonSerializer.Serialize(decoded, s_options)}");
    }

    [Theory]
    [MemberData(nameof(ValidEventFixtures))]
    public void DotnetBytes_MatchTheCommittedFixtures(string anchor, string path)
    {
        var bytes = AGUIProtobuf.Encode(ParseFixture(path));
        var name = $"{anchor}__{Path.GetFileName(path)}.bin";
        var bytesPath = Path.Combine(DotnetBytesDir(), name);

        if (Environment.GetEnvironmentVariable("AGUI_WRITE_PROTO_BYTE_FIXTURES") == "1")
        {
            Directory.CreateDirectory(DotnetBytesDir());
            File.WriteAllBytes(bytesPath, bytes);
            return;
        }

        Assert.True(
            File.Exists(bytesPath),
            $"{bytesPath} missing — run with AGUI_WRITE_PROTO_BYTE_FIXTURES=1");
        Assert.Equal(File.ReadAllBytes(bytesPath), bytes);
    }

    [Fact]
    public void NoStaleDotnetByteFixtures()
    {
        if (!Directory.Exists(DotnetBytesDir()))
        {
            return;
        }

        var expected = new HashSet<string>();
        foreach (var anchorDir in Directory.GetDirectories(s_fixturesDir))
        {
            var anchor = Path.GetFileName(anchorDir);
            if (!anchor.EndsWith("Event", StringComparison.Ordinal))
            {
                continue;
            }

            var valid = Path.Combine(anchorDir, "valid");
            if (!Directory.Exists(valid))
            {
                continue;
            }

            foreach (var file in Directory.GetFiles(valid, "*.json"))
            {
                expected.Add($"{anchor}__{Path.GetFileName(file)}.bin");
            }
        }

        var stale = Directory.GetFiles(DotnetBytesDir())
            .Select(Path.GetFileName)
            .Where(name => !expected.Contains(name!))
            .ToList();
        Assert.Empty(stale);
    }
}
