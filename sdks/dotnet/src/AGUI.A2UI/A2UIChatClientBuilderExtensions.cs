using Microsoft.Extensions.AI;

namespace AGUI.A2UI;

/// <summary>
/// Extension methods for adding <see cref="A2UIChatClient"/> to a <see cref="ChatClientBuilder"/>.
/// </summary>
public static class A2UIChatClientBuilderExtensions
{
    /// <summary>
    /// Adds A2UI surface generation to the pipeline. Advertises a <c>generate_a2ui</c> tool
    /// and drives a <c>render_a2ui</c> subagent through the validate-and-retry recovery loop.
    /// </summary>
    /// <param name="builder">The chat client builder.</param>
    /// <param name="subagentChatClient">
    /// The <b>raw</b> chat client (no automatic function invocation) used to run the
    /// UI-generation subagent.
    /// </param>
    /// <param name="options">Behavior knobs; defaults are filled per the shared toolkit rules.</param>
    /// <returns>The builder for chaining.</returns>
    /// <remarks>
    /// Add this <b>before</b> <c>UseFunctionInvocation()</c> so A2UI sits outside function
    /// invocation: <c>builder.UseA2UI(subagent).UseFunctionInvocation()</c>.
    /// </remarks>
    public static ChatClientBuilder UseA2UI(
        this ChatClientBuilder builder,
        IChatClient subagentChatClient,
        A2UIChatClientOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentNullException.ThrowIfNull(subagentChatClient);
        return builder.Use(inner => new A2UIChatClient(inner, subagentChatClient, options));
    }
}
