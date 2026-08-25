using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using AGUI.Abstractions;
using AGUI.Client;
using AGUI.Formatting;
using Xunit;

namespace AGUI.Client.UnitTests;

public sealed class AGUIEventStreamHandlerTest
{
    private const string ProtoMediaType = "application/vnd.ag-ui.event+proto";
    private const string SseMediaType = "text/event-stream";

    [Fact]
    public async Task SendAsync_SetsAcceptHeaderFromFormattersInOrder()
    {
        HttpRequestMessage? captured = null;
        var inner = new TestInnerHandler((request, _) =>
        {
            captured = request;
            return Task.FromResult(CreateResponse(SseMediaType, string.Empty));
        });

        var handler = new AGUIEventStreamHandler(new IAGUIEventStreamFormatter[]
        {
            new FakeFormatter(ProtoMediaType, []),
            new FakeFormatter(SseMediaType, []),
        })
        {
            InnerHandler = inner,
        };

        using var client = new HttpClient(handler);
        using var response = await client.PostAsync("http://localhost/agent", null);

        Assert.NotNull(captured);
        Assert.Equal("application/vnd.ag-ui.event+proto, text/event-stream", captured!.Headers.Accept.ToString());
    }

    [Fact]
    public async Task SendAsync_RecordsChosenFormatterForResponseContentType()
    {
        var protoEvents = new BaseEvent[] { new RunStartedEvent { ThreadId = "t1", RunId = "r1" } };
        var protoFormatter = new FakeFormatter(ProtoMediaType, protoEvents);

        var inner = new TestInnerHandler((_, _) =>
            Task.FromResult(CreateResponse(ProtoMediaType, "ignored")));

        var handler = new AGUIEventStreamHandler(new IAGUIEventStreamFormatter[]
        {
            protoFormatter,
            new FakeFormatter(SseMediaType, []),
        })
        {
            InnerHandler = inner,
        };

        using var client = new HttpClient(handler);
        using var response = await client.PostAsync("http://localhost/agent", null);

        var results = new List<BaseEvent>();
        await foreach (var evt in response.ReadAGUIEventStreamAsync(CancellationToken.None))
        {
            results.Add(evt);
        }

        Assert.Single(results);
        Assert.IsType<RunStartedEvent>(results[0]);
    }

    [Fact]
    public async Task ReadAGUIEventStreamAsync_WithoutHandler_DefaultsToSse()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "Hi" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" },
        };

        using var response = CreateResponse(SseMediaType, BuildSse(events));
        response.RequestMessage = new HttpRequestMessage(HttpMethod.Post, "http://localhost/agent");

        var results = new List<BaseEvent>();
        await foreach (var evt in response.ReadAGUIEventStreamAsync(CancellationToken.None))
        {
            results.Add(evt);
        }

        Assert.Equal(3, results.Count);
        Assert.IsType<RunStartedEvent>(results[0]);
        Assert.Equal("Hi", Assert.IsType<TextMessageContentEvent>(results[1]).Delta);
        Assert.IsType<RunFinishedEvent>(results[2]);
    }

    private static string BuildSse(BaseEvent[] events)
    {
        var options = AGUIJsonSerializerContext.Default.Options;
        var sb = new StringBuilder();
        foreach (var evt in events)
        {
            var json = JsonSerializer.Serialize(evt, options.GetTypeInfo(typeof(BaseEvent)));
            sb.Append(System.Globalization.CultureInfo.InvariantCulture, $"data: {json}\n\n");
        }

        return sb.ToString();
    }

    private static HttpResponseMessage CreateResponse(string mediaType, string content)
    {
        return new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(content, Encoding.UTF8, mediaType),
        };
    }

    private sealed class FakeFormatter : IAGUIEventStreamFormatter
    {
        private readonly IReadOnlyList<BaseEvent> _events;

        public FakeFormatter(string mediaType, IReadOnlyList<BaseEvent> events)
        {
            MediaType = mediaType;
            _events = events;
        }

        public string MediaType { get; }

        public bool CanRead(string? contentType)
        {
            return string.Equals(contentType, MediaType, StringComparison.OrdinalIgnoreCase);
        }

        public async IAsyncEnumerable<BaseEvent> ReadAsync(
            Stream body,
            [EnumeratorCancellation] CancellationToken cancellationToken)
        {
            foreach (var evt in _events)
            {
                cancellationToken.ThrowIfCancellationRequested();
                yield return evt;
            }

            await Task.CompletedTask.ConfigureAwait(false);
        }

        public Task WriteAsync(
            IAsyncEnumerable<BaseEvent> events,
            Stream output,
            CancellationToken cancellationToken)
        {
            throw new NotSupportedException();
        }
    }

    private sealed class TestInnerHandler : DelegatingHandler
    {
        private readonly Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> _handler;

        public TestInnerHandler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> handler)
        {
            _handler = handler;
        }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return _handler(request, cancellationToken);
        }
    }
}
