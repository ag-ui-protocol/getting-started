using System.ClientModel;
using System.ComponentModel;
using System.Text.Json;
using AGUI.A2UI;
using AGUI.Abstractions;
using AGUI.Server;
using AGUIDojoServer.A2UI;
using AGUIDojoServer.AgenticUI;
using AGUIDojoServer.BackendToolRendering;
using AGUIDojoServer.PredictiveStateUpdates;
using AGUIDojoServer.SharedState;
using Azure.AI.OpenAI;
using Azure.Identity;
using Microsoft.Extensions.AI;
using OpenAI;
using ChatClient = OpenAI.Chat.ChatClient;

namespace AGUIDojoServer;

internal static class ChatClientAgentFactory
{
    private static ChatClient? s_chatClient;

    public static void Initialize(IConfiguration configuration)
    {
        // Resolve a ChatClient from configuration. Three modes are supported, all
        // producing the same OpenAI.Chat.ChatClient so the rest of the factory is
        // provider-agnostic:
        //
        // 1. OPENAI_BASE_URL set — talk to any OpenAI-compatible endpoint with an
        //    API key. This covers a local OpenAI mock (e.g. aimock used by the
        //    dojo/e2e), the real OpenAI API, and Azure OpenAI via its
        //    OpenAI-compatible surface (https://{resource}.openai.azure.com/openai/v1/).
        // 2. AZURE_OPENAI_ENDPOINT set — talk to Azure OpenAI using Entra ID
        //    (DefaultAzureCredential), no API key required.
        // 3. Otherwise — talk to the public OpenAI API with OPENAI_API_KEY.
        var modelName = configuration["OPENAI_CHAT_MODEL_ID"]
            ?? configuration["AZURE_OPENAI_DEPLOYMENT_NAME"]
            ?? "gpt-4o";

        string? baseUrl = configuration["OPENAI_BASE_URL"];
        string? azureEndpoint = configuration["AZURE_OPENAI_ENDPOINT"];
        string? apiKey = configuration["OPENAI_API_KEY"];

        if (string.IsNullOrEmpty(baseUrl) && !string.IsNullOrEmpty(azureEndpoint))
        {
            var azureClient = new AzureOpenAIClient(
                new Uri(azureEndpoint),
                new DefaultAzureCredential());
            s_chatClient = azureClient.GetChatClient(modelName);
            return;
        }

        var options = new OpenAIClientOptions();
        if (!string.IsNullOrEmpty(baseUrl))
        {
            options.Endpoint = new Uri(baseUrl);
        }

        var openAIClient = new OpenAIClient(
            new ApiKeyCredential(apiKey ?? string.Empty),
            options);
        s_chatClient = openAIClient.GetChatClient(modelName);
    }

    private static IChatClient CreateBaseChatClient()
    {
        return s_chatClient!.AsIChatClient()
            .AsBuilder()
            .UseFunctionInvocation()
            .Build();
    }

    public static IChatClient CreateAgenticChat()
    {
        return CreateBaseChatClient();
    }

    public static IChatClient CreateBackendToolRendering()
    {
        return CreateBaseChatClient();
    }

    public static IList<AITool> CreateBackendToolRenderingTools(JsonSerializerOptions options)
    {
        return [AIFunctionFactory.Create(
            GetWeather,
            name: "get_weather",
            description: "Get the weather for a given location.",
            options)];
    }

    public static IChatClient CreateHumanInTheLoop()
    {
        return CreateBaseChatClient();
    }

    public static IChatClient CreateToolBasedGenerativeUI()
    {
        return CreateBaseChatClient();
    }

    public static IChatClient CreateAgenticUI()
    {
        return CreateBaseChatClient();
    }

    public const string AgenticUISystemPrompt = """
        When planning use tools only, without any other messages.
        IMPORTANT:
        - Use the `create_plan` tool to set the initial state of the steps
        - Use the `update_plan_step` tool to update the status of each step
        - Do NOT repeat the plan or summarise it in a message
        - Do NOT confirm the creation or updates in a message
        - Do NOT ask the user for additional information or next steps
        - Do NOT leave a plan hanging, always complete the plan via `update_plan_step` if one is ongoing.
        - Continue calling update_plan_step until all steps are marked as completed.

        Only one plan can be active at a time, so do not call the `create_plan` tool
        again until all the steps in current plan are completed.
        """;

    public static IList<AITool> CreateAgenticUITools(JsonSerializerOptions options)
    {
        return
        [
            AIFunctionFactory.Create(
                AgenticPlanningTools.CreatePlan,
                name: "create_plan",
                description: "Create a plan with multiple steps.",
                AGUIDojoServerSerializerContext.Default.Options),
            AIFunctionFactory.Create(
                AgenticPlanningTools.UpdatePlanStepAsync,
                name: "update_plan_step",
                description: "Update a step in the plan with new description or status.",
                AGUIDojoServerSerializerContext.Default.Options)
        ];
    }

    public static AGUIStreamOptions CreateAgenticUIStreamOptions()
    {
        var options = new AGUIStreamOptions();
        options.MapResultAsStateSnapshot("create_plan");
        options.MapResultAsStateDelta("update_plan_step");
        return options;
    }

    public static IChatClient CreateSharedState()
    {
        return CreateBaseChatClient();
    }

    public const string SharedStateSystemPrompt = """
        You are a helpful recipe assistant that maintains a shared recipe state with the user.

        IMPORTANT:
        - When the user asks you to create, change, or improve a recipe, call the
          `generate_recipe` tool with a COMPLETE recipe: a title, skill_level, cooking_time,
          special_preferences, the full list of ingredients (each with an icon, name and
          amount) and the step-by-step instructions.
        - Always include every ingredient the recipe needs, keeping any the user already added.
        - When the user only asks a question about the recipe, answer in plain text and do
          NOT call the tool.
        """;

    public static IList<AITool> CreateSharedStateTools(JsonSerializerOptions options)
    {
        return
        [
            AIFunctionFactory.Create(
                GenerateRecipe,
                name: "generate_recipe",
                description: "Generate or update the shared recipe and display it to the user.",
                options)
        ];
    }

    public static AGUIStreamOptions CreateSharedStateStreamOptions()
    {
        var options = new AGUIStreamOptions();
        options.MapResultAsStateSnapshot("generate_recipe");
        return options;
    }

    [Description("Generate or update the shared recipe and display it to the user.")]
    private static RecipeResponse GenerateRecipe(
        [Description("The complete recipe to display.")] Recipe recipe) => new() { Recipe = recipe };

    public static IChatClient CreatePredictiveStateUpdates()
    {
        // Deliberately NOT wrapped with UseFunctionInvocation: write_document_local is declared
        // so the model calls it, but the call is intercepted by the stream mapping
        // (CreatePredictiveStateUpdatesStreamOptions) — which streams the document into state and
        // injects a confirm_changes tool call — rather than executed server-side. That leaves the
        // run finishing with the confirm_changes call pending for the human-in-the-loop modal.
        return s_chatClient!.AsIChatClient();
    }

    public const string PredictiveStateUpdatesSystemPrompt = """
        You are a document editor assistant. When asked to write or edit content:

        IMPORTANT:
        - Use the `write_document_local` tool with the full document text in Markdown format
        - Format the document extensively so it's easy to read
        - You can use all kinds of markdown (headings, lists, bold, etc.)
        - However, do NOT use italic or strike-through formatting
        - You MUST write the full document, even when changing only a few words
        - When making edits to the document, try to make them minimal - do not change every word
        - Keep stories SHORT!

        After writing the document, briefly summarize the changes you made in at most two sentences.
        """;

    public static IList<AITool> CreatePredictiveStateUpdatesTools(JsonSerializerOptions options)
    {
        return
        [
            AIFunctionFactory.Create(
                WriteDocument,
                name: "write_document_local",
                description: "Write a document. Use markdown formatting to format the document.",
                AGUIDojoServerSerializerContext.Default.Options)
        ];
    }

    public static AGUIStreamOptions CreatePredictiveStateUpdatesStreamOptions(JsonSerializerOptions jsonSerializerOptions)
    {
        string? lastEmittedDocument = null;
        var options = new AGUIStreamOptions();
        options.MapCall("write_document_local", fcc =>
        {
            var documentContent = fcc.Arguments?.TryGetValue("document", out var documentValue) == true
                ? documentValue?.ToString()
                : null;

            if (documentContent is null || documentContent == lastEmittedDocument)
            {
                return [];
            }

            var events = new List<BaseEvent>();
            int startIndex = 0;
            if (lastEmittedDocument is not null && documentContent.StartsWith(lastEmittedDocument, StringComparison.Ordinal))
            {
                startIndex = lastEmittedDocument.Length;
            }

            const int chunkSize = 10;
            for (int i = startIndex; i < documentContent.Length; i += chunkSize)
            {
                int length = Math.Min(chunkSize, documentContent.Length - i);
                string chunk = documentContent.Substring(0, i + length);

                var stateUpdate = new DocumentState { Document = chunk };
                var stateJson = JsonSerializer.SerializeToElement(stateUpdate, jsonSerializerOptions);

                events.Add(new StateSnapshotEvent { Snapshot = stateJson });
            }

            // Complete the write_document_local call (its document is now reflected in the
            // document state) so the only tool call the client sees pending is confirm_changes.
            events.Add(new ToolCallResultEvent
            {
                MessageId = Guid.NewGuid().ToString("N"),
                ToolCallId = fcc.CallId,
                Content = "Document written.",
                Role = "tool",
            });

            // Inject a client-side `confirm_changes` tool call so the dojo human-in-the-loop
            // approval modal renders. This mirrors the crewai predictive_state_updates flow,
            // whose backend appends a synthetic confirm_changes tool call after writing the
            // document — the dojo registers `confirm_changes` via useHumanInTheLoop and shows
            // the confirm/reject modal in response to the call. The call is parented to a fresh
            // assistant message id so the client tracks it correctly across multiple rounds.
            var confirmCallId = Guid.NewGuid().ToString("N");
            var confirmMessageId = Guid.NewGuid().ToString("N");
            events.Add(new ToolCallStartEvent { ToolCallId = confirmCallId, ToolCallName = "confirm_changes", ParentMessageId = confirmMessageId });
            events.Add(new ToolCallArgsEvent { ToolCallId = confirmCallId, Delta = "{}" });
            events.Add(new ToolCallEndEvent { ToolCallId = confirmCallId });

            lastEmittedDocument = documentContent;
            return events;
        });
        return options;
    }

    // ---- A2UI (agent-generated UI) -----------------------------------------------------

    /// <summary>
    /// The shared A2UI planner prompt. Kept as a system prompt (passed via MapDojoEndpoint)
    /// rather than baked into the client, matching the other feature endpoints.
    /// </summary>
    public const string A2UIPlannerSystemPrompt = A2UICompositionGuides.PlannerInstructions;

    /// <summary>The system prompt for the fixed-schema demo.</summary>
    public const string A2UIFixedSchemaSystemPrompt = """
        You are a helpful travel assistant that can search for flights and hotels.
        When the user asks about flights, use the search_flights tool.
        When the user asks about hotels, use the search_hotels tool.
        IMPORTANT: After calling a tool, do NOT repeat or summarize the data in your text
        response. The tool renders a rich UI automatically. Just say something brief like
        "Here are your results" or ask if they'd like to book.
        """;

    /// <summary>
    /// Fixed-schema demo: the author owns the card layout (in code); the agent only supplies the
    /// data via the search tools, whose return value is an A2UI operations envelope the middleware
    /// paints. No generate_a2ui / subagent / recovery.
    /// </summary>
    public static IChatClient CreateA2UIFixedSchema() => CreateBaseChatClient();

    /// <summary>The fixed-schema server tools (search_flights, search_hotels).</summary>
    public static IList<AITool> CreateA2UIFixedSchemaTools() =>
        [A2UIFixedSchemaTools.CreateSearchFlightsTool(), A2UIFixedSchemaTools.CreateSearchHotelsTool()];

    // Builds an A2UI-enabled chat client: the planner (with function invocation for any server
    // tools) wrapped by A2UIChatClient, which auto-injects generate_a2ui and drives a raw render
    // subagent through the recovery loop.
    private static IChatClient CreateA2UIChatClient(A2UIChatClientOptions options)
    {
        // The subagent must be raw (no function invocation): A2UIChatClient reads the forced
        // render_a2ui call's arguments directly rather than letting it be invoked.
        IChatClient subagent = s_chatClient!.AsIChatClient();

        // Reuse the same OpenAI fragment extractor the endpoint registers for the wire tap, so
        // the adapter can learn the streamed render_a2ui call id before the call coalesces and
        // still balance a mid-stream failure.
        A2UIChatClientOptions resolved = new()
        {
            // Backend opt-in — the `config` half of the `forwarded ?? config` rule (ADK
            // `a2ui["inject_a2ui_tool"]`, AWS Strands / Mastra / CrewAI `a2ui.injectA2UITool`),
            // which exists precisely for a host that does not forward the runtime flag. The dojo
            // forwards `injectA2UITool` only for langgraph* / mastra-agent-local, so these demos
            // opt in server-side. A client-sent `false` still wins.
            InjectA2UITool = options.InjectA2UITool ?? true,
            ToolParams = options.ToolParams,
            StreamingToolCallArgumentExtractor = OpenAIStreamingToolArguments.Extract,
        };

        return s_chatClient!.AsIChatClient()
            .AsBuilder()
            .UseA2UI(subagent, resolved)
            .UseFunctionInvocation()
            .Build();
    }

    /// <summary>Dynamic-schema demo: a subagent designs the UI via generate_a2ui against the dojo catalog.</summary>
    public static IChatClient CreateA2UIDynamicSchema() => CreateA2UIChatClient(new A2UIChatClientOptions
    {
        ToolParams = new A2UIToolParams
        {
            DefaultCatalogId = A2UICompositionGuides.DynamicCatalogId,
            Guidelines = new A2UIGuidelines { CompositionGuide = A2UICompositionGuides.DynamicSchema },
        },
    });

    /// <summary>
    /// Error-recovery demo: a catalog id is supplied but no validation <c>Catalog</c>, so
    /// structural validation (missing root, dangling child refs, duplicate ids) drives the
    /// validate-and-regenerate loop. <c>MaxAttempts</c> is set explicitly to demonstrate the knob
    /// (it already defaults to <see cref="A2UIConstants.MaxA2UIAttempts"/>).
    /// </summary>
    public static IChatClient CreateA2UIRecovery() => CreateA2UIChatClient(new A2UIChatClientOptions
    {
        ToolParams = new A2UIToolParams
        {
            DefaultCatalogId = A2UICompositionGuides.DynamicCatalogId,
            Guidelines = new A2UIGuidelines { CompositionGuide = A2UICompositionGuides.Recovery },
            Recovery = new A2UIRecoveryConfig { MaxAttempts = A2UIConstants.MaxA2UIAttempts },
        },
    });

    /// <summary>
    /// Zero-config / advanced demo: no backend catalog or guide. The catalog schema arrives on
    /// the forwarded <c>RunAgentInput</c> and A2UIChatClient reads it — the easy-devex path.
    /// Injection itself comes from the backend opt-in in <see cref="CreateA2UIChatClient"/>: the
    /// dojo forwards <c>injectA2UITool</c> only for langgraph* / mastra-agent-local, so it never
    /// arrives for <c>ag-ui-dotnet</c>.
    /// </summary>
    public static IChatClient CreateA2UIAdvanced() => CreateA2UIChatClient(new A2UIChatClientOptions());

    /// <summary>
    /// Stream options for the A2UI endpoints: surface OpenAI's per-chunk tool-call argument
    /// fragments as incremental TOOL_CALL_ARGS so render_a2ui surfaces paint progressively.
    /// </summary>
    public static AGUIStreamOptions CreateA2UIStreamOptions() =>
        new AGUIStreamOptions().MapStreamingToolCallArguments(OpenAIStreamingToolArguments.Extract);

    [Description("Get the weather for a given location.")]
    private static WeatherInfo GetWeather([Description("The location to get the weather for.")] string location) => new()
    {
        Temperature = 20,
        Conditions = "sunny",
        Humidity = 50,
        WindSpeed = 10,
        FeelsLike = 25
    };

    [Description("Write a document in markdown format.")]
    private static string WriteDocument([Description("The document content to write.")] string document)
    {
        // Simply return success - the document is tracked via state updates
        return "Document written successfully";
    }
}
