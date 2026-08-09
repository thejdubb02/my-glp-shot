#!/usr/bin/env python3
# SUPERSEDED 2026-08-09 by scripts/build-social-cards.py. Do not run this: it
# overwrites the four share cards with an AI-generated hero that carries no brand
# mark and differs on every run. The two cards it had produced showed two
# different logos, neither of which was the app icon.
#
# Kept only for the Pillow compositing reference. Delete once nothing needs it.
#
# Generate the My GLP Shot social-share Open Graph image.
#
# Pipeline: Imagen 4 produces a 1280x720 hero illustration with NO text (Imagen
# can't render typography reliably). Pillow then crops/pads to 1200x630, adds a
# left-side gradient overlay for legibility, and composites brand text + tagline
# + URL strip on top using system fonts.
#
# Outputs:
#   /opt/my-glp-shot/web/landing/og-image.png   — Open Graph (1200x630)
#   /opt/my-glp-shot/web/landing/twitter-image.png — Twitter large (1200x675)
#   /opt/my-glp-shot/web/app/og-image.png       — same image, served from PWA host
#   /opt/my-glp-shot/web/app/twitter-image.png

import base64, io, json, os, re, urllib.request

KEY_FILE = "/root/.openclaw/openclaw.json"
LANDING  = "/opt/my-glp-shot/web/landing"
APP_DIR  = "/opt/my-glp-shot/web/app"
MODEL    = "gemini-3.1-flash-image"  # migrated from imagen-4.0-generate-001 (discontinued 2026-08-17)

# Same visual language as the achievement art so the brand reads cohesive across
# the marketing site and the in-app share cards. NO TEXT, NO LETTERS, NO NUMBERS
# — Imagen routinely hallucinates garbage typography. We add real text afterwards
# with Pillow.
PROMPT = (
  "Wide 16:9 modern wellness app marketing hero scene, bright and friendly. A single "
  "sleek smartphone shown at a 3/4 angle on the right side of the composition. The phone "
  "screen displays a clean health-tracking app interface with a soft cream and warm "
  "off-white background, a circular countdown ring rendered in warm bronze and teal at "
  "the top, a downward-trending weight progress line chart in teal underneath, and a row "
  "of small friendly mood emoji circles near the bottom of the screen — all light, soft, "
  "and approachable. The phone has a thin matte bezel, subtle drop shadow. Background of "
  "the scene is a soft pastel gradient blending warm cream, peach, and mint teal, with "
  "a few abstract organic blobs and subtle dots floating in the empty space. Brand mood: "
  "Headspace, Calm, MyFitnessPal — gentle, optimistic, wellness-focused, NOT clinical, "
  "NOT dark, NOT luxury. Empty space on the LEFT side for typography. No syringes, no "
  "needles, no medical iconography, no pills. No text, no letters, no numbers, no "
  "watermark, no logos, no readable UI labels. Photorealistic, soft daylight studio lighting."
)

def load_key():
    txt = open(KEY_FILE).read()
    m = re.search(r'"GOOGLE_AI_API_KEY":\s*"([^"]+)"', txt)
    if not m: raise SystemExit("GOOGLE_AI_API_KEY not found")
    return m.group(1)

def generate_hero(api_key):
    # Gemini image gen via :generateContent (Imagen 4 :predict was discontinued 2026-08-17).
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={api_key}"
    body = json.dumps({
        "contents": [{"parts": [{"text": PROMPT}]}],
        "generationConfig": {"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": "16:9"}},
    }).encode()
    req = urllib.request.Request(url, data=body, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        data = json.loads(r.read())
    parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
    for p in parts:
        inline = p.get("inlineData") or p.get("inline_data")
        if inline and inline.get("data"):
            return base64.b64decode(inline["data"])
    raise RuntimeError(f"no image in response: {str(data)[:400]}")

def find_font(prefer_bold=False):
    candidates = (
      "/usr/share/fonts/truetype/dejavu/DejaVu-Sans-Bold.ttf",
      "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
      "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
      "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
      "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    )
    if prefer_bold:
        for c in candidates:
            if "Bold" in c and os.path.exists(c): return c
    for c in candidates:
        if os.path.exists(c): return c
    return None

def compose(hero_bytes, out_w, out_h, save_path):
    from PIL import Image, ImageDraw, ImageFont, ImageFilter
    src = Image.open(io.BytesIO(hero_bytes)).convert("RGB")
    # Resize so the shorter dimension matches, center-crop to target.
    sw, sh = src.size
    src_ratio = sw / sh
    tgt_ratio = out_w / out_h
    if src_ratio > tgt_ratio:
        nh = out_h
        nw = int(out_h * src_ratio)
    else:
        nw = out_w
        nh = int(out_w / src_ratio)
    src = src.resize((nw, nh), Image.LANCZOS)
    left = max(0, (nw - out_w) // 2)
    top  = max(0, (nh - out_h) // 2)
    canvas = src.crop((left, top, left + out_w, top + out_h))
    # Soft cream wash on the left so text reads cleanly against varying hero backdrops.
    overlay = Image.new("RGBA", (out_w, out_h), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    grad_w = int(out_w * 0.62)
    for x in range(grad_w):
        t = x / grad_w
        # cream/off-white wash, ease-out fade
        alpha = int(225 * (1 - t) ** 1.5)
        od.line([(x, 0), (x, out_h)], fill=(252, 244, 232, alpha))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), overlay)
    draw = ImageDraw.Draw(canvas)
    # Brand strip across the bottom: bronze band, soft and warm
    strip_h = int(out_h * 0.12)
    strip_top = out_h - strip_h
    draw.rectangle([(0, strip_top), (out_w, out_h)], fill=(199, 145, 91, 255))     # WSG bronze
    draw.rectangle([(0, strip_top - 2), (out_w, strip_top)], fill=(131, 84, 46, 255))  # bronze-dk pin-stripe
    # Typography
    font_bold = find_font(prefer_bold=True)
    font_reg  = find_font(prefer_bold=False)
    title_font   = ImageFont.truetype(font_bold, int(out_h * 0.13))
    tag_font     = ImageFont.truetype(font_reg,  int(out_h * 0.046))
    eyebrow_font = ImageFont.truetype(font_bold, int(out_h * 0.038))
    brand_font   = ImageFont.truetype(font_bold, int(out_h * 0.06))
    url_font     = ImageFont.truetype(font_reg,  int(out_h * 0.045))
    # Eyebrow (warm bronze, sits on the cream wash)
    eyebrow = "PRIVATE GLP-1 TRACKER · WORKS OFFLINE"
    eb_x = int(out_w * 0.06)
    eb_y = int(out_h * 0.16)
    draw.text((eb_x, eb_y), eyebrow, font=eyebrow_font, fill=(131, 84, 46, 255))
    # Title — deep navy/charcoal for strong contrast on cream
    title_x = int(out_w * 0.06)
    title_y = eb_y + int(out_h * 0.08)
    draw.text((title_x, title_y), "My GLP Shot", font=title_font, fill=(28, 36, 56, 255))
    # Tagline (two lines, softer charcoal)
    tag_y = title_y + int(out_h * 0.18)
    line1 = "Log shots. Track weight."
    line2 = "Your data stays on your device."
    draw.text((title_x, tag_y), line1, font=tag_font, fill=(60, 72, 96, 255))
    draw.text((title_x, tag_y + int(out_h * 0.06)), line2, font=tag_font, fill=(60, 72, 96, 255))
    # Brand strip text — white on bronze
    sb_y = strip_top + int(strip_h * 0.22)
    draw.text((int(out_w * 0.06), sb_y), "My GLP Shot", font=brand_font, fill=(255, 255, 255, 255))
    url_text = "myglpshot.com"
    url_bbox = draw.textbbox((0, 0), url_text, font=url_font)
    url_w = url_bbox[2] - url_bbox[0]
    draw.text((out_w - url_w - int(out_w * 0.06), sb_y + int(strip_h * 0.08)), url_text, font=url_font, fill=(255, 255, 255, 230))
    canvas.convert("RGB").save(save_path, "PNG", optimize=True)
    return os.path.getsize(save_path)

def main():
    # Cache the Imagen output so iterating on layout is cheap.
    cache = "/tmp/mgs-og-hero.png"
    if os.path.exists(cache) and "--regen" not in __import__("sys").argv:
        print("Using cached hero (pass --regen to fetch a new one)")
        hero_bytes = open(cache, "rb").read()
    else:
        api_key = load_key()
        print("Generating hero via Imagen 4…")
        hero_bytes = generate_hero(api_key)
        with open(cache, "wb") as f: f.write(hero_bytes)
    print(f"  got {len(hero_bytes)//1024} KB")
    targets = [
        (1200, 630, os.path.join(LANDING, "og-image.png")),
        (1200, 675, os.path.join(LANDING, "twitter-image.png")),
        (1200, 630, os.path.join(APP_DIR, "og-image.png")),
        (1200, 675, os.path.join(APP_DIR, "twitter-image.png")),
    ]
    for w, h, p in targets:
        sz = compose(hero_bytes, w, h, p)
        print(f"  wrote {p}  {w}x{h}  {sz//1024} KB")
    print("done")

if __name__ == "__main__":
    main()
