using System.Runtime.CompilerServices;
using System.Text.Json;
using AGUI.Abstractions;
using AGUI.Samples.Shared;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;

using JsonOptions = Microsoft.AspNetCore.Http.Json.JsonOptions;

namespace CrossLanguage.TestServer;

internal static class StateRoutes
{
    // shared_state and predictive_state_updates exercise the C# server's
    // ability to emit STATE_SNAPSHOT / STATE_DELTA events. We deliberately
    // skip the LLM here — the wire-format contract is what matters and the
    // LLM-driven state derivation path is already covered by the existing
    // Step05_StateManagement integration tests. Each route emits canned
    // state events the TS client (or any AG-UI client) can subscribe to.
    //
    // Both routes use the negotiating AGUIResults.Events so the same events are
    // served over SSE or protobuf based on the request Accept header (every event
    // they emit — Run*/State*/TextMessage* — is in the protobuf-supported subset).

    /// <summary>
    /// Mirrors the dojo's shared-state agent: returns a single
    /// STATE_SNAPSHOT containing a complete recipe document, then a short
    /// follow-up assistant message.
    /// </summary>
    public static IEndpointConventionBuilder MapSharedState(
        this IEndpointRouteBuilder endpoints,
        string pattern)
    {
        return endpoints.MapPost(pattern, (
            [FromBody] RunAgentInput input,
            [FromServices] IOptions<JsonOptions> jsonOptions,
            HttpContext httpContext,
            CancellationToken cancellationToken) =>
        {
            return AGUIResults.Events(
                EmitSharedStateAsync(input, jsonOptions.Value.SerializerOptions, cancellationToken),
                httpContext,
                cancellationToken);
        });
    }

    /// <summary>
    /// Mirrors the dojo's predictive-state-updates agent: streams several
    /// STATE_DELTA events as if a tool's arguments were being filled in
    /// chunk-by-chunk (JSON Patch add operations on /document).
    /// </summary>
    public static IEndpointConventionBuilder MapPredictiveState(
        this IEndpointRouteBuilder endpoints,
        string pattern)
    {
        return endpoints.MapPost(pattern, (
            [FromBody] RunAgentInput input,
            HttpContext httpContext,
            CancellationToken cancellationToken) =>
        {
            return AGUIResults.Events(
                EmitPredictiveStateAsync(input, cancellationToken),
                httpContext,
                cancellationToken);
        });
    }

    private static async IAsyncEnumerable<BaseEvent> EmitSharedStateAsync(
        RunAgentInput input,
        JsonSerializerOptions jsonSerializerOptions,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        yield return new RunStartedEvent
        {
            ThreadId = input.ThreadId,
            RunId = input.RunId,
        };

        var recipe = new
        {
            recipe = new
            {
                title = "Pasta al Limone",
                skill_level = "beginner",
                cooking_time = "20 minutes",
                ingredients = new[]
                {
                    new { name = "spaghetti", amount = "400g" },
                    new { name = "lemon", amount = "2" },
                    new { name = "parmesan", amount = "100g" },
                },
                instructions = new[]
                {
                    "Bring a large pot of salted water to a boil",
                    "Cook the spaghetti until al dente",
                    "Zest and juice the lemons",
                    "Toss the pasta with the lemon and parmesan",
                },
            },
        };

        var snapshot = JsonSerializer.SerializeToElement(recipe, jsonSerializerOptions);

        yield return new StateSnapshotEvent
        {
            Snapshot = snapshot,
        };

        string messageId = $"msg-{input.RunId}";
        yield return new TextMessageStartEvent
        {
            MessageId = messageId,
            Role = AGUIRoles.Assistant,
        };
        yield return new TextMessageContentEvent
        {
            MessageId = messageId,
            Delta = "Recipe ready.",
        };
        yield return new TextMessageEndEvent
        {
            MessageId = messageId,
        };

        yield return new RunFinishedEvent
        {
            ThreadId = input.ThreadId,
            RunId = input.RunId,
        };

        await Task.CompletedTask.ConfigureAwait(false);
    }

    private static async IAsyncEnumerable<BaseEvent> EmitPredictiveStateAsync(
        RunAgentInput input,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        yield return new RunStartedEvent
        {
            ThreadId = input.ThreadId,
            RunId = input.RunId,
        };

        // Simulate the streaming construction of a document by emitting
        // multiple JSON Patch "add" deltas on /document. The TS client
        // subscriber receives them as STATE_DELTA events in order, and
        // applies the patches to its local state.
        string[] paragraphs =
        [
            "Once upon a time, ",
            "in a far-away land, ",
            "there lived a dragon named Atlantis. ",
            "Every morning Atlantis would soar over the clouds.",
        ];

        string document = "";
        for (int i = 0; i < paragraphs.Length; i++)
        {
            string nextDoc = document + paragraphs[i];
            // JSON Patch operations are an array of operations.
            string patchJson = JsonSerializer.Serialize(new[]
            {
                new
                {
                    op = i == 0 ? "add" : "replace",
                    path = "/document",
                    value = nextDoc,
                },
            });
            yield return new StateDeltaEvent
            {
                Delta = JsonDocument.Parse(patchJson).RootElement,
            };
            document = nextDoc;
        }

        yield return new RunFinishedEvent
        {
            ThreadId = input.ThreadId,
            RunId = input.RunId,
        };

        await Task.CompletedTask.ConfigureAwait(false);
    }
}
