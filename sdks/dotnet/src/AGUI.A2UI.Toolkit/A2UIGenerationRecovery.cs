using System.Text.Json.Nodes;

namespace AGUI.A2UI;

/// <summary>
/// The A2UI validate-and-retry generation loop, mirroring
/// <c>runA2UIGenerationWithRecovery</c> / <c>run_a2ui_generation_with_recovery</c> in the sibling toolkits.
/// </summary>
/// <remarks>
/// Each attempt invokes the subagent, validates the structured tool output, and either
/// returns the built envelope (first valid attempt wins) or retries with the prior
/// attempt's errors appended to the prompt. A missing tool call counts as a failed,
/// retryable attempt. After the attempt cap is reached, a structured hard-failure
/// envelope is returned instead of throwing, so the conversation stays usable.
/// </remarks>
public static class A2UIGenerationRecovery
{
    internal static readonly A2UIValidationError NoToolCallError = new(
        A2UIValidationErrorCodes.EmptyComponents,
        "components",
        "Sub-agent did not call render_a2ui");

    /// <summary>
    /// Formats validation errors as a compact, model-readable list
    /// (<c>- [code] path: message</c> per line).
    /// </summary>
    /// <param name="errors">The errors to format.</param>
    /// <returns>The formatted block.</returns>
    public static string FormatValidationErrors(IEnumerable<A2UIValidationError> errors)
    {
        ArgumentNullException.ThrowIfNull(errors);
        return string.Join("\n", errors.Select(e => $"- [{e.Code}] {e.Path}: {e.Message}"));
    }

    /// <summary>
    /// Appends a fix-it block carrying <paramref name="errors"/> to <paramref name="prompt"/>.
    /// Returns the prompt unchanged when there are no errors.
    /// </summary>
    /// <param name="prompt">The base subagent prompt.</param>
    /// <param name="errors">The prior attempt's validation errors.</param>
    /// <returns>The augmented prompt.</returns>
    public static string AugmentPromptWithValidationErrors(string prompt, IReadOnlyList<A2UIValidationError> errors)
    {
        ArgumentNullException.ThrowIfNull(errors);
        return errors.Count == 0
            ? prompt
            : $"{prompt}\n\n## Previous attempt was invalid — fix these and regenerate:\n{FormatValidationErrors(errors)}\n";
    }

    /// <summary>
    /// Runs the validate-and-retry loop until a valid surface is produced or the attempt cap is reached.
    /// </summary>
    /// <param name="basePrompt">The subagent system prompt produced by request preparation.</param>
    /// <param name="invokeSubagentAsync">
    /// Invokes the subagent with the (possibly error-augmented) prompt and the 1-based attempt
    /// number, returning the structured <c>render_a2ui</c> tool arguments, or <see langword="null"/>
    /// when the model did not call the tool.
    /// </param>
    /// <param name="buildEnvelope">Builds the final operations envelope from validated tool arguments.</param>
    /// <param name="catalog">The catalog used for semantic validation, when available.</param>
    /// <param name="config">Loop configuration overrides.</param>
    /// <param name="onAttempt">Observability callback invoked after each attempt is validated.</param>
    /// <param name="cancellationToken">A token to cancel the loop between attempts.</param>
    /// <returns>The loop outcome.</returns>
    public static async Task<A2UIRecoveryResult> RunAsync(
        string basePrompt,
        Func<string, int, CancellationToken, ValueTask<JsonObject?>> invokeSubagentAsync,
        Func<JsonObject, string> buildEnvelope,
        A2UIValidationCatalog? catalog = null,
        A2UIRecoveryConfig? config = null,
        Action<A2UIAttemptRecord>? onAttempt = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(basePrompt);
        ArgumentNullException.ThrowIfNull(invokeSubagentAsync);
        ArgumentNullException.ThrowIfNull(buildEnvelope);

        int maxAttempts = ResolveMaxAttempts(config);
        List<A2UIAttemptRecord> attempts = [];
        IReadOnlyList<A2UIValidationError> lastErrors = [];

        for (int attempt = 1; attempt <= maxAttempts; attempt++)
        {
            cancellationToken.ThrowIfCancellationRequested();

            string prompt = AugmentPromptWithValidationErrors(basePrompt, lastErrors);
            JsonObject? args = await invokeSubagentAsync(prompt, attempt, cancellationToken).ConfigureAwait(false);

            A2UIAttemptRecord record = ValidateAttempt(attempt, args, catalog);
            attempts.Add(record);
            onAttempt?.Invoke(record);

            if (record.Ok)
            {
                return new A2UIRecoveryResult(buildEnvelope(args!), attempts, Ok: true);
            }

            lastErrors = record.Errors;
        }

        return new A2UIRecoveryResult(WrapRecoveryExhaustedEnvelope(maxAttempts, attempts), attempts, Ok: false);
    }

    /// <summary>
    /// Resolves the attempt cap, falling back to <see cref="A2UIConstants.MaxA2UIAttempts"/>
    /// when the configured value is unset or non-positive. A zero/negative cap would skip the
    /// loop entirely and emit a confusing "0 attempt(s)" envelope, so it is treated as unset
    /// rather than honored. Shared by both generation paths.
    /// </summary>
    /// <remarks>
    /// Public so a hand-rolled integration can build its own generation loop from the same
    /// primitives <see cref="RunAsync"/> uses — notably a STREAMING loop, which
    /// <see cref="RunAsync"/> does not cover. See also
    /// <see cref="AugmentPromptWithValidationErrors"/>, <see cref="ValidateAttempt"/> and
    /// <see cref="WrapRecoveryExhaustedEnvelope"/>.
    /// </remarks>
    public static int ResolveMaxAttempts(A2UIRecoveryConfig? config)
        => config?.MaxAttempts is int max && max > 0 ? max : A2UIConstants.MaxA2UIAttempts;

    /// <summary>
    /// Validates one attempt's structured <c>render_a2ui</c> arguments, narrowing the untrusted
    /// model output to the expected component/data shapes. A null <paramref name="args"/> (the
    /// subagent did not call the tool) is a failed, retryable attempt. Shared by the
    /// non-streaming loop and the streaming twin in <c>A2UIChatClient</c> so the two cannot
    /// drift on attempt semantics.
    /// </summary>
    public static A2UIAttemptRecord ValidateAttempt(int attempt, JsonObject? args, A2UIValidationCatalog? catalog)
    {
        if (args is null)
        {
            return new A2UIAttemptRecord(attempt, Ok: false, [NoToolCallError]);
        }

        JsonArray? components = args["components"] as JsonArray;
        JsonObject? data = args["data"] as JsonObject;
        A2UIValidationResult result = A2UIComponentValidator.Validate(components, data, catalog);
        return new A2UIAttemptRecord(attempt, result.Valid, result.Errors);
    }

    /// <summary>
    /// Builds the structured <c>a2ui_recovery_exhausted</c> envelope returned when every attempt
    /// failed validation, so an invalid surface never paints and the failure is renderable
    /// rather than thrown.
    /// </summary>
    public static string WrapRecoveryExhaustedEnvelope(int maxAttempts, IReadOnlyList<A2UIAttemptRecord> attempts)
    {
        var attemptsArray = new JsonArray();
        foreach (A2UIAttemptRecord attempt in attempts)
        {
            var errorsArray = new JsonArray();
            foreach (A2UIValidationError error in attempt.Errors)
            {
                errorsArray.Add((JsonNode)new JsonObject
                {
                    ["code"] = error.Code,
                    ["path"] = error.Path,
                    ["message"] = error.Message,
                });
            }

            attemptsArray.Add((JsonNode)new JsonObject
            {
                ["attempt"] = attempt.Attempt,
                ["ok"] = attempt.Ok,
                ["errors"] = errorsArray,
            });
        }

        return new JsonObject
        {
            ["error"] = $"Failed to generate valid A2UI after {maxAttempts} attempt(s)",
            ["code"] = "a2ui_recovery_exhausted",
            ["attempts"] = attemptsArray,
        }.ToJsonString();
    }
}
