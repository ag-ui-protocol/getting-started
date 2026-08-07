using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace AGUI.A2UI;

/// <summary>
/// Pure helpers for building A2UI subagent tools: prompt assembly, conversation-history
/// surface reconstruction, request preparation, and operations-envelope assembly.
/// </summary>
/// <remarks>
/// This is the .NET port of <c>@ag-ui/a2ui-toolkit</c> (TypeScript) and
/// <c>ag-ui-a2ui-toolkit</c> (Python). All behavior — section ordering, fallback rules,
/// surface-walk semantics, untrusted-output narrowing — is contract-tested for parity
/// with the sibling implementations.
/// </remarks>
public static class A2UIToolkit
{
    private static readonly JsonSerializerOptions s_indentedOptions = new() { WriteIndented = true };

    /// <summary>
    /// Builds the context section of the subagent prompt from the AG-UI agent state:
    /// one markdown section per described context entry, followed by the component
    /// catalog under an <c>## Available Components</c> heading when present.
    /// </summary>
    /// <param name="state">The AG-UI agent state slice, or <see langword="null"/>.</param>
    /// <returns>The context prompt, possibly empty.</returns>
    public static string BuildContextPrompt(A2UIAgentState? state)
    {
        List<string> parts = [];

        foreach (A2UIContextEntry entry in state?.Context ?? [])
        {
            // A null value with a description must not leak a literal "null"
            // into the subagent prompt — coerce to the empty string first.
            string value = entry.Value ?? string.Empty;
            if (!string.IsNullOrEmpty(entry.Description))
            {
                parts.Add($"## {entry.Description}\n{value}\n");
            }
            else if (value.Length > 0)
            {
                parts.Add($"{value}\n");
            }
        }

        if (!string.IsNullOrEmpty(state?.A2UISchema))
        {
            parts.Add($"## Available Components\n{state!.A2UISchema}\n");
        }

        return string.Join("\n", parts);
    }

    /// <summary>
    /// Walks the conversation history backwards to reconstruct the latest known state of
    /// <paramref name="surfaceId"/> from prior <c>a2ui_operations</c> tool results.
    /// </summary>
    /// <remarks>
    /// Within a message, operations apply in order (the last operation per field wins, and
    /// <c>deleteSurface</c> resets the accumulator). Across messages, the newest mention is
    /// authoritative and older messages only fill fields the newer ones did not set. When the
    /// newest mention ends with the surface deleted, the surface is gone — older state is not
    /// resurrected and <see langword="null"/> is returned.
    /// </remarks>
    /// <param name="messages">The conversation history, oldest first.</param>
    /// <param name="surfaceId">The surface to look for.</param>
    /// <returns>The reconstructed surface state, or <see langword="null"/> when absent or deleted.</returns>
    public static A2UIPriorSurface? FindPriorSurface(IEnumerable<A2UIHistoryMessage> messages, string surfaceId)
    {
        ArgumentNullException.ThrowIfNull(messages);
        ArgumentNullException.ThrowIfNull(surfaceId);

        JsonArray? components = null;
        JsonNode? data = null;
        bool dataSeen = false;
        string? catalogId = null;
        bool matched = false;

        foreach (A2UIHistoryMessage message in messages.Reverse())
        {
            if (message.Role is not ("tool" or "ToolMessage") || message.Content is null)
            {
                continue;
            }

            JsonNode? parsed;
            try
            {
                parsed = JsonNode.Parse(message.Content);
            }
            catch (JsonException)
            {
                // Conversation history is untrusted input — skip malformed content.
                continue;
            }

            if (parsed is not JsonObject parsedObject ||
                parsedObject[A2UIConstants.A2UIOperationsKey] is not JsonArray operations)
            {
                continue;
            }

            // Compute this message's end state for the surface by walking ops forward.
            // deleteSurface resets the per-message accumulator; subsequent create/update
            // ops in the same message restore it.
            bool messageMentions = false;
            bool messageDeleted = false;
            string? messageCatalogId = null;
            JsonArray? messageComponents = null;
            JsonNode? messageData = null;
            bool messageDataSeen = false;

            foreach (JsonNode? operationNode in operations)
            {
                if (operationNode is not JsonObject operation)
                {
                    continue;
                }

                if (operation["deleteSurface"] is JsonObject deleteSurface &&
                    TryGetString(deleteSurface["surfaceId"]) == surfaceId)
                {
                    messageMentions = true;
                    messageDeleted = true;
                    messageCatalogId = null;
                    messageComponents = null;
                    messageData = null;
                    messageDataSeen = false;
                    continue;
                }

                if (operation["createSurface"] is JsonObject createSurface &&
                    TryGetString(createSurface["surfaceId"]) == surfaceId)
                {
                    messageMentions = true;
                    messageDeleted = false;
                    if (TryGetString(createSurface["catalogId"]) is string opCatalogId)
                    {
                        messageCatalogId = opCatalogId;
                    }
                }

                if (operation["updateComponents"] is JsonObject updateComponents &&
                    TryGetString(updateComponents["surfaceId"]) == surfaceId)
                {
                    messageMentions = true;
                    messageDeleted = false;
                    if (updateComponents["components"] is JsonArray opComponents)
                    {
                        // Clone: the captured nodes outlive this method inside the public
                        // A2UIPriorSurface, and a parent-attached JsonNode throws when a
                        // caller re-attaches it elsewhere.
                        messageComponents = (JsonArray)opComponents.DeepClone();
                    }
                }

                if (operation["updateDataModel"] is JsonObject updateDataModel &&
                    TryGetString(updateDataModel["surfaceId"]) == surfaceId)
                {
                    messageMentions = true;
                    messageDeleted = false;
                    messageData = updateDataModel["value"]?.DeepClone();
                    messageDataSeen = true;
                }
            }

            if (!messageMentions)
            {
                continue;
            }

            if (!matched)
            {
                // Newest message that mentions the surface — its end state is authoritative.
                if (messageDeleted)
                {
                    return null;
                }

                matched = true;
                catalogId = messageCatalogId;
                components = messageComponents;
                data = messageData;
                dataSeen = messageDataSeen;
            }
            else if (!messageDeleted)
            {
                // Older message: fill in only the fields not yet set. A delete here is
                // overridden by the newer state already recorded.
                catalogId ??= messageCatalogId;
                components ??= messageComponents;
                if (!dataSeen && messageDataSeen)
                {
                    data = messageData;
                    dataSeen = true;
                }
            }

            // Early-exit once every field is populated — nothing older can override.
            if (matched && components is not null && catalogId is not null && dataSeen)
            {
                break;
            }
        }

        return matched
            ? new A2UIPriorSurface(components ?? [], data, catalogId)
            : null;
    }

    /// <summary>
    /// Assembles the full subagent system prompt in the canonical section order:
    /// generation guidelines, design guidelines, context, composition guide, and —
    /// when editing — the prior-surface edit block.
    /// </summary>
    /// <param name="contextPrompt">The context section produced by <see cref="BuildContextPrompt"/>.</param>
    /// <param name="guidelines">Per-section overrides; see <see cref="A2UIGuidelines"/> for the fallback rules.</param>
    /// <param name="editContext">The prior-surface context when editing an existing surface.</param>
    /// <returns>The assembled prompt, possibly empty.</returns>
    public static string BuildSubagentPrompt(
        string contextPrompt,
        A2UIGuidelines? guidelines = null,
        A2UIEditContext? editContext = null)
    {
        ArgumentNullException.ThrowIfNull(contextPrompt);

        // Per-field fallback: null → built-in default; "" → the host explicitly
        // suppressed the block.
        string generation = guidelines?.GenerationGuidelines ?? A2UIPromptDefaults.GenerationGuidelines;
        string design = guidelines?.DesignGuidelines ?? A2UIPromptDefaults.DesignGuidelines;
        string? compositionGuide = guidelines?.CompositionGuide;

        List<string> parts = [];
        if (generation.Length > 0)
        {
            parts.Add(generation);
        }

        if (design.Length > 0)
        {
            parts.Add($"## Design Guidelines\n{design}");
        }

        if (contextPrompt.Length > 0)
        {
            parts.Add(contextPrompt);
        }

        if (!string.IsNullOrEmpty(compositionGuide))
        {
            parts.Add(compositionGuide!);
        }

        if (editContext is not null)
        {
            string componentsJson = (editContext.Prior.Components ?? []).ToJsonString(s_indentedOptions);
            string dataJson = editContext.Prior.Data?.ToJsonString(s_indentedOptions) ?? "null";

            var editBlock = new StringBuilder()
                .Append("## Editing an existing surface\n")
                .Append("You are editing surface '").Append(editContext.SurfaceId).Append("'. Produce the FULL ")
                .Append("updated components array and data model — not just a diff. ")
                .Append("Preserve component ids that the user has not asked to change so ")
                .Append("the renderer can reconcile them. Reuse the same catalogId.\n\n")
                .Append("### Previous components\n").Append(componentsJson).Append("\n\n")
                .Append("### Previous data\n").Append(dataJson).Append('\n');

            if (!string.IsNullOrEmpty(editContext.Changes))
            {
                editBlock.Append("\n### Requested changes\n").Append(editContext.Changes).Append('\n');
            }

            parts.Add(editBlock.ToString());
        }

        return string.Join("\n", parts.Where(p => p.Length > 0));
    }

    /// <summary>
    /// Resolves the create/update intent, locates the prior surface for updates, and builds
    /// the subagent prompt.
    /// </summary>
    /// <param name="intent"><c>"create"</c> (default) or <c>"update"</c>.</param>
    /// <param name="targetSurfaceId">The surface to edit; required for the update intent.</param>
    /// <param name="changes">An optional natural-language description of the requested changes.</param>
    /// <param name="messages">The conversation history, oldest first.</param>
    /// <param name="state">The AG-UI agent state slice.</param>
    /// <param name="guidelines">Prompt-section overrides.</param>
    /// <returns>
    /// The prepared request. On the update path, a missing prior surface yields a result with
    /// <see cref="A2UIPreparedRequest.Error"/> set and an empty prompt instead of throwing, so the
    /// hosting tool can return a structured error envelope to the planner.
    /// </returns>
    public static A2UIPreparedRequest PrepareA2UIRequest(
        string? intent,
        string? targetSurfaceId,
        string? changes,
        IEnumerable<A2UIHistoryMessage> messages,
        A2UIAgentState? state,
        A2UIGuidelines? guidelines = null)
    {
        ArgumentNullException.ThrowIfNull(messages);

        bool isUpdate = (intent ?? "create") == "update" && !string.IsNullOrEmpty(targetSurfaceId);
        A2UIPriorSurface? prior = isUpdate ? FindPriorSurface(messages, targetSurfaceId!) : null;

        if (isUpdate && prior is null)
        {
            return new A2UIPreparedRequest(
                Prompt: string.Empty,
                IsUpdate: isUpdate,
                Prior: null,
                Error: $"intent='update' requested target_surface_id='{targetSurfaceId}' " +
                    "but no prior render of that surface was found in conversation history");
        }

        string prompt = BuildSubagentPrompt(
            BuildContextPrompt(state),
            guidelines,
            prior is not null ? new A2UIEditContext(targetSurfaceId!, prior, changes) : null);

        return new A2UIPreparedRequest(prompt, isUpdate, prior, Error: null);
    }

    /// <summary>
    /// Builds the final operations envelope from the subagent's structured tool output,
    /// narrowing untrusted values to safe defaults.
    /// </summary>
    /// <remarks>
    /// The model output is untrusted: a missing, empty, or non-string <c>surfaceId</c> falls back
    /// to the default; a non-array <c>components</c> becomes empty; a non-object <c>data</c> is
    /// dropped. The catalog id is never taken from the model — it comes from the prior surface on
    /// updates and from <paramref name="defaultCatalogId"/> on creates. Empty-string defaults fall
    /// back to the canonical constants.
    /// </remarks>
    /// <param name="args">The structured <c>render_a2ui</c> tool arguments from the model.</param>
    /// <param name="isUpdate">Whether this is the update path.</param>
    /// <param name="targetSurfaceId">The surface being updated; ignored on the create path.</param>
    /// <param name="prior">The prior surface state on the update path.</param>
    /// <param name="defaultSurfaceId">The fallback surface id.</param>
    /// <param name="defaultCatalogId">The catalog id used on the create path.</param>
    /// <returns>The serialized operations envelope.</returns>
    public static string BuildA2UIEnvelope(
        JsonObject args,
        bool isUpdate,
        string? targetSurfaceId,
        A2UIPriorSurface? prior,
        string defaultSurfaceId = A2UIConstants.DefaultSurfaceId,
        string defaultCatalogId = A2UIConstants.BasicCatalogId)
    {
        ArgumentNullException.ThrowIfNull(args);

        // Treat empty-string defaults as unset. Without this, a misconfigured host
        // passing "" would propagate the empty string into the emitted ops and surface
        // as "Catalog not found: " / blank surface ids at render time, hiding the cause.
        string safeDefaultSurfaceId = string.IsNullOrEmpty(defaultSurfaceId) ? A2UIConstants.DefaultSurfaceId : defaultSurfaceId;
        string safeDefaultCatalogId = string.IsNullOrEmpty(defaultCatalogId) ? A2UIConstants.BasicCatalogId : defaultCatalogId;

        string argSurfaceId = TryGetString(args["surfaceId"]) is string raw && raw.Length > 0 ? raw : string.Empty;
        string surfaceId = isUpdate
            ? (string.IsNullOrEmpty(targetSurfaceId) ? safeDefaultSurfaceId : targetSurfaceId!)
            : (argSurfaceId.Length > 0 ? argSurfaceId : safeDefaultSurfaceId);
        string catalogId = string.IsNullOrEmpty(prior?.CatalogId) ? safeDefaultCatalogId : prior!.CatalogId!;

        JsonArray components = args["components"] as JsonArray ?? [];
        JsonObject? data = args["data"] as JsonObject;

        IReadOnlyList<JsonObject> ops = AssembleOps(
            isUpdate ? "update" : "create",
            surfaceId,
            catalogId,
            components,
            data);

        return WrapAsOperationsEnvelope(ops);
    }

    /// <summary>
    /// Assembles the ordered operation list for a surface render: the create intent emits
    /// <c>createSurface</c> + <c>updateComponents</c> (+ <c>updateDataModel</c> when data is
    /// non-empty); the update intent omits <c>createSurface</c> so the renderer reconciles in place.
    /// </summary>
    /// <param name="intent"><c>"create"</c> or <c>"update"</c>.</param>
    /// <param name="surfaceId">The target surface id.</param>
    /// <param name="catalogId">The catalog id stamped on <c>createSurface</c>.</param>
    /// <param name="components">The flat component array.</param>
    /// <param name="data">The initial data model; omitted from the envelope when null or empty.</param>
    /// <returns>The ordered operations.</returns>
    public static IReadOnlyList<JsonObject> AssembleOps(
        string intent,
        string surfaceId,
        string catalogId,
        JsonArray components,
        JsonObject? data = null)
    {
        ArgumentNullException.ThrowIfNull(components);

        List<JsonObject> ops = [];
        if (!string.Equals(intent, "update", StringComparison.Ordinal))
        {
            ops.Add(A2UIOperationBuilder.CreateSurface(surfaceId, catalogId));
        }

        ops.Add(A2UIOperationBuilder.UpdateComponents(surfaceId, components));
        if (data is { Count: > 0 })
        {
            ops.Add(A2UIOperationBuilder.UpdateDataModel(surfaceId, data));
        }

        return ops;
    }

    /// <summary>
    /// Serializes operations under the <see cref="A2UIConstants.A2UIOperationsKey"/> envelope key.
    /// </summary>
    /// <param name="operations">The operations to wrap.</param>
    /// <returns>The serialized envelope.</returns>
    public static string WrapAsOperationsEnvelope(IEnumerable<JsonObject> operations)
    {
        ArgumentNullException.ThrowIfNull(operations);
        return new JsonObject
        {
            [A2UIConstants.A2UIOperationsKey] = new JsonArray(operations.Select(JsonNode? (op) => op.DeepClone()).ToArray()),
        }.ToJsonString();
    }

    /// <summary>
    /// Serializes a host-facing error as <c>{"error": message}</c> so the planner receives a
    /// structured failure instead of an exception.
    /// </summary>
    /// <param name="message">The error message.</param>
    /// <returns>The serialized error envelope.</returns>
    public static string WrapErrorEnvelope(string message)
        => new JsonObject { ["error"] = message }.ToJsonString();

    private static string? TryGetString(JsonNode? node)
        => node is JsonValue value && value.TryGetValue(out string? text) ? text : null;
}
