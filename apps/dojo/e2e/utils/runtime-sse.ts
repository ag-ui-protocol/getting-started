import type { Page, Response } from "@playwright/test";

/** Escape a value taken off the wire before interpolating it into a RegExp. */
export function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Resolve with the completed runtime SSE body for the run whose request body
 * contains `marker`.
 *
 * Reading the COMPLETED body rather than live frames keeps wire-level
 * assertions free of timing flake.
 *
 * `marker` must be a quote-free fragment of the prompt: the prompt's own quotes
 * are JSON-escaped in the request body, so matching on them fails. Call this
 * BEFORE sending the message, since the run starts on the click.
 *
 * `integrationId` matches on a path boundary, so capturing `aws-strands` does
 * not also capture `aws-strands-typescript`.
 *
 * Page objects share this rather than each carrying a copy: the copies drifted,
 * and the un-hardened variant rejected the capture whenever a matching
 * response's body could not be buffered.
 */
export function captureRuntimeSSE(
  page: Page,
  integrationId: string,
  marker: string,
  // Below Playwright's 60s test timeout on purpose: at 60s the test would time
  // out first and the named diagnostic below could never be reported.
  timeoutMs = 30_000,
): Promise<string> {
  const pathRe = new RegExp(
    `/api/copilotkit/${escapeForRegExp(integrationId)}(/|$)`,
  );
  let settled = false;

  return new Promise<string>((resolve, reject) => {
    const finish = (fn: () => void) => {
      settled = true;
      clearTimeout(timer);
      page.off("response", onResponse);
      fn();
    };

    // Rejects rather than hanging: a marker that no longer matches the prompt
    // would otherwise surface as an anonymous test timeout with nothing naming
    // the cause.
    const timer = setTimeout(() => {
      if (settled) return;
      finish(() =>
        reject(
          new Error(
            `No runtime SSE response for ${integrationId} matched ${JSON.stringify(marker)} within ${timeoutMs}ms. ` +
              `The marker must be a quote-free fragment of the prompt actually sent.`,
          ),
        ),
      );
    }, timeoutMs);

    const onResponse = async (response: Response) => {
      if (settled) return;
      try {
        if (
          !pathRe.test(new URL(response.url()).pathname) ||
          response.request().method() !== "POST" ||
          // The run's own stream, not a redirect or an error page that happens
          // to carry the marker in its request.
          !(response.headers()["content-type"] ?? "").includes(
            "text/event-stream",
          ) ||
          !(response.request().postData() ?? "").includes(marker)
        ) {
          return;
        }
        // Read defensively: a matching response whose body cannot be buffered
        // (aborted retry, teardown race) must not settle the capture, because
        // the real run response may still be coming.
        const body = await response.text();
        if (!settled) finish(() => resolve(body));
      } catch {
        // Ignore this response; a readable match may still arrive.
      }
    };

    page.on("response", onResponse);
  });
}

/**
 * The single SSE line starting at `from`.
 *
 * `indexOf("\n")` returns -1 on the stream's last frame, and slicing to -1 would
 * silently widen the "frame" to the rest of the body, so an assertion scoped to
 * one frame would pass on content from any later frame.
 */
export function sseFrameAt(sse: string, from: number): string {
  // A negative `from` means the caller's search missed. Slicing from it would
  // count back from the end and quietly return some other line, so it is
  // rejected rather than answered with the wrong text.
  if (from < 0) {
    throw new Error(`sseFrameAt needs a real offset, got ${from}`);
  }
  const end = sse.indexOf("\n", from);
  return end === -1 ? sse.slice(from) : sse.slice(from, end);
}
