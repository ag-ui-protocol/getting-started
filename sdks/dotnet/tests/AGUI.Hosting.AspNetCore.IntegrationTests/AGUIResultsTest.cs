using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using AGUI.Abstractions;
using AGUI.Formatting;
using AGUI.Samples.Shared;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace AGUI.Server.IntegrationTests;

public sealed class AGUIResultsTest
{
    private const string ProtoMediaType = "application/vnd.ag-ui.event+proto";
    private const string SseMediaType = "text/event-stream";

    [Theory]
    [InlineData("application/vnd.ag-ui.event+proto", true, ProtoMediaType)]
    [InlineData("application/vnd.ag-ui.event+proto, text/event-stream", true, ProtoMediaType)]
    [InlineData("text/event-stream, application/vnd.ag-ui.event+proto", true, ProtoMediaType)]
    [InlineData("application/vnd.ag-ui.event+proto, text/event-stream", false, SseMediaType)]
    [InlineData("text/event-stream", true, SseMediaType)]
    [InlineData("text/event-stream", false, SseMediaType)]
    [InlineData("*/*", true, SseMediaType)]
    [InlineData("*/*", false, SseMediaType)]
    [InlineData("text/*", true, SseMediaType)]
    [InlineData(null, true, SseMediaType)]
    [InlineData(null, false, SseMediaType)]
    [InlineData("application/vnd.ag-ui.event+proto;q=0, text/event-stream", true, SseMediaType)]
    public async Task Events_SelectsExpectedFormatter(string? accept, bool registerProto, string expectedContentType)
    {
        var context = CreateContext(accept, registerProto);

        var result = AGUIResults.Events(SampleEvents(), context);
        await result.ExecuteAsync(context);

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Equal(expectedContentType, context.Response.ContentType);
    }

    [Theory]
    [InlineData("application/vnd.ag-ui.event+proto")]
    [InlineData("application/vnd.ag-ui.event+proto, application/json")]
    public async Task Events_Returns406_WhenProtoOnlyAndNoProtoFormatter(string accept)
    {
        var context = CreateContext(accept, registerProto: false);

        var result = AGUIResults.Events(SampleEvents(), context);
        await result.ExecuteAsync(context);

        Assert.Equal(StatusCodes.Status406NotAcceptable, context.Response.StatusCode);
    }

    [Fact]
    public async Task Events_Returns406_WhenNoAcceptableMediaType()
    {
        var context = CreateContext("application/json", registerProto: true);

        var result = AGUIResults.Events(SampleEvents(), context);
        await result.ExecuteAsync(context);

        Assert.Equal(StatusCodes.Status406NotAcceptable, context.Response.StatusCode);
    }

    [Fact]
    public async Task Events_WritesFramedProto_WhenProtoNegotiated()
    {
        var context = CreateContext(ProtoMediaType, registerProto: true);

        var result = AGUIResults.Events(SampleEvents(), context);
        await result.ExecuteAsync(context);

        Assert.Equal(ProtoMediaType, context.Response.ContentType);

        var body = ((MemoryStream)context.Response.Body).ToArray();

        // The fake proto formatter writes a 4-byte big-endian length prefix per event.
        Assert.True(body.Length > 4);
        int firstLength = (body[0] << 24) | (body[1] << 16) | (body[2] << 8) | body[3];
        Assert.True(firstLength > 0);
    }

    [Fact]
    public async Task Events_SseBody_IsByteIdenticalToDataJsonShape()
    {
        var context = CreateContext(SseMediaType, registerProto: false);

        var evt = new RunStartedEvent { ThreadId = "t1", RunId = "r1" };

        var result = AGUIResults.Events(Single(evt), context);
        await result.ExecuteAsync(context);

        var body = Encoding.UTF8.GetString(((MemoryStream)context.Response.Body).ToArray());

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.BaseEvent);
        Assert.Equal($"data: {json}\n\n", body);
    }

    private static DefaultHttpContext CreateContext(string? accept, bool registerProto)
    {
        var services = new ServiceCollection();
        services.AddLogging();
        if (registerProto)
        {
            services.AddSingleton<IAGUIEventStreamFormatter>(new FakeProtoFormatter());
        }

        var context = new DefaultHttpContext
        {
            RequestServices = services.BuildServiceProvider(),
        };
        context.Response.Body = new MemoryStream();
        if (accept is not null)
        {
            context.Request.Headers.Accept = accept;
        }

        return context;
    }

    private static async IAsyncEnumerable<BaseEvent> SampleEvents()
    {
        yield return new RunStartedEvent { ThreadId = "t1", RunId = "r1" };
        yield return new RunFinishedEvent { ThreadId = "t1", RunId = "r1" };
        await Task.CompletedTask.ConfigureAwait(false);
    }

    private static async IAsyncEnumerable<BaseEvent> Single(BaseEvent evt)
    {
        yield return evt;
        await Task.CompletedTask.ConfigureAwait(false);
    }

    private sealed class FakeProtoFormatter : IAGUIEventStreamFormatter
    {
        public string MediaType => ProtoMediaType;

        public bool CanRead(string? contentType)
        {
            return string.Equals(contentType, ProtoMediaType, StringComparison.OrdinalIgnoreCase);
        }

        public IAsyncEnumerable<BaseEvent> ReadAsync(Stream body, CancellationToken cancellationToken)
        {
            throw new NotSupportedException();
        }

        public async Task WriteAsync(
            IAsyncEnumerable<BaseEvent> events,
            Stream output,
            CancellationToken cancellationToken)
        {
            await foreach (var evt in events.WithCancellation(cancellationToken).ConfigureAwait(false))
            {
                var payload = Encoding.UTF8.GetBytes(evt.Type);
                var prefix = new byte[4];
                prefix[0] = (byte)(payload.Length >> 24);
                prefix[1] = (byte)(payload.Length >> 16);
                prefix[2] = (byte)(payload.Length >> 8);
                prefix[3] = (byte)payload.Length;
                await output.WriteAsync(prefix, cancellationToken).ConfigureAwait(false);
                await output.WriteAsync(payload, cancellationToken).ConfigureAwait(false);
            }
        }
    }
}
