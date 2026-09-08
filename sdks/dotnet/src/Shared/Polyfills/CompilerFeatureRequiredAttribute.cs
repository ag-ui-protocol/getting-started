// Polyfill required by the compiler when emitting members that use the 'required' modifier. Compiled
// only for target frameworks whose BCL does not ship
// System.Runtime.CompilerServices.CompilerFeatureRequiredAttribute (netstandard2.0, net472);
// net8.0+ uses the BCL type.
namespace System.Runtime.CompilerServices
{
    [System.AttributeUsage(System.AttributeTargets.All, AllowMultiple = true, Inherited = false)]
    internal sealed class CompilerFeatureRequiredAttribute : System.Attribute
    {
        public CompilerFeatureRequiredAttribute(string featureName)
        {
            FeatureName = featureName;
        }

        public string FeatureName { get; }

        public bool IsOptional { get; init; }

        public const string RefStructs = nameof(RefStructs);

        public const string RequiredMembers = nameof(RequiredMembers);
    }
}
