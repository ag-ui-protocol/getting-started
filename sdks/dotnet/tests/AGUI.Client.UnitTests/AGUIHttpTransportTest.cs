using System.Net;
using System.Text;
using System.Text.Json;
using AGUI.Abstractions;
using AGUI.Client;
using Xunit;

namespace AGUI.Client.UnitTests;

public sealed class AGUIHttpTransportTest
{
    private static readonly JsonSerializerOptions s_options = AGUIJsonSerializerContext.Default.Options;

    [Fact]
    public async Task SendAsync_SuccessfulResponse_ParsesSSEEvents()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "Hello" },
            new TextMessageEndEvent { MessageId = "m1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        using var client = CreateHttpClient(events, HttpStatusCode.OK);
        var service = new AGUIHttpTransport(client, "http://localhost/agent");
        var input = CreateInput();

        var results = new List<BaseEvent>();
        await foreach (var evt in service.SendAsync(input, CancellationToken.None))
        {
            results.Add(evt);
        }

        Assert.Equal(5, results.Count);
        Assert.IsType<RunStartedEvent>(results[0]);
        Assert.IsType<TextMessageStartEvent>(results[1]);
        Assert.IsType<TextMessageContentEvent>(results[2]);
        Assert.IsType<TextMessageEndEvent>(results[3]);
        Assert.IsType<RunFinishedEvent>(results[4]);
    }

    [Fact]
    public async Task SendAsync_NonSuccessStatusCode_ThrowsHttpRequestException()
    {
        using var client = CreateHttpClient([], HttpStatusCode.InternalServerError);
        var service = new AGUIHttpTransport(client, "http://localhost/agent");
        var input = CreateInput();

        await Assert.ThrowsAsync<HttpRequestException>(async () =>
        {
            await foreach (var _ in service.SendAsync(input, CancellationToken.None).ConfigureAwait(false))
            {
            }
        });
    }

    [Fact]
    public async Task SendAsync_NotFound_ThrowsHttpRequestException()
    {
        using var client = CreateHttpClient([], HttpStatusCode.NotFound);
        var service = new AGUIHttpTransport(client, "http://localhost/agent");
        var input = CreateInput();

        await Assert.ThrowsAsync<HttpRequestException>(async () =>
        {
            await foreach (var _ in service.SendAsync(input, CancellationToken.None).ConfigureAwait(false))
            {
            }
        });
    }

    [Fact]
    public async Task SendAsync_EmptyStream_CompletesSuccessfully()
    {
        using var client = CreateHttpClient([], HttpStatusCode.OK);
        var service = new AGUIHttpTransport(client, "http://localhost/agent");
        var input = CreateInput();

        var results = new List<BaseEvent>();
        await foreach (var evt in service.SendAsync(input, CancellationToken.None))
        {
            results.Add(evt);
        }

        Assert.Empty(results);
    }

    [Fact]
    public async Task SendAsync_CancellationRequested_ThrowsOperationCanceled()
    {
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        var handler = new TestDelegatingHandler((_, _) =>
        {
            // This should not be reached since the token is already cancelled
            throw new InvalidOperationException("Should not reach here");
        });

        using var client = new HttpClient(handler);
        var service = new AGUIHttpTransport(client, "http://localhost/agent");
        var input = CreateInput();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
        {
            await foreach (var _ in service.SendAsync(input, cts.Token).ConfigureAwait(false))
            {
            }
        });
    }

    [Fact]
    public async Task SendAsync_CancellationDuringEnumeration_StopsConsumer()
    {
        using var cts = new CancellationTokenSource();

        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "Hello" },
            new TextMessageEndEvent { MessageId = "m1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        using var client = CreateHttpClient(events, HttpStatusCode.OK);
        var service = new AGUIHttpTransport(client, "http://localhost/agent");
        var input = CreateInput();

        // Verify that a consumer can cancel its own enumeration
        var results = new List<BaseEvent>();
        await foreach (var evt in service.SendAsync(input, cts.Token))
        {
            results.Add(evt);
            if (evt is TextMessageContentEvent)
            {
                break; // Consumer decides to stop
            }
        }

        // We stopped after receiving the content event
        Assert.Equal(3, results.Count);
        Assert.IsType<RunStartedEvent>(results[0]);
        Assert.IsType<TextMessageStartEvent>(results[1]);
        Assert.IsType<TextMessageContentEvent>(results[2]);
    }

    [Fact]
    public async Task SendAsync_MultipleEventTypes_DeserializesCorrectly()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "get_weather" },
            new ToolCallArgsEvent { ToolCallId = "tc1", Delta = "{\"loc\":\"NYC\"}" },
            new ToolCallEndEvent { ToolCallId = "tc1" },
            new RunErrorEvent { Message = "Something failed", Code = "ERR01" },
        };

        using var client = CreateHttpClient(events, HttpStatusCode.OK);
        var service = new AGUIHttpTransport(client, "http://localhost/agent");
        var input = CreateInput();

        var results = new List<BaseEvent>();
        await foreach (var evt in service.SendAsync(input, CancellationToken.None))
        {
            results.Add(evt);
        }

        Assert.Equal(5, results.Count);
        var started = Assert.IsType<RunStartedEvent>(results[0]);
        Assert.Equal("t1", started.ThreadId);

        var toolStart = Assert.IsType<ToolCallStartEvent>(results[1]);
        Assert.Equal("get_weather", toolStart.ToolCallName);

        var toolArgs = Assert.IsType<ToolCallArgsEvent>(results[2]);
        Assert.Equal("{\"loc\":\"NYC\"}", toolArgs.Delta);

        Assert.IsType<ToolCallEndEvent>(results[3]);

        var error = Assert.IsType<RunErrorEvent>(results[4]);
        Assert.Equal("Something failed", error.Message);
    }

    [Fact]
    public async Task SendAsync_MultipleEventsInSingleChunk_ParsesAll()
    {
        // Build SSE content with all events in a single chunk (no artificial splitting)
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "A" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "B" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "C" },
            new TextMessageEndEvent { MessageId = "m1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        using var client = CreateHttpClient(events, HttpStatusCode.OK);
        var service = new AGUIHttpTransport(client, "http://localhost/agent");
        var input = CreateInput();

        var results = new List<BaseEvent>();
        await foreach (var evt in service.SendAsync(input, CancellationToken.None))
        {
            results.Add(evt);
        }

        Assert.Equal(7, results.Count);

        // Verify deltas are in order
        var content1 = Assert.IsType<TextMessageContentEvent>(results[2]);
        var content2 = Assert.IsType<TextMessageContentEvent>(results[3]);
        var content3 = Assert.IsType<TextMessageContentEvent>(results[4]);
        Assert.Equal("A", content1.Delta);
        Assert.Equal("B", content2.Delta);
        Assert.Equal("C", content3.Delta);
    }

    [Fact]
    public async Task SendAsync_StateAndActivityEvents_DeserializeCorrectly()
    {
        var stateValue = JsonDocument.Parse("{\"count\":42}").RootElement.Clone();
        var patchOps = JsonDocument.Parse("[{\"op\":\"replace\",\"path\":\"/count\",\"value\":43}]").RootElement.Clone();
        var activityContent = JsonDocument.Parse("{\"text\":\"Processing request\"}").RootElement.Clone();

        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new StateSnapshotEvent { Snapshot = stateValue },
            new StateDeltaEvent { Delta = patchOps },
            new ActivitySnapshotEvent { MessageId = "a1", ActivityType = "PLAN", Content = activityContent },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        using var client = CreateHttpClient(events, HttpStatusCode.OK);
        var service = new AGUIHttpTransport(client, "http://localhost/agent");
        var input = CreateInput();

        var results = new List<BaseEvent>();
        await foreach (var evt in service.SendAsync(input, CancellationToken.None))
        {
            results.Add(evt);
        }

        Assert.Equal(5, results.Count);
        var snapshot = Assert.IsType<StateSnapshotEvent>(results[1]);
        Assert.Equal(42, snapshot.Snapshot.GetProperty("count").GetInt32());

        var delta = Assert.IsType<StateDeltaEvent>(results[2]);
        Assert.Equal("replace", delta.Delta[0].GetProperty("op").GetString());

        var activity = Assert.IsType<ActivitySnapshotEvent>(results[3]);
        Assert.Equal("PLAN", activity.ActivityType);
    }

    private static RunAgentInput CreateInput()
    {
        return new RunAgentInput
        {
            ThreadId = "t1",
            RunId = "r1",
        };
    }

    private static HttpClient CreateHttpClient(BaseEvent[] events, HttpStatusCode statusCode)
    {
        var sseContent = new StringBuilder();
        foreach (var evt in events)
        {
            var json = JsonSerializer.Serialize(evt, s_options.GetTypeInfo(typeof(BaseEvent)));
            sseContent.Append(System.Globalization.CultureInfo.InvariantCulture, $"data: {json}\n\n");
        }

        var handler = new TestDelegatingHandler((_, _) =>
        {
            return Task.FromResult(new HttpResponseMessage
            {
                StatusCode = statusCode,
                Content = new StringContent(sseContent.ToString(), Encoding.UTF8, "text/event-stream")
            });
        });

        return new HttpClient(handler);
    }

    private sealed class TestDelegatingHandler : DelegatingHandler
    {
        private readonly Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> _handler;

        public TestDelegatingHandler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> handler)
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
