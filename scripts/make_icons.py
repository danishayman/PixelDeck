"""Draws the pixel-art app icon (16x16 grid scaled up) into web/icons/."""
from pathlib import Path

from PIL import Image

OUT = Path(__file__).resolve().parent.parent / "web" / "icons"
PAL = {
    ".": (0, 0, 0), "Y": (0xFF, 0xD2, 0x3F), "P": (0xFF, 0x5D, 0xA2),
    "L": (0x9B, 0xE5, 0x64), "C": (0x3D, 0xDC, 0xFF), "K": (0x0A, 0x0A, 0x0A),
}
GRID = [
    "................",
    ".YYYYYYYYYYYYY..",
    ".YKKKKKKKKKKKYP.",
    ".YKKKKKKKKLLKYP.",
    ".YKKKKKKKKLLKYP.",
    ".YKKKKKKKKLLKYP.",
    ".YKKKKKCCKLLKYP.",
    ".YKKKKKCCKLLKYP.",
    ".YKKKKKCCKLLKYP.",
    ".YKKPPKCCKLLKYP.",
    ".YKKPPKCCKLLKYP.",
    ".YKKPPKCCKLLKYP.",
    ".YKKKKKKKKKKKYP.",
    ".YYYYYYYYYYYYYP.",
    "..PPPPPPPPPPPPP.",
    "................",
]


def grid_image(pad: int = 0) -> Image.Image:
    n = len(GRID) + pad * 2
    img = Image.new("RGB", (n, n), PAL["."])
    for y, row in enumerate(GRID):
        for x, ch in enumerate(row):
            img.putpixel((x + pad, y + pad), PAL[ch])
    return img


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    base = grid_image()
    for size in (192, 512):
        base.resize((size, size), Image.Resampling.NEAREST).save(OUT / f"icon-{size}.png")
    # Maskable: keep the art inside the central safe zone.
    grid_image(pad=4).resize((512, 512), Image.Resampling.NEAREST).save(OUT / "icon-maskable-512.png")
    print("icons written to", OUT)


if __name__ == "__main__":
    main()
