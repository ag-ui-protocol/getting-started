using System.Text.Json.Nodes;
using Xunit;

namespace AGUI.A2UI.UnitTests;

/// <summary>
/// Unit tests for <see cref="A2UIOperationBuilder"/>.
/// </summary>
/// <remarks>
/// Ported from the Python toolkit's <c>TestOpBuilders</c> and the TypeScript toolkit's
/// op-builder tests to guarantee byte-level envelope parity across languages.
/// </remarks>
public sealed class A2UIOperationBuilderTest
{
    [Fact]
    public void CreateSurface_ReturnsVersionedOperation()
    {
        // Act
        JsonObject op = A2UIOperationBuilder.CreateSurface("s1", "catalog-1");

        // Assert
        Assert.Equal("v0.9", (string?)op["version"]);
        JsonObject createSurface = Assert.IsType<JsonObject>(op["createSurface"]);
        Assert.Equal("s1", (string?)createSurface["surfaceId"]);
        Assert.Equal("catalog-1", (string?)createSurface["catalogId"]);
    }

    [Fact]
    public void UpdateComponents_WrapsComponentArray()
    {
        // Arrange
        var components = new JsonNode?[]
        {
            new JsonObject { ["id"] = "root", ["component"] = "Row" },
        };

        // Act
        JsonObject op = A2UIOperationBuilder.UpdateComponents("s1", components);

        // Assert
        Assert.Equal("v0.9", (string?)op["version"]);
        JsonObject updateComponents = Assert.IsType<JsonObject>(op["updateComponents"]);
        Assert.Equal("s1", (string?)updateComponents["surfaceId"]);
        JsonArray array = Assert.IsType<JsonArray>(updateComponents["components"]);
        JsonObject component = Assert.IsType<JsonObject>(Assert.Single(array));
        Assert.Equal("root", (string?)component["id"]);
    }

    [Fact]
    public void UpdateDataModel_DefaultsToRootPath()
    {
        // Act
        JsonObject op = A2UIOperationBuilder.UpdateDataModel("s1", new JsonObject { ["items"] = new JsonArray() });

        // Assert
        Assert.Equal("v0.9", (string?)op["version"]);
        JsonObject updateDataModel = Assert.IsType<JsonObject>(op["updateDataModel"]);
        Assert.Equal("s1", (string?)updateDataModel["surfaceId"]);
        Assert.Equal("/", (string?)updateDataModel["path"]);
        Assert.NotNull(updateDataModel["value"]);
    }

    [Fact]
    public void UpdateDataModel_HonorsCustomPath()
    {
        // Act
        JsonObject op = A2UIOperationBuilder.UpdateDataModel("s1", JsonValue.Create(42), "/answer");

        // Assert
        JsonObject updateDataModel = Assert.IsType<JsonObject>(op["updateDataModel"]);
        Assert.Equal("/answer", (string?)updateDataModel["path"]);
        Assert.Equal(42, (int?)updateDataModel["value"]);
    }
}
