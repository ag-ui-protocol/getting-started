using System.IO;
using AGUI.Abstractions;
using AGUI.Protobuf;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;

using JsonOptions = Microsoft.AspNetCore.Http.Json.JsonOptions;

namespace CrossLanguage.TestServer;

internal static class ProtobufParityRoute
{
    // Cross-language protobuf wire-compatibility harness. These routes let the
    // TypeScript Vitest suite exercise the .NET AGUIProtobuf codec directly:
    //   - /protobuf/encode : AG-UI event JSON  -> raw proto message bytes (.NET Encode)
    //   - /protobuf/decode : raw proto message bytes -> AG-UI event JSON (.NET Decode)
    //   - /protobuf/decode-framed : 4-byte BE length-prefixed frames -> AG-UI event JSON array
    //     (.NET ReadFramedAsync), proving the framing helpers interop with @ag-ui/encoder.
    public static void MapProtobufParity(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapPost("/protobuf/encode", async (
            HttpContext context,
            [FromServices] IOptions<JsonOptions> jsonOptions,
            CancellationToken cancellationToken) =>
        {
            var serializerOptions = jsonOptions.Value.SerializerOptions;

            BaseEvent? evt = await context.Request
                .ReadFromJsonAsync<BaseEvent>(serializerOptions, cancellationToken)
                .ConfigureAwait(false);

            if (evt is null)
            {
                return Results.BadRequest("Request body did not deserialize to an AG-UI event.");
            }

            byte[] bytes = AGUIProtobuf.Encode(evt);
            return Results.Bytes(bytes, "application/octet-stream");
        });

        endpoints.MapPost("/protobuf/decode", async (
            HttpContext context,
            [FromServices] IOptions<JsonOptions> jsonOptions,
            CancellationToken cancellationToken) =>
        {
            byte[] message = await ReadBodyAsync(context.Request.Body, cancellationToken).ConfigureAwait(false);

            BaseEvent evt = AGUIProtobuf.Decode(message);

            return Results.Json(evt, jsonOptions.Value.SerializerOptions, "application/json");
        });

        endpoints.MapPost("/protobuf/decode-framed", async (
            HttpContext context,
            [FromServices] IOptions<JsonOptions> jsonOptions,
            CancellationToken cancellationToken) =>
        {
            var events = new List<BaseEvent>();
            await foreach (BaseEvent evt in AGUIProtobuf
                .ReadFramedAsync(context.Request.Body, cancellationToken)
                .ConfigureAwait(false))
            {
                events.Add(evt);
            }

            return Results.Json(events, jsonOptions.Value.SerializerOptions, "application/json");
        });
    }

    private static async Task<byte[]> ReadBodyAsync(Stream body, CancellationToken cancellationToken)
    {
        using var buffer = new MemoryStream();
        await body.CopyToAsync(buffer, cancellationToken).ConfigureAwait(false);
        return buffer.ToArray();
    }
}
