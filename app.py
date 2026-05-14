"""
BlushedCV — serves landing page at /, WebGL makeup app at /app,
and AI color analysis at /api/analyze-makeup-colors.

Hugging Face: add a Space secret named GEMINI_API_KEY.
Get a free key at: https://aistudio.google.com/apikey
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
- lip_colors: array of 2-4 strings (color directions + finishes, e.g. "dusty rose satin")
- eye_colors: array of 2-4 strings (shadow/liner directions)
- blush_colors: array of 2-3 strings
- liner_brow: string, one friendly sentence for liner + brow harmony
- tips: array of 2-4 short actionable tips
- confidence_note: string, one sentence about lighting/angle limits
- disclaimer: string, always exactly ""
- look_hex: object with EXACTLY these keys, each a CSS hex string "#RRGGBB":
  - lip, eye_shadow, liner, brow, blush
Tone: friendly, kind, body-positive, inclusive. English only."""

_ALLOWED_LOOK_VIBES = frozenset({"natural", "glam", "fun"})

_LOOK_VIBE_INSTRUCTIONS: dict[str, str] = {
    "natural": (
        "STYLE BRIEF — NATURAL / EVERYDAY: soft glam, pink/rose/mauve lips and blush, "
        "no orange/coral/terracotta. look_hex.lip and look_hex.blush must be pink-red family."
    ),
    "glam": (
        "STYLE BRIEF — GLAM (BOLD): evening-ready, deeper pigment, smoky eyes, bold lip. "
        "Stay in pink-red-rose-berry-mauve lane. look_hex.lip and look_hex.blush clearly pink or red-rose."
    ),
    "fun": (
        "STYLE BRIEF — FUN / PLAYFUL: creative, trend-forward, colored liner, vivid blush. "
        "Default toward pink-red-rose tones. look_hex stays one coordinated look."
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
        raise HTTPException(status_code=502, detail="Model JSON missing look_hex.")
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


# ── Landing page ──
@app.get("/")
async def landing():
    return FileResponse(str(_ROOT / "index.html"))


# ── WebGL app — handles /app and any sub-paths for SPA routing ──
@app.get("/app")
@app.get("/app/{full_path:path}")
async def makeup_app(full_path: str = ""):
    if full_path:
        candidate = _DIST / full_path
        if candidate.is_file():
            return FileResponse(str(candidate))
    return FileResponse(str(_DIST / "index.html"))


# ── AI makeup color analysis ──
@app.post("/api/analyze-makeup-colors")
async def analyze_makeup_colors(
    image: UploadFile = File(...),
    look_vibe: str = Form("natural"),
) -> dict[str, Any]:
    api_key = (os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or "").strip()
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="GEMINI_API_KEY is not set. Add it as a Space secret in HF Settings.",
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
        "(not exact products). Reply with JSON only. look_hex must match your color suggestions."
    )

    def _quota_retry_delay(exc: BaseException) -> float:
        m = re.search(r"retry in ([\d.]+)s", str(exc), re.I)
        return min(35.0, float(m.group(1)) + 0.5) if m else 7.0

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


# ── Serve all other static files (favicon, icons, css, /assets/) ──
app.mount("/", StaticFiles(directory=str(_ROOT), html=False), name="root-static")
