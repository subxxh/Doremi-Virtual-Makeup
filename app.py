"""
Serves the landing page at / and the Vite WebGL SPA at /app,
and exposes a small vision API for AI makeup color reads.

**Hugging Face Space:** add a repository secret named `GEMINI_API_KEY`.
Create a key: https://aistudio.google.com/apikey

Without a key, `POST /api/analyze-makeup-colors` returns HTTP 503.
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import re
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

_ROOT = Path(__file__).resolve().parent
for _env_path in (_ROOT / ".env", _ROOT / "webgl" / ".env"):
    if _env_path.is_file():
        load_dotenv(_env_path, override=False)

_DIST = _ROOT / "webgl" / "dist"
if not _DIST.is_dir():
    _DIST = _ROOT / "dist"

app = FastAPI(title="BlushedCV Virtual Makeup API")

MAX_IMAGE_BYTES = 2_500_000

SYSTEM_PROMPT = """You are a friendly digital beauty guide inside a virtual makeup try-on app.
You will receive ONE casual webcam-style photo where a face is usually visible.
Return ONLY valid JSON (no markdown fences) with exactly these keys:
- headline: string, max ~70 chars, warm and clear, no emoji
- vibe_tags: array of 3 to 6 short strings (micro-trend tags like "coquette blush" / "clean girl")
- undertone_read: string, 2-3 sentences, soft language ("reads warm-neutral…"), beauty read only — not clinical
- lip_colors: array of 2-4 strings (color directions + finishes, e.g. "dusty rose satin") — favor pink, rose, mauve, soft berry, MLBB rose; avoid peachy/coral/orange-forward lip reads unless the style brief says otherwise
- eye_colors: array of 2-4 strings (shadow/liner directions)
- blush_colors: array of 2-3 strings — favor pink, rose, cool pink, soft raspberry; avoid yellow-orange, terracotta-forward, or heavy coral unless the style brief says otherwise
- liner_brow: string, one friendly sentence for liner + brow harmony
- tips: array of 2-4 short actionable tips (blend edges, balance warmth, etc.)
- confidence_note: string, one sentence: lighting/angle limits the read
- disclaimer: string, always exactly "" (empty — do not add legal, medical, or disclaimer sentences)
- look_hex: object with EXACTLY these keys, each a CSS hex string "#RRGGBB" (6 hex digits, uppercase preferred):
  - lip: main lipstick color that matches lip_colors (prefer pink-rose-mauve-red family in hex; not orange-yellow dominant)
  - eye_shadow: primary eyeshadow for lids/crease that matches eye_colors
  - liner: eyeliner (often deep brown or black)
  - brow: brow fill that harmonizes with hair/photo
  - blush: cheek color that matches blush_colors (prefer pink-red-rose hex; not hot yellow-orange dominant)
The five look_hex colors must be realistic makeup pigments (not neon unless the look calls for it) and must visually harmonize with the text color suggestions.
Tone: friendly, kind, body-positive, inclusive. No insults, no harsh judgments, no certainty about "what you are".
Do not mention model names or policies. English only.
The user message begins with a STYLE BRIEF the user chose (natural / glam / fun). Follow that brief for every field, including vibe_tags and look_hex."""

_ALLOWED_LOOK_VIBES = frozenset({"natural", "glam", "fun"})

_LOOK_VIBE_INSTRUCTIONS: dict[str, str] = {
    "natural": (
        "STYLE BRIEF — NATURAL / EVERYDAY: Cute, flattering, believable soft glam for real life — \"no-makeup makeup\" "
        "or polished everyday. Lips and blush must lean PINK / ROSE / MAUVE / soft BERRY / MLBB rose — sweet, fresh, "
        "romantic. Do NOT steer lips or blush toward yellow, orange, peach-coral, terracotta, or brown-orange; those "
        "read dated or sallow on many faces here. Eyeshadow and liner stay soft and harmonious. look_hex.lip and "
        "look_hex.blush must be clearly pink-red family (enough blue/magenta vs pure orange). Cohesive in daylight, "
        "not heavy stage makeup."
    ),
    "glam": (
        "STYLE BRIEF — GLAM (BOLD): Evening-ready or special-occasion — richer pigment, smokier or deeper eyes, "
        "bolder lip, sharper liner, defined brows — still flattering, not costume. Lips and blush stay in the CUTE "
        "PINK–RED–ROSE–BERRY–MAUVE lane (bold is fine: deeper rose, wine-stain, fuchsia-rose blush). Avoid "
        "orange-red, brick-orange, heavy coral, or yellow-peach blush/lip stories; no \"warm pumpkin\" cheeks. "
        "look_hex.lip and look_hex.blush should read clearly pink or red-rose, not orange-dominant."
    ),
    "fun": (
        "STYLE BRIEF — FUN / PLAYFUL: Creative, expressive, trend-forward — colored liner, vivid blush, playful shadow. "
        "When describing cheeks and lips, still default toward pink-red-rose playful tones rather than orange-peach "
        "unless you deliberately pick one contrasting accent. Keep it joyful and tasteful. look_hex stays one "
        "coordinated look."
    ),
}

_LOOK_HEX_KEYS = ("lip", "eye_shadow", "liner", "brow", "blush")


def _normalize_hex_color(value: str) -> str:
    t = value.strip()
    if not t.startswith("#"):
        t = "#" + t
    h = t[1:]
    if len(h) == 3 and all(c in "0123456789abcdefABCDEF" for c in h):
        h = "".join(c * 2 for c in h)
    if len(h) != 6 or any(c not in "0123456789abcdefABCDEF" for c in h):
        raise ValueError(f"invalid hex: {value!r}")
    return "#" + h.upper()


def _validate_look_hex(data: dict[str, Any]) -> None:
    lh = data.get("look_hex")
    if not isinstance(lh, dict):
        raise HTTPException(status_code=502, detail="Model JSON missing or invalid look_hex (expected object).")
    out: dict[str, str] = {}
    for k in _LOOK_HEX_KEYS:
        v = lh.get(k)
        if not isinstance(v, str):
            raise HTTPException(status_code=502, detail=f"look_hex.{k} must be a string #RRGGBB.")
        try:
            out[k] = _normalize_hex_color(v)
        except ValueError as e:
            raise HTTPException(status_code=502, detail=f"look_hex.{k}: {e!s}") from e
    data["look_hex"] = out


def _strip_json_fence(text: str) -> str:
    t = text.strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z0-9]*\s*", "", t)
        t = re.sub(r"\s*```$", "", t.strip())
    return t.strip()


def _parse_analysis_json(raw: str) -> dict[str, Any]:
    try:
        return json.loads(_strip_json_fence(raw))
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=502, detail=f"Model returned invalid JSON: {e}") from e


# ── Landing page at / ──
@app.get("/")
async def landing():
    return FileResponse(str(_ROOT / "index.html"))

# ── app.html at /app ──
@app.get("/app")
async def makeup_app():
    return FileResponse(str(_ROOT / "app.html"))


@app.post("/api/analyze-makeup-colors")
async def analyze_makeup_colors(
    image: UploadFile = File(...),
    look_vibe: str = Form("natural"),
) -> dict[str, Any]:
    api_key = (os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or "").strip()
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail=(
                "GEMINI_API_KEY is not set. "
                "Hugging Face: add a Space secret named GEMINI_API_KEY."
            ),
        )

    body = await image.read()
    if not body:
        raise HTTPException(status_code=400, detail="Empty image upload.")
    if len(body) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image too large (max ~2.5 MB).")

    vibe_key = look_vibe.strip().lower()
    if vibe_key not in _ALLOWED_LOOK_VIBES:
        raise HTTPException(status_code=400, detail="look_vibe must be one of: natural, glam, fun.")

    try:
        import google.generativeai as genai
        from PIL import Image
    except ImportError as e:
        raise HTTPException(status_code=500, detail="Server missing Gemini deps.") from e

    genai.configure(api_key=api_key)
    model_name = os.environ.get("GEMINI_VISION_MODEL", "gemini-2.5-flash-lite").strip() or "gemini-2.5-flash-lite"

    try:
        pil = Image.open(io.BytesIO(body))
        if pil.mode != "RGB":
            pil = pil.convert("RGB")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not read image: {e!s}") from e

    model = genai.GenerativeModel(model_name=model_name, system_instruction=SYSTEM_PROMPT)

    style_block = _LOOK_VIBE_INSTRUCTIONS[vibe_key]
    user_text = (
        f"{style_block}\n\n"
        "Look at this face snapshot. Suggest flattering makeup COLOR directions "
        "(not exact products). Reply with JSON only, following the schema from your instructions. "
        "look_hex must match the lip, eye, blush, liner, and brow directions you describe."
    )

    def _quota_retry_delay(exc: BaseException) -> float:
        m = re.search(r"retry in ([\d.]+)s", str(exc), re.I)
        if m:
            return min(35.0, float(m.group(1)) + 0.5)
        return 7.0

    def _is_quota_error(exc: BaseException) -> bool:
        s = str(exc).lower()
        return "429" in str(exc) or "quota" in s or "resource exhausted" in s or "rate limit" in s

    response = None
    last_exc: BaseException | None = None
    for attempt in range(2):
        try:
            response = model.generate_content(
                [user_text, pil],
                generation_config=genai.GenerationConfig(
                    response_mime_type="application/json",
                    max_output_tokens=1024,
                    temperature=0.75,
                ),
            )
            break
        except Exception as e:
            last_exc = e
            if attempt == 0 and _is_quota_error(e):
                await asyncio.sleep(_quota_retry_delay(e))
                continue
            raise HTTPException(status_code=502, detail=f"Upstream Gemini error: {e!s}") from e

    if response is None:
        raise HTTPException(
            status_code=502,
            detail=f"Upstream Gemini error after retry: {last_exc!s}" if last_exc else "Empty Gemini response.",
        )

    try:
        raw = response.text
    except ValueError as e:
        raise HTTPException(status_code=502, detail="Gemini returned no text (blocked or empty).") from e

    if not raw or not raw.strip():
        raise HTTPException(status_code=502, detail="Empty response from Gemini.")

    data = _parse_analysis_json(raw)
    required = ["headline", "vibe_tags", "undertone_read", "lip_colors", "eye_colors",
                "blush_colors", "liner_brow", "tips", "confidence_note", "disclaimer", "look_hex"]
    missing = [k for k in required if k not in data]
    if missing:
        raise HTTPException(status_code=502, detail=f"Model JSON missing keys: {', '.join(missing)}")
    _validate_look_hex(data)
    data["disclaimer"] = ""
    return {"ok": True, "analysis": data}


# Static assets (favicon, icons, style.css, assets/) served from root
app.mount("/assets", StaticFiles(directory=str(_ROOT / "assets")), name="assets")

# WebGL app static files served at /app/ path
app.mount("/app", StaticFiles(directory=str(_DIST), html=True), name="webgl")
