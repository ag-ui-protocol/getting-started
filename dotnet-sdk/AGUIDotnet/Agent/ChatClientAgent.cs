using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Channels;
using AGUIDotnet.Events;
using AGUIDotnet.Integrations.ChatClient;
using AGUIDotnet.Types;
using Microsoft.Extensions.AI;

namespace AGUIDotnet.Agent;

public record ChatClientAgentOptions
{
    /// <summary>
    /// Options to provide when using the provided chat client.
    /// </summary>
    public ChatOptions? ChatOptions { get; init; }

    /// <summary>
    /// Whether to preserve inbound system messages passed to the agent.
    /// </summary>
    public bool PreserveInboundSystemMessages { get; init; } = true;

    /// <summary>
    /// The system message to use for the agent, setting this will override any system messages passed in the input.
    /// </summary>
    public string? SystemMessage { get; init; }

    /// <summary>
    /// <para>
    /// Sometimes the agent isn't provided with all or any context in the <see cref="RunAgentInput.Context"/> collection, and it needs to be extracted from passed system messages.
    /// </para>
    /// <para>
    /// Switching this on will cause the agent to perform an initial typed extraction of the context if available, and then use that context for the agent run.
    /// </para>
    /// <para>
    /// This is useful e.g. for frontends like CopilotKit that do not make useCopilotReadable context available to agents, instead relying on shared agent state - it does however provide the context in the system message.
    /// </para>
    /// </summary>
    public bool PerformAiContextExtraction { get; init; } = false;

    /// <summary>
    /// When overriding the system message, whether to include provided or extracted context in the system message.
    /// </summary>
    public bool IncludeContextInSystemMessage { get; init; } = false;

    /// <summary>
    /// When emitting message snapshots back to the frontend, whether to strip out system messages from the snapshot.
    /// </summary>
    public bool StripSystemMessagesWhenEmittingMessageSnapshots { get; init; } = true;

    // todo: introduce a filter mechanism to allow for selective tool call event emission?
    /// <summary>
    /// Whether to emit tool call events for backend tools that are invoked by the agent.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This will cause the agent to emit tool call events AND a messages snapshot with the results to the frontend for ALL backend tools.
    /// </para>
    /// <para>
    /// This means the frontend will see EVERYTHING about that tool call, including the arguments, the result, and any errors that may have occurred.
    /// </para>
    /// </remarks>
    public bool EmitBackendToolCalls { get; init; } = true;
}

/// <summary>
/// A basic, opinionated kitchen-sink agent that uses a chat client to process the entirety of the invoked run.
/// </summary>
/// <remarks>
/// <para>
/// Often you need nothing more than a chat client with available tools to process the run, and this agent provides a simple single-step agentic "flow" that provides that.
/// </para>
/// <para>
/// Provides configuration options to control behaviour, as well as the ability to derive from it to override defaults and hooks for further customisation.
/// </para>
/// </remarks>
public class ChatClientAgent : IAGUIAgent
{
    private readonly IChatClient _chatClient;
    private readonly ChatClientAgentOptions _agentOptions;
    protected static readonly JsonSerializerOptions _jsonSerOpts = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = false,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public UsageDetails Usage { get; private set; } = new();

    public ChatClientAgent(
        IChatClient chatClient,
        ChatClientAgentOptions? agentOptions = null
    )
    {
        ArgumentNullException.ThrowIfNull(chatClient, nameof(chatClient));

        _chatClient = chatClient;
        _agentOptions = agentOptions ?? new();
    }

    public async Task RunAsync(RunAgentInput input, ChannelWriter<BaseEvent> events, CancellationToken cancellationToken = default)
    {
        /*
        Prep the chat options for the chat client.
        */
        var chatOpts =
            _agentOptions.ChatOptions ?? new ChatOptions
            {
                // Support function calls by default.
                ToolMode = ChatToolMode.Auto,
            };

        // Ensure we have an empty tools list to start with.
        chatOpts.Tools ??= [];

        /*
        Prepare the backend tools by filtering out any frontend tools (there shouldn't be any, but just in case),
        and allow the derived type to modify the backend tools if needed.
        */
        var backendTools = (await PrepareBackendTools(
            [.. chatOpts.Tools.OfType<AIFunction>().Where(f => f is not FrontendTool)],
            input,
            events,
            cancellationToken
        ).ConfigureAwait(false)).Where(t => t is not FrontendTool).ToImmutableList();

        var backendToolNames = backendTools.Select(t => t.Name).ToImmutableHashSet();

        var frontendTools = await PrepareFrontendTools(
            [.. input.Tools.Select(t => new FrontendTool(t))],
            input,
            cancellationToken).ConfigureAwait(false);

        var frontendToolNames = frontendTools.Select(t => t.Name).ToImmutableHashSet();

        {
            var conflictingTools = frontendToolNames.Intersect(backendToolNames);

            if (!conflictingTools.IsEmpty)
            {
                throw new InvalidOperationException(
                    $"Some frontend and backend tools conflict by name: {string.Join(", ", conflictingTools)}. " +
                    "Please ensure that frontend tool names do not conflict with backend tool names."
                );
            }
        }

        if (frontendTools.IsEmpty && backendTools.IsEmpty)
        {
            chatOpts.Tools = null;
            chatOpts.AllowMultipleToolCalls = null;
        }
        else
        {
            chatOpts.Tools = [.. backendTools, .. frontendTools];
            chatOpts.AllowMultipleToolCalls = false;
        }

        var context = await PrepareContext(input, cancellationToken).ConfigureAwait(false);
        var mappedMessages = await MapAGUIMessagesToChatClientMessages(input, context, cancellationToken).ConfigureAwait(false);

        /*
        Track tool calls that we have encountered so we know what to do when seeing result content emitted
        from the underlying chat client.
        */
        var knownFrontendToolCalls = new Dictionary<string, string>();
        var knownBackendToolCalls = new Dictionary<string, string>();

        // Handle the run starting
        await OnRunStartedAsync(input, events, cancellationToken).ConfigureAwait(false);

        // With the assumption that our primary response will be an assistant message, track the one we're currently building.
        AssistantMessage? currentResponse = null;

        /*
        As the agent processes this run, we may need to emit message snapshots back to the frontend which
        may differ from the original messages provided in the input as we've likely been producing text / tool calls as we go.

        We want to strip out the inbound system messages as the frontend will re-communicate those on subsequent runs.

        NOTE: CopilotKit seems to dupe system messages when receiving them back in a message snapshot, so this also helps guard against that.
        */
        var agUiMessages = _agentOptions.StripSystemMessagesWhenEmittingMessageSnapshots ?
             [.. input.Messages.Where(m => m is not SystemMessage)]
             : input.Messages.ToList();

        // Tracks whether something in this run has necessitated a message sync to the frontend (mostly emitting backend tool call results).
        var needsMessageSync = false;

        // todo: introduce a RunContext type to hold all the run data to shuttle around to specific virtual methods to provide greater extensibility? (might just be easier to have people implement their own agent from the interface)

        await foreach (var update in _chatClient.GetStreamingResponseAsync(mappedMessages, chatOpts, cancellationToken).ConfigureAwait(false))
        {
            foreach (var content in update.Contents)
            {
                switch (content)
                {
                    case TextContent text:
                        {
                            /*
                            If this chunk update is not the same message as the current response, and we've encountered text content then
                            this implies the need to end the previous text response and start a new one.
                            */
                            if (currentResponse is not null && update.MessageId != currentResponse.Id)
                            {
                                await events.WriteAsync(new TextMessageEndEvent
                                {
                                    MessageId = currentResponse.Id,
                                    Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                                }, cancellationToken).ConfigureAwait(false);

                                agUiMessages.Add(currentResponse);
                                currentResponse = null;
                            }

                            // If this is the first text content and we don't have a current response ID, we need to start a new text message.
                            if (currentResponse is null)
                            {
                                currentResponse = new AssistantMessage
                                {
                                    Id = update.MessageId ?? Guid.NewGuid().ToString(),
                                    Content = "",
                                    ToolCalls = [],
                                };

                                await events.WriteAsync(new TextMessageStartEvent
                                {
                                    MessageId = currentResponse.Id,
                                    Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                                }, cancellationToken).ConfigureAwait(false);
                            }

                            Debug.Assert(currentResponse is not null, "Handling text content without a current response message");

                            // Only emit text content if it is not empty (we allow whitespace as that may have been chunked, and still be valid).
                            if (!string.IsNullOrEmpty(text.Text))
                            {
                                await events.WriteAsync(new TextMessageContentEvent
                                {
                                    MessageId = currentResponse.Id,
                                    Delta = text.Text,
                                    Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                                }, cancellationToken).ConfigureAwait(false);

                                // Append the text to the current response message we're building to mirror the events we're sending out.
                                currentResponse = currentResponse with
                                {
                                    Content = currentResponse.Content + text.Text
                                };
                            }
                        }
                        break;

                    case FunctionCallContent functionCall:
                        {
                            // We need to end the current text message if we have one, in order to dispatch a frontend tool call.
                            if (currentResponse is not null)
                            {
                                await events.WriteAsync(new TextMessageEndEvent
                                {
                                    MessageId = currentResponse.Id,
                                    Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                                }, cancellationToken).ConfigureAwait(false);

                                agUiMessages.Add(currentResponse);
                                currentResponse = null;
                            }

                            // We need to track the frontend calls so we can avoid communicating their results as they don't technically exist in the backend.
                            if (frontendToolNames.Contains(functionCall.Name))
                            {
                                knownFrontendToolCalls.Add(functionCall.CallId, functionCall.Name);
                            }

                            if (backendToolNames.Contains(functionCall.Name))
                            {
                                // We MUST track the tool call, so we can determine what function name it correlates with when we receive the result.
                                knownBackendToolCalls.Add(functionCall.CallId, functionCall.Name);

                                // If we don't want the frontend to see backend tool calls, skip over this content item.
                                if (!_agentOptions.EmitBackendToolCalls ||
                                    !await ShouldEmitBackendToolCallData(functionCall.Name).ConfigureAwait(false))
                                {
                                    continue;
                                }
                            }

                            /*
                            The FunctionInvokingChatClient has already rolled up the arguments for the function call,
                            so we don't need to stream the arguments in chunks, just dispatch a complete start -> args -> end sequence.
                            */
                            await events.WriteAsync(new ToolCallStartEvent
                            {
                                ToolCallId = functionCall.CallId,
                                ToolCallName = functionCall.Name,
                                ParentMessageId = update.MessageId,
                                Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                            }, cancellationToken).ConfigureAwait(false);

                            await events.WriteAsync(new ToolCallArgsEvent
                            {
                                ToolCallId = functionCall.CallId,
                                // todo: we might want to provide a way to get at the wider serialization options from ambient context?
                                // todo: an alternative might be not exposing the underlying channel writer, and instead providing a structured type for emitting common events.
                                Delta = JsonSerializer.Serialize(functionCall.Arguments, _jsonSerOpts),
                                Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                            }, cancellationToken).ConfigureAwait(false);

                            await events.WriteAsync(new ToolCallEndEvent
                            {
                                ToolCallId = functionCall.CallId,
                                Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                            }, cancellationToken).ConfigureAwait(false);

                            agUiMessages.Add(new AssistantMessage
                            {
                                Id = string.IsNullOrEmpty(update.MessageId) ? Guid.NewGuid().ToString() : update.MessageId,
                                // todo: this ~ might ~ not be 100%, I'm unclear whether we might need to represent / concat text across multiple content items for a single message in the context of tool calls (especially if support for multiple tools is added).
                                Content = string.IsNullOrEmpty(update.Text) ? null : update.Text,
                                ToolCalls = [new ToolCall
                                {
                                    Id = functionCall.CallId,
                                    Function = new FunctionCall {
                                        Name = functionCall.Name,
                                        Arguments = JsonSerializer.Serialize(functionCall.Arguments, _jsonSerOpts)
                                    }
                                }]
                            });
                        }

                        break;

                    // We only need to emit tool messages for backend tool calls, and only if we've been asked to
                    case FunctionResultContent funcResult when _agentOptions.EmitBackendToolCalls:
                        {
                            // Ignore this as it's a frontend tool call result, we don't emit these (it's fake).
                            if (knownFrontendToolCalls.ContainsKey(funcResult.CallId))
                            {
                                continue;
                            }

                            if (!knownBackendToolCalls.TryGetValue(funcResult.CallId, out var toolName))
                            {
                                throw new KeyNotFoundException($"Encountered a tool result for a backend tool call that we're not tracking: '{funcResult.CallId}'.");
                            }

                            // We don't want the frontend to see this particular backend tool call result, so skip it.
                            if (!await ShouldEmitBackendToolCallData(toolName).ConfigureAwait(false))
                            {
                                continue;
                            }

                            if (currentResponse is not null)
                            {
                                await events.WriteAsync(new TextMessageEndEvent
                                {
                                    MessageId = currentResponse.Id,
                                    Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                                }, cancellationToken).ConfigureAwait(false);

                                agUiMessages.Add(currentResponse);
                                currentResponse = null;
                            }

                            agUiMessages.Add(new ToolMessage
                            {
                                Id = update.MessageId ?? Guid.NewGuid().ToString(),
                                // todo handle exception if the result was exceptional?
                                Content = JsonSerializer.Serialize(funcResult.Result, _jsonSerOpts),
                                ToolCallId = funcResult.CallId,
                            });

                            /*
                            When we exit the streaming loop, we need to ensure that we emit a message snapshot
                            todo:
                                This was the only place putting this that led to "correct" behaviour, but unsure if it has to be done at the end of the run
                                - admittedly doing it mid-run feels like it would confuse any frontend, and it did... awaiting a mechanism to dispatch tool call results as events instead
                            */
                            needsMessageSync = true;
                        }

                        break;

                    case DataContent data:
                        {
                            // todo: the AG-UI protocol does not current support data content, ignore these for now.
                        }
                        break;

                    // Track usage stats so the agent can be queried post-run for them
                    case UsageContent usage:
                        {
                            Usage.Add(usage.Details);
                        }
                        break;
                }
            }
        }

        // We exited the streaming loop, so end the current text message if we have one.
        if (currentResponse is not null)
        {
            await events.WriteAsync(new TextMessageEndEvent
            {
                MessageId = currentResponse.Id,
                Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            }, cancellationToken).ConfigureAwait(false);

            agUiMessages.Add(currentResponse);
            currentResponse = null;
        }

        if (needsMessageSync)
        {
            // Dispatch an update to push the tool message to the frontend.
            await events.WriteAsync(new MessagesSnapshotEvent
            {
                Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                Messages = [.. agUiMessages]
            }, cancellationToken).ConfigureAwait(false);
        }

        // todo: we could do with handling for run failure to dispatch error event (unsure how best to handle beyond a catch-all exception handler which feels blunt)
        await events.WriteAsync(new RunFinishedEvent
        {
            ThreadId = input.ThreadId,
            RunId = input.RunId,
            Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        }, cancellationToken).ConfigureAwait(false);

        events.Complete();
    }

    /// <summary>
    /// When overridden in a derived class, allows for the agent to prepare the context for the run.
    /// </summary>
    /// <remarks>
    /// Default implementation will perform AI-assisted context extraction if the agent is configured to do so.
    /// </remarks>
    /// <param name="input">The input provided to the agent for the run</param>
    /// <returns>The final context collection to use for the run</returns>
    protected virtual async Task<ImmutableList<Context>> PrepareContext(
        RunAgentInput input,
        CancellationToken cancellationToken = default
    )
    {
        var systemMessages = input.Messages.OfType<SystemMessage>().ToImmutableList();

        // If the agent is not configured to perform AI context extraction, or there are no system messages,
        // we can simply return the context provided in the input.
        if (!_agentOptions.PerformAiContextExtraction || systemMessages.IsEmpty)
        {
            return input.Context;
        }

        var extractedContext = await _chatClient.GetResponseAsync<ImmutableList<Context>>(
                new ChatMessage(
                    ChatRole.System,
                    $$"""
                    <persona>
                    You are an expert at extracting context from a provided system message.
                    </persona>

                    <rules>
                    - You MUST always respond in JSON according to the provided schema.
                    - You MUST correlate and deduplicate context from the provided system message and any existing context.
                    - You MUST preserve the `name` and `value` properties of the context VERBATIM wherever possible.
                    </rules>

                    <examples>
                        <example>
                        <input>
                        1. The name of the user: John Doe
                        2. The user's age: 30
                        </input>
                        <output>
                        ```json
                        [
                            {
                                "name": "The name of the user,
                                "value": "John Doe"
                            },
                            {
                                "name": "The user's age",
                                "value": "30"
                            }
                        ]
                        ```
                        </output>
                        </example>
                    </examples>

                    <existingContext>
                    ```json
                    {{JsonSerializer.Serialize(input.Context, _jsonSerOpts)}}
                    ```
                    </existingContext>

                    <providedSystemMessage>
                    {{string.Join("\n", systemMessages.Select(m => m.Content))}}
                    </providedSystemMessage>
                    """
                ),
                cancellationToken: cancellationToken
            ).ConfigureAwait(false);

        if (extractedContext.Usage is not null)
        {
            Usage.Add(extractedContext.Usage);
        }

        try
        {
            return extractedContext.Result;
        }
        catch (JsonException)
        {
            // todo: handle this? Perhaps get it to self-heal via the LLM, for now just ignore it and leave the context as-is
            return input.Context;
        }
    }

    /// <summary>
    /// When overridden in a derived class, allows for customisation of the system message used for the agent run.
    /// </summary>
    /// <remarks>
    /// This is only used when the system message is overridden by the agent options. Default behaviour is to honour the agent option for including context in the system message, falling back to the provided system message if not set.
    /// </remarks>
    /// <param name="input">The input to the agent for the run</param>
    /// <param name="systemMessage">The system message to use</param>
    /// <param name="context">The final context prepared for the agent</param>
    /// <returns>The final system message to use</returns>
    protected virtual ValueTask<string> PrepareSystemMessage(
        RunAgentInput input,
        string systemMessage,
        ImmutableList<Context> context
    )
    {
        if (!_agentOptions.IncludeContextInSystemMessage)
        {
            return ValueTask.FromResult(systemMessage);
        }

        return ValueTask.FromResult(
            $"{systemMessage}\n\nThe following context is available to you:\n```{JsonSerializer.Serialize(context, _jsonSerOpts)}```"
        );
    }

    /// <summary>
    /// When overridden in a derived class, allows manual mapping of AG-UI messages to chat client messages.
    /// </summary>
    /// <param name="input">The input provided to the agent for the run invocation</param>
    /// <param name="context">The final context either lifted from the input or via the LLM-assisted extraction</param>
    /// <returns>The collection of <see cref="ChatMessage"/> to use with the chat client for the run</returns>
    protected virtual async ValueTask<ImmutableList<ChatMessage>> MapAGUIMessagesToChatClientMessages(
       RunAgentInput input,
       ImmutableList<Context> context,
       CancellationToken cancellationToken = default
   )
    {
        return ChatClientMessageMapper.MapAGUIMessagesToChatClientMessages(
            (_agentOptions.SystemMessage, _agentOptions.PreserveInboundSystemMessages) switch
            {
                // No agent-specific system message, and we do not want to preserve inbound system messages.
                (null, false) => [.. input.Messages.Where(m => m is not SystemMessage)],

                // We have an agent-specific system message, which overrides any inbound system messages regardless of the preserve setting.
                (string sysMessage, _) when !string.IsNullOrWhiteSpace(sysMessage) =>
                    [.. input.Messages.Where(m => m is not SystemMessage)
                        .Prepend(new SystemMessage
                        {
                            Id = Guid.NewGuid().ToString(),
                            Content = await PrepareSystemMessage(input, sysMessage, context).ConfigureAwait(false)
                        })],

                // Fallback to just preserving inbound messages as-is.
                _ => input.Messages
            }
        );
    }

    /// <summary>
    /// When overridden in a derived class, allows for customisation of the frontend tools provided to the agent for the run.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This is useful for hiding frontend tools from the agent, or modifying their description if the agent struggles to understand its usage and you do not control the frontend.
    /// </para>
    /// <para>
    /// Caution is advised not to modify tool names, parameters, or to add new tools as this is likely to cause either silent or real failures when attempts are made to call them.
    /// </para>
    /// </remarks>
    /// <param name="frontendTools">The frontend tools already discovered from the run input</param>
    /// <param name="input">The run input provided to the agent</param>
    /// <returns>The final collection of frontend tools the agent is to be aware of for this run</returns>
    protected virtual ValueTask<ImmutableList<FrontendTool>> PrepareFrontendTools(
        ImmutableList<FrontendTool> frontendTools,
        RunAgentInput input,
        CancellationToken cancellationToken = default
    )
    {
        return ValueTask.FromResult(frontendTools);
    }

    /// <summary>
    /// When overridden in a derived class, allows for customisation of the backend tools available for the given run.
    /// </summary>
    /// <param name="backendTools">The backend tools already available via the provided chat client options</param>
    /// <param name="input">The run input provided to the agent</param>
    /// <param name="events">The events channel writer to push AG-UI events into
    /// <returns>The backend tools to make available to the agent for the run</returns>
    protected virtual ValueTask<ImmutableList<AIFunction>> PrepareBackendTools(
        ImmutableList<AIFunction> backendTools,
        RunAgentInput input,
        ChannelWriter<BaseEvent> events,
        CancellationToken cancellationToken = default
    )
    {
        // By default, zero modification.
        return ValueTask.FromResult(backendTools);
    }

    /// <summary>
    /// When overridden in a derived class, allows for customisation of whether to emit backend tool call data for the given function name.
    /// </summary>
    /// <remarks>
    /// <para>
    /// NOTE: This DOES NOT override <see cref="ChatClientAgentOptions.EmitBackendToolCalls"/> - if that is set to <c>false</c>, this method will not be called at all.
    /// </para>
    /// </remarks>
    /// <param name="functionName">The name of the backend tool being asked about</param>
    /// <returns>Whether to emit necessary data to the frontend about this tool call</returns>
    protected virtual ValueTask<bool> ShouldEmitBackendToolCallData(string functionName)
        => ValueTask.FromResult(_agentOptions.EmitBackendToolCalls);

    /// <summary>
    /// When overridden in a derived class, allows for customisation of the handling for a run starting.
    /// </summary>
    /// <remarks>
    /// The default implementation will emit a <see cref="RunStartedEvent"/> to the provided events channel.
    /// </remarks>
    /// <param name="input">The input to the agent for the current run.</param>
    /// <param name="events">The events channel writer to push events into</param>
    protected virtual async ValueTask OnRunStartedAsync(
        RunAgentInput input,
        ChannelWriter<BaseEvent> events,
        CancellationToken cancellationToken = default
    )
    {
        await events.WriteAsync(new RunStartedEvent
        {
            ThreadId = input.ThreadId,
            RunId = input.RunId,
            Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
        }, cancellationToken).ConfigureAwait(false);
    }
}
