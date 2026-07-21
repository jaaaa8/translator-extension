from fastapi import FastAPI

from . import config

LANGS = ["ja", "es"]

app = FastAPI()


@app.get("/health")
def health():
    return {"status": "ok", "device": config.DEVICE, "langs": LANGS}
