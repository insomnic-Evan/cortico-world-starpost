"""Rasterize Starpost's existing envelope/spark vector for Apple's app-icon sizes.
Only needed when changing the icon. Build machines use the checked-in PNGs.
Requires Pillow, no remote assets or model generation.
"""
from pathlib import Path
import json
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1] / "Starpost/Assets.xcassets"
out = root / "AppIcon.appiconset"
out.mkdir(parents=True, exist_ok=True)
image = Image.new("RGB", (2048, 2048))
pixels = image.load()
for y in range(2048):
    t = y / 2047
    color = tuple(round(a + (b - a) * t) for a, b in zip((93, 88, 205), (53, 67, 151)))
    ImageDraw.Draw(image).line((0, y, 2048, y), fill=color)
d = ImageDraw.Draw(image)
def rect(values): return tuple(round(v * 2048 / 108) for v in values)
def points(values): return [rect(point) for point in values]
d.rounded_rectangle(rect((26, 40, 78, 73)), radius=round(6 * 2048 / 108), outline="white", width=round(4 * 2048 / 108))
d.line(points([(28, 43), (52, 60), (76, 43)]), fill="white", width=round(4 * 2048 / 108), joint="curve")
d.polygon(points([(73, 24), (76, 31), (83, 34), (76, 37), (73, 44), (70, 37), (63, 34), (70, 31)]), fill="#B8ECDD")
entries = []
for idiom, sizes in [("iphone", [(20, 2), (20, 3), (29, 2), (29, 3), (40, 2), (40, 3), (60, 2), (60, 3)]), ("ipad", [(20, 1), (20, 2), (29, 1), (29, 2), (40, 1), (40, 2), (76, 1), (76, 2), (83.5, 2)]), ("ios-marketing", [(1024, 1)])]:
    for size, scale in sizes:
        side = round(size * scale)
        filename = f"icon-{side}.png"
        image.resize((side, side), Image.Resampling.LANCZOS).save(out / filename)
        entries.append({"idiom": idiom, "size": f"{size}x{size}", "scale": f"{scale}x", "filename": filename})
(out / "Contents.json").write_text(json.dumps({"images": entries, "info": {"author": "xcode", "version": 1}}, indent=2) + "\n", encoding="utf-8")
(root / "Contents.json").write_text('{"info":{"author":"xcode","version":1}}\n', encoding="utf-8")
print("Generated Starpost app icons")
