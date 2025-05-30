using System.Collections.Immutable;
using System.Text.Json;
using System.Threading.Channels;
using AGUIDotnet.Events;
using AGUIDotnet.Types;
using Json.Patch;
using Microsoft.Extensions.AI;

namespace AGUIDotnet.Agent;

public record StatefulChatClientAgentOptions<TState> : ChatClientAgentOptions where TState : notnull
{
    /// <summary>
    /// The name to give to the function for retrieving the current shared state of the agent.
    /// </summary>
    public string StateRetrievalFunctionName { get; init; } = "retrieve_state";

    /// <summary>
    /// The description to give to the function for retrieving the current shared state of the agent.
    /// </summary>
    public string StateRetrievalFunctionDescription { get; init; } = "Retrieves the current shared state of the agent.";

    /// <summary>
    /// The name to give to the function for updating the current shared state of the agent.
    /// </summary>
    public string StateUpdateFunctionName { get; init; } = "update_state";

    /// <summary>
    /// The description to give to the function for updating the current shared state of the agent.
    /// </summary>
    public string StateUpdateFunctionDescription { get; init; } = "Updates the current shared state of the agent.";

    /// <summary>
    /// When <see cref="ChatClientAgentOptions.EmitBackendToolCalls"/> is <c>true</c>, this controls whether the frontend should be made aware of the state functions being called. 
    /// </summary>
    public bool EmitStateFunctionsToFrontend { get; init; } = true;
}

/// <summary>
/// Much like <see cref="ChatClientAgent"/> but tailored for scenarios where the agent and frontend collaborate on shared state.
/// </summary>
/// <remarks>
/// This agent is NOT guaranteed to be thread-safe, nor is it resilient to shared use across multiple threads / runs, a separate instance should be used for each invocation.
/// </remarks>
/// <typeparam name="TState"></typeparam>
public class StatefulChatClientAgent<TState> : ChatClientAgent where TState : notnull
{
    private TState _currentState = default!;
    private readonly StatefulChatClientAgentOptions<TState> _agentOptions;

    public StatefulChatClientAgent(IChatClient chatClient, TState initialState, StatefulChatClientAgentOptions<TState> agentOptions) : base(chatClient, agentOptions)
    {
        if (agentOptions?.SystemMessage is null)
        {
            throw new ArgumentException("System message must be provided for a stateful agent.", nameof(agentOptions));
        }

        if (string.IsNullOrWhiteSpace(agentOptions.StateRetrievalFunctionName))
        {
            throw new ArgumentException("State retrieval function name must be provided for a stateful agent.", nameof(agentOptions));
        }

        if (string.IsNullOrWhiteSpace(agentOptions.StateRetrievalFunctionDescription))
        {
            throw new ArgumentException("State retrieval function description must be provided for a stateful agent.", nameof(agentOptions));
        }

        if (string.IsNullOrWhiteSpace(agentOptions.StateUpdateFunctionName))
        {
            throw new ArgumentException("State update function name must be provided for a stateful agent.", nameof(agentOptions));
        }

        if (string.IsNullOrWhiteSpace(agentOptions.StateUpdateFunctionDescription))
        {
            throw new ArgumentException("State update function description must be provided for a stateful agent.", nameof(agentOptions));
        }

        _agentOptions = agentOptions;
        _currentState = initialState;
    }

    private TState RetrieveState()
    {
        return _currentState;
    }

    private void UpdateState(TState newState)
    {
        _currentState = newState;

    }

    protected override async ValueTask<string> PrepareSystemMessage(RunAgentInput input, string systemMessage, ImmutableList<Context> context)
    {
        var coreMessage = await base.PrepareSystemMessage(input, systemMessage, context).ConfigureAwait(false);

        // Hijack the original system message to include some context to the LLM about the stateful nature of this agent.
        // Nudging it to use the state collaboration tools available to it.
        return $"""
        <persona>
        You are a stateful agent that wraps an existing agent, allowing it to collaborate with a human in the frontend on shared state to achieve a goal.
        </persona>

        <tools>
        You may have a variety of tools available to you to help achieve your goal, and state collaboration is one of them.

        You can retrieve the current shared state of the agent using the `retrieve_state` tool, and update the shared state using the `update_state` tool.
        </tools>

        <rules>
        - Wherever necessary (e.g. it is aligned with your stated goal), you MUST make use of the state collaboration tools.
        - Inspect the state of the agent to understand both the current state and the schema / purpose of the state in alignment with the agent's goal.
        - Liberally use the `update_state` tool to update the shared state as you progress towards your goal.
        - Avoid making assumptions about the state, always retrieve it first.
        - Avoid making unnecessary updates to the state, e.g. if the user intent does not require it.
        </rules>

        <underlying_agent>
        {coreMessage}
        </underlying_agent>
        """;
    }

    protected override async ValueTask<ImmutableList<AIFunction>> PrepareBackendTools(ImmutableList<AIFunction> backendTools, RunAgentInput input, ChannelWriter<BaseEvent> events, CancellationToken cancellationToken = default)
    {
        return [
            .. await base.PrepareBackendTools(backendTools, input, events, cancellationToken).ConfigureAwait(false),
            AIFunctionFactory.Create(
                RetrieveState,
                name: _agentOptions.StateRetrievalFunctionName,
                description: _agentOptions.StateRetrievalFunctionDescription
            ),
            AIFunctionFactory.Create(
                async (TState newState) => {
                    var delta = _currentState.CreatePatch(newState, _jsonSerOpts);
                    if (delta.Operations.Count > 0) {
                        UpdateState(newState);
                        await events.WriteAsync(new StateDeltaEvent {
                            Delta = [.. delta.Operations.Cast<object>()],
                            Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                        }, cancellationToken).ConfigureAwait(false);
                    }
                },
                name: _agentOptions.StateUpdateFunctionName,
                description: _agentOptions.StateUpdateFunctionDescription
            )
        ];
    }

    protected override async ValueTask<bool> ShouldEmitBackendToolCallData(string functionName)
    {
        // Short if we're not emitting backend tool calls at all.
        if (!_agentOptions.EmitBackendToolCalls)
        {
            return false;
        }

        bool isStateFunction =
           functionName == _agentOptions.StateRetrievalFunctionName ||
           functionName == _agentOptions.StateUpdateFunctionName;

        // If the function is a state function, only request to emit if the agent options allow it.
        if (isStateFunction)
        {
            return _agentOptions.EmitStateFunctionsToFrontend;
        }

        // Let the base handle it otherwise.
        return await base.ShouldEmitBackendToolCallData(functionName).ConfigureAwait(false);
    }

    protected override async ValueTask OnRunStartedAsync(RunAgentInput input, ChannelWriter<BaseEvent> events, CancellationToken cancellationToken = default)
    {
        // Allow the base behaviour of emitting the RunStartedEvent
        await base.OnRunStartedAsync(input, events, cancellationToken).ConfigureAwait(false);

        // Take the initial state from the input if possible
        try
        {
            if (input.State.ValueKind == JsonValueKind.Object)
            {
                var state = input.State.Deserialize<TState>(_jsonSerOpts);
                if (state is not null)
                {
                    _currentState = state;
                }
            }
        }
        catch (JsonException)
        {

        }

        await events.WriteAsync(new StateSnapshotEvent
        {
            Snapshot = _currentState,
            Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        }, cancellationToken).ConfigureAwait(false);
    }
}
