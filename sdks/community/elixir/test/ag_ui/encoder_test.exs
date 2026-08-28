defmodule AgUI.EncoderTest do
  use ExUnit.Case, async: true

  alias AgUI.Encoder
  alias AgUI.Events.RunStarted

  test "encodes event as JSON" do
    event = %RunStarted{thread_id: "t1", run_id: "r1"}
    json = Encoder.encode_event(event)

    assert %{"type" => "RUN_STARTED", "threadId" => "t1", "runId" => "r1"} =
             Jason.decode!(json)
  end

  test "raises on unsupported content type" do
    event = %RunStarted{thread_id: "t1", run_id: "r1"}

    assert_raise ArgumentError, ~r/unsupported content type/, fn ->
      Encoder.encode_event(event, "application/x-test")
    end
  end
end
