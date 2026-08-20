using System.Text.Json.Nodes;
using Xunit;

namespace AGUI.A2UI.UnitTests;

/// <summary>
/// Unit tests for <see cref="A2UIToolkit.FindPriorSurface"/>.
/// </summary>
/// <remarks>
/// Ported from the Python toolkit's <c>TestFindPriorSurface</c> (11 cases, mirrored in the
/// TypeScript suite). These pin the surface-walk semantics: within a message the last
/// operation per field wins and <c>deleteSurface</c> resets the accumulator; across
/// messages the newest mention is authoritative and older messages only fill gaps; a
/// surface whose newest end state is deleted is never resurrected.
/// The Python "accepts dict-style messages" duck-typing case is covered by the
/// <see cref="A2UIHistoryMessage"/> type here and is not ported.
/// </remarks>
public sealed class A2UIFindPriorSurfaceTest
{
    private static A2UIHistoryMessage ToolMessage(JsonObject content)
        => new("tool", content.ToJsonString());

    private static JsonObject Operations(params JsonObject[] operations)
        => new() { [A2UIConstants.A2UIOperationsKey] = new JsonArray(operations) };

    private static JsonObject DeleteSurface(string surfaceId) => new()
    {
        ["version"] = "v0.9",
        ["deleteSurface"] = new JsonObject { ["surfaceId"] = surfaceId },
    };

    private static JsonArray RowComponents() => new(new JsonObject { ["id"] = "root", ["component"] = "Row" });

    private static JsonArray ColumnComponents() => new(new JsonObject { ["id"] = "root", ["component"] = "Column" });

    [Fact]
    public void FindPriorSurface_SurfaceNotInHistory_ReturnsNull()
    {
        // Arrange
        A2UIHistoryMessage[] messages = [ToolMessage(Operations())];

        // Act & Assert
        Assert.Null(A2UIToolkit.FindPriorSurface(messages, "missing"));
    }

    [Fact]
    public void FindPriorSurface_SingleMessage_ReconstructsState()
    {
        // Arrange
        A2UIHistoryMessage[] messages =
        [
            ToolMessage(Operations(
                A2UIOperationBuilder.CreateSurface("s1", "cat://x"),
                A2UIOperationBuilder.UpdateComponents("s1", RowComponents()),
                A2UIOperationBuilder.UpdateDataModel("s1", new JsonObject { ["items"] = new JsonArray(1, 2) }))),
        ];

        // Act
        A2UIPriorSurface? prior = A2UIToolkit.FindPriorSurface(messages, "s1");

        // Assert
        Assert.NotNull(prior);
        Assert.Equal("cat://x", prior.CatalogId);
        Assert.Equal(RowComponents().ToJsonString(), prior.Components?.ToJsonString());
        Assert.Equal("""{"items":[1,2]}""", prior.Data?.ToJsonString());
    }

    [Fact]
    public void FindPriorSurface_MultipleMessages_PrefersLatest()
    {
        // Arrange
        A2UIHistoryMessage[] messages =
        [
            ToolMessage(Operations(
                A2UIOperationBuilder.CreateSurface("s1", "old-cat"),
                A2UIOperationBuilder.UpdateComponents("s1", RowComponents()))),
            ToolMessage(Operations(
                A2UIOperationBuilder.UpdateComponents("s1", ColumnComponents()),
                A2UIOperationBuilder.UpdateDataModel("s1", new JsonObject { ["changed"] = true }))),
        ];

        // Act
        A2UIPriorSurface? prior = A2UIToolkit.FindPriorSurface(messages, "s1");

        // Assert
        Assert.NotNull(prior);
        Assert.Equal(ColumnComponents().ToJsonString(), prior.Components?.ToJsonString());
        Assert.Equal("""{"changed":true}""", prior.Data?.ToJsonString());
    }

    [Fact]
    public void FindPriorSurface_NonToolAndMalformedMessages_AreIgnored()
    {
        // Arrange
        A2UIHistoryMessage[] messages =
        [
            new("assistant", "not a tool"),
            new("tool", "not json"),
            ToolMessage(new JsonObject { ["unrelated"] = "payload" }),
        ];

        // Act & Assert
        Assert.Null(A2UIToolkit.FindPriorSurface(messages, "s1"));
    }

    [Fact]
    public void FindPriorSurface_WithinMessage_LastOperationWins()
    {
        // Arrange: one envelope emits multiple ops for the same surface. The renderer
        // applies them in order, so the surface ends at Column / {v:2} / cat-B.
        A2UIHistoryMessage[] messages =
        [
            ToolMessage(Operations(
                A2UIOperationBuilder.CreateSurface("s1", "cat-A"),
                A2UIOperationBuilder.UpdateComponents("s1", RowComponents()),
                A2UIOperationBuilder.UpdateDataModel("s1", new JsonObject { ["v"] = 1 }),
                A2UIOperationBuilder.CreateSurface("s1", "cat-B"),
                A2UIOperationBuilder.UpdateComponents("s1", ColumnComponents()),
                A2UIOperationBuilder.UpdateDataModel("s1", new JsonObject { ["v"] = 2 }))),
        ];

        // Act
        A2UIPriorSurface? prior = A2UIToolkit.FindPriorSurface(messages, "s1");

        // Assert
        Assert.NotNull(prior);
        Assert.Equal("cat-B", prior.CatalogId);
        Assert.Equal(ColumnComponents().ToJsonString(), prior.Components?.ToJsonString());
        Assert.Equal("""{"v":2}""", prior.Data?.ToJsonString());
    }

    [Fact]
    public void FindPriorSurface_FieldsAccumulateAcrossWalk()
    {
        // Arrange: turn 1 sets everything; turn 2 only updates data. The walker must
        // surface components + catalogId from turn 1 plus the newer data from turn 2 —
        // not blank components because the most recent message happened to omit them.
        A2UIHistoryMessage[] messages =
        [
            ToolMessage(Operations(
                A2UIOperationBuilder.CreateSurface("s1", "cat://x"),
                A2UIOperationBuilder.UpdateComponents("s1", RowComponents()),
                A2UIOperationBuilder.UpdateDataModel("s1", new JsonObject { ["items"] = new JsonArray(1) }))),
            ToolMessage(Operations(
                A2UIOperationBuilder.UpdateDataModel("s1", new JsonObject { ["items"] = new JsonArray(1, 2, 3) }))),
        ];

        // Act
        A2UIPriorSurface? prior = A2UIToolkit.FindPriorSurface(messages, "s1");

        // Assert
        Assert.NotNull(prior);
        Assert.Equal("cat://x", prior.CatalogId);
        Assert.Equal(RowComponents().ToJsonString(), prior.Components?.ToJsonString());
        Assert.Equal("""{"items":[1,2,3]}""", prior.Data?.ToJsonString());
    }

    [Fact]
    public void FindPriorSurface_NewestDelete_ReturnsNull()
    {
        // Arrange: older message populated the surface; newer message deletes it. The
        // renderer no longer shows it, so the stale state must not be resurrected.
        A2UIHistoryMessage[] messages =
        [
            ToolMessage(Operations(
                A2UIOperationBuilder.CreateSurface("s1", "cat://x"),
                A2UIOperationBuilder.UpdateComponents("s1", RowComponents()),
                A2UIOperationBuilder.UpdateDataModel("s1", new JsonObject { ["items"] = new JsonArray(1, 2) }))),
            ToolMessage(Operations(DeleteSurface("s1"))),
        ];

        // Act & Assert
        Assert.Null(A2UIToolkit.FindPriorSurface(messages, "s1"));
    }

    [Fact]
    public void FindPriorSurface_OlderDelete_OverriddenByNewerCreate()
    {
        // Arrange: older message deleted the surface; newer message recreates it. The
        // newer state must be returned — the older delete is dead history.
        A2UIHistoryMessage[] messages =
        [
            ToolMessage(Operations(DeleteSurface("s1"))),
            ToolMessage(Operations(
                A2UIOperationBuilder.CreateSurface("s1", "cat://new"),
                A2UIOperationBuilder.UpdateComponents("s1", ColumnComponents()),
                A2UIOperationBuilder.UpdateDataModel("s1", new JsonObject { ["items"] = new JsonArray(9) }))),
        ];

        // Act
        A2UIPriorSurface? prior = A2UIToolkit.FindPriorSurface(messages, "s1");

        // Assert
        Assert.NotNull(prior);
        Assert.Equal("cat://new", prior.CatalogId);
        Assert.Equal(ColumnComponents().ToJsonString(), prior.Components?.ToJsonString());
        Assert.Equal("""{"items":[9]}""", prior.Data?.ToJsonString());
    }

    [Fact]
    public void FindPriorSurface_IntraMessageDeleteThenCreate_ReturnsRecreatedState()
    {
        // Arrange: within one message, ops apply in order. Delete then create → the
        // surface exists with the recreated content at end of message, data unset.
        A2UIHistoryMessage[] messages =
        [
            ToolMessage(Operations(
                DeleteSurface("s1"),
                A2UIOperationBuilder.CreateSurface("s1", "cat-recreated"),
                A2UIOperationBuilder.UpdateComponents("s1", RowComponents()))),
        ];

        // Act
        A2UIPriorSurface? prior = A2UIToolkit.FindPriorSurface(messages, "s1");

        // Assert
        Assert.NotNull(prior);
        Assert.Equal("cat-recreated", prior.CatalogId);
        Assert.Equal(RowComponents().ToJsonString(), prior.Components?.ToJsonString());
        Assert.Null(prior.Data);
    }

    [Fact]
    public void FindPriorSurface_ReturnedNodes_AreDetachedFromTheParsedMessage()
    {
        // Arrange
        A2UIHistoryMessage[] messages =
        [
            ToolMessage(Operations(
                A2UIOperationBuilder.CreateSurface("s1", "cat://x"),
                A2UIOperationBuilder.UpdateComponents("s1", RowComponents()),
                A2UIOperationBuilder.UpdateDataModel("s1", new JsonObject { ["items"] = new JsonArray(1) }))),
        ];
        A2UIPriorSurface? prior = A2UIToolkit.FindPriorSurface(messages, "s1");
        Assert.NotNull(prior);

        // Act: re-attaching the returned nodes must not throw "node already has a parent".
        var host = new JsonObject
        {
            ["components"] = prior.Components,
            ["data"] = prior.Data,
        };

        // Assert
        Assert.NotNull(host["components"]);
        Assert.NotNull(host["data"]);
    }

    [Fact]
    public void FindPriorSurface_IntraMessageCreateThenDelete_ReturnsNull()
    {
        // Arrange: within the newest message the surface is created then deleted — its end
        // state is deleted, regardless of older accumulated state in prior messages.
        A2UIHistoryMessage[] messages =
        [
            ToolMessage(Operations(
                A2UIOperationBuilder.CreateSurface("s1", "older-cat"),
                A2UIOperationBuilder.UpdateComponents("s1", RowComponents()))),
            ToolMessage(Operations(
                A2UIOperationBuilder.CreateSurface("s1", "transient"),
                DeleteSurface("s1"))),
        ];

        // Act & Assert
        Assert.Null(A2UIToolkit.FindPriorSurface(messages, "s1"));
    }
}
