using AGUI.Samples.Shared;
using System.ComponentModel;
using Azure.AI.OpenAI;
using Azure.Identity;
using Microsoft.Extensions.AI;

namespace Step09_InterruptsApproval.Server;

public sealed class Program
{
    public static void Main(string[] args)
    {
        var builder = WebApplication.CreateBuilder(args);

        builder.Services.AddAGUI();

        // delete_file is wrapped with ApprovalRequiredAIFunction so FunctionInvokingChatClient
        // produces ToolApprovalRequestContent (which the hosting layer renders as an
        // AG-UI RUN_FINISHED { outcome: interrupt }) instead of executing the function.
        // On resume, ToChatRequestContext detects the tool-approval-shaped resume payload
        // and injects the matching ToolApprovalRequestContent + ToolApprovalResponseContent
        // pair so FICC executes the underlying function — no per-endpoint plumbing needed.
        var deleteFileTool = new ApprovalRequiredAIFunction(
            AIFunctionFactory.Create(DeleteFile, "delete_file", "Deletes a file from the system"));

        IChatClient? inner = null;
        if (string.Equals(builder.Configuration["UseAzureOpenAI"], "true", StringComparison.OrdinalIgnoreCase))
        {
            var endpoint = builder.Configuration["AZURE_OPENAI_ENDPOINT"]
                ?? throw new InvalidOperationException("AZURE_OPENAI_ENDPOINT is not set.");
            var deploymentName = builder.Configuration["AZURE_OPENAI_DEPLOYMENT_NAME"]
                ?? throw new InvalidOperationException("AZURE_OPENAI_DEPLOYMENT_NAME is not set.");

            inner = new AzureOpenAIClient(new Uri(endpoint), new DefaultAzureCredential())
                .GetChatClient(deploymentName)
                .AsIChatClient();
        }
        else
        {
            builder.Services.AddSingleton<FakeChatClient>();
        }

        builder.Services.AddChatClient(sp => inner ?? sp.GetRequiredService<FakeChatClient>())
            .ConfigureOptions(options =>
            {
                options.Instructions =
                    "You are a file-management assistant. When the user asks to delete a file, " +
                    "call the delete_file tool with the requested filename. Do not ask the user " +
                    "to confirm and do not refuse — a separate approval step gates the deletion.";
                options.Tools ??= [];
                options.Tools.Add(deleteFileTool);
            })
            .UseFunctionInvocation();

        var app = builder.Build();

        app.MapAGUI("/");

        app.Run();
    }

    [Description("The filename to delete")]
    private static string DeleteFile(string filename)
    {
        return $"File '{filename}' deleted successfully.";
    }
}
