using System;
using System.Text.Json;
using AGUIDotnet.Types;
using Microsoft.Extensions.AI;

namespace AGUIDotnet.Integrations.ChatClient;

/// <summary>
/// Integrates a frontend tool from AGUI into the <see cref="FunctionInvokingChatClient"/> pipeline.
/// </summary>
/// <param name="tool">The AGUI tool definition provided to an agent</param>
public sealed class FrontendTool(Tool tool) : AIFunction
{
    public override string Name => tool.Name;
    public override string Description => tool.Description;
    public override JsonElement JsonSchema => tool.Parameters;

    protected override ValueTask<object?> InvokeCoreAsync(AIFunctionArguments arguments, CancellationToken cancellationToken)
    {
        /*
        The FunctionInvokingChatClient sets up a function invocation loop where it intercepts function calls
        in order to invoke the appropriate .NET function.

        However, in doing so it expects the function to return a value, which we cannot do in a re-entrant way
        within the context of the same run.

        This function's "invocation" then is a signal to the FunctionInvokingChatClient that it should terminate the invocation loop
        and return out, which allows us to intervene.

        It does unfortunately mean that multiple tool call support is not possible without either:

        - Finding a way to register a regular AiTool with the abstraction that supports serialising the JSON schema (the base one does not)
        - Or, implementing a custom variation of the FunctionInvokingChatClient that has better support for distributed and asynchronous function calling.
        */
        if (FunctionInvokingChatClient.CurrentContext is not null)
        {
            FunctionInvokingChatClient.CurrentContext.Terminate = true;
        }

        return ValueTask.FromResult<object?>(null);
    }
}
