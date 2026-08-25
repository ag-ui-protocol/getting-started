using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class BaseEventJsonConverterTest
{
    [Fact]
    public void PolymorphicDeserialization_RunStartedEvent()
    {
        var original = new RunStartedEvent
        {
            ThreadId = "t1",
            RunId = "r1"
        };

        var json = JsonSerializer.Serialize<BaseEvent>(original, AGUIJsonSerializerContext.Default.BaseEvent);
        using var doc = JsonDocument.Parse(json);
        Assert.Equal("RUN_STARTED", doc.RootElement.GetProperty("type").GetString());

        var deserialized = JsonSerializer.Deserialize<BaseEvent>(json, AGUIJsonSerializerContext.Default.BaseEvent);
        Assert.NotNull(deserialized);
        var typed = Assert.IsType<RunStartedEvent>(deserialized);
        Assert.Equal("t1", typed.ThreadId);
        Assert.Equal("r1", typed.RunId);
    }

    [Fact]
    public void PolymorphicDeserialization_RunFinishedEvent()
    {
        var original = new RunFinishedEvent
        {
            ThreadId = "t1",
            Outcome = new RunFinishedSuccessOutcome()
        };

        var json = JsonSerializer.Serialize<BaseEvent>(original, AGUIJsonSerializerContext.Default.BaseEvent);
        var deserialized = JsonSerializer.Deserialize<BaseEvent>(json, AGUIJsonSerializerContext.Default.BaseEvent);

        Assert.NotNull(deserialized);
        var typed = Assert.IsType<RunFinishedEvent>(deserialized);
        Assert.Equal("t1", typed.ThreadId);
        Assert.IsType<RunFinishedSuccessOutcome>(typed.Outcome);
    }

    [Fact]
    public void PolymorphicDeserialization_RunErrorEvent()
    {
        var original = new RunErrorEvent
        {
            Message = "fail",
            Code = "E1"
        };

        var json = JsonSerializer.Serialize<BaseEvent>(original, AGUIJsonSerializerContext.Default.BaseEvent);
        var deserialized = JsonSerializer.Deserialize<BaseEvent>(json, AGUIJsonSerializerContext.Default.BaseEvent);

        Assert.NotNull(deserialized);
        var typed = Assert.IsType<RunErrorEvent>(deserialized);
        Assert.Equal("fail", typed.Message);
        Assert.Equal("E1", typed.Code);
    }

    [Fact]
    public void Deserialization_ThrowsForUnknownType()
    {
        var json = """{"type":"UNKNOWN_TYPE"}""";
        var exception = Assert.Throws<AGUIUnknownEventTypeException>(() =>
            JsonSerializer.Deserialize<BaseEvent>(json, AGUIJsonSerializerContext.Default.BaseEvent));
        Assert.Equal("UNKNOWN_TYPE", exception.EventType);
    }

    // value is required and null is one of the values it may take, so a CUSTOM
    // event carrying an explicit null must still carry the key when it is written
    // back out: dropping it would produce an event missing a required field.
    [Fact]
    public void Serialization_KeepsAnExplicitNullRequiredValue()
    {
        var json = """{"type":"CUSTOM","name":"app.thing","value":null}""";
        var decoded = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.BaseEvent);
        var custom = Assert.IsType<CustomEvent>(decoded);
        Assert.Null(custom.Value);
        Assert.Equal(json, JsonSerializer.Serialize(custom, AGUIJsonSerializerContext.Default.BaseEvent));
    }

    // role is optional and its value set has no empty member, so an event that
    // never set one must not write an empty string a strict peer would reject.
    [Fact]
    public void Serialization_OmitsAnUnsetOptionalRole()
    {
        var json = JsonSerializer.Serialize(
            new TextMessageStartEvent { MessageId = "m1" },
            AGUIJsonSerializerContext.Default.BaseEvent);
        Assert.Equal("""{"type":"TEXT_MESSAGE_START","messageId":"m1"}""", json);
    }

    // A discriminator that is present but not a string is malformed input, and
    // must not reach the unknown-type path that stream readers skip.
    [Fact]
    public void Deserialization_ThrowsForNonStringType()
    {
        var json = """{"type":null}""";
        Assert.Throws<JsonException>(() =>
            JsonSerializer.Deserialize<BaseEvent>(json, AGUIJsonSerializerContext.Default.BaseEvent));
    }

    [Fact]
    public void Deserialization_ThrowsForMissingType()
    {
        var json = """{"threadId":"t1"}""";
        Assert.Throws<JsonException>(() =>
            JsonSerializer.Deserialize<BaseEvent>(json, AGUIJsonSerializerContext.Default.BaseEvent));
    }

    // The same closure for the other discriminated unions: a member the schema
    // gains needs a converter arm and a serializer-context registration, and
    // without either, .NET would read a member the other SDKs support as
    // unknown. Every concrete member in the assembly must decode from its own
    // discriminator, and its type must be registered.
    [Theory]
    [InlineData(typeof(AGUIMessage), "role")]
    [InlineData(typeof(AGUIInputContent), "type")]
    [InlineData(typeof(AGUIInputContentSource), "type")]
    [InlineData(typeof(RunFinishedOutcome), "type")]
    [InlineData(typeof(SubagentFinishedOutcome), "type")]
    public void EveryUnionMember_IsCarriedByItsConverter(Type baseType, string discriminator)
    {
        var members = typeof(BaseEvent).Assembly.GetTypes()
            .Where(type => type.IsSubclassOf(baseType) && !type.IsAbstract)
            .ToList();
        Assert.NotEmpty(members);

        foreach (var member in members)
        {
            var instance = Activator.CreateInstance(member)!;
            var property = discriminator == "role" ? "Role" : "Type";
            var value = member.GetProperty(property)!.GetValue(instance) as string;
            Assert.False(
                string.IsNullOrEmpty(value),
                $"{member.Name} has no {discriminator} discriminator to be found by.");

            Assert.True(
                AGUIJsonSerializerContext.Default.GetTypeInfo(member) is not null,
                $"{member.Name} is not registered in AGUIJsonSerializerContext.");

            var json = $"{{\"{discriminator}\":\"{value}\"}}";
            var decoded = JsonSerializer.Deserialize(
                json,
                AGUIJsonSerializerContext.Default.GetTypeInfo(baseType)!);
            Assert.IsType(member, decoded);

            try
            {
                JsonSerializer.Serialize(
                    instance,
                    AGUIJsonSerializerContext.Default.GetTypeInfo(baseType)!);
            }
            catch (JsonException exception) when (exception.Message.StartsWith("Unknown", StringComparison.Ordinal))
            {
                Assert.Fail($"{member.Name} has no write case in its converter: {exception.Message}");
            }
            catch (Exception)
            {
                // A member built with no payload can still fail on its own unset
                // required members; only a missing case matters here.
            }
        }
    }

    // The unknown-type paths above skip what they do not recognise, so a
    // converter case forgotten when the schema gains an event would look like
    // a producer sending something unknown rather than like a bug here. This
    // gate closes that: every event model in the assembly must be carried by
    // both directions of the converter, and the set of models must be exactly
    // the set of declared event types.
    [Fact]
    public void EveryDeclaredEventType_IsCarriedByBothConverterDirections()
    {
        var models = typeof(BaseEvent).Assembly.GetTypes()
            .Where(type => type.IsSubclassOf(typeof(BaseEvent)) && !type.IsAbstract)
            .ToList();
        Assert.NotEmpty(models);

        foreach (var model in models)
        {
            var evt = (BaseEvent)Activator.CreateInstance(model)!;

            var decoded = JsonSerializer.Deserialize(
                $$"""{"type":"{{evt.Type}}"}""",
                AGUIJsonSerializerContext.Default.BaseEvent);
            Assert.IsType(model, decoded);

            try
            {
                JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.BaseEvent);
            }
            catch (AGUIUnknownEventTypeException)
            {
                Assert.Fail($"{model.Name} has no write case in {nameof(BaseEventJsonConverter)}.");
            }
            catch (Exception)
            {
                // An event built with no payload can still fail on its own
                // unset required members; only a missing case matters here.
            }
        }

        var declared = typeof(AGUIEventTypes)
            .GetFields(BindingFlags.Public | BindingFlags.Static)
            .Where(field => field.IsLiteral)
            .Select(field => (string)field.GetRawConstantValue()!)
            .ToHashSet();
        var carried = models
            .Select(model => ((BaseEvent)Activator.CreateInstance(model)!).Type)
            .ToHashSet();
        Assert.Equal(declared, carried);
    }
}
