using AGUI.Samples.Shared;
using Azure.AI.OpenAI;
using Azure.Identity;
using Microsoft.Extensions.AI;

namespace Step07_ThinkingEvents.Server;

public sealed class Program
{
    public static void Main(string[] args)
    {
        var builder = WebApplication.CreateBuilder(args);

        builder.Services.AddAGUI();

        if (string.Equals(builder.Configuration["UseAzureOpenAI"], "true", StringComparison.OrdinalIgnoreCase))
        {
            var endpoint = builder.Configuration["AZURE_OPENAI_ENDPOINT"]
                ?? throw new InvalidOperationException("AZURE_OPENAI_ENDPOINT is not set.");
            var deploymentName = builder.Configuration["AZURE_OPENAI_DEPLOYMENT_NAME"]
                ?? throw new InvalidOperationException("AZURE_OPENAI_DEPLOYMENT_NAME is not set.");

            // Reasoning summaries are only surfaced by the Responses API, so use the responses
            // client (not chat completions) and ask the model to emit a reasoning summary. The
            // hosting layer turns the resulting TextReasoningContent into AG-UI thinking events.
            builder.Services.AddChatClient(new AzureOpenAIClient(
                    new Uri(endpoint),
                    new DefaultAzureCredential())
                .GetResponsesClient()
                .AsIChatClient(deploymentName))
                .ConfigureOptions(options =>
                {
                    options.Reasoning = new ReasoningOptions
                    {
                        Effort = ReasoningEffort.Medium,
                        Output = ReasoningOutput.Summary,
                    };
                });
        }
        else
        {
            builder.Services.AddSingleton<FakeChatClient>();
            builder.Services.AddChatClient(sp => sp.GetRequiredService<FakeChatClient>());
        }

        var app = builder.Build();

        app.MapAGUI("/");

        app.Run();
    }
}
