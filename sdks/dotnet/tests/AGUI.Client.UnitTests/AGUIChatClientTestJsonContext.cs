using System.Text.Json.Serialization;

namespace AGUI.Client.UnitTests;

[JsonSerializable(typeof(CustomToolResult))]
internal sealed partial class AGUIChatClientTestJsonContext : JsonSerializerContext;
