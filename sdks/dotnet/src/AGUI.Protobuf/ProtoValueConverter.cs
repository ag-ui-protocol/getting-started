using System;
using System.Text.Json;
using Google.Protobuf.WellKnownTypes;
namespace AGUI.Protobuf;

// Bridges System.Text.Json's JsonElement and protobuf's google.protobuf.Value
// (Struct/ListValue/Value well-known types). This is hand-written and uses ONLY the
// generated well-known types so it stays Native-AOT/trim safe; it never touches the
// reflection-based JsonFormatter/JsonParser or descriptor reflection APIs.
//
// Number precision caveat: google.protobuf.Value models every number as an IEEE-754
// double. Numeric JSON values that do not fit exactly in a double (large long/decimal
// values beyond 2^53) lose precision on the round-trip. This mirrors the behavior of the
// JavaScript @ag-ui/proto implementation, which has the same double-only limitation.
internal static class ProtoValueConverter
{
    public static Value ToValue(JsonElement element)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
            {
                var structValue = new Struct();
                foreach (var property in element.EnumerateObject())
                {
                    structValue.Fields[property.Name] = ToValue(property.Value);
                }

                return new Value { StructValue = structValue };
            }
            case JsonValueKind.Array:
            {
                var listValue = new ListValue();
                foreach (var item in element.EnumerateArray())
                {
                    listValue.Values.Add(ToValue(item));
                }

                return new Value { ListValue = listValue };
            }
            case JsonValueKind.String:
                return new Value { StringValue = element.GetString() ?? string.Empty };
            case JsonValueKind.Number:
                return new Value { NumberValue = element.GetDouble() };
            case JsonValueKind.True:
                return new Value { BoolValue = true };
            case JsonValueKind.False:
                return new Value { BoolValue = false };
            case JsonValueKind.Null:
            case JsonValueKind.Undefined:
            default:
                return new Value { NullValue = NullValue.NullValue };
        }
    }

    public static Value? ToValueOrNull(JsonElement? element)
    {
        if (element is null)
        {
            return null;
        }

        return ToValue(element.Value);
    }

    public static JsonElement ToJsonElement(Value value)
    {
        return JsonElementFactory.Create(writer => WriteValue(writer, value));
    }

    public static JsonElement? ToJsonElementOrNull(Value? value)
    {
        if (value is null)
        {
            return null;
        }

        return ToJsonElement(value);
    }

    /// <summary>
    /// Converts a metadata object to the protobuf <c>Struct</c> the wire format
    /// declares for it.
    /// </summary>
    /// <remarks>
    /// An absent object, and a <see cref="JsonValueKind.Null"/> standing in for
    /// one, both map to null — the same null-as-absent rule the TypeScript and
    /// Python schemas apply.
    ///
    /// Anything else is a protocol violation: metadata is an object, and the
    /// TypeScript and Python schemas reject a non-object at the parse boundary.
    /// .NET types it as <see cref="JsonElement"/> and so cannot, but silently
    /// dropping it here would make the value survive JSON and vanish over
    /// protobuf — transport-dependent data loss. Fail loudly instead, the way
    /// <c>ProtoEventMapper</c> already does for events the wire format cannot
    /// represent.
    /// </remarks>
    /// <exception cref="NotSupportedException">
    /// The metadata is present and is neither an object nor null.
    /// </exception>
    public static Struct? ToStructOrNull(JsonElement? element)
    {
        if (element is not { } value
            || value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
        {
            return null;
        }

        if (value.ValueKind is not JsonValueKind.Object)
        {
            throw new NotSupportedException(
                $"Metadata must be a JSON object, but was '{value.ValueKind}'. "
                + "An absent or null metadata object is allowed; any other value is not "
                + "representable in the AG-UI protobuf wire format.");
        }

        return ToValue(value).StructValue;
    }

    /// <summary>
    /// Converts a protobuf <c>Struct</c> back to a metadata object, or null
    /// when the field was absent.
    /// </summary>
    public static JsonElement? StructToJsonElementOrNull(Struct? structValue)
    {
        if (structValue is null)
        {
            return null;
        }

        return ToJsonElement(new Value { StructValue = structValue });
    }

    public static void WriteValue(Utf8JsonWriter writer, Value value)
    {
        switch (value.KindCase)
        {
            case Value.KindOneofCase.StructValue:
                writer.WriteStartObject();
                foreach (var field in value.StructValue.Fields)
                {
                    writer.WritePropertyName(field.Key);
                    WriteValue(writer, field.Value);
                }

                writer.WriteEndObject();
                break;
            case Value.KindOneofCase.ListValue:
                writer.WriteStartArray();
                foreach (var item in value.ListValue.Values)
                {
                    WriteValue(writer, item);
                }

                writer.WriteEndArray();
                break;
            case Value.KindOneofCase.StringValue:
                writer.WriteStringValue(value.StringValue);
                break;
            case Value.KindOneofCase.NumberValue:
                writer.WriteNumberValue(value.NumberValue);
                break;
            case Value.KindOneofCase.BoolValue:
                writer.WriteBooleanValue(value.BoolValue);
                break;
            case Value.KindOneofCase.NullValue:
            case Value.KindOneofCase.None:
            default:
                writer.WriteNullValue();
                break;
        }
    }
}
