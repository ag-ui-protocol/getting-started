using System.Text.Json.Serialization;

namespace AGUIDojoServer.AgenticUI;

[JsonConverter(typeof(JsonStringEnumConverter<StepStatus>))]
internal enum StepStatus
{
    Pending,
    Completed
}
