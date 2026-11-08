"""Rebuilds the explorer's icons in public/ from the header mark (src/assets/rome-mark.png).

    python3 explorer/scripts/favicon.py

The mark is drawn in the header's colour (--canton in src/styles.css) on a transparent background; the apple-touch icon sits on the page
colour (--bg) as a solid square, since iOS does not keep transparency. Needs Pillow. Only the mark's shape (its alpha) is used, so the
edges are resampled without a halo.
"""
from pathlib import Path
from PIL import Image

HERE = Path(__file__).resolve().parent.parent
MARK = HERE / "src" / "assets" / "rome-mark.png"
OUT = HERE / "public"
CANTON = (0x5E, 0x0A, 0x60)  # --canton, light theme
BG = (0xFB, 0xF8, 0xF4)      # --bg, light theme


def drawn(shape: Image.Image, size: int, width: float, background) -> Image.Image:
    """The mark, `width` of the square wide and centred, in CANTON, on `background` (None: transparent)."""
    w = max(1, round(size * width))
    h = max(1, round(w * shape.height / shape.width))
    alpha = shape.resize((w, h), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (*background, 255) if background else (*CANTON, 0))
    ink = Image.new("RGBA", (w, h), (*CANTON, 255))
    ink.putalpha(alpha)
    canvas.alpha_composite(ink, ((size - w) // 2, (size - h) // 2))
    return canvas


def main() -> None:
    shape = Image.open(MARK).convert("RGBA").getchannel("A")
    OUT.mkdir(exist_ok=True)
    sizes = [16, 32, 48]
    frames = [drawn(shape, s, 0.94, None) for s in sizes]
    frames[-1].save(OUT / "favicon.ico", format="ICO", sizes=[(s, s) for s in sizes], append_images=frames[:-1])
    drawn(shape, 32, 0.94, None).save(OUT / "favicon-32.png", optimize=True)
    drawn(shape, 180, 0.66, BG).convert("RGB").save(OUT / "apple-touch-icon.png", optimize=True)


if __name__ == "__main__":
    main()
