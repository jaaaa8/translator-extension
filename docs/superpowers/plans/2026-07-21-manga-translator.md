# MangaTranslator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extension Chrome MV3 + FastAPI local server dịch trang truyện tranh (Nhật/Tây Ban Nha → Việt/Anh) và overlay chữ dịch đè lên bóng thoại ngay trên trang web.

**Architecture:** Hai tiến trình độc lập giao tiếp REST qua `http://127.0.0.1:8910`. Server: comic-text-detector (detection) → OCR registry (`ja`=manga-ocr, `es`=PaddleOCR) → Gemini (dịch gom cả trang 1 request), trả JSON `blocks[{bbox, src_text, trans_text}]`. Extension: content script phát hiện ảnh + IntersectionObserver, background fetch ảnh + gọi server + cache, overlay là div absolute theo tọa độ tài liệu.

**Tech Stack:** Python 3.11+, FastAPI/uvicorn, PyTorch CUDA, manga-ocr, PaddleOCR, google-genai (Gemini), OpenCV, Pillow; Chrome Extension Manifest V3 (vanilla JS, không build tool).

**Spec:** `docs/superpowers/specs/2026-07-21-manga-translator-design.md`

## Global Constraints

- Windows 11, shell mặc định PowerShell; GPU RTX 3050 4GB (CUDA), mọi model phải fallback CPU được.
- Server port cố định **8910**, chỉ bind `127.0.0.1`.
- Ngôn ngữ nguồn v1: `ja`, `es`. Ngôn ngữ đích v1: `vi`, `en`. Server KHÔNG hard-code danh sách đích.
- Sản phẩm cá nhân: extension load unpacked, server chạy bằng `run_server.bat`. KHÔNG đóng gói installer.
- Ngoài scope v1 (không viết): inpainting, auto-detect ngôn ngữ, WebSocket, Firefox, engine dịch thứ hai.
- API key đọc từ `.env` (`GEMINI_API_KEY`), không bao giờ commit `.env`.
- Endpoint `/translate` là sync `def` (chạy trong threadpool) để không chặn `/health` khi đang xử lý ảnh.
- Extension: tối đa 2 request dịch đồng thời; cache key = `url|srcLang|dstLang`; timeout 60s/ảnh; retry 1 lần sau 3s.

---

### Task 1: Khung server + `/health` + môi trường

**Files:**
- Create: `server/__init__.py`, `server/config.py`, `server/main.py`
- Create: `server/tests/__init__.py`, `server/tests/test_health.py`
- Create: `requirements.txt`, `.env.example`, `.gitignore`, `run_server.bat`

**Interfaces:**
- Produces: `server.config` với các hằng `GEMINI_API_KEY: str`, `GEMINI_MODEL: str` (mặc định `"gemini-2.5-flash"`), `PORT: int` (8910), `DEVICE: str` (`"cuda"`); FastAPI app `server.main:app` với `GET /health` và hằng `LANGS = ["ja", "es"]`. Task 5 sẽ thêm `/translate` vào chính `main.py` này.

- [ ] **Step 1: Tạo venv và cài dependency**

```powershell
cd D:\MangaTranslator
python -m venv venv
venv\Scripts\Activate.ps1
pip install torch --index-url https://download.pytorch.org/whl/cu121
```

Cài torch CUDA **trước** để `manga-ocr` (cài ở bước sau) không kéo bản torch CPU đè lên. Xác nhận: `python -c "import torch; print(torch.cuda.is_available())"` in `True` (nếu `False` vẫn tiếp tục được — mọi thứ chạy CPU).

- [ ] **Step 2: Viết `requirements.txt` và cài**

```
fastapi
uvicorn[standard]
python-multipart
python-dotenv
numpy
opencv-python
pillow
manga-ocr
paddleocr
paddlepaddle
google-genai
pytest
httpx
```

```powershell
pip install -r requirements.txt
```

Lưu ý: `paddlepaddle` là wheel CPU — chủ đích, OCR tiếng Tây Ban Nha chạy trên crop nhỏ nên CPU đủ nhanh, tránh địa ngục cài `paddlepaddle-gpu` trên Windows.

- [ ] **Step 3: Viết `.gitignore`, `.env.example`, `run_server.bat`**

`.gitignore`:
```
venv/
__pycache__/
.env
server/models/
server/vendor/
*.pt
*.onnx
```

`.env.example`:
```
GEMINI_API_KEY=your-key-here
GEMINI_MODEL=gemini-2.5-flash
PORT=8910
DEVICE=cuda
```

`run_server.bat`:
```bat
@echo off
cd /d %~dp0
call venv\Scripts\activate
python -m uvicorn server.main:app --host 127.0.0.1 --port 8910
```

- [ ] **Step 4: Viết test fail cho `/health`**

`server/tests/test_health.py`:
```python
from fastapi.testclient import TestClient

from server.main import app


def test_health():
    client = TestClient(app)
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["langs"] == ["ja", "es"]
    assert "device" in body
```

- [ ] **Step 5: Chạy test, xác nhận FAIL**

```powershell
python -m pytest server/tests/test_health.py -v
```
Expected: FAIL — `ModuleNotFoundError: No module named 'server.main'` (hoặc tương đương).

- [ ] **Step 6: Viết `server/config.py` và `server/main.py`**

`server/__init__.py` và `server/tests/__init__.py`: file rỗng.

`server/config.py`:
```python
import os

from dotenv import load_dotenv

load_dotenv()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
PORT = int(os.getenv("PORT", "8910"))
DEVICE = os.getenv("DEVICE", "cuda")
```

`server/main.py`:
```python
from fastapi import FastAPI

from . import config

LANGS = ["ja", "es"]

app = FastAPI()


@app.get("/health")
def health():
    return {"status": "ok", "device": config.DEVICE, "langs": LANGS}
```

- [ ] **Step 7: Chạy test, xác nhận PASS**

```powershell
python -m pytest server/tests/test_health.py -v
```
Expected: `1 passed`.

- [ ] **Step 8: Commit**

```powershell
git add server/ requirements.txt .env.example .gitignore run_server.bat
git commit -m "feat: server skeleton with /health endpoint"
```

---

### Task 2: Fixture ảnh + vendor comic-text-detector + `detector.py`

**Files:**
- Create: `server/tests/make_fixtures.py`, `server/tests/fixtures/ja_page.png`, `server/tests/fixtures/es_page.png` (sinh bằng script)
- Create: `server/vendor/comic_text_detector/` (git clone, không commit), `server/models/comictextdetector.pt` (tải về, không commit)
- Create: `server/detector.py`, `server/tests/test_detector.py`

**Interfaces:**
- Produces: `server.detector.TextRegion` — dataclass `bbox: tuple[int, int, int, int]` (x, y, w, h theo pixel ảnh gốc), `vertical: bool`; `server.detector.Detector(device: str)` với method `detect(image_bgr: np.ndarray) -> list[TextRegion]`. Task 6 (pipeline) tiêu thụ interface này.

- [ ] **Step 1: Viết script sinh fixture**

`server/tests/make_fixtures.py`:
```python
"""Sinh 2 trang truyện tổng hợp: bóng thoại trắng trên nền xám, chữ đủ to để detect/OCR."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).parent / "fixtures"


def make_page(path, text, font_path, vertical=False):
    img = Image.new("RGB", (800, 1200), "#c9c9c9")
    d = ImageDraw.Draw(img)
    d.ellipse([100, 100, 520, 420], fill="white", outline="black", width=4)
    font = ImageFont.truetype(font_path, 42)
    if vertical:
        x, y = 290, 140
        for ch in text:
            d.text((x, y), ch, font=font, fill="black")
            y += 46
    else:
        d.text((150, 230), text, font=font, fill="black")
    img.save(path)


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    make_page(OUT / "ja_page.png", "こんにちは世界", "C:/Windows/Fonts/msgothic.ttc", vertical=True)
    make_page(OUT / "es_page.png", "Hola amigo", "C:/Windows/Fonts/arialbd.ttf")
    print("fixtures written to", OUT)
```

Chạy: `python server/tests/make_fixtures.py` — xác nhận 2 file PNG xuất hiện. Commit cả script lẫn 2 PNG (fixture ổn định, không sinh lại trong CI).

- [ ] **Step 2: Vendor detector + tải weights**

```powershell
git clone --depth 1 https://github.com/dmMaze/comic_text_detector server/vendor/comic_text_detector
mkdir server/models -Force
```

Tải weights `comictextdetector.pt` về `server/models/comictextdetector.pt` theo link trong README của repo vừa clone (mục model download — có mirror Google Drive/HuggingFace; file này cũng được host trong release assets của `zyddnys/manga-image-translator`). Xác nhận file tồn tại và > 10MB.

- [ ] **Step 3: Viết test fail cho detector**

`server/tests/test_detector.py`:
```python
from pathlib import Path

import cv2
import pytest

from server.detector import Detector

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(scope="module")
def detector():
    return Detector(device="cuda")


def test_detects_text_region_ja(detector):
    img = cv2.imread(str(FIXTURES / "ja_page.png"))
    regions = detector.detect(img)
    assert len(regions) >= 1
    x, y, w, h = regions[0].bbox
    assert w > 0 and h > 0
    # vùng chữ phải nằm trong khu bóng thoại đã vẽ (100..520, 100..420)
    assert 50 < x < 550 and 50 < y < 500


def test_detects_text_region_es(detector):
    img = cv2.imread(str(FIXTURES / "es_page.png"))
    regions = detector.detect(img)
    assert len(regions) >= 1
```

- [ ] **Step 4: Chạy test, xác nhận FAIL**

```powershell
python -m pytest server/tests/test_detector.py -v
```
Expected: FAIL — `ModuleNotFoundError: No module named 'server.detector'`.

- [ ] **Step 5: Viết `server/detector.py`**

```python
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np

VENDOR = Path(__file__).parent / "vendor" / "comic_text_detector"
MODEL = Path(__file__).parent / "models" / "comictextdetector.pt"


@dataclass
class TextRegion:
    bbox: tuple[int, int, int, int]  # x, y, w, h theo pixel ảnh gốc
    vertical: bool


class Detector:
    def __init__(self, device: str = "cuda"):
        # ponytail: vendor dùng absolute import nội bộ nên phải chèn sys.path;
        # nếu sau này vendor lên PyPI thì thay bằng import thường
        sys.path.insert(0, str(VENDOR))
        from inference import TextDetector

        self._model = TextDetector(model_path=str(MODEL), device=device)

    def detect(self, image_bgr: np.ndarray) -> list[TextRegion]:
        _, _, blk_list = self._model(image_bgr)
        regions = []
        for blk in blk_list:
            x1, y1, x2, y2 = (int(v) for v in blk.xyxy)
            regions.append(TextRegion(bbox=(x1, y1, x2 - x1, y2 - y1), vertical=bool(blk.vertical)))
        return regions
```

Lưu ý cho người triển khai: API nội bộ của vendor có thể lệch nhẹ theo commit (tên module `inference`, chữ ký `TextDetector`, attr `xyxy`/`vertical` của TextBlock). Mở `server/vendor/comic_text_detector/inference.py` đối chiếu và chỉnh **phần gọi vendor** cho khớp — interface `TextRegion`/`Detector.detect` của ta thì giữ nguyên vì Task 6 phụ thuộc vào nó. Nếu CUDA lỗi khi khởi tạo, bắt exception và thử lại với `device="cpu"`, in cảnh báo.

- [ ] **Step 6: Chạy test, xác nhận PASS**

```powershell
python -m pytest server/tests/test_detector.py -v
```
Expected: `2 passed` (chạy lần đầu chậm do load model). Nếu detector không tìm thấy vùng chữ trên fixture tổng hợp (model train trên truyện thật), tăng cỡ chữ trong `make_fixtures.py` lên 56 và chạy lại; nếu vẫn fail, chụp/tải một trang manga thật làm `ja_page.png` thay thế rồi ghi chú nguồn trong commit message.

- [ ] **Step 7: Commit**

```powershell
git add server/detector.py server/tests/test_detector.py server/tests/make_fixtures.py server/tests/fixtures/
git commit -m "feat: text detection via vendored comic-text-detector"
```

---

### Task 3: OCR registry (`ja` = manga-ocr, `es` = PaddleOCR)

**Files:**
- Create: `server/ocr.py`, `server/tests/test_ocr.py`

**Interfaces:**
- Consumes: fixture PNG từ Task 2.
- Produces: `server.ocr.OcrRegistry(device: str)` với `langs -> list[str]` (`["ja", "es"]`) và `get(lang: str) -> engine`; mỗi engine có `read(crop_rgb: np.ndarray) -> str`. Thêm ngôn ngữ mới = thêm 1 entry vào dict `ENGINES`. Task 6 tiêu thụ interface này.

- [ ] **Step 1: Viết test fail**

`server/tests/test_ocr.py`:
```python
from pathlib import Path

import cv2
import pytest

from server.ocr import OcrRegistry

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(scope="module")
def registry():
    return OcrRegistry(device="cuda")


def crop_bubble(name):
    img = cv2.imread(str(FIXTURES / name))
    crop = img[100:420, 100:520]  # vùng bóng thoại của fixture
    return cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)


def test_registry_langs(registry):
    assert registry.langs == ["ja", "es"]


def test_manga_ocr_reads_japanese(registry):
    text = registry.get("ja").read(crop_bubble("ja_page.png"))
    assert "こんにちは" in text.replace(" ", "")


def test_paddle_reads_spanish(registry):
    text = registry.get("es").read(crop_bubble("es_page.png"))
    assert "hola" in text.lower()
```

- [ ] **Step 2: Chạy test, xác nhận FAIL**

```powershell
python -m pytest server/tests/test_ocr.py -v
```
Expected: FAIL — `ModuleNotFoundError: No module named 'server.ocr'`.

- [ ] **Step 3: Viết `server/ocr.py`**

```python
import numpy as np
from PIL import Image


class MangaOcrEngine:
    def __init__(self, device: str = "cuda"):
        from manga_ocr import MangaOcr

        self._mocr = MangaOcr()  # tự dùng GPU nếu torch thấy CUDA

    def read(self, crop_rgb: np.ndarray) -> str:
        return self._mocr(Image.fromarray(crop_rgb))


class PaddleLatinEngine:
    def __init__(self, device: str = "cuda"):
        from paddleocr import PaddleOCR

        # wheel CPU — crop nhỏ nên đủ nhanh, khỏi cài paddlepaddle-gpu trên Windows
        self._ocr = PaddleOCR(lang="es", use_angle_cls=False, show_log=False)

    def read(self, crop_rgb: np.ndarray) -> str:
        result = self._ocr.ocr(crop_rgb, cls=False)
        if not result or not result[0]:
            return ""
        return " ".join(line[1][0] for line in result[0])


ENGINES = {"ja": MangaOcrEngine, "es": PaddleLatinEngine}


class OcrRegistry:
    def __init__(self, device: str = "cuda"):
        self._device = device
        self._cache = {}

    @property
    def langs(self) -> list[str]:
        return list(ENGINES)

    def get(self, lang: str):
        if lang not in self._cache:
            self._cache[lang] = ENGINES[lang](self._device)
        return self._cache[lang]
```

Lưu ý: manga-ocr tải model từ HuggingFace lần chạy đầu (~400MB, cần mạng). PaddleOCR bản 3.x đổi API (`predict` thay `ocr`, kết quả dạng dict) — nếu `self._ocr.ocr(...)` báo lỗi/deprecated, đối chiếu docstring của bản đã cài và chỉnh **thân `read()`** cho khớp; chữ ký `read(crop_rgb) -> str` giữ nguyên.

- [ ] **Step 4: Chạy test, xác nhận PASS**

```powershell
python -m pytest server/tests/test_ocr.py -v
```
Expected: `3 passed` (lần đầu chậm do tải model).

- [ ] **Step 5: Commit**

```powershell
git add server/ocr.py server/tests/test_ocr.py
git commit -m "feat: OCR registry with manga-ocr (ja) and PaddleOCR (es)"
```

---

### Task 4: `translator.py` — Gemini, gom cả trang, retry 1 lần

**Files:**
- Create: `server/translator.py`, `server/tests/test_translator.py`

**Interfaces:**
- Consumes: `server.config.GEMINI_API_KEY`, `server.config.GEMINI_MODEL`.
- Produces: `server.translator.GeminiTranslator()` với `translate(texts: list[str], src: str, dst: str) -> list[str]` (cùng độ dài, cùng thứ tự với `texts`); exception `server.translator.TranslateError`. Task 6 tiêu thụ; endpoint Task 5/6 map `TranslateError` → HTTP 502.

- [ ] **Step 1: Viết test fail (mock toàn bộ, không gọi mạng)**

`server/tests/test_translator.py`:
```python
import json

import pytest

import server.translator as tr


class FakeResp:
    def __init__(self, text):
        self.text = text


class FakeModels:
    def __init__(self, replies):
        self.replies = replies
        self.calls = []

    def generate_content(self, **kw):
        self.calls.append(kw)
        return FakeResp(self.replies.pop(0))


class FakeClient:
    def __init__(self, replies):
        self.models = FakeModels(replies)


def make(monkeypatch, replies):
    monkeypatch.setattr(tr.config, "GEMINI_API_KEY", "test-key")
    monkeypatch.setattr(tr.genai, "Client", lambda api_key: FakeClient(replies))
    return tr.GeminiTranslator()


def test_happy_path(monkeypatch):
    t = make(monkeypatch, [json.dumps(["xin chào", "tạm biệt"])])
    assert t.translate(["こんにちは", "さようなら"], "ja", "vi") == ["xin chào", "tạm biệt"]


def test_prompt_contains_numbered_lines_and_langs(monkeypatch):
    t = make(monkeypatch, [json.dumps(["hi"])])
    t.translate(["hola"], "es", "en")
    prompt = t._client.models.calls[0]["contents"]
    assert "1. hola" in prompt
    assert "Spanish" in prompt and "English" in prompt


def test_retry_on_length_mismatch(monkeypatch):
    t = make(monkeypatch, [json.dumps(["only-one"]), json.dumps(["a", "b"])])
    assert t.translate(["x", "y"], "ja", "vi") == ["a", "b"]


def test_raises_after_two_failures(monkeypatch):
    t = make(monkeypatch, ["not json at all", "still not json"])
    with pytest.raises(tr.TranslateError):
        t.translate(["x"], "ja", "vi")


def test_empty_input_returns_empty_without_calling_api(monkeypatch):
    t = make(monkeypatch, [])
    assert t.translate([], "ja", "vi") == []


def test_missing_api_key_raises(monkeypatch):
    monkeypatch.setattr(tr.config, "GEMINI_API_KEY", "")
    with pytest.raises(tr.TranslateError):
        tr.GeminiTranslator()
```

- [ ] **Step 2: Chạy test, xác nhận FAIL**

```powershell
python -m pytest server/tests/test_translator.py -v
```
Expected: FAIL — `ModuleNotFoundError: No module named 'server.translator'`.

- [ ] **Step 3: Viết `server/translator.py`**

```python
import json

from google import genai

from . import config


class TranslateError(Exception):
    pass


LANG_NAMES = {"ja": "Japanese", "es": "Spanish", "vi": "Vietnamese", "en": "English"}

PROMPT = """You are translating comic/manga dialogue from {src} to {dst}.
Translate each numbered line. Keep pronouns and politeness consistent across
lines (they are speech bubbles from the same page, in reading order). Use
natural spoken style. Return ONLY a JSON array of exactly {n} strings, same
order, no extra text.

{lines}"""


class GeminiTranslator:
    def __init__(self):
        if not config.GEMINI_API_KEY:
            raise TranslateError("GEMINI_API_KEY chưa được đặt trong .env")
        self._client = genai.Client(api_key=config.GEMINI_API_KEY)

    def translate(self, texts: list[str], src: str, dst: str) -> list[str]:
        if not texts:
            return []
        prompt = PROMPT.format(
            src=LANG_NAMES.get(src, src),
            dst=LANG_NAMES.get(dst, dst),
            n=len(texts),
            lines="\n".join(f"{i + 1}. {t}" for i, t in enumerate(texts)),
        )
        last_err = "unknown"
        for _ in range(2):  # 1 lần + 1 retry theo spec
            try:
                resp = self._client.models.generate_content(
                    model=config.GEMINI_MODEL,
                    contents=prompt,
                    config={"temperature": 0.2, "response_mime_type": "application/json"},
                )
                out = json.loads(resp.text)
                if isinstance(out, list) and len(out) == len(texts):
                    return [str(x) for x in out]
                last_err = f"expected {len(texts)} items, got: {str(out)[:80]}"
            except Exception as e:
                last_err = str(e)
        raise TranslateError(last_err)
```

- [ ] **Step 4: Chạy test, xác nhận PASS**

```powershell
python -m pytest server/tests/test_translator.py -v
```
Expected: `6 passed`.

- [ ] **Step 5: Commit**

```powershell
git add server/translator.py server/tests/test_translator.py
git commit -m "feat: Gemini translator with whole-page batching and one retry"
```

---

### Task 5: `pipeline.py` + endpoint `POST /translate` + smoke script

**Files:**
- Create: `server/pipeline.py`, `server/tests/test_pipeline.py`, `server/tests/test_translate_endpoint.py`, `scripts/smoke.ps1`
- Modify: `server/main.py` (thêm `/translate`, lifespan preload)

**Interfaces:**
- Consumes: `Detector.detect(image_bgr) -> list[TextRegion]` (Task 2), `OcrRegistry.get(lang).read(crop_rgb) -> str` (Task 3), `GeminiTranslator.translate(texts, src, dst) -> list[str]` + `TranslateError` (Task 4).
- Produces: `server.pipeline.Pipeline(device="cuda", detector=None, ocr=None, translator=None)` (tham số để inject fake trong test) với `process(image_bytes: bytes, src_lang: str, target_lang: str) -> dict` trả đúng schema response của spec; `POST /translate` hoàn chỉnh. Extension (Task 6-7) tiêu thụ HTTP API này.

- [ ] **Step 1: Viết test fail cho pipeline (fake toàn bộ component)**

`server/tests/test_pipeline.py`:
```python
import cv2
import numpy as np
import pytest

from server.detector import TextRegion
from server.pipeline import Pipeline


class FakeDetector:
    def detect(self, img):
        return [
            TextRegion(bbox=(10, 10, 100, 50), vertical=False),
            TextRegion(bbox=(20, 200, 80, 40), vertical=True),
        ]


class FakeEngine:
    def __init__(self):
        self.texts = iter(["hola", ""])  # block 2 rỗng → phải bị loại

    def read(self, crop):
        return next(self.texts)


class FakeOcr:
    langs = ["ja", "es"]

    def get(self, lang):
        return FakeEngine()


class FakeTranslator:
    def translate(self, texts, src, dst):
        return [f"{dst}:{t}" for t in texts]


def encode_png(w, h):
    return cv2.imencode(".png", np.zeros((h, w, 3), np.uint8))[1].tobytes()


def make_pipeline():
    return Pipeline(detector=FakeDetector(), ocr=FakeOcr(), translator=FakeTranslator())


def test_process_returns_schema():
    out = make_pipeline().process(encode_png(300, 200), "es", "vi")
    assert out["image_w"] == 300 and out["image_h"] == 200
    assert out["blocks"] == [
        {"bbox": [10, 10, 100, 50], "src_text": "hola", "trans_text": "vi:hola"}
    ]


def test_empty_ocr_blocks_are_dropped_not_translated():
    out = make_pipeline().process(encode_png(300, 200), "es", "en")
    assert len(out["blocks"]) == 1  # block OCR rỗng không xuất hiện


def test_bad_image_raises():
    with pytest.raises(ValueError):
        make_pipeline().process(b"not an image", "ja", "vi")
```

- [ ] **Step 2: Chạy test, xác nhận FAIL**

```powershell
python -m pytest server/tests/test_pipeline.py -v
```
Expected: FAIL — `ModuleNotFoundError: No module named 'server.pipeline'`.

- [ ] **Step 3: Viết `server/pipeline.py`**

```python
import cv2
import numpy as np


class Pipeline:
    def __init__(self, device: str = "cuda", detector=None, ocr=None, translator=None):
        # import trong hàm để test với fake không phải load model thật
        if detector is None:
            from .detector import Detector

            detector = Detector(device=device)
        if ocr is None:
            from .ocr import OcrRegistry

            ocr = OcrRegistry(device=device)
        if translator is None:
            from .translator import GeminiTranslator

            translator = GeminiTranslator()
        self.device = device
        self.detector = detector
        self.ocr = ocr
        self.translator = translator

    @property
    def langs(self) -> list[str]:
        return self.ocr.langs

    def process(self, image_bytes: bytes, src_lang: str, target_lang: str) -> dict:
        arr = np.frombuffer(image_bytes, np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("không decode được ảnh")
        h, w = img.shape[:2]
        engine = self.ocr.get(src_lang)
        blocks, texts = [], []
        for region in self.detector.detect(img):
            x, y, bw, bh = region.bbox
            crop = cv2.cvtColor(img[y : y + bh, x : x + bw], cv2.COLOR_BGR2RGB)
            text = engine.read(crop).strip()
            if not text:
                continue
            blocks.append({"bbox": [x, y, bw, bh], "src_text": text})
            texts.append(text)
        for block, trans in zip(blocks, self.translator.translate(texts, src_lang, target_lang)):
            block["trans_text"] = trans
        return {"image_w": w, "image_h": h, "blocks": blocks}
```

- [ ] **Step 4: Chạy test pipeline, xác nhận PASS**

```powershell
python -m pytest server/tests/test_pipeline.py -v
```
Expected: `3 passed`.

- [ ] **Step 5: Viết test fail cho endpoint**

`server/tests/test_translate_endpoint.py`:
```python
import cv2
import numpy as np
from fastapi.testclient import TestClient

import server.main as main
from server.translator import TranslateError

PNG = cv2.imencode(".png", np.zeros((100, 100, 3), np.uint8))[1].tobytes()


class FakePipeline:
    langs = ["ja", "es"]

    def __init__(self, error=None):
        self.error = error

    def process(self, data, src, dst):
        if self.error:
            raise self.error
        return {"image_w": 100, "image_h": 100, "blocks": []}


def post(client, src="ja", dst="vi"):
    return client.post(
        "/translate",
        files={"image": ("p.png", PNG, "image/png")},
        data={"src_lang": src, "target_lang": dst},
    )


def test_translate_ok(monkeypatch):
    monkeypatch.setattr(main, "_pipeline", FakePipeline())
    r = post(TestClient(main.app))
    assert r.status_code == 200
    assert r.json() == {"image_w": 100, "image_h": 100, "blocks": []}


def test_unsupported_lang_422(monkeypatch):
    monkeypatch.setattr(main, "_pipeline", FakePipeline())
    r = post(TestClient(main.app), src="fr")
    assert r.status_code == 422


def test_gemini_error_502(monkeypatch):
    monkeypatch.setattr(main, "_pipeline", FakePipeline(error=TranslateError("quota")))
    r = post(TestClient(main.app))
    assert r.status_code == 502
    assert "gemini" in r.json()["error"]


def test_other_error_500(monkeypatch):
    monkeypatch.setattr(main, "_pipeline", FakePipeline(error=ValueError("bad image")))
    r = post(TestClient(main.app))
    assert r.status_code == 500
```

Chạy `python -m pytest server/tests/test_translate_endpoint.py -v` — Expected: FAIL (404, chưa có endpoint).

- [ ] **Step 6: Cập nhật `server/main.py` hoàn chỉnh**

```python
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
```

- [ ] **Step 7: Chạy toàn bộ test server, xác nhận PASS**

```powershell
python -m pytest server/tests -v
```
Expected: tất cả pass (test detector/ocr chậm vì model thật).

- [ ] **Step 8: Smoke test thật (cần `.env` có GEMINI_API_KEY)**

`scripts/smoke.ps1`:
```powershell
# Bắn fixture vào server đang chạy, in JSON blocks
curl.exe -s -X POST http://127.0.0.1:8910/translate `
  -F "image=@server/tests/fixtures/ja_page.png" `
  -F "src_lang=ja" -F "target_lang=vi"
```

Chạy tay: copy `.env.example` → `.env`, điền API key thật, bật `run_server.bat`, đợi log model load xong, chạy `scripts/smoke.ps1`. Expected: JSON có `blocks` với `src_text` chứa chữ Nhật và `trans_text` tiếng Việt. Đây là mốc "server sống end-to-end".

- [ ] **Step 9: Commit**

```powershell
git add server/pipeline.py server/main.py server/tests/test_pipeline.py server/tests/test_translate_endpoint.py scripts/smoke.ps1
git commit -m "feat: full /translate pipeline (detect -> ocr -> gemini)"
```

---

### Task 6: Extension — manifest + popup + background

**Files:**
- Create: `extension/manifest.json`, `extension/background.js`, `extension/popup.html`, `extension/popup.js`

**Interfaces:**
- Consumes: HTTP API `GET /health`, `POST /translate` (Task 5).
- Produces: message protocol cho content script (Task 7):
  - gửi `{type: "translateImage", url, srcLang, dstLang}` → nhận `{ok: true, image_w, image_h, blocks}` hoặc `{ok: false, error}`;
  - gửi `{type: "health"}` → nhận `{ok: bool, device?, langs?}`.
  - `chrome.storage.local` keys: `enabled: bool` (mặc định true), `srcLang: "ja"|"es"` (mặc định `"ja"`), `dstLang: "vi"|"en"` (mặc định `"vi"`).

- [ ] **Step 1: Viết `extension/manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "MangaTranslator",
  "version": "0.1.0",
  "description": "Dịch truyện tranh và overlay lên trang (local server)",
  "permissions": ["storage"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js" },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "css": ["overlay.css"],
      "run_at": "document_idle"
    }
  ],
  "action": { "default_popup": "popup.html" }
}
```

(`content.js`/`overlay.css` được tạo ở Task 7 — tạm tạo 2 file rỗng để load được extension.)

- [ ] **Step 2: Viết `extension/background.js`**

```js
const SERVER = "http://127.0.0.1:8910";
const MAX_CONCURRENT = 2;

// ponytail: cache trong memory của service worker — mất khi worker ngủ,
// nâng lên chrome.storage.session nếu thấy dịch lại nhiều
const cache = new Map(); // key: url|src|dst -> payload
const queue = [];
let active = 0;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "translateImage") {
    queue.push({ msg, sendResponse });
    pump();
    return true; // giữ kênh trả lời async
  }
  if (msg.type === "health") {
    fetch(`${SERVER}/health`)
      .then((r) => r.json())
      .then((d) => sendResponse({ ok: true, ...d }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
});

function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    active++;
    handle(job.msg)
      .then((res) => job.sendResponse(res))
      .catch((e) => job.sendResponse({ ok: false, error: String(e) }))
      .finally(() => {
        active--;
        pump();
      });
  }
}

async function handle({ url, srcLang, dstLang }) {
  const key = `${url}|${srcLang}|${dstLang}`;
  if (cache.has(key)) return { ok: true, ...cache.get(key) };

  const imgResp = await fetch(url);
  if (!imgResp.ok) throw new Error(`fetch ảnh: HTTP ${imgResp.status}`);
  const blob = await imgResp.blob();

  const form = new FormData();
  form.append("image", blob, "page.png");
  form.append("src_lang", srcLang);
  form.append("target_lang", dstLang);

  const data = await postWithRetry(form);
  cache.set(key, data);
  chrome.action.setBadgeText({ text: "" }); // thành công → xóa cảnh báo
  return { ok: true, ...data };
}

async function postWithRetry(form) {
  try {
    return await post(form);
  } catch (e) {
    await new Promise((r) => setTimeout(r, 3000)); // spec: retry 1 lần sau 3s
    try {
      return await post(form);
    } catch (e2) {
      badge();
      throw e2;
    }
  }
}

async function post(form) {
  const resp = await fetch(`${SERVER}/translate`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(60000), // spec: timeout 60s/ảnh
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

function badge() {
  chrome.action.setBadgeText({ text: "!" });
  chrome.action.setBadgeBackgroundColor({ color: "#d33" });
}
```

Ghi chú lệch spec có chủ đích: spec ghi "thăm dò `/health` mỗi 10s khi server offline" — MV3 service worker ngủ nên polling nền không tin cậy; thay bằng: badge `!` khi request fail, popup kiểm tra `/health` mỗi lần mở. Hành vi người dùng thấy tương đương, ít code hơn.

- [ ] **Step 3: Viết `extension/popup.html` và `extension/popup.js`**

`extension/popup.html`:
```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body { font-family: "Segoe UI", sans-serif; width: 220px; padding: 10px; }
      label { display: block; margin: 8px 0 2px; font-size: 12px; color: #555; }
      select { width: 100%; }
      #status { margin-top: 10px; font-size: 12px; }
      .row { display: flex; align-items: center; gap: 6px; }
    </style>
  </head>
  <body>
    <div class="row">
      <input type="checkbox" id="enabled" />
      <b>Bật dịch</b>
    </div>
    <label for="srcLang">Ngôn ngữ nguồn</label>
    <select id="srcLang">
      <option value="ja">Tiếng Nhật</option>
      <option value="es">Tiếng Tây Ban Nha</option>
    </select>
    <label for="dstLang">Ngôn ngữ đích</label>
    <select id="dstLang">
      <option value="vi">Tiếng Việt</option>
      <option value="en">Tiếng Anh</option>
    </select>
    <div id="status">● đang kiểm tra server…</div>
    <script src="popup.js"></script>
  </body>
</html>
```

`extension/popup.js`:
```js
const $ = (id) => document.getElementById(id);

chrome.storage.local.get(["enabled", "srcLang", "dstLang"]).then((v) => {
  $("enabled").checked = v.enabled !== false;
  $("srcLang").value = v.srcLang || "ja";
  $("dstLang").value = v.dstLang || "vi";
});

$("enabled").onchange = (e) => chrome.storage.local.set({ enabled: e.target.checked });
$("srcLang").onchange = (e) => chrome.storage.local.set({ srcLang: e.target.value });
$("dstLang").onchange = (e) => chrome.storage.local.set({ dstLang: e.target.value });

chrome.runtime.sendMessage({ type: "health" }).then((res) => {
  const ok = res && res.ok;
  $("status").textContent = ok ? `● server: ${res.device}` : "● server offline";
  $("status").style.color = ok ? "#2a2" : "#d33";
});
```

- [ ] **Step 4: Kiểm chứng thủ công**

1. Tạo `extension/content.js` và `extension/overlay.css` rỗng (Task 7 sẽ điền).
2. Chrome → `chrome://extensions` → bật Developer mode → Load unpacked → chọn thư mục `extension/`. Expected: không lỗi manifest.
3. Server đang chạy → mở popup. Expected: "● server: cuda" màu xanh; các dropdown giữ giá trị sau khi đóng/mở lại popup.
4. Tắt server → mở lại popup. Expected: "● server offline" màu đỏ.

- [ ] **Step 5: Commit**

```powershell
git add extension/
git commit -m "feat: extension scaffold - manifest, popup, background queue/cache"
```

---

### Task 7: Extension — content script + overlay

**Files:**
- Modify: `extension/content.js`, `extension/overlay.css` (đang rỗng từ Task 6)
- Create: `extension/test/fixture.html`

**Interfaces:**
- Consumes: message protocol + storage keys từ Task 6; JSON blocks schema từ Task 5.
- Produces: overlay hoàn chỉnh trên trang — deliverable cuối của extension.

- [ ] **Step 1: Viết `extension/content.js`**

```js
const MIN_SIZE = 400; // lọc banner/avatar/icon theo spec

let enabled = true;
let srcLang = "ja";
let dstLang = "vi";

const processed = new WeakSet(); // ảnh đã gửi dịch (kể cả kết quả rỗng — không gửi lại)
const overlays = new Map(); // img -> { container, data }

chrome.storage.local.get(["enabled", "srcLang", "dstLang"]).then((v) => {
  enabled = v.enabled !== false;
  srcLang = v.srcLang || "ja";
  dstLang = v.dstLang || "vi";
  if (enabled) start();
});

chrome.storage.onChanged.addListener((ch) => {
  if (ch.srcLang) srcLang = ch.srcLang.newValue;
  if (ch.dstLang) dstLang = ch.dstLang.newValue;
  if (ch.enabled) {
    enabled = ch.enabled.newValue;
    if (enabled) start();
    else stop();
  }
});

// ---- phát hiện ảnh ----

const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        io.unobserve(e.target);
        translateImage(e.target);
      }
    }
  },
  { rootMargin: "800px 0px" } // spec: dịch trước khi ảnh vào màn hình
);

const mo = new MutationObserver((muts) => {
  for (const m of muts)
    for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.tagName === "IMG") watch(n);
      else if (n.querySelectorAll) for (const img of n.querySelectorAll("img")) watch(img);
    }
});

function eligible(img) {
  return img.naturalWidth >= MIN_SIZE && img.naturalHeight >= MIN_SIZE && (img.currentSrc || img.src);
}

function watch(img) {
  if (processed.has(img)) return;
  if (img.complete) {
    if (eligible(img)) io.observe(img);
  } else {
    img.addEventListener("load", () => watch(img), { once: true });
  }
}

function start() {
  for (const img of document.querySelectorAll("img")) watch(img);
  mo.observe(document.body, { childList: true, subtree: true });
}

function stop() {
  io.disconnect();
  mo.disconnect();
  for (const { container } of overlays.values()) container.remove();
  overlays.clear();
}

// ---- dịch + overlay ----

async function translateImage(img) {
  if (processed.has(img)) return;
  processed.add(img);
  const res = await chrome.runtime.sendMessage({
    type: "translateImage",
    url: img.currentSrc || img.src,
    srcLang,
    dstLang,
  });
  if (!enabled || !res || !res.ok) {
    if (res && !res.ok) console.warn("[MangaTranslator]", res.error);
    return;
  }
  if (res.blocks.length) renderOverlay(img, res);
}

function renderOverlay(img, data) {
  const container = document.createElement("div");
  container.className = "mt-overlay";
  for (const b of data.blocks) {
    const el = document.createElement("div");
    el.className = "mt-bubble";
    el.textContent = b.trans_text;
    container.appendChild(el);
  }
  document.body.appendChild(container);
  overlays.set(img, { container, data });
  position(img);
  new ResizeObserver(() => position(img)).observe(img);
}

// Định vị theo TỌA ĐỘ TÀI LIỆU (spec): container absolute với top/left = vị trí
// ảnh + scroll hiện tại → trình duyệt tự cuộn overlay cùng ảnh, không cần scroll listener.
function position(img) {
  const o = overlays.get(img);
  if (!o) return;
  const r = img.getBoundingClientRect();
  o.container.style.left = r.left + scrollX + "px";
  o.container.style.top = r.top + scrollY + "px";
  o.container.style.width = r.width + "px";
  o.container.style.height = r.height + "px";

  const scale = r.width / img.naturalWidth; // bbox theo pixel ảnh gốc (spec)
  o.data.blocks.forEach((b, i) => {
    const [x, y, w, h] = b.bbox;
    const el = o.container.children[i];
    el.style.left = x * scale + "px";
    el.style.top = y * scale + "px";
    el.style.width = w * scale + "px";
    el.style.height = h * scale + "px";
    fitText(el);
  });
}

// Auto-fit: giảm font tới khi chữ nằm gọn trong bubble, sàn 10px (spec)
function fitText(el) {
  let size = 18;
  el.style.fontSize = size + "px";
  while (size > 10 && (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth)) {
    size--;
    el.style.fontSize = size + "px";
  }
}

// Layout trang xê dịch (trang chèn nội dung, đổi cỡ cửa sổ) → reposition tất cả
new ResizeObserver(() => {
  for (const img of overlays.keys()) position(img);
}).observe(document.documentElement);
window.addEventListener("resize", () => {
  for (const img of overlays.keys()) position(img);
});
```

- [ ] **Step 2: Viết `extension/overlay.css`**

```css
.mt-overlay {
  position: absolute;
  z-index: 2147483000;
  pointer-events: none;
}
.mt-bubble {
  position: absolute;
  background: #fff;
  color: #111;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  overflow: hidden;
  font-family: "Segoe UI", Arial, sans-serif;
  line-height: 1.15;
  padding: 2px;
  box-sizing: border-box;
}
```

- [ ] **Step 3: Viết trang fixture để thử overlay**

`extension/test/fixture.html`:
```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>MangaTranslator fixture</title></head>
  <body style="margin: 0">
    <div style="height: 1500px; background: #eee">cuộn xuống để test lazy-trigger</div>
    <img src="ja_page.png" style="width: 60%; display: block; margin: 20px auto" />
    <img src="es_page.png" style="width: 90%; display: block; margin: 20px auto" />
    <div style="height: 800px"></div>
  </body>
</html>
```

Chuẩn bị: copy 2 fixture PNG vào cùng thư mục — `copy server\tests\fixtures\*.png extension\test\`.

- [ ] **Step 4: Kiểm chứng thủ công trên fixture**

1. Server chạy (`run_server.bat`), extension đã reload (`chrome://extensions` → nút reload).
2. `cd extension/test; python -m http.server 8000` → mở `http://localhost:8000/fixture.html`.
3. Popup: nguồn = Nhật, đích = Việt. Cuộn xuống từ từ.
4. Expected — kiểm từng mục:
   - Ảnh ja hiện overlay trắng đè lên bóng thoại với chữ Việt, **trước hoặc ngay khi** ảnh vào màn hình.
   - Cuộn lên/xuống nhanh: chữ **dính chặt** vào bóng thoại, không trượt, không giật.
   - Đổi cỡ cửa sổ: overlay co giãn theo ảnh (60% width → resize là thấy ngay).
   - Đổi nguồn sang Tây Ban Nha trong popup rồi **F5**: ảnh es được dịch (ảnh ja OCR sai là bình thường — sai ngôn ngữ nguồn với ảnh ja, đúng hành vi v1 chọn tay).
   - Tắt công tắc trong popup: mọi overlay biến mất; bật lại + F5: hiện lại (lần này nhanh — cache).
   - Tắt server, F5: không có overlay, badge `!` đỏ trên icon, popup báo offline; không lỗi văng ra trang.

- [ ] **Step 5: Commit**

```powershell
git add extension/
git commit -m "feat: content script - image detection, document-coords overlay, autofit"
```

---

### Task 8: E2E trên site thật + README

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: toàn bộ hệ thống từ Task 1-7.
- Produces: xác nhận hệ thống chạy trên site đọc truyện thật; tài liệu chạy dự án.

- [ ] **Step 1: Chạy toàn bộ test server lần cuối**

```powershell
python -m pytest server/tests -v
```
Expected: tất cả pass.

- [ ] **Step 2: Kiểm chứng trên 2 site đọc truyện thật**

Mở một site đọc manga raw tiếng Nhật và một site truyện tiếng Tây Ban Nha (người dùng chọn site họ hay đọc). Với mỗi site, lặp checklist Task 7 Step 4, thêm:
- Ảnh lazy-load của site (cuộn chương dài) được dịch dần, tối đa 2 request đồng thời (xem tab Network của service worker).
- Ảnh nhỏ (logo, banner, avatar) KHÔNG bị gửi dịch.
- Nếu site chặn hotlink (fetch ảnh 403): console có warning `[MangaTranslator]`, trang không vỡ — đúng hành vi spec (bỏ qua ảnh đó).

Ghi lại site nào chạy tốt / lỗi gì vào commit message hoặc issue để làm mồi cho v2.

- [ ] **Step 3: Viết `README.md`**

```markdown
# MangaTranslator

Dịch truyện tranh (Nhật/Tây Ban Nha → Việt/Anh) ngay trên browser:
extension phát hiện ảnh truyện, local server OCR + dịch qua Gemini,
chữ dịch overlay đè đúng bóng thoại.

## Chạy

1. **Server** (một lần đầu): tạo venv, cài deps theo
   `docs/superpowers/plans/2026-07-21-manga-translator.md` Task 1-2
   (gồm vendor comic-text-detector + tải weights); copy `.env.example`
   → `.env`, điền `GEMINI_API_KEY`.
2. Bật server: `run_server.bat` (đợi log model load xong).
3. **Extension**: `chrome://extensions` → Developer mode → Load unpacked
   → thư mục `extension/`.
4. Mở popup chọn ngôn ngữ nguồn/đích, vào trang truyện, đọc như thường.

## Kiến trúc

Xem `docs/superpowers/specs/2026-07-21-manga-translator-design.md`.

## Test

- Server: `python -m pytest server/tests -v`
- Smoke: `scripts/smoke.ps1` (server phải đang chạy)
- Overlay: `extension/test/fixture.html` qua `python -m http.server 8000`
```

- [ ] **Step 4: Commit**

```powershell
git add README.md
git commit -m "docs: README with run instructions; e2e verified on real sites"
```
