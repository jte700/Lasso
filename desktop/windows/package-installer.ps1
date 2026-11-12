# Makes the Windows download from a folder build.ps1 packaged: Lasso-Setup.exe
# for x64 (which also runs on Windows 11 on Arm) or Lasso-Setup-arm64.exe.
#
#   pwsh -File desktop/windows/build.ps1 -Architecture x64 -NoArchive
#   pwsh -File desktop/windows/package-installer.ps1 -Architecture x64
#
# The version comes from the release tag, or -Version, or package.json, so
# nothing here changes from one release to the next. Needs Inno Setup 6;
# -InstallInnoSetup installs it for the current user first (the release
# workflow does this on a fresh machine).
[CmdletBinding()]
param(
    [ValidateSet('x64', 'arm64')][string]$Architecture = 'x64',
    [string]$Version = '',
    [string]$PackageDir = '',
    [string]$OutputDir = '',
    [switch]$InstallInnoSetup
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'Run this script in PowerShell 7 on Windows.' }
$Root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
if (-not $PackageDir) { $PackageDir = Join-Path $Root "dist/windows/Lasso-win-$Architecture" }
if (-not $OutputDir) { $OutputDir = Join-Path $Root 'dist/windows' }
$Cache = Join-Path $Root 'dist/windows/.cache'
New-Item -ItemType Directory -Force -Path $Cache, $OutputDir | Out-Null
if (-not (Test-Path (Join-Path $PackageDir 'Lasso.exe'))) {
    throw "No packaged Lasso in $PackageDir. Run build.ps1 -Architecture $Architecture -NoArchive first."
}

function Assert-Exit([string]$Operation) {
    if ($LASTEXITCODE -ne 0) { throw "$Operation failed with exit code $LASTEXITCODE." }
}
# A downloaded installer runs only when its publisher's signature checks out.
function Assert-Signed([string]$Path, [string]$Publisher) {
    $Signature = Get-AuthenticodeSignature $Path
    if ($Signature.Status -ne 'Valid' -or $Signature.SignerCertificate.Subject -notmatch [regex]::Escape($Publisher)) {
        Remove-Item $Path -Force
        throw "$([IO.Path]::GetFileName($Path)) is not signed by $Publisher, so it was deleted."
    }
}

if (-not $Version) {
    $Tag = git -C $Root describe --tags --exact-match 2>$null
    $Version = if ($LASTEXITCODE -eq 0 -and $Tag) { $Tag } else { (Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json).version }
}
$Numeric = ($Version -replace '^v', '') -replace '-.*$', ''
if ($Numeric -notmatch '^\d+(\.\d+){0,3}$') { throw "The version must look like 1.2.3, not '$Version'." }

# Microsoft's small WebView2 installer, run only on machines without WebView2.
$WebView2Setup = Join-Path $Cache 'MicrosoftEdgeWebview2Setup.exe'
if (-not (Test-Path $WebView2Setup)) {
    Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $WebView2Setup
}
Assert-Signed $WebView2Setup 'O=Microsoft Corporation'

$InnoFolders = @(
    (Join-Path $env:LOCALAPPDATA 'Programs/Inno Setup 6'),
    (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6'),
    (Join-Path $env:ProgramFiles 'Inno Setup 6')
)
function Find-Iscc {
    $OnPath = Get-Command iscc.exe -ErrorAction SilentlyContinue
    if ($OnPath) { return $OnPath.Source }
    foreach ($Folder in $InnoFolders) {
        $Candidate = Join-Path $Folder 'ISCC.exe'
        if (Test-Path $Candidate) { return $Candidate }
    }
    return $null
}
$Iscc = Find-Iscc
if (-not $Iscc -and $InstallInnoSetup) {
    # A fixed Inno Setup release, checked by its hash and its publisher's signature.
    $InnoSetup = Join-Path $Cache 'innosetup-6.7.4.exe'
    $InnoSetupSha256 = 'a549929319f9120716677c685535ca4671e4b937b5fdc87e2585f32d8eb30e8c'
    if (-not (Test-Path $InnoSetup) -or (Get-FileHash $InnoSetup -Algorithm SHA256).Hash.ToLowerInvariant() -ne $InnoSetupSha256) {
        Invoke-WebRequest -Uri 'https://github.com/jrsoftware/issrc/releases/download/is-6_7_4/innosetup-6.7.4.exe' -OutFile $InnoSetup
    }
    if ((Get-FileHash $InnoSetup -Algorithm SHA256).Hash.ToLowerInvariant() -ne $InnoSetupSha256) {
        Remove-Item $InnoSetup -Force
        throw 'The Inno Setup download does not match its known checksum, so it was deleted.'
    }
    Assert-Signed $InnoSetup 'Pyrsys B.V.'
    $Install = Start-Process -FilePath $InnoSetup -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CURRENTUSER' -PassThru -Wait
    if ($Install.ExitCode -ne 0) { throw "Installing Inno Setup failed with exit code $($Install.ExitCode)." }
    $Iscc = Find-Iscc
}
if (-not $Iscc) { throw 'Inno Setup 6 is needed. Install it from https://jrsoftware.org/isinfo.php or run with -InstallInnoSetup.' }

$Name = if ($Architecture -eq 'x64') { 'Lasso-Setup' } else { 'Lasso-Setup-arm64' }
& $Iscc /Qp "/DAppVersion=$Numeric" "/DArch=$Architecture" "/DPackageDir=$((Resolve-Path $PackageDir).Path)" `
    "/DOutputDir=$((Resolve-Path $OutputDir).Path)" "/DOutputName=$Name" "/DWebView2Setup=$WebView2Setup" `
    (Join-Path $PSScriptRoot 'installer.iss')
Assert-Exit 'Compiling the installer'

$Installer = Join-Path $OutputDir "$Name.exe"
$Hash = (Get-FileHash $Installer -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -Path "$Installer.sha256" -Value "$Hash  $Name.exe" -Encoding utf8NoBOM
Write-Host "Built $Installer"
