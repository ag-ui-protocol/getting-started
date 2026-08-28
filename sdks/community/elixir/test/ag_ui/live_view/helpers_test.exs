defmodule AgUI.LiveView.HelpersTest do
  use ExUnit.Case, async: true

  alias AgUI.LiveView.Helpers
  alias AgUI.LiveView.Renderer
  alias AgUI.Events

  # Mock socket that behaves like Phoenix.LiveView.Socket
  defmodule MockSocket do
    defstruct assigns: %{}
  end

  describe "init_agui/2 with mock socket" do
    test "initializes agui state in socket assigns" do
      socket = %MockSocket{assigns: %{}}

      socket = Helpers.init_agui(socket)

      assert %Renderer{} = socket.assigns.agui
      assert socket.assigns.agui_runner == nil
    end

    test "accepts thread_id option" do
      socket = %MockSocket{assigns: %{}}

      socket = Helpers.init_agui(socket, thread_id: "thread-123")

      assert socket.assigns.agui.session.thread_id == "thread-123"
    end

    test "accepts custom assign keys" do
      socket = %MockSocket{assigns: %{}}

      socket =
        Helpers.init_agui(socket,
          assign_key: :my_agui,
          runner_key: :my_runner
        )

      assert %Renderer{} = socket.assigns.my_agui
      assert socket.assigns.my_runner == nil
    end
  end

  describe "init_agui/2 with plain map" do
    test "works with plain maps" do
      state = %{}

      state = Helpers.init_agui(state)

      assert %Renderer{} = state.agui
      assert state.agui_runner == nil
    end
  end

  describe "handle_agui_message/3" do
    test "handles regular events" do
      socket = %MockSocket{assigns: %{}}
      socket = Helpers.init_agui(socket)

      event = %Events.RunStarted{
        type: :RUN_STARTED,
        thread_id: "t1",
        run_id: "r1"
      }

      {:ok, socket} = Helpers.handle_agui_message({:agui, event}, socket)

      assert socket.assigns.agui.run_status == :running
    end

    test "handles done message" do
      socket = %MockSocket{assigns: %{agui_runner: self()}}
      socket = Helpers.init_agui(socket)
      socket = %{socket | assigns: Map.put(socket.assigns, :agui_runner, self())}

      {:ok, socket} = Helpers.handle_agui_message({:agui, :done}, socket)

      assert socket.assigns.agui_runner == nil
    end

    test "handles error message" do
      socket = %MockSocket{assigns: %{}}
      socket = Helpers.init_agui(socket)
      socket = %{socket | assigns: Map.put(socket.assigns, :agui_runner, self())}

      {:ok, socket} = Helpers.handle_agui_message({:agui, {:error, "test error"}}, socket)

      assert socket.assigns.agui_runner == nil
    end

    test "returns :not_agui for non-agui messages" do
      socket = %MockSocket{assigns: %{}}
      socket = Helpers.init_agui(socket)

      result = Helpers.handle_agui_message({:other, :message}, socket)

      assert result == :not_agui
    end

    test "calls on_error callback" do
      socket = %MockSocket{assigns: %{}}
      socket = Helpers.init_agui(socket)
      socket = %{socket | assigns: Map.put(socket.assigns, :agui_runner, self())}

      on_error = fn socket, reason ->
        put_in(socket.assigns[:error_reason], reason)
      end

      {:ok, socket} =
        Helpers.handle_agui_message(
          {:agui, {:error, "test error"}},
          socket,
          on_error: on_error
        )

      assert socket.assigns.error_reason == "test error"
    end

    test "calls on_done callback" do
      socket = %MockSocket{assigns: %{}}
      socket = Helpers.init_agui(socket)
      socket = %{socket | assigns: Map.put(socket.assigns, :agui_runner, self())}

      on_done = fn socket ->
        put_in(socket.assigns[:completed], true)
      end

      {:ok, socket} =
        Helpers.handle_agui_message(
          {:agui, :done},
          socket,
          on_done: on_done
        )

      assert socket.assigns.completed == true
    end

    test "uses custom tag" do
      socket = %MockSocket{assigns: %{}}
      socket = Helpers.init_agui(socket)

      event = %Events.RunStarted{
        type: :RUN_STARTED,
        thread_id: "t1",
        run_id: "r1"
      }

      {:ok, socket} =
        Helpers.handle_agui_message(
          {:custom_tag, event},
          socket,
          tag: :custom_tag
        )

      assert socket.assigns.agui.run_status == :running
    end
  end

  describe "agui_running?/2" do
    test "returns true when runner is set" do
      socket = %MockSocket{assigns: %{agui_runner: self()}}

      assert Helpers.agui_running?(socket) == true
    end

    test "returns false when runner is nil" do
      socket = %MockSocket{assigns: %{agui_runner: nil}}

      assert Helpers.agui_running?(socket) == false
    end

    test "uses custom runner key" do
      socket = %MockSocket{assigns: %{my_runner: self()}}

      assert Helpers.agui_running?(socket, runner_key: :my_runner) == true
    end
  end

  describe "get_agui_state/2" do
    test "returns the UI state" do
      socket = %MockSocket{assigns: %{}}
      socket = Helpers.init_agui(socket)

      state = Helpers.get_agui_state(socket)

      assert %Renderer{} = state
    end

    test "uses custom assign key" do
      socket = %MockSocket{assigns: %{}}
      socket = Helpers.init_agui(socket, assign_key: :my_agui)

      state = Helpers.get_agui_state(socket, assign_key: :my_agui)

      assert %Renderer{} = state
    end
  end

  describe "abort_agui_run/2" do
    test "sets runner to nil when no runner exists" do
      socket = %MockSocket{assigns: %{agui_runner: nil}}

      socket = Helpers.abort_agui_run(socket)

      assert socket.assigns.agui_runner == nil
    end

    # Note: Testing actual abort requires integration test with Runner
  end

  describe "socket compatibility" do
    test "works with map having assigns key" do
      # Simulating Phoenix.LiveView.Socket structure
      socket = %{assigns: %{other: "data"}}

      socket = Helpers.init_agui(socket)

      assert %Renderer{} = socket.assigns.agui
      assert socket.assigns.other == "data"
    end

    test "works with plain map without assigns key" do
      state = %{other: "data"}

      state = Helpers.init_agui(state)

      assert %Renderer{} = state.agui
      assert state.other == "data"
    end
  end

  describe "multiple concurrent runs" do
    test "can track multiple independent runs" do
      socket1 =
        Helpers.init_agui(%MockSocket{assigns: %{}}, assign_key: :agui1, runner_key: :runner1)

      socket2 = Helpers.init_agui(socket1, assign_key: :agui2, runner_key: :runner2)

      event1 = %Events.RunStarted{type: :RUN_STARTED, thread_id: "t1", run_id: "r1"}
      event2 = %Events.RunStarted{type: :RUN_STARTED, thread_id: "t2", run_id: "r2"}

      {:ok, socket} =
        Helpers.handle_agui_message({:tag1, event1}, socket2, tag: :tag1, assign_key: :agui1)

      {:ok, socket} =
        Helpers.handle_agui_message({:tag2, event2}, socket, tag: :tag2, assign_key: :agui2)

      assert socket.assigns.agui1.session.run_id == "r1"
      assert socket.assigns.agui2.session.run_id == "r2"
    end
  end
end
