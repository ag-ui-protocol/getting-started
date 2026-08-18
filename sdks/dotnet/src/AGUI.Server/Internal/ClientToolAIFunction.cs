using System.Text.Json;
using Microsoft.Extensions.AI;

namespace AGUI.Server;

internal sealed class ClientToolAIFunction : AIFunction
{
    private readonly AIFunctionDeclaration _declaration;
    private readonly IReadOnlyDictionary<string, FunctionResultContent> _resultsByCallId;

    internal ClientToolAIFunction(
        AIFunctionDeclaration declaration,
        IReadOnlyDictionary<string, FunctionResultContent>? resultsByCallId = null)
    {
        _declaration = declaration;
        _resultsByCallId = resultsByCallId ?? new Dictionary<string, FunctionResultContent>();
    }

    public override string Name => _declaration.Name;

    public override string Description => _declaration.Description;

    public override JsonElement JsonSchema => _declaration.JsonSchema;

    public override JsonElement? ReturnJsonSchema => _declaration.ReturnJsonSchema;

    public override IReadOnlyDictionary<string, object?> AdditionalProperties => _declaration.AdditionalProperties;

    protected override ValueTask<object?> InvokeCoreAsync(
        AIFunctionArguments arguments,
        CancellationToken cancellationToken)
    {
        var callId = FunctionInvokingChatClient.CurrentContext?.CallContent.CallId;
        if (callId is null || !_resultsByCallId.TryGetValue(callId, out var result))
        {
            return ValueTask.FromException<object?>(
                new InvalidOperationException($"No client-produced result was supplied for client tool call '{callId ?? "<unknown>"}'."));
        }

        return new ValueTask<object?>(result);
    }
}
