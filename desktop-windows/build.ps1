# Builds Lasso for Windows - a self-contained notification-area application
# that bundles the server code and runs it locally on demand.
#
# The counterpart of desktop/build.sh. Like the macOS build it bundles the
# server and interface but does not bundle Node: Node must remain installed,
# and LASSO_NODE selects which executable the application uses.
#
# Output: dist/windows/Lasso/

[CmdletBinding()]
param(
    [string]$Configuration = 'Release',
    [string]$Runtime = 'win-x64',
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$dist = Join-Path $root 'dist/windows/Lasso'
$appFolder = Join-Path $dist 'app'

function Step($message) { Write-Host "==> $message" }

# --- Node ---------------------------------------------------------------

$nodePath = $env:LASSO_NODE
if (-not $nodePath) { $nodePath = $env:COLAB_NODE }
if (-not $nodePath) {
    $found = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($found) { $nodePath = $found.Source }
}
if (-not $nodePath) {
    foreach ($candidate in @(
        (Join-Path $env:ProgramFiles 'nodejs/node.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'nodejs/node.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs/nodejs/node.exe'))) {
        if (Test-Path $candidate) { $nodePath = $candidate; break }
    }
}
if (-not $nodePath) {
    throw 'node.exe was not found. Install Node 24+ or set LASSO_NODE to its path.'
}
# Recorded after publishing, beside the executable.
$script:ResolvedNode = $nodePath
Write-Host "==> Using node: $nodePath"

# --- Application icon ---------------------------------------------------

Step 'Drawing the application icon'
$assets = Join-Path $here 'src/Lasso.Windows/Assets'
New-Item -ItemType Directory -Force -Path $assets | Out-Null
Add-Type -AssemblyName PresentationCore, PresentationFramework, WindowsBase
$iconScript = Join-Path $here 'tools/write-icon.ps1'
& $iconScript -OutputPath (Join-Path $assets 'lasso.ico')

# --- Tests --------------------------------------------------------------

if (-not $SkipTests) {
    Step 'Running host logic tests'
    & dotnet run --project (Join-Path $here 'tests/Lasso.Core.Tests/Lasso.Core.Tests.csproj') `
        -c $Configuration --nologo
    if ($LASTEXITCODE -ne 0) { throw 'Host logic tests failed.' }

    Step 'Running application tests'
    Push-Location $root
    try {
        & $nodePath --disable-warning=ExperimentalWarning --test
        if ($LASTEXITCODE -ne 0) { throw 'Application tests failed.' }
    } finally {
        Pop-Location
    }
}

# --- Build --------------------------------------------------------------

Step 'Cleaning previous build'
if (Test-Path $dist) { Remove-Item -Recurse -Force $dist }
New-Item -ItemType Directory -Force -Path $appFolder | Out-Null

Step 'Compiling the local PDF drawing reader'
$helperOutput = Join-Path $here 'artifacts/drawing-layout'
& dotnet publish (Join-Path $here 'src/Lasso.DrawingLayout/Lasso.DrawingLayout.csproj') `
    -c $Configuration -r $Runtime -o $helperOutput --nologo
if ($LASTEXITCODE -ne 0) { throw 'The drawing helper could not be published.' }

Step 'Publishing the application'
& dotnet publish (Join-Path $here 'src/Lasso.Windows/Lasso.Windows.csproj') `
    -c $Configuration -r $Runtime --self-contained true -o $dist --nologo
if ($LASTEXITCODE -ne 0) { throw 'The application could not be published.' }

# --- Bundle the server --------------------------------------------------

Step 'Recording the Node executable'
Set-Content -Path (Join-Path $dist 'node-path.txt') -Value $script:ResolvedNode -Encoding utf8 -NoNewline

Step 'Bundling the server'
foreach ($item in @('src', 'public', 'migrations', 'scripts', 'package.json', 'package-lock.json')) {
    $source = Join-Path $root $item
    if (-not (Test-Path $source)) { throw "Missing $item; run this from a complete checkout." }
    Copy-Item -Recurse -Force $source (Join-Path $appFolder $item)
}

Step 'Bundling the drawing reader beside the server'
Copy-Item -Force (Join-Path $helperOutput 'extract-drawing-layout.exe') `
    (Join-Path $appFolder 'scripts/extract-drawing-layout.exe')

Step 'Bundling the offline IFC geometry engine'
$modules = Join-Path $root 'node_modules'
if (-not (Test-Path (Join-Path $modules 'web-ifc/web-ifc-node.wasm'))) {
    throw 'IFC dependencies are missing. Run npm ci before building.'
}
$bundledModules = Join-Path $appFolder 'node_modules'
New-Item -ItemType Directory -Force -Path $bundledModules | Out-Null
foreach ($dependency in @('web-ifc', 'polygon-clipping', 'robust-predicates', 'splaytree')) {
    Copy-Item -Recurse -Force (Join-Path $modules $dependency) (Join-Path $bundledModules $dependency)
}

# The published helper is a build product; the Swift source is macOS-only.
Remove-Item -Force -ErrorAction SilentlyContinue `
    (Join-Path $appFolder 'scripts/extract-drawing-layout.swift')

Write-Host ''
Write-Host "Built: $dist"
Write-Host "Run it:     $(Join-Path $dist 'Lasso.exe')"
Write-Host 'Node.js 24+ must remain installed; set LASSO_NODE to choose which one.'
