# Windows preview validation — 2026-10-17

Validation was performed on macOS. This is a cross-compiled Windows preview, not a Windows execution certification.

- WPF/WebView2 application: .NET SDK 8.0.426 Release build and self-contained win-x64 publish succeeded, with zero compiler warnings/errors.
- Shared application suite: 258 tests passed, zero failures. A subsequently added occupied-port regression also passed with the other three desktop lifecycle checks.
- Windows assistance logic: 13 checks passed for completion boundaries, Unicode safety, readback verification, and pinned source identity.
- Browser: six end-to-end workflow groups passed against an isolated real engine/project, with no browser exceptions. Covered source browsing, default non-publishing inspection, redacted share creation/revocation, light/dark settings, changes/share/review navigation, editing and disk saves, Windows path prompts, Ctrl+K search, and Ctrl+Shift+P palette.
- Package: Windows x64 PE executables verified for Lasso and Node; native x64 canvas renderer and offline IFC/PDF assets verified. The ZIP is CRC-checked and accompanied by SHA-256 and per-file manifest. No local history, user projects, credentials, or logs are packaged.

Screenshots show the Windows workspace rendered in Chrome on macOS with isolated sample data. They do not show the native Windows title bar or certify installed Segoe fonts. The Windows host uses the real OS title bar.

Run the Windows workflow and the live application checks in [the Windows guide](../../../desktop/windows/README.md) before rollout. The preview remains unsigned. Persistent external-document highlights and rich shared-link insertion are still absent; external provenance is available through the local Recent inserted sources ledger.

## Reproduce

```sh
npm test
npm run desktop:windows:test
npm run desktop:windows:test:ui
```

The native assistant logic test requires a .NET 8 SDK. Browser validation requires Chrome, with `CHROME_PATH` supported. Use `pwsh -NoProfile -File desktop/windows/build.ps1` on Windows to run the native package smoke test.
