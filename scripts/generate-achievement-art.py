#!/usr/bin/env python3
# Pre-generate achievement hero art via Google Imagen 4 (fast).
# One PNG per achievement id, 1024x1024, saved to web/app/icons/achievements/.
# Re-run is idempotent: skips files that already exist unless --force.

import base64, json, os, sys, time, urllib.request, urllib.error, re

KEY_FILE = "/root/.openclaw/openclaw.json"
OUT_DIR  = "/opt/my-glp-shot/web/app/icons/achievements"
MODEL    = "gemini-3.1-flash-image"  # migrated from imagen-4.0-generate-001 (discontinued 2026-08-17)

# Same ids as ACHIEVEMENTS in app.js. Each prompt is a self-contained scene
# so the icons feel distinct, not just colour-shifted versions of one shape.
# STANDARDIZED prompt template. Every badge follows the same visual language so the
# collection feels like a coherent set, not 30 unrelated illustrations:
#   • 3D embossed metallic medal/coin, polished gold-bronze with subtle highlights
#   • Centered sculpted subject filling 60% of the composition
#   • Deep navy radial gradient background with subtle vignette + a faint gold ring
#   • Studio lighting, cinematic, premium app trophy aesthetic
#   • No text, no letters, no watermark — the subject conveys the meaning
STYLE = (
  "3D embossed metallic medallion icon, polished gold and bronze finish with soft realistic studio "
  "lighting, deep dark navy blue radial gradient background with a faint gold ring framing the edge, "
  "centered sculpted subject filling about 60 percent of the composition, premium app trophy "
  "aesthetic similar to Apple Fitness or Duolingo league badges, clean vector-like silhouette, "
  "subtle inner glow, square 1:1 composition. No text, no letters, no watermark, no numbers in the image."
)

PROMPTS = {
  # Shot count
  "first":      f"A single polished gold-and-rose-gold insulin syringe held diagonally with a small confetti burst of warm bronze sparkles. {STYLE}",
  "three":      f"Three polished gold insulin syringes arranged in a tight fan formation, their tips meeting at center, gold sparks behind. {STYLE}",
  "ten":        f"A single large polished gold coin with a deep engraved laurel wreath ring, soft glow at center. {STYLE}",
  "twentyfive": f"A polished gold target with a single arrow striking dead center, tight bullseye, subtle starburst behind. {STYLE}",
  "fifty":      f"An open polished gold hand, palm facing forward fingers spread, ringed by a thin gold halo and small twinkles. {STYLE}",
  "hundred":    f"A grand layered gold medal hanging from a deep crimson velvet ribbon with a starburst rosette at the top, fireworks of small gold sparks behind. {STYLE}",
  "twohundred": f"A double-tier gold and bronze medal stack with engraved laurels wrapping both layers, premium prestige finish. {STYLE}",
  "fivehundred":f"An ornate antique gold service medallion with a polished engraved star at center surrounded by intricate filigree, prestige veteran-tier finish. {STYLE}",
  # Streaks (consistency)
  "streak2":    f"A single stylized polished gold flame, slim and elegant, with a soft warm glow. {STYLE}",
  "streak4":    f"A larger stylized polished gold flame with a small bronze core, warm glow halo. {STYLE}",
  "streak8":    f"A polished gold lightning bolt with a soft electric glow, dynamic and angular. {STYLE}",
  "streak12":   f"A sleek streamlined polished gold rocket trailing a stardust comet of small bronze sparks, dynamic diagonal motion. {STYLE}",
  "streak26":   f"A tall classic polished gold trophy cup with engraved laurel branches wrapping the cup, two upright handles. {STYLE}",
  "streak52":   f"A regal jeweled polished gold crown with small ruby-red gemstones at the points, ornate filigree band. {STYLE}",
  "streak104":  f"A faceted brilliant-cut diamond rendered in clear crystal with internal rainbow refractions, set on a small gold pedestal, sparkles around. {STYLE}",
  # Weight loss
  "lost2":      f"A young green sapling with two leaves emerging from polished gold soil, soft glow. {STYLE}",
  "lost5":      f"A single five-pointed star sculpted in polished gold with a tiny etched balance scale silhouette behind it. {STYLE}",
  "lost10":     f"A radiant ten-point starburst sculpted in polished gold and emerald, rays extending outward. {STYLE}",
  "lost15":     f"A polished emerald heart with gold filigree edges, soft inner glow. {STYLE}",
  "lost25":     f"A shooting star sculpted in polished gold with a long emerald vapor trail and small twinkles along the tail. {STYLE}",
  "lost40":     f"A bright comet sculpted in polished gold with a sweeping emerald tail forming an arc, several small stars in its wake. {STYLE}",
  "lost50":     f"A massive ornate sunburst sculpted in polished emerald and bright gold, twelve sharp rays radiating outward from a central polished orb. {STYLE}",
  "lost75":     f"A graceful butterfly sculpted in polished gold and emerald with intricate engraved wing patterns. {STYLE}",
  "lost100":    f"A majestic polished gold mountain peak with a small flag planted at the summit, dramatic shadows, prestige tier finish. {STYLE}",
  # Dose ladder
  "titrate":    f"Three sculpted 3D bars rising in size from left to right with a polished gold upward arrow soaring past the tallest bar. {STYLE}",
  "maintain":   f"A polished gold balance scale, both pans perfectly level, sitting on a small ornate pedestal. {STYLE}",
  # Engagement
  "mood7":      f"A polished gold smiling sun with seven distinct rays radiating outward, warm cheerful glow. {STYLE}",
  "mood30":     f"A polished gold thought bubble with a small sparkling heart inside, soft inner glow. {STYLE}",
  "weight10":   f"A polished gold bar chart with three rising bars and a small magnifying glass overlapping them. {STYLE}",
  "weight50":   f"A polished gold downward-trending line graph with several plotted dots and a small flag at the lowest point. {STYLE}",
  # Special
  "comeback":   f"A polished gold sunrise emerging from behind a stylized horizon line, golden rays fanning upward. {STYLE}",
  "centurion":  f"An ornate polished gold heraldic shield with a small engraved 100 etched at center, surrounded by laurels. {STYLE}",
}

def load_key():
    txt = open(KEY_FILE).read()
    m = re.search(r'"GOOGLE_AI_API_KEY":\s*"([^"]+)"', txt)
    if not m: raise SystemExit("GOOGLE_AI_API_KEY not found")
    return m.group(1)

def gen(api_key, badge_id, prompt):
    # Gemini image gen via :generateContent (Imagen 4 :predict was discontinued 2026-08-17).
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={api_key}"
    body = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": "1:1"}},
    }).encode()
    req = urllib.request.Request(url, data=body, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as r:
        data = json.loads(r.read())
    parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
    for p in parts:
        inline = p.get("inlineData") or p.get("inline_data")
        if inline and inline.get("data"):
            return base64.b64decode(inline["data"])
    raise RuntimeError(f"no image in response for {badge_id}: {str(data)[:400]}")

def main():
    force = "--force" in sys.argv
    only  = [a for a in sys.argv[1:] if not a.startswith("--")]
    os.makedirs(OUT_DIR, exist_ok=True)
    api_key = load_key()
    targets = PROMPTS.items() if not only else [(k, PROMPTS[k]) for k in only if k in PROMPTS]
    # Lazy import PIL so the script runs without it for prompt-only edits.
    try:
        from PIL import Image
        import io
    except ImportError:
        print("Pillow required: pip install Pillow")
        return
    for bid, prompt in targets:
        out = os.path.join(OUT_DIR, f"{bid}.webp")
        if os.path.exists(out) and not force:
            print(f"skip {bid} (exists)")
            continue
        for attempt in range(3):
            try:
                png = gen(api_key, bid, prompt)
                # Resize and write as WebP (massively smaller for the same fidelity).
                im = Image.open(io.BytesIO(png)).convert("RGB").resize((640, 640), Image.LANCZOS)
                im.save(out, "WEBP", quality=85, method=6)
                kb = os.path.getsize(out) // 1024
                print(f"ok   {bid}  {kb} KB")
                break
            except Exception as e:
                print(f"fail {bid} attempt {attempt+1}: {e}")
                time.sleep(2 + attempt * 2)
        else:
            print(f"GIVE UP on {bid}")
    print("done")

if __name__ == "__main__":
    main()
