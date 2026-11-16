"""Package an actual Xcode iphoneos build; never relabel a simulator app as an IPA."""
import hashlib
import json
from pathlib import Path
import plistlib
import subprocess
import sys
import zipfile

app = Path(sys.argv[1]).resolve()
output = Path(sys.argv[2]).resolve()
info = plistlib.loads((app / "Info.plist").read_bytes())
assert info["CFBundleIdentifier"] == "io.starpost.ios"
assert info["CFBundleSupportedPlatforms"] == ["iPhoneOS"], "Simulator packages cannot be installed on iPhone"
assert not (app / "_CodeSignature").exists() and not (app / "embedded.mobileprovision").exists()
assert (app / info["CFBundleExecutable"]).is_file()
output.mkdir(parents=True, exist_ok=True)
ipa = output / f'starpost-ios-{info["CFBundleShortVersionString"]}-unsigned.ipa'
with zipfile.ZipFile(ipa, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for file in sorted(app.rglob("*")):
        if file.is_file():
            archive.write(file, "Payload/Starpost.app/" + file.relative_to(app).as_posix())
checksum = hashlib.sha256(ipa.read_bytes()).hexdigest()
(output / (ipa.name + ".sha256")).write_text(f"{checksum}  {ipa.name}\n", encoding="utf-8")
metadata = {"version": info["CFBundleShortVersionString"], "build": info["CFBundleVersion"], "bundleId": info["CFBundleIdentifier"], "minimumIOS": info["MinimumOSVersion"], "platform": "iphoneos", "architecture": "arm64", "signed": False, "sha256": checksum, "xcode": subprocess.check_output(["xcodebuild", "-version"], text=True).strip(), "installation": "Requires signing before installation on a physical device."}
(output / "build-info.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"Packaged {ipa.name} ({ipa.stat().st_size} bytes)")
