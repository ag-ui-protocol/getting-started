// Polyfill of CollectionBuilderAttribute for target frameworks whose BCL does not ship
// it (it was introduced in .NET 8). It lets a custom collection type be the target of a
// C# collection expression (e.g. `Content = [partA, partB]`) by pointing the compiler at
// a factory method that accepts a ReadOnlySpan of the element type.
#if NETSTANDARD2_0 || NET472
namespace System.Runtime.CompilerServices
{
    [System.AttributeUsage(
        System.AttributeTargets.Class | System.AttributeTargets.Struct,
        Inherited = false,
        AllowMultiple = false)]
    internal sealed class CollectionBuilderAttribute : System.Attribute
    {
        public CollectionBuilderAttribute(System.Type builderType, string methodName)
        {
            BuilderType = builderType;
            MethodName = methodName;
        }

        public System.Type BuilderType { get; }

        public string MethodName { get; }
    }
}
#endif
