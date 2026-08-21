using System;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using AGUI.Abstractions;
using AGUI.Client;
using Xunit;

namespace AGUI.Client.UnitTests;

/// <summary>
/// <see cref="AGUIChatClient"/> composes a caller's <see cref="JsonSerializerOptions"/> and then
/// serializes AG-UI wire types through them — resume payloads, most visibly. These options must
/// therefore carry the omit-a-field-that-has-no-value rule no matter what the caller already put
/// in their resolver chain.
/// </summary>
/// <remarks>
/// The rule travels on <see cref="AGUIJsonUtilities.DefaultTypeInfoResolver"/>, not on the bare
/// source-generated context, and only if nothing ahead of it in the chain answers for AG-UI types
/// first. Both halves are easy to get wrong in a way no other test would notice, which is what
/// these cases pin down.
/// </remarks>
public sealed class CombinedJsonSerializerOptionsNullOmissionTest
{
    private static string SerializeToolCallStart(JsonSerializerOptions options) =>
        JsonSerializer.Serialize(
            new ToolCallStartEvent { ToolCallId = "tc_1", ToolCallName = "search" },
            options.GetTypeInfo(typeof(BaseEvent)));

    [Fact]
    public void CallerWithNoResolversGetsOmission()
    {
        var combined = AGUIChatClient.CombineJsonSerializerOptions(new JsonSerializerOptions());

        Assert.DoesNotContain("parentMessageId", SerializeToolCallStart(combined), StringComparison.Ordinal);
    }

    [Fact]
    public void CallerAlreadyHoldingTheBareContextStillGetsOmission()
    {
        // A caller who followed the older guidance and inserted AGUIJsonSerializerContext.Default
        // themselves. The bare context answers for AG-UI types but does not carry the omission, so
        // finding it in the chain is not a reason to skip prepending the resolver that does.
        var callerOwned = new JsonSerializerOptions();
        callerOwned.TypeInfoResolverChain.Add(AGUIJsonSerializerContext.Default);

        var combined = AGUIChatClient.CombineJsonSerializerOptions(callerOwned);

        Assert.DoesNotContain("parentMessageId", SerializeToolCallStart(combined), StringComparison.Ordinal);
    }

    [Fact]
    public void CallerHoldingTheResolverBehindAnotherResolverStillGetsOmission()
    {
        // Order decides the outcome: the bare context sits ahead here and would answer for AG-UI
        // types itself, nulls and all, if the wrapped resolver were merely "present" rather than
        // first.
        var callerOwned = new JsonSerializerOptions();
        callerOwned.TypeInfoResolverChain.Add(AGUIJsonSerializerContext.Default);
        callerOwned.TypeInfoResolverChain.Add(AGUIJsonUtilities.DefaultTypeInfoResolver);

        var combined = AGUIChatClient.CombineJsonSerializerOptions(callerOwned);

        Assert.DoesNotContain("parentMessageId", SerializeToolCallStart(combined), StringComparison.Ordinal);
    }

    [Fact]
    public void CallerExplicitlyDisablingOmissionStillGetsOmissionForAGUITypes()
    {
        var callerOwned = new JsonSerializerOptions { DefaultIgnoreCondition = JsonIgnoreCondition.Never };

        var combined = AGUIChatClient.CombineJsonSerializerOptions(callerOwned);

        Assert.DoesNotContain("parentMessageId", SerializeToolCallStart(combined), StringComparison.Ordinal);
    }

    [Fact]
    public void CombiningIsIdempotent()
    {
        var once = AGUIChatClient.CombineJsonSerializerOptions(new JsonSerializerOptions());
        var twice = AGUIChatClient.CombineJsonSerializerOptions(once);

        Assert.Equal(
            1,
            twice.TypeInfoResolverChain.Count(r => r == AGUIJsonUtilities.DefaultTypeInfoResolver));
    }

    [Fact]
    public void ResumePayloadOmitsItsUnsetFields()
    {
        // The concrete payload AGUIChatClient builds through these options when a tool approval is
        // declined: no tool call info, no result. Both must be absent rather than null, since this
        // object is nested inside the RunAgentInput that goes back over HTTP — where the outer
        // serialization would happily carry a nested null straight to the agent.
        var combined = AGUIChatClient.CombineJsonSerializerOptions(new JsonSerializerOptions());

        var json = JsonSerializer.Serialize(
            new AGUIToolApprovalResumePayload { Approved = false },
            combined.GetTypeInfo(typeof(AGUIToolApprovalResumePayload)));

        Assert.Equal("""{"approved":false}""", json);
    }

    [Fact]
    public void TheRuleIsScopedToAGUITypes()
    {
        // The omission is attached by a type-info modifier on the AG-UI resolver rather than by
        // setting DefaultIgnoreCondition on the caller's options, so it can only ever reach types
        // that resolver answers for. It declines everything else, which is why a caller's own
        // models keep serializing their nulls exactly as the caller asked.
        var typeInfo = AGUIJsonUtilities.DefaultTypeInfoResolver.GetTypeInfo(
            typeof(CallerModel),
            AGUIJsonSerializerContext.Default.Options);

        Assert.Null(typeInfo);
    }

    private sealed class CallerModel
    {
        public string? Note { get; set; }
    }
}
