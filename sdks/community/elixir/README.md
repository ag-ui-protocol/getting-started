# AgUI

Elixir SDK for the AG‑UI protocol (SSE v1) with optional Phoenix LiveView integration.

## Features

- Typed protocol events and message/tool structs
- SSE client with chunk normalization and compaction helpers
- Protocol reducer and LiveView‑friendly renderer
- Optional LiveView component kit and runner
- Safe normalization option (`RUN_ERROR` on malformed chunks)
- SSE resume via `Last-Event-ID`

## Requirements

- Elixir ~> 1.15
- Erlang/OTP compatible with your Elixir version

## Installation

Add `ag_ui` to your dependencies:

```elixir
def deps do
  [
    {:ag_ui, "~> 0.1.0"}
  ]
end
```

## Quick start

```elixir
alias AgUI.Client.HttpAgent
alias AgUI.Types.RunAgentInput

agent = HttpAgent.new(url: "https://api.example.com/agent")
input = RunAgentInput.new("thread-1", "run-1")

{:ok, result} = HttpAgent.run_agent(agent, input)
IO.inspect(result.new_messages)
```

## Basic usage

```elixir
alias AgUI.Client.HttpAgent
alias AgUI.Types.RunAgentInput

agent = HttpAgent.new(url: "https://api.example.com/agent")
input = RunAgentInput.new("thread-1", "run-1")

{:ok, stream} = HttpAgent.stream_canonical(agent, input, on_error: :run_error)
Enum.each(stream, &IO.inspect/1)
```

### High-level run helper

```elixir
{:ok, result} = HttpAgent.run_agent(agent, input)
IO.inspect(result.new_messages)
IO.inspect(result.session.state)
```

### High-level run helper via AgUI

```elixir
{:ok, result} = AgUI.run_agent(agent, input)
IO.inspect(result.new_messages)
```

### High-level run helper (bang)

```elixir
result = HttpAgent.run_agent!(agent, input)
IO.inspect(result.new_messages)
```

## API overview

- Core protocol types: `AgUI.Types.*`
- Event decoding/encoding: `AgUI.Events`, `AgUI.Encoder`
- HTTP client: `AgUI.Client.HttpAgent`
- State reducer: `AgUI.Session`, `AgUI.Reducer`
- LiveView renderer/runner: `AgUI.LiveView.*` (optional)

## Reducer/session example

```elixir
alias AgUI.Session
alias AgUI.Reducer
alias AgUI.Events

session = Session.new("thread-1", "run-1")

session =
  session
  |> Reducer.apply(%Events.RunStarted{thread_id: "thread-1", run_id: "run-1"})
  |> Reducer.apply(%Events.TextMessageStart{message_id: "m1", role: "assistant"})
  |> Reducer.apply(%Events.TextMessageContent{message_id: "m1", delta: "Hello"})
  |> Reducer.apply(%Events.TextMessageEnd{message_id: "m1"})

IO.inspect(session.messages)
```

## Middleware and subscriber example

```elixir
alias AgUI.Middleware
alias AgUI.Subscriber
alias AgUI.Middleware.FilterToolCalls

logger =
  Middleware.from_function(fn input, next ->
    IO.puts("Run: #{input.run_id}")
    next.(input)
  end)

subscriber =
  Subscriber.from_handlers(%{
    text_message_content: fn event, _session ->
      IO.write(event.delta)
      :ok
    end
  })

runner = Middleware.chain([logger], fn input -> HttpAgent.stream(agent, input) end)
stream = runner.(input)
Subscriber.observe(stream, subscriber, AgUI.Session.new()) |> Enum.to_list()
```

### Specialized subscriber callbacks

```elixir
defmodule MyApp.Subscriber do
  @behaviour AgUI.Subscriber

  @impl true
  def on_text_message_content(_event, buffer, _session) do
    IO.write(buffer)
    :ok
  end

  @impl true
  def on_tool_call_args(_event, buffer, _session) do
    IO.write(buffer)
    :ok
  end

  @impl true
  def on_event(_event, _session), do: :ok
end
```

### Filter tool calls middleware

```elixir
middleware = FilterToolCalls.new(allow: ["weather", "search"])
runner = Middleware.chain([middleware], fn input -> HttpAgent.stream(agent, input) end)
runner.(input) |> Enum.to_list()
```

## Tool-call streaming example

```elixir
{:ok, stream} = HttpAgent.stream_canonical(agent, input)

Enum.each(stream, fn
  %AgUI.Events.ToolCallStart{tool_call_name: name} ->
    IO.puts("Tool: #{name}")

  %AgUI.Events.ToolCallArgs{delta: delta} ->
    IO.write(delta)

  %AgUI.Events.ToolCallEnd{} ->
    IO.puts("")

  _ ->
    :ok
end)
```

## Error handling patterns

```elixir
{:ok, stream} = HttpAgent.stream_canonical(agent, input, on_error: :run_error)

Enum.each(stream, fn
  %AgUI.Events.RunError{message: msg} -> IO.puts("Run error: #{msg}")
  _ -> :ok
end)
```

## Event sequencing validation

```elixir
events = HttpAgent.stream_canonical(agent, input) |> Enum.to_list()
AgUI.Verify.verify_events(events)
```

### Stream validation (verify_stream/1)

```elixir
{:ok, stream} = HttpAgent.stream_canonical(agent, input)

stream
|> AgUI.Verify.verify_stream()
|> Enum.each(&IO.inspect/1)
```

## Server-side usage

```elixir
alias AgUI.Events.RunStarted
alias AgUI.Transport.SSE.Writer

event = %RunStarted{thread_id: "t1", run_id: "r1"}
{:ok, conn} = Writer.write_event(conn, event)
```

### Plug controller streaming example

```elixir
defmodule MyAppWeb.AgentController do
  use MyAppWeb, :controller

  alias AgUI.Events
  alias AgUI.Transport.SSE.Writer

  def run(conn, _params) do
    conn = Writer.prepare_conn(conn)

    {:ok, conn} =
      Writer.write_event(conn, %Events.RunStarted{thread_id: "t1", run_id: "r1"})

    {:ok, conn} =
      Writer.write_event(conn, %Events.TextMessageContent{
        message_id: "m1",
        delta: "Hello from Elixir",
        role: :assistant
      })

    {:ok, conn} =
      Writer.write_event(conn, %Events.RunFinished{thread_id: "t1", run_id: "r1"})

    conn
  end
end
```

### SSE resume

Pass `last_event_id` to resume from a previous event id:

```elixir
{:ok, stream} =
  HttpAgent.stream_canonical(agent, input,
    last_event_id: "evt-123",
    on_error: :run_error
  )
```

## LiveView integration (optional)

LiveView support is fully optional. Use the pure renderer and runner to
drive a LiveView without forcing Phoenix deps on non‑Phoenix users.

```elixir
alias AgUI.LiveView.Runner
alias AgUI.LiveView.Renderer

ui_state = Renderer.init()
{:ok, pid} =
  Runner.start_link(
    liveview: self(),
    agent: agent,
    run_params: input,
    tag: :agui
  )
```

You can also inject the component kit via:

```elixir
defmodule MyAppWeb.AGUIComponents do
  use Phoenix.Component
  use AgUI.LiveView.Components
end
```

## Demo app

The `demo/` directory contains a Phoenix LiveView app that exercises the SDK
via a local mock agent endpoint.

```bash
cd demo
mix deps.get
mix phx.server
```

## Testing

```bash
mix test
```

## API documentation

- HexDocs (coming soon)

## Contributing

```bash
mix deps.get
mix test
```

## Deferred features (not yet implemented)

- Binary protocol transport (`application/vnd.ag-ui.event+proto`)
- WebSocket transport
- CI Dialyzer/Credo gates

## Compatibility matrix

| Area | Status |
| --- | --- |
| Protocol events (core) | ✅ |
| SSE transport | ✅ |
| Proto/binary transport | ❌ |
| LiveView integration | ✅ (optional) |
| WebSocket transport | ❌ |

## License

MIT
