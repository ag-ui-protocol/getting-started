using System.Text.Json.Nodes;
using Xunit;

namespace AGUI.A2UI.UnitTests;

/// <summary>
/// Unit tests for <see cref="A2UIToolkit.BuildContextPrompt"/> and
/// <see cref="A2UIToolkit.BuildSubagentPrompt"/>.
/// </summary>
/// <remarks>
/// Ported from the Python toolkit's <c>TestBuildContextPrompt</c> and
/// <c>TestBuildSubagentPrompt</c> (mirrored in the TypeScript suite).
/// </remarks>
public sealed class A2UIPromptBuildingTest
{
    /// <summary>
    /// Suppresses both built-in default blocks so structural tests can assert exact output
    /// without the (large) default text. The empty string is the documented escape hatch
    /// (<see langword="null"/> → default; <c>""</c> → block omitted).
    /// </summary>
    private static A2UIGuidelines SuppressDefaults() => new()
    {
        GenerationGuidelines = string.Empty,
        DesignGuidelines = string.Empty,
    };

    [Fact]
    public void BuildContextPrompt_EmptyState_ReturnsEmpty()
    {
        // Act & Assert
        Assert.Equal(string.Empty, A2UIToolkit.BuildContextPrompt(new A2UIAgentState()));
        Assert.Equal(string.Empty, A2UIToolkit.BuildContextPrompt(null));
    }

    [Fact]
    public void BuildContextPrompt_DescribedEntry_BecomesMarkdownSection()
    {
        // Arrange
        var state = new A2UIAgentState
        {
            Context = [new A2UIContextEntry("Style guide", "use cards")],
        };

        // Act
        string prompt = A2UIToolkit.BuildContextPrompt(state);

        // Assert
        Assert.Contains("## Style guide", prompt);
        Assert.Contains("use cards", prompt);
    }

    [Fact]
    public void BuildContextPrompt_ValueOnlyEntry_HasNoHeading()
    {
        // Arrange
        var state = new A2UIAgentState
        {
            Context = [new A2UIContextEntry(null, "free-form note")],
        };

        // Act
        string prompt = A2UIToolkit.BuildContextPrompt(state);

        // Assert
        Assert.Contains("free-form note", prompt);
        Assert.DoesNotContain("##", prompt);
    }

    [Fact]
    public void BuildContextPrompt_Schema_RendersAvailableComponentsSection()
    {
        // Arrange
        var state = new A2UIAgentState { A2UISchema = "<catalog json>" };

        // Act
        string prompt = A2UIToolkit.BuildContextPrompt(state);

        // Assert
        Assert.Contains("## Available Components", prompt);
        Assert.Contains("<catalog json>", prompt);
    }

    [Fact]
    public void BuildContextPrompt_EmptyEntries_AreDropped()
    {
        // Arrange
        var state = new A2UIAgentState { Context = [new A2UIContextEntry(null, null)] };

        // Act & Assert
        Assert.Equal(string.Empty, A2UIToolkit.BuildContextPrompt(state));
    }

    [Fact]
    public void BuildSubagentPrompt_NoGuidelines_AppliesBuiltInDefaults()
    {
        // Act
        string prompt = A2UIToolkit.BuildSubagentPrompt("ctx");

        // Assert
        Assert.Contains(A2UIPromptDefaults.GenerationGuidelines, prompt, StringComparison.Ordinal);
        Assert.Contains("## Design Guidelines", prompt, StringComparison.Ordinal);
        Assert.Contains(A2UIPromptDefaults.DesignGuidelines, prompt, StringComparison.Ordinal);
        Assert.Contains("ctx", prompt, StringComparison.Ordinal);
    }

    [Fact]
    public void BuildSubagentPrompt_Sections_AppearInCanonicalOrder()
    {
        // Arrange: generation → design → context → composition.
        var guidelines = new A2UIGuidelines
        {
            GenerationGuidelines = "GENMARK",
            DesignGuidelines = "DESMARK",
            CompositionGuide = "COMPMARK",
        };

        // Act
        string prompt = A2UIToolkit.BuildSubagentPrompt("CTXMARK", guidelines);

        // Assert
        Assert.True(prompt.IndexOf("GENMARK", StringComparison.Ordinal) < prompt.IndexOf("DESMARK", StringComparison.Ordinal));
        Assert.True(prompt.IndexOf("DESMARK", StringComparison.Ordinal) < prompt.IndexOf("CTXMARK", StringComparison.Ordinal));
        Assert.True(prompt.IndexOf("CTXMARK", StringComparison.Ordinal) < prompt.IndexOf("COMPMARK", StringComparison.Ordinal));
    }

    [Fact]
    public void BuildSubagentPrompt_PerFieldOverride_KeepsOtherDefault()
    {
        // Arrange: override generation only → design still falls back to its default.
        var guidelines = new A2UIGuidelines { GenerationGuidelines = "CUSTOM_GEN" };

        // Act
        string prompt = A2UIToolkit.BuildSubagentPrompt("ctx", guidelines);

        // Assert
        Assert.Contains("CUSTOM_GEN", prompt, StringComparison.Ordinal);
        Assert.DoesNotContain(A2UIPromptDefaults.GenerationGuidelines, prompt, StringComparison.Ordinal);
        Assert.Contains(A2UIPromptDefaults.DesignGuidelines, prompt, StringComparison.Ordinal);
    }

    [Fact]
    public void BuildSubagentPrompt_EmptyStringOverride_SuppressesBlock()
    {
        // Act
        string prompt = A2UIToolkit.BuildSubagentPrompt("ctx", SuppressDefaults());

        // Assert
        Assert.DoesNotContain(A2UIPromptDefaults.GenerationGuidelines, prompt, StringComparison.Ordinal);
        Assert.DoesNotContain(A2UIPromptDefaults.DesignGuidelines, prompt, StringComparison.Ordinal);
        Assert.DoesNotContain("## Design Guidelines", prompt, StringComparison.Ordinal);
    }

    [Fact]
    public void BuildSubagentPrompt_ContextOnly_ReturnsContextVerbatim()
    {
        // Act & Assert
        Assert.Equal("ctx", A2UIToolkit.BuildSubagentPrompt("ctx", SuppressDefaults()));
    }

    [Fact]
    public void BuildSubagentPrompt_CompositionGuide_IsAppendedAfterContext()
    {
        // Arrange
        var guidelines = new A2UIGuidelines
        {
            GenerationGuidelines = string.Empty,
            DesignGuidelines = string.Empty,
            CompositionGuide = "guide",
        };

        // Act & Assert
        Assert.Equal("ctx\nguide", A2UIToolkit.BuildSubagentPrompt("ctx", guidelines));
    }

    [Fact]
    public void BuildSubagentPrompt_EditContext_RendersPriorStateAndChanges()
    {
        // Arrange
        var prior = new A2UIPriorSurface(
            new JsonArray(new JsonObject { ["id"] = "root", ["component"] = "Row" }),
            new JsonObject { ["x"] = 1 },
            CatalogId: null);
        var edit = new A2UIEditContext("s1", prior, "make the title bigger");

        // Act
        string prompt = A2UIToolkit.BuildSubagentPrompt("ctx", SuppressDefaults(), edit);

        // Assert
        Assert.Contains("Editing an existing surface", prompt, StringComparison.Ordinal);
        Assert.Contains("'s1'", prompt, StringComparison.Ordinal);
        Assert.Contains("\"id\": \"root\"", prompt, StringComparison.Ordinal);
        Assert.Contains("\"x\": 1", prompt, StringComparison.Ordinal);
        Assert.Contains("Requested changes", prompt, StringComparison.Ordinal);
        Assert.Contains("make the title bigger", prompt, StringComparison.Ordinal);
    }

    [Fact]
    public void BuildSubagentPrompt_NoChanges_OmitsRequestedChangesSection()
    {
        // Arrange
        var edit = new A2UIEditContext("s1", new A2UIPriorSurface(new JsonArray(), null, null));

        // Act
        string prompt = A2UIToolkit.BuildSubagentPrompt("ctx", SuppressDefaults(), edit);

        // Assert
        Assert.DoesNotContain("Requested changes", prompt, StringComparison.Ordinal);
    }

    [Fact]
    public void BuildSubagentPrompt_EmptyEverything_ReturnsEmpty()
    {
        // Act & Assert: empty context AND both default blocks suppressed → empty prompt.
        Assert.Equal(string.Empty, A2UIToolkit.BuildSubagentPrompt(string.Empty, SuppressDefaults()));
    }
}
