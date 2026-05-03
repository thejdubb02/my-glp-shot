#!/usr/bin/env python3
# Pre-generate achievement hero art via Google Imagen 4 (fast).
# One PNG per achievement id, 1024x1024, saved to web/app/icons/achievements/.
# Re-run is idempotent: skips files that already exist unless --force.

import base64, json, os, sys, time, urllib.request, urllib.error, re

KEY_FILE = "/root/.openclaw/openclaw.json"
OUT_DIR  = "/opt/my-glp-shot/web/app/icons/achievements"
MODEL    = "imagen-4.0-generate-001"

# Same ids as ACHIEVEMENTS in app.js. Each prompt is a self-contained scene
# so the icons feel distinct, not just colour-shifted versions of one shape.
STYLE = ("Luxe achievement medallion, 3D embossed metallic finish with soft realistic lighting, polished and gilded, "
         "centered subject filling the composition, dark navy radial gradient background, subtle inner glow, "
         "premium app trophy aesthetic in the spirit of Apple Fitness rings or Duolingo league badges, "
         "vector-clean shapes, no text, no watermark, no letters, square 1:1.")

PROMPTS = {
  "first":    f"Polished gold and rose-gold insulin syringe with a soft confetti burst of warm bronze and cream particles. {STYLE}",
  "ten":      f"Large stylized numeral 10 sculpted in polished bronze with engraved highlights, sitting on a circular gilded coin with subtle starburst rays. {STYLE}",
  "fifty":    f"Five-fingered open hand sculpted in polished bronze, palm forward, ringed by a thin gold halo and small twinkles. {STYLE}",
  "hundred":  f"Bold sculpted 100 numeral on a layered ribbon-and-laurel gold medal, deep crimson velvet ribbon trailing, fireworks of gold sparks behind. {STYLE}",
  "streak4":  f"Stylized 3D flame in molten gold and bronze with a delicate engraved 4 visible inside the flame core, warm glow. {STYLE}",
  "streak12": f"Sleek streamlined rocket sculpted in chrome and bronze trailing a stardust comet of small gold particles, dynamic diagonal motion. {STYLE}",
  "streak26": f"Tall classic trophy cup sculpted in polished gold with engraved laurel branches wrapping the cup, deep navy backdrop. {STYLE}",
  "streak52": f"Regal jeweled crown sculpted in polished gold with small ruby-red gemstones, sitting above a softly draped gold ribbon banner. {STYLE}",
  "lost5":    f"Single five-pointed star sculpted in polished emerald-and-gold bimetal, gentle scale-of-balance silhouette etched faintly behind. {STYLE}",
  "lost10":   f"Radiant burst sculpted in polished gold and emerald with a downward-sweeping ribbon arc behind it, suggesting progress. {STYLE}",
  "lost25":   f"Shooting star sculpted in polished gold with a long emerald vapor trail and small twinkles along the tail. {STYLE}",
  "lost50":   f"Massive ornate starburst sculpted in polished emerald-green and bright gold, rays radiating outward, prestige tier finish. {STYLE}",
  "titrate":  f"Three sculpted 3D bars rising in size left to right with an upward gold arrow soaring past the tallest bar, polished bronze finish. {STYLE}",
}

def load_key():
    txt = open(KEY_FILE).read()
    m = re.search(r'"GOOGLE_AI_API_KEY":\s*"([^"]+)"', txt)
    if not m: raise SystemExit("GOOGLE_AI_API_KEY not found")
    return m.group(1)

def gen(api_key, badge_id, prompt):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:predict?key={api_key}"
    body = json.dumps({
        "instances": [{"prompt": prompt}],
        "parameters": {"sampleCount": 1, "aspectRatio": "1:1"},
    }).encode()
    req = urllib.request.Request(url, data=body, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as r:
        data = json.loads(r.read())
    preds = data.get("predictions", [])
    if not preds or "bytesBase64Encoded" not in preds[0]:
        raise RuntimeError(f"unexpected response for {badge_id}: {str(data)[:400]}")
    return base64.b64decode(preds[0]["bytesBase64Encoded"])

def main():
    force = "--force" in sys.argv
    only  = [a for a in sys.argv[1:] if not a.startswith("--")]
    os.makedirs(OUT_DIR, exist_ok=True)
    api_key = load_key()
    targets = PROMPTS.items() if not only else [(k, PROMPTS[k]) for k in only if k in PROMPTS]
    for bid, prompt in targets:
        out = os.path.join(OUT_DIR, f"{bid}.png")
        if os.path.exists(out) and not force:
            print(f"skip {bid} (exists)")
            continue
        for attempt in range(3):
            try:
                png = gen(api_key, bid, prompt)
                with open(out, "wb") as f: f.write(png)
                print(f"ok   {bid}  {len(png)//1024} KB")
                break
            except Exception as e:
                print(f"fail {bid} attempt {attempt+1}: {e}")
                time.sleep(2 + attempt * 2)
        else:
            print(f"GIVE UP on {bid}")
    print("done")

if __name__ == "__main__":
    main()
