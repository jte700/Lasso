# Alpha-v0 merge validation — October 19, 2026

Merged `origin/Alpha-v0` at `893a3c3` into `codex/mac-usb-drives` after checking the remote and confirming the starting checkout was clean and synchronized.

The latest pre-merge Windows CI run (39345740784) had two failures. Folder recovery converted Windows file IDs to JavaScript numbers, losing precision. It now compares bigint IDs, with a regression test using IDs above the safe integer range. The restart test now closes its reopened database before its fixture deletes temporary storage.

## Integration choices

- Preserve external-drive support, STEP CAD extraction, PDF.js fallback, spreadsheet coordinates, and financial statement sections.
- Include Alpha's Settings window, standard menu, accessibility and typography changes, indented spreadsheet row labels, and explicit source re-reading.
- Preserve both branch database upgrade paths and their regression tests.
- Record both spreadsheet format and reader versions in newly indexed snapshots. Reader version 2 identifies the combined reader.
- Keep the existing .NET 8 Windows package commands. Alpha's separate .NET 9 host is available through `desktop:windows:alpha` and `desktop:windows:alpha:test`.

## Verification

- Combined JavaScript suite: 568 passed, zero failures or skips.
- Combined Mac native suite: 397 checks passed.
- Signed Mac build completed and passed deep, strict signature verification.
- Packaged Node 24 server passed health, workspace, interface asset, and merged schema smoke checks using temporary data.
- Updated `/Applications/Lasso.app`; the previous app is backed up at `/Users/adelyasin/Documents/CoLabDry/dist/Lasso-before-alpha-20261019-202121.app`.
- No conflict markers or whitespace errors remain.

Windows CI must be rerun on GitHub after these commits are pushed. The separate Alpha Windows host has not been built or exercised on this Mac.
