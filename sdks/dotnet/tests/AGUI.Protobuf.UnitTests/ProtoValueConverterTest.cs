using System.Text.Json;
using AGUI.Abstractions;
using Google.Protobuf.WellKnownTypes;
using Xunit;

namespace AGUI.Protobuf.UnitTests;

public sealed class ProtoValueConverterTest
{
    [Fact]
    public void String_RoundTrips()
    {
        var element = JsonTestHelpers.Parse("\"hello\"");
        var value = ProtoValueConverter.ToValue(element);

        Assert.Equal(Value.KindOneofCase.StringValue, value.KindCase);
        Assert.Equal("hello", value.StringValue);
        JsonTestHelpers.AssertEqual(element, ProtoValueConverter.ToJsonElement(value));
    }

    [Fact]
    public void Number_RoundTrips()
    {
        var element = JsonTestHelpers.Parse("42.5");
        var value = ProtoValueConverter.ToValue(element);

        Assert.Equal(Value.KindOneofCase.NumberValue, value.KindCase);
        Assert.Equal(42.5, value.NumberValue);
        JsonTestHelpers.AssertEqual(element, ProtoValueConverter.ToJsonElement(value));
    }

    [Fact]
    public void IntegerNumber_RoundTrips()
    {
        var element = JsonTestHelpers.Parse("42");
        var value = ProtoValueConverter.ToValue(element);

        Assert.Equal(42d, value.NumberValue);
        JsonTestHelpers.AssertEqual(element, ProtoValueConverter.ToJsonElement(value));
    }

    [Theory]
    [InlineData("true", true)]
    [InlineData("false", false)]
    public void Bool_RoundTrips(string json, bool expected)
    {
        var element = JsonTestHelpers.Parse(json);
        var value = ProtoValueConverter.ToValue(element);

        Assert.Equal(Value.KindOneofCase.BoolValue, value.KindCase);
        Assert.Equal(expected, value.BoolValue);
        JsonTestHelpers.AssertEqual(element, ProtoValueConverter.ToJsonElement(value));
    }

    [Fact]
    public void Null_RoundTrips()
    {
        var element = JsonTestHelpers.Parse("null");
        var value = ProtoValueConverter.ToValue(element);

        Assert.Equal(Value.KindOneofCase.NullValue, value.KindCase);
        Assert.Equal(JsonValueKind.Null, ProtoValueConverter.ToJsonElement(value).ValueKind);
    }

    [Fact]
    public void Object_RoundTrips()
    {
        var element = JsonTestHelpers.Parse("{\"a\":1,\"b\":\"x\",\"c\":true,\"d\":null}");
        var value = ProtoValueConverter.ToValue(element);

        Assert.Equal(Value.KindOneofCase.StructValue, value.KindCase);
        JsonTestHelpers.AssertEqual(element, ProtoValueConverter.ToJsonElement(value));
    }

    [Fact]
    public void Array_RoundTrips()
    {
        var element = JsonTestHelpers.Parse("[1,\"two\",false,null]");
        var value = ProtoValueConverter.ToValue(element);

        Assert.Equal(Value.KindOneofCase.ListValue, value.KindCase);
        JsonTestHelpers.AssertEqual(element, ProtoValueConverter.ToJsonElement(value));
    }

    [Fact]
    public void NestedStructure_RoundTrips()
    {
        var element = JsonTestHelpers.Parse(
            "{\"items\":[{\"id\":1,\"tags\":[\"a\",\"b\"]},{\"id\":2,\"nested\":{\"deep\":[true,null,3.14]}}],\"count\":2}");
        var value = ProtoValueConverter.ToValue(element);

        JsonTestHelpers.AssertEqual(element, ProtoValueConverter.ToJsonElement(value));
    }

    [Fact]
    public void ToValueOrNull_ReturnsNullForNull()
    {
        Assert.Null(ProtoValueConverter.ToValueOrNull(null));
    }

    [Fact]
    public void ToJsonElementOrNull_ReturnsNullForNull()
    {
        Assert.Null(ProtoValueConverter.ToJsonElementOrNull(null));
    }
}
