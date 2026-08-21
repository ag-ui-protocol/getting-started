using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

/// <summary>
/// Runs <c>sdks/fixtures/null-omission.json</c>, the cross-language fixture the TypeScript
/// and Python SDKs run too. Holding all three to the same file is what makes "the SDKs agree
/// about when a field is omitted" a checked claim rather than three separate beliefs.
/// </summary>
/// <remarks>
/// Each case is deserialized into the .NET event model and written back out through the same
/// type info the SSE formatter and HTTP transport use, then compared to the fixture's
/// <c>expected</c> object. Because the comparison is exact, a stray <c>null</c> fails and a
/// <c>null</c> the contract carries — inside a state snapshot, a JSON Patch value, an
/// interrupt's metadata — has to still be there.
/// </remarks>
public sealed class NullOmissionFixtureTest
{
    public static TheoryData<string> CaseNames()
    {
        var data = new TheoryData<string>();
        foreach (var name in NullOmissionFixture.CaseNames)
        {
            data.Add(name);
        }

        return data;
    }

    [Fact]
    public void FixtureCoversThisSdk()
    {
        Assert.True(
            NullOmissionFixture.CaseNames.Count > 15,
            $"the fixture only has {NullOmissionFixture.CaseNames.Count} case(s) for .NET");
    }

    [Theory]
    [MemberData(nameof(CaseNames))]
    public void CaseReserializesToItsExpectedJson(string caseName)
    {
        var fixtureCase = NullOmissionFixture.Case(caseName);

        var @event = JsonSerializer.Deserialize(
            fixtureCase.Input.GetRawText(),
            AGUIJsonSerializerContext.Default.BaseEvent)!;

        var produced = JsonSerializer.Serialize(
            @event,
            AGUIJsonSerializerContext.Default.BaseEvent);

        Assert.True(
            JsonNode.DeepEquals(JsonNode.Parse(produced), JsonNode.Parse(fixtureCase.Expected.GetRawText())),
            $"case '{caseName}'\nexpected: {fixtureCase.Expected.GetRawText()}\nproduced: {produced}");
    }
}

internal sealed record NullOmissionFixtureCase(string Name, JsonElement Input, JsonElement Expected);

internal static class NullOmissionFixture
{
    private const string ResourceName =
        "AGUI.Abstractions.UnitTests.CrossLanguageFixtures.null-omission.json";

    private const string SdkName = "dotnet";

    private static readonly IReadOnlyDictionary<string, NullOmissionFixtureCase> Cases = Load();

    internal static IReadOnlyList<string> CaseNames { get; } = Cases.Keys.ToList();

    internal static NullOmissionFixtureCase Case(string name) => Cases[name];

    private static IReadOnlyDictionary<string, NullOmissionFixtureCase> Load()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(ResourceName)
            ?? throw new InvalidOperationException($"Embedded resource '{ResourceName}' not found.");
        using var document = JsonDocument.Parse(stream);

        var cases = new Dictionary<string, NullOmissionFixtureCase>(StringComparer.Ordinal);

        foreach (var element in document.RootElement.GetProperty("stream").EnumerateArray())
        {
            var producedBy = element.GetProperty("producedBy")
                .EnumerateArray()
                .Select(sdk => sdk.GetString())
                .ToList();

            if (!producedBy.Contains(SdkName, StringComparer.Ordinal))
            {
                continue;
            }

            var name = element.GetProperty("name").GetString()!;
            cases.Add(name, new NullOmissionFixtureCase(
                name,
                element.GetProperty("input").Clone(),
                element.GetProperty("expected").Clone()));
        }

        return cases;
    }
}
