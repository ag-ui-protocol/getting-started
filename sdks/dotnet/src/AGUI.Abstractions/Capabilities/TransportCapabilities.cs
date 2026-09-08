namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/capabilities.ts
public sealed class TransportCapabilities
{
    public bool? Streaming { get; set; }

    public bool? Websocket { get; set; }

    public bool? HttpBinary { get; set; }

    public bool? PushNotifications { get; set; }

    public bool? Resumable { get; set; }
}
