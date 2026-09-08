# Changelog

## 1.1.3 — 2026-09-08

- Report remote token usage from Mastra runs.
- Add `onTextBuffered` callback so segment identity is preserved when `useProcessedFinalText` buffers deltas past a tool-call boundary.
- Honour a caller-supplied client abort signal by chaining it into the run's controller instead of overriding it.
- Cancel remote runs at the producer via a per-run cloned client, stopping server-side production and billing on abort.
- Give each assistant text segment its own continuation id.
- Propagate cancellation from Observable teardown.
- Settle aborted runs instead of silently dropping chunks.

### Breaking changes

- Peer dependency floors for ag-ui core and client raised to 0.0.58.
