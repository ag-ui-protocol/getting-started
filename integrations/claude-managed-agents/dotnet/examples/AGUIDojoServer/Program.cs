/// <summary>
/// Example server: one AG-UI endpoint per route, each backed by a managed agent.
/// Provision the agents first with `dotnet run -- setup`.
/// </summary>
///
/// <example>
/// ANTHROPIC_API_KEY=sk-ant-xxx dotnet run -- setup   # provision the environment and agents
/// ANTHROPIC_API_KEY=sk-ant-xxx dotnet run            # serve on http://localhost:8026
/// </example>

using AGUIDojoServer;

if (args.Length > 0 && string.Equals(args[0], "setup", StringComparison.Ordinal))
{
    if (!HasApiKey())
    {
        Console.Error.WriteLine("Error: set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN)");
        return 1;
    }

    await Provisioner.RunAsync();
    return 0;
}

var builder = WebApplication.CreateBuilder(args);
// PORT is what the README and the Dockerfile advertise; honour it here as well so
// `PORT=9000 dotnet run` listens where it says it does rather than only inside the
// container, whose entrypoint sets ASPNETCORE_URLS from it. An explicit --urls (or
// ASPNETCORE_URLS) still wins.
var port = Environment.GetEnvironmentVariable("PORT");
var defaultUrl = string.IsNullOrWhiteSpace(port) ? "http://0.0.0.0:8026" : $"http://0.0.0.0:{port}";
builder.WebHost.UseUrls(builder.Configuration["urls"] ?? defaultUrl);
builder.Services.AddCors(options => options.AddDefaultPolicy(policy =>
    policy.AllowAnyOrigin().AllowAnyHeader().WithMethods("GET", "POST", "OPTIONS")));

var app = builder.Build();
app.UseCors();

if (!HasApiKey())
{
    Console.Error.WriteLine("Warning: ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) is not set; runs will fail.");
}

var agents = ExampleAgents.Build();
foreach (var (route, agent) in agents)
{
    app.MapManagedAgentsAgent($"/{route}", agent);
}

app.MapGet("/health", () => Results.Json(new { status = "healthy", agents = agents.Keys }));

app.Lifetime.ApplicationStarted.Register(() =>
{
    Console.WriteLine("Claude Managed Agents example server");
    foreach (var url in app.Urls)
    {
        foreach (var route in agents.Keys)
        {
            Console.WriteLine($"  POST {url}/{route}");
        }

        Console.WriteLine($"  GET  {url}/health");
    }
});

await app.RunAsync();
return 0;

static bool HasApiKey()
{
    return !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("ANTHROPIC_API_KEY"))
        || !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("ANTHROPIC_AUTH_TOKEN"));
}
