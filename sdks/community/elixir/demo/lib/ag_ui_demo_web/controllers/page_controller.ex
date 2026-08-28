defmodule AgUiDemoWeb.PageController do
  use AgUiDemoWeb, :controller

  def home(conn, _params) do
    redirect(conn, to: ~p"/chat")
  end
end
