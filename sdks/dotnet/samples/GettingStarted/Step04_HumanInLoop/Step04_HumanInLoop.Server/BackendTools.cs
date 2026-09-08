using System.ComponentModel;

namespace Step04_HumanInLoop.Server;

internal static class BackendTools
{
    [Description("Approve the expense report.")]
    internal static string ApproveExpenseReport(
        [Description("The expense report ID to approve")] string expenseReportId)
    {
        return $"Expense report {expenseReportId} has been approved and processed.";
    }
}
