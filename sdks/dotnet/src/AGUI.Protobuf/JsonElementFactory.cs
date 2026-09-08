using System;
using System.IO;
using System.Text.Json;

namespace AGUI.Protobuf;

// Builds a detached JsonElement from a Utf8JsonWriter callback. Uses a MemoryStream rather
// than ArrayBufferWriter<byte> because the latter is not publicly accessible on the
// netstandard2.0/net472 targets.
internal static class JsonElementFactory
{
    public static JsonElement Create(Action<Utf8JsonWriter> write)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            write(writer);
        }

        using var document = JsonDocument.Parse(new ReadOnlyMemory<byte>(stream.GetBuffer(), 0, (int)stream.Length));
        return document.RootElement.Clone();
    }
}
