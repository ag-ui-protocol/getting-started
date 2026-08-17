using System.ClientModel;
using AGUI.Formatting;
using AGUI.Protobuf;
using AGUI.Server;
using CrossLanguage.TestServer;
using Microsoft.Extensions.AI;
using OpenAI;

WebApplicationBuilder builder = WebApplication.CreateBuilder(args);

// The TS dojo e2e stack starts @copilotkit/aimock on :5555 and routes every
// agent's OpenAI traffic through it via OPENAI_BASE_URL. Mirror that contract
// so our cross-language tests can drive deterministic LLM responses.
string baseUrl = builder.Configuration["OPENAI_BASE_URL"]
    ?? throw new InvalidOperationException("OPENAI_BASE_URL must be set (point at the aimock LLMock server, e.g. http://localhost:5555/v1).");
string modelId = builder.Configuration["OPENAI_CHAT_MODEL_ID"] ?? "gpt-4o";
string apiKey = builder.Configuration["OPENAI_API_KEY"] ?? "sk-mock";

OpenAIClient openAiClient = new(
    new ApiKeyCredential(apiKey),
    new OpenAIClientOptions { Endpoint = new Uri(baseUrl) });

IChatClient baseChatClient = openAiClient.GetChatClient(modelId).AsIChatClient();
IChatClient chatClient = baseChatClient.AsBuilder()
    .UseFunctionInvocation(configure: fic =>
    {
        fic.TerminateOnUnknownCalls = true;
        // Let parallel server-side tool calls execute concurrently when the model
        // surfaces more than one in a single assistant turn (parallel_tool_calls).
        fic.AllowConcurrentInvocation = true;
    })
    .Build();

builder.Services.AddSingleton(chatClient);
builder.Services.AddAGUI();
builder.Services.AddSingleton<IAGUIEventStreamFormatter, ProtobufEventStreamFormatter>();
builder.Services.ConfigureHttpJsonOptions(options =>
    options.SerializerOptions.TypeInfoResolverChain.Add(CrossLanguageJsonSerializerContext.Default));

WebApplication app = builder.Build();

app.MapAgenticChat("/agentic_chat");
app.MapBackendToolRendering("/backend_tool_rendering");
app.MapSharedState("/shared_state");
app.MapPredictiveState("/predictive_state_updates");
app.MapHumanInTheLoop("/human_in_the_loop");
app.MapParallelToolCalls("/parallel_tool_calls");
app.MapTokenUsage("/token_usage");
app.MapProtobufParity();

await app.RunAsync().ConfigureAwait(false);

public partial class Program;
