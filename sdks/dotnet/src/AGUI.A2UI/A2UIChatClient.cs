using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using AGUI.Abstractions;
using AGUI.Server;
using Microsoft.Extensions.AI;

namespace AGUI.A2UI;

/// <summary>
/// An <see cref="IChatClient"/> decorator that adds A2UI (agent-generated UI) surface
/// generation. When injection is enabled for the run, the streamed run advertises a
/// <c>generate_a2ui</c> tool; when the wrapped model calls it, the decorator drives a
/// <c>render_a2ui</c> structured-output subagent through the shared validate-and-retry
/// recovery loop and feeds the resulting A2UI operations envelope back as the tool result.
/// </summary>
/// <remarks>
/// <para>
/// This is the ag-ui .NET adapter over the framework-agnostic toolkit
/// (<see cref="A2UIToolkit"/>, <see cref="A2UIGenerationRecovery"/>), matching the
/// LangGraph / Strands / Mastra adapters. The generation loop runs at the chat-client
/// level rather than through automatic function invocation so the inner <c>render_a2ui</c>
/// argument fragments reach the wire incrementally (progressive surface rendering) — the
/// same event shape the other adapters produce.
/// </para>
/// <para>
/// Place this <b>outside</b> function invocation in the pipeline
/// (<c>builder.UseA2UI(...).UseFunctionInvocation()</c>): the wrapped client invokes the
/// developer's own tools, while <c>generate_a2ui</c> surfaces as a terminal call this
/// decorator handles. The component catalog and the per-run <c>injectA2UITool</c> flag are
/// read from the forwarded <see cref="RunAgentInput"/> the AG-UI hosting layer stamps onto
/// <see cref="ChatOptions"/>.
/// </para>
/// </remarks>
public sealed class A2UIChatClient : DelegatingChatClient
{
    // Bare acknowledgement returned as the inner render_a2ui tool result; the painted
    // surface rides the streamed arguments, so the result only has to balance the call.
    private const string RenderAcknowledgement = "{\"status\":\"rendered\"}";

    // The cap on planner rounds (model turn -> generation -> result fed back) per run,
    // guarding against a planner that keeps requesting surfaces without terminating.
    internal const int MaxPlannerRounds = 8;

    private readonly IChatClient _subagentChatClient;
    private readonly A2UIResolvedToolParams _parameters;
    private readonly bool? _injectOption;
    private readonly string? _injectedRenderToolName;
    private readonly Func<ChatResponseUpdate, IEnumerable<AGUIToolCallArgumentFragment>?>? _streamingArgExtractor;

    /// <summary>
    /// Initializes a new instance of the <see cref="A2UIChatClient"/> class.
    /// </summary>
    /// <param name="innerClient">The chat client to wrap (typically already wrapping the
    /// developer's tools with function invocation).</param>
    /// <param name="subagentChatClient">
    /// The chat client used to run the UI-generation subagent. Must be a <b>raw</b> client
    /// (no automatic function invocation): the adapter reads the forced <c>render_a2ui</c>
    /// call's arguments directly rather than letting the call be invoked.
    /// </param>
    /// <param name="options">Behavior knobs; defaults are filled per the shared toolkit rules.</param>
    public A2UIChatClient(IChatClient innerClient, IChatClient subagentChatClient, A2UIChatClientOptions? options = null)
        : base(innerClient)
    {
        ArgumentNullException.ThrowIfNull(subagentChatClient);
        this._subagentChatClient = subagentChatClient;
        this._parameters = A2UIToolDefinitions.ResolveA2UIToolParams(options?.ToolParams);
        this._injectOption = options?.InjectA2UITool;
        this._injectedRenderToolName = options?.InjectedRenderToolName;
        this._streamingArgExtractor = options?.StreamingToolCallArgumentExtractor;
    }

    /// <inheritdoc/>
    /// <remarks>The non-streaming path buffers the streaming path so the two cannot drift.</remarks>
    public override async Task<ChatResponse> GetResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(messages);
        return await this.GetStreamingResponseAsync(messages, options, cancellationToken)
            .ToChatResponseAsync(cancellationToken)
            .ConfigureAwait(false);
    }

    /// <inheritdoc/>
    public override async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(messages);

        string toolName = this._parameters.ToolName;
        bool devWired = options?.Tools is { } tools &&
            tools.Any(t => string.Equals(t.Name, toolName, StringComparison.Ordinal));

        (bool inject, string renderToolName) = ResolveInjection(
            this._injectOption, this._injectedRenderToolName, options);

        // USER PREVAILS: a developer-wired generate_a2ui tool owns the behavior — do not
        // clobber it. Likewise honor a resolved opt-out. Either way, delegate untouched.
        if (devWired || !inject)
        {
            await foreach (ChatResponseUpdate update in base.InnerClient
                .GetStreamingResponseAsync(messages, options, cancellationToken)
                .ConfigureAwait(false))
            {
                yield return update;
            }

            yield break;
        }

        List<ChatMessage> history = messages.ToList();
        A2UIAgentState state = ReadAgentState(options);

        ChatOptions plannerOptions = options?.Clone() ?? new ChatOptions();
        var generateTool = new GenerateA2UIToolDeclaration(toolName, this._parameters.ToolDescription);

        // Drop the A2UI middleware's injected render proxy before advertising generate_a2ui. The
        // middleware adds render_a2ui to RunAgentInput.Tools in the SAME step that forwards
        // injectA2UITool, and the hosting layer maps those onto ChatOptions.Tools — so whenever
        // the flag arrives, the proxy does too. Left in place the planner would see both tools and
        // could call the proxy directly, painting a surface that skips the subagent and the
        // validate-and-retry loop entirely.
        plannerOptions.Tools = (plannerOptions.Tools ?? Enumerable.Empty<AITool>())
            .Where(t => !string.Equals(t.Name, renderToolName, StringComparison.Ordinal))
            .Append(generateTool)
            .ToList();

        for (int round = 1; round <= MaxPlannerRounds; round++)
        {
            var plannerUpdates = new List<ChatResponseUpdate>();
            await foreach (ChatResponseUpdate update in base.InnerClient
                .GetStreamingResponseAsync(history, plannerOptions, cancellationToken)
                .ConfigureAwait(false))
            {
                plannerUpdates.Add(update);
                yield return update;
            }

            // Coalesce the planner's streamed turn into whole messages so the history fed
            // back next round is faithful: assistant narration, the terminal generate_a2ui
            // call(s), AND any of the developer's own tool call/result pairs the inner
            // function-invocation layer resolved this turn. Hand-picking only text +
            // generate_a2ui (as an earlier version did) stranded the round-2 planner without
            // the tools it had just called and their results.
            IList<ChatMessage> plannerMessages = plannerUpdates.ToChatResponse().Messages;
            List<FunctionCallContent> generateCalls = plannerMessages
                .SelectMany(m => m.Contents)
                .OfType<FunctionCallContent>()
                .Where(c => string.Equals(c.Name, toolName, StringComparison.Ordinal))
                .ToList();

            if (generateCalls.Count == 0)
            {
                yield break;
            }

            // Record the planner's full turn before running the generations, so a same-round
            // create -> update finds the freshly created surface: each call's result is
            // appended to history immediately below. The terminal generate_a2ui call is left
            // unanswered here on purpose — its result is what the generation produces.
            history.AddRange(plannerMessages);

            foreach (FunctionCallContent call in generateCalls)
            {
                var envelopeBox = new StrongBox<JsonElement>();
                await foreach (ChatResponseUpdate update in this
                    .RunGenerateStreamingAsync(call, history, state, envelopeBox, cancellationToken)
                    .ConfigureAwait(false))
                {
                    yield return update;
                }

                var result = new FunctionResultContent(call.CallId, envelopeBox.Value);
                yield return new ChatResponseUpdate(ChatRole.Tool, [result]);
                history.Add(new ChatMessage(ChatRole.Tool, [result]));
            }
        }

        // The planner kept requesting generations through the round cap. Give it one final
        // turn to consume the last tool result and narrate, with the generate tool withheld
        // so it cannot request another surface — otherwise the run would end on an unanswered
        // tool result with no closing assistant message.
        ChatOptions closingOptions = options?.Clone() ?? new ChatOptions();
        await foreach (ChatResponseUpdate update in base.InnerClient
            .GetStreamingResponseAsync(history, closingOptions, cancellationToken)
            .ConfigureAwait(false))
        {
            yield return update;
        }
    }

    // Runs one generate_a2ui invocation with the validate-and-retry loop, streaming
    // the render subagent's updates (each retry is a fresh, visible subagent call) and
    // depositing the final envelope — operations, request error, or recovery-exhausted —
    // into envelopeBox.
    private async IAsyncEnumerable<ChatResponseUpdate> RunGenerateStreamingAsync(
        FunctionCallContent call,
        IReadOnlyList<ChatMessage> conversation,
        A2UIAgentState state,
        StrongBox<JsonElement> envelopeBox,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        string? intent = GetStringArgument(call.Arguments, "intent");
        string? targetSurfaceId = GetStringArgument(call.Arguments, "target_surface_id");
        string? changes = GetStringArgument(call.Arguments, "changes");

        List<A2UIHistoryMessage> historyMessages = conversation.Select(ToHistoryMessage).ToList();
        A2UIPreparedRequest prep = A2UIToolkit.PrepareA2UIRequest(
            intent, targetSurfaceId, changes, historyMessages, state, this._parameters.Guidelines);
        if (prep.Error is not null)
        {
            envelopeBox.Value = ParseEnvelope(A2UIToolkit.WrapErrorEnvelope(prep.Error));
            yield break;
        }

        // The streaming twin of A2UIGenerationRecovery.RunAsync: same attempt semantics,
        // but each subagent call streams so its updates can be forwarded between attempts.
        int maxAttempts = A2UIGenerationRecovery.ResolveMaxAttempts(this._parameters.Recovery);
        var attempts = new List<A2UIAttemptRecord>();
        IReadOnlyList<A2UIValidationError> lastErrors = [];
        for (int attempt = 1; attempt <= maxAttempts; attempt++)
        {
            cancellationToken.ThrowIfCancellationRequested();

            string prompt = A2UIGenerationRecovery.AugmentPromptWithValidationErrors(prep.Prompt, lastErrors);

            var attemptUpdates = new List<ChatResponseUpdate>();
            string? liveCallId = null;
            Exception? transientFailure = null;

            // Forward every update so hosting can paint the render_a2ui argument fragments
            // progressively; accumulate them to coalesce the complete tool call afterward.
            // A recoverable mid-stream provider error ends the attempt (a failed, retryable
            // attempt); the try/finally guarantees the streamed call is balanced on the wire.
            IAsyncEnumerator<ChatResponseUpdate> enumerator = this._subagentChatClient
                .GetStreamingResponseAsync(BuildSubagentMessages(prompt, conversation), CreateSubagentOptions(), cancellationToken)
                .GetAsyncEnumerator(cancellationToken);
            try
            {
                while (true)
                {
                    ChatResponseUpdate update;
                    try
                    {
                        if (!await enumerator.MoveNextAsync().ConfigureAwait(false))
                        {
                            break;
                        }

                        update = enumerator.Current;
                    }
                    catch (Exception ex) when (IsRecoverableSubagentError(ex, cancellationToken))
                    {
                        transientFailure = ex;
                        break;
                    }

                    attemptUpdates.Add(update);

                    // Learn the render call id as early as possible. The typed FunctionCallContent
                    // only appears once the call has fully coalesced, so on a mid-stream failure it
                    // never arrives; the streamed fragments carry the id on their first fragment.
                    // The sub-agent is forced to call only render_a2ui, so any fragment id is it.
                    liveCallId ??= update.Contents
                        .OfType<FunctionCallContent>()
                        .FirstOrDefault(c => string.Equals(c.Name, A2UIConstants.RenderA2UIToolName, StringComparison.Ordinal))
                        ?.CallId;
                    if (liveCallId is null && this._streamingArgExtractor is not null)
                    {
                        liveCallId = this._streamingArgExtractor(update)?
                            .FirstOrDefault(f => !string.IsNullOrEmpty(f.ToolCallId))?.ToolCallId;
                    }

                    yield return update;
                }
            }
            finally
            {
                await enumerator.DisposeAsync().ConfigureAwait(false);
            }

            FunctionCallContent? renderCall = attemptUpdates.ToChatResponse().Messages
                .SelectMany(m => m.Contents)
                .OfType<FunctionCallContent>()
                .FirstOrDefault(c => string.Equals(c.Name, A2UIConstants.RenderA2UIToolName, StringComparison.Ordinal));

            // Balance the render call on the wire. It was forwarded to the client, so it is
            // now part of the persisted conversation; an unanswered tool call would make the
            // next turn's history invalid (e.g. OpenAI rejects it). Emit a result even when
            // only fragments streamed before a failure, using the streamed call id.
            string? balanceCallId = renderCall?.CallId ?? liveCallId;
            if (balanceCallId is not null)
            {
                yield return new ChatResponseUpdate(
                    ChatRole.Tool,
                    [new FunctionResultContent(balanceCallId, ParseEnvelope(RenderAcknowledgement))]);
            }

            if (transientFailure is not null)
            {
                // A recoverable transient error is a failed, retryable attempt.
                var failed = new A2UIAttemptRecord(attempt, Ok: false, [ToTransientError(transientFailure)]);
                attempts.Add(failed);
                this._parameters.OnAttempt?.Invoke(failed);
                lastErrors = failed.Errors;
                continue;
            }

            JsonObject? renderArgs = renderCall?.Arguments is { } arguments ? ToJsonObject(arguments) : null;

            // Validation and attempt accounting are shared with the non-streaming recovery
            // loop so the two paths cannot drift on attempt semantics.
            A2UIAttemptRecord record = A2UIGenerationRecovery.ValidateAttempt(attempt, renderArgs, this._parameters.Catalog);
            attempts.Add(record);
            this._parameters.OnAttempt?.Invoke(record);

            if (record.Ok)
            {
                envelopeBox.Value = ParseEnvelope(A2UIToolkit.BuildA2UIEnvelope(
                    renderArgs!,
                    prep.IsUpdate,
                    targetSurfaceId,
                    prep.Prior,
                    this._parameters.DefaultSurfaceId,
                    this._parameters.DefaultCatalogId));
                yield break;
            }

            lastErrors = record.Errors;
        }

        envelopeBox.Value = ParseEnvelope(A2UIGenerationRecovery.WrapRecoveryExhaustedEnvelope(maxAttempts, attempts));
    }

    // Resolves the per-run injection decision. The forwarded runtime flag wins when present
    // (an explicit client false beats a backend opt-in); otherwise the
    // backend option; otherwise on, because wrapping is itself the opt-in.
    // Resolves the per-run injection decision plus the name of the middleware-injected render
    // proxy to drop. The forwarded runtime flag wins when present (an explicit client false beats
    // a backend opt-in); otherwise the backend option; otherwise off, matching the
    // "no injectA2UITool, no injection" contract the sibling adapters share — a host that does not
    // forward the flag opts in via the backend option (or an explicit .UseA2UI configuration).
    //
    // The wire flag is boolean | string (a string names the injected render proxy), and an empty
    // string is falsy in the TS/Python adapters, so it reads as an opt-out here too.
    internal static (bool Inject, string RenderToolName) ResolveInjection(
        bool? injectOption,
        string? injectedRenderToolName,
        ChatOptions? options)
    {
        string fallbackName = string.IsNullOrEmpty(injectedRenderToolName)
            ? A2UIConstants.RenderA2UIToolName
            : injectedRenderToolName!;

        if (TryReadForwardedFlag(options, out bool forwarded, out string? forwardedName))
        {
            return (forwarded, forwardedName ?? fallbackName);
        }

        return (injectOption ?? false, fallbackName);
    }

    // Reads the forwarded injectA2UITool flag. Returns false when the run carries no usable flag,
    // so the caller falls back to the backend option. A non-boolean, non-string value
    // (null/number/array/object) is not a usable flag and is treated as absent.
    private static bool TryReadForwardedFlag(ChatOptions? options, out bool inject, out string? renderToolName)
    {
        inject = false;
        renderToolName = null;
        if (options is null ||
            !options.TryGetRunAgentInput(out RunAgentInput? input) ||
            input.ForwardedProperties is not { ValueKind: JsonValueKind.Object } forwarded ||
            !forwarded.TryGetProperty("injectA2UITool", out JsonElement flag))
        {
            return false;
        }

        switch (flag.ValueKind)
        {
            case JsonValueKind.True:
            case JsonValueKind.False:
                inject = flag.GetBoolean();
                return true;
            case JsonValueKind.String:
                string? name = flag.GetString();
                if (string.IsNullOrEmpty(name))
                {
                    // "" is falsy in the adapters' `if (!flag) skip` gate — an opt-out.
                    inject = false;
                    return true;
                }

                inject = true;
                renderToolName = name;
                return true;
            default:
                return false;
        }
    }

    // Reads the A2UI state (catalog schema + forwarded context entries) from the
    // RunAgentInput the AG-UI hosting layer stamped onto the chat options.
    internal static A2UIAgentState ReadAgentState(ChatOptions? options)
    {
        if (options is null ||
            !options.TryGetRunAgentInput(out RunAgentInput? input) ||
            input.Context is null)
        {
            return new A2UIAgentState();
        }

        var context = new List<A2UIContextEntry>();
        string? schema = null;
        foreach (AGUIContext entry in input.Context)
        {
            if (string.Equals(entry.Description, A2UIConstants.A2UISchemaContextDescription, StringComparison.Ordinal))
            {
                schema = entry.Value;
            }
            else
            {
                context.Add(new A2UIContextEntry(entry.Description, entry.Value));
            }
        }

        return new A2UIAgentState { Context = context, A2UISchema = schema };
    }

    // Classifies a subagent stream error: cancellation (when requested) and programmer
    // errors rethrow; everything else (transient provider/network faults) is recoverable
    // and becomes a failed, retryable attempt. Mirrors the sibling adapters' classifiers.
    private static bool IsRecoverableSubagentError(Exception ex, CancellationToken cancellationToken)
    {
        if (ex is OperationCanceledException && cancellationToken.IsCancellationRequested)
        {
            return false;
        }

        // Programmer errors surface real bugs — never mask them as a retryable generation
        // failure. A timeout raised as OperationCanceledException without a cancel request
        // falls through to recoverable.
        return ex is not (NullReferenceException or ArgumentException or IndexOutOfRangeException or InvalidOperationException);
    }

    private static A2UIValidationError ToTransientError(Exception ex) =>
        new(A2UIValidationErrorCodes.EmptyComponents, "components", $"Sub-agent call failed: {ex.Message}");

    // Builds the render subagent's message list: the generation prompt plus the sanitized conversation.
    private static List<ChatMessage> BuildSubagentMessages(string prompt, IReadOnlyList<ChatMessage> messages) =>
        [new ChatMessage(ChatRole.System, prompt), .. SanitizeForSubagent(messages)];

    // Strips unbalanced tool plumbing from the conversation before it is handed to the render
    // subagent. The in-flight generate_a2ui assistant tool-call has no matching result
    // yet (its result is what we are generating), and providers reject an assistant message
    // whose tool_calls are not each answered by a following tool message. Drop any
    // function call without a matching result (and any assistant message left empty); balanced
    // prior call/result pairs are kept so prior-surface grounding survives.
    private static List<ChatMessage> SanitizeForSubagent(IReadOnlyList<ChatMessage> messages)
    {
        var answeredCallIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (ChatMessage message in messages)
        {
            foreach (FunctionResultContent result in message.Contents.OfType<FunctionResultContent>())
            {
                answeredCallIds.Add(result.CallId);
            }
        }

        var sanitized = new List<ChatMessage>(messages.Count);
        foreach (ChatMessage message in messages)
        {
            bool hasUnbalancedCall = message.Contents
                .OfType<FunctionCallContent>()
                .Any(call => !answeredCallIds.Contains(call.CallId));
            if (!hasUnbalancedCall)
            {
                sanitized.Add(message);
                continue;
            }

            List<AIContent> kept = message.Contents
                .Where(c => c is not FunctionCallContent call || answeredCallIds.Contains(call.CallId))
                .ToList();
            if (kept.Count > 0)
            {
                sanitized.Add(new ChatMessage(message.Role, kept));
            }
        }

        return sanitized;
    }

    // Builds the render subagent's chat options: a forced render_a2ui structured call.
    private static ChatOptions CreateSubagentOptions() => new()
    {
        Tools = [new RenderA2UIToolDeclaration()],
        ToolMode = ChatToolMode.RequireSpecific(A2UIConstants.RenderA2UIToolName),
    };

    // Reads a string argument from a function call's argument dictionary.
    private static string? GetStringArgument(IDictionary<string, object?>? arguments, string name) =>
        arguments is not null && arguments.TryGetValue(name, out object? value)
            ? value switch
            {
                string text => text,
                JsonElement element when element.ValueKind == JsonValueKind.String => element.GetString(),
                JsonValue jsonValue when jsonValue.TryGetValue(out string? text) => text,
                _ => null,
            }
            : null;

    // Maps a chat message onto the toolkit's history shape: the role name plus the
    // message's textual content (for tool results, the function result payload).
    private static A2UIHistoryMessage ToHistoryMessage(ChatMessage message)
    {
        string? content = message.Text;
        if (string.IsNullOrEmpty(content) && message.Role == ChatRole.Tool)
        {
            foreach (FunctionResultContent result in message.Contents.OfType<FunctionResultContent>())
            {
                content = result.Result switch
                {
                    string text => text,
                    JsonElement { ValueKind: JsonValueKind.String } element => element.GetString(),
                    JsonElement element => element.GetRawText(),
                    JsonValue value when value.TryGetValue(out string? text) => text,
                    JsonNode node => node.ToJsonString(),
                    _ => null,
                };

                if (!string.IsNullOrEmpty(content))
                {
                    break;
                }
            }
        }

        return new A2UIHistoryMessage(message.Role.Value, content);
    }

    private static JsonElement ParseEnvelope(string envelope)
    {
        using var document = JsonDocument.Parse(envelope);
        return document.RootElement.Clone();
    }

    private static JsonObject ToJsonObject(IDictionary<string, object?> arguments)
    {
        var result = new JsonObject();
        foreach (KeyValuePair<string, object?> argument in arguments)
        {
            result[argument.Key] = argument.Value switch
            {
                null => null,
                JsonNode node => node.DeepClone(),
                JsonElement element => JsonNode.Parse(element.GetRawText()),
                string text => JsonValue.Create(text),
                bool flag => JsonValue.Create(flag),
                int number => JsonValue.Create(number),
                long number => JsonValue.Create(number),
                double number => JsonValue.Create(number),
                _ => JsonNode.Parse(JsonSerializer.Serialize(
                    argument.Value, AIJsonUtilities.DefaultOptions.GetTypeInfo(argument.Value.GetType()))),
            };
        }

        return result;
    }

    // The schema-only declaration of the planner-facing generate_a2ui tool, used so
    // the planner's call surfaces on the update stream instead of being invoked by an
    // automatic function-invocation layer.
    private sealed class GenerateA2UIToolDeclaration : AIFunctionDeclaration
    {
        private static readonly JsonElement s_schema = ParseSchema();

        private readonly string _name;
        private readonly string _description;

        public GenerateA2UIToolDeclaration(string name, string description)
        {
            this._name = name;
            this._description = description;
        }

        private static JsonElement ParseSchema()
        {
            var schema = new JsonObject
            {
                ["type"] = "object",
                ["properties"] = new JsonObject
                {
                    ["intent"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] = A2UIToolDefinitions.IntentArgumentDescription,
                    },
                    ["target_surface_id"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] = A2UIToolDefinitions.TargetSurfaceIdArgumentDescription,
                    },
                    ["changes"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] = A2UIToolDefinitions.ChangesArgumentDescription,
                    },
                },
            };
            using var document = JsonDocument.Parse(schema.ToJsonString());
            return document.RootElement.Clone();
        }

        public override string Name => this._name;

        public override string Description => this._description;

        public override JsonElement JsonSchema => s_schema;
    }

    // The schema-only declaration of the inner render_a2ui structured-output tool.
    // The subagent is forced to call it; the adapter reads the arguments instead of invoking it.
    private sealed class RenderA2UIToolDeclaration : AIFunctionDeclaration
    {
        private static readonly (string Description, JsonElement Schema) s_definition = ParseDefinition();

        private static (string Description, JsonElement Schema) ParseDefinition()
        {
            JsonNode function = A2UIToolDefinitions.CreateRenderA2UIToolDefinition()["function"]!;
            using var document = JsonDocument.Parse(function["parameters"]!.ToJsonString());
            return (function["description"]!.GetValue<string>(), document.RootElement.Clone());
        }

        public override string Name => A2UIConstants.RenderA2UIToolName;

        public override string Description => s_definition.Description;

        public override JsonElement JsonSchema => s_definition.Schema;
    }
}
