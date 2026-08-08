#!/usr/bin/env python3
"""Render every icon asset the PWA and the Play Store need from one SVG master.

Keeping these generated rather than hand-exported means the maskable safe zone
and the monochrome variant can never drift from the mark.

    <venv>/bin/python scripts/build-icons.py [--out web/app/icons]

Android adaptive icons crop to a circle inscribed in the central 66% of the
canvas in the worst case, so the maskable variant re-renders the mark smaller
inside a full-bleed square rather than scaling the finished icon down.
"""
import argparse
import re
from pathlib import Path

import cairosvg
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
MASTER = ROOT / 'web' / 'app' / 'icons' / 'logo.svg'

# Flat teal: gradients band badly once a launcher shrinks and re-masks the icon.
MASKABLE_BG = '#0f8b80'


def render(svg: str, size: int, out: Path):
    cairosvg.svg2png(bytestring=svg.encode(), write_to=str(out),
                     output_width=size, output_height=size)
    print(f'  {out.name}  {size}x{size}')


def variant_maskable(master: str) -> str:
    """Full-bleed square, mark scaled to 62% and centred inside the safe zone."""
    body = master.split('</defs>', 1)[1].rsplit('</svg>', 1)[0]
    body = re.sub(r'<rect[^>]*?/>', '', body, count=1)          # drop the rounded ground
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">'
        f'<rect x="0" y="0" width="1024" height="1024" fill="{MASKABLE_BG}"/>'
        '<g transform="translate(512,512) scale(0.62) translate(-512,-512)">'
        f'{body}'
        '</g></svg>'
    )


def variant_monochrome(master: str) -> str:
    """White mark on transparent, for themed/monochrome launcher icons."""
    body = master.split('</defs>', 1)[1].rsplit('</svg>', 1)[0]
    body = re.sub(r'<rect[^>]*?/>', '', body, count=1)
    body = body.replace('stroke-opacity="0.42"', 'stroke-opacity="0.55"')
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">'
        '<g transform="translate(512,512) scale(0.62) translate(-512,-512)">'
        f'{body}'
        '</g></svg>'
    )


def variant_play_store(master: str) -> str:
    """512x512 Play Store listing icon: full-bleed square, no rounded corners.

    Play applies its own corner treatment; supplying pre-rounded corners leaves
    visible dark notches behind the platform mask.
    """
    return master.replace('rx="224" ry="224"', 'rx="0" ry="0"')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=str(ROOT / 'web' / 'app' / 'icons'))
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    master = MASTER.read_text()

    print('standard:')
    for size, name in [(512, 'icon-512.png'), (192, 'icon-192.png'),
                       (180, 'apple-touch-icon.png'), (96, 'favicon-96.png'),
                       (32, 'favicon-32.png'), (16, 'favicon-16.png')]:
        render(master, size, out / name)

    print('maskable (Android adaptive):')
    render(variant_maskable(master), 512, out / 'icon-maskable-512.png')

    print('monochrome (themed launcher):')
    render(variant_monochrome(master), 512, out / 'icon-mono-512.png')

    print('Play Store listing:')
    render(variant_play_store(master), 512, out / 'play-store-512.png')

    # Multi-resolution .ico for legacy browser tabs.
    ico = out / 'favicon.ico'
    imgs = [Image.open(out / n) for n in ('favicon-16.png', 'favicon-32.png', 'favicon-96.png')]
    imgs[0].save(ico, format='ICO', sizes=[(16, 16), (32, 32), (96, 96)])
    print(f'  {ico.name}  16/32/96')


if __name__ == '__main__':
    main()
