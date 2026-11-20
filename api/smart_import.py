"""LLM-powered import (Smart Import)."""
import json

from flask import jsonify, request

from config import OPENROUTER_API_KEY, OPENROUTER_BASE_URL, app
from helpers import err, require_user


# ---------- LLM-powered import ----------
IMPORT_PROMPT = (
    "You are a parser. The text below is an export from a GLP-1 / weight-loss / "
    "shot-tracking app (e.g. Shotsy, MyFitnessPal, etc.). Extract all shots and weights.\n\n"
    "Return ONLY valid JSON, no markdown fences, with this exact shape:\n"
    "{\n"
    '  "shots": [{"when":"ISO8601 datetime","dose":<mg as number>,"med":"<medication>",'
    '"site":"<one of: Abdomen — Left, Abdomen — Right, Thigh — Left, Thigh — Right, '
    'Upper arm — Left, Upper arm — Right, or empty string>","notes":"<string>"}],\n'
    '  "weights": [{"date":"YYYY-MM-DD","value":<lb as number>,"unit":"lb|kg"}]\n'
    "}\n\n"
    "Rules:\n"
    "- Convert dates to ISO8601 (assume midnight if time is missing).\n"
    "- Convert kg weights to lb if the source uses kg, BUT keep unit:\"kg\" if you cannot convert reliably.\n"
    "- Skip rows that lack a date or dose for shots / a date or value for weights.\n"
    "- If site is unrecognized, return empty string.\n"
    "- Default med to 'Tirzepatide' if not specified.\n"
    "- Output the JSON only.\n\n"
    "INPUT:\n"
)


@app.route('/api/import/parse', methods=['POST'])
def import_parse():
    user = require_user()
    if not user:
        return err('unauthorized', 'Not signed in.', 401)
    if not OPENROUTER_API_KEY:
        return err('llm_unavailable', 'LLM import is not configured on this server.', 503)
    data = request.get_json(silent=True) or {}
    text = (data.get('text') or '')
    if not text or len(text) < 10:
        return err('empty', 'No text to parse.', 400)
    if len(text) > 1_500_000:
        return err('too_large', 'Text exceeds 1.5 MB. Trim and retry.', 413)

    # Chunk on line boundaries so each Gemini call stays under the model's effective response budget.
    # 120K chars per chunk keeps response JSON well under the 32K-token cap even for densely-logged data.
    CHUNK = 120_000
    chunks = []
    if len(text) <= CHUNK:
        chunks = [text]
    else:
        start = 0
        while start < len(text):
            end = min(start + CHUNK, len(text))
            if end < len(text):
                # Backtrack to the last newline so we don't split a row mid-line.
                nl = text.rfind('\n', start, end)
                if nl > start + (CHUNK // 2):
                    end = nl + 1
            chunks.append(text[start:end])
            start = end

    import requests as _r
    all_shots, all_weights = [], []
    for idx, chunk in enumerate(chunks):
        body = {
            'model': '@preset/smart-text',
            'messages': [{'role': 'user', 'content': IMPORT_PROMPT + chunk}],
            'temperature': 0.0,
            'max_tokens': 32768,
            'response_format': {'type': 'json_object'},
        }
        try:
            # The key goes in a header, not the query string: URLs end up in
            # nginx access logs, proxy logs and error traces.
            r = _r.post(
                f'{OPENROUTER_BASE_URL}/chat/completions',
                headers={'Authorization': f'Bearer {OPENROUTER_API_KEY}',
                         'Content-Type': 'application/json'},
                json=body, timeout=150,
            )
        except Exception as e:
            app.logger.exception('LLM call failed (chunk %d/%d): %s', idx + 1, len(chunks), e)
            return err('llm_error', f'AI parser timed out on chunk {idx + 1}/{len(chunks)}. Try a smaller file.', 502)
        if r.status_code != 200:
            app.logger.warning('LLM %s (chunk %d/%d): %s', r.status_code, idx + 1, len(chunks), r.text[:300])
            return err('llm_error', f'AI parser returned {r.status_code} on chunk {idx + 1}/{len(chunks)}.', 502)
        try:
            out = r.json()
            raw = out['choices'][0]['message']['content']
            parsed = json.loads(raw)
        except (KeyError, IndexError, ValueError, TypeError) as e:
            app.logger.warning('LLM malformed (chunk %d/%d): %s — %s', idx + 1, len(chunks), e, r.text[:300])
            # Don't fail the whole import on one bad chunk — log + skip.
            continue
        shots = parsed.get('shots') if isinstance(parsed, dict) else None
        weights = parsed.get('weights') if isinstance(parsed, dict) else None
        if isinstance(shots, list): all_shots.extend(shots)
        if isinstance(weights, list): all_weights.extend(weights)

    # De-dupe across chunks: chunk overlap or repeated headers can produce duplicate rows.
    def _key_shot(s):
        try: return (str(s.get('when',''))[:16], round(float(s.get('dose') or 0), 3))
        except Exception: return (str(s.get('when','')), str(s.get('dose','')))
    def _key_weight(w):
        try: return (str(w.get('date',''))[:10], round(float(w.get('value') or 0), 2))
        except Exception: return (str(w.get('date','')), str(w.get('value','')))
    seen_s, dedup_s = set(), []
    for s in all_shots:
        k = _key_shot(s)
        if k in seen_s: continue
        seen_s.add(k); dedup_s.append(s)
    seen_w, dedup_w = set(), []
    for w in all_weights:
        k = _key_weight(w)
        if k in seen_w: continue
        seen_w.add(k); dedup_w.append(w)

    return jsonify(shots=dedup_s[:5000], weights=dedup_w[:5000], chunks=len(chunks))
