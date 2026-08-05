import os

from dotenv import load_dotenv

load_dotenv()

LANGS = ("ja", "es", "pt")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_API_KEY_SECONDARY = os.getenv("GEMINI_API_KEY_SECONDARY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-flash-latest")
PIPELINE_VERSIONS = {
    "detector": "comic-text-detector-v1",
    "dedupe": "iou-0.5-area-clamp-exact-v3",
    "prep": "upscale48-border8-v1",
    "recognizers": {
        "ja": "manga-ocr-v1",
        "es": "paddleocr-latin-ppocrv6-v1",
        "pt": "paddleocr-latin-ppocrv6-v1",
    },
    "translator_model": GEMINI_MODEL,
    "prompt": "comic-page-items-v2",
    "policy": "full-page-v1",
    "layout_order": "reading-order-v1",
    "page_schema": "page-v1",
}
PORT = int(os.getenv("PORT", "8910"))
DEVICE = os.getenv("DEVICE", "cuda")
