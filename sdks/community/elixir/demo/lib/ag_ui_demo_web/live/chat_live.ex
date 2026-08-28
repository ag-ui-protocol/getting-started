defmodule AgUiDemoWeb.ChatLive do
  use AgUiDemoWeb, :live_view

  import AgUI.LiveView.Helpers
  import AgUI.LiveView.Components

  alias AgUI.Client.HttpAgent
  alias AgUI.Types.RunAgentInput
  alias AgUiDemo.Scenarios

  @impl true
  def mount(_params, _session, socket) do
    scenarios = Scenarios.list()

    socket =
      socket
      |> init_agui()
      |> assign(:scenarios, scenarios)
      |> assign(:selected_scenario, "text_streaming")
      |> assign(:custom_url, "")
      |> assign(:use_custom_url, false)
      |> assign(:thread_id, "demo-thread-#{:rand.uniform(10000)}")
      |> assign(:current_scope, nil)

    {:ok, socket}
  end

  @impl true
  def handle_event("select_scenario", %{"scenario" => scenario}, socket) do
    {:noreply, assign(socket, :selected_scenario, scenario)}
  end

  @impl true
  def handle_event("toggle_custom_url", _params, socket) do
    {:noreply, assign(socket, :use_custom_url, !socket.assigns.use_custom_url)}
  end

  @impl true
  def handle_event("update_custom_url", %{"url" => url}, socket) do
    {:noreply, assign(socket, :custom_url, url)}
  end

  @impl true
  def handle_event("run_scenario", _params, socket) do
    if agui_running?(socket) do
      {:noreply, socket}
    else
      run_id = uuid4()
      thread_id = socket.assigns.thread_id

      url =
        if socket.assigns.use_custom_url and socket.assigns.custom_url != "" do
          socket.assigns.custom_url
        else
          base_url = AgUiDemoWeb.Endpoint.url()
          scenario = socket.assigns.selected_scenario
          "#{base_url}/api/agent?scenario=#{scenario}"
        end

      input = %RunAgentInput{
        thread_id: thread_id,
        run_id: run_id,
        messages: [],
        tools: []
      }

      socket =
        start_agui_run(socket,
          agent: HttpAgent.new(url: url),
          input: input,
          reset: false
        )

      {:noreply, socket}
    end
  end

  @impl true
  def handle_event("reset", _params, socket) do
    socket =
      if agui_running?(socket) do
        abort_agui_run(socket)
      else
        socket
      end

    socket =
      socket
      |> init_agui()
      |> assign(:thread_id, "demo-thread-#{:rand.uniform(10000)}")

    {:noreply, socket}
  end

  @impl true
  def handle_event("abort", _params, socket) do
    {:noreply, abort_agui_run(socket)}
  end

  @impl true
  def handle_info(msg, socket) do
    case handle_agui_message(msg, socket) do
      {:ok, socket} -> {:noreply, socket}
      :not_agui -> {:noreply, socket}
    end
  end

  @impl true
  def render(assigns) do
    ~H"""
    <Layouts.app flash={@flash} current_scope={@current_scope}>
      <div class="min-h-screen bg-gray-100">
        <div class="max-w-6xl mx-auto py-8 px-4">
          <header class="mb-8">
            <h1 class="text-3xl font-bold text-gray-900">AG-UI Elixir SDK Demo</h1>
            <p class="mt-2 text-gray-600">
              Interactive demonstration of the AG-UI protocol with Phoenix LiveView
            </p>
          </header>

          <div id="agui-chat" class="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <%!-- Controls Panel --%>
            <div class="lg:col-span-1 space-y-4">
              <div class="bg-white rounded-lg shadow p-4">
                <h2 class="text-lg font-semibold mb-4">Scenarios</h2>

                <div id="scenarios-list" class="space-y-2">
                  <%= for {id, name, desc} <- @scenarios do %>
                    <button
                      id={"scenario-#{id}"}
                      phx-click="select_scenario"
                      phx-value-scenario={id}
                      class={"w-full text-left p-3 rounded-lg border transition-colors " <>
                      if @selected_scenario == id do
                        "border-blue-500 bg-blue-50 text-blue-700"
                      else
                        "border-gray-200 hover:border-gray-300 hover:bg-gray-50"
                      end}
                    >
                      <div class="font-medium">{name}</div>
                      <div class="text-sm text-gray-500">{desc}</div>
                    </button>
                  <% end %>
                </div>
              </div>

              <div class="bg-white rounded-lg shadow p-4">
                <h2 class="text-lg font-semibold mb-4">Custom Agent URL</h2>

                <.input
                  type="checkbox"
                  id="use-custom-url"
                  name="use_custom_url"
                  checked={@use_custom_url}
                  label="Use custom URL"
                  phx-click="toggle_custom_url"
                  class="checkbox checkbox-sm"
                />

                <%= if @use_custom_url do %>
                  <.input
                    type="text"
                    id="custom-agent-url"
                    name="custom_url"
                    value={@custom_url}
                    phx-blur="update_custom_url"
                    phx-keyup="update_custom_url"
                    phx-value-url={@custom_url}
                    placeholder="http://localhost:4000/api/agent"
                    class="w-full p-2 border rounded-lg text-sm"
                  />
                <% end %>
              </div>

              <div class="bg-white rounded-lg shadow p-4 space-y-3">
                <button
                  id="run-scenario"
                  phx-click="run_scenario"
                  disabled={agui_running?(assigns)}
                  class={"w-full py-2 px-4 rounded-lg font-medium transition-colors " <>
                  if agui_running?(assigns) do
                    "bg-gray-300 text-gray-500 cursor-not-allowed"
                  else
                    "bg-blue-600 text-white hover:bg-blue-700"
                  end}
                >
                  {if agui_running?(assigns), do: "Running...", else: "Run Scenario"}
                </button>

                <%= if agui_running?(assigns) do %>
                  <button
                    id="abort-run"
                    phx-click="abort"
                    class="w-full py-2 px-4 rounded-lg font-medium bg-red-100 text-red-700 hover:bg-red-200"
                  >
                    Abort
                  </button>
                <% end %>

                <button
                  id="reset-session"
                  phx-click="reset"
                  class="w-full py-2 px-4 rounded-lg font-medium bg-gray-100 text-gray-700 hover:bg-gray-200"
                >
                  Reset Session
                </button>
              </div>
            </div>

            <%!-- Chat Display --%>
            <div class="lg:col-span-2 space-y-4">
              <%!-- Run Status --%>
              <div id="run-status" class="bg-white rounded-lg shadow p-4">
                <.agui_run_status status={@agui.run_status} steps={@agui.steps} />
              </div>

              <%!-- Messages --%>
              <div id="messages-panel" class="bg-white rounded-lg shadow p-4 min-h-[400px]">
                <h2 class="text-lg font-semibold mb-4">Messages</h2>

                <div id="messages-list" class="space-y-4">
                  <%= if @agui.session.messages == [] and map_size(@agui.streaming_messages) == 0 do %>
                    <p class="text-gray-400 text-center py-8">
                      No messages yet. Run a scenario to see AG-UI in action!
                    </p>
                  <% else %>
                    <%= for message <- @agui.session.messages do %>
                      <.demo_message message={message} />
                    <% end %>

                    <%= for {id, buffer} <- @agui.streaming_messages do %>
                      <.agui_streaming_text id={id} content={buffer.content} role={buffer.role} />
                    <% end %>
                  <% end %>
                </div>

                <%!-- Thinking Indicator --%>
                <%= if @agui.session.thinking.active do %>
                  <div class="mt-4">
                    <.agui_thinking content={@agui.session.thinking.content} />
                  </div>
                <% end %>

                <%!-- Streaming Tools --%>
                <%= if map_size(@agui.streaming_tools) > 0 do %>
                  <div class="mt-4">
                    <.agui_streaming_tools tools={@agui.streaming_tools} />
                  </div>
                <% end %>
              </div>

              <%!-- State Debug --%>
              <%= if @agui.session.state != %{} do %>
                <div class="bg-white rounded-lg shadow p-4">
                  <.agui_state_debug state={@agui.session.state} />
                </div>
              <% end %>

              <%!-- Session Info --%>
              <div class="bg-white rounded-lg shadow p-4 text-sm text-gray-500">
                <div>Thread ID: {@thread_id}</div>
                <div>Event Count: {@agui.event_count}</div>
                <%= if @agui.last_event_type do %>
                  <div>Last Event: {@agui.last_event_type}</div>
                <% end %>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Layouts.app>
    """
  end

  # Custom message component with enhanced styling
  attr :message, :map, required: true

  defp demo_message(assigns) do
    ~H"""
    <div class={"p-4 rounded-lg " <> message_bg(@message.role)}>
      <div class="flex items-start gap-3">
        <div class={"w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-medium " <> role_color(@message.role)}>
          {role_initial(@message.role)}
        </div>
        <div class="flex-1 min-w-0">
          <div class="font-medium text-gray-900 mb-1">{role_label(@message.role)}</div>
          <div class="text-gray-700 whitespace-pre-wrap">{format_content(@message.content)}</div>

          <% tool_calls = Map.get(@message, :tool_calls, []) %>
          <%= if tool_calls != [] do %>
            <div class="mt-2 space-y-2">
              <%= for tc <- tool_calls do %>
                <.agui_tool_call tool_call={tc} />
              <% end %>
            </div>
          <% end %>
        </div>
      </div>
    </div>
    """
  end

  defp message_bg(:user), do: "bg-blue-50"
  defp message_bg(:assistant), do: "bg-gray-50"
  defp message_bg(:tool), do: "bg-yellow-50"
  defp message_bg(:system), do: "bg-purple-50"
  defp message_bg(_), do: "bg-white"

  defp role_color(:user), do: "bg-blue-600"
  defp role_color(:assistant), do: "bg-green-600"
  defp role_color(:tool), do: "bg-yellow-600"
  defp role_color(:system), do: "bg-purple-600"
  defp role_color(_), do: "bg-gray-600"

  defp role_initial(:user), do: "U"
  defp role_initial(:assistant), do: "A"
  defp role_initial(:tool), do: "T"
  defp role_initial(:system), do: "S"
  defp role_initial(_), do: "?"

  defp role_label(:user), do: "User"
  defp role_label(:assistant), do: "Assistant"
  defp role_label(:tool), do: "Tool Result"
  defp role_label(:system), do: "System"
  defp role_label(other), do: to_string(other)

  # Format message content - handles both strings and maps (for activity messages)
  defp format_content(content) when is_binary(content), do: content
  defp format_content(content) when is_map(content), do: Jason.encode!(content, pretty: true)
  defp format_content(content), do: inspect(content)

  # Generate a UUID v4
  defp uuid4 do
    <<u0::48, _::4, u1::12, _::2, u2::62>> = :crypto.strong_rand_bytes(16)

    <<u0::48, 4::4, u1::12, 2::2, u2::62>>
    |> Base.encode16(case: :lower)
    |> String.replace(~r/(.{8})(.{4})(.{4})(.{4})(.{12})/, "\\1-\\2-\\3-\\4-\\5")
  end
end
