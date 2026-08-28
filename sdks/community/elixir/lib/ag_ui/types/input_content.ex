defmodule AgUI.Types.InputContent.Text do
  @moduledoc """
  Text content for user messages.
  """

  @type t :: %__MODULE__{
          type: :text,
          text: String.t()
        }

  @enforce_keys [:text]
  defstruct [:text, type: :text]

  @doc """
  Creates Text content from a wire format map.
  """
  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(%{"text" => text}) when is_binary(text) do
    {:ok, %__MODULE__{type: :text, text: text}}
  end

  def from_map(%{"text" => _}) do
    {:error, :invalid_text_type}
  end

  def from_map(_) do
    {:error, :missing_text}
  end

  @doc """
  Converts Text content to wire format map.
  """
  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{text: text}) do
    %{"type" => "text", "text" => text}
  end
end

defmodule AgUI.Types.InputContent.Binary do
  @moduledoc """
  Binary content for user messages (images, audio, files).

  Must include at least one of: `id`, `url`, or `data`.

  ## Wire Format

      {
        "type": "binary",
        "mimeType": "image/png",
        "url": "https://example.com/image.png",
        "filename": "screenshot.png"
      }

  """

  @type t :: %__MODULE__{
          type: :binary,
          mime_type: String.t(),
          id: String.t() | nil,
          url: String.t() | nil,
          data: String.t() | nil,
          filename: String.t() | nil
        }

  @enforce_keys [:mime_type]
  defstruct [:mime_type, :id, :url, :data, :filename, type: :binary]

  @doc """
  Creates Binary content from a wire format map.

  Validates that at least one payload field (id, url, data) is present.
  """
  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(%{"mimeType" => mime_type} = map) when is_binary(mime_type) do
    content = %__MODULE__{
      type: :binary,
      mime_type: mime_type,
      id: map["id"],
      url: map["url"],
      data: map["data"],
      filename: map["filename"]
    }

    # Validate: at least one payload field required
    if is_nil(content.id) and is_nil(content.url) and is_nil(content.data) do
      {:error, :missing_payload}
    else
      {:ok, content}
    end
  end

  def from_map(%{"mimeType" => _}) do
    {:error, :invalid_mime_type}
  end

  def from_map(_) do
    {:error, :missing_mime_type}
  end

  @doc """
  Converts Binary content to wire format map.
  """
  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = content) do
    %{
      "type" => "binary",
      "mimeType" => content.mime_type,
      "id" => content.id,
      "url" => content.url,
      "data" => content.data,
      "filename" => content.filename
    }
    |> AgUI.Types.compact_map()
  end
end

defmodule AgUI.Types.InputContent do
  @moduledoc """
  Content types for user messages supporting multimodal input.

  User messages can contain either plain text or binary content
  (images, audio, files). This module provides types for both.

  ## Text Content

      %AgUI.Types.InputContent.Text{
        type: :text,
        text: "Hello, how are you?"
      }

  ## Binary Content

      %AgUI.Types.InputContent.Binary{
        type: :binary,
        mime_type: "image/png",
        url: "https://example.com/image.png"
      }

  Binary content must include at least one of: `id`, `url`, or `data`.
  """

  alias __MODULE__.{Text, Binary}

  @type t :: Text.t() | Binary.t()

  @doc """
  Creates an InputContent from a wire format map.

  Dispatches to Text or Binary based on the "type" field.
  """
  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(%{"type" => "text"} = map), do: Text.from_map(map)
  def from_map(%{"type" => "binary"} = map), do: Binary.from_map(map)

  def from_map(%{"type" => type}) when is_binary(type) do
    {:error, {:unknown_content_type, type}}
  end

  def from_map(%{"text" => _} = map) do
    # Legacy format without explicit type
    Text.from_map(Map.put(map, "type", "text"))
  end

  def from_map(_) do
    {:error, :missing_type}
  end

  @doc """
  Converts an InputContent to wire format map.
  """
  @spec to_map(t()) :: map()
  def to_map(%Text{} = content), do: Text.to_map(content)
  def to_map(%Binary{} = content), do: Binary.to_map(content)
end
