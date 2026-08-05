using System.Text.Json;
using System.Text.Json.Nodes;

namespace AGUI.ClaudeManagedAgents;

/// <summary>
/// Builders for the user events posted into a managed session.
/// </summary>
public static class ManagedAgentsSessionEvents
{
    /// <summary>
    /// A <c>user.message</c> event carrying <paramref name="text"/>.
    /// </summary>
    public static JsonElement UserMessage(string text)
    {
        var json = new JsonObject
        {
            ["type"] = "user.message",
            ["content"] = new JsonArray(TextBlock(text)),
        };
        return ToElement(json);
    }

    /// <summary>
    /// A <c>user.custom_tool_result</c> event answering a custom tool call.
    /// </summary>
    public static JsonElement CustomToolResult(string customToolUseId, string text, bool isError)
    {
        var json = new JsonObject
        {
            ["type"] = "user.custom_tool_result",
            ["custom_tool_use_id"] = customToolUseId,
            ["content"] = new JsonArray(TextBlock(text)),
            ["is_error"] = isError,
        };
        return ToElement(json);
    }

    /// <summary>
    /// A <c>user.tool_confirmation</c> event answering a built-in tool that asked for confirmation.
    /// </summary>
    /// <param name="toolUseId">The tool call to answer.</param>
    /// <param name="result">A <see cref="ToolConfirmationPolicy"/> value.</param>
    public static JsonElement ToolConfirmation(string toolUseId, string result)
    {
        var json = new JsonObject
        {
            ["type"] = "user.tool_confirmation",
            ["tool_use_id"] = toolUseId,
            ["result"] = result,
        };
        return ToElement(json);
    }

    /// <summary>
    /// A <c>user.interrupt</c> event that stops the current turn.
    /// </summary>
    public static JsonElement Interrupt()
    {
        return ToElement(new JsonObject { ["type"] = "user.interrupt" });
    }

    private static JsonObject TextBlock(string text)
    {
        return new JsonObject
        {
            ["type"] = "text",
            ["text"] = text,
        };
    }

    private static JsonElement ToElement(JsonNode node)
    {
        return JsonSerializer.SerializeToElement(node);
    }
}
