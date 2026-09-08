"""
sd-wrapper — vertaalt de OpenAI `/v1/images/generations` vorm naar de
AUTOMATIC1111 (stable-diffusion-webui) `/sdapi/v1/txt2img` API.

Waarom dit bestaat: de backend van Visiyon praat alleen de OpenAI-vorm
tegen elke image-provider (zie backend/src/lib/images.ts). A1111 heeft
zijn eigen API-vorm. Dit kleine, dependency-lichte servicetje zit
ertussenin zodat de backend niets hoeft te weten over A1111 specifiek —
dezelfde aanpak als bij elke andere OpenAI-compatible provider.

Env vars:
  A1111_URL      basis-URL van de stable-diffusion-webui container
                 (default: http://sd-webui:17860 — the ai-dock image
                 overrides --port with its own default of 17860
                 regardless of what WEBUI_ARGS passes)
  SD_MODEL       optioneel: checkpoint dat geforceerd wordt vóór genereren
  WRAPPER_API_KEY  optioneel: als gezet, moet Authorization: Bearer <key>
                 matchen anders 401 (zelfde als elke andere provider-key)
"""

import base64
import os
import time

import httpx
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

A1111_URL = os.environ.get("A1111_URL", "http://sd-webui:17860").rstrip("/")
SD_MODEL = os.environ.get("SD_MODEL", "").strip()
WRAPPER_API_KEY = os.environ.get("WRAPPER_API_KEY", "").strip()

app = FastAPI(title="sd-wrapper")


class ImageGenRequest(BaseModel):
    prompt: str
    n: int = 1
    size: str = "1024x1024"
    response_format: str = "b64_json"
    negative_prompt: str | None = None
    steps: int | None = None


def _check_auth(request: Request) -> None:
    if not WRAPPER_API_KEY:
        return
    auth = request.headers.get("authorization", "")
    if auth != f"Bearer {WRAPPER_API_KEY}":
        raise HTTPException(status_code=401, detail="Invalid API key")


@app.get("/health")
async def health():
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get(f"{A1111_URL}/sdapi/v1/options")
            r.raise_for_status()
        return {"status": "ok", "a1111": "reachable"}
    except Exception as exc:  # noqa: BLE001
        return {"status": "degraded", "a1111": "unreachable", "error": str(exc)}


@app.post("/v1/images/generations")
async def generate(req: ImageGenRequest, request: Request):
    _check_auth(request)

    try:
        width, height = (int(x) for x in req.size.lower().split("x"))
    except Exception:
        width, height = 1024, 1024
    # P100 has 16GB VRAM but no tensor cores worth writing home about —
    # cap dimensions so a typo like "2048x2048" doesn't OOM the card.
    width = min(max(width, 256), 1536)
    height = min(max(height, 256), 1536)

    payload = {
        "prompt": req.prompt,
        "negative_prompt": req.negative_prompt or "",
        "steps": req.steps or 20,
        "width": width,
        "height": height,
        "batch_size": min(max(req.n, 1), 4),
        "sampler_name": "DPM++ 2M Karras",
    }
    if SD_MODEL:
        payload["override_settings"] = {"sd_model_checkpoint": SD_MODEL}

    async with httpx.AsyncClient(timeout=300) as client:
        try:
            resp = await client.post(f"{A1111_URL}/sdapi/v1/txt2img", json=payload)
            resp.raise_for_status()
        except httpx.ConnectError as exc:
            raise HTTPException(
                status_code=502,
                detail=f"Could not reach stable-diffusion-webui at {A1111_URL}: {exc}",
            ) from exc
        except httpx.HTTPStatusError as exc:
            raise HTTPException(
                status_code=502,
                detail=f"stable-diffusion-webui returned {exc.response.status_code}: {exc.response.text[:300]}",
            ) from exc

    data = resp.json()
    images = data.get("images") or []
    if not images:
        raise HTTPException(status_code=502, detail="stable-diffusion-webui returned no images")

    if req.response_format == "url":
        # No object storage in this wrapper — always hand back b64_json,
        # the backend already accepts either field.
        pass

    return {
        "created": int(time.time()),
        "data": [{"b64_json": img} for img in images],
    }
