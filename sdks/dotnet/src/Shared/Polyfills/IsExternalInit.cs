// Polyfill enabling 'init' accessors. Compiled only for target frameworks whose BCL does not ship
// System.Runtime.CompilerServices.IsExternalInit (netstandard2.0, net472); net8.0+ uses the BCL type.
namespace System.Runtime.CompilerServices
{
    [System.ComponentModel.EditorBrowsable(System.ComponentModel.EditorBrowsableState.Never)]
    internal static class IsExternalInit
    {
    }
}
