defmodule AgUiDemoWeb.PageControllerTest do
  use AgUiDemoWeb.ConnCase

  test "GET /", %{conn: conn} do
    conn = get(conn, ~p"/")
    assert redirected_to(conn, 302) == ~p"/chat"
  end
end
