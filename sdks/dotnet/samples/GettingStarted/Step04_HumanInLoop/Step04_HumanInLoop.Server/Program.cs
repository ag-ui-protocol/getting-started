using AGUI.Samples.Shared;
using System.Text.Json;
using Azure.AI.OpenAI;
using Azure.Identity;
using Microsoft.Extensions.AI;

namespace Step04_HumanInLoop.Server;

public sealed class Program
{
    // ApprovalChatClient serializes opaque function-call arguments (IDictionary&lt;string, object?&gt;),
    // which the source-generated SampleJsonSerializerContext does not cover. Chain the AI resolver
    // (for the dictionary/content types) ahead of the sample context (for the approval payloads).
    private static readonly JsonSerializerOptions s_approvalJson = CreateApprovalJson();

    private static JsonSerializerOptions CreateApprovalJson()
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        options.TypeInfoResolverChain.Add(AIJsonUtilities.DefaultOptions.TypeInfoResolver!);
        options.TypeInfoResolverChain.Add(SampleJsonSerializerContext.Default);
        return options;
    }

    public static void Main(string[] args)
    {
        var builder = WebApplication.CreateBuilder(args);

        builder.Services.AddAGUI();

        builder.Services.ConfigureHttpJsonOptions(options =>
            options.SerializerOptions.TypeInfoResolverChain.Add(SampleJsonSerializerContext.Default));

        var approveExpenseReport = new ApprovalRequiredAIFunction(
            AIFunctionFactory.Create(
                BackendTools.ApproveExpenseReport,
                serializerOptions: SampleJsonSerializerContext.Default.Options));

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
                .AsIChatClient())
                .ConfigureOptions(options =>
                {
                    options.Tools ??= [];
                    options.Tools.Add(approveExpenseReport);
                })
                .Use((inner, _) => new ApprovalChatClient(inner, s_approvalJson))
                .UseFunctionInvocation(configure: fic => fic.TerminateOnUnknownCalls = true);
        }
        else
        {
            builder.Services.AddSingleton<FakeChatClient>();
            builder.Services.AddChatClient(sp => sp.GetRequiredService<FakeChatClient>())
                .ConfigureOptions(options =>
                {
                    options.Tools ??= [];
                    options.Tools.Add(approveExpenseReport);
                })
                .Use((inner, _) => new ApprovalChatClient(inner, s_approvalJson))
                .UseFunctionInvocation(configure: fic => fic.TerminateOnUnknownCalls = true);
        }

        var app = builder.Build();

        app.MapAGUI("/");

        app.Run();
    }
}
