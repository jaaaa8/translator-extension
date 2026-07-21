from contextlib import asynccontextmanager

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse

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
