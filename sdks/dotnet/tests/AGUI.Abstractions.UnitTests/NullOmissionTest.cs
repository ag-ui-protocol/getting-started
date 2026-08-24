using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

/// <summary>
/// Guards the rule that a producer omits a field with no value instead of writing
/// <c>null</c> for it.
/// </summary>
/// <remarks>
/// <para>
/// The omission comes from a single place — <c>DefaultIgnoreCondition</c> on
/// <see cref="AGUIJsonSerializerContext"/> — rather than a
/// <c>[JsonIgnore(WhenWritingNull)]</c> attribute repeated on every nullable property. An
/// attribute has to be remembered on each new property; the day one is forgotten, that
/// property emits a <c>null</c> and receiving SDKs reject the run. Three such nulls have
/// already had to be tolerated on the receiving side.
/// </para>
/// <para>
/// <see cref="EveryWireTypeOmitsPropertiesWithoutAValue"/> discovers the types to check by
/// reflection, so a wire type added later is covered without anyone editing this file.
/// <see cref="RevertingTheContextWideSettingReintroducesTheNulls"/> serializes the same
/// probes without that setting and requires the nulls to come back — otherwise a passing
/// sweep would not prove the setting is what does the work.
/// </para>
/// </remarks>
public sealed class NullOmissionTest
{
    [Fact]
    public void EveryWireTypeOmitsPropertiesWithoutAValue()
    {
        var wireTypes = NullOmissionProbe.DiscoverWireTypes();
        Assert.True(wireTypes.Count > 30, $"reflection found only {wireTypes.Count} wire types");

        var offenders = new List<string>();

        foreach (var type in wireTypes)
        {
            var probe = NullOmissionProbe.Create(type);
            var json = JsonSerializer.Serialize(
                probe,
                AGUIJsonSerializerContext.Default.GetTypeInfo(type)!);

            using var document = JsonDocument.Parse(json);
            foreach (var path in NullOmissionProbe.FindNullPaths(document.RootElement))
            {
                offenders.Add($"{type.Name}{path}");
            }
        }

        Assert.Empty(offenders);
    }

    [Fact]
    public void EveryEventOmitsPropertiesWithoutAValueWhenWrittenAsBaseEvent()
    {
        // The producer path (SSE formatter, HTTP transport) always writes through the
        // BaseEvent type info, which dispatches via BaseEventJsonConverter. Cover that
        // route separately from serializing each concrete type directly.
        var eventTypes = NullOmissionProbe.DiscoverWireTypes()
            .Where(type => typeof(BaseEvent).IsAssignableFrom(type))
            .ToList();
        Assert.True(eventTypes.Count > 20, $"reflection found only {eventTypes.Count} event types");

        var offenders = new List<string>();

        foreach (var type in eventTypes)
        {
            var probe = (BaseEvent)NullOmissionProbe.Create(type);
            var json = JsonSerializer.Serialize(probe, AGUIJsonSerializerContext.Default.BaseEvent);

            using var document = JsonDocument.Parse(json);
            foreach (var path in NullOmissionProbe.FindNullPaths(document.RootElement))
            {
                offenders.Add($"{type.Name}{path}");
            }
        }

        Assert.Empty(offenders);
    }

    [Fact]
    public void EveryWireTypeOmitsPropertiesWithoutAValueThroughCallerOwnedOptions()
    {
        // Same sweep, resolved the way a host application composes AG-UI types into its own
        // JsonSerializerOptions.
        var callerOwned = new JsonSerializerOptions();
        callerOwned.TypeInfoResolverChain.Insert(0, AGUIJsonUtilities.DefaultTypeInfoResolver);

        var offenders = new List<string>();

        foreach (var type in NullOmissionProbe.DiscoverWireTypes())
        {
            var probe = NullOmissionProbe.Create(type);
            var json = JsonSerializer.Serialize(probe, type, callerOwned);

            using var document = JsonDocument.Parse(json);
            foreach (var path in NullOmissionProbe.FindNullPaths(document.RootElement))
            {
                offenders.Add($"{type.Name}{path}");
            }
        }

        Assert.Empty(offenders);
    }

    [Fact]
    public void RevertingTheContextWideSettingReintroducesTheNulls()
    {
        // Same types, same probes, resolved without the context's DefaultIgnoreCondition.
        // Every null this brings back is a null the setting is currently suppressing.
        var reverted = new JsonSerializerOptions
        {
            TypeInfoResolver = new DefaultJsonTypeInfoResolver(),
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        };

        var typesWithRevertedNulls = new List<string>();

        foreach (var type in NullOmissionProbe.DiscoverWireTypes())
        {
            var probe = NullOmissionProbe.Create(type);

            string json;
            try
            {
                json = JsonSerializer.Serialize(probe, type, reverted);
            }
            catch (Exception)
            {
                // A type whose shape depends on the source-generated metadata (a custom
                // converter reaching for a registered type info, say) cannot be serialized
                // this way at all. It contributes nothing either way.
                continue;
            }

            using var document = JsonDocument.Parse(json);
            if (NullOmissionProbe.FindNullPaths(document.RootElement).Count > 0)
            {
                typesWithRevertedNulls.Add(type.Name);
            }
        }

        Assert.True(
            typesWithRevertedNulls.Count > 20,
            "Reverting DefaultIgnoreCondition should reintroduce nulls across the wire types, " +
            $"but only {typesWithRevertedNulls.Count} type(s) changed: " +
            $"{string.Join(", ", typesWithRevertedNulls)}. Either the sweep above is passing " +
            "for some other reason, or per-property [JsonIgnore(WhenWritingNull)] attributes " +
            "have crept back in and the context-wide setting is no longer load-bearing.");
    }

    [Fact]
    public void NoPerPropertyNullIgnoreAttributesOutsideTheAllowlist()
    {
        // The omission rule lives in ONE place — DefaultIgnoreCondition on the
        // context — and this asserts nobody quietly reintroduces the per-property
        // spelling. A re-added [JsonIgnore(WhenWritingNull)] is not a harmless
        // duplicate: while it is present, a green sweep above no longer proves the
        // context-wide setting works, which is how three wire bugs stayed hidden
        // the first time. This is not hypothetical either — within days of the
        // sweep landing, new feature work reintroduced fourteen of them.
        //
        // Allowlist: the interrupt content types are registered onto caller-owned
        // JsonSerializerOptions and cannot inherit the context's setting, so their
        // attributes are load-bearing. See the comments on those classes.
        var allowlist = new HashSet<Type> { typeof(InterruptRequestContent), typeof(InterruptResponseContent) };

        var offenders = typeof(BaseEvent).Assembly
            .GetTypes()
            .Where(type => !allowlist.Contains(type))
            .SelectMany(type => type.GetProperties(
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly))
            .Where(property => property
                .GetCustomAttributes<JsonIgnoreAttribute>()
                .Any(attribute => attribute.Condition == JsonIgnoreCondition.WhenWritingNull))
            .Select(property => $"{property.DeclaringType!.Name}.{property.Name}")
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToList();

        Assert.Empty(offenders);
    }

    [Fact]
    public void OmissionSurvivesCallerOwnedSerializerOptions()
    {
        // Composing AG-UI types into caller-owned options means inserting a resolver, not
        // copying the context's options — DefaultIgnoreCondition does not travel that way.
        // AGUIJsonUtilities.DefaultTypeInfoResolver is what carries the rule across, and
        // AGUIChatClient uses it for exactly this reason.
        var callerOwned = new JsonSerializerOptions
        {
            DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        };
        callerOwned.TypeInfoResolverChain.Insert(0, AGUIJsonUtilities.DefaultTypeInfoResolver);

        var json = JsonSerializer.Serialize<BaseEvent>(
            new ToolCallStartEvent { ToolCallId = "tc_1", ToolCallName = "search" },
            callerOwned);

        Assert.DoesNotContain("parentMessageId", json, StringComparison.Ordinal);
    }

    [Fact]
    public void RawContextInsertedIntoCallerOwnedOptionsIsNotEnough()
    {
        // The trap the resolver above exists to avoid, pinned so nobody "simplifies" the
        // resolver away: the source-generated context on its own does not carry the
        // omission into a foreign options instance.
        var withoutResolver = new JsonSerializerOptions();
        withoutResolver.TypeInfoResolverChain.Insert(0, AGUIJsonSerializerContext.Default);

        var json = JsonSerializer.Serialize<BaseEvent>(
            new ToolCallStartEvent { ToolCallId = "tc_1", ToolCallName = "search" },
            withoutResolver);

        Assert.True(
            json.Contains("\"parentMessageId\":null", StringComparison.Ordinal),
            "Expected the bare context to still emit the null in foreign options, but it " +
            $"produced {json}. If System.Text.Json now propagates the context's " +
            "DefaultIgnoreCondition through TypeInfoResolverChain, this test has served its " +
            "purpose: delete it, and consider whether AGUIJsonUtilities.DefaultTypeInfoResolver " +
            "is still needed. Do not remove the resolver on the strength of this test alone — " +
            "check the minimum supported runtime, not just the one running here.");
    }

    [Fact]
    public void CallerOwnedOptionsKeepNullsThatAreValues()
    {
        var callerOwned = new JsonSerializerOptions();
        callerOwned.TypeInfoResolverChain.Insert(0, AGUIJsonUtilities.DefaultTypeInfoResolver);

        var snapshot = JsonSerializer.Deserialize<JsonElement>("""{"selectedId":null}""");
        var json = JsonSerializer.Serialize<BaseEvent>(
            new StateSnapshotEvent { Snapshot = snapshot },
            callerOwned);

        Assert.Contains("\"selectedId\":null", json, StringComparison.Ordinal);
    }

    [Fact]
    public void ToolCallStartOmitsParentMessageIdWhenItHasNoValue()
    {
        // The specific null that broke TypeScript clients on the first tool call.
        var json = JsonSerializer.Serialize(
            new ToolCallStartEvent { ToolCallId = "tc_1", ToolCallName = "search" },
            AGUIJsonSerializerContext.Default.BaseEvent);

        Assert.DoesNotContain("parentMessageId", json, StringComparison.Ordinal);
    }

    [Fact]
    public void RunFinishedOmitsOutcomeWhenItHasNoValue()
    {
        var json = JsonSerializer.Serialize(
            new RunFinishedEvent { ThreadId = "thread_1", RunId = "run_1" },
            AGUIJsonSerializerContext.Default.BaseEvent);

        Assert.DoesNotContain("outcome", json, StringComparison.Ordinal);
    }

    [Fact]
    public void NullsInsideAnOpaquePayloadAreValuesAndSurvive()
    {
        // Omission is about fields with no value, not about null as a value.
        var snapshot = JsonSerializer.Deserialize<JsonElement>(
            """{"selectedId":null,"items":[null,1]}""");

        var json = JsonSerializer.Serialize(
            new StateSnapshotEvent { Snapshot = snapshot },
            AGUIJsonSerializerContext.Default.BaseEvent);

        Assert.Contains("\"selectedId\":null", json, StringComparison.Ordinal);
        Assert.Contains("[null,1]", json, StringComparison.Ordinal);
    }
}

/// <summary>
/// Builds "has no value" probes: every property the contract requires is filled in, every
/// optional property is left unset. What reaches the JSON is then exactly the question this
/// test file asks.
/// </summary>
internal static class NullOmissionProbe
{
    private static readonly NullabilityInfoContext NullabilityContext = new();

    /// <summary>
    /// Every public, concrete, parameterless-constructible type in AGUI.Abstractions that
    /// <see cref="AGUIJsonSerializerContext"/> knows how to write — that is, the AG-UI wire
    /// surface, discovered rather than listed.
    /// </summary>
    internal static IReadOnlyList<Type> DiscoverWireTypes()
    {
        return typeof(BaseEvent).Assembly
            .GetExportedTypes()
            .Where(type =>
                type is { IsClass: true, IsAbstract: false, IsGenericTypeDefinition: false } &&
                type.GetConstructor(Type.EmptyTypes) is not null &&
                AGUIJsonSerializerContext.Default.GetTypeInfo(type) is not null)
            .OrderBy(type => type.FullName, StringComparer.Ordinal)
            .ToList();
    }

    internal static object Create(Type type)
    {
        var instance = Activator.CreateInstance(type)
            ?? throw new InvalidOperationException($"Could not construct {type.Name}.");

        foreach (var property in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (property.SetMethod is null || !property.SetMethod.IsPublic)
            {
                continue;
            }

            if (IsOptional(property))
            {
                // The point of the probe: leave it unset and see whether it reaches the wire.
                continue;
            }

            var value = SampleFor(property.PropertyType);
            if (value is not null)
            {
                property.SetValue(instance, value);
            }
        }

        return instance;
    }

    /// <summary>
    /// Collects the paths of every JSON <c>null</c> under <paramref name="element"/>.
    /// </summary>
    internal static IReadOnlyList<string> FindNullPaths(JsonElement element, string path = "")
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Null:
                return [path.Length == 0 ? "/" : path];

            case JsonValueKind.Object:
                var fromObject = new List<string>();
                foreach (var property in element.EnumerateObject())
                {
                    fromObject.AddRange(FindNullPaths(property.Value, $"{path}/{property.Name}"));
                }

                return fromObject;

            case JsonValueKind.Array:
                var fromArray = new List<string>();
                var index = 0;
                foreach (var item in element.EnumerateArray())
                {
                    fromArray.AddRange(FindNullPaths(item, $"{path}/{index}"));
                    index++;
                }

                return fromArray;

            default:
                return [];
        }
    }

    /// <summary>
    /// A property is optional — "may have no value" — when it is a nullable reference type
    /// or a <see cref="Nullable{T}"/>. Those are the properties whose absence must not turn
    /// into a <c>null</c> on the wire.
    /// </summary>
    private static bool IsOptional(PropertyInfo property)
    {
        if (Nullable.GetUnderlyingType(property.PropertyType) is not null)
        {
            return true;
        }

        if (property.PropertyType.IsValueType)
        {
            return false;
        }

        return NullabilityContext.Create(property).WriteState == NullabilityState.Nullable;
    }

    private static object? SampleFor(Type type)
    {
        if (type == typeof(string))
        {
            return "x";
        }

        if (type == typeof(JsonElement))
        {
            return JsonSerializer.Deserialize<JsonElement>("{}");
        }

        if (type.IsValueType)
        {
            return null; // Already a usable default (0, false, empty JsonElement).
        }

        if (typeof(IEnumerable).IsAssignableFrom(type))
        {
            return null; // Collection properties on wire types initialize themselves to empty.
        }

        return type.GetConstructor(Type.EmptyTypes) is null ? null : Create(type);
    }
}
