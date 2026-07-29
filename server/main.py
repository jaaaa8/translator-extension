from contextlib import asynccontextmanager

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import config
from .translator import TranslateError

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
    return {"status": "ok", "device": config.DEVICE, "langs": LANGS}


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
    values = (crop_left, crop_top, crop_right, crop_bottom)
    if any(value is not None for value in values) and not all(value is not None for value in values):
        return JSONResponse(status_code=422, content={"error": "crop requires left, top, right, bottom"})
    crop = None if crop_left is None else values
    try:
        return get_pipeline().ocr_image(image.file.read(), src_lang, crop=crop)
    except ValueError as e:
        return JSONResponse(status_code=422, content={"error": str(e)})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


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
