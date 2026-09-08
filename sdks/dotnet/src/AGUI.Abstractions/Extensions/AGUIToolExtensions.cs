using System.Collections.Generic;
using System.Linq;
using Microsoft.Extensions.AI;

namespace AGUI.Abstractions;

/// <summary>
/// Extension methods for converting between AG-UI tool definitions and <see cref="AITool"/> instances.
/// </summary>
public static class AGUIToolExtensions
{
    /// <summary>
    /// Converts a sequence of <see cref="AITool"/> instances to <see cref="AGUITool"/> definitions.
    /// Only <see cref="AIFunctionDeclaration"/> (and its subclass <see cref="AIFunction"/>) instances are converted;
    /// the actual executable implementation stays on the caller side.
    /// </summary>
    /// <param name="tools">The AI tools to convert.</param>
    /// <returns>A sequence of <see cref="AGUITool"/> definitions.</returns>
    public static IEnumerable<AGUITool> AsAGUITools(this IEnumerable<AITool> tools)
    {
        if (tools is null)
        {
            yield break;
        }

        foreach (var tool in tools)
        {
            if (tool is AIFunctionDeclaration function)
            {
                yield return new AGUITool
                {
                    Name = function.Name,
                    Description = function.Description,
                    Parameters = function.JsonSchema
                };
            }
        }
    }

    /// <summary>
    /// Converts a sequence of <see cref="AGUITool"/> instances to <see cref="AITool"/> declarations.
    /// These are declaration-only and cannot be invoked, as the actual implementation exists on the client side.
    /// </summary>
    /// <param name="tools">The AG-UI tool definitions.</param>
    /// <returns>A sequence of <see cref="AITool"/> declarations.</returns>
    public static IEnumerable<AITool> AsAITools(this IList<AGUITool> tools)
    {
        if (tools is null)
        {
            return Enumerable.Empty<AITool>();
        }

        return ConvertTools(tools);
    }

    private static IEnumerable<AITool> ConvertTools(IList<AGUITool> tools)
    {
        foreach (var tool in tools)
        {
            yield return AIFunctionFactory.CreateDeclaration(
                name: tool.Name,
                description: tool.Description,
                jsonSchema: tool.Parameters);
        }
    }
}
