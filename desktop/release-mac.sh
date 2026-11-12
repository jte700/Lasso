#!/usr/bin/env bash
# Builds Lasso.dmg, the Mac download: one app for Apple silicon and Intel Macs
# on macOS 13.5 or later, signed with a Developer ID, notarized by Apple and
# stapled, so it opens on a Mac that has never seen it.
#
#   bash desktop/release-mac.sh            # or: npm run release:mac
#
# Nothing in this file changes from one release to the next. The version comes
# from the release tag (or LASSO_VERSION, or package.json), the Node.js version
# from desktop/windows/runtime-lock.json, and signing from the environment:
#
#   LASSO_SIGN_IDENTITY     a "Developer ID Application" certificate in the keychain
#   and, to notarize, an App Store Connect API key:
#   LASSO_NOTARY_KEY_PATH   the AuthKey_XXXX.p8 file
#   LASSO_NOTARY_KEY_ID     its key ID
#   LASSO_NOTARY_ISSUER     its issuer ID
#   or an Apple ID with an app-specific password:
#   LASSO_NOTARY_APPLE_ID, LASSO_NOTARY_PASSWORD, LASSO_NOTARY_TEAM_ID
#
# Without a signing identity it builds an ad-hoc signed copy for testing, which
# other Macs refuse to open. The result is dist/release/Lasso.dmg and its
# .sha256; this Mac's own dist/Lasso.app is left alone.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${LASSO_RELEASE_DIR:-$ROOT/dist/release}"
CACHE="${LASSO_RELEASE_CACHE:-$HOME/Library/Caches/Lasso/release}"
DMG="$OUT/Lasso.dmg"

fail() { echo "error: $*" >&2; exit 1; }

# One Node.js for every platform: the version the Windows build pins.
NODE_VERSION="v$(sed -n 's/.*"nodeVersion": *"\([^"]*\)".*/\1/p' "$ROOT/desktop/windows/runtime-lock.json")"
[ "$NODE_VERSION" != "v" ] || fail "desktop/windows/runtime-lock.json names no nodeVersion."

TAG="$(git -C "$ROOT" describe --tags --exact-match 2>/dev/null || true)"
VERSION="${LASSO_VERSION:-${TAG#v}}"
BUILD_NUMBER="${LASSO_BUILD_NUMBER:-$(git -C "$ROOT" rev-list --count HEAD 2>/dev/null || echo 1)}"

SIGN_IDENTITY="${LASSO_SIGN_IDENTITY:-}"
NOTARY=()
if [ -n "${LASSO_NOTARY_KEY_PATH:-}" ]; then
  [ -f "$LASSO_NOTARY_KEY_PATH" ] || fail "LASSO_NOTARY_KEY_PATH is not a file: $LASSO_NOTARY_KEY_PATH"
  NOTARY=(--key "$LASSO_NOTARY_KEY_PATH" --key-id "${LASSO_NOTARY_KEY_ID:?set LASSO_NOTARY_KEY_ID}"
    --issuer "${LASSO_NOTARY_ISSUER:?set LASSO_NOTARY_ISSUER}")
elif [ -n "${LASSO_NOTARY_APPLE_ID:-}" ]; then
  NOTARY=(--apple-id "$LASSO_NOTARY_APPLE_ID" --password "${LASSO_NOTARY_PASSWORD:?set LASSO_NOTARY_PASSWORD}"
    --team-id "${LASSO_NOTARY_TEAM_ID:?set LASSO_NOTARY_TEAM_ID}")
fi
if [ ${#NOTARY[@]} -gt 0 ] && [ -z "$SIGN_IDENTITY" ]; then
  fail "notarizing needs LASSO_SIGN_IDENTITY, a Developer ID Application certificate."
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/lasso-release.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$CACHE" "$OUT"

fetch() {
  curl --fail --silent --show-error --location --proto '=https' --retry 3 --max-time 600 --output "$2" "$1"
}
sha256_of() { shasum -a 256 "$1" | awk '{ print $1 }'; }

echo "==> Fetching Node.js $NODE_VERSION for Apple silicon and Intel"
SUMS="$CACHE/node-$NODE_VERSION-SHASUMS256.txt"
[ -s "$SUMS" ] || fetch "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" "$SUMS"
SLICES=()
for arch in arm64 x64; do
  name="node-$NODE_VERSION-darwin-$arch"
  archive="$CACHE/$name.tar.gz"
  expected="$(awk -v file="$name.tar.gz" '$2 == file { print $1 }' "$SUMS")"
  [ -n "$expected" ] || fail "nodejs.org lists no $name.tar.gz."
  if [ ! -f "$archive" ] || [ "$(sha256_of "$archive")" != "$expected" ]; then
    fetch "https://nodejs.org/dist/$NODE_VERSION/$name.tar.gz" "$archive.part"
    mv "$archive.part" "$archive"
  fi
  [ "$(sha256_of "$archive")" = "$expected" ] || fail "$name.tar.gz does not match nodejs.org's checksum."
  tar -xzf "$archive" -C "$WORK" "$name/bin/node" "$name/LICENSE"
  SLICES+=("$WORK/$name/bin/node")
done
mkdir -p "$WORK/node/bin"
lipo -create "${SLICES[@]}" -output "$WORK/node/bin/node"
cp "$WORK/node-$NODE_VERSION-darwin-arm64/LICENSE" "$WORK/node/LICENSE"

echo "==> Building Lasso.app ${VERSION:-from package.json} (build $BUILD_NUMBER)"
BUILD_ENV=(LASSO_NODE="$WORK/node/bin/node" LASSO_ARCHS="arm64 x86_64" LASSO_RELEASE=1
  LASSO_OUTPUT_DIR="$WORK/build" LASSO_BUILD_NUMBER="$BUILD_NUMBER"
  LASSO_ICON_STYLE="${LASSO_ICON_STYLE:-full-bleed}")
[ -z "$VERSION" ] || BUILD_ENV+=(LASSO_VERSION="$VERSION")
if [ -n "$SIGN_IDENTITY" ]; then
  BUILD_ENV+=(LASSO_SIGN_MODE=required LASSO_SIGN_IDENTITY="$SIGN_IDENTITY")
else
  echo "warning: no LASSO_SIGN_IDENTITY, so this build is ad-hoc signed and only for testing." >&2
  BUILD_ENV+=(LASSO_SIGN_MODE=adhoc LASSO_SIGN_IDENTITY=)
fi
env "${BUILD_ENV[@]}" bash "$ROOT/desktop/build.sh"
APP="$WORK/build/Lasso.app"

echo "==> Checking both architectures"
for binary in "$APP/Contents/MacOS/Lasso" "$APP/Contents/MacOS/node" \
    "$APP/Contents/Library/LoginItems/Lasso Launcher.app/Contents/MacOS/LassoLauncher" \
    "$APP/Contents/Resources/app/scripts/"{extract-drawing-layout,render-shared-pdf,render-document-pages,transcribe-video}; do
  archs="$(lipo -archs "$binary")"
  [[ " $archs " == *" arm64 "* && " $archs " == *" x86_64 "* ]] || fail "$binary is built for '$archs' only."
done
# Running the Intel slice goes through Rosetta, and macOS 27 then warns that
# "Lasso" has a component macOS 28 will not open. So it runs only on the
# release machine (CI), never on a Mac someone uses.
if [ -n "${CI:-}" ] && arch -x86_64 /usr/bin/true 2>/dev/null; then
  [ "$(arch -x86_64 "$APP/Contents/MacOS/node" --version)" = "$NODE_VERSION" ] || fail "the Intel Node.js does not run."
else
  echo "    The Intel slice was not run here (it runs on the release machine)."
fi

# Submits a file to Apple and waits; fails with Apple's log when it is refused.
notarize() {
  local result id status
  result="$(xcrun notarytool submit "$1" "${NOTARY[@]}" --wait --timeout 45m --output-format json)"
  id="$(sed -n 's/.*"id" *: *"\([^"]*\)".*/\1/p' <<<"$result" | head -n 1)"
  status="$(sed -n 's/.*"status" *: *"\([^"]*\)".*/\1/p' <<<"$result" | head -n 1)"
  if [ "$status" != "Accepted" ]; then
    echo "$result" >&2
    [ -z "$id" ] || xcrun notarytool log "$id" "${NOTARY[@]}" >&2 || true
    fail "Apple did not notarize $(basename "$1") (status: ${status:-unknown})."
  fi
}

NOTARIZED=no
if [ ${#NOTARY[@]} -gt 0 ]; then
  echo "==> Notarizing Lasso.app"
  ditto -c -k --keepParent "$APP" "$WORK/Lasso.zip"
  notarize "$WORK/Lasso.zip"
  xcrun stapler staple "$APP"
fi

echo "==> Making Lasso.dmg"
mkdir -p "$WORK/dmg"
ditto "$APP" "$WORK/dmg/Lasso.app"
ln -s /Applications "$WORK/dmg/Applications"
rm -f "$DMG" "$DMG.sha256"
hdiutil create -quiet -volname "Lasso" -srcfolder "$WORK/dmg" -fs HFS+ -format UDZO -ov "$DMG"
if [ -n "$SIGN_IDENTITY" ]; then
  codesign --force --sign "$SIGN_IDENTITY" --timestamp "$DMG"
fi
if [ ${#NOTARY[@]} -gt 0 ]; then
  echo "==> Notarizing Lasso.dmg"
  notarize "$DMG"
  xcrun stapler staple "$DMG"
  spctl --assess --type open --context context:primary-signature "$DMG"
  spctl --assess --type execute "$APP"
  NOTARIZED=yes
fi
(cd "$OUT" && shasum -a 256 Lasso.dmg > Lasso.dmg.sha256)

[ -z "${GITHUB_OUTPUT:-}" ] || echo "notarized=$NOTARIZED" >> "$GITHUB_OUTPUT"
echo
echo "Built: $DMG ($(du -h "$DMG" | cut -f1), notarized: $NOTARIZED)"
