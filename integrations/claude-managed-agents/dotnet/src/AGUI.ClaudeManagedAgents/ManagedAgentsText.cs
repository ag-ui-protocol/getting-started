using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace AGUI.ClaudeManagedAgents;

/// <summary>
/// Helpers for turning Managed Agents content blocks into display text.
/// </summary>
internal static partial class ManagedAgentsText
{
    private const string ReplacementCharacter = "�";

    /// <summary>
    /// Concatenates the text of every <c>text</c> block.
    /// </summary>
    internal static string TextOf(IEnumerable<JsonElement>? blocks)
    {
        if (blocks is null)
        {
            return string.Empty;
        }

        var builder = new StringBuilder();
        foreach (var block in blocks)
        {
            if (IsType(block, "text") && TryGetString(block, "text", out var text))
            {
                builder.Append(text);
            }
        }

        return builder.ToString();
    }

    /// <summary>
    /// Flattens the mixed block types of a tool result (text, search results, images,
    /// documents) into a readable string for the UI.
    /// </summary>
    /// <remarks>
    /// <c>text</c> blocks are passed through verbatim. They carry literal tool output — a file
    /// read, a shell transcript — where <c>&amp;lt;</c> means those four characters, so decoding
    /// them would corrupt the very output the user asked to see. Only <c>search_result</c> blocks,
    /// whose bodies are extracted from HTML, are decoded.
    /// </remarks>
    internal static string DescribeToolResult(IEnumerable<JsonElement>? blocks)
    {
        if (blocks is null)
        {
            return string.Empty;
        }

        var parts = new List<string>();
        foreach (var block in blocks)
        {
            if (IsType(block, "text") && TryGetString(block, "text", out var text))
            {
                parts.Add(text);
                continue;
            }

            if (IsType(block, "search_result"))
            {
                var inner = block.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.Array
                    ? TextOf(content.EnumerateArray())
                    : string.Empty;
                var title = DecodeEntities(TryGetString(block, "title", out var t) ? t : string.Empty);
                var source = TryGetString(block, "source", out var s) ? s : string.Empty;
                var summary = inner.Length == 0
                    ? string.Empty
                    : "\n" + Truncate(DecodeEntities(inner), ManagedAgentsLimits.SearchResultPreviewChars);
                parts.Add($"[search result] {title} — {source}{summary}");
                continue;
            }

            var type = TryGetString(block, "type", out var blockType) ? blockType : "unknown";
            parts.Add($"[{type}]");
        }

        return string.Join("\n", parts).Trim();
    }

    /// <summary>
    /// Truncates <paramref name="value"/> to at most <paramref name="length"/> UTF-16 units.
    /// </summary>
    internal static string Truncate(string value, int length)
    {
        return value.Length <= length ? value : value.Substring(0, length);
    }

    private static bool IsType(JsonElement block, string type)
    {
        return block.ValueKind == JsonValueKind.Object
            && TryGetString(block, "type", out var actual)
            && string.Equals(actual, type, StringComparison.Ordinal);
    }

    private static bool TryGetString(JsonElement element, string name, out string value)
    {
        if (element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty(name, out var property)
            && property.ValueKind == JsonValueKind.String)
        {
            value = property.GetString() ?? string.Empty;
            return true;
        }

        value = string.Empty;
        return false;
    }

    private static readonly Dictionary<string, string> s_namedEntities = new(StringComparer.Ordinal)
    {
        ["quot"] = "\"",
        ["lt"] = "<",
        ["gt"] = ">",
        ["amp"] = "&",
    };

    /// <summary>
    /// Decodes numeric and the common named HTML entities in one pass.
    /// </summary>
    /// <remarks>
    /// One pass matters: decoding numeric entities before named ones would rewrite
    /// <c>&amp;#38;lt;</c> to <c>&amp;lt;</c> and then to <c>&lt;</c>, losing the escaping the
    /// source went to the trouble of writing. Each match is resolved exactly once.
    /// </remarks>
    private static string DecodeEntities(string value)
    {
        return Entity().Replace(value, static match =>
        {
            var name = match.Groups["name"];
            if (name.Success)
            {
                return s_namedEntities[name.Value];
            }

            var hex = match.Groups["hex"];
            return hex.Success
                ? CodePointOf(hex.Value, NumberStyles.HexNumber)
                : CodePointOf(match.Groups["dec"].Value, NumberStyles.Integer);
        });
    }

    /// <summary>
    /// The character an entity's code point denotes, or U+FFFD.
    /// </summary>
    /// <remarks>
    /// Surrogate code points (U+D800-U+DFFF) are rejected as well as out-of-range ones: alone they
    /// make the string ill-formed UTF-16, which cannot be encoded as UTF-8 and turns into U+FFFD
    /// (or an encoder error) somewhere downstream.
    /// </remarks>
    private static string CodePointOf(string digits, NumberStyles style)
    {
        if (!long.TryParse(digits, style, CultureInfo.InvariantCulture, out var codePoint))
        {
            return ReplacementCharacter;
        }

        if (codePoint < 0 || codePoint > 0x10FFFF || (codePoint >= 0xD800 && codePoint <= 0xDFFF))
        {
            return ReplacementCharacter;
        }

        return char.ConvertFromUtf32((int)codePoint);
    }

    [GeneratedRegex("&(?:#[xX](?<hex>[0-9a-fA-F]+)|#(?<dec>[0-9]+)|(?<name>quot|lt|gt|amp));")]
    private static partial Regex Entity();
}
