using System.Text.Json.Serialization;

namespace AGUI.Client.UnitTests;

[JsonSerializable(typeof(CustomMetadata))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.SnakeCaseLower)]
internal sealed partial class AGUIChatClientTestJsonSerializerContext : JsonSerializerContext;
