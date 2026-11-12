# Releasing Lasso

The downloads on the website come from GitHub releases. A release is made by
pushing a version tag. Merges and pushes to `main` don't need anything else:
the release workflow takes the version from the tag and has no file lists or
version numbers to keep up to date.

## Making a release

```bash
git tag v1.2.0
git push origin v1.2.0
```

The **Release** workflow (`.github/workflows/release.yml`) then:

1. Runs the server tests on macOS.
2. Builds the Mac app for Apple silicon and Intel, signs it with the Developer ID,
   has Apple notarize it, and packs it into `Lasso.dmg`.
3. Builds the Windows app on x64 and on Arm, runs the Windows tests and the
   packaged smoke test, and makes `Lasso-Setup.exe` and `Lasso-Setup-arm64.exe`.
4. Publishes all three with a `SHA256SUMS.txt` as the `v1.2.0` release.

It takes about 30 to 45 minutes. A tag with a suffix, such as `v1.2.0-beta.1`,
becomes a pre-release, which the website's links skip. To try a branch without
publishing anything, open **Actions → Release → Run workflow** and download the
builds from the run.

## The website's links

These always serve the newest published release, so the site never changes
between releases:

| Download | Link |
| --- | --- |
| Mac (Apple silicon and Intel) | `https://github.com/jte700/Lasso/releases/latest/download/Lasso.dmg` |
| Windows (x64, also runs on Windows 11 on Arm) | `https://github.com/jte700/Lasso/releases/latest/download/Lasso-Setup.exe` |
| Windows 11 on Arm, native | `https://github.com/jte700/Lasso/releases/latest/download/Lasso-Setup-arm64.exe` |

## What each download needs

| | Mac | Windows |
| --- | --- | --- |
| System | macOS 13.5 or later | Windows 10 version 1809 or later, 64-bit |
| Processor | Apple silicon or Intel, one app for both | x64; Arm runs either installer |
| Installs | Drag Lasso to Applications | Installs for the current user, no administrator rights, Start menu entry |
| Also installs | Nothing: Node.js is inside the app | Microsoft Edge WebView2, only if Windows lacks it |
| Updating | Download the new version and replace the app | Run the new installer; it updates in place and keeps data |
| User data | `~/Library/Application Support/Lasso` | `%LOCALAPPDATA%\Lasso`, kept when Lasso is uninstalled |

## One-time setup: signing

Add these in **GitHub → Settings → Secrets and variables → Actions**, or with
`gh secret set NAME`.

### Mac (needed for a published release)

Without these, the release is saved as a draft, so the website never serves a
Mac build that macOS would refuse to open.

1. Join the [Apple Developer Program](https://developer.apple.com/programs/)
   ($99 a year).
2. Create a **Developer ID Application** certificate (Xcode → Settings →
   Accounts → Manage Certificates → +). In Keychain Access, export it with its
   private key as a `.p12` file with a password.
3. In App Store Connect → Users and Access → Integrations → App Store Connect API,
   create a key with Developer access. Download the `.p8` file once, and note
   its Key ID and the Issuer ID.

| Secret | Value |
| --- | --- |
| `MAC_CERTIFICATE_P12_BASE64` | `base64 -i DeveloperID.p12` |
| `MAC_CERTIFICATE_PASSWORD` | the `.p12` password |
| `APPLE_API_KEY_P8_BASE64` | `base64 -i AuthKey_XXXXXXXXXX.p8` |
| `APPLE_API_KEY_ID` | the key's ID |
| `APPLE_API_ISSUER_ID` | the issuer ID |

### Windows (optional)

Without these the installers still work, but Windows SmartScreen shows
"Windows protected your PC" until people click **More info → Run anyway**.
Signing uses [Azure Artifact Signing](https://learn.microsoft.com/azure/artifact-signing/)
(formerly Trusted Signing), since code-signing certificates can no longer be
kept as files.

| Secret | Value |
| --- | --- |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | an app registration with the Artifact Signing Certificate Profile Signer role |
| `AZURE_SIGNING_ENDPOINT` | the account's region endpoint, such as `https://eus.codesigning.azure.net/` |
| `AZURE_SIGNING_ACCOUNT` | the signing account's name |
| `AZURE_CERTIFICATE_PROFILE` | the certificate profile's name |

## Building a download on your own machine

Mac, written to `dist/release/` without touching `dist/Lasso.app`:

```bash
npm run release:mac
```

With no signing variables it is ad-hoc signed, for testing only. To sign and
notarize locally, set `LASSO_SIGN_IDENTITY` and either `LASSO_NOTARY_KEY_PATH`,
`LASSO_NOTARY_KEY_ID` and `LASSO_NOTARY_ISSUER`, or `LASSO_NOTARY_APPLE_ID`,
`LASSO_NOTARY_PASSWORD` and `LASSO_NOTARY_TEAM_ID` (see the top of
`desktop/release-mac.sh`).

Windows, in PowerShell 7 with the .NET 8 SDK and Inno Setup 6:

```powershell
./desktop/windows/build.ps1 -Architecture x64 -NoArchive
./desktop/windows/package-installer.ps1 -Architecture x64
```

## What is pinned, and when to change it

- **Node.js**: `desktop/windows/runtime-lock.json` names the version both apps
  bundle, with the Windows checksums. The Mac build checks its downloads
  against nodejs.org's checksums for that version. Change it only to move to a
  newer Node.js.
- **Inno Setup**: version 6.7.4, pinned by checksum in
  `desktop/windows/package-installer.ps1`.
- **Runners**: the Mac build needs the macOS 26 SDK and runs on `macos-26`.

## Limits

- One Mac icon style per build. Releases use the macOS 26 style, which shows
  square corners on macOS 13 to 15. Set `LASSO_ICON_STYLE=squircle` for the
  older look.
- There is no automatic update yet. People download a new version from the site.
- The server tests run before every release. If a known flaky test fails, re-run
  the job.
