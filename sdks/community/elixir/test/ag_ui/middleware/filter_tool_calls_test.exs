defmodule AgUI.Middleware.FilterToolCallsTest do
  use ExUnit.Case, async: true

  alias AgUI.Middleware.FilterToolCalls
  alias AgUI.Middleware
  alias AgUI.Events
  alias AgUI.Types.RunAgentInput

  defp events(tool_name) do
    [
      %Events.RunStarted{thread_id: "t1", run_id: "r1"},
      %Events.ToolCallStart{tool_call_id: "c1", tool_call_name: tool_name},
      %Events.ToolCallArgs{tool_call_id: "c1", delta: "{}"},
      %Events.ToolCallEnd{tool_call_id: "c1"},
      %Events.RunFinished{thread_id: "t1", run_id: "r1"}
    ]
  end

  test "allowlist only passes specified tools" do
    middleware = FilterToolCalls.new(allow: ["weather"])
    runner = Middleware.chain([middleware], fn _input -> events("weather") end)

    input = %RunAgentInput{thread_id: "t1", run_id: "r1"}
    result = runner.(input) |> Enum.to_list()

    assert Enum.any?(result, &match?(%Events.ToolCallStart{}, &1))
  end

  test "allowlist filters other tools" do
    middleware = FilterToolCalls.new(allow: ["weather"])
    runner = Middleware.chain([middleware], fn _input -> events("search") end)

    input = %RunAgentInput{thread_id: "t1", run_id: "r1"}
    result = runner.(input) |> Enum.to_list()

    refute Enum.any?(result, &match?(%Events.ToolCallStart{}, &1))
  end

  test "blocklist filters specified tools" do
    middleware = FilterToolCalls.new(block: ["search"])
    runner = Middleware.chain([middleware], fn _input -> events("search") end)

    input = %RunAgentInput{thread_id: "t1", run_id: "r1"}
    result = runner.(input) |> Enum.to_list()

    refute Enum.any?(result, &match?(%Events.ToolCallStart{}, &1))
  end

  test "blocklist allows other tools" do
    middleware = FilterToolCalls.new(block: ["search"])
    runner = Middleware.chain([middleware], fn _input -> events("weather") end)

    input = %RunAgentInput{thread_id: "t1", run_id: "r1"}
    result = runner.(input) |> Enum.to_list()

    assert Enum.any?(result, &match?(%Events.ToolCallStart{}, &1))
  end
end
