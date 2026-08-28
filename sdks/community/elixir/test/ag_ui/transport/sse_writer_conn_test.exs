defmodule AgUI.Transport.SSEWriterConnTest do
  use ExUnit.Case, async: true

  alias AgUI.Events.RunStarted
  alias AgUI.Transport.SSE.Writer
  alias Plug.Test

  test "prepare_conn sets SSE headers and chunked response" do
    conn =
      Test.conn(:get, "/")
      |> Writer.prepare_conn()

    assert conn.state == :chunked
    assert Plug.Conn.get_resp_header(conn, "content-type") == ["text/event-stream"]
    assert Plug.Conn.get_resp_header(conn, "cache-control") == ["no-cache"]
    assert Plug.Conn.get_resp_header(conn, "connection") == ["keep-alive"]
  end

  test "write_event auto-prepares conn when not chunked" do
    conn = Test.conn(:get, "/")
    event = %RunStarted{thread_id: "t1", run_id: "r1"}

    {:ok, conn} = Writer.write_event(conn, event, auto_prepare: true)

    assert conn.state == :chunked
    assert Plug.Conn.get_resp_header(conn, "content-type") == ["text/event-stream"]
  end
end
