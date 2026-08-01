# Telemetry + Real-page Fixture Quality Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tạo telemetry đúng theo từng trang, một bộ fixture trang manga thật có ground truth đã review, và một quality gate offline có thể tái lập để Spec B chọn hoặc bác policy dịch theo bằng chứng.

**Architecture:** Server phát trạng thái cache và wall-time analysis; service worker sở hữu metric row theo `job_id` cùng trace từng call Gemini; content script chỉ bổ sung thời điểm overlay đầu tiên theo đúng job. Sáu ảnh được track tại một nguồn canonical. Một module Python thuần đảm nhiệm schema, batch replay và evaluator; một CLI thủ công dùng Gemini production để tạo capture, còn CI chỉ đọc fixture/capture đã commit.

**Tech Stack:** Chrome Extension Manifest V3 · vanilla JavaScript · Node `assert`/`vm` · Python 3.12 stdlib · FastAPI · pytest · Gemini SDK đã cài · Git/PowerShell.

## Global Constraints

- Thiết kế nguồn: `docs/superpowers/specs/2026-08-01-telemetry-real-fixture-quality-gate-design.md`.
- Không đổi production reading order, microbatch policy, translation guards, prompt, model, cache key, hỗ trợ `pt`, overlay geometry hoặc trạng thái `partial`; các thay đổi đó thuộc Spec B/C.
- Không gửi `kind` cho Gemini. Prompt eval chỉ được nhận `id`, `text`, `reading_order`, `bbox`; kích thước ảnh nằm ở page context.
- Không gọi detector, OCR hoặc Gemini trong CI. Test tự động chỉ dùng fake/static capture.
- Không thêm dependency. Dùng helper/cache/protocol hiện có và Python/Node stdlib.
- Telemetry không chứa source URL, OCR text, translation text hoặc API key.
- `analysis_ms` là duration; `*_done_ms` và `first_*_ms` là elapsed từ producer accepted, trừ `first_overlay_ms`; field này đo từ content scope start để giữ tương thích aggregate/benchmark. Mỗi row có `accepted_offset_ms`; producer-relative overlay xấp xỉ `first_overlay_ms - accepted_offset_ms`; sai số còn lại là IPC + MV3 worker wake. Stage không chạy dùng `null`.
- Mỗi job hoàn tất tạo đúng một row trong `scope_done.page_metrics`, gồm cả warm page-cache hit và lỗi trước producer.
- `first_overlay_ms` per-page là task xuyên `content.js` → message contract → `background.js`; không suy ra từ scope aggregate.
- Fixture dùng port `8000`; API production dùng `8910`. `/health` không phải acceptance OCR → Gemini → overlay.
- Mỗi task kết thúc bằng một commit riêng; không dùng `git add -f`, không commit file tạm/candidate chưa review.

## File Responsibility Map

| File | Trách nhiệm sau thay đổi |
|---|---|
| `server/pipeline.py` | Trả analysis artifact kèm cache-hit thực, kể cả hit sau khi chờ lock |
| `server/main.py` | Đo wall-time analysis, phát contract `analysis_ready`, sửa mojibake cục bộ |
| `extension/background.js` | Metric row per-job, OCR/final translation marks, trace từng Gemini call |
| `extension/content.js` | Đo và gửi first overlay đúng `job_id`; merge số local vào kết quả scope |
| `server/tests/fixtures/real_pages/manifest.json` | Ground truth ảnh, bbox, reading order, transcript, term groups, failure metadata |
| `server/real_page_quality.py` | Validator, IoU matching, policy batching, capture/evaluator thuần deterministic |
| `server/run_real_page_probe.py` | CLI thủ công tạo detector/OCR candidate và Gemini policy capture |
| `docs/superpowers/worklogs/2026-08-01-real-page-quality-baseline.json` | Bằng chứng telemetry, baseline membership, attempt, rubric và quyết định gate |

---

### Task 1: Phát `analysis_ms` và cache-hit đúng từ server

**Files:**
- Modify: `server/pipeline.py:102-143`
- Modify: `server/main.py:82-126,149-171`
- Modify: `server/tests/test_pipeline.py`
- Modify: `server/tests/test_ocr_stream.py`

**Interfaces:**
- Produces: `Pipeline.analyze_with_status(image_bytes, crop, analysis_key) -> tuple[AnalysisArtifact, bool]`.
- Preserves: `Pipeline.analyze(...) -> AnalysisArtifact` cho caller cũ.
- Produces: `analysis_ready.analysis_ms: int >= 0` và `analysis_ready.analysis_cache_hit: bool`.
- Consumes: cache hai lần và `_ocr_lock` hiện có; không thêm lock hay cache mới.

- [ ] **Step 1: Viết test thất bại cho miss, direct hit và hit sau khi chờ lock**

Thêm vào `server/tests/test_pipeline.py` một detector chặn được bằng hai `Event`, chạy hai call cùng `analysis_key` bằng `ThreadPoolExecutor`, rồi assert:

```python
cold_artifact, cold_hit = first.result(timeout=2)
waited_artifact, waited_hit = second.result(timeout=2)

assert cold_hit is False
assert waited_hit is True
assert waited_artifact is cold_artifact
assert detector.calls == 1
```

Thêm ca direct warm:

```python
_, first_hit = pipeline.analyze_with_status(image_bytes, None, "same")
_, second_hit = pipeline.analyze_with_status(image_bytes, None, "same")
assert (first_hit, second_hit) == (False, True)
```

- [ ] **Step 2: Chạy test và xác nhận API chưa tồn tại**

Run:

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_pipeline.py -q
```

Expected: FAIL vì `Pipeline` chưa có `analyze_with_status`.

- [ ] **Step 3: Tách implementation tối thiểu nhưng giữ wrapper cũ**

Trong `server/pipeline.py`, chuyển body hiện tại sang API mới; cả cache hit trước lock và sau lock đều trả `True`, chỉ đường decode + detect trả `False`:

```python
def analyze(self, image_bytes, crop, analysis_key):
    artifact, _ = self.analyze_with_status(image_bytes, crop, analysis_key)
    return artifact

def analyze_with_status(self, image_bytes, crop, analysis_key):
    cached = self.get_analysis(analysis_key)
    if cached is not None:
        return cached, True
    with self._ocr_lock:
        cached = self.get_analysis(analysis_key)
        if cached is not None:
            return cached, True
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
            prepared.append(PreparedRegion(
                stable_block_id(analysis_key, bbox, ordinal), bbox, _prep_crop(crop_rgb)
            ))
        artifact = AnalysisArtifact(
            analysis_key, image_w, image_h, tuple(prepared),
            sum(region.crop_rgb.nbytes for region in prepared),
        )
        self._analysis_cache.put(analysis_key, artifact)
        return artifact, False
```

Không cần tạo `_build_analysis()` chỉ để dùng một lần.

Không tạo `analysis_wait_ms`; wall-time ở handler đã bao gồm lock wait.

- [ ] **Step 4: Viết test stream thất bại cho event contract**

Cập nhật `FakeStreamPipeline` trong `server/tests/test_ocr_stream.py` để có `analyze_with_status`. Parse NDJSON của cold và warm request rồi assert:

```python
assert cold[0]["type"] == "analysis_ready"
assert cold[0]["analysis_cache_hit"] is False
assert isinstance(cold[0]["analysis_ms"], int) and cold[0]["analysis_ms"] >= 0
assert warm[0]["analysis_cache_hit"] is True
```

Thêm fake delayed-hit để chứng minh `analysis_cache_hit is True` không ép `analysis_ms == 0`.

- [ ] **Step 5: Đo wall-time tại đúng ranh handler và sửa mojibake cục bộ**

Trong `server/main.py`, dùng `time.perf_counter()` ngay trước precheck/call và sau khi artifact có sẵn:

```python
analysis_started = time.perf_counter()
artifact = pipeline.get_analysis(analysis_key)
if artifact is None:
    artifact, analysis_cache_hit = await asyncio.to_thread(
        pipeline.analyze_with_status, image_bytes, crop, analysis_key
    )
else:
    analysis_cache_hit = True
analysis_ms = max(0, round((time.perf_counter() - analysis_started) * 1000))
```

Event `analysis_ready` thêm đúng hai field. Sửa chuỗi lỗi mojibake tại `server/main.py:160` thành tiếng Việt UTF-8 dễ đọc; không đổi error code hay control flow.

- [ ] **Step 6: Chạy test mục tiêu và commit**

Run:

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_pipeline.py server/tests/test_ocr_stream.py -q
```

Expected: PASS; detector fake chỉ chạy một lần trong ca cạnh tranh.

Commit:

```powershell
git add server/pipeline.py server/main.py server/tests/test_pipeline.py server/tests/test_ocr_stream.py
git commit -m "feat: report server analysis cache telemetry"
```

---

### Task 2: Tạo metric row per-job và trace từng call Gemini

**Files:**
- Modify: `extension/background.js:10-50,366-462,481-685,799-806`
- Modify: `extension/test/background-progressive.test.js`
- Modify: `extension/test/progressive-integration.test.js`

**Interfaces:**
- Consumes: `analysis_ready.analysis_ms`, `analysis_cache_hit`; OCR `image_done`; translation batch response/error.
- Produces: `scope_done.page_metrics: PageMetricRow[]` và giữ `scope_done.metrics` aggregate.
- Produces: một trace row cho mỗi network Gemini call production hiện tại.
- Preserves: microbatch 3/8 và timer hiện tại; không đổi translation policy.

`PageMetricRow` phải có đúng shape tối thiểu sau:

```javascript
{
  job_id, page_artifact_key, cache_hit, error_code, analysis_cache_hit,
  fetch_ms, analysis_ms, first_ocr_ms, ocr_done_ms,
  first_translation_ms, final_translation_ms, first_overlay_ms, accepted_offset_ms, total_ms,
  recognized, failed, translation_batches
}
```

Mỗi phần tử `translation_batches` có:

```javascript
{
  batch_id, phase: "microbatch", block_ids, block_count,
  started_ms, duration_ms, status, cache_hit, error_code
}
```

- [ ] **Step 1: Viết test thất bại cho cold row đầy đủ và bảo toàn số `0`**

Trong `extension/test/background-progressive.test.js`, cho fake OCR phát `analysis_ms: 0`, `analysis_cache_hit: false`, nhiều block rồi `image_done`. Assert `scope_done.page_metrics`:

```javascript
assert.equal(done.page_metrics.length, 1);
const row = done.page_metrics[0];
assert.equal(row.job_id, "job-1");
assert.equal(row.analysis_ms, 0);
assert.equal(row.analysis_cache_hit, false);
assert.ok(Number.isFinite(row.ocr_done_ms));
assert.ok(Number.isFinite(row.final_translation_ms));
assert.deepEqual(row.translation_batches[0].block_ids, ["b1", "b2", "b3"]);
assert.equal(row.translation_batches[0].status, "success");
```

Assert `ocr_done_ms >= first_ocr_ms`, `final_translation_ms >= first_translation_ms`, duration không âm, và row không có `source_url`, `text`, `trans_text`, `api_key`.

- [ ] **Step 2: Viết test thất bại cho hai nguồn row không có producer**

Tạo hai scenario:

1. `replayPage()` warm hit phải tạo row `cache_hit: true`, có `page_artifact_key`, mọi stage không chạy là `null`.
2. `attachDescriptor()` ném trước producer phải tạo row `cache_hit: false`, `error_code` khớp `job_error`, `page_artifact_key: null` nếu key chưa có.

Trong cả hai ca, assert `page_metrics.length === jobs.length`; không có row giả với `0`.

- [ ] **Step 3: Chạy test và xác nhận contract còn thiếu**

Run:

```powershell
node extension/test/background-progressive.test.js
```

Expected: FAIL vì `scope_done` chưa có `page_metrics`, `producerMetrics()` thiếu mark và `completeJob()` bỏ row khi metrics là `null`.

- [ ] **Step 4: Chuẩn hóa row tại một điểm duy nhất trong `completeJob()`**

Thêm helper nhỏ `emptyPageMetrics()` trả các stage `null`. Giữ nguyên các argument translated/failed/counter hiện có của `completeJob()`; chỉ thêm `meta` ở cuối. Hàm luôn merge default + metadata + metrics và push đúng một lần khi `request.done` chưa có `jobId`:

```javascript
function completeJob(
  request, jobId, translated, failed, hit,
  metrics = null, counters = null, counterProducer = null, meta = {}
) {
  if (!request) return;
  if (request.done.has(jobId)) return;
  request.done.add(jobId);
  request.translated += translated;
  request.failed += failed;
  if (hit) request.hits++;
  request.metricRows.push({
    job_id: jobId,
    page_artifact_key: meta.pageKey ?? null,
    cache_hit: hit,
    error_code: meta.errorCode ?? null,
    ...emptyPageMetrics(),
    ...(metrics || {}),
  });
  // giữ counter/hits/scopeDone hiện có
}
```

`replayPage()` truyền page key cùng OCR summary cache (`recognized = page.blocks.length`, `failed = 0`). Nhánh lỗi `acceptScope()` truyền error code đã phát và key nếu đã tạo; vì OCR chưa chạy nên `recognized`/`failed` trong row vẫn `null`, dù scope failure counter vẫn tăng bằng argument `failed` cũ. Không tạo class/schema library.

- [ ] **Step 5: Ghi OCR marks và batch trace tại event/call hiện có**

- Dùng `Number.isFinite(event.analysis_ms)` thay cho phép fallback dùng toán tử `||` hiện tại để giữ `0`.
- Lưu `analysis_cache_hit` từ event vào stage/producer.
- Khi nhận OCR `image_done`, ghi `recognized`, `failed` và `mark(consumer, "ocr_done")`; consumer attach sau khi stage xong cũng nhận cùng mark tương đối.
- Sau mỗi `applyTranslation()` thành công, gán `producer.timings.final_translation = now()`; đây là latest success, không dùng `??=`.
- Trong `flushTranslationBatch()`, tạo một trace row quanh đúng network call, classify `success`, `rate_limited`, `invalid_response`, `failed`; cache-only path không giả thành network call.
- `block_count` phải bằng `block_ids.length`, không lấy tổng block của producer.

`producerMetrics()` trả thêm `ocr_done_ms`, `final_translation_ms`, OCR summary, `analysis_cache_hit` và bản copy trace. `scopeDone()` phát:

```javascript
request.port?.postMessage({
  type: "scope_done",
  // fields cũ
  metrics,
  page_metrics: request.metricRows,
});
```

Aggregate cũ tiếp tục dùng `Math.max`; thêm `ocr_done_ms` và `final_translation_ms` chỉ để tương thích báo cáo scope, không gọi chúng là metric một trang.

- [ ] **Step 6: Viết test trace cho lỗi và nhiều job**

Thêm fake response cho 429, malformed exact-ID và generic error. Assert mỗi call có đúng một trace với status/error code tương ứng; một trang partial chỉ ra batch gây lỗi. Tạo request hai job và assert row tách theo `job_id`, không bị `Math.max` nhập thành một trang.

Cập nhật `extension/test/progressive-integration.test.js` để contract kết quả chấp nhận `page_metrics` nhưng các field cũ vẫn giữ nguyên.

- [ ] **Step 7: Chạy test và commit**

Run:

```powershell
node extension/test/background-progressive.test.js
node extension/test/progressive-integration.test.js
```

Expected: PASS; test đếm đúng một row/job và đúng một trace/network call.

Commit:

```powershell
git add extension/background.js extension/test/background-progressive.test.js extension/test/progressive-integration.test.js
git commit -m "feat: record per-page pipeline and Gemini telemetry"
```

---

### Task 3: Đưa `first_overlay_ms` về đúng từng trang

**Files:**
- Modify: `extension/content.js:81-145`
- Modify: `extension/background.js:366-462,799-806`
- Modify: `extension/test/content-progressive.test.js`
- Modify: `extension/test/background-progressive.test.js`
- Modify: `extension/test/progressive-integration.test.js`

**Interfaces:**
- Produces message: `{type: "render_metric", request_id, job_id, first_overlay_ms}`.
- Produces: `PageMetricRow.first_overlay_ms` theo job.
- Preserves: `scope_done.metrics.first_overlay_ms` là first overlay sớm nhất của scope cho consumer cũ.
- Constraint: không chờ render metric mới kết thúc producer/scope.

- [ ] **Step 1: Viết test content thất bại cho hai trang render ở hai thời điểm**

Trong `extension/test/content-progressive.test.js`, tạo hai binding cùng request, điều khiển `performance.now()`, render job A rồi job B hai lần. Assert:

```javascript
assert.deepEqual(renderMetrics.map((row) => row.job_id), ["job-a", "job-b"]);
assert.equal(renderMetrics.filter((row) => row.job_id === "job-a").length, 1);
assert.ok(renderMetrics[0].first_overlay_ms < renderMetrics[1].first_overlay_ms);
```

Khi nhận `scope_done`, kết quả trả popup/content caller phải có `page_metrics` với số local đã merge theo job, kể cả message render chưa kịp được background xử lý.

- [ ] **Step 2: Chạy test content và xác nhận message chưa có `job_id`**

Run:

```powershell
node extension/test/content-progressive.test.js
```

Expected: FAIL vì `pendingScopes` mới chỉ giữ một `firstOverlayMs` cho toàn scope.

- [ ] **Step 3: Đo first overlay một lần cho mỗi job trong content**

Khởi tạo:

```javascript
pendingScopes.set(requestId, {
  resolve,
  startedAt: performance.now(),
  firstOverlayMs: null,
  firstOverlayByJob: new Map(),
});
```

Trong `upsertOverlayBlock()`, nếu map chưa có `event.job_id`, ghi elapsed, cập nhật scope minimum và gửi message có `job_id`. Không gửi lại khi block thứ hai cùng job render.

Trong handler `scope_done`, map `event.page_metrics` và chỉ điền `first_overlay_ms` từ local map vào row cùng `job_id`; trả cả `page_metrics` trong result. Không dùng local metric để sửa row job khác.

- [ ] **Step 4: Viết test background thất bại cho metric sớm, metric muộn và job lạ**

Các assertions bắt buộc:

- metric đến trước `completeJob()` xuất hiện trong row khi scope hoàn tất;
- metric đến sau `scopeDone()` patch đúng row đã lưu trong `metricSamplesByRequest`;
- job lạ/stale không thuộc request bị bỏ qua;
- scope aggregate giữ minimum, không phải first-write nếu message đến lệch thứ tự.

- [ ] **Step 5: Lưu per-job metric và patch late sample**

`createRequest()` thêm `firstOverlayByJob: new Map()`. Handler `render_metric` xác nhận `job_id` thuộc request trước khi ghi. `completeJob()` merge map vào row. Khi request đã rời `requests`, tìm sample đã record và patch `sample.page_metrics` theo `job_id`; không tạo row mới.

`recordMetrics()` phải giữ `page_metrics` sanitized cùng scope sample để late metric có đích patch. Không thêm database hay thời gian chờ UI.

- [ ] **Step 6: Chạy ba test JS và commit**

Run:

```powershell
node extension/test/content-progressive.test.js
node extension/test/background-progressive.test.js
node extension/test/progressive-integration.test.js
```

Expected: PASS; hai page có hai `first_overlay_ms` độc lập và scope vẫn báo minimum.

Commit:

```powershell
git add extension/content.js extension/background.js extension/test/content-progressive.test.js extension/test/background-progressive.test.js extension/test/progressive-integration.test.js
git commit -m "feat: attribute first overlay timing per page"
```

---

### Task 4: Đưa sáu ảnh vào fixture canonical và đóng băng ground truth

**Files:**
- Create: `server/tests/fixtures/real_pages/manifest.json`
- Create: `server/tests/fixtures/real_pages/mangadex_pt.png`
- Create: `server/tests/fixtures/real_pages/s-manga_ja_1.png`
- Create: `server/tests/fixtures/real_pages/s-manga_ja_2.png`
- Create: `server/tests/fixtures/real_pages/references/mangadex_pt_overlay_partial_and_crop.png`
- Create: `server/tests/fixtures/real_pages/references/s-manga_ja_overlay_1.png`
- Create: `server/tests/fixtures/real_pages/references/s-manga_ja_overlay_2.png`
- Create: `server/real_page_quality.py`
- Create: `server/tests/test_real_page_quality.py`
- Modify: `server/diagnose.py`

**Interfaces:**
- Produces: one canonical manifest with source pages, failure references, reviewed regions and hashes.
- Produces: `load_manifest(path)`, `validate_manifest(path)`, `match_required_regions(expected, detected, min_iou=0.5)`.
- Preserves: `server/diagnose.py` remains the only detector/OCR diagnostic entrypoint; không tạo tool detector thứ hai.
- Produces: hai option `server.diagnose --device cpu --manifest-candidate`; default device hiện có vẫn được giữ cho caller không truyền option.

Nguồn → đích và hash bắt buộc:

| Đích | Kích thước | SHA-256 |
|---|---:|---|
| `mangadex_pt.png` | 500×782 | `8c25aea5e76a9264d83698ee4953b4e037593a49c05b2517de4ebd14a1d84c60` |
| `s-manga_ja_1.png` | 1107×871 | `267ac9ea29bdf0bfbb3686e2806a77b0c52d1178f2810c426ba357b277976023` |
| `s-manga_ja_2.png` | 1105×868 | `7d6867a5c37db97d1f6ce32d5e5fd082d3bf3ac8e9f6914a2497b51f1fd0b9b0` |
| `references/mangadex_pt_overlay_partial_and_crop.png` | 501×781 | `2f1a89dda583183971c891bf945d583394887191bb816f8dbbe686002aba40d2` |
| `references/s-manga_ja_overlay_1.png` | 1102×866 | `e10082842e79b116bc2e4fc3a5c354dce2f05567672c9023a15ac61fd0dd8f40` |
| `references/s-manga_ja_overlay_2.png` | 1103×865 | `9e5c9c6952786e2e5c8263e46677bf14568df5a7c060b660b9501330c103c3a4` |

- [ ] **Step 1: Viết validator test thất bại trước khi copy ảnh**

Test schema bắt buộc:

- source page có `id`, `role`, `image`, `sha256`, `src_lang`, `source_name`, `reading_direction`, `page_kind`, `width`, `height`, `regions`, `term_groups`, `known_order_failures`;
- region có `fixture_block_id`, bbox 4 số dương trong ảnh, `reading_order` liên tục từ `0`, `kind ∈ {dialogue,sfx,sign}`, `src_text` không rỗng, `required` boolean;
- failure reference có source link và labels đã duyệt;
- đúng sáu file; dùng `git ls-files` để đảm bảo không có binary **được track** trùng SHA ngoài canonical (bản nguồn ignored trong vendor không tính là bản thứ hai trong repo);
- `kind` chỉ tồn tại ở manifest/evaluator, không phải prompt item.

Test IoU synthetic phải fail khi thiếu anchor, duplicate match hoặc region mới không được báo.

- [ ] **Step 2: Chạy test và xác nhận fixture chưa tồn tại**

Run:

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_real_page_quality.py -q
```

Expected: FAIL vì module/manifest chưa tồn tại.

- [ ] **Step 3: Copy binary bằng đường dẫn rõ ràng, không force-add vendor**

Tạo thư mục đích rồi dùng `Copy-Item -LiteralPath` cho từng file đã map trong spec. Sau copy, chạy:

```powershell
Get-FileHash server/tests/fixtures/real_pages/*.png -Algorithm SHA256
Get-FileHash server/tests/fixtures/real_pages/references/*.png -Algorithm SHA256
```

Expected: sáu hash đúng bảng trên. Nếu lệch, dừng task; không cập nhật hash theo file sai.

- [ ] **Step 4: Thêm validator tối thiểu bằng stdlib**

`server/real_page_quality.py` chỉ dùng `json`, `hashlib`, `pathlib`, `statistics`. IoU dùng bbox `[x,y,w,h]`; matcher greedy chỉ dùng để chẩn đoán và phải báo đủ `missing`, `duplicate`, `unexpected`, không tự sửa manifest.

CLI hiện có `server/diagnose.py` thêm option `--manifest-candidate` để dump detector/OCR candidate ra file tạm ngoài thư mục canonical. Candidate có bbox/transcript/raw vendor index; không tự gán expected `reading_order` hay `kind`.

- [ ] **Step 5: Chạy diagnostic thật và review ground truth bằng ảnh**

Run CPU trên ba source page:

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m server.diagnose server/tests/fixtures/real_pages/mangadex_pt.png --lang es --device cpu --manifest-candidate .tmp-real-pages/mangadex_pt.json
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m server.diagnose server/tests/fixtures/real_pages/s-manga_ja_1.png --lang ja --device cpu --manifest-candidate .tmp-real-pages/s-manga_ja_1.json
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m server.diagnose server/tests/fixtures/real_pages/s-manga_ja_2.png --lang ja --device cpu --manifest-candidate .tmp-real-pages/s-manga_ja_2.json
```

Review thủ công trên ảnh gốc rồi ghi manifest hoàn chỉnh:

- PT: 7 required regions, source `pt`, layout `rtl`; không dùng vendor LTR làm truth.
- JA1: 21 required regions; region vendor index 5 phải đứng trước index 3/4; poster ngang là `sign`.
- JA2: 17 required regions; vendor order đã đúng nhưng vẫn xác nhận độc lập.
- Transcript OCR phải ứng đúng bbox; sửa bằng nội dung nhìn thấy, không tự chép output sai.
- Failure labels PT dùng `partial_translation`/`overlay_missing`, không dùng `detector_missing_bubble`.

Xóa `.tmp-real-pages` sau khi manifest đã review; thư mục này không được stage.

- [ ] **Step 6: Chạy validator/test và commit fixture**

Run:

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_real_page_quality.py server/tests/test_diagnose.py -q
git status --short
```

Expected: PASS; Git chỉ thấy một bản track của mỗi binary và không thấy candidate tạm.

Commit:

```powershell
git add server/diagnose.py server/real_page_quality.py server/tests/test_diagnose.py server/tests/test_real_page_quality.py server/tests/fixtures/real_pages
git commit -m "test: add reviewed real-page OCR fixtures"
```

---

### Task 5: Replay ba policy từ cùng transcript và gọi Gemini thủ công

**Files:**
- Modify: `server/real_page_quality.py`
- Create: `server/run_real_page_probe.py`
- Modify: `server/tests/test_real_page_quality.py`

**Interfaces:**
- Produces: `prompt_items(page)` với allowlist exact `id/text/reading_order/bbox`.
- Produces: `policy_batches(page, arm, baseline_batches)` cho `batch_control`, `ordered_microbatch`, `full_page`.
- Produces CLI `run` với các argument bắt buộc `--manifest`, `--baseline`, `--out` và `--attempts 3`; Task 7 có invocation bằng đường dẫn thật.
- Consumes: `GeminiTranslator._generate` chỉ tại CLI live để dùng nguyên model/retry/failover production; core test nhận callable fake.
- Does not produce: production `/translate-items` changes.

- [ ] **Step 1: Viết test thất bại cho allowlist và membership**

Với một page synthetic có expected order khác arrival order, assert:

```python
assert set(prompt_items(page)[0]) == {"id", "text", "reading_order", "bbox"}
assert "kind" not in prompt_items(page)[0]
assert ids(policy_batches(page, "batch_control", [["b3"], ["b1", "b2"]])) == [
    ["b3"], ["b1", "b2"]
]
assert ids(policy_batches(page, "ordered_microbatch", [["b3"], ["b1", "b2"]])) == [
    ["b1"], ["b2", "b3"]
]
assert len(policy_batches(page, "full_page", [])) == 1
```

`ordered_microbatch` chỉ mượn dãy size của control, không mượn membership/order.

- [ ] **Step 2: Viết static runner contract và xác nhận test fail**

Fake response inline trong test gồm response hợp lệ/thiếu ID/trùng ID. Test runner phải:

- reject missing/duplicate/invented ID thành `invalid_response`;
- ghi đúng ba attempt mỗi `page × quality arm`, không chạy bù attempt lỗi;
- PT prompt ghi `Portuguese`, dù diagnostic OCR dùng recognizer key `es`;
- không cần `GEMINI_API_KEY` khi truyền fake generate callable.

Run:

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_real_page_quality.py -q
```

Expected: FAIL vì batching/runner chưa tồn tại.

- [ ] **Step 3: Implement batching/prompt thuần trong module chung**

Prompt version cố định `comic-page-eval-v1`, nói rõ các block cùng một trang manga/comic, source/destination language, page width/height, reading order, consistency, natural concise translation và exact ID response. Serialize item bằng `json.dumps(..., ensure_ascii=False)`; không đưa `kind` hoặc URL vào prompt/capture telemetry.

`batch_control` bắt buộc baseline exact IDs đã capture. Nếu ID set không khớp manifest hoặc batch trùng ID, raise trước khi gọi model.

- [ ] **Step 4: Implement CLI mỏng, không thêm API production**

Tách hàm testable:

```python
def run_quality_probe(manifest, baseline, generate, attempts=3, clock=time.perf_counter):
    rows = []
    for page in source_pages(manifest):
        for arm in QUALITY_ARMS:
            batches = policy_batches(page, arm, baseline[page["id"]])
            for attempt in range(1, attempts + 1):
                calls, translations = [], []
                for batch_id, batch in enumerate(batches, 1):
                    started = clock()
                    try:
                        decoded = generate(
                            build_eval_prompt(page, batch),
                            lambda raw, ids=[item["id"] for item in batch]:
                                decode_eval_items(raw, ids),
                        )
                        status, error_code = "success", None
                        translations.extend(decoded)
                    except Exception as error:
                        status, error_code = classify_probe_error(error)
                    calls.append(capture_call(batch_id, batch, started, clock(), status, error_code))
                rows.append(capture_attempt(page, arm, attempt, calls, translations))
    return build_capture(manifest, baseline, rows)
```

CLI live khởi tạo `GeminiTranslator()` một lần và truyền `translator._generate`; decoder kiểm exact ID. Capture ghi commit, fixture SHA, OS/device, model, prompt/policy version, temperature, batch membership, started/duration, status/error code và response keyed by fixture ID. Không ghi key.

Chỉ có ba quality arms: `batch_control`, `ordered_microbatch`, `full_page`. `preview_then_full` là flag riêng `--preview-latency` và CLI từ chối chạy nếu input gate chưa chọn `full_page`.

- [ ] **Step 5: Chạy test và smoke CLI không network**

Run:

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_real_page_quality.py -q
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m server.run_real_page_probe --help
```

Expected: PASS; help hiển thị manifest/baseline/output/attempts và không khởi tạo Gemini.

- [ ] **Step 6: Commit runner**

```powershell
git add server/real_page_quality.py server/run_real_page_probe.py server/tests/test_real_page_quality.py
git commit -m "feat: add deterministic real-page policy probe"
```

---

### Task 6: Thực thi rubric và quality gate hoàn toàn offline

**Files:**
- Modify: `server/real_page_quality.py`
- Modify: `server/run_real_page_probe.py`
- Modify: `server/tests/test_real_page_quality.py`
- Create: `server/tests/fixtures/real_pages/captures/evaluator_cases.json`

**Interfaces:**
- Produces: `validate_capture(manifest, capture)` guardrail deterministic.
- Produces: `evaluate_gate(manifest, capture, manual_scores) -> decision`.
- Produces decisions: `selected`, `blocked`, `no_context_headroom`, `inconclusive` cùng reasons.
- Preserves: human rubric là quality gate chính; CI không tự chấm đúng nghĩa bằng LLM.

- [ ] **Step 1: Viết bảng ca evaluator trước implementation**

`evaluator_cases.json` phải có ít nhất:

- exact IDs hợp lệ;
- missing, duplicate, invented ID và translation rỗng;
- term group có hai surface form xung đột;
- PT có ba mục context là `not_applicable`;
- candidate có critical error;
- arm dưới hai response hợp lệ;
- control median context `5/5` → `no_context_headroom`;
- control `5/3` và candidate tăng `+2` ở spread thấp → vẫn xét candidate;
- candidate tụt quá `1` trên một spread → `blocked`;
- hai candidate cùng qua và hòa context → tie-break số call rồi total latency.

- [ ] **Step 2: Viết test parametrized và xác nhận fail**

Assert thêm:

```python
assert context_score({"terms": 2, "pronouns": 1, "coherence": 2}) == 5
assert evaluate_gate(case_no_headroom)["decision"] == "no_context_headroom"
assert evaluate_gate(case_pt)["pages"]["mangadex_pt"]["context_score"] == "not_applicable"
```

Run:

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_real_page_quality.py -q
```

Expected: FAIL vì evaluator chưa có.

- [ ] **Step 3: Implement guardrail và gate đúng thứ tự spec**

Thứ tự quyết định:

1. Validate hash/schema/exact IDs/order/term group; report length metrics chỉ warning.
2. Mark arm `inconclusive` nếu một page có dưới hai response hợp lệ.
3. Loại candidate có critical error hoặc median 0 ở correctness/tone/conciseness trên bất kỳ source page.
4. PT chỉ chấm ba mục an toàn + RTL/exact ID; context fields bắt buộc `not_applicable`.
5. Nếu control median `context_score >= 5` trên cả hai JA spread, trả `no_context_headroom`.
6. Nếu còn headroom, candidate không được thấp hơn control quá 1 ở spread nào và phải cao hơn ít nhất 2 ở một spread.
7. Nếu cả hai candidate qua mà không arm nào thắng context rõ, tie-break call count rồi total latency.

Dùng `statistics.median`; không viết median riêng.

- [ ] **Step 4: Bổ sung lệnh evaluator offline**

CLI thêm mode:

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m server.run_real_page_probe evaluate --help
```

Mode này không import/khởi tạo `GeminiTranslator`; invocation đầy đủ với file thật nằm ở Task 7 và chạy được khi `GEMINI_API_KEY` rỗng.

- [ ] **Step 5: Chạy test với key rỗng và commit**

Run:

```powershell
$realPagePriorKey = $env:GEMINI_API_KEY
try {
  $env:GEMINI_API_KEY = ''
  & 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_real_page_quality.py -q
} finally {
  $env:GEMINI_API_KEY = $realPagePriorKey
}
```

Expected: PASS, không có network request.

Commit:

```powershell
git add server/real_page_quality.py server/run_real_page_probe.py server/tests/test_real_page_quality.py server/tests/fixtures/real_pages/captures/evaluator_cases.json
git commit -m "test: enforce offline translation quality gate"
```

---

### Task 7: Capture trang thật, chấm tay và hoàn tất worklog gate

**Files:**
- Create: `docs/superpowers/worklogs/2026-08-01-real-page-quality-baseline.json`
- Create: `server/tests/fixtures/real_pages/captures/2026-08-01-policy-probe.json`
- Create: `server/tests/fixtures/real_pages/captures/2026-08-01-manual-scores.json`

**Interfaces:**
- Consumes: telemetry page rows từ Task 1–3; frozen transcript/order từ Task 4; runner/evaluator từ Task 5–6.
- Produces: baseline batch membership, raw attempts, manual rubric, gate decision có thể tái lập.
- Requires: real Chrome tab + installed extension + real popup; đây là manual acceptance, không phải CI.

- [ ] **Step 1: Kiểm tra môi trường thật trước capture**

Run server production ở `8910`, fixture server ở `8000`:

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m http.server 8000 --directory server/tests/fixtures/real_pages
```

Mở từng source PNG từ `http://127.0.0.1:8000/`, dùng popup extension thật. Ghi commit, OS, CPU/GPU, model, pipeline/prompt/policy version. Không dùng `/health` làm bằng chứng hoàn tất.

- [ ] **Step 2: Capture one cold + one warm per Japanese page và PT diagnostic scope**

Với `s-manga_ja_1.png` và `s-manga_ja_2.png`:

- cold: clear đúng cache liên quan bằng UI/dev workflow hiện có, chạy popup một lần;
- warm: chạy lại cùng source/crop/lang/version;
- lưu toàn bộ `page_metrics`, kiểm `analysis_cache_hit`, `ocr_done_ms`, `final_translation_ms`, `first_overlay_ms`, `total_ms` và trace batches.

Với PT, chỉ capture analysis/OCR/batch scheduling bằng recognizer Latin hiện tại và ghi rõ `production_pt_supported: false`; không chấm translation live này.

Baseline membership lấy từ exact `translation_batches[].block_ids` của run đã chọn, cùng fixture hash/commit/device/policy version. Không dựng membership lại từ timer hoặc expected order.

- [ ] **Step 3: Chạy đúng ba attempt cho mỗi page × quality arm**

Tạo file baseline tạm từ telemetry đã review rồi chạy:

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m server.run_real_page_probe run --manifest server/tests/fixtures/real_pages/manifest.json --baseline .tmp-real-pages/baseline.json --out server/tests/fixtures/real_pages/captures/2026-08-01-policy-probe.json --attempts 3
```

Không chạy thêm attempt để thay attempt lỗi. `preview_then_full` chỉ chạy nếu evaluator chọn `full_page` và telemetry cho thấy first-overlay latency còn cần trade-off; nếu không kích hoạt, worklog ghi `preview_probe: {"status":"not_run","reason":"condition_not_met"}`.

- [ ] **Step 4: Chấm tay bằng rubric cố định**

Hai JA spread: chấm đủ correctness, terms, pronouns, tone, coherence, conciseness và `critical_error`. PT: chỉ correctness/tone/conciseness; ba mục context ghi chuỗi `not_applicable`. `kind` chỉ giúp reviewer loại `sign`/`sfx` khỏi coherence; không sửa prompt/capture.

Mỗi score có reviewer và note ngắn. Không để `null`, chuỗi rỗng hay field chưa quyết định trong file final.

- [ ] **Step 5: Chạy evaluator và ghi worklog hoàn chỉnh**

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m server.run_real_page_probe evaluate --manifest server/tests/fixtures/real_pages/manifest.json --capture server/tests/fixtures/real_pages/captures/2026-08-01-policy-probe.json --scores server/tests/fixtures/real_pages/captures/2026-08-01-manual-scores.json --out docs/superpowers/worklogs/2026-08-01-real-page-quality-baseline.json
```

Worklog phải có ba phần `telemetry_validation`, `policy_probe`, `manual_review`, và decision đúng một trong `selected`, `blocked`, `no_context_headroom`, `inconclusive` kèm reason. Nếu `no_context_headroom`, ghi rõ batching không được claim cải thiện chất lượng; reading order vẫn là correctness task của Spec B.

- [ ] **Step 6: Validate artifact và commit bằng chứng**

Run:

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m server.run_real_page_probe evaluate --manifest server/tests/fixtures/real_pages/manifest.json --capture server/tests/fixtures/real_pages/captures/2026-08-01-policy-probe.json --scores server/tests/fixtures/real_pages/captures/2026-08-01-manual-scores.json --out .tmp-real-pages/reproduced-worklog.json
git diff --no-index docs/superpowers/worklogs/2026-08-01-real-page-quality-baseline.json .tmp-real-pages/reproduced-worklog.json
```

Expected: evaluator output giống nhau ngoài field timestamp được đọc từ capture, không sinh timestamp mới. Xóa `.tmp-real-pages`; commit:

```powershell
git add docs/superpowers/worklogs/2026-08-01-real-page-quality-baseline.json server/tests/fixtures/real_pages/captures/2026-08-01-policy-probe.json server/tests/fixtures/real_pages/captures/2026-08-01-manual-scores.json
git commit -m "docs: record real-page translation quality baseline"
```

---

### Task 8: Full regression, scope audit và bàn giao cho Spec B/C

**Files:**
- Modify: `work-flow.md`
- Verify: all files changed in Tasks 1–7

**Interfaces:**
- Produces: documented as-is telemetry/fixture workflow and an explicit Spec B transfer gate.
- Does not produce: production policy or overlay fix.

- [ ] **Step 1: Chạy toàn bộ Python suite**

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests -q
```

Expected: PASS; test evaluator chạy không cần Gemini/network.

- [ ] **Step 2: Chạy toàn bộ JS suite hiện có**

```powershell
Get-ChildItem extension/test/*.test.js | ForEach-Object { node $_.FullName; if ($LASTEXITCODE -ne 0) { throw "JS test failed: $($_.Name)" } }
```

Expected: tất cả process exit `0`.

- [ ] **Step 3: Audit contract và dữ liệu nhạy cảm**

```powershell
Select-String -Path extension/background.js,extension/content.js,server/run_real_page_probe.py -Pattern 'api_key|source_url|trans_text|src_text'
Select-String -Path server/run_real_page_probe.py,server/real_page_quality.py -Pattern 'kind'
git status --short
```

Review từng match: runtime telemetry không serialize dữ liệu cấm; `kind` chỉ được validator/evaluator đọc, không nằm trong prompt item. Xác nhận không có candidate/temp file staged.

- [ ] **Step 4: Cập nhật workflow đúng trạng thái đã ship**

Append mục ngày `2026-08-01` vào `work-flow.md`, mô tả:

- cách lấy `scope_done.page_metrics` và ý nghĩa duration/elapsed/null;
- cách serve fixture/capture/evaluate;
- quality decision hiện tại từ worklog;
- ranh giới Spec B/C.

Ghi cổng chuyển giao bắt buộc cho Spec B: nếu triển khai policy thắng, production `/translate-items` phải mang đúng allowlist `id`, `text`, `reading_order`, `bbox` và page dimensions như `comic-page-eval-v1`; prompt version, policy version và cache key đổi cùng contract. Đây là yêu cầu Spec B, không phải thay đổi production trong commit Spec A.

- [ ] **Step 5: Kiểm diff cuối và commit**

```powershell
git diff --check
git -c safe.directory=D:/MangaTranslator status --short
git -c safe.directory=D:/MangaTranslator diff --stat HEAD
```

Expected: không whitespace error; chỉ file đúng plan. Commit:

```powershell
git add work-flow.md
git commit -m "docs: document real-page quality gate workflow"
```

- [ ] **Step 6: Ghi kết quả verification vào handoff**

Handoff phải tách rõ:

- automated tests PASS;
- manual real-browser telemetry đã chạy hay chưa;
- detector/OCR transcript/order đã được người đọc review hay chưa;
- Gemini capture/rubric decision cụ thể;
- Portuguese vẫn chưa phải production proof;
- Spec B/C vẫn chưa được triển khai.

Không dùng từ “hoàn tất Spec A” nếu Task 7 manual evidence còn thiếu.

---

## Coverage Matrix

| Spec requirement | Task |
|---|---:|
| `analysis_ms`, cache-hit trước/sau lock | 1 |
| OCR done, final translation, one row/job | 2 |
| Trace từng Gemini call và partial attribution | 2 |
| `first_overlay_ms` per-page xuyên content/background | 3 |
| Sáu fixture canonical, hash, manifest, IoU/order/transcript | 4 |
| Prompt allowlist, control/ordered/full-page replay | 5 |
| Rubric, PT N/A, no-headroom và policy gate | 6 |
| Real browser/cold-warm/Gemini capture/worklog | 7 |
| Regression, workflow, Spec B production allowlist handoff | 8 |

## Explicit Deferrals

- Spec B: sửa dedupe return order, dựng production reading order, user-controlled direction, `pt`, page-context `/translate-items`, policy thắng và cache/version migration.
- Spec C: overlay overlap, white crop che chữ, clipping, erasure/inpainting, `partial`/popup semantics.
- Chỉ thêm `analysis_wait_ms`, dashboard, database hoặc LLM judge nếu telemetry/workflow sau này chứng minh cần; Spec A không cần chúng.
