defmodule AgUiDemoWeb.AgentControllerTest do
  use AgUiDemoWeb.ConnCase, async: true

  test "GET /api/agent streams SSE", %{conn: conn} do
    conn = get(conn, ~p"/api/agent?scenario=text_streaming")

    assert conn.status == 200
    assert conn.state in [:chunked, :sent]

    assert Enum.any?(
             get_resp_header(conn, "content-type"),
             &String.starts_with?(&1, "text/event-stream")
           )

    assert get_resp_header(conn, "cache-control") == ["no-cache"]
    assert get_resp_header(conn, "connection") == ["keep-alive"]
  end
end
