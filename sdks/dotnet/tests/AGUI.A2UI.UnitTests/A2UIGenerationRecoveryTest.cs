using System.Text.Json.Nodes;
using Xunit;

namespace AGUI.A2UI.UnitTests;

/// <summary>
/// Unit tests for <see cref="A2UIGenerationRecovery"/>.
/// </summary>
/// <remarks>
/// Ported from the Python toolkit's <c>tests/test_recovery.py</c> and the TypeScript toolkit's
/// <c>recovery.test.ts</c>. The .NET loop is asynchronous (idiomatic <see cref="Task"/>), but the
/// attempt semantics — first valid attempt wins, error-augmented retries, structured exhaustion
/// envelope — are identical across languages.
/// </remarks>
public sealed class A2UIGenerationRecoveryTest
{
    private static A2UIValidationCatalog CreateCatalog() => new(new JsonObject
    {
        ["Row"] = new JsonObject { ["required"] = new JsonArray("children") },
        ["HotelCard"] = new JsonObject { ["required"] = new JsonArray("name", "rating") },
    });

    private static JsonObject CreateRoot() => new()
    {
        ["id"] = "root",
        ["component"] = "Row",
        ["children"] = new JsonObject { ["componentId"] = "card", ["path"] = "/items" },
    };

    private static JsonObject CreateGoodCard() => new()
    {
        ["id"] = "card",
        ["component"] = "HotelCard",
        ["name"] = new JsonObject { ["path"] = "name" },
        ["rating"] = new JsonObject { ["path"] = "rating" },
    };

    // Missing the catalog-required `rating` property.
    private static JsonObject CreateBadCard() => new()
    {
        ["id"] = "card",
        ["component"] = "HotelCard",
        ["name"] = new JsonObject { ["path"] = "name" },
    };

    private static JsonObject CreateArgs(JsonObject card) => new()
    {
        ["surfaceId"] = "s1",
        ["components"] = new JsonArray(CreateRoot(), card),
        ["data"] = new JsonObject
        {
            ["items"] = new JsonArray(new JsonObject { ["name"] = "Ritz", ["rating"] = 4.8 }),
        },
    };

    private static string BuildEnvelope(JsonObject args)
        => new JsonObject { [A2UIConstants.A2UIOperationsKey] = args["components"]!.DeepClone() }.ToJsonString();

    private static readonly IReadOnlyList<A2UIValidationError> s_sampleErrors =
    [
        new(A2UIValidationErrorCodes.MissingRequiredProp, "components[1].rating", "missing required prop 'rating'"),
    ];

    [Fact]
    public void AugmentPromptWithValidationErrors_NoErrors_ReturnsPromptUnchanged()
    {
        // Act
        string result = A2UIGenerationRecovery.AugmentPromptWithValidationErrors("BASE", []);

        // Assert
        Assert.Equal("BASE", result);
    }

    [Fact]
    public void AugmentPromptWithValidationErrors_WithErrors_AppendsFormattedFixBlock()
    {
        // Act
        string result = A2UIGenerationRecovery.AugmentPromptWithValidationErrors("BASE", s_sampleErrors);

        // Assert
        Assert.Contains("BASE", result);
        Assert.Contains("rating", result);
        Assert.Contains(A2UIGenerationRecovery.FormatValidationErrors(s_sampleErrors), result);
    }

    [Fact]
    public async Task RunAsync_ValidFirstAttempt_ReturnsImmediatelyAsync()
    {
        // Arrange
        List<int> calls = [];

        // Act
        A2UIRecoveryResult result = await A2UIGenerationRecovery.RunAsync(
            "P",
            (prompt, attempt, ct) =>
            {
                calls.Add(attempt);
                return new ValueTask<JsonObject?>(CreateArgs(CreateGoodCard()));
            },
            BuildEnvelope,
            CreateCatalog());

        // Assert
        Assert.True(result.Ok);
        A2UIAttemptRecord record = Assert.Single(result.Attempts);
        Assert.True(record.Ok);
        Assert.Equal([1], calls);
        JsonObject envelope = Assert.IsType<JsonObject>(JsonNode.Parse(result.Envelope));
        Assert.True(envelope.ContainsKey(A2UIConstants.A2UIOperationsKey));
    }

    [Fact]
    public async Task RunAsync_InvalidFirstAttempt_RetriesWithErrorFeedbackAsync()
    {
        // Arrange
        List<string> prompts = [];

        // Act
        A2UIRecoveryResult result = await A2UIGenerationRecovery.RunAsync(
            "P",
            (prompt, attempt, ct) =>
            {
                prompts.Add(prompt);
                return new ValueTask<JsonObject?>(CreateArgs(attempt == 1 ? CreateBadCard() : CreateGoodCard()));
            },
            BuildEnvelope,
            CreateCatalog());

        // Assert
        Assert.True(result.Ok);
        Assert.Equal(2, result.Attempts.Count);
        Assert.False(result.Attempts[0].Ok);
        Assert.True(result.Attempts[1].Ok);
        // The retry prompt carries the prior attempt's validation errors.
        Assert.Contains("rating", prompts[1]);
    }

    [Fact]
    public async Task RunAsync_AllAttemptsInvalid_ReturnsStructuredHardFailureAsync()
    {
        // Arrange
        List<A2UIAttemptRecord> seen = [];

        // Act
        A2UIRecoveryResult result = await A2UIGenerationRecovery.RunAsync(
            "P",
            (prompt, attempt, ct) => new ValueTask<JsonObject?>(CreateArgs(CreateBadCard())),
            BuildEnvelope,
            CreateCatalog(),
            onAttempt: seen.Add);

        // Assert
        Assert.False(result.Ok);
        Assert.Equal(A2UIConstants.MaxA2UIAttempts, result.Attempts.Count);
        Assert.Equal(A2UIConstants.MaxA2UIAttempts, seen.Count);
        JsonObject envelope = Assert.IsType<JsonObject>(JsonNode.Parse(result.Envelope));
        Assert.Equal("a2ui_recovery_exhausted", (string?)envelope["code"]);
        Assert.False(string.IsNullOrEmpty((string?)envelope["error"]));
        Assert.IsType<JsonArray>(envelope["attempts"]);
    }

    [Fact]
    public async Task RunAsync_MaxAttemptsOverride_LimitsAttemptsAsync()
    {
        // Arrange
        List<int> calls = [];

        // Act
        A2UIRecoveryResult result = await A2UIGenerationRecovery.RunAsync(
            "P",
            (prompt, attempt, ct) =>
            {
                calls.Add(attempt);
                return new ValueTask<JsonObject?>(CreateArgs(CreateBadCard()));
            },
            BuildEnvelope,
            CreateCatalog(),
            new A2UIRecoveryConfig { MaxAttempts = 2 });

        // Assert
        Assert.False(result.Ok);
        Assert.Equal([1, 2], calls);
    }

    [Fact]
    public async Task RunAsync_MissingToolCall_IsRetryableAsync()
    {
        // Act
        A2UIRecoveryResult result = await A2UIGenerationRecovery.RunAsync(
            "P",
            (prompt, attempt, ct) => new ValueTask<JsonObject?>(
                attempt == 1 ? null : CreateArgs(CreateGoodCard())),
            BuildEnvelope,
            CreateCatalog());

        // Assert
        Assert.True(result.Ok);
        Assert.Equal(2, result.Attempts.Count);
        Assert.False(result.Attempts[0].Ok);
    }
}
