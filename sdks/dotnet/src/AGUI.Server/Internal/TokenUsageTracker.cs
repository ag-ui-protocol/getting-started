using System.Collections.Generic;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;

namespace AGUI.Server;

// Accumulates the UsageContent reported across a run's ChatResponseUpdate stream
// into one TokenUsage entry per (provider, model), preserving first-appearance
// order. Mirrors `aggregateTokenUsage` in sdks/typescript/packages/core/src/token-usage.ts.
//
// A count stays null unless at least one update reported it, so "the provider never
// reported this" stays distinct from "the provider reported zero".
internal sealed class TokenUsageTracker
{
    private readonly Dictionary<(string? Provider, string? Model), TokenUsage> _byProviderModel = [];
    private readonly List<TokenUsage> _inFirstAppearanceOrder = [];

    public void Add(UsageDetails details, string? provider, string? model)
    {
        // Providers that don't echo a label leave these empty rather than null.
        // Normalise to null so the field is omitted rather than emitted blank.
        provider = string.IsNullOrWhiteSpace(provider) ? null : provider;
        model = string.IsNullOrWhiteSpace(model) ? null : model;

        var key = (provider, model);
        if (!_byProviderModel.TryGetValue(key, out var entry))
        {
            entry = new TokenUsage { Provider = provider, Model = model };
            _byProviderModel[key] = entry;
            _inFirstAppearanceOrder.Add(entry);
        }

        entry.InputTokens = Sum(entry.InputTokens, details.InputTokenCount);
        entry.OutputTokens = Sum(entry.OutputTokens, details.OutputTokenCount);
        entry.TotalTokens = Sum(entry.TotalTokens, details.TotalTokenCount);
        entry.ReasoningTokens = Sum(entry.ReasoningTokens, details.ReasoningTokenCount);
        entry.CachedInputTokens = Sum(entry.CachedInputTokens, details.CachedInputTokenCount);
    }

    // Null when nothing was reported, so the terminal event omits `usage` on the wire
    // rather than carrying an empty array.
    public IList<TokenUsage>? Build() =>
        _inFirstAppearanceOrder.Count == 0 ? null : _inFirstAppearanceOrder;

    // Adding to null yields the reported value rather than leaving null, but an
    // unreported count never promotes an accumulated null to zero.
    private static long? Sum(long? accumulated, long? reported) =>
        reported is null ? accumulated : (accumulated ?? 0) + reported.Value;
}
