defmodule AgUI.Transport.SSEWriterTest do
  use ExUnit.Case, async: true

  alias AgUI.Events.RunStarted
  alias AgUI.Transport.SSE.Writer

  test "encodes event into SSE frame with data only" do
    event = %RunStarted{thread_id: "t1", run_id: "r1"}
    frame = IO.iodata_to_binary(Writer.encode_event(event))

    assert String.starts_with?(frame, "data: {")
    assert String.ends_with?(frame, "\n\n")
  end

  test "encodes event with event/id/retry fields" do
    event = %RunStarted{thread_id: "t1", run_id: "r1"}

    frame =
      event
      |> Writer.encode_event(event: "agui", id: "evt-1", retry: 5000)
      |> IO.iodata_to_binary()

    assert String.contains?(frame, "event: agui\n")
    assert String.contains?(frame, "id: evt-1\n")
    assert String.contains?(frame, "retry: 5000\n")
  end

  test "splits multiline data into multiple data lines" do
    frame =
      Writer.encode_data("{\"a\":1}\n{\"b\":2}")
      |> IO.iodata_to_binary()

    assert frame ==
             "data: {\"a\":1}\n" <>
               "data: {\"b\":2}\n" <>
               "\n"
  end
end
