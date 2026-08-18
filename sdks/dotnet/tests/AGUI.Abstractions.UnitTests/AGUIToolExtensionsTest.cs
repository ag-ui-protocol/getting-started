using System.Text.Json;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class AGUIToolExtensionsTest
{
    [Fact]
    public async Task AsAITools_CreatesInvocableProxyWithDeclaredMetadata()
    {
        var schema = JsonDocument.Parse("""
            {
                "type": "object",
                "properties": {
                    "city": { "type": "string" }
                },
                "required": ["city"]
            }
            """).RootElement.Clone();
        var tool = new AGUITool
        {
            Name = "get_weather",
            Description = "Gets the weather.",
            Parameters = schema,
        };

        var proxy = Assert.IsAssignableFrom<AIFunction>(Assert.Single(new[] { tool }.AsAITools()));

        Assert.Equal(tool.Name, proxy.Name);
        Assert.Equal(tool.Description, proxy.Description);
        Assert.True(JsonElement.DeepEquals(schema, proxy.JsonSchema));
        _ = new ApprovalRequiredAIFunction(proxy);

        var exception = await Assert.ThrowsAsync<InvalidOperationException>(
            async () => await proxy.InvokeAsync().ConfigureAwait(true)).ConfigureAwait(true);
        Assert.Contains("client-produced result", exception.Message);
    }
}
