# Optional per-user installation of an extracted Lasso Windows package.
# No elevation, registry autorun, or data migration is performed.
[CmdletBinding()]
param([switch]$Uninstall, [switch]$DesktopShortcut)
$ErrorActionPreference = 'Stop'
$InstallRoot = Join-Path $env:LOCALAPPDATA 'Programs/Lasso'
$Programs = [Environment]::GetFolderPath('Programs')
$StartLink = Join-Path $Programs 'Lasso.lnk'
$DesktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Lasso.lnk'
$Executable = Join-Path $InstallRoot 'Lasso.exe'
$Running = Get-Process Lasso -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Executable }
if ($Running) { throw 'Quit Lasso from its notification-area icon before installing or uninstalling.' }
if ($Uninstall) {
    if (Test-Path $InstallRoot) { Remove-Item $InstallRoot -Recurse -Force }
    foreach ($Link in @($StartLink, $DesktopLink)) { if (Test-Path $Link) { Remove-Item $Link -Force } }
    Write-Host 'Lasso was removed. Your projects and settings remain in %LOCALAPPDATA%\Lasso.'
    return
}
if (-not (Test-Path (Join-Path $PSScriptRoot 'Lasso.exe'))) { throw 'Run install.ps1 from the extracted Windows package.' }
if ([IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') -eq [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')) {
    throw 'Install from the extracted download, outside the installation folder.'
}
$Stage = "$InstallRoot.new"
$Backup = "$InstallRoot.previous"
try {
    if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $Stage | Out-Null
    Copy-Item (Join-Path $PSScriptRoot '*') -Destination $Stage -Recurse -Force
    if (Test-Path $Backup) { Remove-Item $Backup -Recurse -Force }
    if (Test-Path $InstallRoot) { Move-Item $InstallRoot $Backup }
    Move-Item $Stage $InstallRoot
    $Shell = New-Object -ComObject WScript.Shell
    $Links = @($StartLink)
    if ($DesktopShortcut) { $Links += $DesktopLink }
    foreach ($Link in $Links) {
        $Shortcut = $Shell.CreateShortcut($Link)
        $Shortcut.TargetPath = $Executable
        $Shortcut.WorkingDirectory = $InstallRoot
        $Shortcut.IconLocation = "$Executable,0"
        $Shortcut.Description = 'Lasso workspace and writing assistant'
        $Shortcut.Save()
    }
    if (Test-Path $Backup) { Remove-Item $Backup -Recurse -Force }
    Write-Host "Installed Lasso. Open it from Start, or run $Executable"
} catch {
    if ((Test-Path $Backup) -and -not (Test-Path $InstallRoot)) { Move-Item $Backup $InstallRoot }
    throw
} finally {
    if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
}
