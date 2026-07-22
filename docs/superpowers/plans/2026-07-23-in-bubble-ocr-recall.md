# In-bubble OCR Recall (path Latin) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cải thiện độ chính xác/recall OCR bóng thoại cho path Latin (PaddleOCR) — sửa vỡ chữ do capture độ phân giải thấp và sót bóng sạch.

**Architecture:** Trước hết dựng công cụ chẩn đoán tách B2 (detector sót) vs B3 (OCR rỗng) trên trang thật. Sửa nguồn capture full-res (chọn ứng viên `srcset` lớn nhất thay `currentSrc`) và pad+upscale crop server-side. Task knob detector (`.env`) là nhánh có điều kiện, chỉ làm nếu chẩn đoán cho thấy B2.

**Tech Stack:** Python 3.12 · FastAPI · OpenCV · comic-text-detector (vendored) · manga-ocr / PaddleOCR · Chrome MV3 (vanilla JS) · pytest · node self-check (không framework).

## Global Constraints

- Không sửa code vendor `server/vendor/comic_text_detector/` — mọi knob truyền qua constructor.
- Test Python: `venv\Scripts\python -m pytest`, file `server/tests/test_*.py`.
- Test JS: node self-check assert-based (`node <file>`), không thêm framework — khớp thói quen `node --check` của dự án.
- Path unicode trên Windows: đọc/ghi ảnh bằng `np.fromfile`/`cv2.imencode(...).tofile`, không `cv2.imread`/`imwrite` (chokes non-ascii).
- bbox trả về luôn theo pixel ảnh gốc (không đổi do pad/upscale crop) — overlay extension phụ thuộc điều này.

---

### Task 1: Công cụ chẩn đoán + knob detector qua constructor

**Files:**
- Modify: `server/detector.py` (thêm tham số `conf_thresh`/`input_size` vào `Detector.__init__`)
- Create: `server/diagnose.py`
- Test: `server/tests/test_diagnose.py`

**Interfaces:**
- Consumes: `Detector.detect(img_bgr) -> list[TextRegion]` (đã có; `TextRegion.bbox = (x,y,w,h)`), engine `.read(crop_rgb) -> str`.
- Produces:
  - `Detector(device="cuda", conf_thresh: float|None=None, input_size: int|None=None)`
  - `diagnose_image(img_bgr, detector, engine) -> (annotated_bgr: np.ndarray, rows: list[dict])` với mỗi row `{"idx": int, "bbox": [x,y,w,h], "text": str}`

- [ ] **Step 1: Viết test thất bại** — `server/tests/test_diagnose.py`

```python
import numpy as np

from server.diagnose import diagnose_image


class _FakeRegion:
    def __init__(self, bbox):
        self.bbox = bbox
        self.vertical = False


class _FakeDetector:
    def detect(self, img):
        return [_FakeRegion((10, 10, 40, 20)), _FakeRegion((60, 60, 40, 20))]


class _FakeEngine:
    def __init__(self, outs):
        self._outs = list(outs)

    def read(self, crop_rgb):
        return self._outs.pop(0)


def test_diagnose_rows_and_colors():
    img = np.full((200, 200, 3), 255, np.uint8)
    annotated, rows = diagnose_image(img, _FakeDetector(), _FakeEngine(["Hola", ""]))

    assert [r["text"] for r in rows] == ["Hola", ""]
    assert rows[0]["bbox"] == [10, 10, 40, 20]
    # ô có chữ tô xanh, ô rỗng tô đỏ (BGR)
    assert (annotated == [0, 180, 0]).all(axis=2).any()
    assert (annotated == [0, 0, 220]).all(axis=2).any()
```

- [ ] **Step 2: Chạy test — xác nhận FAIL**

Run: `venv\Scripts\python -m pytest server/tests/test_diagnose.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'server.diagnose'`

- [ ] **Step 3: Thêm knob vào `Detector.__init__`** — `server/detector.py`

Thay thân `__init__` (giữ nguyên phần stub/shim phía trên file):

```python
    def __init__(self, device: str = "cuda", conf_thresh: float | None = None, input_size: int | None = None):
        # ponytail: vendor dùng absolute import nội bộ nên phải chèn sys.path;
        # nếu sau này vendor lên PyPI thì thay bằng import thường
        sys.path.insert(0, str(VENDOR))
        from inference import TextDetector

        # knob None → giữ default vendor (conf_thresh=0.4, input_size=1024)
        kw = {"model_path": str(MODEL)}
        if conf_thresh is not None:
            kw["conf_thresh"] = conf_thresh
        if input_size is not None:
            kw["input_size"] = input_size
        try:
            self._model = TextDetector(device=device, **kw)
        except Exception as e:
            print(f"[detector] CUDA init lỗi ({e}), fallback CPU")
            self._model = TextDetector(device="cpu", **kw)
```

- [ ] **Step 4: Viết `server/diagnose.py`**

```python
import sys

import cv2
import numpy as np


def diagnose_image(img_bgr, detector, engine):
    """Chạy detect + OCR như pipeline thật, trả (ảnh annotate, rows).
    Ô xanh = OCR ra chữ, ô đỏ = rỗng → tách B2 (không có ô) vs B3 (ô đỏ)."""
    h, w = img_bgr.shape[:2]
    annotated = img_bgr.copy()
    rows = []
    for i, region in enumerate(detector.detect(img_bgr)):
        x, y, bw, bh = region.bbox
        x, y = max(0, x), max(0, y)
        x2, y2 = min(w, x + bw), min(h, y + bh)
        text = ""
        if x2 > x and y2 > y:
            crop = cv2.cvtColor(img_bgr[y:y2, x:x2], cv2.COLOR_BGR2RGB)
            text = engine.read(crop).strip()
        color = (0, 180, 0) if text else (0, 0, 220)  # BGR
        cv2.rectangle(annotated, (x, y), (x2, y2), color, 2)
        cv2.putText(annotated, str(i), (x, max(12, y - 4)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
        rows.append({"idx": i, "bbox": [x, y, x2 - x, y2 - y], "text": text})
    return annotated, rows


def _write_report(path, rows):
    with open(path, "w", encoding="utf-8") as f:
        for r in rows:
            txt = r["text"] if r["text"] else "<rỗng>"
            f.write(f'#{r["idx"]}  bbox={r["bbox"]}  text="{txt}"\n')


def main(argv):
    import argparse

    from server.detector import Detector
    from server.ocr import OcrRegistry

    p = argparse.ArgumentParser()
    p.add_argument("image")
    p.add_argument("--lang", default="ja")
    p.add_argument("--conf", type=float, default=None)
    p.add_argument("--input-size", type=int, default=None)
    args = p.parse_args(argv)

    img = cv2.imdecode(np.fromfile(args.image, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise SystemExit(f"không đọc được ảnh: {args.image}")

    det = Detector(device="cuda", conf_thresh=args.conf, input_size=args.input_size)
    engine = OcrRegistry(device="cuda").get(args.lang)
    annotated, rows = diagnose_image(img, det, engine)

    out_png, out_txt = args.image + ".diag.png", args.image + ".diag.txt"
    cv2.imencode(".png", annotated)[1].tofile(out_png)
    _write_report(out_txt, rows)
    empty = sum(1 for r in rows if not r["text"])
    print(f"{len(rows)} block, {empty} rỗng → {out_png} / {out_txt}")


if __name__ == "__main__":
    main(sys.argv[1:])
```

- [ ] **Step 5: Chạy test — xác nhận PASS**

Run: `venv\Scripts\python -m pytest server/tests/test_diagnose.py -v`
Expected: PASS

- [ ] **Step 6: Kiểm tra suite không hỏng** (detector.py đổi chữ ký)

Run: `venv\Scripts\python -m pytest server/tests -q`
Expected: toàn bộ pass (chữ ký mới có default nên caller cũ `Detector(device=...)` vẫn chạy)

- [ ] **Step 7: Commit**

```bash
git add server/detector.py server/diagnose.py server/tests/test_diagnose.py
git commit -m "feat: diagnostic tool tách B2/B3 + knob conf/input_size cho detector"
```

- [ ] **Step 8: CHẠY CHẨN ĐOÁN THẬT (decision gate — không phải bước code)**

Run: `venv\Scripts\python -m server.diagnose "server/vendor/comic_text_detector/data/examples/mangadex.jpeg" --lang es`
Mở `mangadex.jpeg.diag.png` + đọc `.diag.txt`, xét 3 bóng sót ("POR FAVOR...", "SIM... EU NÃO VOU...", "EU ME PREOCUPO..."):
- **Không ô nào phủ bóng → B2** → làm **Task 4** (knob `.env`), thử `--conf 0.25` / `--input-size 1536` để tìm giá trị.
- **Có ô đỏ trên bóng → B3** → Task 3 (đã làm) là hướng đúng; Task 4 bỏ qua.
Ghi kết luận vào note Obsidian tiến độ.

---

### Task 2: Nguồn capture full-res (chọn srcset lớn nhất)

**Files:**
- Create: `extension/srcset.js`
- Modify: `extension/manifest.json` (thêm `srcset.js` trước `content.js`)
- Modify: `extension/content.js:51-52` (dùng `bestSource(img)`)
- Test: `extension/test/srcset.test.js`

**Interfaces:**
- Produces: `bestSource(img) -> string` — URL nguồn độ phân giải cao nhất. `img` cần các thuộc tính `srcset`, `src`, `currentSrc`, `baseURI`.

- [ ] **Step 1: Viết test thất bại** — `extension/test/srcset.test.js`

```javascript
const assert = require("assert");
const { bestSource } = require("../srcset.js");

// srcset nhiều biến thể → chọn URL có descriptor lớn nhất
assert.strictEqual(
  bestSource({
    srcset: "https://x/small.jpg 320w, https://x/big.jpg 1280w, https://x/mid.jpg 640w",
    src: "https://x/fallback.jpg",
    baseURI: "https://x/",
  }),
  "https://x/big.jpg"
);

// không srcset → dùng img.src (không phải currentSrc biến thể nhỏ)
assert.strictEqual(
  bestSource({ src: "https://x/orig.jpg", currentSrc: "https://x/small.jpg" }),
  "https://x/orig.jpg"
);

console.log("srcset.test.js OK");
```

- [ ] **Step 2: Chạy test — xác nhận FAIL**

Run: `node extension/test/srcset.test.js`
Expected: FAIL — `Cannot find module '../srcset.js'`

- [ ] **Step 3: Viết `extension/srcset.js`**

```javascript
// Chọn nguồn ảnh full-res. currentSrc có thể trỏ biến thể srcset NHỎ khi trang
// hiển thị ảnh trong khung nhỏ → OCR nhận pixel thấp → vỡ chữ. Ưu tiên ứng viên
// srcset có descriptor lớn nhất; ngược lại img.src (URL gốc, không descriptor).
function bestSource(img) {
  const set = img.srcset || (img.getAttribute && img.getAttribute("srcset"));
  if (set) {
    let best = null;
    let bestW = -1;
    for (const part of set.split(",")) {
      const [url, desc] = part.trim().split(/\s+/);
      if (!url) continue;
      const wt = desc ? parseFloat(desc) : 1; // "1280w"/"2x" → 1280/2; không desc → 1
      if (wt > bestW) {
        bestW = wt;
        best = url;
      }
    }
    if (best) return new URL(best, img.baseURI || "http://localhost/").href;
  }
  return img.src || img.currentSrc;
}

if (typeof module !== "undefined") module.exports = { bestSource };
```

- [ ] **Step 4: Chạy test — xác nhận PASS**

Run: `node extension/test/srcset.test.js`
Expected: `srcset.test.js OK`

- [ ] **Step 5: Nạp `srcset.js` trước `content.js`** — `extension/manifest.json`

Sửa mảng `js` trong `content_scripts[0]`:

```json
      "js": ["srcset.js", "content.js"],
```

- [ ] **Step 6: Dùng `bestSource` trong content.js** — `extension/content.js`

Trong `translatePage` (dòng ~51), đổi URL capture từ `img.currentSrc || img.src` sang `bestSource(img)`. Chỉ MỘT chỗ này — `eligible()` dòng 35 giữ nguyên (chỉ kiểm ảnh có nguồn, không phải URL capture):

```javascript
  const ocrResults = await Promise.all(
    imgs.map((img) =>
      chrome.runtime.sendMessage({
        type: "ocrImage",
        url: bestSource(img),
        srcLang,
      })
    )
  );
```

- [ ] **Step 7: Syntax check**

Run: `node --check extension/content.js` và `node --check extension/srcset.js`
Expected: không lỗi

- [ ] **Step 8: Commit**

```bash
git add extension/srcset.js extension/manifest.json extension/content.js extension/test/srcset.test.js
git commit -m "feat: capture nguồn full-res (chọn srcset lớn nhất) thay currentSrc"
```

---

### Task 3: Pad + upscale crop trước OCR

**Files:**
- Modify: `server/pipeline.py` (thêm `_prep_crop`, dùng trong `ocr_image`)
- Test: `server/tests/test_pipeline.py` (thêm 2 test cho `_prep_crop`)

**Interfaces:**
- Produces: `_prep_crop(crop_rgb: np.ndarray) -> np.ndarray` — đệm viền trắng 8px mỗi cạnh; nếu cao < 48px thì upscale (INTER_CUBIC) lên tối thiểu 48px trước khi đệm.
- Consumes trong `ocr_image`: `engine.read(_prep_crop(crop))` thay `engine.read(crop)`. bbox lưu vào block giữ nguyên tọa độ gốc.

- [ ] **Step 1: Viết test thất bại** — thêm vào `server/tests/test_pipeline.py`

```python
import numpy as np

from server.pipeline import _prep_crop


def test_prep_crop_upscales_small():
    out = _prep_crop(np.zeros((20, 100, 3), np.uint8))
    assert out.shape[0] >= 48  # crop nhỏ được phóng to


def test_prep_crop_pads_large_only():
    out = _prep_crop(np.zeros((80, 200, 3), np.uint8))
    assert out.shape[:2] == (96, 216)  # chỉ đệm 8px mỗi cạnh, không upscale
```

- [ ] **Step 2: Chạy test — xác nhận FAIL**

Run: `venv\Scripts\python -m pytest server/tests/test_pipeline.py -k prep_crop -v`
Expected: FAIL — `ImportError: cannot import name '_prep_crop'`

- [ ] **Step 3: Thêm `_prep_crop` + dùng trong `ocr_image`** — `server/pipeline.py`

Thêm hằng + hàm ở đầu module (sau import):

```python
_MIN_CROP_H = 48  # dưới ngưỡng này OCR đọc kém → upscale trước


def _prep_crop(crop_rgb):
    """Đệm viền trắng (PaddleOCR hay sót chữ sát mép) + phóng to crop chữ nhỏ
    (bóng sau khi trang co lại quá nhỏ để OCR đọc chuẩn)."""
    h = crop_rgb.shape[0]
    if h < _MIN_CROP_H:
        s = _MIN_CROP_H / h
        crop_rgb = cv2.resize(crop_rgb, None, fx=s, fy=s, interpolation=cv2.INTER_CUBIC)
    return cv2.copyMakeBorder(crop_rgb, 8, 8, 8, 8, cv2.BORDER_CONSTANT, value=(255, 255, 255))
```

Trong `ocr_image`, đổi dòng đọc OCR:

```python
            crop = cv2.cvtColor(img[y:y2, x:x2], cv2.COLOR_BGR2RGB)
            text = engine.read(_prep_crop(crop)).strip()
```

- [ ] **Step 4: Chạy test — xác nhận PASS**

Run: `venv\Scripts\python -m pytest server/tests/test_pipeline.py -k prep_crop -v`
Expected: PASS

- [ ] **Step 5: Suite pipeline vẫn xanh** (fake engine nhận crop đã prep — chỉ đổi kích thước, không đổi kiểu)

Run: `venv\Scripts\python -m pytest server/tests/test_pipeline.py -q`
Expected: toàn bộ pass

- [ ] **Step 6: Commit**

```bash
git add server/pipeline.py server/tests/test_pipeline.py
git commit -m "feat: pad + upscale crop bóng nhỏ trước OCR (giảm vỡ chữ path Latin)"
```

---

### Task 4 (CÓ ĐIỀU KIỆN — chỉ làm nếu Task 1 Step 8 kết luận B2): knob detector qua `.env`

Chỉ thực hiện nếu chẩn đoán cho thấy bóng sót vì **detector không trả bbox** (B2). Nếu là B3, bỏ qua task này.

**Files:**
- Modify: `server/config.py` (thêm `DETECTOR_CONF`, `DETECTOR_INPUT_SIZE`)
- Modify: `server/pipeline.py:9-11` (truyền knob khi tạo `Detector`)
- Modify: `.env.example` (ghi knob mới)
- Test: `server/tests/test_config.py` (tạo mới — kiểm mặc định None-an toàn)

**Interfaces:**
- Consumes: `Detector(device, conf_thresh, input_size)` (Task 1).
- Produces: `config.DETECTOR_CONF: float|None`, `config.DETECTOR_INPUT_SIZE: int|None`.

- [ ] **Step 1: Viết test thất bại** — `server/tests/test_config.py`

```python
import importlib


def test_detector_knobs_default_none(monkeypatch):
    monkeypatch.delenv("DETECTOR_CONF", raising=False)
    monkeypatch.delenv("DETECTOR_INPUT_SIZE", raising=False)
    import server.config as config

    importlib.reload(config)
    assert config.DETECTOR_CONF is None
    assert config.DETECTOR_INPUT_SIZE is None
```

- [ ] **Step 2: Chạy test — xác nhận FAIL**

Run: `venv\Scripts\python -m pytest server/tests/test_config.py -v`
Expected: FAIL — `AttributeError: module 'server.config' has no attribute 'DETECTOR_CONF'`

- [ ] **Step 3: Thêm knob vào `config.py`**

```python
def _opt_float(name):
    v = os.getenv(name)
    return float(v) if v else None


def _opt_int(name):
    v = os.getenv(name)
    return int(v) if v else None


DETECTOR_CONF = _opt_float("DETECTOR_CONF")
DETECTOR_INPUT_SIZE = _opt_int("DETECTOR_INPUT_SIZE")
```

- [ ] **Step 4: Truyền knob khi tạo Detector** — `server/pipeline.py`

```python
        if detector is None:
            from . import config
            from .detector import Detector

            detector = Detector(
                device=device,
                conf_thresh=config.DETECTOR_CONF,
                input_size=config.DETECTOR_INPUT_SIZE,
            )
```

- [ ] **Step 5: Ghi knob vào `.env.example`**

```
# Tinh chỉnh detector (để trống = default vendor: conf 0.4, size 1024)
# Hạ conf để bắt thêm bóng mờ; tăng size cho trang lớn chữ nhỏ
DETECTOR_CONF=
DETECTOR_INPUT_SIZE=
```

- [ ] **Step 6: Chạy test — xác nhận PASS + suite xanh**

Run: `venv\Scripts\python -m pytest server/tests/test_config.py server/tests/test_pipeline.py -q`
Expected: toàn bộ pass

- [ ] **Step 7: Tinh chỉnh bằng diagnostic** (không phải bước test)

Chạy lại `python -m server.diagnose <ảnh> --lang es --conf 0.25 --input-size 1536`, so `.diag.png` với default tới khi 3 bóng có ô mà không sinh bbox rác. Chốt giá trị → điền vào `.env`, restart server.

- [ ] **Step 8: Commit**

```bash
git add server/config.py server/pipeline.py .env.example server/tests/test_config.py
git commit -m "feat: knob detector conf/input_size đọc từ .env"
```

---

## Escalation B3 (CHƯA task hóa — chỉ nếu Task 3 vẫn không đủ)

Nếu sau Task 3 mà PaddleOCR vẫn trả rỗng/sai trên bóng sạch, hai nấc sau (spec §2b) cần brainstorm lại trước khi làm — không task hóa sẵn vì có thể không bao giờ cần (YAGNI):
- Bỏ loại cứng `if not text: continue` trong `pipeline.py` — giữ block cho Gemini (rủi ro sinh rác).
- Đưa crop bóng thẳng cho Gemini multimodal đọc+dịch (tốn token ảnh, rủi ro 429).

## Kiểm chứng tay cuối (sau khi xong các task áp dụng)

1. `run_server.bat` (chờ model load).
2. `chrome://extensions` → reload extension → **F5** trang thật (reload extension làm mất content script tab cũ).
3. Mở trang truyện Latin, bấm "Dịch trang này".
4. Xác nhận: 3 bóng trước đây sót giờ có overlay; chữ không vỡ kể cả khi ảnh hiển thị nhỏ.
5. Cập nhật note Obsidian `Tiến độ MangaTranslator.md` với kết quả (B2 hay B3, giá trị knob nếu có).
