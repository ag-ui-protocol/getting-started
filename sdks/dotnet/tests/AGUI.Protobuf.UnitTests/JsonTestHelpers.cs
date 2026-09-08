using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Xunit;

namespace AGUI.Protobuf.UnitTests;

internal static class JsonTestHelpers
{
    public static JsonElement Parse(string json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    public static void AssertEqual(JsonElement expected, JsonElement actual)
    {
        Assert.True(DeepEquals(expected, actual), $"Expected JSON '{expected.GetRawText()}' but got '{actual.GetRawText()}'.");
    }

    private static bool DeepEquals(JsonElement a, JsonElement b)
    {
        if (a.ValueKind != b.ValueKind)
        {
            return false;
        }

        switch (a.ValueKind)
        {
            case JsonValueKind.Object:
            {
                var aProps = a.EnumerateObject().ToDictionary(p => p.Name, p => p.Value);
                var bProps = b.EnumerateObject().ToDictionary(p => p.Name, p => p.Value);
                if (aProps.Count != bProps.Count)
                {
                    return false;
                }

                foreach (var pair in aProps)
                {
                    if (!bProps.TryGetValue(pair.Key, out var other) || !DeepEquals(pair.Value, other))
                    {
                        return false;
                    }
                }

                return true;
            }
            case JsonValueKind.Array:
            {
                var aItems = a.EnumerateArray().ToList();
                var bItems = b.EnumerateArray().ToList();
                if (aItems.Count != bItems.Count)
                {
                    return false;
                }

                for (int i = 0; i < aItems.Count; i++)
                {
                    if (!DeepEquals(aItems[i], bItems[i]))
                    {
                        return false;
                    }
                }

                return true;
            }
            case JsonValueKind.String:
                return a.GetString() == b.GetString();
            case JsonValueKind.Number:
                return a.GetDouble() == b.GetDouble();
            case JsonValueKind.True:
            case JsonValueKind.False:
            case JsonValueKind.Null:
                return true;
            default:
                return a.GetRawText() == b.GetRawText();
        }
    }
}
