using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using AGUI.Abstractions;
using AGUI.Server;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.A2UI.UnitTests;

/// <summary>
/// Pins the injectA2UITool gate and the render-proxy drop in <see cref="A2UIChatClient"/>: the
/// middleware injects a render_a2ui proxy into RunAgentInput.Tools in the same step it forwards
/// injectA2UITool, and the planner must never be handed that proxy (it would paint a surface
/// directly, skipping the subagent + validate-and-retry loop).
/// </summary>
public sealed class A2UIInjectionGateTest
{
    private const string GenerateTool = A2UIConstants.GenerateA2UIToolName;
    private const string RenderProxy = A2UIConstants.RenderA2UIToolName;

    [Fact]
    public async Task NoForwardedFlagAndNoBackendOptIn_DoesNotInjectAsync()
    {
        // Wrapping alone must not advertise a tool whose surfaces nothing on the client is
        // necessarily set up to paint.
        var planner = await RunAsync(new A2UIChatClientOptions(), forwardedJson: null);
        Assert.DoesNotContain(GenerateTool, planner.LastToolNames);
    }

    [Fact]
    public async Task BackendOptIn_WithoutForwardedFlag_InjectsAsync()
    {
        var planner = await RunAsync(new A2UIChatClientOptions { InjectA2UITool = true }, forwardedJson: null);
        Assert.Contains(GenerateTool, planner.LastToolNames);
    }

    [Fact]
    public async Task BackendExplicitFalse_DoesNotInjectAsync()
    {
        var planner = await RunAsync(new A2UIChatClientOptions { InjectA2UITool = false }, forwardedJson: null);
        Assert.DoesNotContain(GenerateTool, planner.LastToolNames);
    }

    [Fact]
    public async Task ForwardedTrue_InjectsWithoutBackendOptInAsync()
    {
        var planner = await RunAsync(new A2UIChatClientOptions(), """{"injectA2UITool":true}""");
        Assert.Contains(GenerateTool, planner.LastToolNames);
    }

    [Fact]
    public async Task ForwardedFalse_BeatsBackendOptInAsync()
    {
        var planner = await RunAsync(new A2UIChatClientOptions { InjectA2UITool = true }, """{"injectA2UITool":false}""");
        Assert.DoesNotContain(GenerateTool, planner.LastToolNames);
    }

    [Fact]
    public async Task ForwardedNonBooleanNonString_TreatedAsAbsentAsync()
    {
        // A number is not a usable flag; fall through to the backend option rather than silently
        // disabling or enabling on malformed input.
        var planner = await RunAsync(new A2UIChatClientOptions { InjectA2UITool = true }, """{"injectA2UITool":3}""");
        Assert.Contains(GenerateTool, planner.LastToolNames);
    }

    [Fact]
    public async Task ForwardedEmptyString_DoesNotInjectAsync()
    {
        // "" is falsy in the TS/Python adapters' `if (!flag)` gate, so it's an opt-out, not absent.
        var planner = await RunAsync(new A2UIChatClientOptions(), """{"injectA2UITool":""}""");
        Assert.DoesNotContain(GenerateTool, planner.LastToolNames);
    }

    [Fact]
    public async Task ForwardedStringName_InjectsAndDropsThatProxyAsync()
    {
        var planner = await RunAsync(new A2UIChatClientOptions(), """{"injectA2UITool":"render_ui_custom"}""", ["render_ui_custom"]);
        Assert.Contains(GenerateTool, planner.LastToolNames);
        Assert.DoesNotContain("render_ui_custom", planner.LastToolNames);
    }

    [Fact]
    public async Task BackendInjectedRenderToolName_DropsThatProxyAsync()
    {
        var options = new A2UIChatClientOptions { InjectA2UITool = true, InjectedRenderToolName = "paint_surface" };
        var planner = await RunAsync(options, forwardedJson: null, ["paint_surface"]);
        Assert.Contains(GenerateTool, planner.LastToolNames);
        Assert.DoesNotContain("paint_surface", planner.LastToolNames);
    }

    [Fact]
    public async Task ForwardedFlag_DropsInjectedRenderProxyAsync()
    {
        var planner = await RunAsync(new A2UIChatClientOptions(), """{"injectA2UITool":true}""", [RenderProxy]);
        Assert.DoesNotContain(RenderProxy, planner.LastToolNames);
        Assert.Contains(GenerateTool, planner.LastToolNames);
    }

    [Fact]
    public async Task Drop_PreservesUnrelatedClientToolsAsync()
    {
        // Only the proxy goes — the developer's own tools survive untouched.
        var planner = await RunAsync(new A2UIChatClientOptions(), """{"injectA2UITool":true}""", [RenderProxy, "get_weather", "search_flights"]);
        Assert.DoesNotContain(RenderProxy, planner.LastToolNames);
        Assert.Contains("get_weather", planner.LastToolNames);
        Assert.Contains("search_flights", planner.LastToolNames);
    }

    [Fact]
    public async Task NoInjection_DoesNotDropTheProxyAsync()
    {
        // Opted out means delegate untouched; removing a client tool the adapter isn't managing
        // would break a host driving the render proxy itself.
        var planner = await RunAsync(new A2UIChatClientOptions(), """{"injectA2UITool":false}""", [RenderProxy]);
        Assert.Contains(RenderProxy, planner.LastToolNames);
        Assert.DoesNotContain(GenerateTool, planner.LastToolNames);
    }

    [Fact]
    public async Task DevWiredGenerateTool_DelegatesUntouchedAsync()
    {
        // USER PREVAILS — don't double-inject, don't mangle their tool list.
        var planner = await RunAsync(new A2UIChatClientOptions { InjectA2UITool = true }, """{"injectA2UITool":true}""", [GenerateTool, RenderProxy]);
        Assert.Equal(1, planner.LastToolNames.Count(n => n == GenerateTool));
        Assert.Contains(RenderProxy, planner.LastToolNames);
    }

    private static async Task<RecordingPlannerClient> RunAsync(
        A2UIChatClientOptions options,
        string? forwardedJson,
        string[]? clientToolNames = null)
    {
        var planner = new RecordingPlannerClient();
        var client = new A2UIChatClient(planner, new NeverCalledSubagentClient(), options);
        var chatOptions = BuildChatOptions(forwardedJson, clientToolNames);

        await foreach (var _ in client
            .GetStreamingResponseAsync([new ChatMessage(ChatRole.User, "make a card")], chatOptions)
            .ConfigureAwait(false))
        {
        }

        Assert.Equal(1, planner.Calls);
        return planner;
    }

    // Go through ToChatRequestContext (the production path that stamps the RunAgentInput and maps
    // input.Tools onto ChatOptions.Tools — precisely the mapping that delivers the proxy), not a
    // hand-built ChatOptions which would not reproduce the bug.
    private static ChatOptions BuildChatOptions(string? forwardedJson, string[]? clientToolNames)
    {
        var input = new RunAgentInput { ThreadId = "thread-1", RunId = "run-1", Messages = [] };
        if (clientToolNames is not null)
        {
            input.Tools = clientToolNames
                .Select(n => new AGUITool
                {
                    Name = n,
                    Description = n,
                    Parameters = JsonDocument.Parse("""{"type":"object","properties":{}}""").RootElement.Clone(),
                })
                .ToList();
        }

        if (forwardedJson is not null)
        {
            input.ForwardedProperties = JsonDocument.Parse(forwardedJson).RootElement.Clone();
        }

        return input.ToChatRequestContext(AIJsonUtilities.DefaultOptions).ChatOptions;
    }

    // Records the tools it was advertised, then ends the planner loop with a plain text turn.
    private sealed class RecordingPlannerClient : IChatClient
    {
        public List<string> LastToolNames { get; } = [];
        public int Calls { get; private set; }

        public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
            IEnumerable<ChatMessage> messages,
            ChatOptions? options = null,
            [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            this.Calls++;
            this.LastToolNames.Clear();
            if (options?.Tools is { } tools)
            {
                this.LastToolNames.AddRange(tools.Select(t => t.Name));
            }

            await Task.CompletedTask.ConfigureAwait(false);
            yield return new ChatResponseUpdate(ChatRole.Assistant, "Nothing to render.");
        }

        public Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default) =>
            throw new NotSupportedException();
        public object? GetService(Type serviceType, object? serviceKey = null) => null;
        public void Dispose() { }
    }

    // No gate case should reach generation.
    private sealed class NeverCalledSubagentClient : IChatClient
    {
        public IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
            IEnumerable<ChatMessage> messages,
            ChatOptions? options = null,
            CancellationToken cancellationToken = default) =>
            throw new InvalidOperationException("The render subagent must not run in a gate test.");

        public Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default) =>
            throw new NotSupportedException();
        public object? GetService(Type serviceType, object? serviceKey = null) => null;
        public void Dispose() { }
    }
}
