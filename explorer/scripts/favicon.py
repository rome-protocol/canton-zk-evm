"""Rebuilds the explorer's icons in public/ from Rome's mark (src/assets/rome-mark.png; the header draws the same tile as an SVG, components/OstiaMark.tsx).

    python3 explorer/scripts/favicon.py

The Ostia mark: Rome's mark in Rome purple (--canton in src/styles.css) centred on a Canton-lime rounded square (corner radius 22% of the
side, transparent outside the corners). The mark spans 0.7362 of the tile's width: the drawing's 0.76 width, with the 1.5% of padding
its crop leaves on each side. The apple-touch icon is the same square with square corners and no transparency, since iOS rounds the corners
itself and fills transparency with black. Needs Pillow. Only the mark's shape (its alpha) is used, so the edges are resampled without a halo.
"""
from pathlib import Path
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent.parent
MARK = HERE / "src" / "assets" / "rome-mark.png"
OUT = HERE / "public"
PURPLE = (0x5E, 0x0A, 0x60)  # --canton, light theme
LIME = (0xF3, 0xFF, 0x97)    # Canton lime
RADIUS = 0.22                # corner radius, share of the side
MARK_WIDTH = 0.7362          # share of the side
SUPER = 4                    # supersampling for the rounded corners


def tile(shape: Image.Image, size: int, rounded: bool) -> Image.Image:
    """The mark on the lime tile, `size` px square; transparent outside the rounded corners when `rounded`."""
    big = size * SUPER
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, big - 1, big - 1), radius=round(big * RADIUS) if rounded else 0, fill=255)
    canvas = Image.new("RGBA", (big, big), (*LIME, 255))
    canvas.putalpha(mask)
    w = round(big * MARK_WIDTH)
    h = round(w * shape.height / shape.width)
    ink = Image.new("RGBA", (w, h), (*PURPLE, 255))
    ink.putalpha(shape.resize((w, h), Image.LANCZOS))
    canvas.alpha_composite(ink, ((big - w) // 2, (big - h) // 2))
    return canvas.resize((size, size), Image.LANCZOS)


def main() -> None:
    shape = Image.open(MARK).convert("RGBA").getchannel("A")
    OUT.mkdir(exist_ok=True)
    sizes = [16, 32, 48]
    frames = [tile(shape, s, True) for s in sizes]
    frames[-1].save(OUT / "favicon.ico", format="ICO", sizes=[(s, s) for s in sizes], append_images=frames[:-1])
    tile(shape, 32, True).save(OUT / "favicon-32.png", optimize=True)
    tile(shape, 180, False).convert("RGB").save(OUT / "apple-touch-icon.png", optimize=True)


if __name__ == "__main__":
    main()
