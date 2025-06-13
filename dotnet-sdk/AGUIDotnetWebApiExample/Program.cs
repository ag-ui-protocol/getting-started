using Microsoft.AspNetCore.Mvc;
using AGUIDotnet.Types;
using AGUIDotnet.Events;
using AGUIDotnet.Agent;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;
using System.Threading.Channels;
using System.ClientModel.Primitives;
using System.Web;
using Azure.AI.OpenAI;
using System.ClientModel;
using Microsoft.Extensions.AI;
using System.Collections.Immutable;
using System.ComponentModel;
using AGUIDotnet.Integrations;

var builder = WebApplication.CreateBuilder(args);

// Add services to the container.
// Learn more about configuring OpenAPI at https://aka.ms/aspnet/openapi
builder.Services.AddOpenApi();

builder.Services.ConfigureHttpJsonOptions(opts =>
{
    // Necessary as the type discriminator is not the first property in the JSON objects used by the AG-UI protocol.
    opts.SerializerOptions.AllowOutOfOrderMetadataProperties = true;
    opts.SerializerOptions.WriteIndented = false;
    opts.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;

    // Necessary as consumers of the AG-UI protocol (e.g. Zod-powered schemas) will not accept null values for optional properties.
    // So we need to ensure that null values are not serialized.
    opts.SerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
});

builder.Services.AddChatClient(
    new AzureOpenAIClient(
        new Uri(builder.Configuration["AzureOpenAI:Endpoint"]!),
        new ApiKeyCredential(builder.Configuration["AzureOpenAI:ApiKey"]!),
        new AzureOpenAIClientOptions
        {
            Transport = new ApiVersionSelectorTransport(builder.Configuration["AzureOpenAI:ApiVersion"]!)
        }
    ).GetChatClient(builder.Configuration["AzureOpenAI:Model"]).AsIChatClient()
)
.UseFunctionInvocation();

var app = builder.Build();

// Configure the HTTP request pipeline.
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

app.UseHttpsRedirection();

var agentsGroup = app.MapGroup("/agents");

agentsGroup.MapPost("echo", async ([FromBody] RunAgentInput input, HttpContext context, IOptions<Microsoft.AspNetCore.Http.Json.JsonOptions> jsonOptions) =>
{
    context.Response.ContentType = "text/event-stream";
    await context.Response.Body.FlushAsync();

    var serOpts = jsonOptions.Value.SerializerOptions;
    var agent = new EchoAgent();

    await foreach (var ev in agent.RunToCompletionAsync(input, context.RequestAborted))
    {
        var serializedEvent = JsonSerializer.Serialize(ev, serOpts);
        await context.Response.WriteAsync($"data: {serializedEvent}\n\n");
        await context.Response.Body.FlushAsync();

        // If the event is a RunFinishedEvent, we can break the loop.
        if (ev is RunFinishedEvent)
        {
            break;
        }
    }
});

agentsGroup.MapPost("chatbot", async ([FromBody] RunAgentInput input, HttpContext context, IOptions<Microsoft.AspNetCore.Http.Json.JsonOptions> jsonOptions) =>
{
    context.Response.ContentType = "text/event-stream";
    await context.Response.Body.FlushAsync();

    var serOpts = jsonOptions.Value.SerializerOptions;

    var azureOpenAiClient = new AzureOpenAIClient(
        new Uri(app.Configuration["AzureOpenAI:Endpoint"]!),
        new ApiKeyCredential(app.Configuration["AzureOpenAI:ApiKey"]!),
        new AzureOpenAIClientOptions
        {
            Transport = new ApiVersionSelectorTransport(app.Configuration["AzureOpenAI:ApiVersion"]!)
        }
    );

    var chatClient = new ChatClientBuilder(azureOpenAiClient.GetChatClient(app.Configuration["AzureOpenAI:Model"]!).AsIChatClient())
        .UseFunctionInvocation()
        .Build();

    static DateTimeOffset GetCurrentDateTime() => DateTimeOffset.UtcNow;

    var agent = new ChatClientAgent(chatClient, new ChatClientAgentOptions
    {
        SystemMessage = """
        <persona>
        You are a helpful assistant acting as a general-purpose chatbot.
        </persona>

        <rules>
        - Where achieving the goal requires chaining multiple steps available as tools, you must use the tools in the logical order to achieve the goal.
        </rules>
        """,

        PerformAiContextExtraction = true,
        IncludeContextInSystemMessage = true,

        ChatOptions = new ChatOptions
        {
            Tools = [
                AIFunctionFactory.Create(
                    GetCurrentDateTime,
                    name: "getCurrentDateTimeUtc",
                    description: "Returns the current date and time in UTC."
                )
            ]
        }
    });

    await foreach (var ev in agent.RunToCompletionAsync(input, context.RequestAborted))
    {
        var serializedEvent = JsonSerializer.Serialize(ev, serOpts);
        await context.Response.WriteAsync($"data: {serializedEvent}\n\n");
        await context.Response.Body.FlushAsync();

        // If the event is a RunFinishedEvent, we can break the loop.
        if (ev is RunFinishedEvent)
        {
            break;
        }
    }

    var finalUsage = agent.Usage;
});

agentsGroup.MapAgentEndpoint(
    "recipe",
    sp =>
    {
        var chatClient = sp.GetRequiredService<IChatClient>();
        return new StatefulChatClientAgent<Recipe>(
            chatClient,
            new Recipe(),
            new StatefulChatClientAgentOptions<Recipe>
            {
                SystemMessage = """
                <persona>
                You are a helpful assistant that collaborates with the user to help create a recipe aligned with their requests and requirements.
                </persona>

                <rules>
                - You have a tool for setting the background colour on the frontend, whenever setting a recipe, please set the background to be inspired by it.
                </rules>
                """,
                PerformAiContextExtraction = false,

                EmitBackendToolCalls = true,
                EmitStateFunctionsToFrontend = false,

                ChatOptions = new ChatOptions
                {
                    Tools = [
                        AIFunctionFactory.Create(
                            async () => {
                                await Task.Delay(5000); // simulated delay
                                return DateTimeOffset.UtcNow;
                            },
                            name: "getCurrentDateTimeUtc",
                            description: "Returns the current date and time in UTC."
                        )
                    ]
                }
            }
        );
    }
);

app.Run();

record Recipe
{
    public string Name { get; init; } = "";
    public string Description { get; init; } = "";
    public ImmutableList<Ingredient> Ingredients { get; init; } = [];

    public ImmutableList<Instruction> Instructions { get; init; } = [];
}

record Ingredient
{
    public required string Name { get; init; }
    public required string Quantity { get; init; }
}

record Instruction
{
    public required string Step { get; init; }
    public required string EstimatedTime { get; init; }

    [Description("A description of the step, supports Markdown formatting.")]
    public required string Description { get; init; }
}

class ApiVersionSelectorTransport(string apiVersion) : HttpClientPipelineTransport
{
    protected override void OnSendingRequest(PipelineMessage message, HttpRequestMessage httpRequest)
    {
        var uriBuilder = new UriBuilder(httpRequest.RequestUri!);
        var query = HttpUtility.ParseQueryString(uriBuilder.Query);
        query["api-version"] = apiVersion;
        uriBuilder.Query = query.ToString();
        httpRequest.RequestUri = uriBuilder.Uri;

        base.OnSendingRequest(message, httpRequest);
    }
}