# Kế hoạch triển khai Spec C: làm sạch và render bản dịch nguyên vị trí

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Mục tiêu:** Thay bbox trắng hiện tại bằng patch làm sạch chữ gốc và chữ dịch fit nguyên vị trí, mount nguyên tử theo block, không dịch/render SFX và không tạo retry không giới hạn.

**Kiến trúc:** Server giữ raw/refined mask từ detector, resolve fragment thành region page-space, OCR fragment rồi tạo `RenderArtifact` độc lập translation trong cache riêng. Extension hash bytes nguồn, join full-page translation với render artifact, persist `page-v2`, đo layout trong content script và chỉ mount patch+text khi cả hai hợp lệ; manifest/OCR recovery dùng breaker persist để có chi phí hữu hạn.

**Công nghệ:** Python 3.12, FastAPI, NumPy, OpenCV, pytest, JavaScript service worker/content script, Chrome storage/session, Node test runner, acceptance FastAPI app hiện có.

**Nguồn thẩm quyền:** `docs/superpowers/specs/2026-08-08-in-place-clean-overlay-rendering-design.md`.

## Ràng buộc toàn cục

- Trước khi sửa code, đọc `GIT-RULES.md` và chỉ làm việc trong worktree triển khai hiện có trên nhánh `feat/v5`; dừng nếu kiểm tra branch/status bên dưới không khớp.
- Spec và plan đã duyệt là file tracked trong worktree triển khai. Luôn đọc chúng bằng đường dẫn tương đối `docs/superpowers/specs/2026-08-08-in-place-clean-overlay-rendering-design.md` và `docs/superpowers/plans/2026-08-09-in-place-clean-overlay-rendering.md` của chính worktree này; không mở hoặc copy bản thứ hai từ worktree chính.
- Không stage hoặc commit tự động. Mỗi task dừng ở review checkpoint; chỉ commit khi người dùng cấp quyền riêng cho checkpoint đó.
- Mọi Python test dùng `D:\MangaTranslator\venv\Scripts\python.exe`; không dùng system Python/pytest.
- Không chạy `server/tests/test_ocr.py`; test này tải model/fixture thật và chỉ chạy khi người dùng phê duyệt gate riêng.
- Không thêm dependency. Dùng NumPy, OpenCV, DOM và Chrome APIs đã có.
- Mọi bbox/mask công khai sau analysis là page-space `[x, y, width, height]`; crop offset chỉ cộng một lần.
- Dedupe hiện hữu chạy trước resolver. Unbounded region vẫn vào full-page translation nhưng fail closed bằng `unsupported_region` nếu không render an toàn.
- Translation là một full-page call; response strict `{id, kind, translation}`. SFX có `kind="sfx"`, `translation=null`, không có RenderBlock/event.
- Mount nguyên tử theo block: không patch-only, không text-only, không card. Font tối thiểu là `10px`; overflow ở mức đó thành `fit_failed` và giữ ảnh gốc.
- `render_artifact_key` không chứa translation identity; browser không persist patch bytes.
- `_analysis_cache = BoundedLru(max_items=8, max_bytes=128 MiB)`, `_ocr_cache = BoundedLru(max_items=256)`, `_render_cache = BoundedLru(max_items=32, max_bytes=128 MiB)`.
- Production và acceptance `/health` cùng phát `versions` và `patch_versions`; `LAYOUT_FIT_VERSION` thuộc extension.
- Legacy `first_overlay_ms` không so trực tiếp với `overlay_semantics="atomic_patch_v1"`.
- Mọi task tuân TDD: thêm red test, chạy thấy fail đúng lý do, viết thay đổi nhỏ nhất, chạy green test, rồi review diff.

## Bản đồ file và trách nhiệm

| File | Responsibility after Spec C |
|---|---|
| `server/artifacts.py` | Dataclass analysis/OCR/render và bounded LRU semantics |
| `server/detector.py` | Trả raw mask, refined mask và detector regions có `vertical` |
| `server/region_resolver.py` | Pure connected-container grouping, bounded/unbounded, fragment order |
| `server/pipeline.py` | Page-space analysis, OCR fragment aggregation, cache/singleflight orchestration |
| `server/rendering.py` | Pure inpaint, alpha feather, fit bbox, lossless PNG patch |
| `server/main.py` | `/ocr-stream`, `/render-artifact`, `/health` production contract |
| `server/contracts.py`, `server/translator.py` | Strict full-page text/SFX response and prompt v3 |
| `server/config.py` | Page-affecting versions and independent patch versions |
| `server/acceptance_app.py` | Protocol-compatible synthetic render/translation/health/asset behavior |
| `extension/source-fetch.js` | URL-deduped fetch/hash pool with refcounted abort |
| `extension/page-cache.js` | `page-v2`, render subrecord, recovery ledger, selective invalidation |
| `extension/background.js` | Key derivation, producer join, manifest/recovery/delivery/metrics |
| `extension/content.js`, `extension/overlay.css` | Atomic patch+text DOM, fit measurement and render feedback |
| `server/tests/*`, `extension/test/*` | Gates A-G without live Gemini or real OCR model |

---

### Task 0: Thiết lập baseline cô lập và tái lập được

**Files:**
- Read: `GIT-RULES.md`
- Read: `docs/superpowers/specs/2026-08-08-in-place-clean-overlay-rendering-design.md`
- No source modification

**Interfaces:**
- Consumes: current `feat/v5` source (branched from the integrated main source) and the approved Spec C document in this worktree.
- Produces: isolated worktree path plus exact baseline test output; no code.

- [ ] **Step 1: Confirm the existing isolated implementation worktree**

From the existing implementation worktree, follow `GIT-RULES.md` and record:

```powershell
git branch --show-current
git status --short
git rev-parse HEAD
```

Expected: branch is `feat/v5`, the implementation worktree is clean, and the recorded HEAD is the source baseline for all later checkpoints. Do not create or select another worktree.

- [ ] **Step 2: Run the server baseline without the real OCR test**

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests --ignore=server/tests/test_ocr.py -q
```

Expected: PASS. If it fails before Spec C changes, stop and record exact pre-existing failures; do not fold unrelated fixes into this plan.

- [ ] **Step 3: Run the extension baseline**

```powershell
node --test extension/test/background.test.js extension/test/background-progressive.test.js extension/test/page-cache.test.js extension/test/reading-order.test.js extension/test/srcset.test.js extension/test/content.test.js extension/test/content-progressive.test.js extension/test/popup.test.js extension/test/progressive-integration.test.js extension/test/fixture-benchmark.test.js
```

Expected: PASS.

- [ ] **Step 4: Review checkpoint**

Save command output in the task ledger. Do not stage or commit.

---

### Task 1: Thêm artifact nền và semantics bounded-LRU an toàn

**Files:**
- Modify: `server/artifacts.py:14-88`
- Modify: `server/tests/test_artifacts.py`

**Interfaces:**
- Consumes: current `stable_block_id()` and `BoundedLru` callers.
- Produces: `PreparedFragment`, expanded `PreparedRegion`, `RenderBlockArtifact`, `RenderArtifact`, and `BoundedLru.put() -> list[K] | None`.

- [ ] **Step 1: Write red tests for oversize and identity-preserving update**

Add to `server/tests/test_artifacts.py`:

```python
def test_lru_rejects_oversize_without_mutating_existing_key():
    cache = BoundedLru(max_items=2, max_bytes=3, size_of=len)
    assert cache.put("a", b"ok") == []
    assert cache.put("a", b"xxxx") is None
    assert cache.get("a") == b"ok"


def test_lru_without_byte_cap_accepts_values():
    cache = BoundedLru(max_items=2)
    assert cache.put("a", object()) == []
    assert cache.peek("a") is not None
```

- [ ] **Step 2: Write red tests for artifact byte accounting**

Construct one `PreparedRegion` with source RGB, OCR crop, raw/refined/container masks and assert `AnalysisArtifact.byte_size` equals the sum of every array's `nbytes`. Also assert the render artifact holds encoded PNG bytes but analysis does not.

- [ ] **Step 3: Run the red tests**

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_artifacts.py -q
```

Expected: FAIL because the new dataclasses/fields and oversize guard do not exist.

- [ ] **Step 4: Implement the dataclasses and LRU guard**

Use these public shapes in `server/artifacts.py`:

```python
BBox = tuple[int, int, int, int]

@dataclass(frozen=True)
class PreparedFragment:
    bbox: BBox
    crop_rgb: np.ndarray
    vertical: bool

@dataclass(frozen=True)
class PreparedRegion:
    block_id: str
    bbox: BBox
    source_bbox: BBox
    fragments: tuple[PreparedFragment, ...]
    source_rgb: np.ndarray
    raw_mask: np.ndarray
    refined_mask: np.ndarray
    container_mask: np.ndarray | None
    vertical: bool
    bounded: bool

@dataclass(frozen=True)
class RenderBlockArtifact:
    block_id: str
    patch_id: str | None
    patch_bbox: BBox | None
    clean_region: BBox | None
    fit_bbox: BBox | None
    patch_mime: str | None
    patch_png: bytes | None
    reason: str | None

@dataclass(frozen=True)
class RenderArtifact:
    schema_version: str
    render_artifact_key: str
    analysis_key: str
    image_w: int
    image_h: int
    blocks: tuple[RenderBlockArtifact, ...]
    byte_size: int
```

At the top of `BoundedLru.put()`:

```python
size = self.size_of(value)
if self.max_bytes is not None and size > self.max_bytes:
    return None
```

Only after that guard may the method pop/replace the old key and evict LRU entries.

- [ ] **Step 5: Run green tests**

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_artifacts.py -q
```

Expected: PASS.

- [ ] **Step 6: Review checkpoint**

Run `git diff --check` and inspect only `server/artifacts.py` plus `server/tests/test_artifacts.py`. Do not stage or commit.

---

### Task 2: Giữ detector mask và resolve vùng chứa chữ

**Files:**
- Modify: `server/detector.py:28-58`
- Create: `server/region_resolver.py`
- Create: `server/tests/test_region_resolver.py`
- Modify: `server/tests/test_detector.py`

**Interfaces:**
- Consumes: vendor `TextDetector.__call__()` result `(mask, mask_refined, blk_list)` and deduped `TextRegion` values.
- Produces: `DetectionResult(raw_mask, refined_mask, regions)` and `resolve_regions(image_bgr, detection) -> tuple[ResolvedRegion, ...]` in work-space coordinates.

- [ ] **Step 1: Write a red detector-adapter test without loading the real model**

Instantiate `Detector` with `__new__`, attach a fake `_model`, and assert raw/refined arrays are retained:

```python
def test_detect_returns_masks_regions_and_vertical():
    raw = np.zeros((20, 30), np.uint8)
    refined = np.full((20, 30), 255, np.uint8)
    block = SimpleNamespace(xyxy=(1, 2, 11, 12), vertical=True)
    detector = Detector.__new__(Detector)
    detector._model = lambda image: (raw, refined, [block])

    result = detector.detect(np.zeros((20, 30, 3), np.uint8))

    assert result.raw_mask is raw
    assert result.refined_mask is refined
    assert result.regions == (TextRegion((1, 2, 10, 10), True),)
```

- [ ] **Step 2: Write resolver red tests**

In `server/tests/test_region_resolver.py`, build deterministic NumPy pages and assert:

```python
def test_closed_light_component_groups_two_horizontal_fragments():
    image, raw, refined = closed_bubble_fixture()
    detection = DetectionResult(raw, refined, (
        TextRegion((25, 30, 12, 8), False),
        TextRegion((25, 42, 14, 8), False),
    ))
    resolved = resolve_regions(image, detection)
    assert len(resolved) == 1
    assert resolved[0].bounded is True
    assert [row.bbox for row in resolved[0].fragments] == [(25, 30, 12, 8), (25, 42, 14, 8)]


def test_open_component_stays_unbounded_translation_candidate():
    image, detection = open_narration_fixture()
    resolved = resolve_regions(image, detection)
    assert len(resolved) == 1
    assert resolved[0].bounded is False
    assert resolved[0].container_mask is None
```

Add separate tests for adjacent closed bubbles, mixed orientation not grouping, and exact duplicate union dedupe.

- [ ] **Step 3: Run red tests**

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_detector.py -k "returns_masks or constructor" -q
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_region_resolver.py -q
```

Expected: FAIL because `DetectionResult`, `ResolvedRegion` and resolver do not exist.

- [ ] **Step 4: Implement the smallest deterministic resolver**

In `server/detector.py` add:

```python
@dataclass(frozen=True)
class DetectionResult:
    raw_mask: np.ndarray
    refined_mask: np.ndarray
    regions: tuple[TextRegion, ...]
```

In `server/region_resolver.py`, use one light-background connected-component pass:

```python
LIGHT_THRESHOLD = 200

def resolve_regions(image_bgr, detection):
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    raw = detection.raw_mask.astype(np.uint8) > 0
    walkable = ((gray >= LIGHT_THRESHOLD) | raw).astype(np.uint8)
    _, labels = cv2.connectedComponents(walkable, connectivity=4)
    assignments = [_component_for_region(labels, raw, region) for region in detection.regions]
    return _group_components(image_bgr, detection, labels, assignments)
```

`_component_for_region()` selects the modal positive label under that fragment's raw mask, falling back to its bbox center. A component is bounded only when it does not touch an image edge. Group key is `(component_label, vertical)` for bounded components and a unique fragment key for unbounded components. Crop raw/refined/container masks around a clamped `source_bbox`; `bbox` remains the union of fragment bboxes.

- [ ] **Step 5: Run green tests**

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_detector.py -k "returns_masks or constructor" -q
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_region_resolver.py -q
```

Expected: PASS. Do not run the module-scoped real detector fixture in this task.

- [ ] **Step 6: Review checkpoint**

Inspect the resolver constants and fixture failures before tuning them. Any threshold change must update `versions.region_resolver`, not become hidden configuration.

---

### Task 3: Tích hợp analysis page-space và OCR theo fragment

**Files:**
- Modify: `server/pipeline.py:29-214`
- Modify: `server/tests/test_pipeline.py`
- Modify: `server/tests/test_ocr_stream.py`

**Interfaces:**
- Consumes: `DetectionResult`, `resolve_regions()`, artifact dataclasses from Tasks 1-2.
- Produces: page-space `AnalysisArtifact`; OCR event `{block_id,bbox,src_text,vertical}`; incomplete region retry by stable block ID.

- [ ] **Step 1: Write red crop-offset and unique-union tests**

Use a fake detector returning work-space masks/regions, analyze crop `(0.25, 0.25, 0.75, 0.75)`, then assert `PreparedRegion.bbox`, `source_bbox` and every `PreparedFragment.bbox` received the same page offset exactly once. Use an asymmetric red/blue fixture to assert source and OCR crops are converted once from OpenCV BGR into contract RGB. Add a second fixture where two detector fragments resolve to one block and assert `stable_block_id(analysis_key, union_bbox, 0)`.

- [ ] **Step 2: Write red OCR aggregation tests**

Add tests that feed horizontal and vertical fragment crops through a deterministic fake engine:

```python
assert block == {
    "type": "ocr_block",
    "ocr_key": "ocr-1",
    "block_id": expected_id,
    "bbox": list(expected_union),
    "src_text": "右\n左",
    "vertical": True,
}
```

Also assert duplicate fragment text with overlapping geometry appears once. When one fragment raises, emit the partial block if another fragment succeeds, emit `ocr_block_error`, and do not add that region to `completed_ids`.

- [ ] **Step 3: Run red tests**

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_pipeline.py server/tests/test_ocr_stream.py -q
```

Expected: FAIL on detector return type, missing masks/vertical and one-crop-per-region assumptions.

- [ ] **Step 4: Implement analysis integration**

In `Pipeline.analyze()`:

```python
detection = self._detector.detect(work)
deduped = _dedupe_regions(list(detection.regions))
resolved = resolve_regions(work, replace(detection, regions=tuple(deduped)))
```

For each resolved region, add crop offset once, convert its BGR source/fragment crops once with `cv2.cvtColor(..., cv2.COLOR_BGR2RGB)`, build page-space fragments, retain RGB source/masks, and compute `byte_size` from every stored array. Set `_analysis_cache` to `max_items=8`, `max_bytes=128 * 1024 * 1024`.

- [ ] **Step 5: Implement fragment OCR without widening `_ocr_lock`**

Sort fragments by:

```python
key = (lambda fragment: (-fragment.bbox[0], fragment.bbox[1])) if region.vertical \
    else (lambda fragment: (fragment.bbox[1], fragment.bbox[0]))
```

Acquire `_ocr_lock` only around each `engine.read(fragment.crop_rgb)`. Normalize/strip text, remove duplicate geometry/text and join with `"\n"`. Preserve cached successes and retry only region IDs absent from `completed_ids`.

- [ ] **Step 6: Run green tests**

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_pipeline.py server/tests/test_ocr_stream.py -q
```

Expected: PASS.

- [ ] **Step 7: Review checkpoint**

Inspect that no cleaning/inpaint call occurs while `_ocr_lock` is held and no public coordinate remains work-space.

---

### Task 4: Tạo patch sạch lossless và hình học fit

**Files:**
- Create: `server/rendering.py`
- Create: `server/tests/test_rendering.py`

**Interfaces:**
- Consumes: `AnalysisArtifact` and `PreparedRegion` from Task 1.
- Produces: `build_render_artifact(analysis, render_artifact_key) -> RenderArtifact` with PNG bytes, page-space bbox and capability reason.

- [ ] **Step 1: Write pixel-level red tests**

Create a white synthetic bubble with black text pixels and explicit raw/refined masks. Assert:

```python
artifact = build_render_artifact(analysis, "render-1")
assert artifact.schema_version == "render-v1"
assert artifact.render_artifact_key == "render-1"
block = artifact.blocks[0]
rgba = cv2.imdecode(np.frombuffer(block.patch_png, np.uint8), cv2.IMREAD_UNCHANGED)
rgba = cv2.cvtColor(rgba, cv2.COLOR_BGRA2RGBA)
assert block.patch_mime == "image/png"
assert np.all(rgba[..., 3][refined_mask == 0] == 0)
assert np.all(rgba[..., 3][raw_mask > 0] == 255)
assert block.fit_bbox is not None
```

Add tests for unbounded -> `unsupported_region`, empty mask -> `clean_failed`, open/invalid container -> `layout_failed`, patch/fit bbox page-space, and asymmetric source colors surviving PNG round-trip without red/blue swap.

- [ ] **Step 2: Run red tests**

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_rendering.py -q
```

Expected: FAIL because `server/rendering.py` does not exist.

- [ ] **Step 3: Implement cleaner and alpha feather**

Use fixed constants owned by `patch_versions.cleaner`:

```python
INPAINT_RADIUS = 3
FEATHER_PX = 2
FIT_PADDING_PX = 4
```

Call `cv2.inpaint(source_rgb, refined_mask, INPAINT_RADIUS, cv2.INPAINT_TELEA)`. Build alpha from distance-transform inside refined mask: raw-mask pixels remain 255, pixels outside refined mask remain 0, and only the expanded band feathers inward. Convert RGBA to BGRA exactly once for `cv2.imencode(".png", encoded_bgra)`, then hash the encoded bytes plus page-space patch bbox for `patch_id`.

- [ ] **Step 4: Implement fit bbox**

Erode `container_mask` by `FIT_PADDING_PX`, choose the largest connected interior component containing the raw text centroid, convert its crop-relative bbox through `source_bbox` to page-space, and reject empty/out-of-page results as `layout_failed`.

- [ ] **Step 5: Run green tests**

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_rendering.py -q
```

Expected: PASS.

- [ ] **Step 6: Review checkpoint**

Render the synthetic RGBA result to a temporary PNG for visual inspection, but do not add generated debug files to Git.

---

### Task 5: Thêm render cache, singleflight, API và miền version

**Files:**
- Modify: `server/pipeline.py:47-214`
- Modify: `server/main.py:40-140`
- Modify: `server/config.py:11-25`
- Modify: `server/acceptance_app.py:14-419`
- Modify: `server/tests/test_ocr_stream.py`
- Modify: `server/tests/test_health.py`
- Modify: `server/tests/test_acceptance_app.py`
- Create: `server/tests/test_render_artifact.py`

**Interfaces:**
- Consumes: `build_render_artifact()` from Task 4.
- Produces: `Pipeline.ensure_render()`, `Pipeline.get_render()`, `POST /render-artifact`, `versions`, `patch_versions`.

- [ ] **Step 1: Write red API and singleflight tests**

Add tests for:

```python
assert client.post("/render-artifact", data={
    "analysis_key": "missing",
    "render_artifact_key": "render-1",
    "source_content_hash": sha256(b"png").hexdigest(),
}).status_code == 409
```

Then upload bytes, assert source-hash mismatch returns `409 source_identity_mismatch`, valid upload returns all render fields/base64 PNG, repeated key builds once, and two concurrent requests share the same future.

For `/ocr-stream`, assert both production and acceptance still accept an omitted `render_artifact_key` during this compatibility task. When the field is present, production must start `ensure_render()` after analysis and before OCR iteration.

- [ ] **Step 2: Write red overlap/lock test**

Use events around a fake `build_render_artifact` and fake OCR engine. Assert render build starts after analysis and can remain blocked while OCR enters `_ocr_lock`; releasing either does not require releasing the other.

- [ ] **Step 3: Run red tests**

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_render_artifact.py server/tests/test_ocr_stream.py server/tests/test_health.py server/tests/test_acceptance_app.py -q
```

Expected: FAIL because render cache/API/version payload do not exist.

- [ ] **Step 4: Implement pipeline render ownership**

Initialize:

```python
self._render_cache = BoundedLru(
    max_items=32,
    max_bytes=128 * 1024 * 1024,
    size_of=lambda artifact: artifact.byte_size,
)
self._render_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="render")
self._render_futures = {}
self._render_futures_lock = Lock()
```

`ensure_render(analysis_key, render_key)` returns the existing future or submits one build; completion stores only non-oversize artifacts and always removes the future entry in `finally`.

- [ ] **Step 5: Implement key-first `/render-artifact`**

Use form fields `analysis_key`, `render_artifact_key`, `source_content_hash`, optional crop coordinates and optional image. Without live analysis/image return `409 artifact_missing`. With image, verify SHA-256 before `Pipeline.analyze()`. Serialize internal `patch_png` thành trường JSON `patch_rgba` bằng base64 chỉ tại HTTP boundary; response luôn có `schema_version="render-v1"` và `render_artifact_key` đúng request.

Add `render_artifact_key: str | None = Form(None)` to production and acceptance `/ocr-stream`. In production, after analysis succeeds, call `ensure_render()` before yielding/iterating OCR only when the field is present, so cleaning overlaps recognition without breaking the still-legacy extension caller.

Update both endpoint forms and their direct test callers in this task, but keep the field optional until Task 8 wires the extension caller and then makes it required in both apps. Both health endpoints expose the same two version domains. Keep Task 14 for deterministic render payloads, metrics and cache headers, so the existing protocol test suite is green at this checkpoint.

- [ ] **Step 6: Split version payloads**

In `server/config.py`:

```python
PIPELINE_VERSIONS = {
    "detector": "comic-text-detector-v1",
    "dedupe": "iou-0.5-area-clamp-exact-v3",
    "prep": "upscale48-border8-v1",
    "region_resolver": "light-component-v1",
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
PATCH_VERSIONS = {
    "cleaner": "telea3-feather2-v1",
    "render_encoding": "png-rgba-v1",
    "render_schema": "render-v1",
}
```

Keep the existing recognizer, prompt and page-schema values verbatim in this task. Task 5 bumps only `region_resolver` in the page domain and introduces `PATCH_VERSIONS`; Task 6 bumps the prompt with its implementation, and Task 7 bumps `page_schema` at both identity owners. `/health` returns both objects.

- [ ] **Step 7: Run green tests**

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_render_artifact.py server/tests/test_ocr_stream.py server/tests/test_health.py server/tests/test_acceptance_app.py -q
```

Expected: PASS.

- [ ] **Step 8: Review checkpoint**

Inspect that translation/model/prompt values never participate in server render cache keys or cleaner output.

---

### Task 6: Mở rộng dịch toàn trang với phân loại SFX nghiêm ngặt

**Files:**
- Modify: `server/contracts.py:8-34`
- Modify: `server/translator.py:22-165`
- Modify: `server/main.py:157-184`
- Modify: `server/config.py:11-25`
- Modify: `server/tests/test_translator.py`
- Modify: `server/tests/test_translate_endpoint.py`
- Modify: `server/tests/test_health.py`

**Interfaces:**
- Consumes: unchanged request item fields `id,text,reading_order,bbox`.
- Produces: exact response item `{id, kind: "text"|"sfx", translation: str|null}` and prompt v3.

- [ ] **Step 1: Write strict normalizer red tests**

Add:

```python
def test_normalize_items_preserves_text_and_sfx_null():
    assert tr._normalize_items([
        {"id": "b2", "kind": "sfx", "translation": None},
        {"id": "b1", "kind": "text", "translation": "xin chào"},
    ], ["b1", "b2"]) == [
        {"id": "b1", "kind": "text", "translation": "xin chào"},
        {"id": "b2", "kind": "sfx", "translation": None},
    ]
```

Parametrize invalid pairs: `text/null`, `text/empty`, `sfx/string`, invalid kind, extra/missing key, duplicate/missing/foreign ID.

- [ ] **Step 2: Write endpoint/prompt red tests**

Assert `/translate-items` returns JSON null, never `"None"`, and `ITEM_PROMPT` explicitly requests exact keys plus conditional null. Assert input projected to Gemini still has only the four existing request fields. Assert production `/health` advertises `versions.prompt == "comic-page-items-v3"` only with this new prompt contract.

- [ ] **Step 3: Run red tests**

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_translator.py server/tests/test_translate_endpoint.py server/tests/test_health.py -q
```

Expected: FAIL on the old two-field response, `str(None)` coercion, and the still-v2 prompt identity.

- [ ] **Step 4: Implement one shared strict normalizer**

Replace the assignment at current `_normalize_items()` line 64 with validation before coercion:

```python
kind = item["kind"]
translation = item["translation"]
if kind == "text":
    if not isinstance(translation, str) or not translation.strip():
        raise ValueError("text translation must be a non-empty string")
elif kind == "sfx":
    if translation is not None:
        raise ValueError("sfx translation must be null")
else:
    raise ValueError("invalid translation kind")
rows[item_id] = {"kind": kind, "translation": translation}
```

Both Gemini decode and `server/main.py` response pass through this helper. Do not add a second parser.

- [ ] **Step 5: Update prompt and tests**

Prompt tells Gemini to classify sound-effect lettering as `sfx`, keep dialogue/narration as `text`, return each input ID once, and emit null only for SFX. Keep one retry and full-page context unchanged. In the same change, set `PIPELINE_VERSIONS["prompt"] = "comic-page-items-v3"`; do not advertise v3 before the prompt/normalizer exists.

- [ ] **Step 6: Run green tests**

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_translator.py server/tests/test_translate_endpoint.py server/tests/test_health.py -q
```

Expected: PASS.

- [ ] **Step 7: Review checkpoint**

Inspect the HTTP response and hot-cache payload types: no string coercion may occur after normalization.

---

### Task 7: Persist `page-v2` nghiêm ngặt và invalidation chọn lọc

**Files:**
- Modify: `extension/page-cache.js:1-315`
- Modify: `extension/test/page-cache.test.js`
- Modify: `server/config.py:11-25`
- Modify: `server/acceptance_app.py:284-303`
- Modify: `server/tests/test_health.py`
- Modify: `server/tests/test_acceptance_app.py`

**Interfaces:**
- Consumes: `versions`, `patch_versions`, `LAYOUT_FIT_VERSION`, PageRow/RenderBlock shapes from the spec.
- Produces: validated PageRow round-trip, simultaneous `page-v2` identity at extension/production/acceptance health, manifest absent/empty distinction, ready/sentinel render validation, selective purge.

- [ ] **Step 1: Write a full round-trip red test with fixed clock**

Build a `page-v2` row containing text, SFX, vertical/reading order, manifest, mismatch count and ready render. Include the existing operational fields `analysis_known`, `image_w`, `image_h`, `source_url`, `natural_width`, `natural_height`, `crop`, `created_at`, `updated_at`, `last_accessed_at` and `last_error`. Assert `putPage()` then `getPage()` deep-equals expected metadata with a fixed clock, including:

```javascript
assert.strictEqual(roundTripped.analysis_known, true);
assert.strictEqual(roundTripped.image_w, 800);
assert.strictEqual(roundTripped.image_h, 1200);
assert.strictEqual(Object.hasOwn(withoutManifest, "manifest_ids"), false);
assert.deepStrictEqual(allSfx.manifest_ids, []);
```

- [ ] **Step 2: Write red validator tests**

Assert rejection of invalid `kind`, missing/non-boolean `vertical`, negative/non-integer `reading_order`, `in_place` without layout, `skip` without reason, ready render with block-ID mismatch, and sentinel with non-empty blocks. Assert `patch_rgba` is silently impossible to persist because it is not in the allowlist.

- [ ] **Step 3: Write red invalidation tests**

Cover:

- ES recognizer bump preserves JA PageRow.
- cleaner bump preserves PageRow/translations and removes stale render only.
- `LAYOUT_FIT_VERSION` mismatch keeps patch ID/fit bbox but runtime treats the cached layout profile as unavailable until remeasure.
- page schema/prompt/layout-order mismatch purges PageRow.

- [ ] **Step 4: Run red tests**

```powershell
node --test extension/test/page-cache.test.js
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_health.py server/tests/test_acceptance_app.py -q
```

Expected: FAIL because page-v2 fields/selective comparison do not exist and the two health sites still advertise page-v1.

- [ ] **Step 5: Implement exact allowlists**

Set `PAGE_SCHEMA = "page-v2"`, `PIPELINE_VERSIONS["page_schema"] = "page-v2"`, and the acceptance `/health` page-schema value to `"page-v2"` in the same task. Add dedicated validators `storedTranslationBlock`, `storedRenderBlock`, `storedRenderSubrecord`, and `storedManifestIds`; do not pass nullable enum/number fields through `copyStrings()`.

`storedTranslationBlock()` phải allowlist tường minh toàn bộ `block_id`, `bbox`, `src_text`, `trans_text`, `kind`, `vertical`, `reading_order`, `state`. Page allowlist là phần mở rộng nghiêm ngặt của `storedPage()` hiện tại: ngoài `schema_version`, hai object version, năm identity field (`page_artifact_key`, `analysis_key`, `ocr_key`, `render_artifact_key`, `source_content_hash`), language/direction/state, `ocr_done`, `blocks`, optional `manifest_ids`, `manifest_mismatch_count` và optional `render`, phải giữ và validate tường minh `analysis_known` (boolean), `image_w`/`image_h` (nullable finite number), `source_url`, `natural_width`/`natural_height`, `crop`, `created_at`, `updated_at`, `last_accessed_at` và `last_error`. Dùng nhánh nullable-number tương đương `copyNumbers(..., ["image_w", "image_h"])`; không suy allowlist toàn phần chỉ từ khối PageRow liệt kê các field mới trong spec. Render validator giữ mọi field trong contract `RenderSubrecord`/`RenderBlock` đã duyệt; không dùng object spread tại persistence boundary.

Use:

```javascript
if (record.manifest_ids !== undefined) value.manifest_ids = storedManifestIds(record.manifest_ids);
```

Never default absent manifest to `[]`.

- [ ] **Step 6: Implement version-domain comparison**

`pageVersionsEqual(row.versions, liveVersions, row.src_lang)` compares page-affecting scalar versions and only `recognizers[row.src_lang]`. `patch_versions` mismatch invalidates `render`, not PageRow. A stale `layout_fit_version` leaves patch metadata stored but background must ignore the old layout profile.

- [ ] **Step 7: Run green tests**

```powershell
node --test extension/test/page-cache.test.js
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_health.py server/tests/test_acceptance_app.py -q
```

Expected: PASS.

- [ ] **Step 8: Review checkpoint**

Inspect serialized storage JSON and assert no base64 PNG/`patch_rgba` value exists.

---

### Task 8: Thêm source fetch/hash dùng chung và công thức key mới

**Files:**
- Create: `extension/source-fetch.js`
- Create: `extension/test/source-fetch.test.js`
- Modify: `extension/background.js:1-121,397-625,899-939`
- Modify: `extension/test/background-progressive.test.js`
- Modify: `extension/test/progressive-integration.test.js`
- Modify: `server/main.py:88-156`
- Modify: `server/acceptance_app.py:335-394`
- Modify: `server/tests/test_ocr_stream.py`
- Modify: `server/tests/test_acceptance_app.py`

**Interfaces:**
- Produces: `MangaSourceFetch.create({fetchImpl, cryptoImpl, maxConcurrent})`, `pool.acquire(url) -> {promise, release}`, async `buildKeys(descriptor, sourceIdentity, versions, patchVersions)`, and the required end-to-end `/ocr-stream` render-key contract.
- Consumes: descriptor source URL/crop, `/health` version siblings, and the optional `/ocr-stream` compatibility seam from Task 5.

- [ ] **Step 1: Write source-pool red tests**

Test exact behavior:

```javascript
const first = pool.acquire("https://x/page.jpg");
const second = pool.acquire("https://x/page.jpg");
assert.strictEqual(first.promise, second.promise);
first.release();
assert.strictEqual(aborted, false);
second.release();
assert.strictEqual(aborted, true);
```

Add a deferred fetch fixture proving at most two URLs active, FIFO start, crop does not affect dedupe, and SHA-256 is over exact bytes.

- [ ] **Step 2: Write background key red tests**

Assert same bytes/different URL yield same analysis key, same URL/different bytes yield different key, resolver bump changes analysis key, and dst/prompt/model changes do not alter render key. Capture the extension `/ocr-stream` FormData and assert it contains the exact `render_artifact_key` returned by `buildKeys()`. Add production and acceptance API tests asserting omission becomes `422` only after the caller is wired.

- [ ] **Step 3: Run red tests**

```powershell
node --test extension/test/source-fetch.test.js extension/test/background-progressive.test.js extension/test/progressive-integration.test.js
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_ocr_stream.py server/tests/test_acceptance_app.py -q
```

Expected: FAIL because source identity is currently URL/natural dimensions, fetches are not pooled, the extension omits the render key, and both endpoints still accept that omission.

- [ ] **Step 4: Implement the focused pool**

`source-fetch.js` is DOM/Chrome independent and exports exactly `globalThis.MangaSourceFetch = { create }`, matching the loading pattern of `reading-order.js`. Add it to the existing top-level `importScripts("page-cache.js", "reading-order.js", "source-fetch.js")`. Each URL entry owns `{controller, refs, promise}`. The pool counter/queue is separate from producer `MAX_CONCURRENT`; use `MAX_SOURCE_FETCH=2`.

- [ ] **Step 5: Wire identity without serializing scope admission**

At `acceptScope`, acquire all job identities first. Iterate original job order, await only that row's identity, call `attachDescriptor` and `admitRequestJobs` immediately, then continue. Hold the acquisition until producer/replay no longer needs fallback blob; release on request/producer teardown.

On source failure emit `source_unavailable`, set page metric, leave existing cache untouched and allow the next visit to retry.

- [ ] **Step 6: Replace key formulas**

Implement the exact Spec C formulas and include `region_resolver` in `analysis_key`. `page_artifact_key` excludes all patch versions. `render_artifact_key` excludes language/model/prompt and includes only `analysis_key` plus `patch_versions`.

Define `const LAYOUT_FIT_VERSION = "dom-fit-10px-v1"` trong background. Đưa nó vào render subrecord/event/metric identity, nhưng không đưa vào `/health`, `analysis_key`, `ocr_key`, `page_artifact_key` hoặc `render_artifact_key`; content chỉ echo giá trị nhận từ event, không sở hữu một constant trùng lặp.

Preserve contract validity in this exact order inside the task:

1. Store `renderArtifactKey` on the producer and append `form.append("render_artifact_key", producer.renderArtifactKey)` in `openOcrStream()` for every extension call; update every direct production/acceptance test caller in the same change.
2. Only after those callers send the field, change production and acceptance to `render_artifact_key: str = Form(...)` and make production `ensure_render()` unconditional after analysis. Remove the optional Task 5 branch.

- [ ] **Step 7: Run green tests**

```powershell
node --test extension/test/source-fetch.test.js extension/test/background-progressive.test.js extension/test/progressive-integration.test.js
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_ocr_stream.py server/tests/test_acceptance_app.py -q
```

Expected: PASS.

- [ ] **Step 8: Review checkpoint**

Inspect abort paths for supersede/disconnect: abort only the final URL consumer, never every crop/request sharing the fetch. Also inspect the captured FormData and both endpoint signatures: no reachable extension `/ocr-stream` call may omit `render_artifact_key` when the server makes it required.

---

### Task 9: Join translation với RenderArtifact trong producer

**Files:**
- Modify: `extension/background.js:410-850`
- Modify: `extension/test/background-progressive.test.js`
- Modify: `extension/test/progressive-integration.test.js`

**Interfaces:**
- Consumes: source identity, page/render keys, `/render-artifact`, strict translation items and `page-v2`.
- Produces: `manifest_ids`, filtered render candidates, atomic `translation` event payload, one cheap render key-call on warm replay.

- [ ] **Step 1: Extend the fake server and write red producer tests**

Fake `/health` returns both version objects. Fake `/render-artifact` supports key hit, `409` then blob retry, delay and manifest mismatch. Add scenarios:

- translation and render finish in either order but no `translation` event occurs until both are ready;
- SFX is persisted with `kind="sfx", trans_text=null` but absent from manifest/event;
- all-SFX page has `manifest_ids=[]` and no translation event;
- warm PageRow makes one render key-call, zero Gemini calls;
- unbounded/capability skip remains translated in PageRow but emits no render event.

- [ ] **Step 2: Run red tests**

```powershell
node --test extension/test/background-progressive.test.js extension/test/progressive-integration.test.js
```

Expected: FAIL because producer emits text immediately and has no render stage/manifest.

- [ ] **Step 3: Add render-stage ownership**

Create `fetchRenderArtifact(producer)` using key-first POST and one blob retry on `409 artifact_missing`. The producer owns `translationReady` and `renderReady`; terminal state depends on server artifacts, never a content ACK.

- [ ] **Step 4: Make translation application data-only until join**

`applyTranslation()` validates/stores `{kind, trans_text}`. After the exact full-page result, set:

```javascript
page.manifest_ids = orderedBlocks
  .filter((block) => block.kind === "text")
  .map((block) => block.block_id);
```

Hot cache stores `{kind, translation}` and is used only when every item for the same context hash exists.

- [ ] **Step 5: Emit only renderable manifest candidates**

Join artifact blocks by ID, preserve set-based artifact-superset validation, then post `translation` with `patch_id`, `patch_rgba` base64, `patch_mime`, patch bbox, fit bbox, vertical, text, `layout_fit_version` and cached layout hint. Do not emit SFX, `skip` or any text without patch/fit geometry.

- [ ] **Step 6: Split replay gate from terminal fast path**

Implement the approved seam:

```javascript
const hasManifest = Object.hasOwn(page, "manifest_ids");
const terminalHit = hasManifest && page.state === "complete" && page.ocr_done === true;
```

`replayPage()` uses `hasManifest` and manifest membership to emit blocks. Only `terminalHit` performs `completeJob/removeJob/return`; partial rows attach to a producer and continue recovery.

- [ ] **Step 7: Run green tests**

```powershell
node --test extension/test/background-progressive.test.js extension/test/progressive-integration.test.js
```

Expected: PASS.

- [ ] **Step 8: Review checkpoint**

Inspect that cleaner failure never triggers a Gemini call and render versions never alter translation cache keys.

---

### Task 10: Thay bbox trắng bằng DOM patch+text nguyên tử

**Files:**
- Modify: `extension/content.js:108-172`
- Modify: `extension/overlay.css:1-22`
- Modify: `extension/test/content.test.js`
- Modify: `extension/test/content-progressive.test.js`

**Interfaces:**
- Consumes: renderable `translation` event from Task 9.
- Produces: one `.mt-render-block` commit, best-effort `render_metric`, cached layout hint revalidation.

- [ ] **Step 1: Upgrade the fake DOM and write atomic red tests**

Extend existing `createElement` fake with `className`, `textContent`, `clientWidth/Height`, `scrollWidth/Height`, controllable image `decode()`, and append-call tracking. Hold `decode()` on a deferred promise and assert no wrapper/text is visible before it resolves; change the image source binding while held and assert the stale block never mounts. Assert one successful event creates exactly:

```text
.mt-render-block
  .mt-clean-patch
  .mt-translated-text
```

and the wrapper is appended only after patch decode, both children and final layout exist. A rejected decode mounts neither child and leaves the collector incomplete, so no stale ready render is persisted; it must not be coerced into a permanent capability reason.

- [ ] **Step 2: Write overflow and stale-profile red tests**

Simulate text that fits at 12px, text that still overflows at 10px, and a cached 18px profile invalid after resize. Assert fit failure mounts neither child and posts:

```javascript
{ type: "render_metric", painted: false, reason: "fit_failed", layout_profile: null }
```

- [ ] **Step 3: Run red tests**

```powershell
node --test extension/test/content.test.js extension/test/content-progressive.test.js
```

Expected: FAIL because `.mt-bubble` mounts text immediately with white background/hidden overflow.

- [ ] **Step 4: Implement detached measurement and atomic commit**

Replace `fitText()` with a function returning either `{font_px, line_height}` or `null`. Start from a valid cached hint or 18px, decrement to 10px, and test both scroll dimensions. Build the patch `<img>` from `data:${patch_mime};base64,${patch_rgba}` and await `decode()` before appending anything visible. Measure text before appending the visible wrapper.

Use one page-to-render geometry calculation for wrapper, patch and fit bbox. Never round patch/text independently. Revalidate cached profile for every current viewport/zoom, and call `validBinding(event)` again immediately before the single visible append because image decode/layout measurement are asynchronous.

- [ ] **Step 5: Replace CSS**

Remove `.mt-bubble` visual behavior. Add:

```css
.mt-render-block { position: absolute; overflow: visible; background: transparent; }
.mt-clean-patch { position: absolute; pointer-events: none; }
.mt-translated-text { position: absolute; overflow: visible; background: transparent; }
```

Keep existing overlay root pointer-event and z-index behavior unless a test proves it must change.

- [ ] **Step 6: Post render feedback without terminal ACK semantics**

After success/failure, post page/render/layout identity, block ID, `painted`, reason and layout profile. Mark `first_overlay_ms` only after visible wrapper commit.

- [ ] **Step 7: Run green tests**

```powershell
node --test extension/test/content.test.js extension/test/content-progressive.test.js
```

Expected: PASS.

- [ ] **Step 8: Review checkpoint**

Search `extension` for `.mt-bubble`, opaque white backgrounds and translated-text `overflow:hidden`; expected render path has none.

---

### Task 11: Persist kết quả render ready và chặn manifest mismatch recovery

**Files:**
- Modify: `extension/background.js:402-850,955-984`
- Modify: `extension/page-cache.js`
- Modify: `extension/test/background-progressive.test.js`
- Modify: `extension/test/page-cache.test.js`

**Interfaces:**
- Consumes: `render_metric`, `manifest_ids`, RenderArtifact and page-v2 validators.
- Produces: ready render subrecord, breaker sentinel, one paid mismatch recovery per PageRow.

- [ ] **Step 1: Write collector red tests**

Assert background persists render only after outcomes for the entire manifest. Disconnect/supersede before the final result leaves `render` absent and does not block producer terminal. Late metric with stale page/render/layout identity cannot update the row.

- [ ] **Step 2: Write mismatch-breaker red tests**

Cover exact state transitions:

```text
missing/stale render -> render-only rebuild, count remains 0
fresh mismatch count 0 -> persist count 1 before paid recovery
recovery success -> new PageRow still count 1
fresh mismatch count 1 -> breaker_open=true, blocks=[]
same sentinel revisit -> no analysis/clean/Gemini
patch bump -> render-only retry, count stays 1
```

- [ ] **Step 3: Run red tests**

```powershell
node --test extension/test/page-cache.test.js extension/test/background-progressive.test.js
```

Expected: FAIL because render collector/count/sentinel do not exist.

- [ ] **Step 4: Implement the identity-guarded collector**

Keep ephemeral outcomes keyed by `[page_artifact_key, render_artifact_key, layout_fit_version]`. Canonicalize completed RenderBlocks in `manifest_ids` order. Persist only a full ready set; no partial render subrecord.

- [ ] **Step 5: Implement mismatch state machine**

Compare fresh artifact using `manifest subset-of artifact IDs`. Persist count `1` with `await pageCache.putPage(page)` before starting paid recovery. On repeat, persist `{breaker_open:true, blocks:[]}`; validator explicitly exempts sentinel from ready set-equality.

- [ ] **Step 6: Run green tests**

```powershell
node --test extension/test/page-cache.test.js extension/test/background-progressive.test.js
```

Expected: PASS.

- [ ] **Step 7: Review checkpoint**

Inspect every mismatch path for persist-before-network ordering and absence of render/page deletion that would reset the count.

---

### Task 12: Thêm OCR-recovery ledger persist và eviction có bảo vệ

**Files:**
- Modify: `extension/page-cache.js:1-315`
- Modify: `extension/background.js:415-625,785-850`
- Modify: `extension/test/page-cache.test.js`
- Modify: `extension/test/background-progressive.test.js`

**Interfaces:**
- Produces: `claimOcrRecovery(ocrKey, protectedPageKey) -> boolean`, ledger prefix `mt:ocr-recovery:`, schema `ocr-recovery-v1`.
- Consumes: partial PageRow with manifest and existing OCR singleflight keyed by `ocr_key`.

- [ ] **Step 1: Write ledger red tests**

Assert absence claims once, presence returns false, claim persists before callback/network, 8MiB accounting includes ledgers, protected page cannot be evicted, wrong ledger schema is purged, and orphan ledger is GC'd after its last referencing PageRow disappears.

- [ ] **Step 2: Write partial-replay recovery red tests**

Create `partial + manifest + ocr_done=false` PageRow. Assert translation replay occurs first, no early `image_done/removeJob`, claim is written before `/ocr-stream`, and recovery failure preserves delivered overlay. Revisit with used ledger must replay and terminal without another OCR POST. New `ocr_key` gets a new budget; new prompt/dst does not.

- [ ] **Step 3: Run red tests**

```powershell
node --test extension/test/page-cache.test.js extension/test/background-progressive.test.js
```

Expected: FAIL because ledger APIs and partial recovery state do not exist.

- [ ] **Step 4: Implement storage methods**

Add `OCR_RECOVERY_PREFIX` and exact schema validator. Extend `_evictFor(key, value, protectedPageKey)` so both `key` and protected page are excluded; ledgers are never eviction candidates. On claim write failure, throw `CacheFullError` and return to caller without network.

- [ ] **Step 5: Implement partial state machine**

After manifest replay, if the OCR identity is incomplete and the claim succeeds, force producer `ocr_done=false`, attach OCR/analysis stages and run one recovery. If ledger already exists, do not call `/ocr-stream` or Gemini; terminal the visit using delivered count while leaving persistent page/ledger state intact.

If recovery yields a new/changed block snapshot, run one full-page translation for the updated exact item set. If block snapshot is unchanged, reuse the authoritative manifest/translation and skip Gemini.

- [ ] **Step 6: Run green tests**

```powershell
node --test extension/test/page-cache.test.js extension/test/background-progressive.test.js
```

Expected: PASS.

- [ ] **Step 7: Review checkpoint**

Count every network branch for one `ocr_key`: across repeated visits, recovery POST count must be at most one.

---

### Task 13: Đếm delivery và rehydrate offline theo từng job

**Files:**
- Modify: `extension/background.js:397-457,780-941`
- Modify: `extension/test/background-progressive.test.js`

**Interfaces:**
- Produces: `request.deliveredByJob: Map<jobId, Set<blockId>>`, per-consumer terminal payload, merged offline request object.
- Consumes: translation event sites, `completeJob`, producer consumers and job ledger.

- [ ] **Step 1: Write delivery red tests**

Cover cache hit with mixed text/SFX, all-SFX zero delivery, failure before any event, failure after partial replay, disconnected consumer and duplicate terminal. Assert ID is counted only after successful `postMessage` at the emit loop and direct replay site.

- [ ] **Step 2: Write the exact two-job rehydrate/replacement gate**

Fixture requirements:

- two visible queued jobs share one request ID;
- two `state="partial"`, `ocr_done=false`, `manifest_ids` absent PageRows use page-v2/current health and distinct page keys;
- await `ready`, assert offline count 0, one request object, two delivered sets/jobs/producers;
- hold both at OCR, replace with nonmatching source/crop;
- assert both producers have zero consumers, remain unretired/in map, old request removed and old ledgers retained;
- release both; assert each terminals once and both ledgers are eventually removed.

- [ ] **Step 3: Run red tests**

```powershell
node --test extension/test/background-progressive.test.js
```

Expected: FAIL on missing delivered map and one-request-per-offline-job behavior.

- [ ] **Step 4: Seed and record delivery**

`createRequest()` seeds an empty Set for every expected job. Add block ID only inside a per-consumer successful translation post and inside successful `replayPage()` post. Cache-hit `translated` uses that Set; `recognized` remains total OCR blocks.

- [ ] **Step 5: Make terminal events per consumer**

In finish/fail loops:

```javascript
const req = requests.get(consumer.requestId);
if (!req || req.done.has(consumer.jobId)) continue;
const translated = req.deliveredByJob.get(consumer.jobId).size;
if (req.connected && consumer.port) consumer.port.postMessage(imageDonePayload);
completeJob(req, consumer.jobId, translated, failed, hit, metrics, counters, producer, meta);
```

Send `image_done` before `completeJob`; remove shared broadcast.

- [ ] **Step 6: Merge offline request rows**

`offlineLedger()` reuses `requests.get(request_id)`, merging expected IDs, empty delivered Sets, jobs and `jobsBySourceCrop`. Complete the full startup restore loop before `resumeOfflineJobs()`.

- [ ] **Step 7: Run green tests**

```powershell
node --test extension/test/background-progressive.test.js
```

Expected: PASS.

- [ ] **Step 8: Review checkpoint**

Inspect that `jobsBySourceCrop` of the old request is not used to decide replacement; only the replacement request's map is authoritative.

---

### Task 14: Hoàn tất telemetry, acceptance protocol và gate tái lập được

**Files:**
- Modify: `server/acceptance_app.py:14-419`
- Modify: `server/tests/test_acceptance_app.py`
- Modify: `extension/background.js:14-61,486-513,955-984`
- Modify: `extension/content.js:99-167`
- Modify: `extension/test/fixture.html`
- Modify: `extension/test/background-progressive.test.js`
- Modify: `extension/test/progressive-integration.test.js`
- Modify: `extension/test/fixture-benchmark.js`
- Modify: `extension/test/fixture-benchmark.test.js`

**Interfaces:**
- Produces: `atomic_patch_v1` page metrics, synthetic `/render-artifact`, exact golden render coverage and route-specific cache headers.

- [ ] **Step 1: Write telemetry red tests**

Assert every PageMetric has `overlay_semantics`, `partial_replay`, `cache_hit`, `analysis_cache_hit`, `render_wait_after_translation_ms`, coverage/reason counts, mismatch/source flags and error code. Assert late render metric updates timestamp only, strict cold filter excludes null/cache/partial rows, and empty cohort yields null percentile.

- [ ] **Step 2: Write acceptance-app red tests**

Assert production-compatible `/health`, `/ocr-stream` vertical field, strict text/SFX `/translate-items`, key-first `/render-artifact`, and deterministic clean/skip candidates. Serve benchmark asset with `public, max-age=31536000, immutable`; keep fault/control asset `no-store`.

- [ ] **Step 3: Freeze exact synthetic golden outcomes**

Use acceptance pages A-D for: renderable text, SFX, unsupported narration and fit failure. Assert exact manifest/rendered/skip ID sets and `render_coverage = rendered / manifest_ids`; SFX never enters the denominator.

- [ ] **Step 4: Run red tests**

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_acceptance_app.py -q
node --test extension/test/background-progressive.test.js extension/test/progressive-integration.test.js extension/test/fixture-benchmark.test.js
```

Expected: FAIL on old protocol/metric/header semantics.

- [ ] **Step 5: Implement metric ownership**

Content measures from `pendingScopes.startedAt` to atomic wrapper commit. Background labels partial/cache/analysis cohorts when receiving metric. Scope-level minima remain diagnostics; exporter flattens `page_metrics[]` and applies strict `=== false` filters.

- [ ] **Step 6: Implement acceptance protocol**

Reuse `config.PIPELINE_VERSIONS` and `config.PATCH_VERSIONS` in acceptance health. Add deterministic base64 RGBA patch responses and text/SFX classification. Select `Cache-Control` by route/mode instead of one module-level `ASSET_HEADERS` value.

- [ ] **Step 7: Run green tests**

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_acceptance_app.py -q
node --test extension/test/background-progressive.test.js extension/test/progressive-integration.test.js extension/test/fixture-benchmark.test.js
```

Expected: PASS.

- [ ] **Step 8: Review checkpoint**

Verify old text-only samples cannot enter `atomic_patch_v1` percentiles and benchmark assets are cacheable on a clean profile.

---

### Task 15: Chạy Gate A-G, visual QA và ghi bằng chứng

**Files:**
- Create: `docs/superpowers/worklogs/2026-08-09-in-place-clean-overlay-rendering.json`
- Modify only after evidence: `docs/superpowers/specs/2026-08-08-in-place-clean-overlay-rendering-design.md` status line

**Interfaces:**
- Consumes: completed Tasks 1-14.
- Produces: command outputs, gate results, benchmark cohorts and manual visual evidence; no unverified PASS.

- [ ] **Step 1: Run all server tests except the prohibited real OCR module**

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests --ignore=server/tests/test_ocr.py -q
```

Expected: PASS with zero failures.

- [ ] **Step 2: Run the complete extension suite**

```powershell
node --test extension/test/background.test.js extension/test/background-progressive.test.js extension/test/page-cache.test.js extension/test/source-fetch.test.js extension/test/reading-order.test.js extension/test/srcset.test.js extension/test/content.test.js extension/test/content-progressive.test.js extension/test/popup.test.js extension/test/progressive-integration.test.js extension/test/fixture-benchmark.test.js
```

Expected: PASS with zero failures.

- [ ] **Step 3: Start the acceptance server for visual QA**

```powershell
$acceptanceProcess = Start-Process -FilePath 'D:\MangaTranslator\venv\Scripts\python.exe' -ArgumentList '-m','uvicorn','server.acceptance_app:app','--host','127.0.0.1','--port','8910' -WindowStyle Hidden -PassThru
$acceptanceProcess.Id
```

Open the existing acceptance fixture through Chrome extension controls. Do not bypass popup/extension policy with raw CDP injection.

- [ ] **Step 4: Verify UI outcomes manually or through the approved Chrome control surface**

Record evidence for:

- renderable text: no original ink, no rectangular white box, no visible seam;
- scale/zoom: patch and text share geometry, no 1px clipping;
- long text: shrinks to exactly 10px inside the speech bubble, with `scrollWidth <= clientWidth` and `scrollHeight <= clientHeight`; keep `fit_failed` as a unit-level defensive check, not a visual acceptance fixture;
- SFX: original remains and no translated text/patch appears;
- partial replay followed by recovery failure: mounted overlay remains;
- all-SFX cache hit: `image_done` precedes `scope_done` and translated count is 0.

- [ ] **Step 5: Run reproducible latency gates**

Collect `page_metrics[]` only. Assert warm `atomic_patch_v1 first_overlay_ms.p95 <= 100`, cold `render_wait_after_translation_ms.p95 <= 100`, and report cold p50/p95 for the strict four-condition cohort. An empty cohort is a failed measurement setup, not percentile 0.

- [ ] **Step 6: Stop only the acceptance process created by this task**

```powershell
if ($acceptanceProcess -and -not $acceptanceProcess.HasExited) {
    Stop-Process -Id $acceptanceProcess.Id
}
```

Do not stop an unrelated process that was already listening on port 8910; if startup failed because the port was occupied, record that condition and use the existing server only after verifying its `/health` versions.

- [ ] **Step 7: Write the worklog from actual evidence**

The JSON worklog records commit/branch, interpreter path, Node/Python commands, counts, fixture IDs, metric cohorts, gate A-G status, known late-consumer limitation and whether visual QA was manual or tool-assisted.

- [ ] **Step 8: Update spec status only if every required gate passed**

If any gate failed or visual QA was unavailable, leave the spec status unchanged and record the exact blocker. If all passed, change only the status line to implemented/verified with a link to the worklog.

- [ ] **Step 9: Final review checkpoint**

Run:

```powershell
git diff --check
git status --short
```

Confirm no model files, generated debug PNGs, unrelated dirty files or patch bitmap cache data are included. Do not stage or commit without explicit user approval.

---

## Ma trận coverage của Spec C

| Spec/Gate | Implemented by |
|---|---|
| Gate A — detector, coordinates, resolver | Tasks 1-3 |
| Gate B — patch, fit, atomic UI | Tasks 4, 9-10, 14-15 |
| Gate C — translation and page-v2 | Tasks 6-7, 9, 13 |
| Gate D — source/key/version/cache | Tasks 1, 5, 7-8 |
| Gate E — manifest and recovery breakers | Tasks 11-12 |
| Gate F — delivery, partial replay, rehydrate | Tasks 9, 12-13 |
| Gate G — telemetry and performance | Tasks 10, 14-15 |
| Production/acceptance version parity | Tasks 5 and 14 |
| No SFX translation/paint | Tasks 6, 9-10, 14-15 |
| No unlimited retry/rebuild | Tasks 11-12, 15 |

## Checkpoint triển khai

- After Task 5: server can analyze/OCR/render independently; UI remains legacy.
- After Task 7: strict translation/page-v2 contracts are reviewable before browser orchestration changes.
- After Task 10: cold atomic UI vertical slice works without recovery hardening.
- After Task 13: all persistent breakers, terminal accounting and rehydrate invariants are closed.
- After Task 15: only evidence-backed rollout decision remains.
