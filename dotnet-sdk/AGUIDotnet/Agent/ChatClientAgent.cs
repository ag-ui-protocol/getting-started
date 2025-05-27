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
    public bool IncludeContextInSystemMessage { get; init; } = true;
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
        )).Where(t => t is not FrontendTool).ToImmutableList();

        var frontendTools = await PrepareFrontendTools(
            [.. input.Tools.Select(t => new FrontendTool(t))],
            input,
            cancellationToken);

        var frontendToolNames = frontendTools.Select(t => t.Name).ToImmutableHashSet();

        {
            var conflictingTools = frontendToolNames.Intersect(backendTools.Select(t => t.Name).ToImmutableHashSet());

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

        var context = await PrepareContext(input, cancellationToken);
        var mappedMessages = await MapAGUIMessagesToChatClientMessages(input, context, cancellationToken);

        var inFlightFrontendCalls = new HashSet<string>();

        // Handle the run starting
        await OnRunStartedAsync(input, events, cancellationToken);

        string? currentResponseId = null;

        await foreach (var update in _chatClient.GetStreamingResponseAsync(mappedMessages, chatOpts, cancellationToken))
        {
            /*
            The function invocation loop provided by the chat client abstractions will still yield function result contents
            for the frontend tools, even though we short-circuited the invocation loop.

            We need to ensure we skip these updates, as they're not relevant and would confuse the frontend and subsequent runs.
            */
            if (update.Contents.OfType<FunctionResultContent>().Any(fr => inFlightFrontendCalls.Contains(fr.CallId)))
            {
                Debug.Assert(update.Contents.Count == 1, $"Expected on a single content item when ignoring dispatched frontend tool calls, but got {update.Contents.Count}.");
                continue;
            }

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
                            if (currentResponseId is not null && update.MessageId != currentResponseId)
                            {
                                await events.WriteAsync(new TextMessageEndEvent
                                {
                                    MessageId = currentResponseId,
                                    Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                                }, cancellationToken);

                                currentResponseId = null;
                            }

                            // If this is the first text content and we don't have a current response ID, we need to start a new text message.
                            if (currentResponseId is null)
                            {
                                currentResponseId = update.MessageId ?? Guid.NewGuid().ToString();

                                await events.WriteAsync(new TextMessageStartEvent
                                {
                                    MessageId = currentResponseId,
                                    Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                                }, cancellationToken);
                            }

                            Debug.Assert(currentResponseId is not null, "Handling text content without a current response message ID.");

                            // Only emit text content if it is not empty (we allow whitespace as that may have been chunked, and still be valid).
                            if (!string.IsNullOrEmpty(text.Text))
                            {
                                await events.WriteAsync(new TextMessageContentEvent
                                {
                                    MessageId = currentResponseId,
                                    Delta = text.Text,
                                    Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                                }, cancellationToken);
                            }
                        }
                        break;

                    case DataContent data:
                        {
                            // todo: the AG-UI protocol does not current support data content, ignore these for now.
                        }
                        break;

                    // We have a function call that we know is for a frontend tool.
                    case FunctionCallContent functionCall when frontendToolNames.Contains(functionCall.Name):
                        {
                            // We need to end the current text message if we have one, in order to dispatch a frontend tool call.
                            if (currentResponseId is not null)
                            {
                                await events.WriteAsync(new TextMessageEndEvent
                                {
                                    MessageId = currentResponseId,
                                    Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                                }, cancellationToken);
                                currentResponseId = null;
                            }

                            inFlightFrontendCalls.Add(functionCall.CallId);

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
                            }, cancellationToken);

                            await events.WriteAsync(new ToolCallArgsEvent
                            {
                                ToolCallId = functionCall.CallId,
                                // todo: we might want to provide a way to get at the wider serialization options from ambient context?
                                // todo: an alternative might be not exposing the underlying channel writer, and instead providing a structured type for emitting common events.
                                Delta = JsonSerializer.Serialize(functionCall.Arguments, _jsonSerOpts),
                                Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                            }, cancellationToken);

                            await events.WriteAsync(new ToolCallEndEvent
                            {
                                ToolCallId = functionCall.CallId,
                                Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                            }, cancellationToken);
                        }

                        break;

                    case UsageContent usage:
                        {
                            Usage.Add(usage.Details);
                        }
                        break;
                }
            }
        }

        // We exited the streaming loop, so end the current text message if we have one.
        if (currentResponseId is not null)
        {
            await events.WriteAsync(new TextMessageEndEvent
            {
                MessageId = currentResponseId,
                Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            }, cancellationToken);
        }

        await events.WriteAsync(new RunFinishedEvent
        {
            ThreadId = input.ThreadId,
            RunId = input.RunId,
            Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        }, cancellationToken);

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
            );

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
                            Content = await PrepareSystemMessage(input, sysMessage, context)
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
        }, cancellationToken);
    }
}
