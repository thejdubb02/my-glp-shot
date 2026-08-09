#!/usr/bin/env python3
"""Render the Open Graph and Twitter share cards from the brand mark.

Replaces the AI-hero pipeline in generate-og-image.py for these four files. That
approach produced a different picture on every run, and neither of the two cards
it left behind carried the app icon — the landing card showed a shield-and-swoosh
mark that appears nowhere else in the product and spelled the name "MyGLPShot",
while the app card showed a phone mockup and no mark at all. Three brand marks in
one product is worse than a plainer card.

This is deterministic: same logo.svg in, same PNG out, so the cards cannot drift
away from the icon again.

    <venv>/bin/python scripts/build-social-cards.py
"""
import argparse
import io
from pathlib import Path

import cairosvg
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
LOGO = ROOT / 'web' / 'app' / 'icons' / 'logo.svg'
FONT_DIR = Path('/usr/share/fonts/truetype/lato')

# Same teal as the icon ground, so the card and the app icon read as one brand.
TEAL_TOP = (20, 184, 166)
TEAL_BOT = (13, 106, 98)
CREAM = (246, 250, 249)
MINT = (204, 251, 241)

CARDS = [
    ('og-image.png', 1200, 630),
    ('twitter-image.png', 1200, 675),
]
TARGETS = [ROOT / 'web' / 'landing', ROOT / 'web' / 'app']

TAGLINE = 'Log shots. Track weight. Spot patterns.'
SUBLINE = 'Private by design — your data is encrypted on your device.'
URL = 'myglpshot.com'


def font(name, size):
    return ImageFont.truetype(str(FONT_DIR / name), size)


def vertical_gradient(size, top, bottom):
    w, h = size
    grad = Image.new('RGB', (1, h))
    px = grad.load()
    for y in range(h):
        t = y / max(1, h - 1)
        px[0, y] = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    return grad.resize((w, h), Image.BILINEAR)


def render_mark(px):
    """The icon's ring + droplet on transparent, at `px` square."""
    svg = LOGO.read_text()
    # Drop the rounded-square ground: the card supplies its own background, and
    # a tile-within-a-tile reads as a screenshot of an icon rather than a logo.
    start = svg.index('<rect')
    end = svg.index('/>', start) + 2
    svg = svg[:start] + svg[end:]
    svg = svg.replace('stroke-opacity="0.62"', 'stroke-opacity="0.75"')
    png = cairosvg.svg2png(bytestring=svg.encode(), output_width=px, output_height=px)
    return Image.open(io.BytesIO(png)).convert('RGBA')


def build(width, height):
    img = vertical_gradient((width, height), TEAL_TOP, TEAL_BOT).convert('RGBA')
    d = ImageDraw.Draw(img)

    # A low-contrast halo behind the mark. Kept clear of the type: a wider radius
    # put its left edge straight through the tagline, where it read as a stray
    # line rather than depth.
    ghost = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    gd = ImageDraw.Draw(ghost)
    r = int(height * 0.60)
    cx, cy = int(width * 0.80), height // 2
    gd.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(255, 255, 255, 30), width=int(height * 0.05))
    img = Image.alpha_composite(img, ghost)
    d = ImageDraw.Draw(img)

    # Mark, right-hand side.
    mark_px = int(height * 0.62)
    mark = render_mark(mark_px)
    img.paste(mark, (int(width * 0.72) - mark_px // 2, (height - mark_px) // 2), mark)

    # Type, left-hand side.
    left = int(width * 0.065)
    title_f = font('Lato-Black.ttf', int(height * 0.125))
    tag_f = font('Lato-Semibold.ttf', int(height * 0.052))
    sub_f = font('Lato-Regular.ttf', int(height * 0.038))
    url_f = font('Lato-Bold.ttf', int(height * 0.040))

    block_h = int(height * 0.125) + int(height * 0.052) * 2 + int(height * 0.038) + int(height * 0.10)
    y = (height - block_h) // 2

    d.text((left, y), 'My GLP Shot', font=title_f, fill=(255, 255, 255))
    y += int(height * 0.155)
    d.text((left, y), TAGLINE, font=tag_f, fill=MINT)
    y += int(height * 0.082)
    d.text((left, y), SUBLINE, font=sub_f, fill=(226, 245, 242))
    y += int(height * 0.095)

    # URL on a soft pill so it reads as a destination, not another line of copy.
    tw = d.textlength(URL, font=url_f)
    pad_x, pad_y = int(height * 0.026), int(height * 0.018)
    pill = Image.new('RGBA', (int(tw) + pad_x * 2, int(height * 0.040) + pad_y * 2), (0, 0, 0, 0))
    ImageDraw.Draw(pill).rounded_rectangle(
        [0, 0, pill.width - 1, pill.height - 1], radius=pill.height // 2, fill=(255, 255, 255, 38))
    img.paste(pill, (left, y), pill)
    ImageDraw.Draw(img).text((left + pad_x, y + pad_y - 2), URL, font=url_f, fill=CREAM)

    return img.convert('RGB')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--quality', type=int, default=90)
    args = ap.parse_args()
    for name, w, h in CARDS:
        card = build(w, h)
        for target in TARGETS:
            out = target / name
            # optimize keeps these near 60 KB; the AI heroes they replace were
            # 560 KB and 1.1 MB, which crawlers and previews had to pull every time.
            card.save(out, 'PNG', optimize=True)
            print(f'  {out.relative_to(ROOT)}  {w}x{h}  {out.stat().st_size // 1024} KB')


if __name__ == '__main__':
    main()
