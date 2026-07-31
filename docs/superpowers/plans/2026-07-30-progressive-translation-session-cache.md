# Progressive Translation + Session Page Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hiển thị bản dịch theo từng block, tái sử dụng đúng analysis/OCR/translation artifact, và giữ mọi manual single-page job đã được chấp nhận trong cùng phiên Chrome để người dùng quay lại khôi phục mà không gọi lại pipeline khi exact cache còn đủ.

**Architecture:** Local server tách pipeline thành analysis artifact, partial OCR artifact và structured translation; service worker sở hữu scheduler, single-flight, micro-batch, cancellation và `chrome.storage.session`; content script chỉ chọn ảnh, đăng ký render subscription và upsert overlay. Micro-batch nằm trong service worker—không nằm trong content—vì content bị hủy khi full navigation nhưng manual `visible` job vẫn phải hoàn tất trong nền.

**Tech Stack:** Chrome Extension Manifest V3 · vanilla JavaScript · `chrome.runtime.Port` · `chrome.storage.session` · Web Crypto · Fetch/NDJSON · Python 3.12 · FastAPI/StreamingResponse · OpenCV/NumPy · pytest · Node assert/VM tests.

## Global Constraints

- Không thêm runtime dependency mới; dùng stdlib Python, Web Platform API và dependency đã có.
- Giữ `MAX_CONCURRENT = 2`; mỗi request chỉ có tối đa 4 producer được admit đồng thời.
- Priority cố định: foreground hiện hành > detached manual `visible` FIFO > prewarm.
- Micro-batch: batch đầu 3 block hoặc 250 ms; batch sau 8 block hoặc 500 ms; flush khi image kết thúc.
- Session cache soft budget đúng 8 MiB; không lưu image bytes hoặc prepared crop trong Chrome storage.
- Server analysis cache: tối đa 32 artifact và 128 MiB; partial OCR cache: 256 `ocrKey`.
- Service-worker hot cache: 256 OCR image record và 2.048 translation block record.
- Cache identity phải gồm source/crop, natural dimensions, language, model và version như spec; không log raw URL có query.
- Manual `visible` được gắn `persistUntilDone`; `loaded` và prewarm không được kế thừa policy này.
- Rời viewport giữ overlay. Source đổi hoặc DOM image bị xóa chỉ detach overlay; không xóa artifact.
- Không auto-discover/auto-translate ảnh mới, không WebSocket, IndexedDB, server task registry, Shadow DOM, DeepL, PaddleOCR GPU hoặc heuristic reading-order mới.
- Giữ `/ocr`, `/translate-texts`, `/translate` và toàn bộ test cũ.
- Test JS tiếp tục dùng Node built-in `assert`/`vm`; test Python dùng pytest hiện có.

## File Responsibility Map

| File | Trách nhiệm sau thay đổi |
|---|---|
| `server/artifacts.py` | Bounded LRU, analysis/OCR record và stable `blockId` |
| `server/config.py` | Version descriptor trả cho extension |
| `server/pipeline.py` | `analyze()`, `iter_ocr()`, compatibility wrappers |
| `server/translator.py` | Structured translation theo exact ID set và failover hiện có |
| `server/main.py` | `/ocr-stream`, `/translate-items`, health versions; giữ API cũ |
| `extension/page-cache.js` | Storage schema, 8 MiB eviction, job ledger/page record, rehydrate |
| `extension/background.js` | Key derivation, Port protocol, scheduler, producers, batching, cancellation, hot cache |
| `extension/srcset.js` | Candidate source/crop/priority metadata; không sở hữu cache-completion |
| `extension/content.js` | Request snapshot, Port subscriber, stale guards, block upsert, overlay lifecycle |
| `extension/popup.js`, `popup.html` | Trigger action và hiển thị status/cache summary ngắn |
| `extension/test/fixture.html` | A/B navigation và browser acceptance |
| `work-flow.md` | Workflow as-is sau khi implementation đã pass |

---

### Task 1: Version descriptor, bounded server artifacts và stable block identity

**Files:**
- Create: `server/artifacts.py`
- Modify: `server/config.py:1-9`
- Create: `server/tests/test_artifacts.py`

**Interfaces:**
- Produces: `PIPELINE_VERSIONS: dict[str, object]`.
- Produces: `BoundedLru(max_items, max_bytes=None, size_of=None)` với `get(key)`, `put(key, value) -> list[evicted_key]`, `peek(key)`.
- Produces: `stable_block_id(analysis_key: str, bbox: tuple[int,int,int,int], ordinal: int) -> str`.
- Produces: `PreparedRegion`, `AnalysisArtifact`, `OcrArtifact` dataclass dùng ở Task 2.

- [ ] **Step 1: Viết test thất bại cho identity và hai giới hạn LRU**

```python
# server/tests/test_artifacts.py
import numpy as np

from server.artifacts import (
    AnalysisArtifact,
    BoundedLru,
    PreparedRegion,
    stable_block_id,
)


def artifact(key, size):
    crop = np.zeros((size, 1, 1), np.uint8)
    region = PreparedRegion("b", (1, 2, 3, 4), crop)
    return AnalysisArtifact(key, 100, 200, (region,), crop.nbytes)


def test_stable_block_id_changes_only_with_identity_inputs():
    a = stable_block_id("analysis-a", (1, 2, 3, 4), 0)
    assert a == stable_block_id("analysis-a", (1, 2, 3, 4), 0)
    assert a != stable_block_id("analysis-a", (1, 2, 3, 4), 1)
    assert a != stable_block_id("analysis-b", (1, 2, 3, 4), 0)


def test_lru_evicts_by_count_and_touch():
    cache = BoundedLru(max_items=2)
    cache.put("a", 1)
    cache.put("b", 2)
    assert cache.get("a") == 1
    assert cache.put("c", 3) == ["b"]
    assert cache.peek("a") == 1


def test_lru_evicts_by_bytes():
    cache = BoundedLru(max_items=32, max_bytes=5, size_of=lambda value: value.byte_size)
    cache.put("a", artifact("a", 3))
    assert cache.put("b", artifact("b", 3)) == ["a"]
```

- [ ] **Step 2: Chạy test và xác nhận lỗi import**

Run: `& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_artifacts.py -q`

Expected: FAIL với `ModuleNotFoundError: No module named 'server.artifacts'`.

- [ ] **Step 3: Thêm implementation tối thiểu trong `server/artifacts.py`**

```python
from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass, field
from hashlib import sha256
import json
from threading import Lock
from typing import Callable, Generic, TypeVar

import numpy as np

K = TypeVar("K")
V = TypeVar("V")


@dataclass(frozen=True)
class PreparedRegion:
    block_id: str
    bbox: tuple[int, int, int, int]
    crop_rgb: np.ndarray


@dataclass(frozen=True)
class AnalysisArtifact:
    key: str
    image_w: int
    image_h: int
    regions: tuple[PreparedRegion, ...]
    byte_size: int


@dataclass
class OcrArtifact:
    key: str
    analysis_key: str
    completed_ids: set[str] = field(default_factory=set)
    blocks: dict[str, dict] = field(default_factory=dict)
    failures: dict[str, str] = field(default_factory=dict)
    complete: bool = False


def stable_block_id(analysis_key, bbox, ordinal):
    raw = json.dumps([analysis_key, list(bbox), ordinal], separators=(",", ":"))
    return sha256(raw.encode("utf-8")).hexdigest()[:24]


class BoundedLru(Generic[K, V]):
    def __init__(self, max_items, max_bytes=None, size_of: Callable[[V], int] | None = None):
        self.max_items = max_items
        self.max_bytes = max_bytes
        self.size_of = size_of or (lambda value: 1)
        self._items = OrderedDict()
        self._bytes = 0
        self._lock = Lock()

    def __len__(self):
        with self._lock:
            return len(self._items)

    def peek(self, key):
        with self._lock:
            row = self._items.get(key)
            return None if row is None else row[0]

    def get(self, key):
        with self._lock:
            row = self._items.get(key)
            if row is None:
                return None
            self._items.move_to_end(key)
            return row[0]

    def put(self, key, value):
        with self._lock:
            if key in self._items:
                _, old_size = self._items.pop(key)
                self._bytes -= old_size
            size = self.size_of(value)
            self._items[key] = (value, size)
            self._bytes += size
            evicted = []
            while len(self._items) > self.max_items or (
                self.max_bytes is not None and self._bytes > self.max_bytes
            ):
                old_key, (_, old_size) = self._items.popitem(last=False)
                self._bytes -= old_size
                evicted.append(old_key)
            return evicted
```

- [ ] **Step 4: Khai báo version descriptor ở một nơi phía server**

```python
# server/config.py
PIPELINE_VERSIONS = {
    "detector": "comic-text-detector-v1",
    "dedupe": "iou-0.5-area-bbox-v2",
    "prep": "upscale48-border8-v1",
    "recognizers": {"ja": "manga-ocr-v1", "es": "paddleocr-es-v1"},
    "translator_model": GEMINI_MODEL,
    "prompt": "comic-items-v1",
    "policy": "microbatch-3-8-250-500-v1",
    "page_schema": "page-v1",
}
```

- [ ] **Step 5: Chạy test unit**

Run: `& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_artifacts.py -q`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add server/artifacts.py server/config.py server/tests/test_artifacts.py
git commit -m "feat: add versioned pipeline artifacts"
```

---

### Task 2: Tách analysis khỏi recognizer và cache partial OCR

**Files:**
- Modify: `server/pipeline.py:1-122`
- Modify: `server/tests/test_pipeline.py`

**Interfaces:**
- Consumes: artifact classes và `stable_block_id()` từ Task 1.
- Produces: `Pipeline.get_analysis(key) -> AnalysisArtifact | None`.
- Produces: `Pipeline.analyze(image_bytes, crop, analysis_key) -> AnalysisArtifact`.
- Produces: `Pipeline.iter_ocr(analysis_key, src_lang, ocr_key, cancelled=lambda: False) -> Iterator[dict]`.
- Preserves: `Pipeline.ocr_image(...)` và `Pipeline.process(...)` schema cũ.

- [ ] **Step 1: Thêm test thất bại cho reuse, stable order, partial retry và block isolation**

```python
# append to server/tests/test_pipeline.py
class CountingDetector:
    def __init__(self):
        self.calls = 0

    def detect(self, image):
        self.calls += 1
        return [TextRegion(bbox=(10, 10, 40, 20), vertical=False)]


class ThreeRegionDetector:
    def detect(self, image):
        return [
            TextRegion(bbox=(10, 10, 40, 20), vertical=False),
            TextRegion(bbox=(60, 10, 40, 20), vertical=False),
            TextRegion(bbox=(110, 10, 40, 20), vertical=False),
        ]


class TwoRegionDetector:
    def detect(self, image):
        return [
            TextRegion(bbox=(10, 10, 40, 20), vertical=False),
            TextRegion(bbox=(60, 10, 40, 20), vertical=False),
        ]


class SequenceEngine:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = 0

    def read(self, crop):
        self.calls += 1
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


class CancelAfterFirstEngine:
    def __init__(self, cancelled):
        self.cancelled = cancelled
        self.calls = 0

    def read(self, crop):
        self.calls += 1
        self.cancelled[0] = True
        return "hola"


def test_analysis_is_reused_across_recognizers():
    detector = CountingDetector()
    pipeline = Pipeline(detector=detector, ocr=FakeOcr(), translator=FakeTranslator())
    data = encode_png(300, 200)
    pipeline.analyze(data, None, "a1")
    pipeline.analyze(data, None, "a1")
    assert detector.calls == 1


def test_iter_ocr_retries_only_failed_block():
    engine = SequenceEngine(["hola", RuntimeError("bad"), "adios", "retry"])
    pipeline = Pipeline(
        detector=ThreeRegionDetector(),
        ocr=SharedOcr(engine),
        translator=FakeTranslator(),
    )
    pipeline.analyze(encode_png(300, 200), None, "a1")
    first = list(pipeline.iter_ocr("a1", "es", "o1"))
    assert [event["type"] for event in first].count("ocr_block_error") == 1
    second = list(pipeline.iter_ocr("a1", "es", "o1"))
    assert engine.calls == 4
    assert second[-1]["type"] == "image_done"
    assert second[-1]["failed"] == 0


def test_cancel_is_checked_between_engine_reads():
    cancelled = [False]
    engine = CancelAfterFirstEngine(cancelled)
    pipeline = Pipeline(
        detector=TwoRegionDetector(),
        ocr=SharedOcr(engine),
        translator=FakeTranslator(),
    )
    pipeline.analyze(encode_png(300, 200), None, "a1")
    events = list(pipeline.iter_ocr("a1", "es", "o1", lambda: cancelled[0]))
    assert engine.calls == 1
```

Định nghĩa fake ngay trong test file: `CountingDetector.calls`, `SequenceEngine.calls`, detector trả bbox cố định. Không dùng model thật.

- [ ] **Step 2: Chạy ba test và xác nhận API chưa tồn tại**

Run: `& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_pipeline.py -k "analysis_is_reused or retries_only_failed or cancel_is_checked" -q`

Expected: FAIL vì `Pipeline.analyze`/`iter_ocr` chưa có.

- [ ] **Step 3: Tách `analyze()` và giữ bbox ảnh gốc**

```python
from collections import Counter
from hashlib import sha256
from .artifacts import AnalysisArtifact, BoundedLru, OcrArtifact, PreparedRegion, stable_block_id

ANALYSIS_MAX_BYTES = 128 * 1024 * 1024

# trong Pipeline.__init__
self._analysis_cache = BoundedLru(
    max_items=32,
    max_bytes=ANALYSIS_MAX_BYTES,
    size_of=lambda artifact: artifact.byte_size,
)
self._ocr_cache = BoundedLru(max_items=256)

def get_analysis(self, key):
    return self._analysis_cache.get(key)

def analyze(self, image_bytes, crop, analysis_key):
    cached = self._analysis_cache.get(analysis_key)
    if cached is not None:
        return cached
    with self._ocr_lock:
        cached = self._analysis_cache.get(analysis_key)
        if cached is not None:
            return cached
        img, image_w, image_h, work, offset_x, offset_y = self._decode_crop(image_bytes, crop)
        work_h, work_w = work.shape[:2]
        regions = sorted(
            _dedupe_regions(self.detector.detect(work)),
            key=lambda region: (-region.bbox[2] * region.bbox[3], *region.bbox),
        )
        ordinals = Counter()
        prepared = []
        for region in regions:
            x, y, bw, bh = region.bbox
            x, y = max(0, x), max(0, y)
            x2, y2 = min(work_w, x + bw), min(work_h, y + bh)
            if x2 <= x or y2 <= y:
                continue
            bbox = (offset_x + x, offset_y + y, x2 - x, y2 - y)
            ordinal = ordinals[bbox]
            ordinals[bbox] += 1
            crop_rgb = cv2.cvtColor(work[y:y2, x:x2], cv2.COLOR_BGR2RGB)
            prepared.append(
                PreparedRegion(
                    stable_block_id(analysis_key, bbox, ordinal),
                    bbox,
                    _prep_crop(crop_rgb),
                )
            )
        artifact = AnalysisArtifact(
            analysis_key,
            image_w,
            image_h,
            tuple(prepared),
            sum(region.crop_rgb.nbytes for region in prepared),
        )
        self._analysis_cache.put(analysis_key, artifact)
        return artifact
```

`_decode_crop()` giữ nguyên coordinate contract:

```python
def _decode_crop(self, image_bytes, crop):
    arr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("không decode được ảnh")
    image_h, image_w = img.shape[:2]
    offset_x = offset_y = 0
    work = img
    if crop is not None:
        left, top, right, bottom = crop
        if not (0 <= left < right <= 1 and 0 <= top < bottom <= 1):
            raise ValueError("crop outside image")
        offset_x = floor(left * image_w)
        offset_y = floor(top * image_h)
        crop_right = ceil(right * image_w)
        crop_bottom = ceil(bottom * image_h)
        work = img[offset_y:crop_bottom, offset_x:crop_right]
    return img, image_w, image_h, work, offset_x, offset_y
```

`analyze()` không gọi `self.ocr.get()`.

- [ ] **Step 4: Thêm partial OCR iterator với cache-after-each-block**

```python
def iter_ocr(self, analysis_key, src_lang, ocr_key, cancelled=lambda: False):
    analysis = self._analysis_cache.get(analysis_key)
    if analysis is None:
        raise KeyError("analysis_missing")
    record = self._ocr_cache.get(ocr_key)
    if record is None:
        record = OcrArtifact(ocr_key, analysis_key)
        self._ocr_cache.put(ocr_key, record)

    for region in analysis.regions:
        cached = record.blocks.get(region.block_id)
        if cached is not None:
            yield {"type": "ocr_block", "ocr_key": ocr_key, **cached}

    if record.complete:
        yield {
            "type": "image_done",
            "ocr_key": ocr_key,
            "recognized": len(record.blocks),
            "failed": 0,
        }
        return

    with self._ocr_lock:
        engine = self.ocr.get(src_lang)
    for region in analysis.regions:
        if region.block_id in record.completed_ids:
            continue
        if cancelled():
            return
        try:
            with self._ocr_lock:
                text = engine.read(region.crop_rgb).strip()
        except Exception:
            record.failures[region.block_id] = "recognizer_failed"
            yield {
                "type": "ocr_block_error",
                "ocr_key": ocr_key,
                "block_id": region.block_id,
                "code": "recognizer_failed",
            }
            continue
        record.completed_ids.add(region.block_id)
        record.failures.pop(region.block_id, None)
        if text:
            block = {
                "block_id": region.block_id,
                "bbox": list(region.bbox),
                "src_text": text,
            }
            record.blocks[region.block_id] = block
            yield {"type": "ocr_block", "ocr_key": ocr_key, **block}

    record.complete = len(record.completed_ids) == len(analysis.regions)
    yield {
        "type": "image_done",
        "ocr_key": ocr_key,
        "recognized": len(record.blocks),
        "failed": len(analysis.regions) - len(record.completed_ids),
    }
```

- [ ] **Step 5: Viết compatibility wrapper bằng staged API**

```python
def ocr_image(self, image_bytes, src_lang, crop=None):
    digest = sha256(image_bytes).hexdigest()
    analysis_key = f"legacy:{digest}:{crop}"
    ocr_key = f"{analysis_key}:{src_lang}"
    analysis = self.analyze(image_bytes, crop, analysis_key)
    blocks = {}
    for event in self.iter_ocr(analysis_key, src_lang, ocr_key):
        if event["type"] == "ocr_block":
            blocks[event["block_id"]] = {
                "bbox": event["bbox"],
                "src_text": event["src_text"],
            }
    ordered = [blocks[r.block_id] for r in analysis.regions if r.block_id in blocks]
    return {"image_w": analysis.image_w, "image_h": analysis.image_h, "blocks": ordered}
```

- [ ] **Step 6: Chạy pipeline tests**

Run: `& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_pipeline.py -q`

Expected: toàn file PASS, gồm schema compatibility cũ.

- [ ] **Step 7: Commit**

```powershell
git add server/pipeline.py server/tests/test_pipeline.py
git commit -m "feat: stage analysis and partial OCR"
```

---

### Task 3: Thêm `/ocr-stream` NDJSON nhưng giữ `/ocr`

**Files:**
- Modify: `server/main.py:1-91`
- Create: `server/tests/test_ocr_stream.py`
- Modify: `server/tests/test_health.py`

**Interfaces:**
- Consumes: `Pipeline.analyze/get_analysis/iter_ocr` từ Task 2.
- Produces: `POST /ocr-stream` với multipart fields `analysis_key`, `ocr_key`, `src_lang`, optional image/crop.
- Produces event order: `analysis_ready` → zero or more block events → `image_done`.
- Produces: HTTP 409 `{"error":"analysis_missing"}` khi warm request không file tham chiếu cache đã mất.

- [ ] **Step 1: Viết endpoint tests thất bại**

```python
# server/tests/test_ocr_stream.py
import json
from fastapi.testclient import TestClient

import server.main as main


class FakeStreamPipeline:
    def __init__(self):
        self.analysis = None

    def get_analysis(self, key):
        return self.analysis if self.analysis and self.analysis.key == key else None

    def analyze(self, data, crop, key):
        self.analysis = type(
            "Analysis",
            (),
            {"key": key, "image_w": 100, "image_h": 200, "regions": [1, 2]},
        )()
        return self.analysis

    def iter_ocr(self, analysis_key, src_lang, ocr_key, cancelled):
        yield {
            "type": "ocr_block",
            "ocr_key": ocr_key,
            "block_id": "b1",
            "bbox": [1, 2, 3, 4],
            "src_text": "hola",
        }
        yield {"type": "image_done", "ocr_key": ocr_key, "recognized": 1, "failed": 0}


def events(response):
    return [json.loads(line) for line in response.text.splitlines()]


def test_ocr_stream_cold_then_warm(monkeypatch):
    pipeline = FakeStreamPipeline()
    monkeypatch.setattr(main, "_pipeline", pipeline)
    client = TestClient(main.app)
    cold = client.post(
        "/ocr-stream",
        files={"image": ("page.png", b"png", "image/png")},
        data={"analysis_key": "a1", "ocr_key": "o1", "src_lang": "es"},
    )
    assert [row["type"] for row in events(cold)] == [
        "analysis_ready", "ocr_block", "image_done"
    ]
    warm = client.post(
        "/ocr-stream",
        data={"analysis_key": "a1", "ocr_key": "o2", "src_lang": "ja"},
    )
    assert warm.status_code == 200


def test_ocr_stream_reports_analysis_missing(monkeypatch):
    monkeypatch.setattr(main, "_pipeline", FakeStreamPipeline())
    response = TestClient(main.app).post(
        "/ocr-stream",
        data={"analysis_key": "missing", "ocr_key": "o1", "src_lang": "ja"},
    )
    assert response.status_code == 409
    assert response.json() == {"error": "analysis_missing"}
```

- [ ] **Step 2: Chạy test và xác nhận 404**

Run: `& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_ocr_stream.py -q`

Expected: FAIL vì endpoint trả 404.

- [ ] **Step 3: Thêm async streaming endpoint, đưa blocking ML sang thread**

```python
import asyncio
import json

from fastapi import Request
from fastapi.responses import StreamingResponse


def _ndjson(event):
    return json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n"


def _validated_crop(left, top, right, bottom):
    values = (left, top, right, bottom)
    if any(value is not None for value in values) and not all(value is not None for value in values):
        return JSONResponse(
            status_code=422,
            content={"error": "crop requires left, top, right, bottom"},
        )
    return None if left is None else values


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
    if data is None and pipeline.get_analysis(analysis_key) is None:
        return JSONResponse(status_code=409, content={"error": "analysis_missing"})

    async def stream():
        try:
            analysis = pipeline.get_analysis(analysis_key)
            if analysis is None:
                analysis = await asyncio.to_thread(
                    pipeline.analyze, data, crop_or_error, analysis_key
                )
            yield _ndjson({
                "type": "analysis_ready",
                "analysis_key": analysis_key,
                "image_w": analysis.image_w,
                "image_h": analysis.image_h,
                "regions": len(analysis.regions),
            })
            iterator = pipeline.iter_ocr(
                analysis_key,
                src_lang,
                ocr_key,
                lambda: False,
            )
            while not await request.is_disconnected():
                event = await asyncio.to_thread(next, iterator, None)
                if event is None:
                    break
                yield _ndjson(event)
        except ValueError as error:
            yield _ndjson({"type": "job_error", "stage": "decode", "code": str(error)})

    return StreamingResponse(stream(), media_type="application/x-ndjson")
```

Extract `_validated_crop()` from existing `/ocr` so both endpoints use exactly the same four-fields-or-none rule.

- [ ] **Step 4: Trả version descriptor trong health**

```python
@app.get("/health")
def health():
    return {
        "status": "ok",
        "device": config.DEVICE,
        "langs": LANGS,
        "versions": config.PIPELINE_VERSIONS,
    }
```

- [ ] **Step 5: Chạy endpoint compatibility tests**

Run: `& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_ocr_stream.py server/tests/test_translate_endpoint.py server/tests/test_health.py -q`

Expected: PASS; `/ocr` cũ vẫn pass.

- [ ] **Step 6: Commit**

```powershell
git add server/main.py server/tests/test_ocr_stream.py server/tests/test_health.py
git commit -m "feat: stream OCR blocks over NDJSON"
```

---

### Task 4: Structured Gemini translation theo exact ID set

**Files:**
- Modify: `server/translator.py:1-66`
- Modify: `server/main.py:62-74`
- Modify: `server/tests/test_translator.py`
- Modify: `server/tests/test_translate_endpoint.py`

**Interfaces:**
- Produces: `GeminiTranslator.translate_items(items, src, dst) -> list[dict]`.
- Input item: `{"id": str, "text": str}`; output item: `{"id": str, "translation": str}`.
- Produces: `POST /translate-items` body `{src_lang,dst_lang,items}`.
- Preserves: `translate(texts, src, dst) -> list[str]` và `/translate-texts`.

- [ ] **Step 1: Viết test thất bại cho exact-set validation**

```python
# append to server/tests/test_translator.py
def test_translate_items_accepts_reordered_exact_ids(monkeypatch):
    reply = json.dumps([
        {"id": "b2", "translation": "hai"},
        {"id": "b1", "translation": "một"},
    ])
    translator = make(monkeypatch, [reply])
    assert translator.translate_items(
        [{"id": "b1", "text": "one"}, {"id": "b2", "text": "two"}],
        "en",
        "vi",
    ) == [
        {"id": "b1", "translation": "một"},
        {"id": "b2", "translation": "hai"},
    ]


@pytest.mark.parametrize(
    "reply",
    [
        [{"id": "b1", "translation": "x"}],
        [{"id": "b1", "translation": "x"}, {"id": "foreign", "translation": "y"}],
        [{"id": "b1", "translation": "x"}, {"id": "b1", "translation": "y"}],
    ],
)
def test_translate_items_rejects_missing_foreign_or_duplicate_ids(monkeypatch, reply):
    translator = make(monkeypatch, [json.dumps(reply), json.dumps(reply)])
    with pytest.raises(tr.TranslateError):
        translator.translate_items(
            [{"id": "b1", "text": "one"}, {"id": "b2", "text": "two"}],
            "en",
            "vi",
        )
```

- [ ] **Step 2: Chạy test và xác nhận method chưa có**

Run: `& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_translator.py -k translate_items -q`

Expected: FAIL với `AttributeError`.

- [ ] **Step 3: Đổi prompt sang object ID và giữ failover loop một lần**

```python
ITEM_PROMPT = """You are translating comic/manga dialogue from {src} to {dst}.
Translate every item. Keep pronouns and politeness consistent inside this batch.
Return ONLY a JSON array of objects with exactly these keys:
{{"id":"the input id","translation":"translated text"}}.
Return each input id exactly once; do not invent ids.

{items}"""

def _decode_items(raw, expected_ids):
    out = json.loads(raw)
    if not isinstance(out, list):
        raise ValueError("expected an array")
    rows = {}
    for item in out:
        if not isinstance(item, dict) or set(item) != {"id", "translation"}:
            raise ValueError("invalid translation item")
        item_id = str(item["id"])
        if item_id in rows:
            raise ValueError(f"duplicate id: {item_id}")
        rows[item_id] = str(item["translation"])
    if set(rows) != set(expected_ids):
        raise ValueError("translation id set mismatch")
    return [{"id": item_id, "translation": rows[item_id]} for item_id in expected_ids]

def translate_items(self, items, src, dst):
    if not items:
        return []
    ids = [str(item["id"]) for item in items]
    if len(ids) != len(set(ids)):
        raise TranslateError("duplicate input id")
    prompt = ITEM_PROMPT.format(
        src=LANG_NAMES.get(src, src),
        dst=LANG_NAMES.get(dst, dst),
        items=json.dumps(items, ensure_ascii=False),
    )
    return self._generate(prompt, lambda raw: _decode_items(raw, ids))
```

`_generate(prompt, decode)` chứa nguyên vòng tối đa 2 attempt, 429 failover và promotion guard hiện tại; chỉ thay phần parse bằng callback `decode(resp.text)`.

```python
def _generate(self, prompt, decode):
    last_err = "unknown"
    client_index = self._active_client
    switched = False
    for attempt in range(2):
        try:
            response = self._clients[client_index].models.generate_content(
                model=config.GEMINI_MODEL,
                contents=prompt,
                config={"temperature": 0.2, "response_mime_type": "application/json"},
            )
            result = decode(response.text)
            if switched:
                self._active_client = client_index
            return result
        except Exception as error:
            last_err = str(error)
            if getattr(error, "code", None) == 429:
                if attempt == 0 and len(self._clients) > 1:
                    client_index = 1 - client_index
                    switched = True
                    continue
                break
    raise TranslateError(last_err)
```

Giữ `translate()` dùng `PROMPT` array-string hiện tại để mọi caller/API cũ và fixture test cũ không đổi:

```python
def translate(self, texts, src, dst):
    if not texts:
        return []
    prompt = PROMPT.format(
        src=LANG_NAMES.get(src, src),
        dst=LANG_NAMES.get(dst, dst),
        n=len(texts),
        lines="\n".join(f"{index + 1}. {text}" for index, text in enumerate(texts)),
    )

    def decode(raw):
        out = json.loads(raw)
        if not isinstance(out, list) or len(out) != len(texts):
            raise ValueError(f"expected {len(texts)} translation strings")
        return [str(value) for value in out]

    return self._generate(prompt, decode)
```

- [ ] **Step 4: Thêm Pydantic contract và endpoint**

```python
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
        return {
            "items": get_pipeline().translator.translate_items(
                rows, body.src_lang, body.dst_lang
            )
        }
    except TranslateError as error:
        return JSONResponse(status_code=502, content={"error": f"gemini: {error}"})
```

- [ ] **Step 5: Thêm endpoint assertions**

Test `/translate-items` success giữ đúng ID dù translator trả reorder; duplicate input trả 422; fake translator có `translate_items()`. Không xóa test `/translate-texts` cũ.

- [ ] **Step 6: Chạy translator/API tests**

Run: `& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_translator.py server/tests/test_translate_endpoint.py -q`

Expected: PASS, bao gồm failover concurrency cũ.

- [ ] **Step 7: Commit**

```powershell
git add server/translator.py server/main.py server/tests/test_translator.py server/tests/test_translate_endpoint.py
git commit -m "feat: translate comic blocks by stable id"
```

---

### Task 5: Session job ledger và 8 MiB page cache

**Files:**
- Create: `extension/page-cache.js`
- Create: `extension/test/page-cache.test.js`
- Modify: `extension/background.js:1` (load helper)

**Interfaces:**
- Produces global/CommonJS `PageCache`, `CacheFullError`, `PAGE_SCHEMA = "page-v1"`.
- `PageCache.getPage(pageKey)`, `findPage(predicate)`, `putPage(record)`.
- `PageCache.putJob(record)`, `removeJob(jobId)`, `removePage(pageKey)`, `rehydrate() -> {pages,jobs}`.
- `PageCache.purgeIncompatible(versions) -> removedCount`.
- `PageCache.status() -> {background,cached,failed}`.
- Storage keys: `mt:page:<pageArtifactKey>` và `mt:job:<jobId>`.

Page record persisted by Task 7 uses this exact superset of the spec minimum:

```javascript
{
  schema_version: "page-v1",
  page_artifact_key: "p1",
  analysis_key: "a1",
  ocr_key: "o1",
  overlay_key: "v1",
  source_url: "https://x/page.jpg",
  crop: "full",
  natural_width: 1200,
  natural_height: 1800,
  src_lang: "ja",
  dst_lang: "vi",
  versions: {},
  state: "queued",
  analysis_known: false,
  ocr_done: false,
  image_w: null,
  image_h: null,
  blocks: [],
  created_at: 0,
  updated_at: 0,
  last_accessed_at: 0,
  last_error: null
}
```

Job ledger stores `job_id,scope,src_lang,dst_lang,descriptor,state,waiting_for_health,created_at`; it contains no image bytes.

- [ ] **Step 1: Viết fake storage và test state/eviction thất bại**

```javascript
// extension/test/page-cache.test.js
const assert = require("assert");
const { PageCache, CacheFullError } = require("../page-cache.js");

function fakeStorage(seed = {}) {
  const rows = { ...seed };
  return {
    rows,
    async get(key) {
      if (key === null) return { ...rows };
      if (typeof key === "string") return key in rows ? { [key]: rows[key] } : {};
      return Object.fromEntries(key.filter((name) => name in rows).map((name) => [name, rows[name]]));
    },
    async set(values) { Object.assign(rows, values); },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete rows[key];
    },
    async getBytesInUse() {
      return new TextEncoder().encode(JSON.stringify(rows)).byteLength;
    },
  };
}

function page(key, state, access, text = "x") {
  return {
    schema_version: "page-v1",
    page_artifact_key: key,
    state,
    versions: { prompt: "v2" },
    blocks: [{ block_id: "b", trans_text: text }],
    last_accessed_at: access,
    updated_at: access,
  };
}

(async () => {
  const storage = fakeStorage();
  const cache = new PageCache(storage, { budgetBytes: 800, now: () => 10 });
  await cache.putPage(page("active", "running", 1, "a".repeat(150)));
  await cache.putPage(page("old", "complete", 2, "b".repeat(150)));
  await cache.putPage(page("new", "complete", 3, "c".repeat(150)));
  assert.ok(await cache.getPage("active"));
  assert.strictEqual(await cache.getPage("old"), null);
  assert.ok(await cache.getPage("new"));

  await cache.putPage({ ...page("wrong-version", "complete", 4), versions: { prompt: "v1" } });
  assert.strictEqual(await cache.purgeIncompatible({ prompt: "v2" }), 1);
  assert.strictEqual(await cache.getPage("wrong-version"), null);

  await cache.putJob({ job_id: "j1", state: "running", created_at: 1 });
  const rehydrated = await cache.rehydrate();
  assert.strictEqual(rehydrated.jobs[0].state, "queued");

  const tiny = new PageCache(fakeStorage(), { budgetBytes: 20 });
  await assert.rejects(
    tiny.putPage(page("too-large", "running", 1, "x".repeat(100))),
    CacheFullError
  );
  console.log("page-cache.test.js OK");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Chạy test và xác nhận module chưa tồn tại**

Run: `node --test extension/test/page-cache.test.js`

Expected: FAIL với `Cannot find module '../page-cache.js'`.

- [ ] **Step 3: Thêm schema validation và storage adapters**

```javascript
const PAGE_SCHEMA = "page-v1";
const PAGE_PREFIX = "mt:page:";
const JOB_PREFIX = "mt:job:";
const ACTIVE_STATES = new Set(["queued", "running"]);
const TERMINAL_STATES = new Set(["partial", "complete", "failed"]);

class CacheFullError extends Error {}

function pageStorageKey(key) { return PAGE_PREFIX + key; }
function jobStorageKey(key) { return JOB_PREFIX + key; }
function recordBytes(key, value) {
  return new TextEncoder().encode(JSON.stringify({ [key]: value })).byteLength;
}

class PageCache {
  constructor(storage, { budgetBytes = 8 * 1024 * 1024, now = Date.now } = {}) {
    this.storage = storage;
    this.budgetBytes = budgetBytes;
    this.now = now;
  }

  async _all() {
    return this.storage.get(null);
  }

  async getPage(pageKey) {
    const key = pageStorageKey(pageKey);
    const row = (await this.storage.get(key))[key];
    if (!row || row.schema_version !== PAGE_SCHEMA) return null;
    row.last_accessed_at = this.now();
    try {
      await this.storage.set({ [key]: row });
    } catch {
      // Access-time bookkeeping must not turn a valid hit into a render failure.
    }
    return row;
  }

  async findPage(predicate) {
    const rows = await this._all();
    for (const [key, row] of Object.entries(rows)) {
      if (key.startsWith(PAGE_PREFIX) && row.schema_version === PAGE_SCHEMA && predicate(row)) {
        return row;
      }
    }
    return null;
  }

  async purgeIncompatible(versions) {
    const rows = await this._all();
    const expected = JSON.stringify(versions);
    const remove = Object.entries(rows)
      .filter(([key, row]) =>
        key.startsWith(PAGE_PREFIX) &&
        (row.schema_version !== PAGE_SCHEMA || JSON.stringify(row.versions) !== expected)
      )
      .map(([key]) => key);
    if (remove.length) await this.storage.remove(remove);
    return remove.length;
  }
```

- [ ] **Step 4: Thêm eviction đúng thứ tự và retry write đúng một lần**

```javascript
  async _evictFor(key, value) {
    const rows = await this._all();
    const stale = [];
    const complete = [];
    const otherTerminal = [];
    for (const [name, row] of Object.entries(rows)) {
      if (!name.startsWith(PAGE_PREFIX) || name === key) continue;
      if (row.schema_version !== PAGE_SCHEMA) stale.push([name, row]);
      else if (row.state === "complete") complete.push([name, row]);
      else if (row.state === "partial" || row.state === "failed") otherTerminal.push([name, row]);
    }
    const byAccess = (a, b) => (a[1].last_accessed_at || 0) - (b[1].last_accessed_at || 0);
    complete.sort(byAccess);
    otherTerminal.sort(byAccess);
    const candidates = [...stale, ...complete, ...otherTerminal];
    let bytes = await this.storage.getBytesInUse(null);
    const previous = rows[key] ? recordBytes(key, rows[key]) : 0;
    bytes = bytes - previous + recordBytes(key, value);
    while (bytes > this.budgetBytes && candidates.length) {
      const [removeKey, removeValue] = candidates.shift();
      await this.storage.remove(removeKey);
      bytes -= recordBytes(removeKey, removeValue);
    }
    if (bytes > this.budgetBytes) throw new CacheFullError("session cache full");
  }

  async putPage(record) {
    const key = pageStorageKey(record.page_artifact_key);
    const value = {
      ...record,
      schema_version: PAGE_SCHEMA,
      updated_at: this.now(),
      last_accessed_at: record.last_accessed_at || this.now(),
    };
    await this._evictFor(key, value);
    try {
      await this.storage.set({ [key]: value });
    } catch (firstError) {
      await this._evictOneTerminal(key);
      await this._evictFor(key, value);
      try {
        await this.storage.set({ [key]: value });
      } catch {
        throw new CacheFullError(String(firstError));
      }
    }
    return value;
  }

  async _evictOneTerminal(excludeKey) {
    const rows = await this._all();
    const candidates = Object.entries(rows)
      .filter(([key, row]) =>
        key !== excludeKey &&
        key.startsWith(PAGE_PREFIX) &&
        TERMINAL_STATES.has(row.state)
      )
      .sort((a, b) => {
        const tier = (row) => row.schema_version !== PAGE_SCHEMA ? 0 :
          row.state === "complete" ? 1 : 2;
        return tier(a[1]) - tier(b[1]) ||
          (a[1].last_accessed_at || 0) - (b[1].last_accessed_at || 0);
      });
    if (candidates.length) await this.storage.remove(candidates[0][0]);
  }
```

Không đưa `queued/running` vào candidates. `putJob()` dùng cùng budget check; nếu active records đã chiếm hết budget thì từ chối job mới rõ ràng.

- [ ] **Step 5: Thêm ledger rehydrate và status**

```javascript
  async putJob(record) {
    const key = jobStorageKey(record.job_id);
    await this._evictFor(key, record);
    try {
      await this.storage.set({ [key]: record });
    } catch (firstError) {
      await this._evictOneTerminal(key);
      await this._evictFor(key, record);
      try {
        await this.storage.set({ [key]: record });
      } catch {
        throw new CacheFullError(String(firstError));
      }
    }
    return record;
  }

  async removeJob(jobId) {
    await this.storage.remove(jobStorageKey(jobId));
  }

  async removePage(pageKey) {
    await this.storage.remove(pageStorageKey(pageKey));
  }

  async rehydrate() {
    const rows = await this._all();
    const pages = [];
    const jobs = [];
    for (const [key, row] of Object.entries(rows)) {
      if (key.startsWith(PAGE_PREFIX)) {
        if (row.schema_version === PAGE_SCHEMA) {
          const page = row.state === "running" ? { ...row, state: "queued" } : row;
          pages.push(page);
          if (page !== row) await this.storage.set({ [key]: page });
        } else {
          await this.storage.remove(key);
        }
      } else if (key.startsWith(JOB_PREFIX)) {
        const job = row.state === "running" ? { ...row, state: "queued" } : row;
        jobs.push(job);
        if (job !== row) await this.storage.set({ [key]: job });
      }
    }
    return { pages, jobs };
  }

  async status() {
    const rows = await this._all();
    const pages = Object.entries(rows)
      .filter(([key, row]) => key.startsWith(PAGE_PREFIX) && row.schema_version === PAGE_SCHEMA)
      .map(([, row]) => row);
    const jobs = Object.entries(rows)
      .filter(([key]) => key.startsWith(JOB_PREFIX))
      .map(([, row]) => row);
    return {
      background: jobs.filter((row) => ACTIVE_STATES.has(row.state)).length,
      cached: pages.filter((row) => row.state === "complete").length,
      failed: pages.filter((row) => row.state === "failed").length,
    };
  }
}

globalThis.PageCache = PageCache;
globalThis.CacheFullError = CacheFullError;
if (typeof module !== "undefined") {
  module.exports = { PageCache, CacheFullError, PAGE_SCHEMA };
}
```

- [ ] **Step 6: Load helper trong service worker và chạy test**

```javascript
// extension/background.js line 1
if (typeof importScripts === "function") importScripts("page-cache.js");
```

Run: `node --test extension/test/page-cache.test.js extension/test/background.test.js`

Expected: 2/2 PASS; background test VM cung cấp `importScripts: () => {}` cho tới khi Task 6 dùng `PageCache`.

- [ ] **Step 7: Commit**

```powershell
git add extension/page-cache.js extension/test/page-cache.test.js extension/background.js extension/test/background.test.js
git commit -m "feat: persist session page artifacts"
```

---

### Task 6: Background key builder, NDJSON reader và bounded priority scheduler

**Files:**
- Modify: `extension/background.js:1-121`
- Create: `extension/test/background-progressive.test.js`

**Interfaces:**
- Produces: `buildKeys(job, versions) -> Promise<{sourceRevision,analysisKey,ocrKey,overlayKey,pageArtifactKey}>`.
- Produces: `readNdjson(response) -> AsyncGenerator<object>`.
- Produces scheduler functions `enqueueTask(task)`, `pumpTasks()`, `releaseRequest(requestId)`.
- Port input `start_scope`: `{request_id,replaces_request_id,scope,src_lang,dst_lang,jobs[]}`.
- Job descriptor: `{job_id,source_url,crop,natural_width,natural_height,priority,distance}`.

- [ ] **Step 1: Viết test thất bại cho key separation, chunk split và priority**

```javascript
// extension/test/background-progressive.test.js
const assert = require("assert");
const fs = require("fs");
const vm = require("vm");
const { webcrypto } = require("crypto");
const { TextEncoder, TextDecoder } = require("util");

function responseFrom(chunks) {
  return {
    body: {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield new TextEncoder().encode(chunk);
      },
    },
  };
}

const starts = [];
const context = {
  Promise, JSON, Map, Set, URL, TextEncoder, TextDecoder,
  crypto: webcrypto,
  console,
  setTimeout, clearTimeout,
  importScripts: () => {},
  chrome: {
    runtime: {
      onMessage: { addListener() {} },
      onConnect: { addListener() {} },
    },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    storage: { session: {} },
  },
  fetch: async () => ({ ok: true, json: async () => ({}) }),
};
vm.createContext(context);
vm.runInContext(fs.readFileSync("extension/background.js", "utf8"), context);

(async () => {
  const versions = {
    detector: "d1", dedupe: "dd1", prep: "p1",
    recognizers: { ja: "r-ja", es: "r-es" },
    translator_model: "g1", prompt: "pr1", policy: "po1", page_schema: "page-v1",
  };
  const job = {
    source_url: "https://x/page.jpg?token=secret",
    crop: null,
    natural_width: 1000,
    natural_height: 1600,
    src_lang: "ja",
    dst_lang: "vi",
  };
  const vi = await context.buildKeys(job, versions);
  const en = await context.buildKeys({ ...job, dst_lang: "en" }, versions);
  const es = await context.buildKeys({ ...job, src_lang: "es" }, versions);
  assert.strictEqual(vi.analysisKey, en.analysisKey);
  assert.strictEqual(vi.ocrKey, en.ocrKey);
  assert.notStrictEqual(vi.pageArtifactKey, en.pageArtifactKey);
  assert.strictEqual(vi.analysisKey, es.analysisKey);
  assert.notStrictEqual(vi.ocrKey, es.ocrKey);

  const parsed = [];
  for await (const row of context.readNdjson(
    responseFrom(['{"type":"a"}\n{"ty', 'pe":"b"}\n'])
  )) parsed.push(row.type);
  assert.deepStrictEqual(parsed, ["a", "b"]);

  const order = [
    { tier: 2, sequence: 1 },
    { tier: 1, sequence: 2 },
    { tier: 0, sequence: 3 },
  ].sort(context.compareTasks);
  assert.deepStrictEqual(order.map((row) => row.tier), [0, 1, 2]);
  console.log("background-progressive.test.js transport OK");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Chạy test và xác nhận helper chưa có**

Run: `node --test extension/test/background-progressive.test.js`

Expected: FAIL vì `buildKeys`/`readNdjson` chưa được định nghĩa.

- [ ] **Step 3: Thêm canonical hashing bằng Web Crypto**

```javascript
const MAX_OUTSTANDING_PER_REQUEST = 4;
const PRIORITY = Object.freeze({ foreground: 0, background: 1, prewarm: 2 });

function canonicalCrop(crop) {
  if (!crop) return "full";
  const rounded = Object.fromEntries(
    ["left", "top", "right", "bottom"].map((key) => [
      key, Math.round(crop[key] * 1e6) / 1e6,
    ])
  );
  return rounded.left === 0 && rounded.top === 0 &&
    rounded.right === 1 && rounded.bottom === 1 ? "full" : rounded;
}

async function hashValue(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function buildKeys(job, versions) {
  const crop = canonicalCrop(job.crop);
  const sourceUrl = new URL(job.source_url);
  sourceUrl.hash = "";
  const sourceRevision = await hashValue([
    sourceUrl.href,
    job.natural_width,
    job.natural_height,
  ]);
  const analysisKey = await hashValue([
    sourceRevision, crop, versions.detector, versions.dedupe, versions.prep,
  ]);
  const ocrKey = await hashValue([
    analysisKey, job.src_lang, versions.recognizers[job.src_lang],
  ]);
  const overlayKey = await hashValue([
    sourceRevision, crop, ocrKey, job.dst_lang,
    versions.translator_model, versions.prompt, versions.policy,
  ]);
  return {
    sourceRevision,
    analysisKey,
    ocrKey,
    overlayKey,
    pageArtifactKey: await hashValue([overlayKey, versions.page_schema]),
    crop,
  };
}
```

- [ ] **Step 4: Thêm parser chịu được một line bị chia network chunks**

```javascript
async function* readNdjson(response) {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop();
    for (const line of lines) {
      if (line.trim()) yield JSON.parse(line);
    }
  }
  pending += decoder.decode();
  if (pending.trim()) yield JSON.parse(pending);
}
```

Chuẩn hóa JSON helper để Task 7 không dùng lẫn signature cũ `(form,json,timeout)`:

```javascript
async function postJson(url, body, timeout = 60000) {
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      method: "POST",
      body: isForm ? body : JSON.stringify(body),
      headers: isForm ? undefined : { "Content-Type": "application/json" },
      signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}
```

Update legacy callers thành `postJson(url, form)` và `postJson(url, jsonBody, 300000)`.

- [ ] **Step 5: Thay FIFO bằng sort nhỏ, không thêm heap**

```javascript
const taskQueue = [];
let taskSequence = 0;
let activeTasks = 0;

function compareTasks(a, b) {
  return a.tier - b.tier || a.distance - b.distance || a.sequence - b.sequence;
}

function enqueueTask(task) {
  taskQueue.push({ distance: 0, ...task, sequence: ++taskSequence });
  taskQueue.sort(compareTasks);
  pumpTasks();
}

function pumpTasks() {
  while (activeTasks < MAX_CONCURRENT && taskQueue.length) {
    const task = taskQueue.shift();
    if (task.cancelled()) {
      task.done();
      continue;
    }
    activeTasks++;
    Promise.resolve(task.run())
      .catch(task.fail)
      .finally(() => {
        activeTasks--;
        task.done();
        pumpTasks();
      });
  }
}
```

```javascript
function admitRequestJobs(request) {
  while (request.outstanding < MAX_OUTSTANDING_PER_REQUEST && request.pendingJobs.length) {
    const producer = request.pendingJobs.shift();
    request.outstanding++;
    enqueueTask({
      tier: request.connected ? PRIORITY.foreground : PRIORITY.background,
      distance: producer.descriptor.distance || 0,
      cancelled: () => producer.cancelled === true,
      run: () => runProducer(producer),
      fail: (error) => failProducer(producer, error),
      done: () => {
        request.outstanding--;
        admitRequestJobs(request);
      },
    });
  }
}
```

Metadata chờ admit không fetch/upload và không tính active producer.

- [ ] **Step 6: Giữ message API cũ và đăng ký Port listener**

```javascript
const ports = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "translation") return;
  ports.add(port);
  port.onMessage.addListener((message) => {
    if (message.type === "start_scope") {
      void acceptScope(port, message).catch((error) => {
        port.postMessage({
          type: "scope_error",
          request_id: message.request_id,
          code: error instanceof CacheFullError ? "cache_full" : "request_failed",
          error: String(error),
        });
      });
    }
    if (message.type === "cancel_request") releaseRequest(message.request_id);
  });
  port.onDisconnect.addListener(() => disconnectPort(port));
});

function disconnectPort(port) {
  ports.delete(port);
  for (const request of [...requests.values()]) {
    if (request.port === port) releaseRequest(request.requestId);
  }
}
```

`acceptScope`, `releaseRequest`, `disconnectPort` được hoàn thiện ở Task 7. `ocrImage`/`translateTexts` runtime messages cũ vẫn chạy để test compatibility không đỏ giữa hai commit.

- [ ] **Step 7: Chạy transport và regression tests**

Run: `node --test extension/test/background-progressive.test.js extension/test/background.test.js`

Expected: 2/2 PASS.

- [ ] **Step 8: Commit**

```powershell
git add extension/background.js extension/test/background-progressive.test.js
git commit -m "feat: add progressive background transport"
```

---

### Task 7: Background-owned producers, micro-batch, cancellation và rehydrate

**Files:**
- Modify: `extension/background.js`
- Modify: `extension/test/background-progressive.test.js`

**Interfaces:**
- Request state: `{requestId,scope,srcLang,dstLang,port,jobs,pendingJobs,outstanding,connected}`.
- Producer state: `{pageKey,analysisKey,ocrKey,descriptor,consumers,persistUntilDone,state,blocks,pendingTranslations,controller}`.
- Stage maps: `analysisStages: Map<analysisKey,Stage>`, `ocrStages: Map<ocrKey,Stage>`; mỗi Stage có consumer set riêng và chỉ abort khi set rỗng.
- Hot LRU: `hotOcr` tối đa 256 record, `hotTranslations` tối đa 2.048 block.
- Output events: `page_job_accepted`, `progress`, `translation`, `block_error`, `image_done`, `page_status`, `scope_done`.
- Runtime messages: existing `health`, plus `pageStatus` và `prewarmJob`.

- [ ] **Step 1: Mở rộng test harness thành fake Port/storage/server**

```javascript
function fakePort(name = "translation") {
  const sent = [];
  let onMessage;
  let onDisconnect;
  return {
    name,
    sent,
    postMessage(message) { sent.push(structuredClone(message)); },
    onMessage: { addListener(listener) { onMessage = listener; } },
    onDisconnect: { addListener(listener) { onDisconnect = listener; } },
    receive(message) { onMessage(message); },
    disconnect() { onDisconnect(); },
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}
```

Fake fetch phải đếm riêng source fetch, `/ocr-stream`, `/translate-items`; fake storage được giữ ngoài VM để tạo VM thứ hai mô phỏng worker restart.

`createBackgroundApp(storage = fakeStorage())` phải inject `AbortController,FormData,Blob,performance,structuredClone,setTimeout,clearTimeout`, load `page-cache.js` rồi `background.js` vào VM và trả đúng test API:

- `connect()`, `startScope(requestId, scope, job, replacesRequestId)`, `job(jobId, source)`;
- `waitFor(type, port)`, `releaseOcr(pageName)`, `finishAll()`;
- `networkCounts()`, `page(key)`, `job(key)`, `waitForStoredPage(state)`;
- `seedRunningPageAndJob()`, `restartWorker()` dùng lại cùng storage object.

```javascript
async function scenario(name, check) {
  const app = createBackgroundApp();
  try {
    await check(app);
  } catch (error) {
    error.message = name + ": " + error.message;
    throw error;
  }
}
```

- [ ] **Step 2: Viết các assertion end-to-end thất bại trong background test**

```javascript
await scenario("A continues after disconnect and exact return makes zero calls", async (app) => {
  const portA = app.connect();
  portA.receive(app.startScope("rA", "visible", app.job("jA", "https://x/A.jpg")));
  await app.waitFor("page_job_accepted", portA);
  portA.disconnect();
  await app.releaseOcr("A");
  await app.waitForStoredPage("complete");
  const callsAfterA = app.networkCounts();

  const portBack = app.connect();
  portBack.receive(app.startScope("rBack", "visible", app.job("jBack", "https://x/A.jpg")));
  await app.waitFor("scope_done", portBack);
  assert.deepStrictEqual(app.networkCounts(), callsAfterA);
  assert.ok(portBack.sent.some((event) => event.cache_hit === true));
});

await scenario("detached A never renders on B", async (app) => {
  const port = app.connect();
  port.receive(app.startScope("rA", "visible", app.job("jA", "https://x/A.jpg")));
  port.receive(app.startScope("rB", "visible", app.job("jB", "https://x/B.jpg"), "rA"));
  await app.finishAll();
  assert.strictEqual(
    port.sent.some((event) => event.request_id === "rB" && event.job_id === "jA"),
    false
  );
});

await scenario("worker restart requeues persisted running job", async (app) => {
  await app.seedRunningPageAndJob();
  const restarted = app.restartWorker();
  await restarted.ready;
  assert.strictEqual(restarted.job("persisted").state, "queued");
  await restarted.finishAll();
  assert.strictEqual(restarted.page("persisted").state, "complete");
});
```

Thêm cùng file các case sau; mỗi case assert cả event và network/stage counters, không chỉ state cuối:

- foreground trước detached trước prewarm, và tối đa bốn producer/request được admit;
- bấm lại exact key dùng cùng producer, không xóa pending batch, không mất `persistUntilDone` và không tạo duplicate fetch/inference;
- target mới tạo 0 source fetch/analysis/OCR call; đổi recognizer tạo 0 source fetch/detect/prep; đổi trở lại cấu hình cũ tạo 0 inference/cloud call khi artifact còn sống;
- page `partial` replay block đã có ngay và chỉ request ID còn thiếu;
- replacement khác target/recognizer xóa ledger cũ, nhưng exact replacement chuyển ownership sang ledger mới thay vì retire shared producer;
- loaded disconnect abort queued/fetch; stale cloud response có thể vào hot cache nhưng không phát event cho request mới;
- offline chỉ thử một lần tới health success; cache full trả `job_error.code === "cache_full"`;
- một OCR block lỗi, một image lỗi và một translation batch lỗi vẫn giữ block/image/batch hợp lệ còn lại.

- [ ] **Step 3: Khởi tạo cache/rehydrate trước mọi handler**

```javascript
const pageCache = new PageCache(chrome.storage.session);
const requests = new Map();
const producers = new Map();
const analysisStages = new Map();
const ocrStages = new Map();
const hotOcr = new Map();
const hotTranslations = new Map();
const offlineJobs = [];
let serverVersions = null;

async function refreshServerVersions(resume = true) {
  const response = await fetch(`${SERVER}/health`);
  if (!response.ok) throw new Error(`health HTTP ${response.status}`);
  const data = await response.json();
  serverVersions = data.versions;
  await pageCache.purgeIncompatible(serverVersions);
  if (resume) void resumeOfflineJobs();
  return data;
}

const ready = pageCache.rehydrate().then(async ({ pages, jobs }) => {
  try {
    await refreshServerVersions(false);
    const pagesByKey = new Map(
      pages
        .filter((page) => JSON.stringify(page.versions) === JSON.stringify(serverVersions))
        .map((page) => [page.page_artifact_key, page])
    );
    for (const job of jobs) {
      if (job.scope === "visible" && (job.state === "queued" || job.state === "running")) {
        restoreProducer(job, pagesByKey);
      }
    }
    pumpTasks();
  } catch {
    for (const job of jobs) {
      if (job.scope !== "visible") continue;
      offlineJobs.push(restoreOfflineLedger(job));
    }
  }
});

async function health() {
  return refreshServerVersions(true);
}

function restoreOfflineLedger(job) {
  const request = createRequest(null, {
    request_id: job.request_id,
    scope: "visible",
    src_lang: job.src_lang,
    dst_lang: job.dst_lang,
    jobs: [job.descriptor],
  });
  request.connected = false;
  return { request, descriptor: job.descriptor, ledger: job };
}
```

Mọi `acceptScope`, `pageStatus`, `prewarmJob` bắt đầu bằng `await ready`.

- [ ] **Step 4: Persist ledger trước acceptance và register-new-before-release-old**

```javascript
function createRequest(port, message) {
  const request = {
    requestId: message.request_id,
    scope: message.scope,
    srcLang: message.src_lang,
    dstLang: message.dst_lang,
    port,
    jobs: new Map(),
    jobsBySourceCrop: new Map(),
    pendingJobs: [],
    outstanding: 0,
    connected: true,
  };
  for (const row of message.jobs) {
    const descriptor = {
      ...row,
      src_lang: message.src_lang,
      dst_lang: message.dst_lang,
      scope: message.scope,
    };
    request.jobsBySourceCrop.set(
      JSON.stringify([descriptor.source_url, canonicalCrop(descriptor.crop)]),
      descriptor
    );
  }
  return request;
}

async function acceptScope(port, message) {
  await ready;
  const request = createRequest(port, message);
  requests.set(request.requestId, request);
  if (!message.jobs.length) {
    if (message.replaces_request_id) releaseRequest(message.replaces_request_id, request);
    request.port.postMessage({
      type: "scope_done",
      request_id: request.requestId,
      images: 0,
      translated: 0,
      failed: 0,
      cache_hit: false,
    });
    requests.delete(request.requestId);
    return;
  }
  if (!serverVersions) {
    try {
      await health();
    } catch {
      // descriptor loop below persists/queues each job without another retry
    }
  }
  for (const rawDescriptor of message.jobs) {
    const descriptor = {
      ...rawDescriptor,
      src_lang: request.srcLang,
      dst_lang: request.dstLang,
      scope: request.scope,
    };
    const ledger = {
      job_id: descriptor.job_id,
      request_id: request.requestId,
      scope: request.scope,
      src_lang: request.srcLang,
      dst_lang: request.dstLang,
      descriptor,
      state: "queued",
      created_at: Date.now(),
    };
    if (request.scope === "visible") await pageCache.putJob(ledger);
    await attachDescriptor(request, descriptor, ledger);
  }
  if (message.replaces_request_id) releaseRequest(message.replaces_request_id, request);
  admitRequestJobs(request);
  emitStatus();
}
```

`attachDescriptor()` lấy health versions. Nếu server offline và chưa có versions, ledger ở `queued` với `waiting_for_health=true`; không dùng timer retry. Khi versions có, tính keys, seed OCR từ sibling `ocr_key`, persist page descriptor rồi mới phát `page_job_accepted`.

```javascript
async function attachDescriptor(request, descriptor, ledger) {
  if (!serverVersions) {
    if (request.scope === "visible") {
      await pageCache.putJob({ ...ledger, waiting_for_health: true });
    }
    offlineJobs.push({ request, descriptor, ledger });
    return;
  }
  const keys = await buildKeys(descriptor, serverVersions);
  descriptor.page_artifact_key = keys.pageArtifactKey;
  if (request.scope !== "visible") {
    const producer = createProducer(descriptor, keys, {
      page_artifact_key: keys.pageArtifactKey,
      analysis_key: keys.analysisKey,
      ocr_key: keys.ocrKey,
      overlay_key: keys.overlayKey,
      state: "queued",
      ocr_done: false,
      blocks: [],
      persist: false,
    });
    producer.consumers.set(request.requestId, {
      requestId: request.requestId,
      jobId: descriptor.job_id,
      port: request.port,
    });
    request.jobs.set(descriptor.job_id, producer);
    request.pendingJobs.push(producer);
    return;
  }
  const exact = await pageCache.getPage(keys.pageArtifactKey);
  let page = exact;
  if (!page) {
    const analysisSibling = await pageCache.findPage(
      (row) => row.analysis_key === keys.analysisKey
    );
    const sibling = await pageCache.findPage(
      (row) => row.ocr_key === keys.ocrKey && row.blocks.some((block) => block.src_text)
    );
    page = {
      schema_version: serverVersions.page_schema,
      page_artifact_key: keys.pageArtifactKey,
      analysis_key: keys.analysisKey,
      ocr_key: keys.ocrKey,
      overlay_key: keys.overlayKey,
      source_url: descriptor.source_url,
      crop: keys.crop,
      natural_width: descriptor.natural_width,
      natural_height: descriptor.natural_height,
      src_lang: descriptor.src_lang,
      dst_lang: descriptor.dst_lang,
      versions: serverVersions,
      state: "queued",
      analysis_known: Boolean(analysisSibling),
      ocr_done: sibling?.ocr_done === true,
      image_w: sibling?.image_w || null,
      image_h: sibling?.image_h || null,
      blocks: sibling
        ? sibling.blocks.map(({ block_id, bbox, src_text }) => ({
            block_id, bbox, src_text, trans_text: null, state: "ocr_complete",
          }))
        : [],
      created_at: Date.now(),
      updated_at: Date.now(),
      last_accessed_at: Date.now(),
      last_error: null,
    };
    await pageCache.putPage(page);
  }
  const attached = await attachExactPage(request, descriptor, keys, page);
  const producer = attached.producer;
  if (producer) {
    request.jobs.set(descriptor.job_id, producer);
    request.pendingJobs.push(producer);
  }
  request.port.postMessage({
    type: "page_job_accepted",
    request_id: request.requestId,
    job_id: descriptor.job_id,
    page_artifact_key: keys.pageArtifactKey,
    state: attached.cacheHit ? "complete" : producer.state,
  });
  replayPage(request, descriptor.job_id, attached.page, attached.cacheHit);
  if (producer) {
    await pageCache.putJob({
      ...ledger,
      page_artifact_key: keys.pageArtifactKey,
      waiting_for_health: false,
    });
  } else {
    await pageCache.removeJob(descriptor.job_id);
    completeJob(request, descriptor.job_id, attached.page.blocks.length, 0, true);
  }
}
```

Nếu target đổi, sibling cùng `ocr_key` seed toàn bộ OCR nên không mở `/ocr-stream`. Nếu recognizer đổi, `analysis_key` giống nhau nhưng `ocr_key` mới; producer gọi warm stream không file và chỉ cold-retry khi server trả `analysis_missing`.

- [ ] **Step 5: Exact page hit/replay và producer single-flight**

```javascript
async function attachExactPage(request, descriptor, keys, seededPage = null) {
  const cached = await pageCache.getPage(keys.pageArtifactKey) || seededPage;
  if (cached?.state === "complete") {
    return { producer: null, page: cached, cacheHit: true };
  }
  let producer = producers.get(keys.pageArtifactKey);
  if (!producer) {
    producer = createProducer(descriptor, keys, cached);
    producers.set(keys.pageArtifactKey, producer);
  }
  producer.consumers.set(request.requestId, {
    requestId: request.requestId,
    jobId: descriptor.job_id,
    port: request.port,
  });
  if (request.scope === "visible") producer.persistUntilDone = true;
  return { producer, page: producer.page, cacheHit: false };
}
```

`replayPage()` gửi dimensions trước, sau đó mỗi complete block bằng event `translation` có `block_id`, `bbox`, `src_text`, `trans_text`; duplicate replay là hợp lệ vì content upsert theo ID.

```javascript
async function runProducer(producer) {
  producer.state = "running";
  producer.page.state = "running";
  if (producer.page.ocr_done) {
    for (const block of producer.page.blocks) {
      if (!block.trans_text) queueTranslation(producer, block);
    }
    await flushTranslations(producer);
  } else {
    await consumeOcr(producer);
  }
  await finishProducer(producer);
}
```

Khi exact record là `partial/failed`, `attachExactPage()` replay phần có sẵn, đổi state về `queued`, giữ `last_error` làm diagnostic và chỉ chạy stage còn thiếu.

- [ ] **Step 6: Bridge OCR stream, retry `analysis_missing` đúng một lần**

```javascript
function attachStage(stageMap, key, producer) {
  let stage = stageMap.get(key);
  if (!stage) {
    let resolveAnalysis;
    let rejectAnalysis;
    const analysisReady = new Promise((resolve, reject) => {
      resolveAnalysis = resolve;
      rejectAnalysis = reject;
    });
    stage = {
      key,
      consumers: new Map(),
      controller: new AbortController(),
      promise: null,
      analysisReady,
      resolveAnalysis,
      rejectAnalysis,
      owner: null,
      cancelAfterCurrentBlock: false,
    };
    stageMap.set(key, stage);
  }
  stage.consumers.set(producer.pageKey, producer);
  return stage;
}

async function openOcrStream(producer, includeImage) {
  const stage = producer.ocrStage;
  const form = new FormData();
  form.append("analysis_key", producer.analysisKey);
  form.append("ocr_key", producer.ocrKey);
  form.append("src_lang", producer.descriptor.src_lang);
  appendCrop(form, producer.descriptor.crop);
  if (includeImage) {
    const imageResponse = await fetch(producer.descriptor.source_url, {
      signal: stage.controller.signal,
    });
    if (!imageResponse.ok) throw new Error(`fetch image HTTP ${imageResponse.status}`);
    form.append("image", await imageResponse.blob(), "page.png");
  }
  return fetch(`${SERVER}/ocr-stream`, {
    method: "POST",
    body: form,
    signal: stage.controller.signal,
  });
}

async function consumeOcr(producer) {
  producer.ocrStage = attachStage(ocrStages, producer.ocrKey, producer);
  producer.analysisStage = attachStage(
    analysisStages, producer.analysisKey, producer
  );
  const ocrStage = producer.ocrStage;
  if (ocrStage.promise) return ocrStage.promise;
  ocrStage.promise = (async () => {
    const analysisStage = producer.analysisStage;
    let includeImage;
    if (!analysisStage.owner) {
      analysisStage.owner = producer.ocrKey;
      includeImage = !producer.page.analysis_known;
    } else {
      await analysisStage.analysisReady;
      includeImage = false;
    }
    let response = await openOcrStream(producer, includeImage);
    if (response.status === 409 && !producer.retriedAnalysis) {
      producer.retriedAnalysis = true;
      response = await openOcrStream(producer, true);
    }
    if (!response.ok) throw new Error(`ocr-stream HTTP ${response.status}`);
    for await (const event of readNdjson(response)) {
      if (event.type === "analysis_ready") {
        for (const consumer of ocrStage.consumers.values()) {
          applyAnalysisReady(consumer, event);
        }
        resolveAnalysisStage(analysisStage, event);
        if (ocrStage.cancelAfterAnalysis && !ocrStage.consumers.size) {
          ocrStage.controller.abort();
          return;
        }
      }
      if (event.type === "job_error") {
        throw new Error(`${event.stage}:${event.code}`);
      }
      for (const consumer of ocrStage.consumers.values()) {
        if (event.type === "ocr_block") await applyOcrBlock(consumer, event);
        if (event.type === "ocr_block_error") emitBlockError(consumer, event);
        if (event.type === "image_done") await finishOcr(consumer, event);
      }
    }
  })();
  return ocrStage.promise;
}

function resolveAnalysisStage(stage, event) {
  stage.resolveAnalysis(event);
}
```

`resolveAnalysisStage()` resolve một deferred Promise được tạo khi analysis Stage được tạo. Nếu owner stream fail trước `analysis_ready`, reject deferred, xóa owner và cho request kế tiếp cold-retry đúng một lần. Analysis single-flight: recognizer khác chờ Promise rồi gọi warm stream không file. OCR single-flight: exact `ocrKey` dùng cùng Stage promise và fan-out block cho mọi page producer cần nó.

- [ ] **Step 7: Background-owned finite micro-batch và exact ID validation**

```javascript
function lruSet(map, key, value, maxItems) {
  map.delete(key);
  map.set(key, value);
  while (map.size > maxItems) map.delete(map.keys().next().value);
}

async function translationKeyForBatch(producer, blocks, block) {
  const contextHash = await hashValue(
    blocks.map((row) => ({ blockId: row.block_id, srcText: row.src_text }))
  );
  return hashValue([
    producer.ocrKey,
    block.block_id,
    await hashValue(block.src_text),
    contextHash,
    producer.descriptor.dst_lang,
    producer.page.versions.translator_model,
    producer.page.versions.prompt,
    producer.page.versions.policy,
  ]);
}

function queueTranslation(producer, block) {
  if (block.trans_text || producer.pendingTranslations.has(block.block_id)) return;
  producer.pendingTranslations.set(block.block_id, block);
  const first = producer.translationBatches === 0;
  const limit = first ? 3 : 8;
  const delay = first ? 250 : 500;
  if (producer.pendingTranslations.size >= limit) {
    void flushTranslations(producer);
  } else if (!producer.translationTimer) {
    producer.translationTimer = setTimeout(() => void flushTranslations(producer), delay);
  }
}

async function flushTranslations(producer) {
  producer.translationChain = producer.translationChain.then(
    () => flushTranslationBatch(producer)
  );
  return producer.translationChain;
}

async function flushTranslationBatch(producer) {
  clearTimeout(producer.translationTimer);
  producer.translationTimer = null;
  const blocks = [...producer.pendingTranslations.values()];
  producer.pendingTranslations.clear();
  if (!blocks.length) return;
  producer.translationBatches++;
  const keyed = await Promise.all(blocks.map(async (block) => ({
    block,
    key: await translationKeyForBatch(producer, blocks, block),
  })));
  const cached = keyed.map(({ key }) => hotTranslations.get(key));
  if (cached.every(Boolean)) {
    for (const item of cached) await applyTranslation(producer, item);
    return;
  }
  const response = await postJson(`${SERVER}/translate-items`, {
    src_lang: producer.descriptor.src_lang,
    dst_lang: producer.descriptor.dst_lang,
    items: keyed.map(({ block }) => ({ id: block.block_id, text: block.src_text })),
  }, 300000);
  const expected = new Set(keyed.map(({ block }) => block.block_id));
  const actual = new Set(response.items.map((item) => item.id));
  if (actual.size !== response.items.length ||
      actual.size !== expected.size ||
      [...actual].some((id) => !expected.has(id))) {
    throw new Error("translation id set mismatch");
  }
  for (const item of response.items) {
    const key = keyed.find(({ block }) => block.block_id === item.id).key;
    lruSet(hotTranslations, key, item, 2048);
    await applyTranslation(producer, item);
  }
}
```

`applyOcrBlock()` gọi `lruSet(hotOcr, producer.ocrKey, snapshot, 256)`. Cả `applyOcrBlock()` và `applyTranslation()` cập nhật RAM rồi emit cho live consumers ngay. Chỉ producer manual `visible` nối `pageCache.putPage()` vào `producer.persistChain`; `loaded`/prewarm không ghi page cache. Current render không chờ storage; terminal `visible` state chờ `persistChain` settle. Cache write failure đặt `last_error="cache_failed"` nhưng không đổi processing state; current render vẫn nhận event.

Xóa unbounded `ocrCache` cũ. Compatibility `ocrImage` đọc/ghi qua `hotOcr` và `lruSet(..., 256)`; `ocrInFlight` chỉ giữ Promise đang chạy và xóa ở `finally`.

- [ ] **Step 8: Cài cancellation matrix theo scope**

```javascript
function releaseStageConsumer(stageMap, stageKey, pageKey) {
  const stage = stageMap.get(stageKey);
  if (!stage) return;
  stage.consumers.delete(pageKey);
  if (!stage.consumers.size) {
    stage.cancelAfterCurrentBlock = true;
    stage.controller.abort();
    stageMap.delete(stageKey);
  }
}

function releaseOcrConsumer(producer) {
  const stage = ocrStages.get(producer.ocrKey);
  if (!stage) return;
  stage.consumers.delete(producer.pageKey);
  if (stage.consumers.size) return;
  const analysis = analysisStages.get(producer.analysisKey);
  if (analysis?.owner === producer.ocrKey && analysis.consumers.size) {
    stage.cancelAfterAnalysis = true;
    return;
  }
  stage.cancelAfterCurrentBlock = true;
  stage.controller.abort();
  ocrStages.delete(producer.ocrKey);
}

function releaseRequest(requestId, replacement = null) {
  const request = requests.get(requestId);
  if (!request) return;
  request.connected = false;
  for (const producer of request.jobs.values()) {
    const releasedConsumer = producer.consumers.get(requestId);
    producer.consumers.delete(requestId);
    const sourceCrop = JSON.stringify([
      producer.descriptor.source_url,
      canonicalCrop(producer.descriptor.crop),
    ]);
    const replacementDescriptor = replacement?.jobsBySourceCrop.get(sourceCrop);
    const sameSourceReplacement = Boolean(replacementDescriptor);
    const exactReplacement =
      replacementDescriptor?.page_artifact_key === producer.pageKey;
    if (exactReplacement) {
      if (releasedConsumer) void pageCache.removeJob(releasedConsumer.jobId);
      continue;
    }
    if (request.scope === "visible" && !sameSourceReplacement) continue;
    if (sameSourceReplacement) {
      if (releasedConsumer) void pageCache.removeJob(releasedConsumer.jobId);
      if (producer.consumers.size) continue;
      producer.persistUntilDone = false;
      clearTimeout(producer.translationTimer);
      producer.translationTimer = null;
      producer.pendingTranslations.clear();
      producer.retireReason = "replaced";
    }
    if (!producer.consumers.size && !producer.persistUntilDone) {
      producer.cancelAfterCurrentBlock = true;
      removeQueuedTasks(producer);
      releaseStageConsumer(analysisStages, producer.analysisKey, producer.pageKey);
      releaseOcrConsumer(producer);
      void retireProducer(producer);
    }
  }
  for (let index = offlineJobs.length - 1; index >= 0; index--) {
    const row = offlineJobs[index];
    if (row.request.requestId !== requestId) continue;
    const sourceCrop = JSON.stringify([
      row.descriptor.source_url,
      canonicalCrop(row.descriptor.crop),
    ]);
    const replaced = replacement?.jobsBySourceCrop.has(sourceCrop);
    if (request.scope !== "visible" || replaced) {
      offlineJobs.splice(index, 1);
      void pageCache.removeJob(row.descriptor.job_id);
    }
  }
  requests.delete(requestId);
}
```

`retireProducer()` idempotent và chỉ áp dụng khi producer không còn consumer. Với manual page có `persist=true`, nó chờ `persistChain`, persist page thành `partial` nếu đã có analysis/OCR/translation hữu ích, nếu chưa có artifact thì gọi `removePage(pageKey)`, rồi xóa ledger. Với `loaded`/prewarm, nó chỉ dọn RAM vì không có page/ledger trong session storage. Cả hai nhánh cuối cùng xóa producer maps. Loop OCR kiểm `cancelAfterCurrentBlock` trước block kế; task chưa chạy được `removeQueuedTasks()` đưa thẳng qua cùng finalizer.

Không abort Gemini batch đã gửi. Response hợp lệ chỉ vào bounded hot cache sau khi producer đã retire; `emitToConsumers()` không có consumer stale và page cũ không bị đổi lại thành `running/complete`. Với source mới, manual visible cũ giữ `persistUntilDone` và queued task được đổi tier từ foreground sang background FIFO. Với same source nhưng target/recognizer mới, old unsent translation dừng; exact `ocrKey`/analysis stage vẫn sống vì request mới đã được attach trước khi old consumer được release. Với exact replacement, producer tiếp tục nguyên trạng và chỉ ledger/request ownership cũ được bỏ.

- [ ] **Step 9: Finalize state/status và requeue offline**

Khi OCR done, flush pending translation. Page là:

- `complete` khi mọi OCR text block có translation và không còn block lỗi;
- `partial` khi có artifact hợp lệ nhưng còn block/batch lỗi;
- `failed` khi chưa có analysis/OCR/translation hữu ích;
- `queued` khi server offline hoặc worker vừa rehydrate;
- `running` chỉ trong active producer.

`pageStatus` trả `pageCache.status()`. Health success gọi `resumeOfflineJobs()` một lần; không có interval/polling.

```javascript
async function resumeOfflineJobs() {
  const queued = offlineJobs.splice(0);
  for (const row of queued) {
    if (!row.request.connected && row.request.scope !== "visible") continue;
    await attachDescriptor(row.request, row.descriptor, {
      ...row.ledger,
      waiting_for_health: false,
    });
    admitRequestJobs(row.request);
  }
}
```

Khi một job đạt terminal state hoặc exact cache hit hoàn tất replay, gọi `pageCache.removeJob(jobId)`; chỉ page artifact còn lại. `scope_done.cache_hit=true` chỉ khi mọi job của scope hoàn tất bằng exact page hit.

`finishProducer()` emit `image_done` cho từng live consumer sau translation flush với `translated` và `failed`; sau khi mọi job của request done mới emit một `scope_done`.

Sau terminal/replay, gỡ page producer khỏi `producers` và release nó khỏi `analysisStages`/`ocrStages`; artifact đã hoàn thành vẫn nằm trong server cache, hot LRU hoặc page record.

`prewarmJob` tạo stage consumer không có page record, tier `PRIORITY.prewarm`, và release ngay sau OCR done/error:

```javascript
if (msg.type === "prewarmJob") {
  ready
    .then(() => enqueuePrewarm({ ...msg, tier: PRIORITY.prewarm }))
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: String(error) }));
  return true;
}
if (msg.type === "pageStatus") {
  ready.then(() => pageCache.status()).then(sendResponse);
  return true;
}
```

Fetch/URL hết hạn chuyển page sang `partial` nếu đã có block, ngược lại `failed`; lần bấm exact source tiếp theo đổi terminal page về `queued` và thử lại. Server-offline error chỉ đặt `waiting_for_health`, không schedule timer. Worker chết giữa Gemini có thể khiến batch gọi lại sau rehydrate; exact ID/upsert giữ correctness và test chỉ cho phép tối đa một duplicate call.

- [ ] **Step 10: Chạy background suite**

Run: `node --test extension/test/page-cache.test.js extension/test/background.test.js extension/test/background-progressive.test.js`

Expected: 3/3 PASS; assertions A→B, zero-call, rehydrate, priority, offline, target reuse và loaded cancellation đều xanh.

- [ ] **Step 11: Commit**

```powershell
git add extension/background.js extension/test/background-progressive.test.js
git commit -m "feat: own progressive page jobs in background"
```

---

### Task 8: Content Port subscriber và idempotent overlay upsert

**Files:**
- Modify: `extension/srcset.js:31-112`
- Modify: `extension/content.js:1-248`
- Modify: `extension/test/srcset.test.js`
- Modify: `extension/test/content.test.js`
- Create: `extension/test/content-progressive.test.js`

**Interfaces:**
- `selectCandidates(images, scope, viewportWidth, viewportHeight, minSize) -> job[]`; không nhận `translated WeakMap`.
- Job metadata thêm `natural_width`, `natural_height`, `distance`, `source_signature`.
- Content gửi đúng một `start_scope` Port message cho mỗi lần bấm.
- `translation` event phải có `request_id,job_id,block_id,bbox,src_text,trans_text,image_w,image_h`.
- Overlay map: `img -> {container,source,scope,imageW,imageH,blocks: Map<blockId,{element,bbox}>}`.

- [ ] **Step 1: Sửa srcset tests trước để key completion không còn nằm ở DOM**

```javascript
const jobs = selectCandidates(
  [doneImage],
  "visible",
  800,
  600,
  400
);
assert.strictEqual(jobs.length, 1);
assert.strictEqual(jobs[0].natural_width, doneImage.naturalWidth);
assert.strictEqual(jobs[0].natural_height, doneImage.naturalHeight);
assert.strictEqual(typeof jobs[0].distance, "number");
assert.strictEqual(typeof jobs[0].source_signature, "string");
```

Xóa assertion cũ cho rằng `translated.get(img) === source|srcLang|crop` làm candidate biến mất. Exact completion nay do background/page artifact quyết định.

- [ ] **Step 2: Chạy srcset test và xác nhận signature cũ làm test fail**

Run: `node --test extension/test/srcset.test.js`

Expected: FAIL vì positional arguments chưa đổi.

- [ ] **Step 3: Trả candidate metadata và viewport distance**

```javascript
function viewportDistance(img, viewportWidth, viewportHeight) {
  const rect = img.getBoundingClientRect();
  const dx = rect.right < 0 ? -rect.right : rect.left > viewportWidth ? rect.left - viewportWidth : 0;
  const dy = rect.bottom < 0 ? -rect.bottom : rect.top > viewportHeight ? rect.top - viewportHeight : 0;
  return Math.hypot(dx, dy);
}

function sourceSignature(img) {
  const picture = img.parentElement?.tagName === "PICTURE" ? img.parentElement : null;
  const elements = picture?.querySelectorAll
    ? [...picture.querySelectorAll("source"), img]
    : [img];
  return JSON.stringify(elements.map((element) => [
    element.getAttribute?.("src") || "",
    element.getAttribute?.("srcset") || "",
    element.getAttribute?.("sizes") || "",
    element.getAttribute?.("media") || "",
    element.getAttribute?.("type") || "",
  ]));
}

function selectCandidates(images, scope, viewportWidth, viewportHeight, minSize = 400) {
  if (scope !== "loaded" && scope !== "visible") {
    throw new Error(`scope không hỗ trợ: ${scope}`);
  }
  const jobs = [];
  for (const img of images) {
    if (!img.complete || !eligible(img, minSize)) continue;
    if (scope === "visible" && !isViewportVisible(img, viewportWidth, viewportHeight)) continue;
    jobs.push({
      img,
      source: sourceForScope(img, scope),
      crop: scope === "visible" ? viewportCrop(img, viewportWidth, viewportHeight) : null,
      natural_width: img.naturalWidth,
      natural_height: img.naturalHeight,
      distance: viewportDistance(img, viewportWidth, viewportHeight),
      source_signature: sourceSignature(img),
    });
  }
  return jobs;
}
```

Export `viewportDistance` và `sourceSignature`; bỏ `jobKey` nếu không còn caller sau khi content chuyển xong.

- [ ] **Step 4: Viết content progressive test thất bại với fake duplex Port**

```javascript
// extension/test/content-progressive.test.js
const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

function fakePort() {
  const sent = [];
  let listener;
  let lastEmitted = null;
  return {
    name: "translation",
    sent,
    postMessage(message) { sent.push({ ...message }); },
    onMessage: { addListener(fn) { listener = fn; } },
    onDisconnect: { addListener() {} },
    emit(message) { lastEmitted = message; listener(message); },
    lastEmitted() { return lastEmitted; },
  };
}

function createContentVm(port) {
  let nextId = 0;
  let rect = { left: 0, top: 0, right: 500, bottom: 800, width: 500, height: 800 };
  const image = {
    src: "https://x/A.jpg",
    currentSrc: "",
    complete: true,
    naturalWidth: 1000,
    naturalHeight: 1600,
    isConnected: true,
    baseURI: "https://x/",
    parentElement: null,
    getAttribute: () => "",
    getBoundingClientRect: () => rect,
    getClientRects: () => [rect],
  };
  const rendered = [];
  let intersectionObservers = 0;
  const context = {
    Promise, Map, WeakMap, Set, URL, console,
    crypto: { randomUUID: () => "id-" + ++nextId },
    queueMicrotask,
    performance,
    innerWidth: 800,
    innerHeight: 600,
    scrollX: 0,
    scrollY: 0,
    requestAnimationFrame: (callback) => (callback(), 1),
    document: {
      body: { appendChild: (element) => rendered.push(element) },
      documentElement: {},
      querySelectorAll: () => [image],
      createElement: () => ({
        style: {},
        children: [],
        removed: false,
        appendChild(child) { this.children.push(child); },
        remove() { this.removed = true; },
      }),
    },
    window: { addEventListener() {} },
    MutationObserver: class { observe() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class {
      constructor() { intersectionObservers++; }
      observe() {}
      disconnect() {}
    },
    chrome: {
      storage: {
        local: { get: async () => ({ srcLang: "ja", dstLang: "vi" }) },
        onChanged: { addListener() {} },
      },
      runtime: {
        connect: () => port,
        sendMessage: async () => ({ ok: true }),
        onMessage: { addListener() {} },
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync("extension/srcset.js", "utf8"), context);
  vm.runInContext(fs.readFileSync("extension/content.js", "utf8"), context);
  return {
    context,
    port,
    lastTranslation: () => port.lastEmitted(),
    liveOverlays: () => rendered.filter((element) => !element.removed),
    liveBubbles: () => rendered.filter((element) => !element.removed).flatMap((element) => element.children),
    moveOffscreen: () => {
      rect = { left: 900, top: 0, right: 1400, bottom: 800, width: 500, height: 800 };
    },
    swapSource: (source) => { image.src = source; },
    intersectionObserverCount: () => intersectionObservers,
  };
}

(async () => {
  const app = createContentVm(fakePort());
  const pending = app.context.translatePage("visible");
  const start = app.port.sent.find((message) => message.type === "start_scope");
  const job = start.jobs[0];

  app.port.emit({
    type: "translation",
    request_id: start.request_id,
    job_id: job.job_id,
    block_id: "b1",
    bbox: [1, 2, 30, 40],
    src_text: "hola",
    trans_text: "xin chào",
    image_w: 1000,
    image_h: 1600,
  });
  app.port.emit({ ...app.lastTranslation(), trans_text: "xin chào mới" });
  assert.strictEqual(app.liveBubbles().length, 1);
  assert.strictEqual(app.liveBubbles()[0].textContent, "xin chào mới");

  app.moveOffscreen();
  app.context.repositionOverlays();
  assert.strictEqual(app.liveOverlays().length, 1);
  assert.strictEqual(app.intersectionObserverCount(), 0);

  app.swapSource("https://x/B.jpg");
  app.context.pruneOverlays();
  assert.strictEqual(app.liveOverlays().length, 0);

  app.port.emit({
    type: "scope_done",
    request_id: start.request_id,
    images: 1,
    translated: 1,
    failed: 0,
  });
  assert.strictEqual((await pending).blocks, 1);
  console.log("content-progressive.test.js OK");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

`createContentVm()` dùng fake DOM hiện có từ `content.test.js`, bổ sung `crypto.randomUUID`, `chrome.runtime.connect` và lưu callbacks observer. Không thêm shared test-helper file.

Trong `content.test.js`, giữ nguyên ba regression intent bằng Port events: zero-job request supersede request cũ; chỉ newest request được upsert/complete; prewarm chọn ảnh có visible area lớn nhất và không tạo translation/page record.

- [ ] **Step 5: Thay WeakMap completion/token bằng request/job bindings**

```javascript
const imageRequests = new WeakMap();
const jobBindings = new Map();
const pendingScopes = new Map();
const activeScopeMessages = new Map();
let currentRequestId = null;
let port = null;

function translationPort() {
  if (port) return port;
  port = chrome.runtime.connect({ name: "translation" });
  port.onMessage.addListener(handleEvent);
  port.onDisconnect.addListener(() => {
    port = null;
    const message = activeScopeMessages.get(currentRequestId);
    if (message && pendingScopes.has(currentRequestId)) {
      queueMicrotask(() => translationPort().postMessage({
        ...message,
        replaces_request_id: null,
      }));
    }
  });
  return port;
}

function snapshotJobs(scope, requestId, requestSrcLang, requestDstLang) {
  const images = [...document.querySelectorAll("img")];
  const candidates = selectCandidates(images, scope, innerWidth, innerHeight, MIN_SIZE);
  for (const img of images) {
    if (scope === "loaded" || isViewportVisible(img, innerWidth, innerHeight)) {
      imageRequests.set(img, requestId);
      const overlay = overlays.get(img);
      if (overlay && (
        overlay.srcLang !== requestSrcLang ||
        overlay.dstLang !== requestDstLang ||
        sourceSignature(img) !== overlay.sourceSignature
      )) removeOverlay(img);
    }
  }
  return candidates.map((candidate) => {
    const jobId = crypto.randomUUID();
    const cropSignature = JSON.stringify(candidate.crop || "full");
    const overlay = overlays.get(candidate.img);
    if (overlay && overlay.cropSignature !== cropSignature) removeOverlay(candidate.img);
    jobBindings.set(jobId, {
      img: candidate.img,
      requestId,
      source: candidate.source,
      sourceSignature: candidate.source_signature,
      cropSignature,
      scope,
      srcLang: requestSrcLang,
      dstLang: requestDstLang,
    });
    return {
      job_id: jobId,
      source_url: candidate.source,
      crop: candidate.crop,
      natural_width: candidate.natural_width,
      natural_height: candidate.natural_height,
      distance: candidate.distance,
      priority: isViewportVisible(candidate.img, innerWidth, innerHeight) ? 0 : 1,
    };
  });
}
```

- [ ] **Step 6: Gửi atomic `start_scope` kể cả zero-job**

```javascript
function translatePage(scope, requestedSrcLang = srcLang, requestedDstLang = dstLang) {
  const requestId = crypto.randomUUID();
  const replacesRequestId = currentRequestId;
  currentRequestId = requestId;
  const requestSrcLang = requestedSrcLang;
  const requestDstLang = requestedDstLang;
  srcLang = requestSrcLang;
  dstLang = requestDstLang;
  const jobs = snapshotJobs(scope, requestId, requestSrcLang, requestDstLang);
  const done = new Promise((resolve) => {
    pendingScopes.set(requestId, {
      resolve,
      srcLang: requestSrcLang,
      dstLang: requestDstLang,
      startedAt: performance.now(),
      firstOverlayMs: null,
    });
  });
  const message = {
    type: "start_scope",
    request_id: requestId,
    replaces_request_id: replacesRequestId,
    scope,
    src_lang: requestSrcLang,
    dst_lang: requestDstLang,
    jobs,
  };
  activeScopeMessages.set(requestId, message);
  translationPort().postMessage(message);
  return done;
}
```

Runtime message phải chuyển language snapshot từ popup, không đọc storage trễ:

```javascript
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "translatePage") {
    translatePage(msg.scope, msg.srcLang, msg.dstLang).then(sendResponse);
    return true;
  }
  if (msg.type === "prewarmPage") {
    prewarmPage(msg.srcLang);
    sendResponse({ ok: true });
  }
});
```

Background phải nhận zero-job, release old request sau khi đăng ký request mới, rồi trả `scope_done`; đây là regression guard thay cho object token cũ.

- [ ] **Step 7: Cài bốn stale guards trước mọi DOM write**

```javascript
function validBinding(event) {
  const binding = jobBindings.get(event.job_id);
  if (!binding || binding.requestId !== event.request_id) return null;
  if (imageRequests.get(binding.img) !== event.request_id) return null;
  if (!binding.img.isConnected || !isCurrentSource(binding.img, binding.source, binding.scope)) return null;
  if (sourceSignature(binding.img) !== binding.sourceSignature) return null;
  if (binding.srcLang !== srcLang || binding.dstLang !== dstLang) return null;
  return binding;
}

function handleEvent(event) {
  if (event.type === "translation") {
    const binding = validBinding(event);
    if (binding) upsertOverlayBlock(binding.img, binding, event);
    return;
  }
  if (event.type === "block_error") return;
  if (event.type === "image_done") {
    const binding = validBinding(event);
    if (binding && event.translated === 0) removeOverlay(binding.img);
    return;
  }
  if (event.type === "scope_error") {
    const pending = pendingScopes.get(event.request_id);
    if (!pending) return;
    pendingScopes.delete(event.request_id);
    activeScopeMessages.delete(event.request_id);
    pending.resolve({ ok: false, error: event.code || event.error });
    return;
  }
  if (event.type === "scope_done") {
    const pending = pendingScopes.get(event.request_id);
    if (!pending) return;
    pendingScopes.delete(event.request_id);
    activeScopeMessages.delete(event.request_id);
    for (const [jobId, binding] of jobBindings) {
      if (binding.requestId === event.request_id) jobBindings.delete(jobId);
    }
    pending.resolve({
      ok: true,
      images: event.images,
      blocks: event.translated,
      failed: event.failed,
      cacheHit: event.cache_hit === true,
      firstOverlayMs: pending.firstOverlayMs,
    });
  }
}
```

- [ ] **Step 8: Upsert đúng một bubble per `blockId`**

```javascript
function ensureOverlay(img, binding, event) {
  let overlay = overlays.get(img);
  if (overlay && overlay.requestId !== binding.requestId) {
    const sameConfig = overlay.source === binding.source &&
      overlay.sourceSignature === binding.sourceSignature &&
      overlay.cropSignature === binding.cropSignature &&
      overlay.srcLang === binding.srcLang &&
      overlay.dstLang === binding.dstLang;
    if (sameConfig) {
      overlay.requestId = binding.requestId;
    } else {
      removeOverlay(img);
      overlay = null;
    }
  }
  if (overlay) return overlay;
  const container = document.createElement("div");
  container.className = "mt-overlay";
  if (!enabled) container.style.display = "none";
  document.body.appendChild(container);
  overlay = {
    container,
    source: binding.source,
    sourceSignature: binding.sourceSignature,
    cropSignature: binding.cropSignature,
    scope: binding.scope,
    requestId: binding.requestId,
    srcLang: binding.srcLang,
    dstLang: binding.dstLang,
    imageW: event.image_w,
    imageH: event.image_h,
    blocks: new Map(),
    resizeObserver: new ResizeObserver(() => position(img)),
  };
  overlays.set(img, overlay);
  overlay.resizeObserver.observe(img);
  return overlay;
}

function upsertOverlayBlock(img, binding, event) {
  const overlay = ensureOverlay(img, binding, event);
  let block = overlay.blocks.get(event.block_id);
  if (!block) {
    const element = document.createElement("div");
    element.className = "mt-bubble";
    overlay.container.appendChild(element);
    block = { element, bbox: event.bbox };
    overlay.blocks.set(event.block_id, block);
  }
  block.bbox = event.bbox;
  block.element.textContent = event.trans_text;
  position(img);
  const pending = pendingScopes.get(binding.requestId);
  if (pending && pending.firstOverlayMs == null) {
    pending.firstOverlayMs = Math.round(performance.now() - pending.startedAt);
    translationPort().postMessage({
      type: "render_metric",
      request_id: binding.requestId,
      first_overlay_ms: pending.firstOverlayMs,
    });
  }
}
```

`position()` iterate `overlay.blocks.values()` thay cho array index. Không tạo `IntersectionObserver`; rời viewport không gọi `removeOverlay()`.

- [ ] **Step 9: Prune chỉ source-change/disconnect và chuyển prewarm sang background tier thấp**

```javascript
function pruneOverlays() {
  for (const [img, overlay] of overlays) {
    if (!img.isConnected ||
        sourceSignature(img) !== overlay.sourceSignature ||
        !isCurrentSource(img, overlay.source, overlay.scope)) {
      removeOverlay(img);
    }
  }
}

async function prewarmPage(requestSrcLang) {
  const jobs = selectCandidates(
    document.querySelectorAll("img"), "visible", innerWidth, innerHeight, MIN_SIZE
  );
  const selected = jobs.sort((a, b) => a.distance - b.distance)[0];
  if (!selected) return;
  await chrome.runtime.sendMessage({
    type: "prewarmJob",
    source_url: selected.source,
    crop: selected.crop,
    natural_width: selected.natural_width,
    natural_height: selected.natural_height,
    src_lang: requestSrcLang,
  });
}
```

- [ ] **Step 10: Chạy content/srcset suites**

Run: `node --test extension/test/srcset.test.js extension/test/content.test.js extension/test/content-progressive.test.js`

Expected: 3/3 PASS; progressive event xuất hiện trước `scope_done`, duplicate block không tạo node, stale/source-change/offscreen đều đúng.

- [ ] **Step 11: Commit**

```powershell
git add extension/srcset.js extension/content.js extension/test/srcset.test.js extension/test/content.test.js extension/test/content-progressive.test.js
git commit -m "feat: render progressive translations by block"
```

---

### Task 9: Popup status cho background/cache/error và exact hit

**Files:**
- Modify: `extension/popup.html`
- Modify: `extension/popup.js:1-70`
- Modify: `extension/test/popup.test.js`

**Interfaces:**
- Consumes runtime message `pageStatus -> {background,cached,failed}`.
- Content callback giữ `{ok,images,blocks,failed,cacheHit}`.
- User copy: `Đang dịch nền: n · Đã cache: n · Lỗi: n`; exact hit: `Khôi phục từ cache`.
- Popup không khóa hai nút tới `scope_done`; action token chỉ cho callback mới nhất sửa `#result`.

- [ ] **Step 1: Viết popup assertions thất bại**

```javascript
const ready = popup({
  pageStatus: { background: 2, cached: 8, failed: 1 },
});
ready.settings.resolve({ srcLang: "ja", dstLang: "vi" });
ready.health.resolve({ ok: true, device: "cpu" });
await flush();
assert.strictEqual(
  ready.elements.cacheStatus.textContent,
  "Đang dịch nền: 2 · Đã cache: 8 · Lỗi: 1"
);

ready.elements.translateVisible.onclick();
ready.elements.translateVisible.onclick();
ready.releaseTabs();
assert.strictEqual(
  ready.sent.filter((row) => row.message.type === "translatePage").length,
  2
);
ready.replyTranslateAt(0, { ok: true, images: 1, blocks: 1 });
assert.strictEqual(ready.elements.result.textContent, "đang dịch…");
ready.replyTranslateAt(1, {
  ok: true, images: 1, blocks: 4, failed: 0, cacheHit: true,
});
assert.strictEqual(ready.elements.result.textContent, "Khôi phục từ cache");
```

Fake `runtime.sendMessage` phân biệt `health` và `pageStatus`; fake `tabs.sendMessage` giữ callback để test trả response.

```javascript
const translateCallbacks = [];
const runtime = {
  sendMessage: (message) => {
    if (message.type === "health") return health.promise;
    if (message.type === "pageStatus") return Promise.resolve(pageStatus);
    return Promise.resolve();
  },
};

// trong tabs.sendMessage fake
sendMessage: (id, message, done) => {
  sent.push({ id, message: { ...message } });
  if (message.type === "translatePage") translateCallbacks.push(done);
  else done();
},

// trong object popup() trả về
replyTranslate: (response) => translateCallbacks.at(-1)(response),
replyTranslateAt: (index, response) => translateCallbacks[index](response),
```

- [ ] **Step 2: Chạy test và xác nhận cacheStatus/exact copy chưa có**

Run: `node --test extension/test/popup.test.js`

Expected: FAIL ở text assertions mới.

- [ ] **Step 3: Thêm đúng một dòng status, không thêm dashboard**

```html
<div id="cacheStatus">Đang dịch nền: 0 · Đã cache: 0 · Lỗi: 0</div>
```

Giữ `#result` và `#status`; thêm cùng font-size 12 px.

- [ ] **Step 4: Load status khi popup mở và refresh sau action**

```javascript
async function refreshPageStatus() {
  const state = await chrome.runtime.sendMessage({ type: "pageStatus" });
  const value = state || { background: 0, cached: 0, failed: 0 };
  $("cacheStatus").textContent =
    `Đang dịch nền: ${value.background} · Đã cache: ${value.cached} · Lỗi: ${value.failed}`;
}

refreshPageStatus();
```

Thay `setActionsDisabled()` bằng latest-action guard:

```javascript
let actionSequence = 0;

function translate(scope) {
  const action = ++actionSequence;
  $("result").textContent = "đang dịch…";
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, {
      type: "translatePage",
      scope,
      srcLang: $("srcLang").value,
      dstLang: $("dstLang").value,
    }, (res) => {
      if (action !== actionSequence) return;
      if (chrome.runtime.lastError) {
        $("result").textContent = "không kết nối được trang — F5 trang rồi thử lại";
        return;
      }
if (res && res.ok && res.cacheHit) {
  $("result").textContent = "Khôi phục từ cache";
} else {
  $("result").textContent =
    res && res.ok
      ? `xong: ${res.images} ảnh, ${res.blocks} thoại, ${res.failed || 0} lỗi`
      : `lỗi: ${res ? res.error : "?"}`;
}
void refreshPageStatus();
    });
  });
}
```

- [ ] **Step 5: Chạy popup và toàn extension unit tests**

Run: `node --test extension/test/background.test.js extension/test/background-progressive.test.js extension/test/page-cache.test.js extension/test/srcset.test.js extension/test/content.test.js extension/test/content-progressive.test.js extension/test/popup.test.js`

Expected: 7/7 PASS.

- [ ] **Step 6: Commit**

```powershell
git add extension/popup.html extension/popup.js extension/test/popup.test.js
git commit -m "feat: show session translation status"
```

---

### Task 10: Cross-layer acceptance, metrics và workflow handoff

**Files:**
- Modify: `extension/test/fixture.html`
- Create: `extension/test/progressive-integration.test.js`
- Modify: `extension/background.js`
- Modify: `extension/content.js`
- Modify: `work-flow.md`
- Create: `docs/superpowers/worklogs/2026-07-30-progressive-translation-verification.md`

**Interfaces:**
- `scope_done.metrics`: `queue_wait_ms,fetch_ms,analysis_ms,first_ocr_ms,first_translation_ms,total_ms`.
- Content gửi `first_overlay_ms` khi bubble đầu tiên được upsert; background merge vào sample của request.
- Runtime dev message `benchmarkSummary` trả p50/p95 cho `first_overlay_ms`, `first_translation_ms`, `total_ms` từ tối đa 100 sample RAM, cùng bounded counters cho translation calls/429/stale work/cancel latency; không thêm UI.

- [ ] **Step 1: Viết cross-layer test trước**

`progressive-integration.test.js` chạy background VM và content VM với hai đầu fake Port nối trực tiếp. Nó dùng shared fake `chrome.storage.session` và fake server NDJSON, rồi assert:

```javascript
const { reader, server } = createIntegration();

await reader.clickVisible();
reader.navigate("B");
await server.finishPage("A");
assert.strictEqual(reader.textFor("B"), "");

await reader.clickVisible();
await server.finishPage("B");
reader.navigate("A");
const before = server.counts();
await reader.clickVisible();
assert.deepStrictEqual(server.counts(), before);
assert.strictEqual(reader.textFor("A"), "A translated");

reader.navigate("A", { cropTop: 0.2 });
await reader.clickVisible();
assert.ok(server.counts().ocrStream > before.ocrStream);
```

`createIntegration()` load production `page-cache.js/background.js` vào VM thứ nhất và `srcset.js/content.js` vào VM thứ hai. Hai `postMessage()` gọi listener đầu kia bằng `queueMicrotask`; `reader.navigate(source, options)` chỉ đổi fake image `src`/rect; `server.finishPage(name)` release deferred NDJSON chunks. Không gọi trực tiếp production helper để đi tắt Port protocol.

Case cuối khóa exact-crop rule: cùng source nhưng crop khác phải miss.

Trong cùng harness thêm các case bắt buộc sau:

- scope `loaded` có ảnh gần và xa: translation ảnh gần đến trước, nhưng cả hai đi qua cùng Port/event path;
- hai lần bấm liên tiếp khi source fetch, OCR và translation đang được defer: chỉ request mới được render;
- Port disconnect rồi worker VM restart giữa manual job: persisted block replay idempotent và job tiếp tục;
- inject riêng một block OCR lỗi, một image fetch lỗi và một translation batch lỗi: artifact hợp lệ còn lại vẫn render/cache, scope báo đúng `failed`;
- chạy cả `visible` crop và `loaded` full image; đóng/mở lại popup không làm dừng job và status đọc lại từ background.

- [ ] **Step 2: Chạy integration test và xác nhận chưa nối được hai layer**

Run: `node --test extension/test/progressive-integration.test.js`

Expected: FAIL cho tới khi fake Port và production protocol khớp.

- [ ] **Step 3: Thêm monotonic metrics mà không ảnh hưởng cache key**

```javascript
function mark(producer, name) {
  producer.timings[name] ??= performance.now();
}

function producerMetrics(producer) {
  const start = producer.timings.accepted;
  const elapsed = (name) =>
    producer.timings[name] == null ? null : Math.round(producer.timings[name] - start);
  return {
    queue_wait_ms: elapsed("started"),
    fetch_ms: producer.durations.fetch_ms || 0,
    analysis_ms: producer.durations.analysis_ms || 0,
    first_ocr_ms: elapsed("first_ocr"),
    first_translation_ms: elapsed("first_translation"),
    total_ms: Math.round(performance.now() - start),
  };
}
```

Content đặt `firstOverlayAt = performance.now()` đúng lần upsert đầu; response `translatePage()` thêm `first_overlay_ms`. Metrics không được ghi vào page artifact hoặc key.

Ở lần upsert đầu, content gửi về cùng Port:

```javascript
translationPort().postMessage({
  type: "render_metric",
  request_id: binding.requestId,
  first_overlay_ms: Math.round(performance.now() - pendingScopes.get(binding.requestId).startedAt),
});
```

Background merge field này vào request metrics; `onConnect` xử lý `render_metric` riêng, không tạo/cancel producer.

- [ ] **Step 4: Thêm bounded in-memory benchmark summary**

```javascript
const metricSamples = [];

function recordMetrics(sample) {
  metricSamples.push(sample);
  if (metricSamples.length > 100) metricSamples.shift();
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * ratio) - 1];
}

function benchmarkSummary() {
  const fields = ["first_overlay_ms", "first_translation_ms", "total_ms", "cancel_latency_ms"];
  return Object.fromEntries(fields.map((field) => {
    const values = metricSamples.map((row) => row[field]).filter(Number.isFinite);
    return [field, { p50: percentile(values, 0.5), p95: percentile(values, 0.95) }];
  }));
}
```

Khi `scope_done`, gọi `recordMetrics({...producerMetrics(producer), first_overlay_ms, cancel_latency_ms, translation_calls, rate_limited, stale_work})`. Các counter tăng ngay tại scheduler/translation/cancel branch tương ứng và được reset cùng vòng đời sample; không đưa vào cache key. Runtime message `benchmarkSummary` chỉ trả aggregate; không trả source URL, OCR text hoặc translation text.

`chrome.runtime.onMessage` trả summary chỉ cho `benchmarkSummary`; không expose session page data cho content.

- [ ] **Step 5: Mở rộng fixture A/B nhưng giữ thao tác thủ công**

```html
<button id="pageA">Trang A</button>
<button id="pageB">Trang B</button>
```

```javascript
const sources = { A: "ja_page.png", B: "es_page.png" };
for (const name of ["A", "B"]) {
  document.getElementById("page" + name).onclick = () => {
    document.getElementById("readerPage").src = sources[name];
  };
}
```

Giữ nút `swapSource`, `replacePage`, `moveViewport` để kiểm source-change, DOM removal và offscreen.

- [ ] **Step 6: Chạy cross-layer và full automated suites**

Run: `node --test extension/test/background.test.js extension/test/background-progressive.test.js extension/test/page-cache.test.js extension/test/srcset.test.js extension/test/content.test.js extension/test/content-progressive.test.js extension/test/popup.test.js extension/test/progressive-integration.test.js`

Expected: 8/8 PASS.

Run: `& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests -q`

Expected: toàn bộ test cũ và mới PASS.

- [ ] **Step 7: Browser acceptance trên fixture**

Khởi động:

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m uvicorn server.main:app --host 127.0.0.1 --port 8910
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m http.server 8000 --directory extension/test
```

Load unpacked extension, mở `http://127.0.0.1:8000/fixture.html`, rồi kiểm:

1. Dịch A, chuyển B trước khi A xong: không bubble A trên B.
2. Quay A, bấm Dịch: popup báo `Khôi phục từ cache`; Network không có source fetch, `/ocr-stream`, `/translate-items`.
3. Đẩy A khỏi viewport rồi trả lại: overlay còn.
4. Đổi source trên cùng `img`: overlay cũ detach; không tự dịch B.
5. Đổi `vi → en`: không có source fetch/`/ocr-stream`; chỉ `/translate-items`.
6. Reload service worker giữa job: persisted blocks replay, không bubble trùng.
7. Scope `loaded`: đóng content/đổi request hủy stale queue theo policy cũ.
8. Full browser restart: `chrome.storage.session` page/job records bị xóa và A chạy cold path đúng thiết kế.
9. Scope `loaded` có hai ảnh gần/xa: ảnh gần có overlay trước; đóng rồi mở popup vẫn thấy background/cache status đúng.
10. Fault controls lần lượt làm hỏng một OCR block, một image và một translation batch: phần hợp lệ còn lại không biến mất.

- [ ] **Step 8: Ghi benchmark có thể tái kiểm**

Chạy ít nhất 20 sample cùng fixture/máy cho cold và warm `visible`; lấy:

```javascript
chrome.runtime.sendMessage({ type: "benchmarkSummary" }).then(console.log)
```

Ghi p50/p95 `first_overlay_ms` làm TTFT user-visible; đồng thời ghi queue wait, fetch/upload, analysis, first OCR, first translation, viewport/scope completion, cancel latency, hit/miss reason, stale work, số Gemini calls/429, hardware và Chrome/Python/model version vào worklog. Pass target: visible first overlay p50 ≤ 5 s, p95 ≤ 8 s; total không chậm baseline quá 10%; block count không giảm.

- [ ] **Step 9: Cập nhật workflow và verification worklog bằng kết quả thật**

`work-flow.md` phải thay luồng request/response cũ bằng:

```text
popup action
  -> content snapshot + candidate descriptors
  -> start_scope Port
  -> background page/job lookup + scheduler
  -> /ocr-stream analysis_ready + ocr_block
  -> background micro-batch /translate-items
  -> content stale guard + blockId upsert
  -> page artifact complete/partial trong storage.session
```

Worklog liệt kê commit range, test counts, browser cases, benchmark table, warnings dependency và mọi acceptance chưa đạt. Không chép roadmap thành trạng thái thực tế.

- [ ] **Step 10: Fresh verification gate**

```powershell
git diff --check
node --test extension/test/background.test.js extension/test/background-progressive.test.js extension/test/page-cache.test.js extension/test/srcset.test.js extension/test/content.test.js extension/test/content-progressive.test.js extension/test/popup.test.js extension/test/progressive-integration.test.js
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests -q
```

Expected: diff check sạch; Node/Python đều exit 0. Browser/benchmark results phải có trong worklog trước khi claim P0 complete.

- [ ] **Step 11: Commit**

```powershell
git add extension/test/fixture.html extension/test/progressive-integration.test.js extension/background.js extension/content.js work-flow.md docs/superpowers/worklogs/2026-07-30-progressive-translation-verification.md
git commit -m "test: verify progressive session workflow"
```

---

## Implementation Order and Review Gates

1. Tasks 1–4 tạo server contracts và giữ API cũ xanh.
2. Tasks 5–7 tạo session/cache/coordinator, nhưng content cũ vẫn hoạt động qua message compatibility.
3. Task 8 chuyển content sang Port trong một commit có full content regression.
4. Task 9 chỉ thêm status copy.
5. Task 10 là cross-layer/browser/performance gate; không dùng unit-test pass để thay thế acceptance thật.

Sau mỗi task: chạy đúng targeted test, commit, rồi reviewer kiểm spec con của task trước khi sang task kế. Sau Task 10: chạy fresh full suite và browser acceptance trước khi dùng `superpowers:finishing-a-development-branch`.
