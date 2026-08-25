namespace AGUI.Server.IntegrationTests;

/// <summary>
/// Selects the AG-UI wire transport format used by the test client when negotiating with the
/// server. The decoded event/<see cref="Microsoft.Extensions.AI.ChatResponseUpdate"/> streams and
/// the request JSON are identical across formats, so the Verify baselines are shared.
/// </summary>
public enum TransportFormat
{
    /// <summary>JSON over Server-Sent Events (<c>text/event-stream</c>); the default transport.</summary>
    Json,

    /// <summary>Length-prefixed protobuf (<c>application/vnd.ag-ui.event+proto</c>).</summary>
    Protobuf,
}
