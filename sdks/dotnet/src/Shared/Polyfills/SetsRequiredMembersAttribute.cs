// Polyfill of System.Diagnostics.CodeAnalysis.SetsRequiredMembersAttribute. Compiled only for target
// frameworks whose BCL does not ship it (netstandard2.0, net472); net8.0+ uses the BCL type. It tells
// the compiler that a constructor sets all 'required' members, so callers need not set them.
namespace System.Diagnostics.CodeAnalysis
{
    [System.AttributeUsage(System.AttributeTargets.Constructor, AllowMultiple = false, Inherited = false)]
    internal sealed class SetsRequiredMembersAttribute : System.Attribute
    {
    }
}
