using System;
using System.Collections.Generic;
using System.Text.Json;
using AGUI.Abstractions;
using Google.Protobuf.WellKnownTypes;
using Proto = AGUI.ProtocolBuffers;

namespace AGUI.Protobuf;

// Maps the AG-UI .NET message/content/tool-call/interrupt/json-patch model to and from the
// generated protobuf messages. The reshaping rules mirror sdks/typescript/packages/proto/src/proto.ts
// verbatim so the wire format stays byte-compatible with @ag-ui/proto.
internal static class ProtoMessageMapper
{
    public static Proto.Message ToProto(AGUIMessage message)
    {
        var proto = new Proto.Message
        {
            Id = message.Id ?? string.Empty,
            Role = message.Role,
            Metadata = ProtoValueConverter.ToStructOrNull(message.Metadata),
        };

        // Set once from the base rather than per role: attribution applies to every
        // message kind, and a MESSAGES_SNAPSHOT mixes the parent's messages with those of
        // every subagent that ran, so losing it on one role would silently reparent that
        // role's messages to the parent.
        if (message.SubagentRunId is not null)
        {
            proto.SubagentRunId = message.SubagentRunId;
        }

        switch (message)
        {
            case AGUIUserMessage user:
                if (user.Name is not null)
                {
                    proto.Name = user.Name;
                }

                if (user.Content.Value is IList<AGUIInputContent> parts)
                {
                    foreach (var part in parts)
                    {
                        var protoPart = ToProtoContentPart(part);
                        if (protoPart is not null)
                        {
                            proto.ContentParts.Add(protoPart);
                        }
                    }
                }
                else if (user.Content.Value is string text)
                {
                    proto.Content = text;
                }
                else
                {
                    proto.Content = string.Empty;
                }

                break;
            case AGUIAssistantMessage assistant:
                if (assistant.Content is not null)
                {
                    proto.Content = assistant.Content;
                }

                if (assistant.Name is not null)
                {
                    proto.Name = assistant.Name;
                }

                if (assistant.ToolCalls is not null)
                {
                    foreach (var toolCall in assistant.ToolCalls)
                    {
                        proto.ToolCalls.Add(ToProtoToolCall(toolCall));
                    }
                }

                break;
            case AGUISystemMessage system:
                proto.Content = system.Content;
                if (system.Name is not null)
                {
                    proto.Name = system.Name;
                }

                break;
            case AGUIDeveloperMessage developer:
                proto.Content = developer.Content;
                if (developer.Name is not null)
                {
                    proto.Name = developer.Name;
                }

                break;
            case AGUIToolMessage tool:
                proto.Content = tool.Content;
                proto.ToolCallId = tool.ToolCallId;
                if (tool.Error is not null)
                {
                    proto.Error = tool.Error;
                }

                break;
            default:
                throw new NotSupportedException(
                    $"Message role '{message.Role}' is not supported by the AG-UI protobuf wire format.");
        }

        return proto;
    }

    public static AGUIMessage FromProto(Proto.Message proto)
    {
        // Applied here rather than inside each role branch below: the branches return
        // six different concrete types, so a per-branch assignment is six chances to
        // forget one and silently reparent that role's messages to the parent.
        var message = FromProtoCore(proto);
        if (proto.HasSubagentRunId)
        {
            message.SubagentRunId = proto.SubagentRunId;
        }

        message.Metadata = ProtoValueConverter.StructToJsonElementOrNull(proto.Metadata);
        return message;
    }

    private static AGUIMessage FromProtoCore(Proto.Message proto)
    {
        var id = string.IsNullOrEmpty(proto.Id) ? null : proto.Id;

        switch (proto.Role)
        {
            case AGUIRoles.User:
            {
                var user = new AGUIUserMessage
                {
                    Id = id,
                    Name = proto.HasName ? proto.Name : null,
                };

                if (proto.ContentParts.Count > 0)
                {
                    var parts = new List<AGUIInputContent>();
                    foreach (var protoPart in proto.ContentParts)
                    {
                        var part = FromProtoContentPart(protoPart);
                        if (part is not null)
                        {
                            parts.Add(part);
                        }
                    }

                    if (parts.Count > 0)
                    {
                        user.Content = parts;
                    }
                    else
                    {
                        user.Content = proto.HasContent ? proto.Content : string.Empty;
                    }
                }
                else
                {
                    user.Content = proto.HasContent ? proto.Content : string.Empty;
                }

                return user;
            }
            case AGUIRoles.Assistant:
            {
                var assistant = new AGUIAssistantMessage
                {
                    Id = id,
                    Content = proto.HasContent ? proto.Content : null,
                    Name = proto.HasName ? proto.Name : null,
                };

                if (proto.ToolCalls.Count > 0)
                {
                    var toolCalls = new List<AGUIToolCall>();
                    foreach (var protoToolCall in proto.ToolCalls)
                    {
                        toolCalls.Add(FromProtoToolCall(protoToolCall));
                    }

                    assistant.ToolCalls = toolCalls;
                }

                return assistant;
            }
            case AGUIRoles.System:
                return new AGUISystemMessage
                {
                    Id = id,
                    Content = proto.HasContent ? proto.Content : string.Empty,
                    Name = proto.HasName ? proto.Name : null,
                };
            case AGUIRoles.Developer:
                return new AGUIDeveloperMessage
                {
                    Id = id,
                    Content = proto.HasContent ? proto.Content : string.Empty,
                    Name = proto.HasName ? proto.Name : null,
                };
            case AGUIRoles.Tool:
                return new AGUIToolMessage
                {
                    Id = id,
                    Content = proto.HasContent ? proto.Content : string.Empty,
                    ToolCallId = proto.HasToolCallId ? proto.ToolCallId : string.Empty,
                    Error = proto.HasError ? proto.Error : null,
                };
            default:
                throw new NotSupportedException(
                    $"Message role '{proto.Role}' is not supported by the AG-UI protobuf wire format.");
        }
    }

    public static Proto.ToolCall ToProtoToolCall(AGUIToolCall toolCall)
    {
        return new Proto.ToolCall
        {
            Id = toolCall.Id,
            Type = toolCall.Type,
            Metadata = ProtoValueConverter.ToStructOrNull(toolCall.Metadata),
            Function = new Proto.ToolCall.Types.Function
            {
                Name = toolCall.Function.Name,
                Arguments = toolCall.Function.Arguments,
            },
        };
    }

    public static AGUIToolCall FromProtoToolCall(Proto.ToolCall proto)
    {
        return new AGUIToolCall
        {
            Id = proto.Id,
            Type = proto.Type,
            Function = new AGUIToolCallFunction
            {
                Name = proto.Function?.Name ?? string.Empty,
                Arguments = proto.Function?.Arguments ?? string.Empty,
            },
            Metadata = ProtoValueConverter.StructToJsonElementOrNull(proto.Metadata),
        };
    }

    public static Proto.Interrupt ToProtoInterrupt(AGUIInterrupt interrupt)
    {
        var proto = new Proto.Interrupt
        {
            Id = interrupt.Id,
            Reason = interrupt.Reason,
        };

        if (interrupt.Message is not null)
        {
            proto.Message = interrupt.Message;
        }

        if (interrupt.ToolCallId is not null)
        {
            proto.ToolCallId = interrupt.ToolCallId;
        }

        if (interrupt.ResponseSchema is not null)
        {
            proto.ResponseSchema = ProtoValueConverter.ToValue(interrupt.ResponseSchema.Value);
        }

        if (interrupt.ExpiresAt is not null)
        {
            proto.ExpiresAt = interrupt.ExpiresAt;
        }

        if (interrupt.Metadata is not null)
        {
            proto.Metadata = ProtoValueConverter.ToValue(interrupt.Metadata.Value);
        }

        if (interrupt.SubagentRunId is not null)
        {
            proto.SubagentRunId = interrupt.SubagentRunId;
        }

        return proto;
    }

    public static AGUIInterrupt FromProtoInterrupt(Proto.Interrupt proto)
    {
        return new AGUIInterrupt
        {
            Id = proto.Id,
            Reason = proto.Reason,
            Message = proto.HasMessage ? proto.Message : null,
            ToolCallId = proto.HasToolCallId ? proto.ToolCallId : null,
            ResponseSchema = ProtoValueConverter.ToJsonElementOrNull(proto.ResponseSchema),
            ExpiresAt = proto.HasExpiresAt ? proto.ExpiresAt : null,
            Metadata = ProtoValueConverter.ToJsonElementOrNull(proto.Metadata),
            SubagentRunId = proto.HasSubagentRunId ? proto.SubagentRunId : null,
        };
    }

    public static Proto.JsonPatchOperation ToProtoPatchOperation(JsonElement operation)
    {
        var proto = new Proto.JsonPatchOperation
        {
            Op = ParseOperationType(GetStringProperty(operation, "op")),
            Path = GetStringProperty(operation, "path") ?? string.Empty,
        };

        if (operation.TryGetProperty("from", out var from) && from.ValueKind == JsonValueKind.String)
        {
            proto.From = from.GetString() ?? string.Empty;
        }

        if (operation.TryGetProperty("value", out var value) && value.ValueKind != JsonValueKind.Undefined)
        {
            proto.Value = ProtoValueConverter.ToValue(value);
        }

        return proto;
    }

    public static void WriteProtoPatchOperation(Utf8JsonWriter writer, Proto.JsonPatchOperation proto)
    {
        writer.WriteStartObject();
        writer.WriteString("op", OperationTypeToString(proto.Op));
        writer.WriteString("path", proto.Path);

        if (proto.HasFrom)
        {
            writer.WriteString("from", proto.From);
        }

        if (proto.Value is not null)
        {
            writer.WritePropertyName("value");
            ProtoValueConverter.WriteValue(writer, proto.Value);
        }

        writer.WriteEndObject();
    }

    private static Proto.InputContent? ToProtoContentPart(AGUIInputContent part)
    {
        switch (part)
        {
            case AGUITextInputContent text:
                return new Proto.InputContent
                {
                    Text = new Proto.TextInputPart { Text = text.Text },
                };
            case AGUIImageInputContent image:
                return new Proto.InputContent
                {
                    Image = new Proto.ImageInputPart
                    {
                        Source = ToProtoSource(image.Source),
                        Metadata = ProtoValueConverter.ToValueOrNull(image.Metadata),
                    },
                };
            case AGUIAudioInputContent audio:
                return new Proto.InputContent
                {
                    Audio = new Proto.AudioInputPart
                    {
                        Source = ToProtoSource(audio.Source),
                        Metadata = ProtoValueConverter.ToValueOrNull(audio.Metadata),
                    },
                };
            case AGUIVideoInputContent video:
                return new Proto.InputContent
                {
                    Video = new Proto.VideoInputPart
                    {
                        Source = ToProtoSource(video.Source),
                        Metadata = ProtoValueConverter.ToValueOrNull(video.Metadata),
                    },
                };
            case AGUIDocumentInputContent document:
                return new Proto.InputContent
                {
                    Document = new Proto.DocumentInputPart
                    {
                        Source = ToProtoSource(document.Source),
                        Metadata = ProtoValueConverter.ToValueOrNull(document.Metadata),
                    },
                };
            case AGUIBinaryInputContent binary:
            {
                var source = ToProtoBinarySource(binary);
                if (source is null)
                {
                    return null;
                }

                return new Proto.InputContent
                {
                    Document = new Proto.DocumentInputPart
                    {
                        Source = source,
                        Metadata = BuildBinaryMetadata(binary),
                    },
                };
            }
            default:
                return null;
        }
    }

    private static AGUIInputContent? FromProtoContentPart(Proto.InputContent proto)
    {
        switch (proto.PartCase)
        {
            case Proto.InputContent.PartOneofCase.Text:
                return new AGUITextInputContent { Text = proto.Text.Text };
            case Proto.InputContent.PartOneofCase.Image:
                return new AGUIImageInputContent
                {
                    Source = FromProtoSource(proto.Image.Source)!,
                    Metadata = ProtoValueConverter.ToJsonElementOrNull(proto.Image.Metadata),
                };
            case Proto.InputContent.PartOneofCase.Audio:
                return new AGUIAudioInputContent
                {
                    Source = FromProtoSource(proto.Audio.Source)!,
                    Metadata = ProtoValueConverter.ToJsonElementOrNull(proto.Audio.Metadata),
                };
            case Proto.InputContent.PartOneofCase.Video:
                return new AGUIVideoInputContent
                {
                    Source = FromProtoSource(proto.Video.Source)!,
                    Metadata = ProtoValueConverter.ToJsonElementOrNull(proto.Video.Metadata),
                };
            case Proto.InputContent.PartOneofCase.Document:
                return new AGUIDocumentInputContent
                {
                    Source = FromProtoSource(proto.Document.Source)!,
                    Metadata = ProtoValueConverter.ToJsonElementOrNull(proto.Document.Metadata),
                };
            case Proto.InputContent.PartOneofCase.None:
            default:
                return null;
        }
    }

    private static Proto.InputContentSource ToProtoSource(AGUIInputContentSource source)
    {
        switch (source)
        {
            case AGUIInputContentDataSource data:
                return new Proto.InputContentSource
                {
                    Data = new Proto.InputContentDataSource
                    {
                        Value = data.Value,
                        MimeType = data.MimeType,
                    },
                };
            case AGUIInputContentUrlSource url:
            {
                var urlSource = new Proto.InputContentUrlSource { Value = url.Value };
                if (url.MimeType is not null)
                {
                    urlSource.MimeType = url.MimeType;
                }

                return new Proto.InputContentSource { Url = urlSource };
            }
            default:
                throw new NotSupportedException(
                    $"Input content source type '{source.Type}' is not supported by the AG-UI protobuf wire format.");
        }
    }

    private static AGUIInputContentSource? FromProtoSource(Proto.InputContentSource? source)
    {
        if (source is null)
        {
            return null;
        }

        switch (source.SourceCase)
        {
            case Proto.InputContentSource.SourceOneofCase.Data:
                return new AGUIInputContentDataSource
                {
                    Value = source.Data.Value,
                    MimeType = source.Data.MimeType,
                };
            case Proto.InputContentSource.SourceOneofCase.Url:
                return new AGUIInputContentUrlSource
                {
                    Value = source.Url.Value,
                    MimeType = source.Url.HasMimeType ? source.Url.MimeType : null,
                };
            case Proto.InputContentSource.SourceOneofCase.None:
            default:
                return null;
        }
    }

    private static Proto.InputContentSource? ToProtoBinarySource(AGUIBinaryInputContent binary)
    {
        if (binary.Data is not null)
        {
            return new Proto.InputContentSource
            {
                Data = new Proto.InputContentDataSource { Value = binary.Data, MimeType = binary.MimeType },
            };
        }

        if (binary.Url is not null)
        {
            return new Proto.InputContentSource
            {
                Url = new Proto.InputContentUrlSource { Value = binary.Url, MimeType = binary.MimeType },
            };
        }

        if (binary.Id is not null)
        {
            return new Proto.InputContentSource
            {
                Url = new Proto.InputContentUrlSource { Value = binary.Id, MimeType = binary.MimeType },
            };
        }

        return null;
    }

    private static Value BuildBinaryMetadata(AGUIBinaryInputContent binary)
    {
        // Mirrors proto.ts: legacy binary parts are encoded as a document whose metadata
        // carries the { legacyBinary, filename, id } object so the original shape can be
        // recovered by consumers that understand the flag.
        //
        // A field with no value is left out of the struct rather than written as
        // NullValue — proto.ts hands `undefined` to Struct.wrap, and ts-proto's encoder
        // skips undefined entries. Writing NullValue here would put a `null` on the binary
        // wire that no TypeScript producer emits.
        var metadata = new Struct();
        metadata.Fields["legacyBinary"] = new Value { BoolValue = true };

        if (binary.Filename is not null)
        {
            metadata.Fields["filename"] = new Value { StringValue = binary.Filename };
        }

        if (binary.Id is not null)
        {
            metadata.Fields["id"] = new Value { StringValue = binary.Id };
        }

        return new Value { StructValue = metadata };
    }

    private static Proto.JsonPatchOperationType ParseOperationType(string? op)
    {
        switch (op)
        {
            case "add":
                return Proto.JsonPatchOperationType.Add;
            case "remove":
                return Proto.JsonPatchOperationType.Remove;
            case "replace":
                return Proto.JsonPatchOperationType.Replace;
            case "move":
                return Proto.JsonPatchOperationType.Move;
            case "copy":
                return Proto.JsonPatchOperationType.Copy;
            case "test":
                return Proto.JsonPatchOperationType.Test;
            default:
                throw new NotSupportedException(
                    $"JSON Patch operation '{op}' is not supported by the AG-UI protobuf wire format.");
        }
    }

    private static string OperationTypeToString(Proto.JsonPatchOperationType op)
    {
        switch (op)
        {
            case Proto.JsonPatchOperationType.Add:
                return "add";
            case Proto.JsonPatchOperationType.Remove:
                return "remove";
            case Proto.JsonPatchOperationType.Replace:
                return "replace";
            case Proto.JsonPatchOperationType.Move:
                return "move";
            case Proto.JsonPatchOperationType.Copy:
                return "copy";
            case Proto.JsonPatchOperationType.Test:
                return "test";
            default:
                throw new NotSupportedException(
                    $"JSON Patch operation '{op}' is not supported by the AG-UI protobuf wire format.");
        }
    }

    private static string? GetStringProperty(JsonElement element, string name)
    {
        if (element.ValueKind == JsonValueKind.Object &&
            element.TryGetProperty(name, out var value) &&
            value.ValueKind == JsonValueKind.String)
        {
            return value.GetString();
        }

        return null;
    }
}
