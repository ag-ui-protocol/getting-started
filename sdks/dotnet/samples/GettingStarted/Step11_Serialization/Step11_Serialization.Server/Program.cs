using Azure.AI.OpenAI;
using Azure.Identity;
using Microsoft.Extensions.AI;

namespace Step11_Serialization.Server;

public sealed class Program
{
    public static void Main(string[] args)
    {
        var builder = WebApplication.CreateBuilder(args);

        builder.Services.AddAGUI();
        builder.Services.AddSingleton<MessageHistoryStore>();

        if (string.Equals(builder.Configuration["UseAzureOpenAI"], "true", StringComparison.OrdinalIgnoreCase))
        {
            var endpoint = builder.Configuration["AZURE_OPENAI_ENDPOINT"]
                ?? throw new InvalidOperationException("AZURE_OPENAI_ENDPOINT is not set.");
            var deploymentName = builder.Configuration["AZURE_OPENAI_DEPLOYMENT_NAME"]
                ?? throw new InvalidOperationException("AZURE_OPENAI_DEPLOYMENT_NAME is not set.");

            builder.Services.AddChatClient(new AzureOpenAIClient(
                    new Uri(endpoint),
                    new DefaultAzureCredential())
                .GetChatClient(deploymentName)
                .AsIChatClient());
        }
        else
        {
            builder.Services.AddSingleton<FakeChatClient>();
            builder.Services.AddChatClient(sp => sp.GetRequiredService<FakeChatClient>());
        }

        var app = builder.Build();

        app.MapAGUIWithHistory("/");

        app.Run();
    }
}
