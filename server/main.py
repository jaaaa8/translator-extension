from contextlib import asynccontextmanager
import asyncio
import json
import time

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from . import config
from .translator import TranslateError, _normalize_items

LANGS = ["ja", "es"]

_pipeline = None


def get_pipeline():
    global _pipeline
    if _pipeline is None:
        from .pipeline import Pipeline

        _pipeline = Pipeline(device=config.DEVICE)
    return _pipeline


@asynccontextmanager
async def lifespan(app):
    get_pipeline()  # load model một lần lúc khởi động (spec); TestClient không chạy lifespan nên test vẫn nhẹ
    yield


app = FastAPI(lifespan=lifespan)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "device": config.DEVICE,
        "langs": LANGS,
        "versions": config.PIPELINE_VERSIONS,
    }


def _validated_crop(left, top, right, bottom):
    values = (left, top, right, bottom)
    if any(value is not None for value in values) and not all(value is not None for value in values):
        return JSONResponse(
            status_code=422,
            content={"error": "crop requires left, top, right, bottom"},
        )
    return None if left is None else values


def _ndjson(event):
    return json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n"


# sync def → FastAPI chạy trong threadpool, không chặn /health khi đang xử lý ảnh
@app.post("/ocr")
def ocr(
    image: UploadFile = File(...),
    src_lang: str = Form(...),
    crop_left: float | None = Form(None),
    crop_top: float | None = Form(None),
    crop_right: float | None = Form(None),
    crop_bottom: float | None = Form(None),
):
    if src_lang not in LANGS:
        return JSONResponse(status_code=422, content={"error": f"src_lang không hỗ trợ: {src_lang}"})
    crop_or_error = _validated_crop(crop_left, crop_top, crop_right, crop_bottom)
    if isinstance(crop_or_error, JSONResponse):
        return crop_or_error
    try:
        return get_pipeline().ocr_image(image.file.read(), src_lang, crop=crop_or_error)
    except ValueError as e:
        return JSONResponse(status_code=422, content={"error": str(e)})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/ocr-stream")
async def ocr_stream(
    request: Request,
    analysis_key: str = Form(...),
    ocr_key: str = Form(...),
    src_lang: str = Form(...),
    image: UploadFile | None = File(None),
    crop_left: float | None = Form(None),
    crop_top: float | None = Form(None),
    crop_right: float | None = Form(None),
    crop_bottom: float | None = Form(None),
):
    if src_lang not in LANGS:
        return JSONResponse(status_code=422, content={"error": f"src_lang không hỗ trợ: {src_lang}"})
    crop_or_error = _validated_crop(crop_left, crop_top, crop_right, crop_bottom)
    if isinstance(crop_or_error, JSONResponse):
        return crop_or_error
    pipeline = get_pipeline()
    data = await image.read() if image is not None else None
    cached_analysis = pipeline.get_analysis(analysis_key)
    if data is None and cached_analysis is None:
        return JSONResponse(status_code=409, content={"error": "analysis_missing"})

    async def stream():
        analysis_started = time.perf_counter()
        try:
            analysis = cached_analysis
            if analysis is None:
                analysis, analysis_cache_hit = await asyncio.to_thread(
                    pipeline.analyze_with_status, data, crop_or_error, analysis_key
                )
            else:
                analysis_cache_hit = True
            analysis_ms = max(0, round((time.perf_counter() - analysis_started) * 1000))
            yield _ndjson({
                "type": "analysis_ready",
                "analysis_key": analysis_key,
                "image_w": analysis.image_w,
                "image_h": analysis.image_h,
                "regions": len(analysis.regions),
                "analysis_ms": analysis_ms,
                "analysis_cache_hit": analysis_cache_hit,
            })
            iterator = pipeline._iter_ocr(analysis, analysis_key, src_lang, ocr_key, lambda: False)
            while not await request.is_disconnected():
                event = await asyncio.to_thread(next, iterator, None)
                if event is None:
                    break
                yield _ndjson(event)
        except ValueError as error:
            yield _ndjson({"type": "job_error", "stage": "decode", "code": str(error)})

    return StreamingResponse(stream(), media_type="application/x-ndjson")


class TranslateTextsBody(BaseModel):
    texts: list[str]
    src_lang: str
    target_lang: str = "vi"


@app.post("/translate-texts")
def translate_texts(body: TranslateTextsBody):
    try:
        translations = get_pipeline().translator.translate(body.texts, body.src_lang, body.target_lang)
        return {"translations": translations}
    except TranslateError as e:
        return JSONResponse(status_code=502, content={"error": f"gemini: {e}"})


class TranslateItem(BaseModel):
    id: str
    text: str


class TranslateItemsBody(BaseModel):
    items: list[TranslateItem]
    src_lang: str
    dst_lang: str = "vi"


@app.post("/translate-items")
def translate_items(body: TranslateItemsBody):
    if body.src_lang not in LANGS:
        return JSONResponse(
            status_code=422,
            content={"error": f"src_lang không hỗ trợ: {body.src_lang}"},
        )
    rows = [item.model_dump() for item in body.items]
    if len({row["id"] for row in rows}) != len(rows):
        return JSONResponse(status_code=422, content={"error": "duplicate input id"})
    try:
        translated = get_pipeline().translator.translate_items(
            rows, body.src_lang, body.dst_lang
        )
        return {"items": _normalize_items(translated, [row["id"] for row in rows])}
    except TranslateError as error:
        return JSONResponse(
            status_code=429 if error.code == 429 else 502,
            content={"error": f"gemini: {error}", "error_code": error.error_kind or "generation_error"},
        )
    except ValueError as error:
        return JSONResponse(
            status_code=502,
            content={"error": f"gemini: {error}", "error_code": "invalid_response"},
        )


@app.post("/translate")
def translate(
    image: UploadFile = File(...),
    src_lang: str = Form(...),
    target_lang: str = Form("vi"),
):
    if src_lang not in LANGS:
        return JSONResponse(status_code=422, content={"error": f"src_lang không hỗ trợ: {src_lang}"})
    data = image.file.read()
    try:
        return get_pipeline().process(data, src_lang, target_lang)
    except TranslateError as e:
        return JSONResponse(status_code=502, content={"error": f"gemini: {e}"})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})
