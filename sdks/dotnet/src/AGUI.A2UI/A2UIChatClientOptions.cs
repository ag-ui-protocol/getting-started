using AGUI.Server;
using Microsoft.Extensions.AI;

namespace AGUI.A2UI;

/// <summary>
/// Options for <see cref="A2UIChatClient"/>: whether to inject the <c>generate_a2ui</c>
/// tool, plus the shared toolkit knobs (tool name/description, guidelines, default surface
/// and catalog ids, validation catalog, recovery config, and the per-attempt callback).
/// </summary>
public sealed class A2UIChatClientOptions
{
    /// <summary>
    /// Gets whether to inject the <c>generate_a2ui</c> tool. The per-run forwarded
    /// <c>injectA2UITool</c> flag wins when present; this value is the backend opt-in used only
    /// when the run forwards no flag, so a client-sent <see langword="false"/> still wins.
    /// <see langword="null"/> (the default) means <b>off</b>, matching the "no
    /// <c>injectA2UITool</c>, no injection" contract the sibling adapters share (ADK
    /// <c>a2ui["inject_a2ui_tool"]</c>, AWS Strands / Mastra / CrewAI <c>a2ui.injectA2UITool</c>).
    /// Set <see langword="true"/> to opt in on a host that does not forward the flag.
    /// </summary>
    public bool? InjectA2UITool { get; init; }

    /// <summary>
    /// Gets the name under which the A2UI middleware injected its <c>render_a2ui</c> proxy tool,
    /// which is dropped from the planner's tool list so the model calls <c>generate_a2ui</c>
    /// instead of painting a surface directly (bypassing the subagent and the validate-and-retry
    /// loop). Defaults to <see cref="A2UIConstants.RenderA2UIToolName"/>.
    /// </summary>
    /// <remarks>
    /// Only needed when the host configured the middleware with a custom name
    /// (<c>injectA2UITool: "myName"</c>). When the run forwards that string form, the forwarded
    /// name takes precedence over this value.
    /// </remarks>
    public string? InjectedRenderToolName { get; init; }

    /// <summary>
    /// Gets the shared toolkit parameters (tool name/description, guidelines, default surface
    /// and catalog ids, validation catalog, recovery config, per-attempt callback). Defaults
    /// are filled per the shared toolkit rules when unset.
    /// </summary>
    public A2UIToolParams? ToolParams { get; init; }

    /// <summary>
    /// Gets an optional extractor that reads provider-native streamed tool-call argument
    /// fragments off a render sub-agent update (the same kind registered on the server's
    /// <see cref="AGUIStreamOptions.MapStreamingToolCallArguments"/>). It lets the adapter learn
    /// the streamed <c>render_a2ui</c> call id before the coalesced tool call arrives, so a
    /// generation attempt that streams fragments and then fails mid-stream can still emit a
    /// balancing tool result and leave the persisted conversation valid. When unset, balancing
    /// falls back to the coalesced call id (which is unavailable on a mid-stream failure).
    /// </summary>
    public Func<ChatResponseUpdate, IEnumerable<AGUIToolCallArgumentFragment>?>? StreamingToolCallArgumentExtractor { get; init; }
}
