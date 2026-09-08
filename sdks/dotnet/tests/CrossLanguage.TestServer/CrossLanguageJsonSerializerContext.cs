using System.Text.Json.Serialization;

namespace CrossLanguage.TestServer;

[JsonSerializable(typeof(WeatherReport))]
[JsonSerializable(typeof(TimeReport))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.SnakeCaseLower)]
internal sealed partial class CrossLanguageJsonSerializerContext : JsonSerializerContext;
