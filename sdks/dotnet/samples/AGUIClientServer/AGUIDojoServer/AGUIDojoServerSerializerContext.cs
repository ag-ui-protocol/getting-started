using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using AGUIDojoServer.AgenticUI;
using AGUIDojoServer.BackendToolRendering;
using AGUIDojoServer.PredictiveStateUpdates;
using AGUIDojoServer.SharedState;

namespace AGUIDojoServer;

[JsonSerializable(typeof(WeatherInfo))]
[JsonSerializable(typeof(Recipe))]
[JsonSerializable(typeof(Ingredient))]
[JsonSerializable(typeof(RecipeResponse))]
[JsonSerializable(typeof(Plan))]
[JsonSerializable(typeof(Step))]
[JsonSerializable(typeof(StepStatus))]
[JsonSerializable(typeof(StepStatus?))]
[JsonSerializable(typeof(JsonPatchOperation))]
[JsonSerializable(typeof(List<JsonPatchOperation>))]
[JsonSerializable(typeof(List<string>))]
[JsonSerializable(typeof(DocumentState))]
[JsonSerializable(typeof(JsonArray))]
[JsonSerializable(typeof(JsonObject))]
internal sealed partial class AGUIDojoServerSerializerContext : JsonSerializerContext;
