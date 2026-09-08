// Polyfill of the C# 15 union marker attribute for target frameworks whose BCL does
// not ship it yet. When System.Runtime.CompilerServices.UnionAttribute ships in the
// .NET 11 BCL, this internal copy is excluded for that TFM so the framework type is
// used instead (the same pattern the runtime uses for IsExternalInit, etc.).
//
// A type marked with [Union] that follows the "basic union pattern" (a public Value
// member plus one single-parameter constructor per case type) is recognized as a real
// union by a C# 15+ compiler, gaining union conversions, pattern-match unwrapping and
// exhaustiveness, with no change to the type's source. Under older compilers the
// attribute is inert and the type behaves as an ordinary struct/class.
#if !NET11_0_OR_GREATER
namespace System.Runtime.CompilerServices
{
    [System.AttributeUsage(System.AttributeTargets.Class | System.AttributeTargets.Struct, AllowMultiple = false)]
    internal sealed class UnionAttribute : System.Attribute
    {
    }
}
#endif
