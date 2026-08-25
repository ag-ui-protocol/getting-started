using AGUI.Server;
using Xunit;

namespace AGUI.Server.UnitTests;

public sealed class AGUIIdGeneratorTest
{
    [Fact]
    public void NewId_DefaultPrefix_StartsWithId()
    {
        var id = AGUIIdGenerator.NewId();

        Assert.StartsWith("id_", id);
    }

    [Fact]
    public void NewId_CustomPrefix_StartsWithPrefix()
    {
        var id = AGUIIdGenerator.NewId("custom");

        Assert.StartsWith("custom_", id);
    }

    [Fact]
    public void NewId_NullPrefix_ReturnsEntropyOnly()
    {
        var id = AGUIIdGenerator.NewId(null);

        Assert.DoesNotContain("_", id);
        Assert.Equal(24, id.Length);
    }

    [Fact]
    public void NewId_EmptyPrefix_ReturnsEntropyOnly()
    {
        var id = AGUIIdGenerator.NewId("");

        Assert.DoesNotContain("_", id);
        Assert.Equal(24, id.Length);
    }

    [Fact]
    public void NewId_HasCorrectEntropyLength()
    {
        var id = AGUIIdGenerator.NewId("test");

        // "test_" + 24 chars
        Assert.Equal(5 + 24, id.Length);
    }

    [Fact]
    public void NewId_UsesAlphanumericCharacters()
    {
        var id = AGUIIdGenerator.NewId();
        var entropy = id.Substring("id_".Length);

        Assert.All(entropy.ToCharArray(), c =>
            Assert.True(char.IsLetterOrDigit(c), $"Character '{c}' is not alphanumeric"));
    }

    [Fact]
    public void NewMessageId_StartsWithMsg()
    {
        var id = AGUIIdGenerator.NewMessageId();

        Assert.StartsWith("msg_", id);
    }

    [Fact]
    public void NewMessageId_HasCorrectLength()
    {
        var id = AGUIIdGenerator.NewMessageId();

        // "msg_" + 24 chars
        Assert.Equal(4 + 24, id.Length);
    }

    [Fact]
    public void NewId_GeneratesUniqueIds()
    {
        var ids = new HashSet<string>();
        for (var i = 0; i < 100; i++)
        {
            ids.Add(AGUIIdGenerator.NewId());
        }

        Assert.Equal(100, ids.Count);
    }
}
