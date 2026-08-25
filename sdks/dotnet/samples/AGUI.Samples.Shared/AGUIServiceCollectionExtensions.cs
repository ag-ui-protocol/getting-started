using System;
using System.Text.Json;
using AGUI.Abstractions;
using AGUI.Formatting;
using Microsoft.AspNetCore.Http.Json;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Microsoft.Extensions.DependencyInjection;

/// <summary>
/// Extension methods for <see cref="IServiceCollection"/> to configure AG-UI ASP.NET Core hosting.
/// </summary>
public static class AGUIServiceCollectionExtensions
{
    /// <summary>
    /// Adds AG-UI services to the specified <see cref="IServiceCollection"/>: the built-in
    /// Server-Sent Events formatter and the AG-UI JSON serialization configuration.
    /// </summary>
    /// <param name="services">The <see cref="IServiceCollection"/> to configure.</param>
    /// <returns>The <see cref="IServiceCollection"/> for method chaining.</returns>
    public static IServiceCollection AddAGUI(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);

        services.TryAddEnumerable(
            ServiceDescriptor.Singleton<IAGUIEventStreamFormatter, SseEventStreamFormatter>());

        services.Configure<JsonOptions>(options =>
        {
            // AG-UI first, and AGUIJsonUtilities.DefaultTypeInfoResolver rather than the bare
            // source-generated context. Routes that hand events to
            // TypedResults.ServerSentEvents serialize with these application options, so two
            // things have to hold for a field with no value to stay off the wire: the AG-UI
            // resolver has to carry the omission (the context's own DefaultIgnoreCondition
            // does not follow it into a different options instance), and it has to be asked
            // before AIJsonUtilities' resolver, which answers for any type and would
            // otherwise resolve AG-UI events itself. Get either wrong and these routes emit
            // "parentRunId": null / "input": null, which TypeScript clients reject.
            options.SerializerOptions.TypeInfoResolverChain.Insert(
                0, AGUIJsonUtilities.DefaultTypeInfoResolver);
            options.SerializerOptions.TypeInfoResolverChain.Add(AIJsonUtilities.DefaultOptions.TypeInfoResolver!);
            AGUIJsonUtilities.RegisterInterruptContentTypes(options.SerializerOptions);
        });

        return services;
    }
}
