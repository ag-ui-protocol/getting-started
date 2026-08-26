using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using AGUI.Protobuf;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace AGUI.Server.IntegrationTests;

public sealed class MultimodalInputIntegrationTest : IntegrationTestBase
{
    public MultimodalInputIntegrationTest(WebApplicationFactory<Program> factory)
        : base(factory)
    {
    }

    [Theory]
    [InlineData(TransportFormat.Json)]
    [InlineData(TransportFormat.Protobuf)]
    public async Task PostRun_CanonicalMultimodalContent_ReachesInnerChatClient(TransportFormat format)
    {
        List<ChatMessage>? capturedMessages = null;
        var configuredFactory = Factory.WithWebHostBuilder(builder =>
        {
            builder.ConfigureTestServices(services =>
            {
                services.AddSingleton(sp =>
                {
                    var client = new DelegatingStreamingChatClient();
                    client.SetHandler((messages, options, ct) =>
                    {
                        capturedMessages = messages.ToList();
                        return EmitEmptyResponse(ct);
                    });
                    return client;
                });
            });
        });
        using var httpClient = configuredFactory.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Post, "/agui")
        {
            Content = new StringContent(
                """
                {
                  "threadId": "thread-1",
                  "runId": "run-1",
                  "messages": [
                    {
                      "id": "message-1",
                      "role": "user",
                      "content": [
                        { "type": "text", "text": "Summarize this report." },
                        {
                          "type": "image",
                          "source": {
                            "type": "url",
                            "value": "https://example.com/chart.png",
                            "mimeType": "image/png"
                          },
                          "metadata": { "detail": "high" }
                        },
                        {
                          "type": "document",
                          "source": {
                            "type": "data",
                            "value": "JVBERg==",
                            "mimeType": "application/pdf"
                          },
                          "metadata": { "filename": "report.pdf" }
                        }
                      ]
                    }
                  ],
                  "context": []
                }
                """,
                Encoding.UTF8,
                "application/json")
        };
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue(
            format == TransportFormat.Protobuf
                ? ProtobufEventStreamFormatter.ProtobufMediaType
                : "text/event-stream"));

        using var response = await httpClient.SendAsync(request);

        response.EnsureSuccessStatusCode();
        Assert.NotNull(capturedMessages);
        var chatMessage = Assert.Single(capturedMessages);
        Assert.Equal("message-1", chatMessage.MessageId);
        Assert.Collection(
            chatMessage.Contents,
            content => Assert.Equal("Summarize this report.", Assert.IsType<TextContent>(content).Text),
            content =>
            {
                var uri = Assert.IsType<UriContent>(content);
                Assert.Equal("https://example.com/chart.png", uri.Uri.ToString());
                Assert.Equal("image/png", uri.MediaType);
                var metadata = Assert.IsType<JsonElement>(uri.AdditionalProperties?["metadata"]);
                Assert.Equal("high", metadata.GetProperty("detail").GetString());
            },
            content =>
            {
                var data = Assert.IsType<DataContent>(content);
                Assert.Equal(System.Convert.FromBase64String("JVBERg=="), data.Data.ToArray());
                Assert.Equal("application/pdf", data.MediaType);
                Assert.Equal("report.pdf", data.Name);
                var metadata = Assert.IsType<JsonElement>(data.AdditionalProperties?["metadata"]);
                Assert.Equal("report.pdf", metadata.GetProperty("filename").GetString());
            });
    }
}
