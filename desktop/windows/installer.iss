; The Windows download. It installs Lasso for the person running it, without
; administrator rights, on Windows 10 (1809) or later, adds it to the Start
; menu and installs Microsoft Edge WebView2 when Windows does not have it yet.
; Built by package-installer.ps1, which passes every value below, so nothing
; here changes from one release to the next.

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#ifndef Arch
  #define Arch "x64"
#endif
#ifndef PackageDir
  #error Pass /DPackageDir= naming the folder build.ps1 packaged.
#endif
#ifndef WebView2Setup
  #error Pass /DWebView2Setup= naming Microsoft's WebView2 bootstrapper.
#endif
#ifndef OutputDir
  #define OutputDir "."
#endif
#ifndef OutputName
  #define OutputName "Lasso-Setup"
#endif

[Setup]
; One AppId for every release, so a new installer updates the installed app.
AppId={{5B0C6E1A-2F4D-4C1E-9B7A-1D3E8F6A2C90}
AppName=Lasso
AppVersion={#AppVersion}
AppVerName=Lasso {#AppVersion}
AppPublisher=Lasso
VersionInfoVersion={#AppVersion}
; The same folder install.ps1 uses, so an earlier manual install is updated.
DefaultDirName={localappdata}\Programs\Lasso
DisableDirPage=yes
DefaultGroupName=Lasso
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
MinVersion=10.0.17763
#if Arch == "arm64"
ArchitecturesAllowed=arm64
ArchitecturesInstallIn64BitMode=arm64
#else
; x64 also runs on Windows 11 on Arm.
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
#endif
OutputDir={#OutputDir}
OutputBaseFilename={#OutputName}
SetupIconFile=Assets\lasso.ico
UninstallDisplayIcon={app}\Lasso.exe
UninstallDisplayName=Lasso
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
; Lasso keeps running in the notification area, so updating closes it first.
CloseApplications=force
RestartApplications=no

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#PackageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#WebView2Setup}"; DestDir: "{tmp}"; Flags: deleteafterinstall; Check: NeedsWebView2

[Icons]
Name: "{autoprograms}\Lasso"; Filename: "{app}\Lasso.exe"
Name: "{autodesktop}\Lasso"; Filename: "{app}\Lasso.exe"; Tasks: desktopicon

[Run]
Filename: "{tmp}\MicrosoftEdgeWebview2Setup.exe"; Parameters: "/silent /install"; StatusMsg: "Installing Microsoft Edge WebView2..."; Flags: waituntilterminated; Check: NeedsWebView2
Filename: "{app}\Lasso.exe"; Description: "{cm:LaunchProgram,Lasso}"; Flags: nowait postinstall skipifsilent

; Uninstalling removes the app only. Projects, history and settings stay in
; %LOCALAPPDATA%\Lasso, as with install.ps1 -Uninstall.

[Code]
const
  WebView2Client = 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function HasWebView2(RootKey: Integer): Boolean;
var
  Version: String;
begin
  Result := RegQueryStringValue(RootKey, WebView2Client, 'pv', Version)
    and (Version <> '') and (Version <> '0.0.0.0');
end;

{ Windows 11 ships WebView2; most Windows 10 machines have it from Edge. }
function NeedsWebView2: Boolean;
begin
  Result := not (HasWebView2(HKLM32) or HasWebView2(HKLM64) or HasWebView2(HKCU));
end;
