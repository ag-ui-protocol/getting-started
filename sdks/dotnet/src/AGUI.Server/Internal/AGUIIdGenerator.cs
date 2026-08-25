using System.Security.Cryptography;

namespace AGUI.Server;

internal static class AGUIIdGenerator
{
    private const int DefaultEntropyLength = 24;
    private const string Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

    internal static string NewId(string? prefix = "id")
    {
        var entropy = GetRandomString(DefaultEntropyLength);
        return string.IsNullOrEmpty(prefix) ? entropy : $"{prefix}_{entropy}";
    }

    internal static string NewMessageId() => NewId("msg");

    private static string GetRandomString(int length)
    {
#if NET8_0_OR_GREATER
        return RandomNumberGenerator.GetString(Chars, length);
#else
        var bytes = new byte[length];
        using (var rng = RandomNumberGenerator.Create())
        {
            rng.GetBytes(bytes);
        }

        var result = new char[length];
        for (int i = 0; i < length; i++)
        {
            result[i] = Chars[bytes[i] % Chars.Length];
        }

        return new string(result);
#endif
    }
}
