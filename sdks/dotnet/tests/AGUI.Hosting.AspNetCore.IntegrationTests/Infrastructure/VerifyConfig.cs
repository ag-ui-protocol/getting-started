using System.Runtime.CompilerServices;
using DiffEngine;

namespace AGUI.Server.IntegrationTests;

internal static class VerifyConfig
{
    [ModuleInitializer]
    internal static void Initialize()
    {
        VerifierSettings.DontScrubDateTimes();
        DiffRunner.Disabled = true;

        // Tool-call arguments (and other nested JSON) are serialized to a string with
        // WriteIndented, which embeds Environment.NewLine *inside* that string value. That
        // makes the escaped newline platform-dependent ("\r\n" on Windows, "\n" on Linux),
        // so baselines captured on one OS fail on the other. Verify normalizes file line
        // endings but not newlines escaped inside string values, so normalize them here.
        VerifierSettings.AddScrubber(builder => builder.Replace("\\r\\n", "\\n"));
    }
}
