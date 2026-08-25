using System.Text.Json;
using AGUI.Abstractions;
using AGUI.Client;
using Microsoft.Extensions.AI;

// Default to localhost:5018 matching the AGUIDojoServer launchSettings
string baseUrl = args.Length > 0 ? args[0] : "http://localhost:5018";
string? scenarioFilter = args.Length > 1 ? args[1] : null;

Console.WriteLine("AGUIDojoServer Non-Interactive Console Client");
Console.WriteLine($"Server: {baseUrl}");
Console.WriteLine();

using var httpClient = new HttpClient();

// Define the fixed scenarios to exercise
var scenarios = new (string Endpoint, string Description, Func<HttpClient, string, Task> RunAsync)[]
{
    ("/agentic_chat", "Agentic Chat", RunAgenticChatAsync),
    ("/backend_tool_rendering", "Backend Tool Rendering", RunBackendToolRenderingAsync),
    ("/human_in_the_loop", "Human in the Loop", RunHumanInTheLoopAsync),
    ("/tool_based_generative_ui", "Tool Based Generative UI", RunToolBasedGenerativeUIAsync),
    ("/agentic_generative_ui", "Agentic Generative UI", RunAgenticGenerativeUIAsync),
    ("/shared_state", "Shared State", RunSharedStateAsync),
    ("/predictive_state_updates", "Predictive State Updates", RunPredictiveStateUpdatesAsync),
};

foreach (var (endpoint, description, runAsync) in scenarios)
{
    if (scenarioFilter is not null && !endpoint.Contains(scenarioFilter, StringComparison.OrdinalIgnoreCase))
    {
        continue;
    }

    Console.WriteLine(new string('=', 60));
    Console.WriteLine($"SCENARIO: {description}");
    Console.WriteLine($"ENDPOINT: {endpoint}");
    Console.WriteLine(new string('=', 60));

    try
    {
        await runAsync(httpClient, $"{baseUrl}{endpoint}");
    }
    catch (Exception ex)
    {
        Console.WriteLine($"[ERROR] {ex.GetType().Name}: {ex.Message}");
        if (ex.InnerException is not null)
        {
            Console.WriteLine($"  Inner: {ex.InnerException.Message}");
        }
    }

    Console.WriteLine();
}

Console.WriteLine("All scenarios completed.");

// ============================================================
// Scenario 1: Agentic Chat
// Dojo registers: change_background (client tool), get_weather (render tool).
// We register change_background so the agent can call it.
// ============================================================
static async Task RunAgenticChatAsync(HttpClient httpClient, string serverUrl)
{
    var changeBackgroundTool = AIFunctionFactory.Create(
        (string background) =>
        {
            Console.Write($"\n  [Client Action: change_background → {background}]");
            return "Background changed successfully.";
        },
        name: "change_background",
        description: "Change the chat background color. Use a CSS gradient or color.");

    var client = new AGUIChatClient(new(httpClient, serverUrl));

    var messages = new List<ChatMessage>
    {
        new(ChatRole.System, "The user's name is Bob."),
        new(ChatRole.User, "Change the background to a sunset gradient and write a short four-line poem about programming.")
    };

    var options = new ChatOptions
    {
        Tools = [changeBackgroundTool]
    };

    Console.WriteLine("User: Change the background to a sunset gradient and write a short four-line poem about programming.");
    Console.Write("Assistant: ");
    await StreamAndReportAsync(client, messages, options);
}

// ============================================================
// Scenario 2: Backend Tool Rendering
// Server has get_weather tool. Dojo client renders results in a custom card.
// We just observe - server tool is handled server-side.
// ============================================================
static async Task RunBackendToolRenderingAsync(HttpClient httpClient, string serverUrl)
{
    var client = new AGUIChatClient(new(httpClient, serverUrl));

    var messages = new List<ChatMessage>
    {
        new(ChatRole.User, "What is the weather in San Francisco?")
    };

    Console.WriteLine("User: What is the weather in San Francisco?");
    Console.Write("Assistant: ");
    await StreamAndReportAsync(client, messages);
}

// ============================================================
// Scenario 3: Human in the Loop
// Dojo registers: generate_task_steps (client tool). Agent proposes steps,
// user selects which to perform. We simulate accepting all steps.
// ============================================================
static async Task RunHumanInTheLoopAsync(HttpClient httpClient, string serverUrl)
{
    var generateTaskStepsTool = AIFunctionFactory.Create(
        (string steps) =>
        {
            Console.Write($"\n  [Client Action: generate_task_steps received]");
            try
            {
                using var doc = JsonDocument.Parse(steps);
                if (doc.RootElement.ValueKind == JsonValueKind.Array)
                {
                    var descriptions = new List<string>();
                    foreach (var step in doc.RootElement.EnumerateArray())
                    {
                        if (step.TryGetProperty("description", out var desc))
                        {
                            descriptions.Add(desc.GetString() ?? "");
                            Console.Write($"\n    ✓ {desc.GetString()}");
                        }
                    }

                    Console.Write("\n  [Simulated: User selected ALL steps]");
                    return $"The user selected the following steps: {string.Join(", ", descriptions)}";
                }
            }
            catch (JsonException)
            {
            }

            return $"The user accepted all proposed steps.";
        },
        name: "generate_task_steps",
        description: "Generate task steps for the user to review and select. Parameter is a JSON array of objects with 'description' and 'status' fields.");

    var client = new AGUIChatClient(new(httpClient, serverUrl));

    var messages = new List<ChatMessage>
    {
        new(ChatRole.User, "Help me organize a birthday party for my friend next Saturday. Generate the task steps I need to complete.")
    };

    var options = new ChatOptions
    {
        Tools = [generateTaskStepsTool]
    };

    Console.WriteLine("User: Help me organize a birthday party. Generate task steps.");
    Console.Write("Assistant: ");
    await StreamAndReportAsync(client, messages, options);
}

// ============================================================
// Scenario 4: Tool Based Generative UI
// Dojo registers: generate_haiku (client tool). Agent fills in Japanese/English
// text and the UI renders it. We log the haiku data.
// ============================================================
static async Task RunToolBasedGenerativeUIAsync(HttpClient httpClient, string serverUrl)
{
    var generateHaikuTool = AIFunctionFactory.Create(
        (string japanese, string english, string image_name, string gradient) =>
        {
            Console.Write($"\n  [Client Render: generate_haiku]");
            Console.Write($"\n    Japanese: {japanese}");
            Console.Write($"\n    English:  {english}");
            Console.Write($"\n    Image:    {image_name}");
            Console.Write($"\n    Gradient: {gradient}");
            return "Haiku displayed to user.";
        },
        name: "generate_haiku",
        description: "Generate and display a haiku. Parameters: japanese (3 lines), english (3 lines), image_name, gradient (CSS gradient for background).");

    var client = new AGUIChatClient(new(httpClient, serverUrl));

    var messages = new List<ChatMessage>
    {
        new(ChatRole.User, "Write me a haiku about the ocean.")
    };

    var options = new ChatOptions
    {
        Tools = [generateHaikuTool]
    };

    Console.WriteLine("User: Write me a haiku about the ocean.");
    Console.Write("Assistant: ");
    await StreamAndReportAsync(client, messages, options);
}

// ============================================================
// Scenario 5: Agentic Generative UI
// No client tools. Server uses create_plan/update_plan_step internally and
// emits StateSnapshot/StateDelta events. We observe them.
// ============================================================
static async Task RunAgenticGenerativeUIAsync(HttpClient httpClient, string serverUrl)
{
    var client = new AGUIChatClient(new(httpClient, serverUrl));

    var messages = new List<ChatMessage>
    {
        new(ChatRole.User, "Create a plan for learning to bake bread.")
    };

    Console.WriteLine("User: Create a plan for learning to bake bread.");
    Console.Write("Assistant: ");

    int stateSnapshotCount = 0;
    int stateDeltaCount = 0;

    await foreach (var update in client.GetStreamingResponseAsync(messages))
    {
        foreach (var content in update.Contents)
        {
            if (content is TextContent textContent)
            {
                Console.Write(textContent.Text);
            }
            else if (content is FunctionCallContent callContent)
            {
                Console.Write($"\n  [Server Tool: {callContent.Name}]");
            }
        }

        if (update.RawRepresentation is StateSnapshotEvent snapshot)
        {
            stateSnapshotCount++;
            string text = snapshot.Snapshot.ToString();
            Console.Write($"\n  [StateSnapshot #{stateSnapshotCount}: {Truncate(text, 120)}]");
        }
        else if (update.RawRepresentation is StateDeltaEvent delta)
        {
            stateDeltaCount++;
            string text = delta.Delta.ToString();
            Console.Write($"\n  [StateDelta #{stateDeltaCount}: {Truncate(text, 120)}]");
        }
    }

    Console.WriteLine();
    Console.WriteLine($"  Summary: {stateSnapshotCount} snapshots, {stateDeltaCount} deltas");
}

// ============================================================
// Scenario 6: Shared State
// Dojo passes recipe state. Agent updates it via StateSnapshot events.
// We pass recipe via RawRepresentationFactory and observe updates.
// ============================================================
static async Task RunSharedStateAsync(HttpClient httpClient, string serverUrl)
{
    var recipeState = JsonSerializer.SerializeToElement(new
    {
        recipe = new
        {
            title = "Carrot Cake",
            skill_level = "Intermediate",
            cooking_time = "45 min",
            special_preferences = new[] { "Vegetarian" },
            ingredients = new[]
            {
                new { name = "Carrots", amount = "3 large, grated" },
                new { name = "All-Purpose Flour", amount = "2 cups" }
            },
            instructions = new[] { "Preheat oven to 350°F (175°C)" }
        }
    });

    var client = new AGUIChatClient(new(httpClient, serverUrl));

    var messages = new List<ChatMessage>
    {
        new(ChatRole.User, "Add cream cheese frosting ingredients and instructions to this recipe.")
    };

    var options = new ChatOptions
    {
        RawRepresentationFactory = _ => new RunAgentInput { State = recipeState }
    };

    Console.WriteLine("User: Add cream cheese frosting to this recipe.");
    Console.WriteLine($"  [State: Carrot Cake recipe with 2 ingredients, 1 instruction]");
    Console.Write("Assistant: ");

    int stateSnapshotCount = 0;

    await foreach (var update in client.GetStreamingResponseAsync(messages, options))
    {
        foreach (var content in update.Contents)
        {
            if (content is TextContent textContent)
            {
                Console.Write(textContent.Text);
            }
        }

        if (update.RawRepresentation is StateSnapshotEvent snapshot)
        {
            stateSnapshotCount++;
            string text = snapshot.Snapshot.ToString();
            Console.Write($"\n  [StateSnapshot #{stateSnapshotCount}: {Truncate(text, 200)}]");
        }
    }

    Console.WriteLine();
    Console.WriteLine($"  Summary: {stateSnapshotCount} state snapshots");
}

// ============================================================
// Scenario 7: Predictive State Updates
// Dojo registers: confirm_changes (client tool). Agent calls write_document
// (server tool) which emits progressive StateSnapshots, then calls
// confirm_changes for approval. We auto-approve.
// ============================================================
static async Task RunPredictiveStateUpdatesAsync(HttpClient httpClient, string serverUrl)
{
    var confirmChangesTool = AIFunctionFactory.Create(
        () =>
        {
            Console.Write("\n  [Client Action: confirm_changes → auto-approved]");
            return "The user confirmed the changes.";
        },
        name: "confirm_changes",
        description: "Confirm the document changes after writing.");

    var client = new AGUIChatClient(new(httpClient, serverUrl));

    var documentState = JsonSerializer.SerializeToElement(new { document = "" });

    var messages = new List<ChatMessage>
    {
        new(ChatRole.User, "Write a short pirate story.")
    };

    var options = new ChatOptions
    {
        Tools = [confirmChangesTool],
        RawRepresentationFactory = _ => new RunAgentInput { State = documentState }
    };

    Console.WriteLine("User: Write a short pirate story.");
    Console.Write("Assistant: ");

    int stateSnapshotCount = 0;
    string? lastDocument = null;

    await foreach (var update in client.GetStreamingResponseAsync(messages, options))
    {
        foreach (var content in update.Contents)
        {
            if (content is TextContent textContent)
            {
                Console.Write(textContent.Text);
            }
            else if (content is FunctionCallContent callContent && callContent.Name != "confirm_changes")
            {
                Console.Write($"\n  [Server Tool: {callContent.Name}]");
            }
        }

        if (update.RawRepresentation is StateSnapshotEvent snapshot)
        {
            stateSnapshotCount++;
            if (snapshot.Snapshot.TryGetProperty("document", out var docProp))
            {
                lastDocument = docProp.GetString();
            }

            if (stateSnapshotCount % 25 == 0)
            {
                Console.Write($"\n  [StateSnapshot #{stateSnapshotCount}, doc length: {lastDocument?.Length ?? 0}]");
            }
        }
    }

    Console.WriteLine();
    Console.WriteLine($"  Summary: {stateSnapshotCount} state snapshots");

    if (lastDocument is not null)
    {
        Console.WriteLine($"  Final document ({lastDocument.Length} chars):");
        Console.WriteLine($"  {Truncate(lastDocument, 500)}");
    }
}

static async Task StreamAndReportAsync(AGUIChatClient client, List<ChatMessage> messages, ChatOptions? options = null)
{
    await foreach (var update in client.GetStreamingResponseAsync(messages, options))
    {
        foreach (var content in update.Contents)
        {
            if (content is TextContent textContent)
            {
                Console.Write(textContent.Text);
            }
            else if (content is FunctionCallContent callContent)
            {
                Console.Write($"\n  [Tool Call: {callContent.Name}({string.Join(", ", callContent.Arguments?.Select(kv => $"{kv.Key}={kv.Value}") ?? [])})]");
            }
        }

        if (update.RawRepresentation is StateSnapshotEvent snapshot)
        {
            string text = snapshot.Snapshot.ToString();
            Console.Write($"\n  [StateSnapshot: {Truncate(text, 120)}]");
        }
        else if (update.RawRepresentation is StateDeltaEvent delta)
        {
            string text = delta.Delta.ToString();
            Console.Write($"\n  [StateDelta: {Truncate(text, 120)}]");
        }
    }

    Console.WriteLine();
}

static string Truncate(string? value, int maxLength)
{
    if (value is null)
    {
        return "";
    }

    return value.Length <= maxLength ? value : value[..maxLength] + "...";
}
