using System.Linq;
using System.Text.Json;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Client.UnitTests;

public sealed class ClientAIToolExtensionsTest
{
    [Fact]
    public void AsAGUITools_WithAIFunction_ConvertsCorrectly()
    {
        var func = AIFunctionFactory.Create(() => "hello", "greet", "Says hello");
        var tools = new AITool[] { func };

        var aguiTools = tools.AsAGUITools().ToList();

        Assert.Single(aguiTools);
        Assert.Equal("greet", aguiTools[0].Name);
        Assert.Equal("Says hello", aguiTools[0].Description);
    }

    [Fact]
    public void AsAGUITools_WithParameterizedFunction_IncludesJsonSchema()
    {
        var func = AIFunctionFactory.Create((string city) => $"Weather in {city}", "get_weather", "Gets weather");
        var tools = new AITool[] { func };

        var aguiTools = tools.AsAGUITools().ToList();

        Assert.Single(aguiTools);
        Assert.Equal("get_weather", aguiTools[0].Name);
        // Parameters should be a valid JSON schema element
        Assert.NotEqual(default, aguiTools[0].Parameters);
        Assert.Equal(JsonValueKind.Object, aguiTools[0].Parameters.ValueKind);
    }

    [Fact]
    public void AsAGUITools_WithEmptyList_ReturnsEmpty()
    {
        var tools = Enumerable.Empty<AITool>();

        var aguiTools = tools.AsAGUITools().ToList();

        Assert.Empty(aguiTools);
    }

    [Fact]
    public void AsAGUITools_WithNullList_ReturnsEmpty()
    {
        IEnumerable<AITool> tools = null!;

        var aguiTools = tools.AsAGUITools().ToList();

        Assert.Empty(aguiTools);
    }

    [Fact]
    public void AsAGUITools_MultipleFunctions_ConvertsAll()
    {
        var func1 = AIFunctionFactory.Create(() => "a", "tool_a", "Tool A");
        var func2 = AIFunctionFactory.Create(() => "b", "tool_b", "Tool B");
        var tools = new AITool[] { func1, func2 };

        var aguiTools = tools.AsAGUITools().ToList();

        Assert.Equal(2, aguiTools.Count);
        Assert.Equal("tool_a", aguiTools[0].Name);
        Assert.Equal("tool_b", aguiTools[1].Name);
    }
}
