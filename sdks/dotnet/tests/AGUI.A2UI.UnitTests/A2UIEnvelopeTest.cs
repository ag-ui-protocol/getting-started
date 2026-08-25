using System.Text.Json.Nodes;
using Xunit;

namespace AGUI.A2UI.UnitTests;

/// <summary>
/// Unit tests for <see cref="A2UIToolkit.AssembleOps"/>, the envelope wrappers,
/// <see cref="A2UIToolkit.PrepareA2UIRequest"/>, <see cref="A2UIToolkit.BuildA2UIEnvelope"/>,
/// <see cref="A2UIToolDefinitions"/>, and parameter resolution.
/// </summary>
/// <remarks>
/// Ported from the Python toolkit's <c>TestAssembleOps</c>, <c>TestWrapAsOperationsEnvelope</c>,
/// <c>TestWrapErrorEnvelope</c>, <c>TestPrepareA2UIRequest</c>, <c>TestBuildA2UIEnvelope</c>,
/// <c>TestRenderToolDef</c>, and <c>TestResolveA2UIToolParams</c> (mirrored in the TypeScript
/// suite). The Python <c>model</c> passthrough assertions are not ported: in .NET the subagent
/// chat client is owned by the adapter factory, not by <see cref="A2UIToolParams"/>.
/// </remarks>
public sealed class A2UIEnvelopeTest
{
    private static readonly string[] s_renderToolRequiredFields = ["surfaceId", "components"];

    private static JsonArray RowComponents() => new(new JsonObject { ["id"] = "root", ["component"] = "Row" });

    private static A2UIHistoryMessage PriorSurfaceMessage(string surfaceId) => new(
        "tool",
        A2UIToolkit.WrapAsOperationsEnvelope(
        [
            A2UIOperationBuilder.CreateSurface(surfaceId, "cat://x"),
            A2UIOperationBuilder.UpdateComponents(surfaceId, RowComponents()),
            A2UIOperationBuilder.UpdateDataModel(surfaceId, new JsonObject { ["items"] = new JsonArray(1, 2) }),
        ]));

    private static JsonArray ParseOperations(string envelope)
    {
        JsonObject parsed = Assert.IsType<JsonObject>(JsonNode.Parse(envelope));
        return Assert.IsType<JsonArray>(parsed[A2UIConstants.A2UIOperationsKey]);
    }

    private static JsonObject SingleOperation(JsonArray operations, string operationName)
    {
        JsonObject? match = operations
            .OfType<JsonObject>()
            .SingleOrDefault(op => op.ContainsKey(operationName));
        Assert.NotNull(match);
        return Assert.IsType<JsonObject>(match[operationName]);
    }

    [Fact]
    public void CreateRenderA2UIToolDefinition_HasCanonicalShape()
    {
        // Act
        JsonObject definition = A2UIToolDefinitions.CreateRenderA2UIToolDefinition();

        // Assert
        Assert.Equal("function", (string?)definition["type"]);
        JsonObject function = Assert.IsType<JsonObject>(definition["function"]);
        Assert.Equal(A2UIConstants.RenderA2UIToolName, (string?)function["name"]);
        JsonObject parameters = Assert.IsType<JsonObject>(function["parameters"]);
        JsonArray required = Assert.IsType<JsonArray>(parameters["required"]);
        Assert.Equal(s_renderToolRequiredFields, required.Select(n => (string?)n).ToArray());
        JsonObject properties = Assert.IsType<JsonObject>(parameters["properties"]);
        Assert.Equal(["surfaceId", "components", "data"], properties.Select(p => p.Key).ToArray());
    }

    [Fact]
    public void AssembleOps_CreateIntent_EmitsFullEnvelope()
    {
        // Act
        IReadOnlyList<JsonObject> ops = A2UIToolkit.AssembleOps(
            "create", "s1", "cat://x", RowComponents(), new JsonObject { ["items"] = new JsonArray("a") });

        // Assert
        Assert.Equal(3, ops.Count);
        Assert.True(ops[0].ContainsKey("createSurface"));
        Assert.True(ops[1].ContainsKey("updateComponents"));
        Assert.True(ops[2].ContainsKey("updateDataModel"));
    }

    [Fact]
    public void AssembleOps_UpdateIntent_SkipsCreateSurface()
    {
        // Act
        IReadOnlyList<JsonObject> ops = A2UIToolkit.AssembleOps(
            "update", "s1", "cat://x", RowComponents(), new JsonObject { ["items"] = new JsonArray("a") });

        // Assert
        Assert.Equal(2, ops.Count);
        Assert.True(ops[0].ContainsKey("updateComponents"));
        Assert.True(ops[1].ContainsKey("updateDataModel"));
    }

    [Fact]
    public void AssembleOps_NoData_OmitsDataModelOp()
    {
        // Act
        IReadOnlyList<JsonObject> ops = A2UIToolkit.AssembleOps("create", "s1", "cat://x", RowComponents());

        // Assert
        Assert.Equal(2, ops.Count);
        Assert.True(ops[0].ContainsKey("createSurface"));
        Assert.True(ops[1].ContainsKey("updateComponents"));
    }

    [Fact]
    public void AssembleOps_EmptyData_OmitsDataModelOp()
    {
        // Act
        IReadOnlyList<JsonObject> ops = A2UIToolkit.AssembleOps(
            "create", "s1", "cat://x", RowComponents(), new JsonObject());

        // Assert
        Assert.Equal(2, ops.Count);
    }

    [Fact]
    public void WrapAsOperationsEnvelope_SerializesUnderOperationsKey()
    {
        // Act
        string envelope = A2UIToolkit.WrapAsOperationsEnvelope([A2UIOperationBuilder.CreateSurface("s1", "c")]);

        // Assert
        JsonArray ops = ParseOperations(envelope);
        JsonObject op = Assert.IsType<JsonObject>(Assert.Single(ops));
        Assert.Equal("v0.9", (string?)op["version"]);
        Assert.Equal("s1", (string?)op["createSurface"]?["surfaceId"]);
    }

    [Fact]
    public void WrapAsOperationsEnvelope_EmptyOps_SerializesEmptyArray()
    {
        // Act & Assert
        Assert.Empty(ParseOperations(A2UIToolkit.WrapAsOperationsEnvelope([])));
    }

    [Fact]
    public void WrapErrorEnvelope_WrapsMessage()
    {
        // Act
        JsonObject parsed = Assert.IsType<JsonObject>(JsonNode.Parse(A2UIToolkit.WrapErrorEnvelope("boom")));

        // Assert
        Assert.Equal("boom", (string?)parsed["error"]);
        Assert.Single(parsed);
    }

    [Fact]
    public void PrepareA2UIRequest_CreateIntent_BuildsPromptWithoutPrior()
    {
        // Arrange
        var state = new A2UIAgentState { Context = [new A2UIContextEntry(null, "ctx")] };
        var guidelines = new A2UIGuidelines { CompositionGuide = "guide" };

        // Act
        A2UIPreparedRequest prep = A2UIToolkit.PrepareA2UIRequest(
            "create", targetSurfaceId: null, changes: null, messages: [], state, guidelines);

        // Assert
        Assert.Null(prep.Error);
        Assert.False(prep.IsUpdate);
        Assert.Null(prep.Prior);
        Assert.Contains("ctx", prep.Prompt);
        Assert.Contains("guide", prep.Prompt);
    }

    [Fact]
    public void PrepareA2UIRequest_MissingIntent_DefaultsToCreate()
    {
        // Act
        A2UIPreparedRequest prep = A2UIToolkit.PrepareA2UIRequest(
            intent: null, targetSurfaceId: null, changes: null, messages: [], state: null);

        // Assert
        Assert.False(prep.IsUpdate);
        Assert.Null(prep.Error);
    }

    [Fact]
    public void PrepareA2UIRequest_UpdateWithMatchingPrior_BuildsEditPrompt()
    {
        // Act
        A2UIPreparedRequest prep = A2UIToolkit.PrepareA2UIRequest(
            "update", "s1", "make it red", [PriorSurfaceMessage("s1")], state: null);

        // Assert
        Assert.Null(prep.Error);
        Assert.True(prep.IsUpdate);
        Assert.Equal("cat://x", prep.Prior?.CatalogId);
        Assert.Contains("Editing an existing surface", prep.Prompt);
        Assert.Contains("make it red", prep.Prompt);
    }

    [Fact]
    public void PrepareA2UIRequest_UpdateWithoutPrior_ReturnsError()
    {
        // Act
        A2UIPreparedRequest prep = A2UIToolkit.PrepareA2UIRequest(
            "update", "missing", changes: null, [PriorSurfaceMessage("s1")], state: null);

        // Assert
        Assert.Equal(string.Empty, prep.Prompt);
        Assert.NotNull(prep.Error);
        Assert.Contains("missing", prep.Error);
        Assert.Contains("no prior render", prep.Error);
    }

    [Fact]
    public void BuildA2UIEnvelope_Create_UsesConfiguredCatalogNotArgs()
    {
        // Arrange
        var args = new JsonObject
        {
            ["surfaceId"] = "from-args",
            ["components"] = RowComponents(),
            ["data"] = new JsonObject { ["items"] = new JsonArray(1) },
        };

        // Act
        JsonArray ops = ParseOperations(A2UIToolkit.BuildA2UIEnvelope(
            args, isUpdate: false, targetSurfaceId: null, prior: null,
            defaultCatalogId: "cat://configured"));

        // Assert
        JsonObject createSurface = SingleOperation(ops, "createSurface");
        Assert.Equal("from-args", (string?)createSurface["surfaceId"]);
        Assert.Equal("cat://configured", (string?)createSurface["catalogId"]);
        JsonObject updateComponents = SingleOperation(ops, "updateComponents");
        Assert.Equal(RowComponents().ToJsonString(), updateComponents["components"]?.ToJsonString());
        JsonObject updateDataModel = SingleOperation(ops, "updateDataModel");
        Assert.Equal("""{"items":[1]}""", updateDataModel["value"]?.ToJsonString());
    }

    [Fact]
    public void BuildA2UIEnvelope_MissingSurfaceId_FallsBackToDefault()
    {
        // Arrange
        var args = new JsonObject { ["components"] = new JsonArray() };

        // Act
        JsonArray ops = ParseOperations(A2UIToolkit.BuildA2UIEnvelope(
            args, isUpdate: false, targetSurfaceId: null, prior: null));

        // Assert
        Assert.Equal(A2UIConstants.DefaultSurfaceId, (string?)SingleOperation(ops, "createSurface")["surfaceId"]);
    }

    [Fact]
    public void BuildA2UIEnvelope_EmptyStringDefaults_FallBackToCanonical()
    {
        // Arrange: a misconfigured host passes empty-string defaults. Those must NOT
        // propagate into the emitted ops — the renderer would surface
        // "Catalog not found: " / a blank surface id, hiding the real cause.
        var args = new JsonObject { ["components"] = RowComponents() };

        // Act
        JsonArray ops = ParseOperations(A2UIToolkit.BuildA2UIEnvelope(
            args, isUpdate: false, targetSurfaceId: null, prior: null,
            defaultSurfaceId: string.Empty, defaultCatalogId: string.Empty));

        // Assert
        JsonObject createSurface = SingleOperation(ops, "createSurface");
        Assert.Equal(A2UIConstants.DefaultSurfaceId, (string?)createSurface["surfaceId"]);
        Assert.Equal(A2UIConstants.BasicCatalogId, (string?)createSurface["catalogId"]);
    }

    [Theory]
    [InlineData("42")]
    [InlineData("[\"x\"]")]
    [InlineData("null")]
    [InlineData("{\"a\":1}")]
    [InlineData("true")]
    public void BuildA2UIEnvelope_NonStringSurfaceId_FallsBackToDefault(string badSurfaceIdJson)
    {
        // Arrange: the model is untrusted — surfaceId may come back as a number, array,
        // null, object, or boolean. Without narrowing, a non-string value propagates into
        // createSurface.surfaceId and the renderer crashes. Mirror of the TS/Python narrow.
        var args = new JsonObject
        {
            ["surfaceId"] = JsonNode.Parse(badSurfaceIdJson),
            ["components"] = new JsonArray(),
        };

        // Act
        JsonArray ops = ParseOperations(A2UIToolkit.BuildA2UIEnvelope(
            args, isUpdate: false, targetSurfaceId: null, prior: null));

        // Assert
        Assert.Equal(A2UIConstants.DefaultSurfaceId, (string?)SingleOperation(ops, "createSurface")["surfaceId"]);
    }

    [Fact]
    public void BuildA2UIEnvelope_UpdateWithEmptyTargetSurfaceId_FallsBackToDefault()
    {
        // Arrange: direct callers (bypassing PrepareA2UIRequest) may pass an empty target
        // surface id on the update path. It must not propagate into updateComponents.
        var args = new JsonObject { ["components"] = RowComponents() };
        var prior = new A2UIPriorSurface(new JsonArray(), null, "cat://prior");

        // Act
        JsonArray ops = ParseOperations(A2UIToolkit.BuildA2UIEnvelope(
            args, isUpdate: true, targetSurfaceId: string.Empty, prior));

        // Assert
        Assert.Equal(A2UIConstants.DefaultSurfaceId, (string?)SingleOperation(ops, "updateComponents")["surfaceId"]);
    }

    [Fact]
    public void BuildA2UIEnvelope_Update_SkipsCreateSurfaceAndKeepsTarget()
    {
        // Arrange
        var args = new JsonObject
        {
            ["surfaceId"] = "ignored",
            ["components"] = new JsonArray(new JsonObject { ["id"] = "root", ["component"] = "Column" }),
        };
        var prior = new A2UIPriorSurface(new JsonArray(), null, "cat://prior");

        // Act
        JsonArray ops = ParseOperations(A2UIToolkit.BuildA2UIEnvelope(
            args, isUpdate: true, targetSurfaceId: "s1", prior));

        // Assert
        Assert.DoesNotContain(ops.OfType<JsonObject>(), op => op.ContainsKey("createSurface"));
        Assert.Equal("s1", (string?)SingleOperation(ops, "updateComponents")["surfaceId"]);
    }

    [Fact]
    public void BuildA2UIEnvelope_UpdateWithData_EmitsDataModelOp()
    {
        // Arrange
        var args = new JsonObject
        {
            ["components"] = RowComponents(),
            ["data"] = new JsonObject { ["items"] = new JsonArray(1) },
        };
        var prior = new A2UIPriorSurface(new JsonArray(), null, "cat://prior");

        // Act
        JsonArray ops = ParseOperations(A2UIToolkit.BuildA2UIEnvelope(
            args, isUpdate: true, targetSurfaceId: "s1", prior));

        // Assert: update path = updateComponents + updateDataModel, both on the target.
        Assert.Equal(2, ops.Count);
        Assert.Equal("s1", (string?)SingleOperation(ops, "updateComponents")["surfaceId"]);
        JsonObject updateDataModel = SingleOperation(ops, "updateDataModel");
        Assert.Equal("s1", (string?)updateDataModel["surfaceId"]);
        Assert.Equal("""{"items":[1]}""", updateDataModel["value"]?.ToJsonString());
    }

    [Fact]
    public void ResolveA2UIToolParams_FillsCanonicalDefaults()
    {
        // Act
        A2UIResolvedToolParams resolved = A2UIToolDefinitions.ResolveA2UIToolParams(new A2UIToolParams());

        // Assert
        Assert.Equal(A2UIConstants.DefaultSurfaceId, resolved.DefaultSurfaceId);
        Assert.Equal(A2UIConstants.BasicCatalogId, resolved.DefaultCatalogId);
        Assert.Equal(A2UIConstants.GenerateA2UIToolName, resolved.ToolName);
        Assert.Equal(A2UIToolDefinitions.GenerateA2UIToolDescription, resolved.ToolDescription);
        Assert.Null(resolved.Guidelines);
    }

    [Fact]
    public void ResolveA2UIToolParams_EmptyStringOverrides_FallBackToDefaults()
    {
        // Arrange
        var parameters = new A2UIToolParams { ToolName = string.Empty, DefaultCatalogId = string.Empty };

        // Act
        A2UIResolvedToolParams resolved = A2UIToolDefinitions.ResolveA2UIToolParams(parameters);

        // Assert
        Assert.Equal(A2UIConstants.GenerateA2UIToolName, resolved.ToolName);
        Assert.Equal(A2UIConstants.BasicCatalogId, resolved.DefaultCatalogId);
    }

    [Fact]
    public void ResolveA2UIToolParams_Overrides_PassThrough()
    {
        // Arrange
        var guidelines = new A2UIGuidelines { CompositionGuide = "g" };
        var parameters = new A2UIToolParams { ToolName = "custom_tool", Guidelines = guidelines };

        // Act
        A2UIResolvedToolParams resolved = A2UIToolDefinitions.ResolveA2UIToolParams(parameters);

        // Assert
        Assert.Equal("custom_tool", resolved.ToolName);
        Assert.Same(guidelines, resolved.Guidelines);
    }
}
