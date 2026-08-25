using System.Net.ServerSentEvents;
using System.Text.Json;
using AGUI.Abstractions;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;

using JsonOptions = Microsoft.AspNetCore.Http.Json.JsonOptions;

namespace CrossLanguage.TestServer;

internal static class HumanInTheLoopRoute
{
    // Mirrors the dojo humanInTheLoopPage flow: first turn the agent
    // surfaces an interrupt asking the user to approve a plan; second turn
    // the client posts a resume payload (approved or rejected) and the
    // agent finishes with a confirmation message that reflects the choice.
    public static IEndpointConventionBuilder MapHumanInTheLoop(
        this IEndpointRouteBuilder endpoints,
        string pattern)
    {
        return endpoints.MapPost(pattern, (
            [FromBody] RunAgentInput input,
            [FromServices] IOptions<JsonOptions> jsonOptions,
            CancellationToken cancellationToken) =>
        {
            return TypedResults.ServerSentEvents(EmitAsync(input, jsonOptions.Value.SerializerOptions, cancellationToken));
        });
    }

    private const string InterruptId = "interrupt-plan-approval";
    private const string PlanText =
        "I plan to: 1) gather ingredients, 2) preheat the oven, 3) bake the cake.";

    private static async IAsyncEnumerable<SseItem<BaseEvent>> EmitAsync(
        RunAgentInput input,
        JsonSerializerOptions jsonSerializerOptions,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken)
    {
        yield return new SseItem<BaseEvent>(new RunStartedEvent
        {
            ThreadId = input.ThreadId,
            RunId = input.RunId,
        });

        bool hasResume = input.Resume is { Count: > 0 };

        if (!hasResume)
        {
            // First turn: explain the proposed plan, then suspend with an
            // interrupt that requests approval.
            string messageId = $"msg-plan-{input.RunId}";
            yield return new SseItem<BaseEvent>(new TextMessageStartEvent
            {
                MessageId = messageId,
                Role = AGUIRoles.Assistant,
            });
            yield return new SseItem<BaseEvent>(new TextMessageContentEvent
            {
                MessageId = messageId,
                Delta = PlanText,
            });
            yield return new SseItem<BaseEvent>(new TextMessageEndEvent
            {
                MessageId = messageId,
            });

            yield return new SseItem<BaseEvent>(new RunFinishedEvent
            {
                ThreadId = input.ThreadId,
                RunId = input.RunId,
                Outcome = new RunFinishedInterruptOutcome
                {
                    Interrupts =
                    {
                        new AGUIInterrupt
                        {
                            Id = InterruptId,
                            Reason = InterruptReasons.Confirmation,
                            Message = "Do you approve this plan?",
                        },
                    },
                },
            });
            yield break;
        }

        // Second turn: read the approval status from the resume payload and
        // continue accordingly. Tests can drive either branch.
        AGUIResume resume = input.Resume![0];
        bool approved = false;
        if (resume.Payload is { ValueKind: JsonValueKind.Object } payload &&
            payload.TryGetProperty("approved", out JsonElement approvedElem) &&
            approvedElem.ValueKind is JsonValueKind.True or JsonValueKind.False)
        {
            approved = approvedElem.GetBoolean();
        }

        string finalMessageId = $"msg-final-{input.RunId}";
        yield return new SseItem<BaseEvent>(new TextMessageStartEvent
        {
            MessageId = finalMessageId,
            Role = AGUIRoles.Assistant,
        });
        yield return new SseItem<BaseEvent>(new TextMessageContentEvent
        {
            MessageId = finalMessageId,
            Delta = approved
                ? "Approved. Executing the plan now."
                : "Plan rejected. Awaiting new instructions.",
        });
        yield return new SseItem<BaseEvent>(new TextMessageEndEvent
        {
            MessageId = finalMessageId,
        });

        yield return new SseItem<BaseEvent>(new RunFinishedEvent
        {
            ThreadId = input.ThreadId,
            RunId = input.RunId,
            Outcome = new RunFinishedSuccessOutcome(),
        });

        await Task.CompletedTask.ConfigureAwait(false);

        _ = jsonSerializerOptions; // Reserved for future use (structured payload validation).
    }
}
