if Code.ensure_loaded?(Phoenix.Component) do
  defmodule AgUI.LiveView.Components do
    @moduledoc """
    AG-UI component kit for Phoenix LiveView.

    This module provides pre-built LiveView components for rendering AG-UI
    chat interfaces. Components support pluggable renderers for custom
    message and activity types via registries.

    ## Usage

    Use this module in your LiveView to get all AG-UI components:

        defmodule MyAppWeb.ChatLive do
          use MyAppWeb, :live_view
          use AgUI.LiveView.Components

          def render(assigns) do
            ~H\"\"\"
            <.agui_chat ui_state={@agui} />
            \"\"\"
          end
        end

    ## Custom Renderers

    You can customize how specific message roles or activity types are rendered
    by providing registry options:

        use AgUI.LiveView.Components,
          message_registry: %{
            user: &MyComponents.custom_user_message/1,
            assistant: &MyComponents.custom_assistant_message/1
          },
          activity_registry: %{
            "code_execution" => &MyComponents.code_execution_activity/1,
            "file_upload" => &MyComponents.file_upload_activity/1
          }

    Registry functions receive the message map as their argument and should
    return a Phoenix.LiveView.Rendered struct (typically via ~H sigil).

    ## Components

    - `agui_chat/1` - Main chat container
    - `agui_message_list/1` - List of messages with streaming support
    - `agui_message/1` - Single message with role-based rendering
    - `agui_streaming_text/1` - Streaming text with cursor
    - `agui_tool_call/1` - Tool call display
    - `agui_run_status/1` - Run status indicator
    - `agui_thinking/1` - Thinking indicator
    - `agui_state_debug/1` - State debug view
    - `agui_streaming_tools/1` - Streaming tool calls display

    ## Import-Only Usage

    If you prefer to import components without the registry feature:

        import AgUI.LiveView.Components

    Note: With import-only usage, custom registries are not available.
    Use `use AgUI.LiveView.Components` for full registry support.
    """

    use Phoenix.Component

    @doc """
    Injects AG-UI components with optional custom registries.

    ## Options

    - `:message_registry` - Map of role atoms to render functions
    - `:activity_registry` - Map of activity_type strings to render functions

    ## Example

        use AgUI.LiveView.Components,
          message_registry: %{user: &my_user_renderer/1},
          activity_registry: %{"code" => &my_code_activity/1}
    """
    defmacro __using__(opts) do
      activity_registry = Keyword.get(opts, :activity_registry, %{})
      message_registry = Keyword.get(opts, :message_registry, %{})

      quote do
        use Phoenix.Component
        import AgUI.LiveView.Components, only: []

        @agui_activity_registry unquote(Macro.escape(activity_registry))
        @agui_message_registry unquote(Macro.escape(message_registry))

        # Main chat container
        attr :ui_state, :map, required: true
        attr :class, :string, default: ""
        attr :show_status, :boolean, default: true
        attr :show_thinking, :boolean, default: true

        def agui_chat(assigns) do
          assigns =
            assigns
            |> assign(:activity_registry, @agui_activity_registry)
            |> assign(:message_registry, @agui_message_registry)

          AgUI.LiveView.Components.render_agui_chat(assigns)
        end

        # Message list
        attr :messages, :list, required: true
        attr :streaming, :map, default: %{}

        def agui_message_list(assigns) do
          assigns =
            assigns
            |> assign(:activity_registry, @agui_activity_registry)
            |> assign(:message_registry, @agui_message_registry)

          AgUI.LiveView.Components.render_agui_message_list(assigns)
        end

        # Single message with registry support
        attr :message, :map, required: true

        def agui_message(assigns) do
          assigns =
            assigns
            |> assign(:activity_registry, @agui_activity_registry)
            |> assign(:message_registry, @agui_message_registry)

          AgUI.LiveView.Components.render_agui_message(assigns)
        end

        # Delegate other components to the module
        defdelegate agui_streaming_text(assigns), to: AgUI.LiveView.Components
        defdelegate agui_tool_call(assigns), to: AgUI.LiveView.Components
        defdelegate agui_run_status(assigns), to: AgUI.LiveView.Components
        defdelegate agui_thinking(assigns), to: AgUI.LiveView.Components
        defdelegate agui_state_debug(assigns), to: AgUI.LiveView.Components
        defdelegate agui_streaming_tools(assigns), to: AgUI.LiveView.Components
      end
    end

    # ========================================
    # Render functions used by __using__ macro
    # ========================================

    @doc false
    def render_agui_chat(assigns) do
      ~H"""
      <div class={"agui-chat " <> @class}>
        <.render_agui_message_list
          messages={@ui_state.session.messages}
          streaming={@ui_state.streaming_messages}
          activity_registry={@activity_registry}
          message_registry={@message_registry}
        />
        <%= if @show_thinking and @ui_state.session.thinking.active do %>
          <.agui_thinking content={@ui_state.session.thinking.content} />
        <% end %>
        <%= if @show_status do %>
          <.agui_run_status status={@ui_state.run_status} steps={@ui_state.steps} />
        <% end %>
      </div>
      """
    end

    @doc false
    def render_agui_message_list(assigns) do
      ~H"""
      <div class="agui-message-list">
        <%= for message <- @messages do %>
          <.render_agui_message
            message={message}
            activity_registry={@activity_registry}
            message_registry={@message_registry}
          />
        <% end %>
        <%= for {id, buffer} <- @streaming do %>
          <.agui_streaming_text id={id} content={buffer.content} role={buffer.role} />
        <% end %>
      </div>
      """
    end

    @doc false
    def render_agui_message(assigns) do
      ~H"""
      <div class={"agui-message agui-message--" <> to_string(@message.role)}>
        {render_message_with_registry(@message, @message_registry, @activity_registry)}
      </div>
      """
    end

    # ========================================
    # Standard component functions (for import)
    # ========================================

    @doc """
    Main chat container component.

    ## Attributes

    - `ui_state` - The AG-UI renderer state (required)
    - `class` - Additional CSS classes (default: "")
    - `show_status` - Whether to show run status (default: true)
    - `show_thinking` - Whether to show thinking indicator (default: true)

    ## Example

        <.agui_chat ui_state={@agui} />

    """
    attr :ui_state, :map, required: true
    attr :class, :string, default: ""
    attr :show_status, :boolean, default: true
    attr :show_thinking, :boolean, default: true

    def agui_chat(assigns) do
      ~H"""
      <div class={"agui-chat " <> @class}>
        <.agui_message_list
          messages={@ui_state.session.messages}
          streaming={@ui_state.streaming_messages}
        />
        <%= if @show_thinking and @ui_state.session.thinking.active do %>
          <.agui_thinking content={@ui_state.session.thinking.content} />
        <% end %>
        <%= if @show_status do %>
          <.agui_run_status status={@ui_state.run_status} steps={@ui_state.steps} />
        <% end %>
      </div>
      """
    end

    @doc """
    Message list component with streaming support.

    ## Attributes

    - `messages` - List of message structs (required)
    - `streaming` - Map of message_id => streaming buffer (default: %{})

    """
    attr :messages, :list, required: true
    attr :streaming, :map, default: %{}

    def agui_message_list(assigns) do
      ~H"""
      <div class="agui-message-list">
        <%= for message <- @messages do %>
          <.agui_message message={message} />
        <% end %>
        <%= for {id, buffer} <- @streaming do %>
          <.agui_streaming_text id={id} content={buffer.content} role={buffer.role} />
        <% end %>
      </div>
      """
    end

    @doc """
    Single message component with role-based rendering.

    ## Attributes

    - `message` - Message struct with :role and :content fields (required)

    """
    attr :message, :map, required: true

    def agui_message(assigns) do
      ~H"""
      <div class={"agui-message agui-message--" <> to_string(@message.role)}>
        <.render_message_content message={@message} />
      </div>
      """
    end

    @doc """
    Streaming text component with cursor indicator.

    ## Attributes

    - `id` - Unique identifier (required)
    - `content` - Current content (required)
    - `role` - Message role (default: :assistant)

    """
    attr :id, :string, required: true
    attr :content, :string, required: true
    attr :role, :atom, default: :assistant

    def agui_streaming_text(assigns) do
      ~H"""
      <div class={"agui-streaming-text agui-streaming-text--" <> to_string(@role)} id={@id}>
        <span class="agui-streaming-content">{@content}</span>
        <span class="agui-cursor">|</span>
      </div>
      """
    end

    @doc """
    Tool call display component.

    ## Attributes

    - `tool_call` - Tool call map with :name and :args fields (required)

    """
    attr :tool_call, :map, required: true

    def agui_tool_call(assigns) do
      ~H"""
      <div class="agui-tool-call">
        <div class="agui-tool-name">{@tool_call.function.name}</div>
        <pre class="agui-tool-args"><%= format_json(@tool_call.function.arguments) %></pre>
      </div>
      """
    end

    @doc """
    Run status indicator component.

    ## Attributes

    - `status` - Current run status (:idle, :running, :finished, {:error, msg}) (required)
    - `steps` - List of step structs (default: [])

    """
    attr :status, :any, required: true
    attr :steps, :list, default: []

    def agui_run_status(assigns) do
      ~H"""
      <div class={"agui-run-status agui-run-status--" <> status_class(@status)}>
        <span class="agui-status-indicator"></span>
        <span class="agui-status-label">{status_label(@status)}</span>
        <%= if @steps != [] do %>
          <div class="agui-steps">
            <%= for step <- @steps do %>
              <span class={"agui-step agui-step--" <> to_string(step.status)}>
                {step.name}
              </span>
            <% end %>
          </div>
        <% end %>
      </div>
      """
    end

    @doc """
    Thinking indicator component.

    ## Attributes

    - `content` - Current thinking content (default: "")
    - `label` - Label text (default: "Thinking...")

    """
    attr :content, :string, default: ""
    attr :label, :string, default: "Thinking..."

    def agui_thinking(assigns) do
      ~H"""
      <div class="agui-thinking">
        <div class="agui-thinking-label">{@label}</div>
        <%= if @content != "" do %>
          <div class="agui-thinking-content">{@content}</div>
        <% end %>
      </div>
      """
    end

    @doc """
    State debug view component.

    Shows the current shared state in a collapsible details element.

    ## Attributes

    - `state` - State map to display (required)

    """
    attr :state, :map, required: true

    def agui_state_debug(assigns) do
      ~H"""
      <details class="agui-state-debug">
        <summary>State</summary>
        <pre><%= format_json(@state) %></pre>
      </details>
      """
    end

    @doc """
    Streaming tool calls display component.

    ## Attributes

    - `tools` - Map of tool_call_id => tool buffer (required)

    """
    attr :tools, :map, required: true

    def agui_streaming_tools(assigns) do
      ~H"""
      <div class="agui-streaming-tools">
        <%= for {id, tool} <- @tools do %>
          <div class="agui-streaming-tool" id={id}>
            <div class="agui-tool-name">{tool.name}</div>
            <pre class="agui-tool-args"><%= tool.args %></pre>
          </div>
        <% end %>
      </div>
      """
    end

    # ========================================
    # Registry-based rendering helpers
    # ========================================

    defp render_message_with_registry(
           %{role: :activity} = msg,
           _message_registry,
           activity_registry
         ) do
      render_activity_with_registry(msg, activity_registry)
    end

    defp render_message_with_registry(%{role: role} = msg, message_registry, _activity_registry) do
      case Map.get(message_registry, role) do
        nil -> default_message_render(msg)
        component when is_function(component, 1) -> component.(msg)
      end
    end

    defp render_activity_with_registry(%{activity_type: type} = msg, activity_registry) do
      case Map.get(activity_registry, type) do
        nil -> default_activity_render(msg)
        component when is_function(component, 1) -> component.(msg)
      end
    end

    defp render_activity_with_registry(msg, _activity_registry) do
      default_activity_render(msg)
    end

    defp default_message_render(%{role: :user, content: content}) do
      assigns = %{content: content}

      ~H"""
      <div class="agui-user-content">{@content}</div>
      """
    end

    defp default_message_render(%{role: :assistant, tool_calls: tool_calls} = msg)
         when is_list(tool_calls) and tool_calls != [] do
      assigns = %{content: msg[:content], tool_calls: tool_calls}

      ~H"""
      <div class="agui-assistant-content">
        <%= if @content do %>
          {@content}
        <% end %>
        <%= for tc <- @tool_calls do %>
          <.agui_tool_call tool_call={tc} />
        <% end %>
      </div>
      """
    end

    defp default_message_render(%{role: :assistant, content: content}) do
      assigns = %{content: content}

      ~H"""
      <div class="agui-assistant-content">{@content}</div>
      """
    end

    defp default_message_render(%{role: :tool, content: content}) do
      assigns = %{content: content}

      ~H"""
      <pre class="agui-tool-content"><%= @content %></pre>
      """
    end

    defp default_message_render(%{role: :system, content: content}) do
      assigns = %{content: content}

      ~H"""
      <div class="agui-system-content">{@content}</div>
      """
    end

    defp default_message_render(%{role: :developer, content: content}) do
      assigns = %{content: content}

      ~H"""
      <div class="agui-developer-content">{@content}</div>
      """
    end

    defp default_message_render(msg) do
      assigns = %{msg: msg}

      ~H"""
      <div class="agui-unknown-content">{inspect(@msg)}</div>
      """
    end

    defp default_activity_render(%{activity_type: type, content: content}) do
      assigns = %{type: type, content: content}

      ~H"""
      <div class="agui-activity">
        <div class="agui-activity-type">{@type}</div>
        <pre class="agui-activity-content"><%= format_json(@content) %></pre>
      </div>
      """
    end

    defp default_activity_render(msg) do
      assigns = %{msg: msg}

      ~H"""
      <div class="agui-activity">
        <pre class="agui-activity-content"><%= inspect(@msg) %></pre>
      </div>
      """
    end

    # ========================================
    # Default render_message_content (for import)
    # ========================================

    attr :message, :map, required: true

    defp render_message_content(%{message: %{role: :user}} = assigns) do
      ~H"""
      <div class="agui-user-content">{@message.content}</div>
      """
    end

    defp render_message_content(%{message: %{role: :assistant, tool_calls: tool_calls}} = assigns)
         when is_list(tool_calls) and tool_calls != [] do
      ~H"""
      <div class="agui-assistant-content">
        <%= if @message.content do %>
          {@message.content}
        <% end %>
        <%= for tc <- @message.tool_calls do %>
          <.agui_tool_call tool_call={tc} />
        <% end %>
      </div>
      """
    end

    defp render_message_content(%{message: %{role: :assistant}} = assigns) do
      ~H"""
      <div class="agui-assistant-content">{@message.content}</div>
      """
    end

    defp render_message_content(%{message: %{role: :tool}} = assigns) do
      ~H"""
      <pre class="agui-tool-content"><%= @message.content %></pre>
      """
    end

    defp render_message_content(%{message: %{role: :system}} = assigns) do
      ~H"""
      <div class="agui-system-content">{@message.content}</div>
      """
    end

    defp render_message_content(%{message: %{role: :developer}} = assigns) do
      ~H"""
      <div class="agui-developer-content">{@message.content}</div>
      """
    end

    defp render_message_content(%{message: %{role: :activity}} = assigns) do
      ~H"""
      <div class="agui-activity">
        <div class="agui-activity-type">{@message[:activity_type]}</div>
        <pre class="agui-activity-content"><%= format_json(@message[:content]) %></pre>
      </div>
      """
    end

    defp render_message_content(assigns) do
      ~H"""
      <div class="agui-unknown-content">{inspect(@message)}</div>
      """
    end

    # ========================================
    # Helpers
    # ========================================

    defp status_class(:idle), do: "idle"
    defp status_class(:running), do: "running"
    defp status_class(:finished), do: "finished"
    defp status_class({:error, _}), do: "error"

    defp status_label(:idle), do: "Ready"
    defp status_label(:running), do: "Running..."
    defp status_label(:finished), do: "Complete"
    defp status_label({:error, msg}), do: "Error: #{msg}"

    defp format_json(data) when is_binary(data) do
      case Jason.decode(data) do
        {:ok, json} -> Jason.encode!(json, pretty: true)
        _ -> data
      end
    end

    defp format_json(data) when is_map(data) do
      Jason.encode!(data, pretty: true)
    end

    defp format_json(other), do: inspect(other)
  end
end
