using AGUIDojoServer;
using Microsoft.Extensions.Options;

using JsonOptions = Microsoft.AspNetCore.Http.Json.JsonOptions;

WebApplicationBuilder builder = WebApplication.CreateBuilder(args);

builder.Services.AddHttpClient().AddLogging();
builder.Services.ConfigureHttpJsonOptions(options => options.SerializerOptions.TypeInfoResolverChain.Add(AGUIDojoServerSerializerContext.Default));
builder.Services.AddAGUI();

WebApplication app = builder.Build();

// Initialize the factory
ChatClientAgentFactory.Initialize(app.Configuration);

var jsonOptions = app.Services.GetRequiredService<IOptions<JsonOptions>>();

// Map the AG-UI agent endpoints for different scenarios
app.MapDojoEndpoint("/agentic_chat", ChatClientAgentFactory.CreateAgenticChat());

app.MapDojoEndpoint("/backend_tool_rendering",
    ChatClientAgentFactory.CreateBackendToolRendering(),
    serverTools: ChatClientAgentFactory.CreateBackendToolRenderingTools(jsonOptions.Value.SerializerOptions));

app.MapDojoEndpoint("/human_in_the_loop", ChatClientAgentFactory.CreateHumanInTheLoop());

app.MapDojoEndpoint("/tool_based_generative_ui", ChatClientAgentFactory.CreateToolBasedGenerativeUI());

app.MapDojoEndpoint("/agentic_generative_ui",
    ChatClientAgentFactory.CreateAgenticUI(),
    serverTools: ChatClientAgentFactory.CreateAgenticUITools(jsonOptions.Value.SerializerOptions),
    systemPrompt: ChatClientAgentFactory.AgenticUISystemPrompt,
    configureStreamOptions: _ => ChatClientAgentFactory.CreateAgenticUIStreamOptions());

app.MapDojoEndpoint("/shared_state",
    ChatClientAgentFactory.CreateSharedState(),
    serverTools: ChatClientAgentFactory.CreateSharedStateTools(jsonOptions.Value.SerializerOptions),
    systemPrompt: ChatClientAgentFactory.SharedStateSystemPrompt,
    configureStreamOptions: _ => ChatClientAgentFactory.CreateSharedStateStreamOptions());

app.MapDojoEndpoint("/predictive_state_updates",
    ChatClientAgentFactory.CreatePredictiveStateUpdates(),
    serverTools: ChatClientAgentFactory.CreatePredictiveStateUpdatesTools(jsonOptions.Value.SerializerOptions),
    systemPrompt: ChatClientAgentFactory.PredictiveStateUpdatesSystemPrompt,
    configureStreamOptions: json => ChatClientAgentFactory.CreatePredictiveStateUpdatesStreamOptions(json));

// A2UI fixed-schema: the search tools return a pre-authored a2ui_operations envelope; the A2UI
// middleware paints it. No generate_a2ui / subagent / progressive-args tap needed.
app.MapDojoEndpoint("/a2ui_fixed_schema",
    ChatClientAgentFactory.CreateA2UIFixedSchema(),
    serverTools: ChatClientAgentFactory.CreateA2UIFixedSchemaTools(),
    systemPrompt: ChatClientAgentFactory.A2UIFixedSchemaSystemPrompt);

// A2UI (agent-generated UI). generate_a2ui is auto-injected and handled by A2UIChatClient
// (subagent + recovery); the stream options surface the render_a2ui argument fragments so
// surfaces paint progressively.
app.MapDojoEndpoint("/a2ui_dynamic_schema",
    ChatClientAgentFactory.CreateA2UIDynamicSchema(),
    systemPrompt: ChatClientAgentFactory.A2UIPlannerSystemPrompt,
    configureStreamOptions: _ => ChatClientAgentFactory.CreateA2UIStreamOptions());

app.MapDojoEndpoint("/a2ui_recovery",
    ChatClientAgentFactory.CreateA2UIRecovery(),
    systemPrompt: ChatClientAgentFactory.A2UIPlannerSystemPrompt,
    configureStreamOptions: _ => ChatClientAgentFactory.CreateA2UIStreamOptions());

app.MapDojoEndpoint("/a2ui_advanced",
    ChatClientAgentFactory.CreateA2UIAdvanced(),
    systemPrompt: ChatClientAgentFactory.A2UIPlannerSystemPrompt,
    configureStreamOptions: _ => ChatClientAgentFactory.CreateA2UIStreamOptions());

await app.RunAsync();

public partial class Program;
