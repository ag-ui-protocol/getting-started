namespace AGUI.ClaudeManagedAgents;

/// <summary>
/// How to answer a built-in tool that the agent's permission policy gates on user confirmation
/// (<c>evaluated_permission: "ask"</c>).
/// </summary>
public static class ToolConfirmationPolicy
{
    /// <summary>Confirm the tool call so it proceeds.</summary>
    public const string Allow = "allow";

    /// <summary>Reject the tool call.</summary>
    public const string Deny = "deny";
}
