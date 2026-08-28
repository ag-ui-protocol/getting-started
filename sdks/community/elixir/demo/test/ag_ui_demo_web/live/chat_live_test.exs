defmodule AgUiDemoWeb.ChatLiveTest do
  use AgUiDemoWeb.ConnCase, async: true

  import Phoenix.LiveViewTest

  test "renders chat surface", %{conn: conn} do
    {:ok, view, _html} = live(conn, ~p"/chat")

    assert has_element?(view, "#agui-chat")
    assert has_element?(view, "#scenarios-list")
    assert has_element?(view, "#scenario-text_streaming")
    assert has_element?(view, "#run-scenario")
    assert has_element?(view, "#reset-session")
    assert has_element?(view, "#messages-list")
    assert has_element?(view, "#run-status")
  end

  test "toggle custom url input", %{conn: conn} do
    {:ok, view, _html} = live(conn, ~p"/chat")

    refute has_element?(view, "#custom-agent-url")

    _ = view |> element("#use-custom-url") |> render_click()

    assert has_element?(view, "#custom-agent-url")
  end

  test "selects a scenario button", %{conn: conn} do
    {:ok, view, _html} = live(conn, ~p"/chat")

    _ = view |> element("#scenario-tool_call") |> render_click()

    assert has_element?(view, "#scenario-tool_call.border-blue-500")
  end
end
