namespace AGUI.ClaudeManagedAgents;

/// <summary>
/// Hands swallowed failures to the configured error handler.
/// </summary>
internal static class ManagedAgentsErrorReporter
{
    /// <summary>
    /// Reports <paramref name="error"/> to <paramref name="onError"/>, absorbing everything the
    /// handler does wrong.
    /// </summary>
    /// <remarks>
    /// A broken handler must never break the run, so a synchronous throw, a faulted task and a
    /// <see langword="null"/> task are all swallowed here. Awaiting the handler's task is what
    /// keeps an asynchronous handler from having to be <c>async void</c>, whose exception would
    /// escape to the synchronization context and terminate the process.
    /// <para>
    /// That await is bounded by <c>timeout</c> (defaulting to
    /// <see cref="ManagedAgentsLimits.BestEffortSendTimeout"/>), because the handler is consumer
    /// code on the run's critical path and gets the same bound as any other best-effort call.
    /// Without one, a handler that never completes (an <c>await</c> on a host that blackholes the
    /// connection) would hold the caller forever: the run's terminal event would never be emitted
    /// and the thread's run gate would never be released, so every later run on that thread would
    /// be refused for the process's lifetime. Abandoning the handler is the lesser loss — the
    /// telemetry is best-effort, the run is not.
    /// </para>
    /// </remarks>
    internal static async Task ReportAsync(
        Func<Exception, ManagedAgentsErrorContext, Task>? onError,
        string operation,
        Exception error,
        string? sessionId = null,
        string? threadId = null,
        TimeSpan? timeout = null)
    {
        if (onError is null)
        {
            // No handler configured — the default. Without this the cause would be discarded
            // outright, because RUN_ERROR deliberately carries no third-party text: an operator
            // with a rotated API key would see "The run failed." and an empty log. Written to
            // stderr, never to the client, so the redaction the client relies on is untouched.
            var ids = string.Join(", ", new[]
            {
                sessionId is null ? null : $"sessionId={sessionId}",
                threadId is null ? null : $"threadId={threadId}",
            }.Where(part => part is not null));
            Console.Error.WriteLine(
                $"[claude-managed-agents] {operation} failed{(ids.Length > 0 ? $" ({ids})" : string.Empty)}: {error}");
            return;
        }

        try
        {
            var pending = onError(
                error,
                new ManagedAgentsErrorContext { Operation = operation, SessionId = sessionId, ThreadId = threadId });
            if (pending is not null)
            {
                await pending
                    .WaitAsync(timeout ?? ManagedAgentsLimits.BestEffortSendTimeout)
                    .ConfigureAwait(false);
            }
        }
        catch (Exception)
        {
            // ignored on purpose — including the TimeoutException from the bound above
        }
    }

    /// <summary>
    /// Reports from a callback that cannot await (a task continuation). The returned task is not
    /// observed because <see cref="ReportAsync"/> never faults.
    /// </summary>
    internal static void ReportDetached(
        Func<Exception, ManagedAgentsErrorContext, Task>? onError,
        string operation,
        Exception error,
        string? sessionId = null,
        string? threadId = null)
    {
        _ = ReportAsync(onError, operation, error, sessionId, threadId);
    }
}
