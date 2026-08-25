using System.Text.Json;
using AGUI.Abstractions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Xunit;

namespace AGUI.Server.IntegrationTests;

public sealed class CapabilitiesEndpointIntegrationTest
{
    [Fact]
    public async Task MapAGUICapabilities_ReturnsCapabilitiesJson()
    {
        var capabilities = new AgentCapabilities
        {
            Identity = new IdentityCapabilities
            {
                Name = "TestAgent",
                Type = "ag-ui-dotnet",
                Version = "1.0.0"
            },
            Transport = new TransportCapabilities
            {
                Streaming = true
            },
            Tools = new ToolsCapabilities
            {
                Supported = true,
                ClientProvided = true
            }
        };

        await using var app = CreateApp(capabilities);
        await app.StartAsync();
        var client = app.GetTestClient();

        var response = await client.GetAsync("/capabilities");

        response.EnsureSuccessStatusCode();

        var json = await response.Content.ReadAsStringAsync();
        var result = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.AgentCapabilities);

        Assert.NotNull(result);
        Assert.Equal("TestAgent", result.Identity?.Name);
        Assert.Equal("ag-ui-dotnet", result.Identity?.Type);
        Assert.Equal("1.0.0", result.Identity?.Version);
        Assert.True(result.Transport?.Streaming);
        Assert.True(result.Tools?.Supported);
        Assert.True(result.Tools?.ClientProvided);
    }

    [Fact]
    public async Task MapAGUICapabilities_WithFactory_ReturnsDynamicCapabilities()
    {
        var toolCount = 0;
        var capabilitiesFactory = () =>
        {
            toolCount++;
            return new AgentCapabilities
            {
                Identity = new IdentityCapabilities { Name = $"Agent-{toolCount}" }
            };
        };

        await using var app = CreateApp(capabilitiesFactory);
        await app.StartAsync();
        var client = app.GetTestClient();

        var response1 = await client.GetAsync("/capabilities");
        response1.EnsureSuccessStatusCode();
        var json1 = await response1.Content.ReadAsStringAsync();
        var result1 = JsonSerializer.Deserialize(json1, AGUIJsonSerializerContext.Default.AgentCapabilities);

        var response2 = await client.GetAsync("/capabilities");
        response2.EnsureSuccessStatusCode();
        var json2 = await response2.Content.ReadAsStringAsync();
        var result2 = JsonSerializer.Deserialize(json2, AGUIJsonSerializerContext.Default.AgentCapabilities);

        Assert.Equal("Agent-1", result1?.Identity?.Name);
        Assert.Equal("Agent-2", result2?.Identity?.Name);
    }

    [Fact]
    public async Task MapAGUICapabilities_PostRequest_Returns405()
    {
        var capabilities = new AgentCapabilities
        {
            Identity = new IdentityCapabilities { Name = "TestAgent" }
        };

        await using var app = CreateApp(capabilities);
        await app.StartAsync();
        var client = app.GetTestClient();

        var response = await client.PostAsync("/capabilities", null);

        Assert.Equal(System.Net.HttpStatusCode.MethodNotAllowed, response.StatusCode);
    }

    private static WebApplication CreateApp(AgentCapabilities capabilities)
    {
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Services.AddAGUI();
        builder.Services.AddRouting();
        var app = builder.Build();
        app.MapAGUICapabilities("/capabilities", capabilities);
        return app;
    }

    private static WebApplication CreateApp(Func<AgentCapabilities> capabilitiesFactory)
    {
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Services.AddAGUI();
        builder.Services.AddRouting();
        var app = builder.Build();
        app.MapAGUICapabilities("/capabilities", capabilitiesFactory);
        return app;
    }
}
