using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUIDojoServer;

/// <summary>
/// The environment and per-route agent IDs written by <see cref="Provisioner"/> and
/// read by the server. Stored in <c>.managed-agents.json</c> next to the built assembly
/// (gitignored), so setup and the server agree on its location regardless of the working
/// directory. Override the path with <c>MANAGED_AGENTS_IDS_PATH</c>.
/// </summary>
internal sealed class ProvisionedIds
{
    internal const string FileName = ".managed-agents.json";

    private const string PathEnvironmentVariable = "MANAGED_AGENTS_IDS_PATH";

    private static readonly JsonSerializerOptions s_jsonOptions = new() { WriteIndented = true };

    [JsonPropertyName("environmentId")]
    public string EnvironmentId { get; set; } = string.Empty;

    /// <summary>Feature route → managed agent ID.</summary>
    [JsonPropertyName("agents")]
    public Dictionary<string, string> Agents { get; set; } = [];

    internal static string FilePath =>
        Environment.GetEnvironmentVariable(PathEnvironmentVariable) is { Length: > 0 } path
            ? path
            : Path.Combine(AppContext.BaseDirectory, FileName);

    internal static ProvisionedIds? Load()
    {
        try
        {
            return JsonSerializer.Deserialize<ProvisionedIds>(File.ReadAllText(FilePath), s_jsonOptions);
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    internal void Save()
    {
        File.WriteAllText(FilePath, JsonSerializer.Serialize(this, s_jsonOptions) + Environment.NewLine);
    }
}
