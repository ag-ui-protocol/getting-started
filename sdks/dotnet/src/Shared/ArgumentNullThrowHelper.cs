// Adapted from dotnet/runtime's shared ArgumentNullThrowHelper. Call sites use a single null
// check that maps to ArgumentNullException.ThrowIfNull on modern targets and to a manual throw on
// netstandard2.0/net472, whose BCL does not ship the helper. On those targets the paired
// CallerArgumentExpressionAttribute polyfill supplies the parameter name.
using System.Runtime.CompilerServices;

namespace System
{
    internal static class ArgumentNullThrowHelper
    {
        public static void ThrowIfNull(
            object? argument,
            [CallerArgumentExpression(nameof(argument))] string? paramName = null)
        {
#if NET
            ArgumentNullException.ThrowIfNull(argument, paramName);
#else
            if (argument is null)
            {
                throw new ArgumentNullException(paramName);
            }
#endif
        }
    }
}
