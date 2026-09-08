using System.Diagnostics;

namespace AGUI.Server;

/// <summary>
/// Diagnostics contract for AG-UI server-side run tracing.
/// </summary>
/// <remarks>
/// Subscribe to the run spans from an OpenTelemetry tracer provider with
/// <c>AddSource(AGUIServerInstrumentation.ActivitySourceName)</c>. Each AG-UI run produced by
/// <see cref="ChatResponseUpdateAGUIExtensions.AsAGUIEventStreamAsync(System.Collections.Generic.IAsyncEnumerable{Microsoft.Extensions.AI.ChatResponseUpdate}, ChatRequestContext, System.Threading.CancellationToken)"/>
/// is emitted as an <c>agui.run</c> span tagged with <c>agui.thread_id</c>, <c>agui.run_id</c>,
/// <c>agui.parent_run_id</c> (on a continuation), <c>agui.run.outcome</c>
/// (<c>success</c>/<c>interrupt</c>/<c>error</c>/<c>canceled</c>), and <c>agui.events.count</c>. The model and tool
/// spans emitted by the wrapped <see cref="Microsoft.Extensions.AI.IChatClient"/> nest under it.
/// </remarks>
public static class AGUIServerInstrumentation
{
    /// <summary>
    /// Gets the name of the <see cref="System.Diagnostics.ActivitySource"/> that emits AG-UI
    /// server run spans.
    /// </summary>
    public const string ActivitySourceName = "Experimental.AGUI.Server";

    internal static readonly ActivitySource ActivitySource = new(ActivitySourceName);
}
