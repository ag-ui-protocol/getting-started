using System.Linq;
using System.Runtime.CompilerServices;
using System.Text.Json;
using AGUI.Abstractions;
using AGUI.Client;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Server.IntegrationTests;

public sealed class ClientToolIntegrationTest : IntegrationTestBase
{
    public ClientToolIntegrationTest(WebApplicationFactory<Program> factory)
        : base(factory)
    {
    }

    [Theory]
    [InlineData(TransportFormat.Json)]
    [InlineData(TransportFormat.Protobuf)]
    public async Task ClientTools_SentInRunAgentInput_ConvertedToAITools(TransportFormat format)
    {
        ChatOptions? capturedOptions = null;

        var client = CreateClient((messages, options, ct) =>
        {
            capturedOptions = options;
            return EmitEmptyResponse(ct);
        }, format);

        var clientTool = AIFunctionFactory.Create(
            (string location) => $"Sunny in {location}",
            "get_weather",
            "Gets the weather for a location");

        var options = new ChatOptions { Tools = [clientTool] };

        await CollectUpdates(client, [new ChatMessage(ChatRole.User, "What's the weather?")], options);

        Assert.NotNull(capturedOptions);
        Assert.NotNull(capturedOptions!.Tools);
        Assert.Single(capturedOptions.Tools);
        Assert.Equal("get_weather", capturedOptions.Tools[0].Name);
    }

    [Theory]
    [InlineData(TransportFormat.Json)]
    [InlineData(TransportFormat.Protobuf)]
    public async Task ClientToolAutoInvocation_ServerRequestsClientTool_FunctionInvokedByFunctionInvokingChatClient(TransportFormat format)
    {
        var invocationCount = 0;
        var clientTool = AIFunctionFactory.Create(
            (string location) =>
            {
                Interlocked.Increment(ref invocationCount);
                return $"Sunny in {location}";
            },
            "get_weather",
            "Gets the weather for a location");

        var turnCount = 0;

        var client = CreateClient((messages, options, ct) =>
        {
            var turn = Interlocked.Increment(ref turnCount);
            if (turn == 1)
            {
                // First turn: request the client tool
                return EmitToolCallResponse("call-1", "get_weather",
                    new Dictionary<string, object?> { ["location"] = "Seattle" }, ct);
            }

            // Second turn: FunctionInvokingChatClient sends the tool result back,
            // we respond with text
            return EmitTextResponse("It's sunny in Seattle!", ct);
        }, format);

        var options = new ChatOptions { Tools = [clientTool] };
        var updates = await CollectUpdates(
            client, [new ChatMessage(ChatRole.User, "What's the weather in Seattle?")], options);

        // The FunctionInvokingChatClient should have auto-invoked the client tool
        Assert.Equal(1, invocationCount);

        // Should have text content from the second turn
        var textUpdates = updates
            .Where(u => u.Text != null && u.Text.Length > 0)
            .ToList();
        Assert.Contains(textUpdates, u => u.Text!.Contains("sunny"));
    }

    [Theory]
    [InlineData(TransportFormat.Json)]
    [InlineData(TransportFormat.Protobuf)]
    public async Task ServerToolPassThrough_NotInClientTools_YieldedAsFunctionCallContent(TransportFormat format)
    {
        // A dummy client tool is needed so AGUIChatClient can distinguish client vs server tools.
        // When clientToolSet is non-empty, tool calls not matching any client tool are treated as
        // server tools and hidden from the internal FunctionInvokingChatClient.
        var dummyClientTool = AIFunctionFactory.Create(
            (string x) => x,
            "unrelated_client_tool",
            "A client tool not related to the server tool");

        var client = CreateClient((messages, options, ct) =>
            EmitToolCallResponse("call-1", "server_only_tool",
                new Dictionary<string, object?> { ["key"] = "value" }, ct), format);

        var options = new ChatOptions { Tools = [dummyClientTool] };
        var updates = await CollectUpdates(
            client, [new ChatMessage(ChatRole.User, "Do something")], options);

        // Server tool call should be yielded as FunctionCallContent (not auto-invoked)
        var funcCallUpdates = updates
            .Where(u => u.Contents.OfType<FunctionCallContent>().Any())
            .ToList();

        Assert.Single(funcCallUpdates);
        var funcCall = funcCallUpdates[0].Contents.OfType<FunctionCallContent>().Single();
        Assert.Equal("server_only_tool", funcCall.Name);
        Assert.Equal("call-1", funcCall.CallId);
    }

    [Theory]
    [InlineData(TransportFormat.Json)]
    [InlineData(TransportFormat.Protobuf)]
    public async Task ServerToolPassThrough_WithClientTools_ServerToolNotAutoInvoked(TransportFormat format)
    {
        var clientTool = AIFunctionFactory.Create(
            (string x) => x,
            "client_tool",
            "A client tool");

        var client = CreateClient((messages, options, ct) =>
            EmitToolCallResponse("call-1", "server_tool",
                new Dictionary<string, object?> { ["data"] = "test" }, ct), format);

        var options = new ChatOptions { Tools = [clientTool] };
        var updates = await CollectUpdates(
            client, [new ChatMessage(ChatRole.User, "Do something")], options);

        // Server tool call should still be yielded as FunctionCallContent
        var funcCallUpdates = updates
            .Where(u => u.Contents.OfType<FunctionCallContent>().Any())
            .ToList();

        Assert.Single(funcCallUpdates);
        var funcCall = funcCallUpdates[0].Contents.OfType<FunctionCallContent>().Single();
        Assert.Equal("server_tool", funcCall.Name);
    }
}
