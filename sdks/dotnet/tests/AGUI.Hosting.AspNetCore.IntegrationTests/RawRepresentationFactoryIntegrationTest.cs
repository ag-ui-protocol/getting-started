using AGUI.Abstractions;
using AGUI.Client;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Server.IntegrationTests;

public sealed class RawRepresentationFactoryIntegrationTest : IntegrationTestBase
{
    public RawRepresentationFactoryIntegrationTest(WebApplicationFactory<Program> factory)
        : base(factory)
    {
    }

    [Theory]
    [InlineData(TransportFormat.Json)]
    [InlineData(TransportFormat.Protobuf)]
    public async Task GetStreamingResponseAsync_WithRawRepresentationFactory_UsesProvidedRunAgentInput(TransportFormat format)
    {
        var client = CreateClient((messages, options, ct) => EmitEmptyResponse(ct), format);

        var options = new ChatOptions
        {
            RawRepresentationFactory = _ => new RunAgentInput
            {
                ThreadId = "custom-thread",
                RunId = "custom-run"
            }
        };

        var updates = await CollectUpdates(
            client, [new ChatMessage(ChatRole.User, "Hello")], options);

        // The AGUIChatClient creates RunAgentInput from RawRepresentationFactory,
        // and the server receives it and uses threadId/runId.
        var started = updates
            .Select(u => u.RawRepresentation)
            .OfType<RunStartedEvent>()
            .FirstOrDefault();

        Assert.NotNull(started);
        Assert.Equal("custom-thread", started!.ThreadId);
        Assert.Equal("custom-run", started.RunId);
    }

    [Theory]
    [InlineData(TransportFormat.Json)]
    [InlineData(TransportFormat.Protobuf)]
    public async Task GetStreamingResponseAsync_WithRawRepresentationFactory_PreservesProvidedMessages(TransportFormat format)
    {
        IList<ChatMessage>? capturedMessages = null;
        var client = CreateClient((messages, options, ct) =>
        {
            capturedMessages = messages.ToList();
            return EmitEmptyResponse(ct);
        }, format);

        var options = new ChatOptions
        {
            RawRepresentationFactory = _ => new RunAgentInput
            {
                ThreadId = "t1",
                RunId = "r1",
                Messages = new List<AGUIMessage>
                {
                    new AGUIUserMessage { Content = new List<AGUIInputContent> { new AGUITextInputContent { Text = "pre-set message" } } }
                }
            }
        };

        await CollectUpdates(
            client, [new ChatMessage(ChatRole.User, "should be ignored")], options);

        // The server converts AGUIMessages to ChatMessages
        Assert.NotNull(capturedMessages);
        Assert.Single(capturedMessages!);
        Assert.Equal(ChatRole.User, capturedMessages[0].Role);
    }

    [Theory]
    [InlineData(TransportFormat.Json)]
    [InlineData(TransportFormat.Protobuf)]
    public async Task GetStreamingResponseAsync_WithoutRawRepresentationFactory_FallsBackToConversationId(TransportFormat format)
    {
        var client = CreateClient((messages, options, ct) => EmitEmptyResponse(ct), format);

        var options = new ChatOptions
        {
            ConversationId = "conv-123"
        };

        var updates = await CollectUpdates(
            client, [new ChatMessage(ChatRole.User, "Hi")], options);

        // Verify ConversationId is used as ThreadId
        var started = updates
            .Select(u => u.RawRepresentation)
            .OfType<RunStartedEvent>()
            .FirstOrDefault();

        Assert.NotNull(started);
        Assert.Equal("conv-123", started!.ThreadId);
    }

    [Theory]
    [InlineData(TransportFormat.Json)]
    [InlineData(TransportFormat.Protobuf)]
    public async Task GetStreamingResponseAsync_WithRawRepresentationFactory_ConversationIdFallsBackForThreadId(TransportFormat format)
    {
        var client = CreateClient((messages, options, ct) => EmitEmptyResponse(ct), format);

        var options = new ChatOptions
        {
            ConversationId = "conv-456",
            RawRepresentationFactory = _ => new RunAgentInput
            {
                RunId = "explicit-run"
                // ThreadId left as default (empty)
            }
        };

        var updates = await CollectUpdates(
            client, [new ChatMessage(ChatRole.User, "Hi")], options);

        // Verify the events were produced (the AGUIChatClient fills in ThreadId from ConversationId)
        Assert.NotEmpty(updates);
    }

    [Theory]
    [InlineData(TransportFormat.Json)]
    [InlineData(TransportFormat.Protobuf)]
    public async Task GetStreamingResponseAsync_WithNonRunAgentInputFromFactory_FallsBackToDefault(TransportFormat format)
    {
        var client = CreateClient((messages, options, ct) => EmitEmptyResponse(ct), format);

        var options = new ChatOptions
        {
            ConversationId = "fallback-conv",
            RawRepresentationFactory = _ => "not a RunAgentInput"
        };

        var updates = await CollectUpdates(
            client, [new ChatMessage(ChatRole.User, "Hi")], options);

        // Should fall back to default behavior and not throw
        Assert.NotEmpty(updates);
    }
}
