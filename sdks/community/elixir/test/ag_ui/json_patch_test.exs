defmodule AgUI.JSONPatchTest do
  use ExUnit.Case, async: true

  alias AgUI.JSONPatch

  describe "apply/2" do
    test "returns document unchanged for empty operations" do
      doc = %{"a" => 1, "b" => 2}
      assert {:ok, ^doc} = JSONPatch.apply(doc, [])
    end

    test "add operation adds a new key" do
      doc = %{"a" => 1}
      ops = [%{"op" => "add", "path" => "/b", "value" => 2}]
      assert {:ok, %{"a" => 1, "b" => 2}} = JSONPatch.apply(doc, ops)
    end

    test "add operation adds to nested path" do
      doc = %{"a" => %{"b" => 1}}
      ops = [%{"op" => "add", "path" => "/a/c", "value" => 2}]
      assert {:ok, %{"a" => %{"b" => 1, "c" => 2}}} = JSONPatch.apply(doc, ops)
    end

    test "add operation appends to array with - index" do
      doc = %{"items" => [1, 2]}
      ops = [%{"op" => "add", "path" => "/items/-", "value" => 3}]
      assert {:ok, %{"items" => [1, 2, 3]}} = JSONPatch.apply(doc, ops)
    end

    test "remove operation removes a key" do
      doc = %{"a" => 1, "b" => 2}
      ops = [%{"op" => "remove", "path" => "/b"}]
      assert {:ok, %{"a" => 1}} = JSONPatch.apply(doc, ops)
    end

    test "remove operation removes nested key" do
      doc = %{"a" => %{"b" => 1, "c" => 2}}
      ops = [%{"op" => "remove", "path" => "/a/b"}]
      assert {:ok, %{"a" => %{"c" => 2}}} = JSONPatch.apply(doc, ops)
    end

    test "remove operation returns error for missing path" do
      doc = %{"a" => 1}
      ops = [%{"op" => "remove", "path" => "/missing"}]
      assert {:error, {:patch_failed, _}} = JSONPatch.apply(doc, ops)
    end

    test "replace operation replaces existing value" do
      doc = %{"a" => 1}
      ops = [%{"op" => "replace", "path" => "/a", "value" => 99}]
      assert {:ok, %{"a" => 99}} = JSONPatch.apply(doc, ops)
    end

    test "replace operation replaces nested value" do
      doc = %{"a" => %{"b" => 1}}
      ops = [%{"op" => "replace", "path" => "/a/b", "value" => 42}]
      assert {:ok, %{"a" => %{"b" => 42}}} = JSONPatch.apply(doc, ops)
    end

    test "move operation moves value from one path to another" do
      doc = %{"a" => 1, "b" => 2}
      ops = [%{"op" => "move", "path" => "/c", "from" => "/a"}]
      assert {:ok, %{"b" => 2, "c" => 1}} = JSONPatch.apply(doc, ops)
    end

    test "copy operation copies value from one path to another" do
      doc = %{"a" => 1}
      ops = [%{"op" => "copy", "path" => "/b", "from" => "/a"}]
      assert {:ok, %{"a" => 1, "b" => 1}} = JSONPatch.apply(doc, ops)
    end

    test "test operation succeeds when value matches" do
      doc = %{"a" => 1}
      ops = [%{"op" => "test", "path" => "/a", "value" => 1}]
      assert {:ok, %{"a" => 1}} = JSONPatch.apply(doc, ops)
    end

    test "test operation fails when value does not match" do
      doc = %{"a" => 1}
      ops = [%{"op" => "test", "path" => "/a", "value" => 99}]
      assert {:error, {:patch_failed, _}} = JSONPatch.apply(doc, ops)
    end

    test "multiple operations are applied in sequence" do
      doc = %{"counter" => 0}

      ops = [
        %{"op" => "replace", "path" => "/counter", "value" => 1},
        %{"op" => "add", "path" => "/items", "value" => []},
        %{"op" => "add", "path" => "/items/-", "value" => "first"}
      ]

      assert {:ok, %{"counter" => 1, "items" => ["first"]}} = JSONPatch.apply(doc, ops)
    end

    test "operations are atomic - failure rolls back all changes" do
      doc = %{"a" => 1}

      ops = [
        %{"op" => "add", "path" => "/b", "value" => 2},
        # This should fail because /missing doesn't exist
        %{"op" => "remove", "path" => "/missing"}
      ]

      # The patch should fail and doc should be unchanged
      assert {:error, {:patch_failed, _}} = JSONPatch.apply(doc, ops)
    end

    test "accepts non-map documents" do
      doc = ["a", "b"]
      assert {:ok, ^doc} = JSONPatch.apply(doc, [])
    end

    test "returns error for invalid operations" do
      assert {:error, :invalid_operations} = JSONPatch.apply(%{}, "not a list")
    end

    test "handles complex nested structures" do
      doc = %{
        "users" => [
          %{"id" => 1, "name" => "Alice"},
          %{"id" => 2, "name" => "Bob"}
        ],
        "metadata" => %{"version" => "1.0"}
      }

      ops = [
        %{"op" => "replace", "path" => "/users/0/name", "value" => "Alicia"},
        %{"op" => "add", "path" => "/metadata/updated", "value" => true}
      ]

      assert {:ok, result} = JSONPatch.apply(doc, ops)
      assert result["users"] |> hd() |> Map.get("name") == "Alicia"
      assert result["metadata"]["updated"] == true
    end
  end

  describe "apply!/2" do
    test "returns result on success" do
      doc = %{"a" => 1}
      ops = [%{"op" => "add", "path" => "/b", "value" => 2}]
      assert %{"a" => 1, "b" => 2} = JSONPatch.apply!(doc, ops)
    end

    test "raises on failure" do
      doc = %{"a" => 1}
      ops = [%{"op" => "remove", "path" => "/missing"}]

      assert_raise ArgumentError, ~r/JSON Patch failed/, fn ->
        JSONPatch.apply!(doc, ops)
      end
    end
  end

  describe "AG-UI specific scenarios" do
    test "state delta - increment counter" do
      state = %{"counter" => 5, "items" => ["a", "b"]}
      ops = [%{"op" => "replace", "path" => "/counter", "value" => 6}]
      assert {:ok, %{"counter" => 6, "items" => ["a", "b"]}} = JSONPatch.apply(state, ops)
    end

    test "state delta - append to array" do
      state = %{"messages" => []}

      ops = [
        %{"op" => "add", "path" => "/messages/-", "value" => %{"id" => "1", "text" => "Hello"}}
      ]

      assert {:ok, result} = JSONPatch.apply(state, ops)
      assert length(result["messages"]) == 1
    end

    test "activity delta - update search results" do
      content = %{
        "status" => "searching",
        "results" => []
      }

      ops = [
        %{"op" => "replace", "path" => "/status", "value" => "complete"},
        %{"op" => "add", "path" => "/results/-", "value" => %{"url" => "https://example.com"}}
      ]

      assert {:ok, result} = JSONPatch.apply(content, ops)
      assert result["status"] == "complete"
      assert length(result["results"]) == 1
    end
  end
end
