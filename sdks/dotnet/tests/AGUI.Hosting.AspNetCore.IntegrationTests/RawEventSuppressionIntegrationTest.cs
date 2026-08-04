using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using AGUI.Abstractions;
using AGUI.Samples.Shared;
using AGUI.Server;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace AGUI.Server.IntegrationTests;

/// <summary>
/// Verifies that <see cref="AGUIStreamOptions.IncludeRawEvents"/> reaches the wire: the field is
/// serialized into the SSE body by default and absent from it when the option is turned off.
/// </summary>
public sealed class RawEventSuppressionIntegrationTest
{
    private const string SseMediaType = "text/event-stream";

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task SseBody_ContainsRawEvent_OnlyWhenIncludeRawEventsIsTrue(bool includeRawEvents)
    {
        var body = await WriteSseBody(new AGUIStreamOptions { IncludeRawEvents = includeRawEvents });

        Assert.Equal(includeRawEvents, body.Contains("\"rawEvent\""));

        // The events themselves are on the wire either way — only the field differs.
        Assert.Contains("TEXT_MESSAGE_CONTENT", body);
        Assert.Contains("TOOL_CALL_ARGS", body);
    }

    [Fact]
    public async Task SseBody_DefaultOptions_ContainRawEvent()
    {
        var body = await WriteSseBody(new AGUIStreamOptions());

        Assert.Contains("\"rawEvent\"", body);
    }

    private static async Task<string> WriteSseBody(AGUIStreamOptions streamOptions)
    {
        var input = new RunAgentInput { ThreadId = "thread-1", RunId = "run-1" };
        var ctx = input.ToChatRequestContext(AIJsonUtilities.DefaultOptions, streamOptions);

        var context = new DefaultHttpContext
        {
            RequestServices = new ServiceCollection().AddLogging().BuildServiceProvider(),
        };
        context.Response.Body = new MemoryStream();
        context.Request.Headers.Accept = SseMediaType;

        var result = AGUIResults.Events(Updates().AsAGUIEventStreamAsync(ctx), context);
        await result.ExecuteAsync(context).ConfigureAwait(false);

        Assert.Equal(SseMediaType, context.Response.ContentType);

        return Encoding.UTF8.GetString(((MemoryStream)context.Response.Body).ToArray());
    }

    private static async IAsyncEnumerable<ChatResponseUpdate> Updates()
    {
        yield return new ChatResponseUpdate(ChatRole.Assistant, "Hello") { MessageId = "msg-1" };
        yield return new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            MessageId = "msg-1",
            Contents = [new FunctionCallContent("call-1", "search", new Dictionary<string, object?> { ["q"] = "x" })],
        };

        await Task.CompletedTask.ConfigureAwait(false);
    }
}
