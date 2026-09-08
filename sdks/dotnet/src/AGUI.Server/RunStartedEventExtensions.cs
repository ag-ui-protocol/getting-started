using AGUI.Abstractions;

namespace AGUI.Server;

internal static class RunStartedEventExtensions
{
    extension(RunStartedEvent)
    {
        public static RunStartedEvent Create(string threadId, string runId, string? parentRunId = null) =>
            new() { ThreadId = threadId, RunId = runId, ParentRunId = parentRunId };
    }
}
