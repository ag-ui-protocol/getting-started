using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

/// <summary>
/// Provider-reported token usage for a single (provider, model) pair.
/// </summary>
/// <remarks>
/// <para>
/// Deliberately numeric-only: it carries provider and model labels and token counts,
/// and never prompts, completions, messages, tool arguments, or thread/run/user
/// identifiers.
/// </para>
/// <para>
/// Every count is nullable, and null means the provider did not report that count —
/// which stays distinct from a reported zero. Consumers that only need totals can sum
/// across the entries on <see cref="RunFinishedEvent.Usage"/>.
/// </para>
/// </remarks>
// Keep in sync with sdks/typescript/packages/core/src/events.ts (TokenUsageSchema)
// and sdks/typescript/packages/proto/src/proto/events.proto (message Usage).
// Counts are long to match the proto `int64` fields.
public sealed class TokenUsage
{
    /// <summary>
    /// The provider that served the request (for example <c>"openai"</c>), when known.
    /// </summary>
    [JsonPropertyName("provider")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Provider { get; set; }

    /// <summary>
    /// The model that served the request (for example <c>"gpt-4o"</c>), when known.
    /// </summary>
    [JsonPropertyName("model")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Model { get; set; }

    /// <summary>
    /// Tokens consumed by the input, including any counted by <see cref="CachedInputTokens"/>.
    /// </summary>
    [JsonPropertyName("inputTokens")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public long? InputTokens { get; set; }

    /// <summary>
    /// Tokens produced as output, including any counted by <see cref="ReasoningTokens"/>.
    /// </summary>
    [JsonPropertyName("outputTokens")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public long? OutputTokens { get; set; }

    /// <summary>
    /// Total tokens billed for the request, as reported by the provider.
    /// </summary>
    [JsonPropertyName("totalTokens")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public long? TotalTokens { get; set; }

    /// <summary>
    /// Output tokens the model spent on internal reasoning.
    /// </summary>
    [JsonPropertyName("reasoningTokens")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public long? ReasoningTokens { get; set; }

    /// <summary>
    /// Input tokens served from the provider's cache.
    /// </summary>
    [JsonPropertyName("cachedInputTokens")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public long? CachedInputTokens { get; set; }
}
