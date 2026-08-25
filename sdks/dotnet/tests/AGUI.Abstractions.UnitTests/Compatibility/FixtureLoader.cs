using System.Reflection;
using System.Text.Json;

namespace AGUI.Abstractions.UnitTests.Compatibility;

internal static class FixtureLoader
{
    internal static JsonElement[] LoadFixture(string fileName)
    {
        var assembly = Assembly.GetExecutingAssembly();
        var resourceName = $"AGUI.Abstractions.UnitTests.Compatibility.Fixtures.{fileName}";
        using var stream = assembly.GetManifestResourceStream(resourceName)
            ?? throw new InvalidOperationException($"Embedded resource '{resourceName}' not found.");
        using var doc = JsonDocument.Parse(stream);
        // Clone elements so the document can be disposed
        return doc.RootElement.EnumerateArray()
            .Select(e => e.Clone())
            .ToArray();
    }

    internal static BaseEvent DeserializeAsBaseEvent(JsonElement element)
    {
        var json = element.GetRawText();
        return JsonSerializer.Deserialize<BaseEvent>(json, AGUIJsonSerializerContext.Default.BaseEvent)!;
    }
}
