using AGUI.Samples.Shared;
using Azure.AI.OpenAI;
using Azure.Identity;
using Microsoft.Extensions.AI;

namespace Step10_InterruptsUserInput.Server;

public sealed class Program
{
    public static void Main(string[] args)
    {
        var builder = WebApplication.CreateBuilder(args);

        builder.Services.AddAGUI();

        IChatClient? azureChatClient = null;
        if (string.Equals(builder.Configuration["UseAzureOpenAI"], "true", StringComparison.OrdinalIgnoreCase))
        {
            var endpoint = builder.Configuration["AZURE_OPENAI_ENDPOINT"]
                ?? throw new InvalidOperationException("AZURE_OPENAI_ENDPOINT is not set.");
            var deploymentName = builder.Configuration["AZURE_OPENAI_DEPLOYMENT_NAME"]
                ?? throw new InvalidOperationException("AZURE_OPENAI_DEPLOYMENT_NAME is not set.");

            azureChatClient = new AzureOpenAIClient(new Uri(endpoint), new DefaultAzureCredential())
                .GetChatClient(deploymentName)
                .AsIChatClient();
        }
        else
        {
            builder.Services.AddSingleton<FakeChatClient>();
        }

        // The model is offered a single tool to ask the user for free-form input.
        // UserInputToolChatClient converts a call to this tool into an AG-UI interrupt and,
        // on resume, converts the user's answer back into the tool result.
        var requestUserInput = AIFunctionFactory.Create(
            (string prompt) => string.Empty,
            UserInputToolChatClient.ToolName,
            "Ask the end user for a piece of free-form text. Pass the question to show them as 'prompt'.");

        builder.Services.AddChatClient(sp =>
                new UserInputToolChatClient(azureChatClient ?? sp.GetRequiredService<FakeChatClient>()))
            .ConfigureOptions(options =>
            {
                options.Instructions =
                    "You are an account-setup assistant. To finish creating the account you must know the " +
                    "user's preferred username. Use the request_user_input tool to ask the user for it, passing " +
                    "a short question as the 'prompt'. After the tool returns the username, confirm in one sentence " +
                    "that the account has been created.";
                options.Tools ??= [];
                options.Tools.Add(requestUserInput);
            });

        var app = builder.Build();

        app.MapAGUI("/");

        app.Run();
    }
}
