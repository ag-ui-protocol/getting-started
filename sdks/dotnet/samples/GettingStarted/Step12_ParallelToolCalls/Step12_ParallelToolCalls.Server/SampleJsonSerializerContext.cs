using System.Text.Json.Serialization;

namespace Step12_ParallelToolCalls.Server;

[JsonSerializable(typeof(WeatherReport))]
[JsonSerializable(typeof(TimeReport))]
internal sealed partial class SampleJsonSerializerContext : JsonSerializerContext;
