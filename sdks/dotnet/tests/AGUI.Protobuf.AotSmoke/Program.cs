// Native-AOT smoke for the protobuf transport: publishes with PublishAot and
// runs the public formatter surface end to end. IsAotCompatible=true is a
// promise the analyzers only partially check; this executable is the proof.
using System.Text.Json;
using AGUI.Abstractions;
using AGUI.Protobuf;

var formatter = new ProtobufEventStreamFormatter();

static JsonElement Json(string json)
{
    using var document = JsonDocument.Parse(json);
    return document.RootElement.Clone();
}

// A spread of events chosen to drag every mapper path through the AOT
// compiler at runtime: struct/value conversion, message snapshots with
// content parts, flattened outcomes, patch operations.
BaseEvent[] events =
[
    new RunStartedEvent
    {
        ThreadId = "t1",
        RunId = "r1",
        Input = new RunAgentInput
        {
            ThreadId = "t1",
            RunId = "r1",
            Messages =
            [
                new AGUIUserMessage { Id = "u1", Content = "hello" },
                new AGUIAssistantMessage { Id = "a1", Content = "hi" },
            ],
        },
    },
    new StateDeltaEvent { Delta = Json("""[{"op":"add","path":"/x","value":{"y":1}}]""") },
    new CustomEvent { Name = "app.ping", Value = Json("""{"n":1}""") },
    new RunFinishedEvent
    {
        ThreadId = "t1",
        RunId = "r1",
        Timestamp = 1755772800000,
        Metadata = Json("""{"trace":"abc"}"""),
        Outcome = new RunFinishedInterruptOutcome
        {
            Interrupts = [new AGUIInterrupt { Id = "i1", Reason = "tool_approval" }],
        },
    },
];

using var stream = new MemoryStream();
await formatter.WriteAsync(Enumerate(events), stream, CancellationToken.None).ConfigureAwait(false);
stream.Position = 0;

var decoded = new List<BaseEvent>();
await foreach (var evt in formatter.ReadAsync(stream, CancellationToken.None).ConfigureAwait(false))
{
    decoded.Add(evt);
}

if (decoded.Count != events.Length)
{
    Console.Error.WriteLine($"FAIL: wrote {events.Length} events, read {decoded.Count}");
    return 1;
}

for (var i = 0; i < events.Length; i++)
{
    if (decoded[i].Type != events[i].Type)
    {
        Console.Error.WriteLine($"FAIL: event {i} came back as {decoded[i].Type}, expected {events[i].Type}");
        return 1;
    }
}

var outcome = ((RunFinishedEvent)decoded[3]).Outcome;
if (outcome is not RunFinishedInterruptOutcome { Interrupts: [{ Id: "i1" }] })
{
    Console.Error.WriteLine("FAIL: interrupt outcome did not survive the round trip");
    return 1;
}

// The decode guards must survive AOT too: a malformed frame (two events
// merged into one message) errors instead of decoding arbitrarily.
var first = ToFrame(new StepFinishedEvent { StepName = "plan" });
var second = ToFrame(new StepStartedEvent { StepName = "next" });
var malformed = new byte[4 + (first.Length - 4) + (second.Length - 4)];
var payloadLength = (first.Length - 4) + (second.Length - 4);
malformed[0] = (byte)(payloadLength >> 24);
malformed[1] = (byte)(payloadLength >> 16);
malformed[2] = (byte)(payloadLength >> 8);
malformed[3] = (byte)payloadLength;
first.AsSpan(4).CopyTo(malformed.AsSpan(4));
second.AsSpan(4).CopyTo(malformed.AsSpan(4 + first.Length - 4));

try
{
    await foreach (var _ in formatter.ReadAsync(new MemoryStream(malformed), CancellationToken.None).ConfigureAwait(false))
    {
    }

    Console.Error.WriteLine("FAIL: malformed frame decoded instead of throwing");
    return 1;
}
catch (InvalidDataException)
{
}

Console.WriteLine("AOT smoke passed");
return 0;

static async IAsyncEnumerable<BaseEvent> Enumerate(BaseEvent[] events)
{
    foreach (var evt in events)
    {
        yield return evt;
    }

    await Task.CompletedTask.ConfigureAwait(false);
}

byte[] ToFrame(BaseEvent evt)
{
    using var frame = new MemoryStream();
    formatter.WriteAsync(Enumerate([evt]), frame, CancellationToken.None).GetAwaiter().GetResult();
    return frame.ToArray();
}
