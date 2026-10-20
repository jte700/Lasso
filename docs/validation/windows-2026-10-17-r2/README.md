# Windows 1.0.1 / r2 validation

The reported `income-statement.xlsx` was read through the production extractor in isolated temporary history. The file and its snapshots were not added to the repository or release package. The reproduction returned five revenue alternatives, five source-scoped follow-ups, and the exact SingleStep!D5 cell with its 2020 heading. The input SHA-256 and non-sensitive result summary are in `workbook-results.json`.

Changes cover formatted empty Excel cells/rows, label-only variable acceptance, exact-match linking, claim-range replacement, transient UIA read failures, standard Windows list-box suggestions, verified clickable text highlights, source-scoped follow-ups and explicit rich-link insertion. The workspace is more compact and uses simpler Windows styling.

Checks performed on macOS:

- 261 application tests passed, including legacy-index retention and corrected source-preview coordinates.
- 31 Windows pure-logic checks passed for completion plans, source anchors, five suggestions and Unicode HTML clipboard formatting.
- 107 Mac regression checks passed.
- Six shared-workspace browser workflow groups passed without browser exceptions. Screenshots here are the workspace rendered in Chrome on macOS; they do not show the WPF popup or Windows title bar.
- Windows WPF host and separate browser interaction harness compile successfully. Self-contained win-x64 publish completed.
- Release assembly/runtime architecture, package manifest, ZIP CRC and SHA-256 are checked separately in `package-results.json`.

Not performed here: launching the app on Windows; real Windows Chrome/Edge UI Automation interaction, physical keyboard-hook delivery, hyperlink paste, DPI/monitor behavior or installer verification. The executable is unsigned. These results do not certify exact Mac/Windows parity.

Run the live Windows browser harness on a Windows desktop:

```powershell
dotnet run --project desktop/windows/BrowserTests/Lasso.BrowserTests.csproj -- edge
dotnet run --project desktop/windows/BrowserTests/Lasso.BrowserTests.csproj -- chrome
```

The harness uses synthetic sources and an isolated browser profile. It covers textareas, inputs and contenteditable fields; idle popup persistence; five alternatives; verified acceptance; clickable source geometry; and follow-up context. It invokes acceptance directly, so physical shortcut delivery and rich paste require additional live checks. See [Windows guide](../../../desktop/windows/README.md).

For the updated package, quit the earlier app from its tray menu, extract `Lasso-win-x64-r2.zip` into a fresh folder and run `Lasso.exe`. Existing project history is retained; spreadsheet indexing is repaired lazily on access.

Implementation references: [Microsoft UI Automation text ranges](https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/find-and-highlight-text-using-ui-automation) and [Windows mouse activation](https://learn.microsoft.com/en-us/windows/win32/inputdev/about-mouse-input).
