// Polyfill of System.Runtime.CompilerServices.CallerArgumentExpressionAttribute. Compiled only for
// target frameworks whose BCL does not ship it (netstandard2.0, net472); net8.0+ uses the BCL type.
// The C# compiler recognizes this attribute by name to populate caller-argument names.
namespace System.Runtime.CompilerServices
{
    [System.AttributeUsage(System.AttributeTargets.Parameter, AllowMultiple = false, Inherited = false)]
    internal sealed class CallerArgumentExpressionAttribute : System.Attribute
    {
        public CallerArgumentExpressionAttribute(string parameterName)
        {
            ParameterName = parameterName;
        }

        public string ParameterName { get; }
    }
}
