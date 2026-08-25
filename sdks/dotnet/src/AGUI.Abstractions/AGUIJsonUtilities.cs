using System;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;
using Microsoft.Extensions.AI;

namespace AGUI.Abstractions;

/// <summary>
/// Helpers for configuring System.Text.Json to (de)serialize AG-UI types.
/// </summary>
public static class AGUIJsonUtilities
{
    /// <summary>
    /// The AG-UI type resolver: <see cref="AGUIJsonSerializerContext"/> with the
    /// omit-a-field-that-has-no-value rule attached to the type metadata itself.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Prefer this over inserting <see cref="AGUIJsonSerializerContext.Default"/> directly
    /// when composing your own <see cref="JsonSerializerOptions"/>. The context's
    /// <c>DefaultIgnoreCondition</c> lives on the context's own
    /// <see cref="JsonSerializerContext.Options"/> and does not follow the context into a
    /// different options instance, so a plain
    /// <c>options.TypeInfoResolverChain.Insert(0, AGUIJsonSerializerContext.Default)</c>
    /// would start writing <c>"parentMessageId": null</c> and similar — the exact wire
    /// divergence that receiving SDKs have had to be patched to tolerate.
    /// </para>
    /// <para>
    /// The rule is applied per property by a type-info modifier rather than by setting
    /// <c>DefaultIgnoreCondition</c> on the caller's options, so it governs AG-UI types only
    /// and leaves the caller's own payloads — tool arguments, tool results — serialized
    /// exactly as the caller asked.
    /// </para>
    /// </remarks>
    public static IJsonTypeInfoResolver DefaultTypeInfoResolver { get; } =
        AGUIJsonSerializerContext.Default.WithAddedModifier(OmitPropertiesWithoutAValue);

    /// <summary>
    /// Registers the AG-UI interrupt content types (<see cref="InterruptRequestContent"/> and
    /// <see cref="InterruptResponseContent"/>) with the specified <see cref="JsonSerializerOptions"/>
    /// so they round-trip as polymorphic <see cref="AIContent"/>.
    /// </summary>
    /// <param name="options">The JSON serializer options to configure.</param>
    public static void RegisterInterruptContentTypes(JsonSerializerOptions options)
    {
#if NET7_0_OR_GREATER
        ArgumentNullException.ThrowIfNull(options);
#else
        if (options is null)
        {
            throw new ArgumentNullException(nameof(options));
        }
#endif

        options.AddAIContentType<InterruptRequestContent>("interruptRequest");
        options.AddAIContentType<InterruptResponseContent>("interruptResponse");
    }

    /// <summary>
    /// Makes every property that can hold no value write nothing instead of <c>null</c>.
    /// </summary>
    /// <remarks>
    /// Applied to every nullable property rather than a chosen list, which is the whole
    /// point: a nullable property added later is covered without anyone remembering to mark
    /// it. Non-nullable value types are skipped — they cannot be absent. A non-nullable
    /// reference property that is null at runtime is a producer bug either way, and dropping
    /// the key is what TypeScript does with the same bug (<c>JSON.stringify</c> omits
    /// <c>undefined</c>), so the SDKs stay consistent even when misused.
    /// </remarks>
    private static void OmitPropertiesWithoutAValue(JsonTypeInfo typeInfo)
    {
        if (typeInfo.Kind != JsonTypeInfoKind.Object)
        {
            return;
        }

        foreach (var property in typeInfo.Properties)
        {
            if (property.PropertyType.IsValueType &&
                Nullable.GetUnderlyingType(property.PropertyType) is null)
            {
                continue;
            }

            var alreadyDeclared = property.ShouldSerialize;
            property.ShouldSerialize = alreadyDeclared is null
                ? static (_, value) => value is not null
                : (parent, value) => value is not null && alreadyDeclared(parent, value);
        }
    }
}
