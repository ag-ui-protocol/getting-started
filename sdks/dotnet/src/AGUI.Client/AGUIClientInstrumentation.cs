using System.Diagnostics;

namespace AGUI.Client;

/// <summary>
/// Diagnostics contract for AG-UI client-side tracing.
/// </summary>
/// <remarks>
/// Subscribe with OpenTelemetry via <c>AddSource(AGUIClientInstrumentation.ActivitySourceName)</c>
/// to capture the <c>execute_tool</c> spans that <see cref="AGUIChatClient"/> emits when it invokes
/// a client-side (frontend) tool locally. The AG-UI client wires this source into the
/// function-invoking pipeline it owns, so it is the source for client tool execution even though
/// any outer <c>UseOpenTelemetry()</c> only wraps the call in a <c>chat</c> span.
/// </remarks>
public static class AGUIClientInstrumentation
{
    /// <summary>
    /// Gets the name of the <see cref="System.Diagnostics.ActivitySource"/> used for AG-UI
    /// client-side tool-execution spans.
    /// </summary>
    public const string ActivitySourceName = "Experimental.AGUI.Client";

    internal static readonly ActivitySource ActivitySource = new(ActivitySourceName);
}
