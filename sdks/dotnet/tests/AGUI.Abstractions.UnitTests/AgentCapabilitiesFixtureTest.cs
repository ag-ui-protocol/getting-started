using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

/// <summary>
/// Runs <c>sdks/fixtures/agent-capabilities.json</c>, the cross-language fixture the
/// TypeScript and Python SDKs run too. <see cref="AgentCapabilities"/> is generated from one
/// schema definition for all three SDKs; this file is where they are held to each other's
/// wire output rather than each merely agreeing with itself.
/// </summary>
/// <remarks>
/// <para>
/// Each case is parsed into the .NET model and written back out through the
/// source-generated <see cref="AGUIJsonSerializerContext"/> — the AOT path the SSE
/// formatter, the protobuf formatter and the HTTP transport all use — then compared to the
/// fixture's <c>expected</c> object. The comparison is order-insensitive but exact in
/// content, so an unset optional member surfacing as <c>null</c> fails the case, and so does
/// inventing a value for a group the input left out.
/// </para>
/// <para>
/// A second pass goes through <see cref="AGUIJsonUtilities.DefaultTypeInfoResolver"/> set as
/// the sole <see cref="JsonSerializerOptions.TypeInfoResolver"/> — set, never chained — so a
/// capability type missing from the context throws instead of quietly falling back to
/// reflection and producing a green result that would not survive trimming.
/// </para>
/// </remarks>
public sealed class AgentCapabilitiesFixtureTest
{
    public static TheoryData<string> CaseNames()
    {
        var data = new TheoryData<string>();
        foreach (var name in AgentCapabilitiesFixture.CaseNames)
        {
            data.Add(name);
        }

        return data;
    }

    /// <summary>
    /// Caller-owned options resolving AG-UI types through the source-generated context only.
    /// </summary>
    private static JsonSerializerOptions AGUIOptions()
    {
        var options = new JsonSerializerOptions { TypeInfoResolver = AGUIJsonUtilities.DefaultTypeInfoResolver };
        options.MakeReadOnly();
        return options;
    }

    [Fact]
    public void FixtureCoversThisSdk()
    {
        // Anti-vacuity: an empty or mis-filtered fixture would let every [Theory] below pass
        // by never running.
        Assert.NotEmpty(AgentCapabilitiesFixture.CaseNames);

        // `producedBy` exists for wire types an SDK genuinely does not implement. Nothing about
        // AgentCapabilities is optional for .NET — the model is generated from one schema
        // definition for all SDKs — so a case that skipped "dotnet" would be papering over a
        // failure rather than recording a real gap. If one ever legitimately needs skipping,
        // the reason belongs here, next to the loosened assertion.
        Assert.Empty(AgentCapabilitiesFixture.CaseNamesNotCoveringThisSdk);
        Assert.Equal(AgentCapabilitiesFixture.TotalCaseCount, AgentCapabilitiesFixture.CaseNames.Count);
    }

    [Fact]
    public void NoExpectedDocumentContainsANull()
    {
        // Anti-vacuity of a second kind: the point of the fixture is that an undeclared
        // member is absent rather than null, so an `expected` document that carried a null
        // anywhere would be asserting the opposite of the contract. Checked here rather than
        // trusted, because the file is edited by three SDKs' authors.
        foreach (var name in AgentCapabilitiesFixture.CaseNames)
        {
            var expected = JsonNode.Parse(AgentCapabilitiesFixture.Case(name).Expected.GetRawText());
            AssertNoNulls(expected, $"{name}.expected", "");
        }
    }

    [Fact]
    public void AssertNoNullsRejectsANullUnderANonOpenKey()
    {
        // The metadata/custom skip in AssertNoNulls is only meaningful if the walk it guards
        // actually rejects a null elsewhere — and the added guard rejects a null VALUE spelled at
        // the open key itself. No `expected` document exercises either directly (an `expected`
        // that carried such a null would have failed NoExpectedDocumentContainsANull first), so
        // these three inputs pin the behaviour: a null at an open key (custom, identity.metadata)
        // throws, and a null value NESTED under an open key is legal and does not throw.
        Assert.ThrowsAny<Xunit.Sdk.XunitException>(() => AssertNoNulls(
            JsonNode.Parse(JsonDocument.Parse("{\"custom\":null}").RootElement.GetRawText()),
            "custom-null",
            ""));

        Assert.ThrowsAny<Xunit.Sdk.XunitException>(() => AssertNoNulls(
            JsonNode.Parse(JsonDocument.Parse("{\"identity\":{\"metadata\":null}}").RootElement.GetRawText()),
            "metadata-null",
            ""));

        // A null VALUE under an open-by-key member is data the protocol preserves; the walk must
        // not descend into it and must not throw.
        AssertNoNulls(
            JsonNode.Parse(JsonDocument.Parse("{\"custom\":{\"anything\":null}}").RootElement.GetRawText()),
            "custom-open-null",
            "");
    }

    [Theory]
    [MemberData(nameof(CaseNames))]
    public void CaseReserializesToItsExpectedJson(string caseName)
    {
        var fixtureCase = AgentCapabilitiesFixture.Case(caseName);

        var capabilities = JsonSerializer.Deserialize(
            fixtureCase.Input.GetRawText(),
            AGUIJsonSerializerContext.Default.AgentCapabilities)!;

        var produced = JsonSerializer.Serialize(
            capabilities,
            AGUIJsonSerializerContext.Default.AgentCapabilities);

        Assert.True(
            JsonNode.DeepEquals(JsonNode.Parse(produced), JsonNode.Parse(fixtureCase.Expected.GetRawText())),
            $"case '{caseName}'\nexpected: {fixtureCase.Expected.GetRawText()}\nproduced: {produced}");
    }

    [Theory]
    [MemberData(nameof(CaseNames))]
    public void CaseReserializesToItsExpectedJsonThroughTheResolver(string caseName)
    {
        var fixtureCase = AgentCapabilitiesFixture.Case(caseName);
        var options = AGUIOptions();

        var capabilities = (AgentCapabilities)JsonSerializer.Deserialize(
            fixtureCase.Input.GetRawText(),
            typeof(AgentCapabilities),
            options)!;

        var produced = JsonSerializer.Serialize(capabilities, typeof(AgentCapabilities), options);

        Assert.True(
            JsonNode.DeepEquals(JsonNode.Parse(produced), JsonNode.Parse(fixtureCase.Expected.GetRawText())),
            $"case '{caseName}'\nexpected: {fixtureCase.Expected.GetRawText()}\nproduced: {produced}");
    }

    private static void AssertNoNulls(JsonNode? node, string caseName, string path)
    {
        switch (node)
        {
            case null:
                Assert.Fail($"{caseName}: JSON null at '{(path.Length == 0 ? "$" : path)}'");
                break;
            case JsonObject obj:
                foreach (var property in obj)
                {
                    // A null VALUE under an open-by-key member (identity.metadata, custom) is data the
                    // protocol says MUST be preserved — the open_values_may_be_null case pins it — so the
                    // walk does not descend into those; a null anywhere else is an unset member spelled wrong.
                    if (property.Key is "metadata" or "custom")
                    {
                        // Skipping the member skips its VALUE, not the member itself: the schema types
                        // both as objects that may be absent but are never null when present.
                        Assert.False(
                            property.Value is null || property.Value.GetValueKind() == JsonValueKind.Null,
                            $"{caseName}: JSON null at '{path}.{property.Key}'");
                        continue;
                    }

                    AssertNoNulls(property.Value, caseName, $"{path}.{property.Key}");
                }

                break;
            case JsonArray array:
                for (var i = 0; i < array.Count; i++)
                {
                    AssertNoNulls(array[i], caseName, $"{path}[{i}]");
                }

                break;
            case JsonValue value:
                Assert.False(
                    value.GetValueKind() == JsonValueKind.Null,
                    $"{caseName}: JSON null at '{(path.Length == 0 ? "$" : path)}'");
                break;
        }
    }
}

internal sealed record AgentCapabilitiesFixtureCase(string Name, JsonElement Input, JsonElement Expected);

internal static class AgentCapabilitiesFixture
{
    private const string ResourceName =
        "AGUI.Abstractions.UnitTests.CrossLanguageFixtures.agent-capabilities.json";

    private const string SdkName = "dotnet";

    private static readonly Loaded Fixture = Load();

    private static IReadOnlyDictionary<string, AgentCapabilitiesFixtureCase> Cases => Fixture.Cases;

    internal static IReadOnlyList<string> CaseNames { get; } = Fixture.Cases.Keys.ToList();

    /// <summary>Names of fixture cases whose <c>producedBy</c> does not list this SDK.</summary>
    internal static IReadOnlyList<string> CaseNamesNotCoveringThisSdk => Fixture.SkippedNames;

    /// <summary>Number of cases in the fixture file, before the <c>producedBy</c> filter.</summary>
    internal static int TotalCaseCount => Fixture.Cases.Count + Fixture.SkippedNames.Count;

    internal static AgentCapabilitiesFixtureCase Case(string name) => Cases[name];

    private sealed record Loaded(
        IReadOnlyDictionary<string, AgentCapabilitiesFixtureCase> Cases,
        IReadOnlyList<string> SkippedNames);

    private static Loaded Load()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(ResourceName)
            ?? throw new InvalidOperationException($"Embedded resource '{ResourceName}' not found.");
        using var document = JsonDocument.Parse(stream);

        var cases = new Dictionary<string, AgentCapabilitiesFixtureCase>(StringComparer.Ordinal);
        var skipped = new List<string>();

        foreach (var element in document.RootElement.GetProperty("cases").EnumerateArray())
        {
            var producedBy = element.GetProperty("producedBy")
                .EnumerateArray()
                .Select(sdk => sdk.GetString())
                .ToList();

            var name = element.GetProperty("name").GetString()!;

            if (!producedBy.Contains(SdkName, StringComparer.Ordinal))
            {
                skipped.Add(name);
                continue;
            }

            cases.Add(name, new AgentCapabilitiesFixtureCase(
                name,
                element.GetProperty("input").Clone(),
                element.GetProperty("expected").Clone()));
        }

        return new Loaded(cases, skipped);
    }
}
