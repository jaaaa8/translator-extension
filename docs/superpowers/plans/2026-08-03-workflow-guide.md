# Kế hoạch triển khai tài liệu workflow MangaTranslator

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tạo `workflow-guide.md` bằng tiếng Việt, giải thích đúng current `feat/v3` từ DOM image selection qua detector, MangaOCR/PaddleOCR, cache, translation, overlay và page-transition lifecycle bằng 11 phần cùng ba sơ đồ Mermaid.

**Architecture:** Đây là thay đổi tài liệu thuần Markdown, chỉ tạo một artifact sản phẩm ở repository root. Tài liệu đi theo vòng đời dữ liệu; mỗi stage nêu input, xử lý, output và cache/reuse path có thể bỏ qua stage đó. Source hiện tại và dependency source đang được gọi là nguồn sự thật.

**Tech Stack:** Markdown, Mermaid `sequenceDiagram`/`flowchart TD`, CodeGraph, PowerShell và Git read-only checks.

## Global Constraints

- Chỉ tạo `workflow-guide.md`; không sửa `work-flow.md`, application source, test hoặc các file bẩn sẵn có.
- Chỉ mô tả hành vi đang tồn tại trên current `feat/v3`; không đưa nhánh `feat/spec-a-telemetry-quality-gate`, roadmap hoặc kiến trúc tương lai vào tài liệu.
- Có đúng 11 heading cấp hai theo spec và đúng ba fenced Mermaid diagram.
- Viết tiếng Việt cho người mới; giữ identifier kỹ thuật trong backtick và định nghĩa thuật ngữ trước khi dùng sâu.
- Mỗi stage quan trọng phải nói rõ input, xử lý, output và cache nào có thể bỏ qua stage.
- Tách comic detector ngoài với Paddle detector trong; tách bbox crop, bbox ảnh nguồn và tọa độ CSS.
- Ghi đúng current limitations: progressive `hotOcr` không có read path, production `analysis_ready` không phát `analysis_ms`, `first_overlay_ms` nằm ngoài `scope_done.metrics`.
- Không thêm dependency, HTML, ảnh xuất riêng, source map, debug runbook, test checklist, benchmark report hoặc đề xuất tối ưu/runtime migration.
- Không stage hoặc commit nếu người dùng chưa yêu cầu.

## File Map

- Create: `workflow-guide.md` — artifact duy nhất người đọc sử dụng.
- Reference: `docs/superpowers/specs/2026-08-03-workflow-guide-design.md` — contract đã duyệt.
- Reference: `extension/popup.js`, `extension/content.js`, `extension/srcset.js` — entry point, candidate/crop và stale-render contract.
- Reference: `extension/background.js`, `extension/page-cache.js` — keys, scheduler, streaming, cache và lifecycle.
- Reference: `server/main.py`, `server/pipeline.py`, `server/detector.py`, `server/ocr.py`, `server/artifacts.py`, `server/translator.py` — local OCR/translation implementation.
- Reference: `server/vendor/comic_text_detector/inference.py`, `server/vendor/comic_text_detector/utils/imgproc_utils.py` — detector letterbox/resize contract.
- Reference: `venv/Lib/site-packages/manga_ocr/ocr.py`, `venv/Lib/site-packages/paddleocr/_pipelines/ocr.py` — package paths current engines gọi.
- Preserve: `work-flow.md`.

---

### Task 1: Tạo khung tài liệu và luồng end-to-end

**Files:**

- Create: `workflow-guide.md`
- Reference: `docs/superpowers/specs/2026-08-03-workflow-guide-design.md`
- Reference: `extension/popup.js`
- Reference: `extension/content.js`
- Reference: `extension/srcset.js`
- Reference: `extension/background.js`
- Preserve: `work-flow.md`

**Interfaces:**

- Consumes: `translatePage(scope, srcLang, dstLang)`, `selectCandidates(images, scope, viewportWidth, viewportHeight)`, `start_scope`, `buildKeys(job, versions)`, scheduler constants.
- Produces: Sections 1–5 and Mermaid diagram 1; Task 2 appends Sections 6–7 without renaming these headings.

- [ ] **Step 1: Kiểm tra trạng thái trước khi tạo file**

  Run:

  ```powershell
  Test-Path -LiteralPath '.\workflow-guide.md'
  git diff --exit-code -- '.\work-flow.md'
  git status --short -- '.\work-flow.md' '.\workflow-guide.md'
  ```

  Expected: `workflow-guide.md` chưa tồn tại và `work-flow.md` không có diff. Nếu target đã tồn tại hoặc file cũ có diff, dừng để tránh ghi đè thay đổi của người dùng.

- [ ] **Step 2: Revalidate source/crop/key/scheduler contracts bằng CodeGraph**

  Run:

  ```powershell
  codegraph explore "Show current verbatim source and call paths for popup translate actions, content translatePage/snapshotJobs/validBinding, srcset selectCandidates/bestSource/viewportCrop, and background buildKeys/scheduler constants. Include current values and current callers."
  ```

  Expected: current source xác nhận `<img>` only, minimum `400×400`, `visible` dùng `currentSrc || src` và crop, `loaded` dùng `bestSource()` và full image, `MAX_CONCURRENT = 2`, `MAX_OUTSTANDING_PER_REQUEST = 4`, priority `0/1/2`.

- [ ] **Step 3: Tạo title, bản đọc nhanh, thuật ngữ và Mermaid diagram 1**

  Dùng `apply_patch` tạo `workflow-guide.md` với:

  ```markdown
  # Workflow MangaTranslator — từ ảnh manga đến overlay

  ## 1. Đọc nhanh trong hai phút
  ## 2. Thành phần và dữ liệu chính
  ```

  Section 1 chứa một bản tóm tắt ngắn và đúng một fenced block bắt đầu bằng:

  ````markdown
  ```mermaid
  sequenceDiagram
  ```
  ````

  Diagram dùng participants: Người dùng, Popup, Content script, Background, Cache, Local server, Gemini và Overlay. Diagram phải có hai nhánh `alt`: exact page hit và cold/partial path; cold/partial path phải đi qua `/ocr-stream`, `analysis_ready`, `ocr_block`, `/translate-items`, Gemini, `validBinding`, `upsertOverlayBlock`, rồi `scope_done`.

  Section 2 dùng bảng định nghĩa tối thiểu: popup, content script, background/service worker, local server, detector, recognizer, overlay, request, job, producer, consumer, region, block và artifact.

- [ ] **Step 4: Viết Sections 3–5 theo đúng vòng đời trước OCR**

  Append bằng `apply_patch` với đúng headings:

  ```markdown
  ## 3. Chọn ảnh và nguồn ảnh
  ## 4. Viewport crop và hệ tọa độ
  ## 5. Tạo key và xếp lịch job
  ```

  Section 3 phải phân biệt bằng bảng:

  - eligibility: image complete, source tồn tại, `naturalWidth` và `naturalHeight` ≥ 400;
  - `visible`: giao viewport, `currentSrc || src`, normalized crop;
  - `loaded`: mọi eligible loaded image, `bestSource()`, full image;
  - canvas không thuộc current pipeline.

  Section 4 phải ghi công thức pixel conversion:

  ```text
  offset_x = floor(left × image_width)
  offset_y = floor(top × image_height)
  right_px = ceil(right × image_width)
  bottom_px = ceil(bottom × image_height)
  ```

  Giải thích padding viewport 10%, canonical full crop, crop-space bbox, original-image bbox và CSS coordinates là ba hệ tọa độ khác nhau.

  Section 5 dùng bảng key components cho `sourceRevision`, `analysis_key`, `ocr_key`, `overlay_key`, `page_artifact_key`, rồi giải thích producer/consumer và scheduler `2` concurrent, `4` outstanding/request, foreground/background/prewarm `0/1/2`.

- [ ] **Step 5: Review độc lập phần end-to-end**

  Run:

  ```powershell
  Get-Content -Raw -Encoding utf8 -LiteralPath '.\workflow-guide.md'
  Select-String -LiteralPath '.\workflow-guide.md' -Pattern '^## [1-5]\.' -Encoding utf8
  Select-String -LiteralPath '.\workflow-guide.md' -Pattern '^```mermaid$|^sequenceDiagram$' -Encoding utf8
  ```

  Expected: Sections 1–5 xuất hiện đúng thứ tự, có một sequence diagram và không mô tả detector/recognizer như đã chạy trước scheduler/cache lookup.

---

### Task 2: Mở hộp đen detector và hai recognizer

**Files:**

- Modify: `workflow-guide.md`
- Reference: `server/pipeline.py`
- Reference: `server/detector.py`
- Reference: `server/artifacts.py`
- Reference: `server/ocr.py`
- Reference: `server/vendor/comic_text_detector/inference.py`
- Reference: `server/vendor/comic_text_detector/utils/imgproc_utils.py`
- Reference: `venv/Lib/site-packages/manga_ocr/ocr.py`
- Reference: `venv/Lib/site-packages/paddleocr/_pipelines/ocr.py`

**Interfaces:**

- Consumes: image bytes, normalized crop, `analysis_key`, `src_lang`; `Pipeline.analyze()`, `Pipeline._iter_ocr()`, `Detector.detect()`, `OcrRegistry.get()`.
- Produces: Sections 6–7 and Mermaid diagram 2; output contract là `ocr_block {block_id, bbox, src_text}` với bbox ảnh nguồn.

- [ ] **Step 1: Revalidate detector/preprocessing/engine source**

  Run:

  ```powershell
  codegraph explore "Show current verbatim source and call paths for Pipeline._decode_crop, analyze, _dedupe_regions, _prep_crop, _iter_ocr, Detector.detect, MangaOcrEngine, PaddleLatinEngine and OcrRegistry.get. Include exact constants and output schemas."
  ```

  Then read only dependency implementations CodeGraph does not index:

  ```powershell
  Select-String -Path '.\server\vendor\comic_text_detector\inference.py' -Pattern 'def preprocess_img|class TextDetector|def __call__' -Context 0,40 -Encoding utf8
  Select-String -Path '.\server\vendor\comic_text_detector\utils\imgproc_utils.py' -Pattern 'def letterbox' -Context 0,45 -Encoding utf8
  Select-String -Path '.\venv\Lib\site-packages\manga_ocr\ocr.py' -Pattern 'class MangaOcr|def __call__|def _preprocess' -Context 0,30 -Encoding utf8
  Select-String -Path '.\venv\Lib\site-packages\paddleocr\_pipelines\ocr.py' -Pattern 'class PaddleOCR|def predict' -Context 0,35 -Encoding utf8
  ```

  Expected: `_MIN_CROP_H = 48`, `_DEDUPE_IOU = 0.5`, analysis cache `32`/`128 MiB`, OCR cache `256`, detector default input `1024`, MangaOCR ViT generation, Paddle full OCR pipeline.

- [ ] **Step 2: Thêm Mermaid diagram 2 và Section 6**

  Append bằng `apply_patch`:

  ```markdown
  ## 6. Detector xử lý ảnh thế nào
  ```

  Mở section bằng một fenced `mermaid` chứa `flowchart TD` và chuỗi node:

  ```text
  bytes → BGR decode → optional crop → letterbox 1024×1024
  → comic detector → scale bbox về work → xyxy thành x,y,w,h
  → dedupe IoU > 0.5 → clip → cộng offset → original-image bbox
  ```

  Sau diagram, giải thích từng bước, detector CUDA fallback CPU, `vertical` được tạo nhưng không route recognizer, và `AnalysisArtifact` giữ prepared RGB crops chứ không chỉ bbox.

- [ ] **Step 3: Hoàn thiện diagram 2 và Section 7 cho region preprocessing**

  Diagram 2 phải tiếp tục từ original-image bbox qua:

  ```text
  region crop → BGR sang RGB → height < 48?
  → INTER_CUBIC upscale → white border 8 px → src_lang branch
  ```

  Append đúng heading:

  ```markdown
  ## 7. Chia region và nhận dạng chữ
  ```

  Section phải nói rõ:

  - resize chỉ thay recognizer input; bbox overlay không đổi;
  - `ja`: lazy MangaOCR, PIL image, grayscale→RGB, ViT processor, `generate(max_length=300)`, auto CUDA/CPU và package warm-up;
  - `es`: lazy `PaddleOCR(lang="es")`, ba auxiliary pipeline tắt, MKL-DNN tắt, Paddle detector nội bộ → recognizer nội bộ → nối `rec_texts`;
  - project gọi từng region, không dùng batch engine interface;
  - detector và recognizer dùng chung `_ocr_lock`;
  - empty text không phát translation block; recognizer exception phát `ocr_block_error` và region có thể retry lần sau.

- [ ] **Step 4: Review độc lập OCR internals**

  Run:

  ```powershell
  Select-String -LiteralPath '.\workflow-guide.md' -Pattern '^## [67]\.' -Encoding utf8
  Select-String -LiteralPath '.\workflow-guide.md' -Pattern '1024×1024|IoU > 0\.5|48 px|8 px|MangaOCR|PaddleOCR|detector nội bộ|_ocr_lock' -Encoding utf8
  ```

  Expected: mọi pattern có match; Section 6–7 phân biệt comic detector với Paddle detector và giữ bbox trong tọa độ ảnh nguồn.

---

### Task 3: Viết streaming, cache, chuyển trang và metrics

**Files:**

- Modify: `workflow-guide.md`
- Reference: `extension/background.js`
- Reference: `extension/page-cache.js`
- Reference: `extension/content.js`
- Reference: `server/main.py`
- Reference: `server/pipeline.py`
- Reference: `server/translator.py`

**Interfaces:**

- Consumes: `analysis_ready`, `ocr_block`, `ocr_block_error`, `image_done`, `translation`, `scope_done`; PageCache/server LRU/background Map contracts.
- Produces: Sections 8–11, Mermaid diagram 3 và final complete document content.

- [ ] **Step 1: Revalidate progressive/cache/lifecycle contracts**

  Run:

  ```powershell
  codegraph explore "Show current verbatim source and call paths for queueTranslation, flushTranslationBatch, translate_items, validBinding, upsertOverlayBlock, buildKeys, attachDescriptor, PageCache storedPage/rehydrate, releaseRequest, retireProducer, disconnectPort and resumeOfflineJobs. Include all hotOcr/hotTranslations reads and writes plus production metric fields."
  ```

  Expected: first batch `3/250 ms`, later batch `8/500 ms`; PageCache `8 MiB` and visible-only persistence; progressive `hotOcr` write without read; `visible` demotion and `loaded` retirement; production `analysis_ready` lacks `analysis_ms`.

- [ ] **Step 2: Viết Section 8 — streaming, translation và overlay**

  Append:

  ```markdown
  ## 8. OCR streaming, dịch và overlay
  ```

  Nội dung đi đúng thứ tự:

  1. `analysis_ready`;
  2. mỗi `ocr_block` được lưu/persist và queue ngay;
  3. first batch 3/250, later batch 8/500;
  4. `/translate-items` dùng ID-keyed JSON;
  5. Gemini JSON normalization và tối đa hai attempt theo current code;
  6. extension kiểm tra exact ID set;
  7. `validBinding` kiểm tra request/job/DOM/source/signature/languages;
  8. `upsertOverlayBlock(block_id)`;
  9. scale original bbox sang rendered image rectangle và fit font 18→10 px;
  10. `image_done`, page `complete`/`partial`, rồi all jobs → `scope_done`.

  Nêu rõ batch translation lỗi không xóa block đã dịch thành công.

- [ ] **Step 3: Thêm Mermaid diagram 3 và Section 9 — cache**

  Append:

  ```markdown
  ## 9. Các tầng cache hiện tại
  ```

  Mở section bằng `flowchart TD` thể hiện:

  ```text
  exact page hit → replay
  OCR sibling → translation only
  analysis sibling → /ocr-stream không image
  server hit → skip detector
  409 analysis_missing → retry kèm image
  ```

  Sau diagram, dùng bảng location/key/payload/lifetime cho:

  - `analysisStages` và `ocrStages` — in-flight only;
  - server `_analysis_cache` — 32/128 MiB, prepared crops;
  - server `_ocr_cache` — 256;
  - `hotTranslations` — 2.048, only all-batch hit skips request;
  - `hotOcr` — legacy read, progressive write-only;
  - `PageCache` — 8 MiB, visible only, metadata/blocks but no image/prepared crop;
  - visible job ledger.

  Giải thích exact page, OCR sibling, analysis sibling, server-side 409 retry và prewarm behavior.

- [ ] **Step 4: Hoàn thiện diagram 3 và Section 10 — chuyển trang/restart**

  Diagram 3 phải thêm lifecycle branch:

  ```text
  replaced/disconnected request
  → visible: demote background + persist
  → loaded: retire if no consumer
  service-worker restart → lose Maps + rehydrate visible jobs
  Chrome restart → lose session cache
  server restart → lose analysis/OCR LRU
  ```

  Append:

  ```markdown
  ## 10. Chuyển trang và restart
  ```

  Phân biệt sáu trường hợp:

  1. cùng DOM node đổi `src/srcset`;
  2. DOM node bị thay/rời document;
  3. bấm dịch lần nữa với `replaces_request_id`;
  4. đóng popup hoặc Port reconnect;
  5. service-worker restart;
  6. Chrome restart so với local-server restart.

  Nêu rõ source/DOM change tự nó chỉ prune overlay và chặn stale render, không gửi cancel ngay cho background.

- [ ] **Step 5: Viết Section 11 — metrics thực tế**

  Append:

  ```markdown
  ## 11. Metrics hiện tại
  ```

  Dùng bảng cho `queue_wait_ms`, `fetch_ms`, `analysis_ms`, `first_ocr_ms`, `first_translation_ms`, `first_overlay_ms`, `total_ms`.

  Bắt buộc ghi:

  - production `analysis_ready` hiện không có `analysis_ms`, nên value thường là `0`;
  - `first_overlay_ms` đo trong content, trả riêng từ `translatePage` và gửi bằng `render_metric`, không nằm trong `scope_done.metrics`;
  - phần này giải thích semantics, không chép benchmark numbers.

---

### Task 4: Kiểm tra toàn bộ artifact và phạm vi thay đổi

**Files:**

- Verify: `workflow-guide.md`
- Verify: `docs/superpowers/specs/2026-08-03-workflow-guide-design.md`
- Preserve: `work-flow.md`

**Interfaces:**

- Consumes: complete Markdown từ Tasks 1–3 và acceptance criteria trong spec.
- Produces: verified documentation artifact; không thay đổi runtime interface.

- [ ] **Step 1: Kiểm tra structure và Mermaid fences**

  Run:

  ```powershell
  $lines = Get-Content -Encoding utf8 -LiteralPath '.\workflow-guide.md'
  $h2 = @($lines | Select-String '^## (?:[1-9]|1[01])\. ')
  $mermaid = @($lines | Select-String '^```mermaid$')
  $sequence = @($lines | Select-String '^sequenceDiagram$')
  $flows = @($lines | Select-String '^flowchart TD$')
  if ($h2.Count -ne 11) { throw "Expected 11 H2 sections, got $($h2.Count)" }
  if ($mermaid.Count -ne 3) { throw "Expected 3 Mermaid blocks, got $($mermaid.Count)" }
  if ($sequence.Count -ne 1 -or $flows.Count -ne 2) { throw "Expected 1 sequenceDiagram and 2 flowchart TD diagrams" }
  $h2.Line
  ```

  Expected: 11 headings in numeric order, three Mermaid blocks, one sequence diagram and two flowcharts.

- [ ] **Step 2: Kiểm tra required current-code facts**

  Run:

  ```powershell
  $required = @(
    '400×400','10%','1024×1024','IoU > 0.5','48 px','8 px',
    'MangaOCR','PaddleOCR','detector nội bộ','MAX_CONCURRENT = 2',
    'MAX_OUTSTANDING_PER_REQUEST = 4','3 block','250 ms','8 block','500 ms',
    '128 MiB','8 MiB','hotOcr','analysis_ms','first_overlay_ms',
    'visible','loaded','409','chrome.storage.session'
  )
  $content = Get-Content -Raw -Encoding utf8 -LiteralPath '.\workflow-guide.md'
  foreach ($term in $required) {
    if (-not $content.Contains($term)) { throw "Missing required fact: $term" }
  }
  ```

  Expected: không ném lỗi.

- [ ] **Step 3: Kiểm tra identifiers có caller/source hiện tại**

  Run:

  ```powershell
  $terms = @(
    'start_scope','analysis_ready','ocr_block','ocr_block_error','image_done',
    'translation','scope_done','/ocr-stream','/translate-items','validBinding',
    'upsertOverlayBlock','analysis_key','ocr_key','page_artifact_key'
  )
  foreach ($term in $terms) {
    $found = Select-String -Path '.\extension\*.js','.\server\*.py' -SimpleMatch -Pattern $term
    if (-not $found) { throw "Missing current-source identifier: $term" }
  }
  ```

  Expected: mọi identifier được tìm thấy trong current source.

- [ ] **Step 4: Kiểm tra không có placeholder hoặc nội dung ngoài phạm vi**

  Run:

  ```powershell
  $placeholderPatterns = @('T' + 'BD', 'T' + 'ODO', 'implement ' + 'later', 'similar ' + 'to', 'appropriate error ' + 'handling')
  $placeholder = Select-String -LiteralPath '.\workflow-guide.md' -Pattern ($placeholderPatterns -join '|') -Encoding utf8
  $future = Select-String -LiteralPath '.\workflow-guide.md' -Pattern 'C\+\+|Rust|Paddle GPU|feat/spec-a-telemetry-quality-gate|nên tối ưu|đề xuất tối ưu' -Encoding utf8
  if ($placeholder) { throw 'Placeholder found' }
  if ($future) { throw 'Out-of-scope future/optimization content found' }
  ```

  Expected: không ném lỗi.

- [ ] **Step 5: Đọc toàn bộ tài liệu như người mới**

  Run:

  ```powershell
  Get-Content -Raw -Encoding utf8 -LiteralPath '.\workflow-guide.md'
  ```

  Khi đọc, xác nhận có thể trả lời trực tiếp:

  - ảnh nào được chọn và source nào được fetch;
  - crop được đổi sang pixel và bbox ảnh gốc thế nào;
  - detector resize/dedupe ra sao;
  - MangaOCR khác PaddleOCR ở đâu;
  - cache hit nào bỏ qua detector, OCR hoặc Gemini;
  - đổi trang, Port disconnect và restart tác động job thế nào;
  - overlay chỉ render khi nào;
  - metric nào hiện chưa được production server populate.

  Nếu câu nào chưa trả lời được, sửa đúng section bằng `apply_patch` rồi chạy lại Task 4 từ Step 1.

- [ ] **Step 6: Kiểm tra UTF-8, whitespace và file cũ không đổi**

  Run:

  ```powershell
  $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
  [void]$utf8.GetString([System.IO.File]::ReadAllBytes((Resolve-Path '.\workflow-guide.md')))
  git diff --no-index --check -- NUL '.\workflow-guide.md'
  $newFileDiffExit = $LASTEXITCODE
  if ($newFileDiffExit -notin 0,1) { throw "Unexpected diff exit: $newFileDiffExit" }
  git diff --exit-code -- '.\work-flow.md'
  git status --short -- '.\work-flow.md' '.\workflow-guide.md'
  ```

  Expected: UTF-8 hợp lệ; `git diff --no-index` không in whitespace error; `work-flow.md` không có diff; path-scoped status chỉ báo `workflow-guide.md` là file mới.

## Bàn giao

- Cung cấp link tuyệt đối tới `workflow-guide.md`.
- Nêu rõ `work-flow.md` không đổi và không có application code/test bị sửa.
- Báo kết quả thực tế của Task 4, gồm 11 headings, ba Mermaid diagrams, UTF-8 và whitespace.
- Nêu rõ chưa stage/commit nếu người dùng chưa yêu cầu.
