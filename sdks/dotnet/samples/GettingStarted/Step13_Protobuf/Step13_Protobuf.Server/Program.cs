using AGUI.Formatting;
using AGUI.Protobuf;
using AGUI.Samples.Shared;
using Microsoft.Extensions.AI;

namespace Step13_Protobuf.Server;

public sealed class Program
{
    public static void Main(string[] args)
    {
        var builder = WebApplication.CreateBuilder(args);

        builder.Services.AddAGUI();

        // Register the protobuf formatter so the negotiating AGUIResults.Events result can answer the
        // protobuf wire format when a client explicitly accepts it. SSE remains the default for any
        // other client.
        builder.Services.AddSingleton<IAGUIEventStreamFormatter, ProtobufEventStreamFormatter>();

        builder.Services.AddSingleton<FakeChatClient>();
        builder.Services.AddChatClient(sp => sp.GetRequiredService<FakeChatClient>())
            .UseFunctionInvocation(configure: fic => fic.TerminateOnUnknownCalls = true);

        var app = builder.Build();

        app.MapAGUI("/");

        app.Run();
    }
}
