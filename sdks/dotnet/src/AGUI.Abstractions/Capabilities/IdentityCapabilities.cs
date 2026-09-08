namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/capabilities.ts
public sealed class IdentityCapabilities
{
    public string? Name { get; set; }

    public string? Type { get; set; }

    public string? Description { get; set; }

    public string? Version { get; set; }

    public string? Provider { get; set; }

    public string? DocumentationUrl { get; set; }

    public IDictionary<string, object?>? Metadata { get; set; }
}
