defmodule AgUI.LiveView.RunnerTest do
  use ExUnit.Case, async: true

  alias AgUI.LiveView.Runner
  alias AgUI.Client.HttpAgent
  alias AgUI.Types.RunAgentInput
  alias AgUI.Events

  # Mock server for testing
  defmodule MockServer do
    use Plug.Router

    plug(Plug.Parsers,
      parsers: [:json],
      pass: ["application/json"],
      json_decoder: Jason
    )

    plug(:match)
    plug(:dispatch)

    post "/stream" do
      events = [
        %{type: "RUN_STARTED", threadId: "t1", runId: "r1"},
        %{type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant"},
        %{type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Hello"},
        %{type: "TEXT_MESSAGE_END", messageId: "m1"},
        %{type: "RUN_FINISHED", threadId: "t1", runId: "r1"}
      ]

      conn
      |> put_resp_content_type("text/event-stream")
      |> send_chunked(200)
      |> send_events(events)
    end

    post "/error" do
      conn
      |> send_resp(500, "Internal Server Error")
    end

    post "/slow" do
      Process.sleep(100)

      events = [
        %{type: "RUN_STARTED", threadId: "t1", runId: "r1"},
        %{type: "RUN_FINISHED", threadId: "t1", runId: "r1"}
      ]

      conn
      |> put_resp_content_type("text/event-stream")
      |> send_chunked(200)
      |> send_events(events)
    end

    defp send_events(conn, events) do
      Enum.reduce(events, conn, fn event, conn ->
        data = "data: #{Jason.encode!(event)}\n\n"
        {:ok, conn} = chunk(conn, data)
        conn
      end)
    end
  end

  setup_all do
    # Start the mock server
    {:ok, _pid} = Bandit.start_link(plug: MockServer, port: 0, ip: :loopback)

    # Get the actual port
    # We need to start on a random port and get it
    port = get_available_port()
    {:ok, _pid} = Bandit.start_link(plug: MockServer, port: port, ip: :loopback)

    {:ok, port: port}
  end

  defp get_available_port do
    {:ok, socket} = :gen_tcp.listen(0, [:binary, active: false, reuseaddr: true])
    {:ok, port} = :inet.port(socket)
    :gen_tcp.close(socket)
    port
  end

  describe "start_link/1" do
    test "starts a runner process", %{port: port} do
      agent = HttpAgent.new(url: "http://localhost:#{port}/stream")

      input = %RunAgentInput{
        thread_id: "thread-1",
        run_id: "run-1",
        messages: [],
        tools: []
      }

      {:ok, runner} =
        Runner.start_link(
          liveview: self(),
          agent: agent,
          input: input,
          tag: :test_agui
        )

      assert is_pid(runner)
      assert Process.alive?(runner)

      # Wait for events
      assert_receive {:test_agui, %Events.RunStarted{}}, 5000
      assert_receive {:test_agui, %Events.TextMessageStart{}}, 5000
      assert_receive {:test_agui, %Events.TextMessageContent{}}, 5000
      assert_receive {:test_agui, %Events.TextMessageEnd{}}, 5000
      assert_receive {:test_agui, %Events.RunFinished{}}, 5000
      assert_receive {:test_agui, :done}, 5000
    end

    test "uses default tag :agui", %{port: port} do
      agent = HttpAgent.new(url: "http://localhost:#{port}/stream")

      input = %RunAgentInput{
        thread_id: "thread-1",
        run_id: "run-1",
        messages: [],
        tools: []
      }

      {:ok, _runner} =
        Runner.start_link(
          liveview: self(),
          agent: agent,
          input: input
        )

      assert_receive {:agui, %Events.RunStarted{}}, 5000
    end

    test "sends error on connection failure" do
      # Use a valid port number that's unlikely to have anything listening
      agent = HttpAgent.new(url: "http://localhost:59999/nonexistent")

      input = %RunAgentInput{
        thread_id: "thread-1",
        run_id: "run-1",
        messages: [],
        tools: []
      }

      {:ok, _runner} =
        Runner.start_link(
          liveview: self(),
          agent: agent,
          input: input,
          tag: :test_agui
        )

      # Should receive an error (either connection refused or task crashed)
      assert_receive {:test_agui, {:error, _reason}}, 5000
    end
  end

  describe "abort/1" do
    test "aborts a running stream", %{port: port} do
      agent = HttpAgent.new(url: "http://localhost:#{port}/slow")

      input = %RunAgentInput{
        thread_id: "thread-1",
        run_id: "run-1",
        messages: [],
        tools: []
      }

      {:ok, runner} =
        Runner.start_link(
          liveview: self(),
          agent: agent,
          input: input,
          tag: :test_agui
        )

      # Abort immediately
      :ok = Runner.abort(runner)

      # Should receive done
      assert_receive {:test_agui, :done}, 1000
    end
  end

  describe "streaming?/1" do
    test "returns true when streaming", %{port: port} do
      agent = HttpAgent.new(url: "http://localhost:#{port}/slow")

      input = %RunAgentInput{
        thread_id: "thread-1",
        run_id: "run-1",
        messages: [],
        tools: []
      }

      {:ok, runner} =
        Runner.start_link(
          liveview: self(),
          agent: agent,
          input: input,
          tag: :test_agui
        )

      # Should be streaming initially
      assert Runner.streaming?(runner) == true

      # Abort and wait for cleanup
      Runner.abort(runner)
      assert_receive {:test_agui, :done}, 1000
    end
  end

  describe "process monitoring" do
    test "stops runner when LiveView dies", %{port: port} do
      agent = HttpAgent.new(url: "http://localhost:#{port}/slow")

      input = %RunAgentInput{
        thread_id: "thread-1",
        run_id: "run-1",
        messages: [],
        tools: []
      }

      # Start a fake LiveView process
      fake_lv =
        spawn(fn ->
          receive do
            :stop -> :ok
          end
        end)

      {:ok, runner} =
        Runner.start_link(
          liveview: fake_lv,
          agent: agent,
          input: input,
          tag: :test_agui
        )

      assert Process.alive?(runner)

      # Kill the fake LiveView
      Process.exit(fake_lv, :kill)

      # Runner should stop
      Process.sleep(100)
      refute Process.alive?(runner)
    end
  end

  describe "normalization" do
    test "normalizes events by default", %{port: port} do
      agent = HttpAgent.new(url: "http://localhost:#{port}/stream")

      input = %RunAgentInput{
        thread_id: "thread-1",
        run_id: "run-1",
        messages: [],
        tools: []
      }

      {:ok, _runner} =
        Runner.start_link(
          liveview: self(),
          agent: agent,
          input: input,
          tag: :test_agui,
          normalize: true
        )

      # Should receive normalized events
      assert_receive {:test_agui, event}, 5000
      assert is_struct(event)
    end

    test "can disable normalization", %{port: port} do
      agent = HttpAgent.new(url: "http://localhost:#{port}/stream")

      input = %RunAgentInput{
        thread_id: "thread-1",
        run_id: "run-1",
        messages: [],
        tools: []
      }

      {:ok, _runner} =
        Runner.start_link(
          liveview: self(),
          agent: agent,
          input: input,
          tag: :test_agui,
          normalize: false
        )

      # Should still receive events (raw)
      assert_receive {:test_agui, _event}, 5000
    end
  end
end
