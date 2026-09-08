using System.Text.Json.Serialization;

namespace Step02_BackendTools.Server;

[JsonSerializable(typeof(RestaurantSearchRequest))]
[JsonSerializable(typeof(RestaurantSearchResponse))]
internal sealed partial class SampleJsonSerializerContext : JsonSerializerContext;
