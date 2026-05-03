#!/usr/bin/env python3
# Pre-generate achievement hero art via Google Imagen 4 (fast).
# One PNG per achievement id, 1024x1024, saved to web/app/icons/achievements/.
# Re-run is idempotent: skips files that already exist unless --force.

import base64, json, os, sys, time, urllib.request, urllib.error, re

KEY_FILE = "/root/.openclaw/openclaw.json"
OUT_DIR  = "/opt/my-glp-shot/web/app/icons/achievements"
MODEL    = "imagen-4.0-fast-generate-001"

# Same ids as ACHIEVEMENTS in app.js. Each prompt is a self-contained scene
# so the icons feel distinct, not just colour-shifted versions of one shape.
PROMPTS = {
  "first":    "Flat vector medallion: a single insulin syringe with confetti bursting out, golden bronze gradient circle background, modern minimalist illustration, premium achievement badge style, centered, plain solid background, no text",
  "ten":      "Flat vector achievement medal: a large stylized number 10 on a polished bronze coin, subtle sparkles, modern flat illustration, premium badge style, centered, plain solid background, no text",
  "fifty":    "Flat vector achievement medal: a high-five hand with five fingers spread, surrounded by a glowing bronze ring and small stars, modern flat illustration, centered, plain solid background, no text",
  "hundred":  "Flat vector achievement medal: a bold 100 numeral on a deep red and gold ribboned medallion, fireworks behind, modern flat illustration, premium prestige badge, centered, plain solid background, no text",
  "streak4":  "Flat vector achievement medal: a stylized flame icon with a small 4 inside the flame, warm bronze and orange gradient background, modern flat illustration, centered, plain solid background, no text",
  "streak12": "Flat vector achievement medal: a rocket trailing a comet streak of bronze stars, dynamic motion, modern flat illustration, premium badge, centered, plain solid background, no text",
  "streak26": "Flat vector achievement medal: a tall trophy cup with laurel branches on either side, deep bronze gradient, modern flat illustration, centered, plain solid background, no text",
  "streak52": "Flat vector achievement medal: a regal crown sitting above a 1-year ribbon banner, gold and bronze tones, modern flat illustration, premium prestige badge, centered, plain solid background, no text",
  "lost5":    "Flat vector achievement medal: a single bright star with a small silhouette of a balance scale beneath, soft green and bronze tones suggesting progress, modern flat illustration, centered, plain solid background, no text",
  "lost10":   "Flat vector achievement medal: a glowing star burst with a downward-trending line graph behind it, fresh green and bronze gradient, modern flat illustration, centered, plain solid background, no text",
  "lost25":   "Flat vector achievement medal: a sparkling shooting star with a measuring tape coiling beneath, vibrant green and bronze gradient, modern flat illustration, premium badge, centered, plain solid background, no text",
  "lost50":   "Flat vector achievement medal: a large radiant sparkle starburst with confetti, bold emerald green and gold gradient, premium prestige badge, modern flat illustration, centered, plain solid background, no text",
  "titrate":  "Flat vector achievement medal: a clean ascending bar chart with an upward arrow, bronze gradient background, modern flat illustration, centered, plain solid background, no text",
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
