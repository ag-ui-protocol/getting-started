# Step 14 — Telemetry (OpenTelemetry tracing)

This Step shows how to observe an AG-UI .NET app with **OpenTelemetry**. Nothing about the
protocol changes — you compose standard middleware and subscribe to two activity sources:

- `Experimental.AGUI.Server` — the AG-UI **run** span (`agui.run`), one per run, tagged with
  `agui.thread_id`, `agui.run_id`, `agui.parent_run_id` (on a resume), `agui.run.outcome`
  (`success` / `interrupt` / `error` / `canceled`), and `agui.events.count`.
- `Experimental.AGUI.Client` — `execute_tool` spans for client-side (frontend) tools that the
  `AGUIChatClient` invokes locally.
- `Experimental.Microsoft.Extensions.AI` — the GenAI spans from `UseOpenTelemetry()`
  (`chat`, `execute_tool`, `orchestrate_tools`), which nest **under** the run span.

The server also enables ASP.NET Core instrumentation and the client enables HttpClient
instrumentation, so the W3C `traceparent` header flows over the request and the whole exchange
is **one trace**.

## Run it

By default both apps print spans to their own console (no external dependency).

```bash
# terminal 1 — server (http://localhost:5014)
dotnet run --project Step14_Telemetry.Server

# terminal 2 — client
dotnet run --project Step14_Telemetry.Client
```

The client asks for the weather; the server's fake model calls the `get_weather` backend tool
and answers. Watch the spans appear in each console.

## Send the traces somewhere headless

Set `OTEL_EXPORTER_OTLP_ENDPOINT` on **both** processes to switch from the console exporter to
OTLP. Any OTLP sink works:

- **Aspire dashboard** (UI at `:18888`, OTLP at `:4317`):

  ```bash
  npx -y @microsoft/aspire-cli dashboard run        # or the mcr.microsoft.com/dotnet/aspire-dashboard image
  $env:OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4317"   # set in both terminals, then run as above
  ```

- **OpenTelemetry Collector** with the `debug` exporter (prints received spans to the
  collector's stdout) — point `OTEL_EXPORTER_OTLP_ENDPOINT` at the collector's OTLP port.

- **`dotnet-counters`** for live metrics from the GenAI meter:
  `dotnet-counters monitor -n Step14_Telemetry.Server --counters Experimental.Microsoft.Extensions.AI`.

## What the trace looks like

A single trace spans client and server:

```
agent conversation                         (client)
└─ chat                                     (client GenAI span — wraps the round trip)
   └─ POST http://localhost:5014/           (client HttpClient span)   ── traceparent ──▶
      └─ POST /                             (server ASP.NET request)
         └─ agui.run            {agui.thread_id, agui.run_id, agui.run.outcome=success, agui.events.count}
            └─ orchestrate_tools
               ├─ chat                      (gen_ai.operation.name=chat)        — model requests the tool
               ├─ execute_tool get_weather  (gen_ai.tool.name=get_weather)      — tool runs on the server
               └─ chat                      (gen_ai.operation.name=chat)        — model answers
```

For a **human-in-the-loop** flow, a resume is a second run: its `agui.run` carries
`agui.parent_run_id` pointing at the first run, and (when the client drives both turns under one
activity) both runs share the same trace — so the interrupt and its resume render together.
