#!/bin/bash
# GitBell.app을 만든다. swift build 결과에 Info.plist, 언어 파일, 아이콘을 묶고 로컬 서명(ad-hoc)을 한다.
# 사용: scripts/build-app.sh [출력 폴더]   (기본: dist/)
# 내 Mac에서 직접 빌드한 앱은 인터넷에서 받은 표시(격리 속성)가 없어 Gatekeeper 경고 없이 열린다.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/dist}"
APP="$OUT/GitBell.app"
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)"

cd "$ROOT"
swift build -c release --product GitBell
BIN_DIR="$(swift build -c release --show-bin-path)"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN_DIR/GitBell" "$APP/Contents/MacOS/GitBell"
cp -R "$ROOT"/Resources/*.lproj "$APP/Contents/Resources/"
cp "$ROOT/Resources/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>GitBell</string>
    <key>CFBundleDisplayName</key><string>GitBell</string>
    <key>CFBundleIdentifier</key><string>io.github.kgyujin.gitbell</string>
    <key>CFBundleExecutable</key><string>GitBell</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>${VERSION}</string>
    <key>CFBundleVersion</key><string>${VERSION}</string>
    <key>CFBundleIconFile</key><string>AppIcon</string>
    <key>CFBundleDevelopmentRegion</key><string>en</string>
    <key>CFBundleLocalizations</key><array><string>en</string><string>ko</string></array>
    <key>LSMinimumSystemVersion</key><string>13.0</string>
    <key>LSUIElement</key><true/>
    <key>NSHumanReadableCopyright</key><string>MIT License</string>
</dict>
</plist>
PLIST

codesign --force --sign - "$APP" >/dev/null
echo "$APP"
