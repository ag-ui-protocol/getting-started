defmodule AgUITest do
  use ExUnit.Case
  doctest AgUI

  test "version/0 returns version string" do
    assert AgUI.version() == "0.1.0"
  end
end
