using System.Text.Json;
using Xunit;

namespace AGUI.ClaudeManagedAgents.Tests;

public class ManagedAgentsTextTest
{
    private static IEnumerable<JsonElement> Blocks(string json)
    {
        return FakeManagedAgentsClient.Json(json).EnumerateArray().Select(static block => block.Clone()).ToList();
    }

    [Fact]
    public void TextOfJoinsOnlyTextBlocks()
    {
        Assert.Equal(
            "ab",
            ManagedAgentsText.TextOf(Blocks("""[{"type":"text","text":"a"},{"type":"image"},{"type":"text","text":"b"}]""")));
        Assert.Equal(string.Empty, ManagedAgentsText.TextOf(null));
    }

    /// <summary>
    /// Decoding is reachable only through a search result, the one block type whose body is
    /// extracted from HTML.
    /// </summary>
    private static string Decoded(string text)
    {
        var escaped = JsonSerializer.Serialize(text);
        var described = ManagedAgentsText.DescribeToolResult(Blocks(
            $$"""[{"type":"search_result","title":"","source":"s","content":[{"type":"text","text":{{escaped}}}]}]"""));
        return described["[search result]  — s\n".Length..];
    }

    [Fact]
    public void DescribeToolResultSummarizesBlocksAndDecodesOnlySearchResults()
    {
        var described = ManagedAgentsText.DescribeToolResult(Blocks(
            """
            [
              {"type": "text", "text": "5 &lt; 6 &amp;&amp; &#x1F600; &#65;"},
              {"type": "search_result", "title": "T &amp; U", "source": "https://x", "content": [{"type": "text", "text": "a &lt; b"}]},
              {"type": "document"}
            ]
            """));

        Assert.Equal(
            "5 &lt; 6 &amp;&amp; &#x1F600; &#65;\n[search result] T & U — https://x\na < b\n[document]",
            described);
    }

    [Fact]
    public void PassesLiteralToolOutputThroughVerbatim()
    {
        // A file read or shell transcript means `&lt;` literally; decoding it would corrupt the
        // very output the user asked to see.
        const string Html = """<a href="y">&lt;div&gt;</a> &amp; more""";
        var escaped = JsonSerializer.Serialize(Html);
        Assert.Equal(Html, ManagedAgentsText.DescribeToolResult(Blocks($$"""[{"type":"text","text":{{escaped}}}]""")));
    }

    [Fact]
    public void DecodesNumericAndNamedEntities()
    {
        Assert.Equal("5 < 6 && \U0001F600 A \"q\" >", Decoded("5 &lt; 6 &amp;&amp; &#x1F600; &#65; &quot;q&quot; &gt;"));
    }

    [Fact]
    public void DecodesTheSameInputsAsThePythonAndTypeScriptPorts()
    {
        // Every case here is one where the three ports could drift apart. They are
        // asserted identically in all three suites.
        // An uppercase hex marker is accepted (&#[xX]).
        Assert.Equal("A", Decoded("&#X41;"));
        // Non-ASCII digits are not numeric references. Python's \d matches the whole
        // Unicode Nd category, which decoded this to "A" there alone.
        Assert.Equal("&#\u0666\u0665;", Decoded("&#\u0666\u0665;"));
        // An absurdly long decimal folds to U+FFFD rather than raising.
        Assert.Equal("\uFFFD", Decoded("&#" + new string('1', 5000) + ";"));
    }

    [Fact]
    public void ResolvesEachEntityExactlyOnce()
    {
        // Regression: decoding numeric entities before named ones turned `&#38;lt;` into `&lt;`
        // and then into `<`, discarding the escaping the source wrote.
        Assert.Equal("&lt;", Decoded("&#38;lt;"));
        Assert.Equal("&lt;", Decoded("&#x26;lt;"));
        Assert.Equal("&lt;", Decoded("&amp;lt;"));
        Assert.Equal("&amp;", Decoded("&amp;amp;"));
        Assert.Equal("&#60;", Decoded("&#38;#60;"));
    }

    [Fact]
    public void LeavesUnknownAndMalformedEntitiesAlone()
    {
        Assert.Equal("&nbsp; &copy; &#; &# 65; &lt", Decoded("&nbsp; &copy; &#; &# 65; &lt"));
    }

    [Fact]
    public void ReplacesLoneSurrogateEntitiesRatherThanEmittingInvalidText()
    {
        // A lone surrogate makes the string ill-formed UTF-16: it cannot be encoded as UTF-8, so
        // it would arrive as U+FFFD (or break the encoder) anyway. Every port rejects it here.
        Assert.Equal("a�b�c", Decoded("a&#xD800;b&#55296;c"));
        Assert.Equal("a�b", Decoded("a&#xDFFF;b"));

        // Out of range, and the boundaries around the surrogate block, still work.
        Assert.Equal("a�b", Decoded("a&#x110000;b"));
        Assert.Equal("a\uD7FF\uE000b", Decoded("a&#xD7FF;&#xE000;b"));

        // A well-formed astral character written as one code point is unaffected.
        Assert.Equal("\U0001F600", Decoded("&#x1F600;"));
    }

    [Fact]
    public void TruncatesTheSearchResultBodyToItsPreviewLength()
    {
        var body = new string('x', ManagedAgentsLimits.SearchResultPreviewChars + 50);
        var described = ManagedAgentsText.DescribeToolResult(Blocks(
            $$"""[{"type":"search_result","title":"T","source":"s","content":[{"type":"text","text":"{{body}}"}]}]"""));

        Assert.Equal($"[search result] T — s\n{new string('x', ManagedAgentsLimits.SearchResultPreviewChars)}", described);
    }

    [Fact]
    public void UsesAnUnknownPlaceholderForABlockWithNoType()
    {
        Assert.Equal("[unknown]", ManagedAgentsText.DescribeToolResult(Blocks("""[{"data":"raw"}]""")));
    }

    [Fact]
    public void TruncatesLongText()
    {
        var text = new string('y', ManagedAgentsLimits.ToolResultMaxChars + 1);

        Assert.Equal(ManagedAgentsLimits.ToolResultMaxChars, ManagedAgentsText.Truncate(text, ManagedAgentsLimits.ToolResultMaxChars).Length);
        Assert.Equal("short", ManagedAgentsText.Truncate("short", ManagedAgentsLimits.ToolResultMaxChars));
    }
}
