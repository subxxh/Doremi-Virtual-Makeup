---
title: Doremi Virtual Makeup
emoji: 💄
colorFrom: pink
colorTo: purple
sdk: docker
app_port: 7860
---

Static WebGL makeup app + optional **Gemini** color-read API (`app.py`).

**Hugging Face:** create a Space from this repo, set **sdk: docker** (this README), add a secret **`GEMINI_API_KEY`**, and rebuild. The Dockerfile runs `npm run build` in `webgl/` then `uvicorn` on port **7860**.

**Local:** `pip install -r requirements.txt`, put `GEMINI_API_KEY` in `.env`, `uvicorn app:app --reload --port 8000` from repo root, and `npm run dev` in `webgl/` (Vite proxies `/api` to 8000).
