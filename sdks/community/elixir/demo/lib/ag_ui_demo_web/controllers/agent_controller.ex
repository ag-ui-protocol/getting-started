defmodule AgUiDemoWeb.AgentController do
  use AgUiDemoWeb, :controller

  alias AgUI.Transport.SSE.Writer
  alias AgUiDemo.Scenarios

  @doc """
  Handles POST requests to run an agent scenario.

  Expects JSON body with:
  - scenario: string (scenario name)
  - threadId: string (optional)
  - runId: string (optional)

  Returns SSE stream of AG-UI events.
  """
  def run(conn, params) do
    scenario = Map.get(params, "scenario", "text_streaming")
    thread_id = Map.get(params, "threadId", "demo-thread-#{:rand.uniform(1000)}")
    run_id = Map.get(params, "runId", uuid4())

    opts = [thread_id: thread_id, run_id: run_id]

    {events, delay} = Scenarios.get(scenario, opts)

    conn
    |> Writer.prepare_conn(headers: [{"access-control-allow-origin", "*"}])
    |> stream_events(events, delay)
  end

  defp stream_events(conn, events, delay) do
    Enum.reduce_while(events, conn, fn event, conn ->
      # Add small delay between events for realistic streaming
      Process.sleep(delay)

      case Writer.write_event(conn, event, auto_prepare: false) do
        {:ok, conn} -> {:cont, conn}
        {:error, _reason} -> {:halt, conn}
      end
    end)
  end

  # Generate a UUID v4
  defp uuid4 do
    <<u0::48, _::4, u1::12, _::2, u2::62>> = :crypto.strong_rand_bytes(16)

    <<u0::48, 4::4, u1::12, 2::2, u2::62>>
    |> Base.encode16(case: :lower)
    |> String.replace(~r/(.{8})(.{4})(.{4})(.{4})(.{12})/, "\\1-\\2-\\3-\\4-\\5")
  end
end
