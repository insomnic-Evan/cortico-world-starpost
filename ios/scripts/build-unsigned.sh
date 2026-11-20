#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != Darwin ]]; then
  echo "This build requires macOS with Xcode (including GitHub macOS runners)." >&2
  exit 1
fi
mkdir -p build/distribution
swift test --parallel
xcodebuild -project Starpost.xcodeproj -scheme Starpost -configuration Release \
  -sdk iphoneos -destination 'generic/platform=iOS' -derivedDataPath build/DerivedData \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY='' \
  build > build/xcode-device.log 2>&1 || { tail -n 120 build/xcode-device.log; exit 1; }
APP="$PWD/build/DerivedData/Build/Products/Release-iphoneos/Starpost.app"
xcrun lipo "$APP/Starpost" -verify_arch arm64
xcrun vtool -show-build "$APP/Starpost" | tee build/distribution/platform.txt
grep -q 'platform IOS$' build/distribution/platform.txt
if codesign --verify "$APP" >/dev/null 2>&1; then
  echo 'Unexpected signed application; refusing to label it unsigned.' >&2
  exit 1
fi
test ! -f "$APP/embedded.mobileprovision"
python3 scripts/package-unsigned.py "$APP" build/distribution
echo 'Unsigned device IPA ready in ios/build/distribution'
