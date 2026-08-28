defmodule AgUI.LiveView.ComponentsTest do
  use ExUnit.Case, async: true

  # Test that the components module compiles correctly when Phoenix is available
  describe "module availability" do
    test "Components module is defined when Phoenix.Component is available" do
      if Code.ensure_loaded?(Phoenix.Component) do
        assert Code.ensure_loaded?(AgUI.LiveView.Components)
      end
    end

    test "Components module uses Phoenix.Component" do
      if Code.ensure_loaded?(AgUI.LiveView.Components) do
        # The module should export component functions
        assert function_exported?(AgUI.LiveView.Components, :agui_chat, 1)
      end
    end
  end
end

# Component tests require Phoenix.Component to be available
if Code.ensure_loaded?(Phoenix.Component) do
  defmodule AgUI.LiveView.ComponentsFunctionalTest do
    use ExUnit.Case, async: true

    alias AgUI.LiveView.Components
    alias AgUI.LiveView.Renderer

    describe "component functions exist" do
      test "agui_chat is exported" do
        assert function_exported?(Components, :agui_chat, 1)
      end

      test "agui_message_list is exported" do
        assert function_exported?(Components, :agui_message_list, 1)
      end

      test "agui_message is exported" do
        assert function_exported?(Components, :agui_message, 1)
      end

      test "agui_streaming_text is exported" do
        assert function_exported?(Components, :agui_streaming_text, 1)
      end

      test "agui_tool_call is exported" do
        assert function_exported?(Components, :agui_tool_call, 1)
      end

      test "agui_run_status is exported" do
        assert function_exported?(Components, :agui_run_status, 1)
      end

      test "agui_thinking is exported" do
        assert function_exported?(Components, :agui_thinking, 1)
      end

      test "agui_state_debug is exported" do
        assert function_exported?(Components, :agui_state_debug, 1)
      end

      test "agui_streaming_tools is exported" do
        assert function_exported?(Components, :agui_streaming_tools, 1)
      end
    end

    describe "agui_chat component" do
      test "returns Phoenix.LiveView.Rendered struct" do
        ui_state = Renderer.init()

        result =
          Components.agui_chat(%{
            ui_state: ui_state,
            class: "",
            show_status: true,
            show_thinking: true
          })

        assert %Phoenix.LiveView.Rendered{} = result
      end

      test "accepts custom class" do
        ui_state = Renderer.init()

        result =
          Components.agui_chat(%{
            ui_state: ui_state,
            class: "my-class",
            show_status: false,
            show_thinking: false
          })

        assert %Phoenix.LiveView.Rendered{} = result
      end
    end

    describe "agui_message_list component" do
      test "renders empty list" do
        result = Components.agui_message_list(%{messages: [], streaming: %{}})
        assert %Phoenix.LiveView.Rendered{} = result
      end

      test "renders messages" do
        messages = [
          %{id: "1", role: :user, content: "Hello"},
          %{id: "2", role: :assistant, content: "Hi", tool_calls: []}
        ]

        result = Components.agui_message_list(%{messages: messages, streaming: %{}})
        assert %Phoenix.LiveView.Rendered{} = result
      end

      test "renders streaming messages" do
        result =
          Components.agui_message_list(%{
            messages: [],
            streaming: %{
              "s1" => %{content: "Streaming...", role: :assistant}
            }
          })

        assert %Phoenix.LiveView.Rendered{} = result
      end
    end

    describe "agui_message component" do
      test "renders user message" do
        result = Components.agui_message(%{message: %{id: "1", role: :user, content: "Hello"}})
        assert %Phoenix.LiveView.Rendered{} = result
      end

      test "renders assistant message" do
        result =
          Components.agui_message(%{
            message: %{id: "1", role: :assistant, content: "Hi", tool_calls: []}
          })

        assert %Phoenix.LiveView.Rendered{} = result
      end

      test "renders assistant message with tool calls" do
        result =
          Components.agui_message(%{
            message: %{
              id: "1",
              role: :assistant,
              content: "Let me help",
              tool_calls: [%{id: "tc1", name: "search", args: "{}"}]
            }
          })

        assert %Phoenix.LiveView.Rendered{} = result
      end

      test "renders tool message" do
        result =
          Components.agui_message(%{
            message: %{id: "1", role: :tool, content: "{\"result\": 42}"}
          })

        assert %Phoenix.LiveView.Rendered{} = result
      end

      test "renders system message" do
        result =
          Components.agui_message(%{message: %{id: "1", role: :system, content: "System prompt"}})

        assert %Phoenix.LiveView.Rendered{} = result
      end

      test "renders developer message" do
        result =
          Components.agui_message(%{message: %{id: "1", role: :developer, content: "Debug info"}})

        assert %Phoenix.LiveView.Rendered{} = result
      end

      test "renders activity message" do
        result =
          Components.agui_message(%{
            message: %{
              id: "1",
              role: :activity,
              activity_type: "chart",
              content: %{"data" => [1, 2, 3]}
            }
          })

        assert %Phoenix.LiveView.Rendered{} = result
      end

      test "renders unknown role message" do
        result =
          Components.agui_message(%{message: %{id: "1", role: :unknown, content: "Something"}})

        assert %Phoenix.LiveView.Rendered{} = result
      end
    end

    describe "agui_streaming_text component" do
      test "renders streaming content" do
        result =
          Components.agui_streaming_text(%{id: "s1", content: "Hello world", role: :assistant})

        assert %Phoenix.LiveView.Rendered{} = result
      end
    end

    describe "agui_tool_call component" do
      test "renders tool call" do
        result =
          Components.agui_tool_call(%{tool_call: %{name: "search", args: "{\"q\": \"test\"}"}})

        assert %Phoenix.LiveView.Rendered{} = result
      end
    end

    describe "agui_run_status component" do
      test "renders idle status" do
        result = Components.agui_run_status(%{status: :idle, steps: []})
        assert %Phoenix.LiveView.Rendered{} = result
      end

      test "renders running status" do
        result = Components.agui_run_status(%{status: :running, steps: []})
        assert %Phoenix.LiveView.Rendered{} = result
      end

      test "renders finished status" do
        result = Components.agui_run_status(%{status: :finished, steps: []})
        assert %Phoenix.LiveView.Rendered{} = result
      end

      test "renders error status" do
        result =
          Components.agui_run_status(%{status: {:error, "Something went wrong"}, steps: []})

        assert %Phoenix.LiveView.Rendered{} = result
      end

      test "renders with steps" do
        result =
          Components.agui_run_status(%{
            status: :running,
            steps: [
              %{name: "thinking", status: :finished},
              %{name: "responding", status: :started}
            ]
          })

        assert %Phoenix.LiveView.Rendered{} = result
      end
    end

    describe "agui_thinking component" do
      test "renders thinking indicator" do
        result = Components.agui_thinking(%{content: "Analyzing...", label: "Thinking"})
        assert %Phoenix.LiveView.Rendered{} = result
      end

      test "renders with empty content" do
        result = Components.agui_thinking(%{content: "", label: "Thinking..."})
        assert %Phoenix.LiveView.Rendered{} = result
      end
    end

    describe "agui_state_debug component" do
      test "renders state debug view" do
        result = Components.agui_state_debug(%{state: %{"counter" => 42, "items" => ["a", "b"]}})
        assert %Phoenix.LiveView.Rendered{} = result
      end
    end

    describe "agui_streaming_tools component" do
      test "renders streaming tools" do
        result =
          Components.agui_streaming_tools(%{
            tools: %{
              "tc1" => %{name: "search", args: "{\"query\":"},
              "tc2" => %{name: "calculate", args: ""}
            }
          })

        assert %Phoenix.LiveView.Rendered{} = result
      end

      test "renders empty tools map" do
        result = Components.agui_streaming_tools(%{tools: %{}})
        assert %Phoenix.LiveView.Rendered{} = result
      end
    end

    describe "__using__ macro" do
      test "macro is defined" do
        assert Kernel.macro_exported?(Components, :__using__, 1)
      end
    end

    describe "registry-based rendering" do
      test "render_agui_message falls back to default when no custom renderer" do
        result =
          Components.render_agui_message(%{
            message: %{id: "1", role: :user, content: "Hello"},
            message_registry: %{},
            activity_registry: %{}
          })

        assert %Phoenix.LiveView.Rendered{} = result
        rendered = Phoenix.HTML.Safe.to_iodata(result) |> IO.iodata_to_binary()
        assert rendered =~ "agui-user-content"
      end

      test "render_agui_message falls back to default activity render" do
        result =
          Components.render_agui_message(%{
            message: %{
              id: "1",
              role: :activity,
              activity_type: "unknown_type",
              content: %{"data" => 1}
            },
            message_registry: %{},
            activity_registry: %{}
          })

        assert %Phoenix.LiveView.Rendered{} = result
        rendered = Phoenix.HTML.Safe.to_iodata(result) |> IO.iodata_to_binary()
        assert rendered =~ "agui-activity"
      end

      test "render_agui_message uses message registry with custom renderer" do
        # Custom renderer returns a simple rendered struct
        custom_renderer = fn msg ->
          %Phoenix.LiveView.Rendered{
            static: ["<div class=\"custom-user\">", "</div>"],
            dynamic: fn _ -> [msg.content] end,
            fingerprint: 123,
            root: true
          }
        end

        result =
          Components.render_agui_message(%{
            message: %{id: "1", role: :user, content: "Hello"},
            message_registry: %{user: custom_renderer},
            activity_registry: %{}
          })

        assert %Phoenix.LiveView.Rendered{} = result
        rendered = Phoenix.HTML.Safe.to_iodata(result) |> IO.iodata_to_binary()
        assert rendered =~ "custom-user"
        assert rendered =~ "Hello"
      end

      test "render_agui_message uses activity registry with custom renderer" do
        custom_activity_renderer = fn msg ->
          %Phoenix.LiveView.Rendered{
            static: ["<div class=\"custom-chart\">", "</div>"],
            dynamic: fn _ -> [inspect(msg.content)] end,
            fingerprint: 456,
            root: true
          }
        end

        result =
          Components.render_agui_message(%{
            message: %{id: "1", role: :activity, activity_type: "chart", content: %{"x" => 1}},
            message_registry: %{},
            activity_registry: %{"chart" => custom_activity_renderer}
          })

        assert %Phoenix.LiveView.Rendered{} = result
        rendered = Phoenix.HTML.Safe.to_iodata(result) |> IO.iodata_to_binary()
        assert rendered =~ "custom-chart"
      end
    end
  end
end
