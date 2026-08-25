using System.Collections.Generic;
using AGUI.Abstractions;

namespace AGUI.Server;

internal static class RunFinishedEventExtensions
{
    extension(RunFinishedEvent)
    {
        public static RunFinishedEvent Create(
            string threadId,
            string runId,
            RunFinishedOutcome? outcome = null,
            IList<TokenUsage>? usage = null) =>
            new() { ThreadId = threadId, RunId = runId, Outcome = outcome, Usage = usage };
    }
}
