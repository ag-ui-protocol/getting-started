using System.Collections.Generic;
using AGUI.Abstractions;
using Google.Protobuf.WellKnownTypes;
using Xunit;

namespace AGUI.Protobuf.UnitTests;

/// <summary>
/// The binary transport has its own hand-built payload: a deprecated
/// <see cref="AGUIBinaryInputContent"/> is encoded as a document whose <c>metadata</c> struct
/// carries <c>{ legacyBinary, filename, id }</c>. That struct is assembled field by field rather
/// than by the JSON serializer, so the omit-a-field-that-has-no-value rule does not reach it and
/// has to be asserted here.
/// </summary>
/// <remarks>
/// This is the one place the .NET protobuf producer can invent a <c>null</c> for a field that has
/// no value, and the JSON sweep and shared cross-language fixture cannot see it — neither goes
/// through the protobuf mapper. proto.ts hands <c>undefined</c> to <c>Struct.wrap</c> and
/// ts-proto's encoder skips undefined entries, so an absent key is what TypeScript puts on the
/// binary wire and what .NET has to match.
/// </remarks>
public sealed class BinaryMetadataNullOmissionTest
{
    private static Struct EncodeBinaryMetadata(AGUIBinaryInputContent binary)
    {
        var message = new AGUIUserMessage
        {
            Id = "msg_1",
            Content = new List<AGUIInputContent> { binary },
        };

        var proto = ProtoMessageMapper.ToProto(message);
        var part = Assert.Single(proto.ContentParts);

        return part.Document.Metadata.StructValue;
    }

    [Fact]
    public void MetadataOmitsFilenameAndIdWhenTheyHaveNoValue()
    {
        var metadata = EncodeBinaryMetadata(new AGUIBinaryInputContent
        {
            MimeType = "text/plain",
            Data = "aGk=",
        });

        Assert.True(metadata.Fields["legacyBinary"].BoolValue);
        Assert.DoesNotContain("filename", metadata.Fields.Keys);
        Assert.DoesNotContain("id", metadata.Fields.Keys);
    }

    [Fact]
    public void MetadataNeverWritesNullValueForAnAbsentField()
    {
        var metadata = EncodeBinaryMetadata(new AGUIBinaryInputContent
        {
            MimeType = "text/plain",
            Data = "aGk=",
        });

        Assert.DoesNotContain(
            Value.KindOneofCase.NullValue,
            new List<Value.KindOneofCase>(EnumerateKinds(metadata)));
    }

    [Fact]
    public void MetadataCarriesFilenameAndIdWhenTheyHaveValues()
    {
        var metadata = EncodeBinaryMetadata(new AGUIBinaryInputContent
        {
            MimeType = "text/plain",
            Data = "aGk=",
            Filename = "notes.txt",
            Id = "bin_1",
        });

        Assert.Equal("notes.txt", metadata.Fields["filename"].StringValue);
        Assert.Equal("bin_1", metadata.Fields["id"].StringValue);
    }

    [Fact]
    public void MetadataOmitsOnlyTheFieldThatHasNoValue()
    {
        var metadata = EncodeBinaryMetadata(new AGUIBinaryInputContent
        {
            MimeType = "text/plain",
            Data = "aGk=",
            Id = "bin_1",
        });

        Assert.Equal("bin_1", metadata.Fields["id"].StringValue);
        Assert.DoesNotContain("filename", metadata.Fields.Keys);
    }

    private static IEnumerable<Value.KindOneofCase> EnumerateKinds(Struct metadata)
    {
        foreach (var value in metadata.Fields.Values)
        {
            yield return value.KindCase;
        }
    }
}
