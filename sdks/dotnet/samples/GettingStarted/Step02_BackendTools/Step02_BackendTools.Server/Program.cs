using AGUI.Samples.Shared;
using System.ComponentModel;
using Azure.AI.OpenAI;
using Azure.Identity;
using Microsoft.Extensions.AI;

namespace Step02_BackendTools.Server;

public sealed class Program
{
    public static void Main(string[] args)
    {
        var builder = WebApplication.CreateBuilder(args);

        builder.Services.AddAGUI();

        builder.Services.ConfigureHttpJsonOptions(options =>
            options.SerializerOptions.TypeInfoResolverChain.Add(SampleJsonSerializerContext.Default));

        var searchRestaurants = AIFunctionFactory.Create(
            SearchRestaurants,
            serializerOptions: SampleJsonSerializerContext.Default.Options);

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
                    options.Tools.Add(searchRestaurants);
                })
                .UseFunctionInvocation(configure: fic => fic.TerminateOnUnknownCalls = true);
        }
        else
        {
            builder.Services.AddSingleton<FakeChatClient>();
            builder.Services.AddChatClient(sp => sp.GetRequiredService<FakeChatClient>())
                .ConfigureOptions(options =>
                {
                    options.Tools ??= [];
                    options.Tools.Add(searchRestaurants);
                })
                .UseFunctionInvocation(configure: fic => fic.TerminateOnUnknownCalls = true);
        }

        var app = builder.Build();

        app.MapAGUI("/");

        app.Run();
    }

    [Description("Search for restaurants in a location.")]
    private static RestaurantSearchResponse SearchRestaurants(
        [Description("The restaurant search request")] RestaurantSearchRequest request)
    {
        string cuisine = request.Cuisine == "any" ? "Italian" : request.Cuisine;

        return new RestaurantSearchResponse
        {
            Location = request.Location,
            Cuisine = request.Cuisine,
            Results =
            [
                new RestaurantInfo
                {
                    Name = "The Golden Fork",
                    Cuisine = cuisine,
                    Rating = 4.5,
                    Address = $"123 Main St, {request.Location}"
                },
                new RestaurantInfo
                {
                    Name = "Spice Haven",
                    Cuisine = cuisine == "Italian" ? "Indian" : cuisine,
                    Rating = 4.7,
                    Address = $"456 Oak Ave, {request.Location}"
                },
                new RestaurantInfo
                {
                    Name = "Green Leaf",
                    Cuisine = "Vegetarian",
                    Rating = 4.3,
                    Address = $"789 Elm Rd, {request.Location}"
                }
            ]
        };
    }
}
