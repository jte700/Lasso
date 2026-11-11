#!/usr/bin/env bash
# Builds Lasso.app, a self-contained macOS menu bar application that bundles
# the server code and the Node.js runtime that runs it locally on demand.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist"
APP="$DIST/Lasso.app"
SUPPORT="$HOME/Library/Application Support/Lasso"
PREVIOUS_SUPPORT="$HOME/Library/Application Support/CoLab Dry"
# The server uses node:sqlite, which needs Node.js 24 or newer.
MINIMUM_NODE_MAJOR=24
# The oldest macOS the app runs on, declared in Info.plist and compiled into
# every shipped Swift binary. The Swift code needs macOS 13 (SMAppService login
# items, for the launcher) and the nodejs.org build of Node.js 24 needs 13.5.
MACOS_MINIMUM="13.5"
# Without a target, swiftc builds for the macOS it runs on. The architecture
# stays this Mac's, like the slice of Node.js that is bundled.
SWIFT_TARGET="$(uname -m)-apple-macos$MACOS_MINIMUM"

# Succeeds when macOS version $1 is later than $2, part by part (13.5 > 13.0.1).
macos_is_later() {
  local IFS=.
  local first=($1) second=($2) part
  for part in 0 1 2; do
    if [ "${first[part]:-0}" -gt "${second[part]:-0}" ]; then return 0; fi
    if [ "${first[part]:-0}" -lt "${second[part]:-0}" ]; then return 1; fi
  done
  return 1
}

# The app runs its server on a copy of this Node, so it works on Macs without
# Node installed. LASSO_NODE picks another build to bundle.
NODE_BIN="${LASSO_NODE:-${COLAB_NODE:-$(command -v node || true)}}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "error: no Node.js to bundle was found. Install Node.js $MINIMUM_NODE_MAJOR+ from nodejs.org or set LASSO_NODE." >&2
  exit 1
fi
# Version managers such as asdf and Volta put a shim on PATH, so Node itself
# names the binary that actually runs.
NODE_SOURCE="$("$NODE_BIN" -p 'process.execPath' 2>/dev/null || true)"
NODE_VERSION=""
if [ -n "$NODE_SOURCE" ] && [ -x "$NODE_SOURCE" ]; then
  NODE_VERSION="$("$NODE_SOURCE" --version 2>/dev/null || true)"
fi
NODE_MAJOR="${NODE_VERSION#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"
if ! [[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] || [ "$NODE_MAJOR" -lt "$MINIMUM_NODE_MAJOR" ]; then
  echo "error: Lasso bundles Node.js $MINIMUM_NODE_MAJOR or newer, but $NODE_BIN reports '${NODE_VERSION:-no version}'." >&2
  echo "Install a current Node.js from nodejs.org or set LASSO_NODE." >&2
  exit 1
fi
NODE_ARCHS="$(lipo -archs "$NODE_SOURCE" 2>/dev/null || true)"
if [ -z "$NODE_ARCHS" ]; then
  echo "error: $NODE_SOURCE is not a macOS executable, so it cannot be bundled. Set LASSO_NODE to a Node.js binary." >&2
  exit 1
fi
# Homebrew's Node links Homebrew libraries that other Macs do not have. The
# nodejs.org and nvm builds link only macOS's own libraries.
NODE_FOREIGN_LIBRARIES="$(otool -L "$NODE_SOURCE" \
  | awk '/^\t/ && $1 !~ /^\/(usr\/lib|System\/Library)\// { print "  " $1 }' | sort -u)"
if [ -n "$NODE_FOREIGN_LIBRARIES" ]; then
  echo "error: $NODE_SOURCE links libraries outside macOS, so a bundled copy would not run on other Macs:" >&2
  echo "$NODE_FOREIGN_LIBRARIES" >&2
  echo "Install Node.js from nodejs.org (or nvm) and set LASSO_NODE to that binary." >&2
  exit 1
fi

# Resolve signing before replacing the previous app. Accessibility approvals
# identify certificate-signed updates consistently; ad-hoc builds change hash.
SIGNING_MODE="${LASSO_SIGN_MODE:-${COLAB_SIGN_MODE:-required}}"
SIGNING_IDENTITY="${LASSO_SIGN_IDENTITY:-${COLAB_SIGN_IDENTITY:-}}"
case "$SIGNING_MODE" in
  required|auto|adhoc) ;;
  *) echo "error: LASSO_SIGN_MODE must be required, auto, or adhoc." >&2; exit 1 ;;
esac
if [ "$SIGNING_MODE" = "adhoc" ]; then
  if [ -n "$SIGNING_IDENTITY" ]; then
    echo "error: choose certificate signing or adhoc mode, rather than both." >&2
    exit 1
  fi
  SIGNING_IDENTITY="-"
  echo "warning: this temporary ad-hoc build may invalidate Accessibility approval." >&2
else
  AVAILABLE_SIGNING_IDENTITIES="$(security find-identity -v -p codesigning 2>/dev/null || true)"
  if [ -z "$SIGNING_IDENTITY" ]; then
    for candidate_identity in "Lasso Local Development" "CoLab Dry Local Development"; do
      if grep -Fq "\"$candidate_identity\"" <<<"$AVAILABLE_SIGNING_IDENTITIES"; then
        SIGNING_IDENTITY="$candidate_identity"
        break
      fi
    done
  fi
  if [ -z "$SIGNING_IDENTITY" ]; then
    echo "error: a stable code-signing identity is required before rebuilding Lasso." >&2
    echo "Set LASSO_SIGN_IDENTITY to a valid certificate name or SHA-1 fingerprint." >&2
    echo "The previous app has been preserved. Use LASSO_SIGN_MODE=adhoc only for a temporary build." >&2
    exit 1
  fi
  if [[ "$SIGNING_IDENTITY" =~ ^[a-fA-F0-9]{40}$ ]]; then
    matching_identities="$(grep -Fi " $SIGNING_IDENTITY \"" <<<"$AVAILABLE_SIGNING_IDENTITIES" || true)"
  else
    matching_identities="$(grep -F "\"$SIGNING_IDENTITY\"" <<<"$AVAILABLE_SIGNING_IDENTITIES" || true)"
  fi
  identity_count="$(awk 'NF { count++ } END { print count+0 }' <<<"$matching_identities")"
  if [ "$identity_count" != "1" ]; then
    echo "error: signing identity must match exactly one valid certificate. Use its SHA-1 fingerprint." >&2
    exit 1
  fi
  SIGNING_IDENTITY="$(awk '{ print $2 }' <<<"$matching_identities")"
fi

BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/lasso-build.XXXXXX")"
trap 'rm -rf "$BUILD_DIR"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
BUILD_APP="$BUILD_DIR/Lasso.app"
CONTENTS="$BUILD_APP/Contents"
RESOURCES="$CONTENTS/Resources"

echo "==> Preparing staged build"
mkdir -p "$CONTENTS/MacOS" "$RESOURCES/app" "$RESOURCES/node"

echo "==> Finding the Node.js $NODE_VERSION license"
# Tarball, nvm and Homebrew installs keep LICENSE beside bin/. The nodejs.org
# installer does not, so that release's license is downloaded once and cached.
NODE_LICENSE_HEADER="Node.js is licensed for use as follows:"
is_node_license() { [ -f "$1" ] && head -n 1 "$1" | grep -Fq "$NODE_LICENSE_HEADER"; }
NODE_LICENSE="${LASSO_NODE_LICENSE:-}"
NODE_PREFIX_LICENSE="$(dirname "$(dirname "$NODE_SOURCE")")/LICENSE"
if [ -n "$NODE_LICENSE" ]; then
  if ! is_node_license "$NODE_LICENSE"; then
    echo "error: LASSO_NODE_LICENSE is not a Node.js LICENSE file: $NODE_LICENSE" >&2
    exit 1
  fi
elif is_node_license "$NODE_PREFIX_LICENSE"; then
  NODE_LICENSE="$NODE_PREFIX_LICENSE"
else
  NODE_LICENSE="$HOME/Library/Caches/Lasso/node-$NODE_VERSION-LICENSE"
  if ! is_node_license "$NODE_LICENSE"; then
    NODE_LICENSE_URL="https://raw.githubusercontent.com/nodejs/node/$NODE_VERSION/LICENSE"
    echo "    downloading $NODE_LICENSE_URL"
    if ! curl --fail --silent --show-error --location --proto '=https' --max-time 60 \
        --output "$BUILD_DIR/node-LICENSE" "$NODE_LICENSE_URL" \
      || ! is_node_license "$BUILD_DIR/node-LICENSE"; then
      echo "error: the Node.js $NODE_VERSION license could not be downloaded. Save" >&2
      echo "https://github.com/nodejs/node/blob/$NODE_VERSION/LICENSE and set LASSO_NODE_LICENSE to it." >&2
      exit 1
    fi
    mkdir -p "$(dirname "$NODE_LICENSE")"
    mv "$BUILD_DIR/node-LICENSE" "$NODE_LICENSE"
  fi
fi

echo "==> Recording build configuration (node: $NODE_BIN)"
cat > "$ROOT/desktop/BuildConfig.swift" <<SWIFT
// Generated by desktop/build.sh — do not edit.
enum BuildConfig {
    static let nodePath = "$NODE_BIN"
}
SWIFT

echo "==> Compiling the menu bar app"
SWIFT_OPTIONS=(-O -target "$SWIFT_TARGET")
if [ "${LASSO_BROWSER_GEOMETRY_TEST:-0}" = "1" ]; then
  SWIFT_OPTIONS+=(-D BROWSER_GEOMETRY_TEST "$ROOT/desktop/tests/browser-geometry.swift")
fi
swiftc "${SWIFT_OPTIONS[@]}" \
  -module-cache-path "${LASSO_SWIFT_MODULE_CACHE:-${TMPDIR:-/tmp}/lasso-swift-module-cache}" \
  -framework Cocoa -framework WebKit -framework PDFKit -framework ServiceManagement -framework DiskArbitration \
  -framework EventKit -framework SwiftUI -framework Quartz -framework SceneKit -framework ModelIO -framework Carbon \
  -framework Vision -framework AVFoundation -framework AVKit \
  -o "$CONTENTS/MacOS/Lasso" \
  "$ROOT/desktop/BuildConfig.swift" \
  "$ROOT/desktop/NodeRuntime.swift" \
  "$ROOT/desktop/WorkspaceAPI.swift" \
  "$ROOT/desktop/AssistActivation.swift" \
  "$ROOT/desktop/SuggestionApps.swift" \
  "$ROOT/desktop/TransientDismissal.swift" \
  "$ROOT/desktop/DirectoryColors.swift" \
  "$ROOT/desktop/LaunchHelper.swift" \
  "$ROOT/desktop/Appearance.swift" \
  "$ROOT/desktop/NativeMaterial.swift" \
  "$ROOT/desktop/DirectoryMenu.swift" \
  "$ROOT/desktop/StatusPopover.swift" \
  "$ROOT/desktop/StatusHeader.swift" \
  "$ROOT/desktop/NotchMotion.swift" \
  "$ROOT/desktop/NotchPanel.swift" \
  "$ROOT/desktop/SyntheticKeyboard.swift" \
  "$ROOT/desktop/KeyRouting.swift" \
  "$ROOT/desktop/PinchRouting.swift" \
  "$ROOT/desktop/CompletionTransaction.swift" \
  "$ROOT/desktop/InsertionCasing.swift" \
  "$ROOT/desktop/InsertionUndo.swift" \
  "$ROOT/desktop/HostSelection.swift" \
  "$ROOT/desktop/AssistSourceIdentity.swift" \
  "$ROOT/desktop/AssistWordChoice.swift" \
  "$ROOT/desktop/SpokenAccept.swift" \
  "$ROOT/desktop/SourceOpenTarget.swift" \
  "$ROOT/desktop/SourceOpener.swift" \
  "$ROOT/desktop/AssistPopupHost.swift" \
  "$ROOT/desktop/DependencyReference.swift" \
  "$ROOT/desktop/LinkedSourceMemory.swift" \
  "$ROOT/desktop/HostGeometry.swift" \
  "$ROOT/desktop/AccessibilityWork.swift" \
  "$ROOT/desktop/HostAccessibilityMode.swift" \
  "$ROOT/desktop/DictationWatch.swift" \
  "$ROOT/desktop/HostTextAdapter.swift" \
  "$ROOT/desktop/FocusedTextElement.swift" \
  "$ROOT/desktop/DependencyOverlay.swift" \
  "$ROOT/desktop/DependencyHighlighter.swift" \
  "$ROOT/desktop/CodeSyntax.swift" \
  "$ROOT/desktop/ModelPreview.swift" \
  "$ROOT/desktop/VideoPreview.swift" \
  "$ROOT/desktop/AssistVideoPreviewView.swift" \
  "$ROOT/desktop/ModelOrbit.swift" \
  "$ROOT/desktop/AssistTableLayout.swift" \
  "$ROOT/desktop/AssistSuggestionList.swift" \
  "$ROOT/desktop/PreviewWordMarks.swift" \
  "$ROOT/desktop/AssistPreviewViews.swift" \
  "$ROOT/desktop/SlideDeckPreview.swift" \
  "$ROOT/desktop/SourceInspectorPanel.swift" \
  "$ROOT/desktop/WebText.swift" \
  "$ROOT/desktop/ShareInsertion.swift" \
  "$ROOT/desktop/ShareMarkup.swift" \
  "$ROOT/desktop/ShareComposer.swift" \
  "$ROOT/desktop/ShareComposerController.swift" \
  "$ROOT/desktop/ShareInteractivePDFView.swift" \
  "$ROOT/desktop/SharePreviewCanvas.swift" \
  "$ROOT/desktop/ShareComposerView.swift" \
  "$ROOT/desktop/ShareComposerView+Drawing.swift" \
  "$ROOT/desktop/ShareComposerView+Documents.swift" \
  "$ROOT/desktop/ShareComposerView+Scrolling.swift" \
  "$ROOT/desktop/ShareComposerView+Input.swift" \
  "$ROOT/desktop/ShareComposerView+Markup.swift" \
  "$ROOT/desktop/ShareComposerView+Regressions.swift" \
  "$ROOT/desktop/SourceChooser.swift" \
  "$ROOT/desktop/AssistSuggestion.swift" \
  "$ROOT/desktop/AssistValueChange.swift" \
  "$ROOT/desktop/PassageWordDiff.swift" \
  "$ROOT/desktop/RecommendationUsageClient.swift" \
  "$ROOT/desktop/InsertionMode.swift" \
  "$ROOT/desktop/AssistPermission.swift" \
  "$ROOT/desktop/AccessibilityReader.swift" \
  "$ROOT/desktop/AssistGlassBubble.swift" \
  "$ROOT/desktop/AssistBoxView.swift" \
  "$ROOT/desktop/AssistBoxView+Drawing.swift" \
  "$ROOT/desktop/AssistBoxView+Preview.swift" \
  "$ROOT/desktop/AssistBoxView+Input.swift" \
  "$ROOT/desktop/AssistBoxView+Footer.swift" \
  "$ROOT/desktop/GlobalAssist.swift" \
  "$ROOT/desktop/GlobalAssistant+Prediction.swift" \
  "$ROOT/desktop/GlobalAssistant+Preview.swift" \
  "$ROOT/desktop/GlobalAssistant+Panel.swift" \
  "$ROOT/desktop/GlobalAssistant+Insertion.swift" \
  "$ROOT/desktop/GlobalAssistant+Regressions.swift" \
  "$ROOT/desktop/ExternalDrives.swift" \
  "$ROOT/desktop/DriveMenu.swift" \
  "$ROOT/desktop/MainMenu.swift" \
  "$ROOT/desktop/ShortcutCatalog.swift" \
  "$ROOT/desktop/ShortcutsPane.swift" \
  "$ROOT/desktop/SettingsPanes.swift" \
  "$ROOT/desktop/SettingsWindow.swift" \
  "$ROOT/desktop/ConnectApps.swift" \
  "$ROOT/desktop/RanchModels.swift" \
  "$ROOT/desktop/RanchNetworkLayout.swift" \
  "$ROOT/desktop/RanchTypeIcon.swift" \
  "$ROOT/desktop/RanchTheme.swift" \
  "$ROOT/desktop/RanchGlass.swift" \
  "$ROOT/desktop/RanchStore.swift" \
  "$ROOT/desktop/RanchEditors.swift" \
  "$ROOT/desktop/RanchViewers.swift" \
  "$ROOT/desktop/RanchViews.swift" \
  "$ROOT/desktop/RanchLists.swift" \
  "$ROOT/desktop/RanchSheetView.swift" \
  "$ROOT/desktop/RanchReview.swift" \
  "$ROOT/desktop/RanchDetail.swift" \
  "$ROOT/desktop/RanchNetworkView.swift" \
  "$ROOT/desktop/RanchWindow.swift" \
  "$ROOT/desktop/GlobalHotKey.swift" \
  "$ROOT/desktop/Lasso.swift"

echo "==> Compiling the launcher (starts Lasso at login and with Command-L)"
# Its own small app, so it keeps running after Lasso quits. SMAppService
# finds login items in Contents/Library/LoginItems.
LAUNCHER="$CONTENTS/Library/LoginItems/Lasso Launcher.app"
mkdir -p "$LAUNCHER/Contents/MacOS" "$LAUNCHER/Contents/Resources"
swiftc -O -target "$SWIFT_TARGET" \
  -module-cache-path "${LASSO_SWIFT_MODULE_CACHE:-${TMPDIR:-/tmp}/lasso-swift-module-cache}" \
  -framework Cocoa -framework Carbon \
  -o "$LAUNCHER/Contents/MacOS/LassoLauncher" "$ROOT/desktop/LassoLauncher.swift"
cat > "$LAUNCHER/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Lasso Launcher</string>
  <key>CFBundleDisplayName</key><string>Lasso</string>
  <key>CFBundleIdentifier</key><string>com.jte700.lasso.launcher</string>
  <key>CFBundleVersion</key><string>1.0.0</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleExecutable</key><string>LassoLauncher</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>$MACOS_MINIMUM</string>
  <!-- No Dock icon, menu or windows. -->
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST
printf 'APPL????' > "$LAUNCHER/Contents/PkgInfo"

echo "==> Bundling Node.js $NODE_VERSION from $NODE_SOURCE"
# The app finds it as an auxiliary executable beside its own.
BUNDLED_NODE="$CONTENTS/MacOS/node"
APP_ARCHS="$(lipo -archs "$CONTENTS/MacOS/Lasso")"
for arch in $APP_ARCHS; do
  if [[ " $NODE_ARCHS " != *" $arch "* ]]; then
    echo "error: $NODE_SOURCE has no $arch build (it has: $NODE_ARCHS). Install Node.js for this Mac or set LASSO_NODE." >&2
    exit 1
  fi
done
if [ "$NODE_ARCHS" = "$APP_ARCHS" ]; then
  cp "$NODE_SOURCE" "$BUNDLED_NODE"
else
  # The nodejs.org installer's universal Node is twice the size of the slice
  # this app can run, so only the app's own architectures are kept.
  NODE_SLICES=()
  for arch in $APP_ARCHS; do NODE_SLICES+=(-extract "$arch"); done
  lipo "$NODE_SOURCE" "${NODE_SLICES[@]}" -output "$BUNDLED_NODE"
fi
chmod 755 "$BUNDLED_NODE"
# The app declares one minimum macOS, so the Node.js it runs on must not need
# a later one. Each bundled architecture records its own minimum.
NODE_MACOS="$(vtool -show-build "$BUNDLED_NODE" 2>/dev/null \
  | awk '$1 == "minos" { print $2 }' | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1 || true)"
if ! [[ "$NODE_MACOS" =~ ^[0-9]+(\.[0-9]+)*$ ]]; then
  echo "error: vtool -show-build could not read which macOS $NODE_SOURCE needs." >&2
  exit 1
fi
if macos_is_later "$NODE_MACOS" "$MACOS_MINIMUM"; then
  echo "error: Node.js $NODE_VERSION from $NODE_SOURCE needs macOS $NODE_MACOS, but Lasso runs on macOS $MACOS_MINIMUM." >&2
  echo "Set LASSO_NODE to a Node.js built for macOS $MACOS_MINIMUM or earlier, or raise MACOS_MINIMUM in desktop/build.sh." >&2
  exit 1
fi
cp "$NODE_LICENSE" "$RESOURCES/node/LICENSE"

echo "==> Bundling the server"
for item in src public migrations scripts package.json package-lock.json; do
  cp -R "$ROOT/$item" "$RESOURCES/app/"
done
# Finder leaves .DS_Store files in folders it has shown; the app needs none.
find "$RESOURCES/app" -name .DS_Store -delete
# The app registrations connected apps sign in with, when this build has its
# own. Without them, the Connect window asks for one the first time.
if [ -n "${LASSO_MICROSOFT_CLIENT_ID:-}${LASSO_GOOGLE_CLIENT_ID:-}" ]; then
  "$NODE_BIN" -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({
    microsoft: { clientId: process.env.LASSO_MICROSOFT_CLIENT_ID || null },
    google: { clientId: process.env.LASSO_GOOGLE_CLIENT_ID || null, clientSecret: process.env.LASSO_GOOGLE_CLIENT_SECRET || null },
  }, null, 2))' "$RESOURCES/app/connector-apps.json"
fi

echo "==> Bundling offline IFC geometry engine"
if [ ! -f "$ROOT/node_modules/web-ifc/web-ifc-node.wasm" ]; then
  echo "error: IFC dependencies are missing. Run npm ci before building." >&2
  exit 1
fi
mkdir -p "$RESOURCES/app/node_modules"
for dependency in web-ifc polygon-clipping robust-predicates splaytree; do
  cp -R "$ROOT/node_modules/$dependency" "$RESOURCES/app/node_modules/"
done

echo "==> Compiling local PDF drawing reader"
swiftc -O -target "$SWIFT_TARGET" -module-cache-path "${LASSO_SWIFT_MODULE_CACHE:-${TMPDIR:-/tmp}/lasso-swift-module-cache}" -framework PDFKit -o "$RESOURCES/app/scripts/extract-drawing-layout" \
  "$ROOT/scripts/extract-drawing-layout.swift"

echo "==> Compiling safe PDF sharing renderer"
swiftc -O -target "$SWIFT_TARGET" -module-cache-path "${LASSO_SWIFT_MODULE_CACHE:-${TMPDIR:-/tmp}/lasso-swift-module-cache}" -framework PDFKit -framework AppKit -o "$RESOURCES/app/scripts/render-shared-pdf" \
  "$ROOT/scripts/render-shared-pdf.swift"

echo "==> Compiling document page renderer for marked-up shares"
swiftc -O -target "$SWIFT_TARGET" -module-cache-path "${LASSO_SWIFT_MODULE_CACHE:-${TMPDIR:-/tmp}/lasso-swift-module-cache}" -framework AppKit -framework PDFKit -framework QuickLookThumbnailing -o "$RESOURCES/app/scripts/render-document-pages" \
  "$ROOT/scripts/render-document-pages.swift"

echo "==> Compiling on-device video transcriber"
swiftc -O -target "$SWIFT_TARGET" -module-cache-path "${LASSO_SWIFT_MODULE_CACHE:-${TMPDIR:-/tmp}/lasso-swift-module-cache}" -framework AVFoundation -framework Speech -o "$RESOURCES/app/scripts/transcribe-video" \
  "$ROOT/scripts/transcribe-video.swift"

echo "==> Drawing the app icon"
# The icon is drawn from scripts/render-app-icon.swift and cached by that
# script's hash, so ordinary rebuilds reuse it instead of redrawing.
# macOS 26 masks a full-bleed icon to its own shape and puts any other legacy
# icon on a grey plate; earlier versions need the squircle drawn in. The icon
# matches the macOS this build runs on (LASSO_ICON_STYLE=full-bleed|squircle).
ICON_STYLE="${LASSO_ICON_STYLE:-}"
if [ -z "$ICON_STYLE" ]; then
  if [ "$(sw_vers -productVersion | cut -d. -f1)" -ge 26 ]; then ICON_STYLE="full-bleed"; else ICON_STYLE="squircle"; fi
fi
case "$ICON_STYLE" in
  full-bleed) ICON_FLAGS=(--full-bleed) ;;
  squircle) ICON_FLAGS=() ;;
  *) echo "error: LASSO_ICON_STYLE must be full-bleed or squircle." >&2; exit 1 ;;
esac
ICON_CACHE="${LASSO_ICON_CACHE:-${TMPDIR:-/tmp}/lasso-app-icon}"
ICON_HASH="$(shasum -a 256 "$ROOT/scripts/render-app-icon.swift" | awk '{ print $1 }')"
ICON_FILE="$ICON_CACHE/AppIcon-$ICON_STYLE-$ICON_HASH.icns"
if [ ! -f "$ICON_FILE" ]; then
  mkdir -p "$ICON_CACHE"
  # The icon renderer runs only here and is not shipped, so it keeps this
  # Mac's default target.
  swiftc -O -module-cache-path "${LASSO_SWIFT_MODULE_CACHE:-${TMPDIR:-/tmp}/lasso-swift-module-cache}" -framework AppKit \
    -o "$BUILD_DIR/render-app-icon" "$ROOT/scripts/render-app-icon.swift"
  "$BUILD_DIR/render-app-icon" "$BUILD_DIR/AppIcon.iconset" ${ICON_FLAGS[@]+"${ICON_FLAGS[@]}"}
  iconutil -c icns -o "$BUILD_DIR/AppIcon.icns" "$BUILD_DIR/AppIcon.iconset"
  mv "$BUILD_DIR/AppIcon.icns" "$ICON_FILE"
fi
cp "$ICON_FILE" "$RESOURCES/AppIcon.icns"
cp "$ICON_FILE" "$LAUNCHER/Contents/Resources/AppIcon.icns"

echo "==> Writing Info.plist"
cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Lasso</string>
  <key>CFBundleDisplayName</key><string>Lasso</string>
  <key>CFBundleIdentifier</key><string>com.jte700.lasso</string>
  <key>CFBundleVersion</key><string>1.0.0</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleExecutable</key><string>Lasso</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>$MACOS_MINIMUM</string>
  <key>NSHighResolutionCapable</key><true/>
  <!-- Status bar only: no Dock icon, keeps running in the background. -->
  <key>LSUIElement</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <!-- System-wide suggestions read the text around the caret and watch for
       keystrokes. Both are opt-in from the menu bar. -->
  <key>NSRemovableVolumesUsageDescription</key>
  <string>Lasso reads files on external drives you choose to index and keeps searchable copies on this Mac.</string>
  <key>NSInputMonitoringUsageDescription</key>
  <string>Lasso watches for typing so it can suggest sources from your indexed project.</string>
  <key>NSAccessibilityUsageDescription</key>
  <string>Lasso reads the text around your cursor so it can suggest sources and insert them.</string>
  <!-- Open file asks the source's app (Excel, Numbers, Word, Acrobat) to go to
       the cited cell, passage or page. The file opens even when this is denied. -->
  <key>NSAppleEventsUsageDescription</key>
  <string>Lasso asks the app that opens a source to go to the cited cell, page, passage or moment in a video.</string>
  <!-- Connecting the Calendar app in Connect 3rd Party Apps reads its events. -->
  <key>NSCalendarsFullAccessUsageDescription</key>
  <string>Lasso reads the events in the calendars you choose so it can suggest and cite them.</string>
  <key>NSCalendarsUsageDescription</key>
  <string>Lasso reads the events in the calendars you choose so it can suggest and cite them.</string>
</dict>
</plist>
PLIST
printf 'APPL????' > "$CONTENTS/PkgInfo"

# First run keeps the history recorded so far by `npm start` instead of
# opening an empty workspace. Existing app data is never overwritten.
if [ ! -d "$SUPPORT/data" ]; then
  if [ -d "$PREVIOUS_SUPPORT/data" ]; then
    DATA_SEED="$PREVIOUS_SUPPORT/data"
  elif [ -d "$ROOT/.lasso-data" ]; then
    DATA_SEED="$ROOT/.lasso-data"
  elif [ -d "$ROOT/.colab-dry-data" ]; then
    DATA_SEED="$ROOT/.colab-dry-data"
  fi
  if [ -n "${DATA_SEED:-}" ]; then
    echo "==> Seeding app data from $DATA_SEED"
    mkdir -p "$SUPPORT"
    cp -R "$DATA_SEED" "$SUPPORT/data"
  fi
fi

echo "==> Signing"
# Keep the certificate-bound designated requirement generated by codesign.
# Sign inside-out in one process so a one-time Keychain approval covers the
# bundled Node, the helpers, the launcher and the containing app without a
# second prompt.
codesign --force --sign "$SIGNING_IDENTITY" "$BUNDLED_NODE" \
  "$RESOURCES/app/scripts/extract-drawing-layout" "$RESOURCES/app/scripts/render-shared-pdf" \
  "$RESOURCES/app/scripts/render-document-pages" "$RESOURCES/app/scripts/transcribe-video" "$LAUNCHER" "$BUILD_APP"
codesign --verify --deep --strict "$BUILD_APP"
if [ "$("$BUNDLED_NODE" --version 2>/dev/null || true)" != "$NODE_VERSION" ]; then
  echo "error: the signed bundled Node.js does not run. The previous app has been preserved." >&2
  exit 1
fi

echo "==> Replacing app with verified build"
mkdir -p "$DIST"
rm -rf "$APP"
mv "$BUILD_APP" "$APP"
# Finder, alerts and Privacy & Security settings cache app icons. Re-register
# so the new icon replaces a cached one without logging out.
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ -x "$LSREGISTER" ]; then
  "$LSREGISTER" -f "$APP" >/dev/null 2>&1 || true
fi
touch "$APP"

echo
echo "Built: $APP ($(du -sh "$APP" | cut -f1), of which Node.js $NODE_VERSION is $(du -sh "$APP/Contents/MacOS/node" | cut -f1))"
echo "Run it:      open -a \"$APP\""
echo "Install it:  cp -R \"$APP\" /Applications/"
