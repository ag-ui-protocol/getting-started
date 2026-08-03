using Xunit;

namespace AGUI.ClaudeManagedAgents.Tests;

public class ManagedAgentsCustomToolsTest
{
    [Fact]
    public void KeepsValidToolNames()
    {
        Assert.Equal("show_chart", ManagedAgentsCustomTools.NormalizeToolName("show_chart"));
        Assert.Equal("Get-Weather_2", ManagedAgentsCustomTools.NormalizeToolName("Get-Weather_2"));
    }

    [Fact]
    public void ReplacesInvalidCharactersAndTruncatesLongNames()
    {
        Assert.Equal("search_web_", ManagedAgentsCustomTools.NormalizeToolName("search web!"));
        Assert.Equal(new string('x', ManagedAgentsLimits.ToolNameMaxLength), ManagedAgentsCustomTools.NormalizeToolName(new string('x', 200)));
        Assert.Equal("tool", ManagedAgentsCustomTools.NormalizeToolName(string.Empty));
    }

    [Fact]
    public void NormalizesANameWithATrailingNewline()
    {
        // Regression: the validity pattern ended in `$`, which in .NET also matches immediately
        // before a trailing newline — so "show_chart\n" was treated as already valid and forwarded
        // to the API unchanged.
        Assert.Equal("show_chart_", ManagedAgentsCustomTools.NormalizeToolName("show_chart\n"));
        Assert.Equal("show_chart__", ManagedAgentsCustomTools.NormalizeToolName("show_chart\r\n"));
    }

    [Fact]
    public void CapsTheDescriptionAtTheApisLimit()
    {
        // The API accepts 1-4096; capping lower silently truncated valid descriptions.
        Assert.Equal(4096, ManagedAgentsLimits.ToolDescriptionMaxLength);
        var kept = ManagedAgentsCustomTools.CustomToolFrom("ok", new string('d', 2000), parameters: default);
        Assert.Equal(2000, kept.GetProperty("description").GetString()!.Length);
    }

    [Fact]
    public void BuildsAnInputSchemaAndADefaultDescription()
    {
        var tool = ManagedAgentsCustomTools.CustomToolFrom(
            "ping",
            description: string.Empty,
            FakeManagedAgentsClient.Json("""{"properties":{"a":{"type":"string"}}}"""));

        var expected = FakeManagedAgentsClient.Json(
            """
            {
              "type": "custom",
              "name": "ping",
              "description": "Tool ping",
              "input_schema": {"type": "object", "properties": {"a": {"type": "string"}}}
            }
            """);
        Assert.True(System.Text.Json.JsonElement.DeepEquals(expected, tool), tool.GetRawText());
    }

    [Fact]
    public void HandlesMissingParametersAndNormalizesTheName()
    {
        var tool = ManagedAgentsCustomTools.CustomToolFrom("lookup docs", "Lookup", parameters: default);

        Assert.Equal("lookup_docs", ManagedAgentsCustomTools.NameOf(tool));
        Assert.Equal("""{"type":"object","properties":{}}""", tool.GetProperty("input_schema").GetRawText());
    }

    [Fact]
    public void PreservesANestedSchemaWithReusedDefinitions()
    {
        // Regression: only `properties` and `required` were copied, so `$defs` vanished and every
        // `$ref` pointing into it became dangling.
        const string Route = """
            {
              "type": "object",
              "description": "A route",
              "additionalProperties": false,
              "properties": {
                "from": {"$ref": "#/$defs/point"},
                "to": {"$ref": "#/$defs/point"},
                "via": {"type": "array", "items": {"$ref": "#/$defs/point"}}
              },
              "required": ["from", "to"],
              "$defs": {
                "point": {
                  "type": "object",
                  "properties": {"x": {"type": "number"}, "y": {"type": "number"}},
                  "required": ["x", "y"]
                }
              }
            }
            """;

        var tool = ManagedAgentsCustomTools.CustomToolFrom("route", "Plot", FakeManagedAgentsClient.Json(Route));

        Assert.True(
            System.Text.Json.JsonElement.DeepEquals(FakeManagedAgentsClient.Json(Route), tool.GetProperty("input_schema")),
            tool.GetProperty("input_schema").GetRawText());
    }

    [Fact]
    public void PreservesCompositionKeywordsAndATopLevelRef()
    {
        const string AnyOf = """{"type":"object","anyOf":[{"required":["a"]},{"required":["b"]}],"properties":{"a":{},"b":{}}}""";
        var either = ManagedAgentsCustomTools.CustomToolFrom("either", "d", FakeManagedAgentsClient.Json(AnyOf));
        Assert.True(
            System.Text.Json.JsonElement.DeepEquals(FakeManagedAgentsClient.Json(AnyOf), either.GetProperty("input_schema")),
            either.GetProperty("input_schema").GetRawText());

        // The API accepts object input schemas only, so `type` is asserted while everything else
        // — including the definitions the `$ref` needs — is carried through.
        const string TopLevelRef = """{"$ref":"#/$defs/args","$defs":{"args":{"type":"object","properties":{"q":{"type":"string"}}}}}""";
        const string Expected = """{"$ref":"#/$defs/args","$defs":{"args":{"type":"object","properties":{"q":{"type":"string"}}}},"type":"object"}""";
        var byRef = ManagedAgentsCustomTools.CustomToolFrom("ref", "d", FakeManagedAgentsClient.Json(TopLevelRef));
        Assert.True(
            System.Text.Json.JsonElement.DeepEquals(FakeManagedAgentsClient.Json(Expected), byRef.GetProperty("input_schema")),
            byRef.GetProperty("input_schema").GetRawText());
    }

    [Fact]
    public void TruncatesLongDescriptions()
    {
        var description = new string('d', ManagedAgentsLimits.ToolDescriptionMaxLength + 10);
        var tool = ManagedAgentsCustomTools.CustomToolFrom("ping", description, parameters: default);

        Assert.Equal(ManagedAgentsLimits.ToolDescriptionMaxLength, tool.GetProperty("description").GetString()!.Length);
    }
}
