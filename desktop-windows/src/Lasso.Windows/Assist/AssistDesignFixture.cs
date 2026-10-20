//  Deterministic render used only when LASSO_OVERLAY_FIXTURE=1.
//
//  The macOS build carries the same fixture for the same reason: keeping it
//  beside the production panel makes visual checks exercise the exact drawing,
//  material, and sizing path users receive, with no host application, no server,
//  and no project data involved. The values match the macOS fixture so the two
//  platforms can be compared side by side.

using Lasso.Core;

namespace Lasso.Windows.Assist;

internal static class AssistDesignFixture
{
    public static AssistFlyout Show()
    {
        var flyout = new AssistFlyout();
        var panel = flyout.Panel;

        panel.Mode = AssistMode.Suggestions;
        panel.Selected = 0;
        panel.SourceScoped = true;
        panel.Suggestions =
        [
            Suggestion("Office supplies", "$400", "/Accounting/Income-Statement.xlsx",
                "Accounting!B21", "fixture-1"),
            Suggestion("Office supplies budget", "$420", "/Expenses/Budget-Plan.xlsx",
                "Expenses!B18", "fixture-2"),
            Suggestion("Office supplies actual", "$375", "/History/Historical-Expenses.xlsx",
                "Sheet1!C9", "fixture-3"),
            Suggestion("Supplies account", "6110", "/Accounting/Chart-of-Accounts.pdf",
                "p. 6", "fixture-4"),
        ];
        panel.Preview = new AssistDocumentPreview(
            Filename: "Income-Statement.xlsx",
            Path: "/Accounting/Income-Statement.xlsx",
            Location: "Accounting!B21",
            Context: "Office supplies",
            ValueText: "$400",
            ObjectType: "SPREADSHEET_CELL",
            SnapshotVersion: 1,
            Columns: ["A", "B", "D", "F"],
            Headers: ["", "Current Period", "Prior Period", "Increase (Decrease)"],
            Rows:
            [
                Row(18, ("Payroll Taxes", false), ("225", false), ("215", false), ("10", false)),
                Row(19, ("Depreciation-Direct", false), ("612", false), ("612", false), ("0", false)),
                Row(20, ("Office Supplies", false), ("400", true), ("310", false), ("90", false)),
                Row(21, ("Utilities", false), ("180", false)),
                Row(22, ("", false), ("", false)),
            ]);
        panel.IsPreviewLoading = false;

        flyout.Show();
        // Centred on the primary work area, where a screenshot can find it.
        var work = System.Windows.SystemParameters.WorkArea;
        flyout.Width = panel.PanelWidth;
        flyout.Height = panel.PanelHeight;
        flyout.Left = work.Left + (work.Width - panel.PanelWidth) / 2;
        flyout.Top = work.Top + (work.Height - panel.PanelHeight) / 2;
        panel.Refresh();
        return flyout;
    }

    private static AssistSuggestion Suggestion(string label, string detail, string path,
        string location, string objectId) =>
        new(InsertText: label, Label: label, Detail: detail, Path: path, Location: location,
            ReplaceFrom: null, ObjectId: objectId, VersionId: "v1", SnapshotId: "s1",
            UsageObjectId: null, ProjectId: "fixture", RankingReason: null);

    private static AssistPreviewRow Row(int number, params (string Value, bool Cited)[] cells) =>
        new(number, cells.Select(cell => new AssistPreviewCell(cell.Value, cell.Cited)).ToList());
}
