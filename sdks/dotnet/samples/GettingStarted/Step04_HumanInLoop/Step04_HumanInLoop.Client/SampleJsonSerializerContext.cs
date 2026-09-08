using System.Text.Json.Serialization;

namespace Step04_HumanInLoop.Client;

[JsonSerializable(typeof(ApprovalRequest))]
[JsonSerializable(typeof(ApprovalResponse))]
internal sealed partial class SampleJsonSerializerContext : JsonSerializerContext;
