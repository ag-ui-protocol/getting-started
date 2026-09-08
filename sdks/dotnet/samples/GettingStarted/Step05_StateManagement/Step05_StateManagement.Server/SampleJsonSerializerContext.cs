using System.Text.Json.Serialization;

namespace Step05_StateManagement.Server;

[JsonSerializable(typeof(AgentState))]
[JsonSerializable(typeof(RecipeState))]
internal sealed partial class SampleJsonSerializerContext : JsonSerializerContext;
