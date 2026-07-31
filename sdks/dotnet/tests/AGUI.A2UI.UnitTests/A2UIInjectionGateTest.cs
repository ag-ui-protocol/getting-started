using System.Runtime.CompilerServices;
using System.Text.Json;
using AGUI.Abstractions;
using AGUI.Server;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.A2UI.UnitTests;

/// <summary>
/// Contract tests for the <c>injectA2UITool</c> gate and the render-proxy drop, pinning parity
/// with the sibling adapters (ADK <c>plan_a2ui_injection</c>, AWS Strands / Mastra
/// <c>planA2UIInjection</c>):
/// <list type="number">
/// <item>OFF unless the run forwards <c>injectA2UITool</c> OR the backend opts in
/// ("no <c>injectA2UITool</c>, no injection").</item>
/// <item>Nullish precedence — a forwarded <see langword="false"/> beats a backend opt-in.</item>
/// <item>The flag is <c>boolean | string</c>; a string names the injected render proxy, and an
/// empty string is falsy (an opt-out).</item>
/// <item>USER PREVAILS — a dev-wired <c>generate_a2ui</c> is never clobbered.</item>
/// <item>The middleware-injected render proxy is DROPPED, so the planner cannot bypass the
/// subagent + validate-and-retry loop by calling it directly.</item>
/// </list>
/// </summary>
public sealed class A2UIInjectionGateTest
{
    private const string GenerateTool = A2UIConstants.GenerateA2UIToolName;
    private const string RenderProxy = A2UIConstants.RenderA2UIToolName;

    // ---- 1. Default is OFF (the sibling contract) -------------------------------------------

    [Fact]
    public async Task NoForwardedFlagAndNoBackendOptIn_DoesNotInjectAsync()
    {
        var planner = await RunAsync(options: new A2UIChatClientOptions(), forwardedJson: null);

        // Wrapping alone must not advertise generate_a2ui: nothing on the client is necessarily
        // set up to paint the resulting surfaces. Mirrors ADK/Strands `if not flag: return None`.
        Assert.DoesNotContain(GenerateTool, planner.LastToolNames);
    }

    [Fact]
    public async Task BackendOptIn_WithoutForwardedFlag_InjectsAsync()
    {
        var planner = await RunAsync(
            options: new A2UIChatClientOptions { InjectA2UITool = true },
            forwardedJson: null);

        // The `config` half of `forwarded ?? config` — for hosts that never forward the flag.
        Assert.Contains(GenerateTool, planner.LastToolNames);
    }

    [Fact]
    public async Task BackendExplicitFalse_DoesNotInjectAsync()
    {
        var planner = await RunAsync(
            options: new A2UIChatClientOptions { InjectA2UITool = false },
            forwardedJson: null);

        Assert.DoesNotContain(GenerateTool, planner.LastToolNames);
    }

    // ---- 2. Nullish precedence ---------------------------------------------------------------

    [Fact]
    public async Task ForwardedTrue_InjectsWithoutBackendOptInAsync()
    {
        var planner = await RunAsync(
            options: new A2UIChatClientOptions(),
            forwardedJson: """{"injectA2UITool":true}""");

        // The client can ENABLE A2UI, not merely veto it.
        Assert.Contains(GenerateTool, planner.LastToolNames);
    }

    [Fact]
    public async Task ForwardedFalse_BeatsBackendOptInAsync()
    {
        var planner = await RunAsync(
            options: new A2UIChatClientOptions { InjectA2UITool = true },
            forwardedJson: """{"injectA2UITool":false}""");

        // An explicit runtime false disables injection even when the backend opted in — the
        // case ADK pins in test_a2ui_tool.py.
        Assert.DoesNotContain(GenerateTool, planner.LastToolNames);
    }

    [Fact]
    public async Task ForwardedNonBooleanNonString_TreatedAsAbsentAsync()
    {
        var planner = await RunAsync(
            options: new A2UIChatClientOptions { InjectA2UITool = true },
            forwardedJson: """{"injectA2UITool":3}""");

        // A number is not a usable flag: fall through to the backend option rather than
        // silently disabling (or enabling) on malformed input.
        Assert.Contains(GenerateTool, planner.LastToolNames);
    }

    // ---- 3. The string form ------------------------------------------------------------------

    [Fact]
    public async Task ForwardedEmptyString_DoesNotInjectAsync()
    {
        var planner = await RunAsync(
            options: new A2UIChatClientOptions(),
            forwardedJson: """{"injectA2UITool":""}""");

        // "" is falsy in the TS/Python siblings' `if (!flag)` gate.
        Assert.DoesNotContain(GenerateTool, planner.LastToolNames);
    }

    [Fact]
    public async Task ForwardedStringName_InjectsAndDropsThatProxyAsync()
    {
        const string CustomProxy = "render_ui_custom";

        var planner = await RunAsync(
            options: new A2UIChatClientOptions(),
            forwardedJson: $"{{\"injectA2UITool\":\"{CustomProxy}\"}}",
            clientToolNames: [CustomProxy]);

        // A string is truthy AND names the proxy the middleware injected under a custom name.
        Assert.Contains(GenerateTool, planner.LastToolNames);
        Assert.DoesNotContain(CustomProxy, planner.LastToolNames);
    }

    [Fact]
    public async Task BackendInjectedRenderToolName_DropsThatProxyAsync()
    {
        const string CustomProxy = "paint_surface";

        var planner = await RunAsync(
            options: new A2UIChatClientOptions
            {
                InjectA2UITool = true,
                InjectedRenderToolName = CustomProxy,
            },
            forwardedJson: null,
            clientToolNames: [CustomProxy]);

        Assert.Contains(GenerateTool, planner.LastToolNames);
        Assert.DoesNotContain(CustomProxy, planner.LastToolNames);
    }

    // ---- 5. The render-proxy drop ------------------------------------------------------------

    [Fact]
    public async Task ForwardedFlag_DropsInjectedRenderProxyAsync()
    {
        var planner = await RunAsync(
            options: new A2UIChatClientOptions(),
            forwardedJson: """{"injectA2UITool":true}""",
            clientToolNames: [RenderProxy]);

        // The middleware injects `render_a2ui` into RunAgentInput.Tools in the SAME step that
        // forwards the flag, and the hosting layer maps it onto ChatOptions.Tools. Left in place
        // the planner could call it directly and paint a surface that skipped the subagent and
        // the validate-and-retry loop — a SILENT bypass of two of the four A2UI pillars.
        Assert.DoesNotContain(RenderProxy, planner.LastToolNames);
        Assert.Contains(GenerateTool, planner.LastToolNames);
    }

    [Fact]
    public async Task Drop_PreservesUnrelatedClientToolsAsync()
    {
        var planner = await RunAsync(
            options: new A2UIChatClientOptions(),
            forwardedJson: """{"injectA2UITool":true}""",
            clientToolNames: [RenderProxy, "get_weather", "search_flights"]);

        // Only the proxy goes — the developer's own tools must survive untouched.
        Assert.DoesNotContain(RenderProxy, planner.LastToolNames);
        Assert.Contains("get_weather", planner.LastToolNames);
        Assert.Contains("search_flights", planner.LastToolNames);
    }

    [Fact]
    public async Task NoInjection_DoesNotDropTheProxyAsync()
    {
        var planner = await RunAsync(
            options: new A2UIChatClientOptions(),
            forwardedJson: """{"injectA2UITool":false}""",
            clientToolNames: [RenderProxy]);

        // Opted out: delegate untouched. Removing a client tool the adapter is not managing
        // would break a host that drives the render proxy itself.
        Assert.Contains(RenderProxy, planner.LastToolNames);
        Assert.DoesNotContain(GenerateTool, planner.LastToolNames);
    }

    // ---- 4. USER PREVAILS --------------------------------------------------------------------

    [Fact]
    public async Task DevWiredGenerateTool_DelegatesUntouchedAsync()
    {
        var planner = await RunAsync(
            options: new A2UIChatClientOptions { InjectA2UITool = true },
            forwardedJson: """{"injectA2UITool":true}""",
            clientToolNames: [GenerateTool, RenderProxy]);

        // The dev owns generate_a2ui — do not double-inject, and do not mangle their tool list.
        Assert.Equal(1, planner.LastToolNames.Count(n => n == GenerateTool));
        Assert.Contains(RenderProxy, planner.LastToolNames);
    }

    // ---- harness -----------------------------------------------------------------------------

    // Drives one streamed run through the decorator and returns the planner, which records the
    // tool list it was actually handed. The planner emits text only (no generate_a2ui call), so
    // the decorator's loop terminates after one round and the subagent is never invoked.
    private static async Task<RecordingPlannerClient> RunAsync(
        A2UIChatClientOptions options,
        string? forwardedJson,
        string[]? clientToolNames = null)
    {
        var planner = new RecordingPlannerClient();
        var client = new A2UIChatClient(planner, new NeverCalledSubagentClient(), options);

        ChatOptions chatOptions = BuildChatOptions(forwardedJson, clientToolNames);
        await foreach (var _ in client.GetStreamingResponseAsync(
            [new ChatMessage(ChatRole.User, "make a card")], chatOptions).ConfigureAwait(false))
        {
            // Drain.
        }

        Assert.Equal(1, planner.Calls);
        return planner;
    }

    // Builds ChatOptions the way the AG-UI hosting layer does, so forwardedProps and the
    // client tool list travel the real path (ToChatRequestContext stamps the RunAgentInput and
    // maps input.Tools onto ChatOptions.Tools) rather than a test-only shortcut.
    private static ChatOptions BuildChatOptions(string? forwardedJson, string[]? clientToolNames)
    {
        var input = new RunAgentInput
        {
            ThreadId = "thread-1",
            RunId = "run-1",
            Messages = [],
            Tools = clientToolNames?.Select(name => new AGUITool
            {
                Name = name,
                Description = name,
                Parameters = JsonDocument.Parse("""{"type":"object","properties":{}}""").RootElement.Clone(),
            }).ToList(),
        };

        if (forwardedJson is not null)
        {
            input.ForwardedProperties = JsonDocument.Parse(forwardedJson).RootElement.Clone();
        }

        return input.ToChatRequestContext(AIJsonUtilities.DefaultOptions).ChatOptions;
    }

    // Records the tool names it was handed, then emits text only so the planner loop ends.
    private sealed class RecordingPlannerClient : IChatClient
    {
        public List<string> LastToolNames { get; private set; } = [];

        public int Calls { get; private set; }

        public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
            IEnumerable<ChatMessage> messages,
            ChatOptions? options = null,
            [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            await Task.CompletedTask.ConfigureAwait(false);
            this.Calls++;
            this.LastToolNames = (options?.Tools ?? []).Select(t => t.Name).ToList();
            yield return new ChatResponseUpdate(ChatRole.Assistant, "Nothing to render.");
        }

        public Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default) =>
            throw new NotSupportedException();

        public object? GetService(Type serviceType, object? serviceKey = null) => null;

        public void Dispose()
        {
        }
    }

    // The gate tests never reach generation; a call here means the decorator ran a subagent it
    // should not have.
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

        public void Dispose()
        {
        }
    }
}
