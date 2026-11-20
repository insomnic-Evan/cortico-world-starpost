"""Select the newest available iOS 27+ phone runtime and record it in the job log."""
import json
import re
import sys

candidates = []
for runtime, devices in json.load(sys.stdin)["devices"].items():
    version = re.fullmatch(r"com\.apple\.CoreSimulator\.SimRuntime\.iOS-(\d+(?:-\d+)*)", runtime)
    if version:
        parts = tuple(map(int, version[1].split("-")))
        for device in devices:
            if parts[0] >= 27 and device.get("isAvailable") and device["name"].startswith("iPhone"):
                candidates.append((parts, device["name"], device["udid"]))
if not candidates:
    sys.exit("An available iPhone simulator on iOS 27 or later is required.")
version, name, udid = max(candidates)
print(name, "iOS", ".".join(map(str, version)), file=sys.stderr)
print(udid)
