# Build on Windows with PowerShell 7 and the .NET 8 SDK.
# The published app includes .NET, Node, and Windows-native production packages.
[CmdletBinding()]
param(
    [ValidateSet('x64', 'arm64')][string]$Architecture = 'x64',
    [ValidateSet('Release', 'Debug')][string]$Configuration = 'Release',
    [switch]$SkipTests,
    [switch]$NoArchive
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'Run this script in PowerShell 7 on Windows.' }
$Root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$BuildRoot = Join-Path $Root 'dist/windows'
$Output = Join-Path $BuildRoot "Lasso-win-$Architecture"
$Stage = Join-Path $BuildRoot ('.stage-' + [Guid]::NewGuid().ToString('N'))
$Cache = Join-Path $BuildRoot '.cache'
$RuntimeLock = Get-Content (Join-Path $PSScriptRoot 'runtime-lock.json') -Raw | ConvertFrom-Json
$OriginalPath = $env:PATH
New-Item -ItemType Directory -Force -Path $Stage, $Cache | Out-Null

function Assert-Exit([string]$Operation) {
    if ($LASTEXITCODE -ne 0) { throw "$Operation failed with exit code $LASTEXITCODE." }
}
function Get-NodeRuntime([string]$TargetArchitecture) {
    $Entry = $RuntimeLock.archives.$TargetArchitecture
    $Archive = Join-Path $Cache $Entry.file
    if (-not (Test-Path $Archive)) {
        Invoke-WebRequest -Uri "https://nodejs.org/dist/v$($RuntimeLock.nodeVersion)/$($Entry.file)" -OutFile $Archive
    }
    $Actual = (Get-FileHash $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($Actual -ne $Entry.sha256) {
        Remove-Item $Archive -Force
        throw "Node runtime checksum mismatch for $($Entry.file). The unverified download was removed."
    }
    $Folder = Join-Path $Cache "node-v$($RuntimeLock.nodeVersion)-win-$TargetArchitecture"
    # Always extract the verified archive; do not trust an old extracted cache.
    if (Test-Path $Folder) { Remove-Item $Folder -Recurse -Force }
    Expand-Archive $Archive -DestinationPath $Cache -Force
    return $Folder
}

try {
    $null = Get-Command dotnet -ErrorAction Stop
    $HostArchitecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
    if ($HostArchitecture -notin @('x64', 'arm64')) { throw 'A 64-bit Windows build machine is required.' }
    $HostNode = Get-NodeRuntime $HostArchitecture
    $TargetNode = if ($Architecture -eq $HostArchitecture) { $HostNode } else { Get-NodeRuntime $Architecture }
    $env:PATH = "$HostNode;$OriginalPath"
    $Node = Join-Path $HostNode 'node.exe'
    $NpmCli = Join-Path $HostNode 'node_modules/npm/bin/npm-cli.js'
    $App = Join-Path $Stage 'app'
    New-Item -ItemType Directory -Force -Path $App | Out-Null

    # Explicit allowlist: never bundle .lasso-data, credentials, .git, logs,
    # the developer's node_modules, or the rest of their working directory.
    foreach ($Item in @('src', 'public', 'migrations', 'scripts', 'package.json', 'package-lock.json')) {
        Copy-Item (Join-Path $Root $Item) -Destination $App -Recurse
    }
    # macOS helper binaries cannot execute on Windows; portable readers are in src.
    Get-ChildItem (Join-Path $App 'scripts') -File | Where-Object { $_.Extension -eq '' -or $_.Name -like 'validate-windows-*.mjs' } | Remove-Item -Force
    & $Node $NpmCli ci --prefix $App --omit=dev --include=optional "--os=win32" "--cpu=$Architecture" --no-audit --no-fund
    Assert-Exit 'Installing Windows production dependencies'
    if (-not (Test-Path (Join-Path $App 'node_modules/web-ifc/web-ifc-node.wasm'))) { throw 'Offline IFC engine was not installed.' }
    if (-not (Test-Path (Join-Path $App "node_modules/@napi-rs/canvas-win32-$Architecture-msvc"))) { throw 'Windows PDF renderer was not installed for the target architecture.' }

    if (-not $SkipTests) {
        if ($Architecture -ne $HostArchitecture) { throw 'Cross-architecture packaging requires -SkipTests; validate that artifact on a native Windows machine before release.' }
        Copy-Item (Join-Path $Root 'test') -Destination $App -Recurse
        Push-Location $App
        try {
            & $Node --disable-warning=ExperimentalWarning --test
            Assert-Exit 'Application tests'
        } finally { Pop-Location }
        Remove-Item (Join-Path $App 'test') -Recurse -Force
        & dotnet run --project (Join-Path $PSScriptRoot 'Assist/tests/Lasso.Assist.LogicTests.csproj') --configuration $Configuration
        Assert-Exit 'Windows assist logic tests'
        & dotnet build (Join-Path $PSScriptRoot 'BrowserTests/Lasso.BrowserTests.csproj') --configuration $Configuration
        Assert-Exit 'Windows browser regression harness build'
    }

    & dotnet publish (Join-Path $PSScriptRoot 'Lasso.Windows.csproj') --configuration $Configuration --runtime "win-$Architecture" --self-contained true -p:PublishSingleFile=false -p:PublishTrimmed=false --output $Stage
    Assert-Exit 'Windows desktop publish'
    $Runtime = Join-Path $Stage 'runtime'
    New-Item -ItemType Directory -Force -Path $Runtime | Out-Null
    Copy-Item (Join-Path $TargetNode 'node.exe') $Runtime
    Copy-Item (Join-Path $TargetNode 'LICENSE') (Join-Path $Runtime 'NODE-LICENSE.txt')
    Copy-Item (Join-Path $PSScriptRoot 'install.ps1') $Stage
    Copy-Item (Join-Path $PSScriptRoot 'README.md') (Join-Path $Stage 'WINDOWS-README.md')
    Copy-Item (Join-Path $PSScriptRoot 'runtime-lock.json') $Stage

    if (-not $SkipTests) {
        $Smoke = Start-Process -FilePath (Join-Path $Stage 'Lasso.exe') -ArgumentList '--smoke-test' -PassThru
        if (-not $Smoke.WaitForExit(45000)) { $Smoke.Kill($true); throw 'Packaged server smoke test timed out.' }
        if ($Smoke.ExitCode -ne 0) { throw 'Packaged server smoke test failed. See %LOCALAPPDATA%\Lasso\logs\lasso.log.' }
    }
    if (Test-Path $Output) { Remove-Item $Output -Recurse -Force }
    Move-Item $Stage $Output
    if (-not $NoArchive) {
        $Archive = "$Output.zip"
        if (Test-Path $Archive) { Remove-Item $Archive -Force }
        Compress-Archive -Path $Output -DestinationPath $Archive -CompressionLevel Optimal
        $Hash = (Get-FileHash $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
        Set-Content -Path "$Archive.sha256" -Value "$Hash  $([IO.Path]::GetFileName($Archive))" -Encoding utf8NoBOM
        Write-Host "Built $Archive"
    }
    Write-Host "Launch $(Join-Path $Output 'Lasso.exe')"
} finally {
    $env:PATH = $OriginalPath
    if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
}
