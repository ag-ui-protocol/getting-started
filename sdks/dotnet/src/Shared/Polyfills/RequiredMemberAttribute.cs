// Polyfill enabling the 'required' modifier. Compiled only for target frameworks whose BCL does not
// ship System.Runtime.CompilerServices.RequiredMemberAttribute (netstandard2.0, net472); net8.0+
// uses the BCL type.
namespace System.Runtime.CompilerServices
{
    [System.AttributeUsage(
        System.AttributeTargets.Class | System.AttributeTargets.Struct |
        System.AttributeTargets.Field | System.AttributeTargets.Property,
        AllowMultiple = false,
        Inherited = false)]
    internal sealed class RequiredMemberAttribute : System.Attribute
    {
    }
}
