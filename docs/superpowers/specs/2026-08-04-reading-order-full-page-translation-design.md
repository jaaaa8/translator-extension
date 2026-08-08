# Thiết kế Spec B: reading order tất định, full-page translation và Portuguese

**Ngày:** 2026-08-04

**Nhánh:** `feat/v3`

**Trạng thái:** thiết kế hội thoại đã PASS; tài liệu này chờ người dùng review trước khi lập implementation plan

## 1. Kết quả cần đạt

Spec B đưa policy `full_page` đã thắng quality gate của Spec A vào production, với bốn bảo đảm:

1. Mọi trang có reading order tất định từ hình học, hỗ trợ độc lập `rtl` và `ltr` cho cả single page lẫn spread.
2. Gemini nhận toàn bộ block của một trang theo đúng thứ tự, kèm bbox, kích thước ảnh và hướng đọc.
3. Đổi hướng hoặc thuật toán layout không ép chạy lại detector/OCR; cache chỉ invalid đúng từ tầng layout/translation trở lên.
4. Production hỗ trợ `pt` như một source language riêng nhưng ES/PT dùng chung chính xác một Paddle Latin engine runtime.

Thiết kế chọn phương án nhỏ nhất hoàn chỉnh: một helper JavaScript thuần dùng chung giữa background worker và Node acceptance test, một request full-page cho mỗi producer, và model Pydantic dùng chung giữa production/acceptance.

## 2. Ngoài phạm vi

- Không suy `reading_direction` từ site, `src_lang`, classifier hoặc vendor order.
- Không thêm setting single/spread hoặc cho content script gửi `page_kind`.
- Không đổi detector hoặc IoU dedupe threshold theo hướng đọc. Sửa normalization độc lập ở commit `c806f14` được ghi rõ tại mục 3.2.
- Không chèn ordering vào `pipeline.py:ocr_image()` legacy; production đi qua `/ocr-stream -> _iter_ocr -> applyOcrBlock`.
- Không giữ `ordered_microbatch`, preview pass hoặc trạng thái lai với `full_page`.
- Không sửa mask, inpainting, text fitting hoặc overlay geometry của Spec C.
- Không thêm spatial index, framework, dependency hoặc abstraction dành cho quy mô chưa có.
- Không dùng live Gemini quality rerun làm gate của vertical slice.

## 3. Kiến trúc và luồng dữ liệu

Luồng production:

```text
popup/content chọn reading_direction explicit
  -> background chuẩn hóa descriptor
  -> /ocr-stream hoàn tất analysis và OCR
  -> background tập hợp toàn bộ OCR blocks
  -> reading-order.js tạo ordered view, không mutate OCR artifact
  -> /translate-items nhận một full-page request
  -> background validate exact response IDs nguyên tử
  -> warm translation cache, persist và render theo ordered view
```

Detector, analysis và OCR vẫn direction-agnostic. Reading order chỉ tồn tại ở background sau khi stream OCR kết thúc; vì policy `full_page` vốn phải chờ đủ OCR, ordering không thêm một điểm chờ mới ngoài policy đã chọn.

### 3.1 Helper JavaScript dùng chung

Tạo `extension/reading-order.js` không phụ thuộc DOM, Chrome API hoặc Node API. API chính nhận block cùng `image_w`, `image_h`, `reading_direction` và trả một object mới:

```text
{
  page_kind: "single" | "spread",
  gutter_x: number | null,
  blocks: ordered shallow copies
}
```

`gutter_x` là `null` cho single page. Kết quả diagnostic này cho phép comparator kiểm trực tiếp `page_kind` và gutter trên cùng đường production; test không dựng lại thuật toán.

File gắn API lên `globalThis` cho service worker/VM. CommonJS export phải có guard đầy đủ:

```js
if (typeof module !== "undefined" && module.exports) module.exports = api;
```

Không được viết `module.exports = ...` trần vì `module` không tồn tại trong service worker hoặc sandbox VM.

`extension/background.js` giữ guard hiện hữu và import cả hai helper trong cùng đường classic-worker:

```js
if (typeof importScripts === "function") {
  importScripts("page-cache.js", "reading-order.js");
}
```

Trong `background-progressive.test.js`, `importScripts` là stub rỗng. Vì vậy mọi VM context chạy `background.js` và dùng ordering phải `vm.runInContext()` `reading-order.js` trước `background.js`, gồm context hiện ở quanh dòng 228 và context thứ hai quanh dòng 298-299. Mọi harness sibling thêm sau này cũng tuân cùng quy tắc.

### 3.2 Clamp và geometry duy nhất của analysis artifact

Commit `c806f14` gồm hai thay đổi normalization đi cùng một cache migration:

1. Clamp bbox lấy giao thật với ảnh: tính raw right/bottom từ tọa độ detector trước khi clamp origin; region hoàn toàn ngoài ảnh bị loại thay vì bị đẩy vào mép ảnh thành region ma.
2. Sau clamp và cộng crop offset, server loại exact duplicate trên toàn normalized bbox `[x, y, width, height]`; public reading-order helper cũng reject artifact còn duplicate geometry.

`PIPELINE_VERSIONS["dedupe"] = "iou-0.5-area-clamp-exact-v3"` bao phủ cả clamp semantics và exact normalized-bbox dedupe. IoU dedupe hiện hữu vẫn chạy trước clamp với threshold `> 0.5`; không mở rộng nó sang near-duplicate sau clamp.

Mọi bbox giữ lại đã unique nên `stable_block_id(analysis_key, bbox, 0)` cố ý dùng `ordinal=0`. Giữ tham số `ordinal` trong API hiện tại để tránh churn không liên quan ở `server/artifacts.py` và tests; chỉ dọn API nếu một task riêng chứng minh còn caller cần ordinal khác.

## 4. Setting `reading_direction`

`chrome.storage.local.readingDirection` là setting phẳng toàn cục, chỉ nhận `rtl` hoặc `ltr`, mặc định `rtl`.

- Popup lần đầu phải hiển thị `rtl`, không để control rỗng, và luôn hiển thị hướng hiện hành cạnh ngôn ngữ.
- Content script giữ direction trong module state, đọc storage, theo dõi `storage.onChanged`, và snapshot cùng `srcLang`/`dstLang` cho mỗi action.
- Mọi `start_scope` mới gửi direction explicit.
- Background có một canonical normalizer: missing thành `rtl`, invalid thành lỗi.
- Normalizer được gọi tại đúng ba boundary tạo descriptor: `acceptScope`, `offlineLedger`/restore và handler `prewarmJob`.
- Sau ba boundary này descriptor luôn explicit. Rule missing cũng bao phủ content script cũ còn sống sau extension update; không dùng danh sách nguồn missing làm guard.
- `storedDescriptor` cho phép field mới. `PageCache` chỉ round-trip dữ liệu và không tự default; legacy row thiếu field vẫn thiếu cho tới khi background boundary chuẩn hóa.
- Prewarm vẫn không persist page hoặc dịch, nhưng descriptor của nó phải thỏa cùng invariant.
- Server bắt buộc `reading_direction`; missing hoặc invalid trả `422`, không có default server.

Page record không lưu direction và `page_schema` vẫn là `page-v1`.

## 5. Thuật toán reading order

Tất cả bbox dùng hệ tọa độ ảnh đầy đủ do server decode, dạng `[x, y, width, height]`. `image_w/image_h` lấy từ page artifact của producer. DOM `natural_width/natural_height` vẫn được dùng cho source identity, eligibility và normalized crop hiện có, nhưng không được dùng thay cho pixel geometry của contract.

Helper chỉ tạo shallow copy/ordered view; không đổi thứ tự hoặc field của OCR artifact.

### 5.1 Phân loại trang

```text
image_w / image_h >= 1.2  -> spread
otherwise                 -> single
```

`page_kind` là hàm tất định của ảnh nên không có setting hoặc cache-key component riêng. `1.2` thuộc version `layout_order`.

### 5.2 Row bands

Trong một single page hoặc một nửa spread:

1. Mỗi bbox là một node.
2. Hai node nối khi vertical overlap `>= 0.5 * min(height_a, height_b)`.
3. Mỗi connected component là một band.
4. Band sort trên xuống dưới bằng top edge nhỏ nhất; khi hòa, dùng canonical band signature tạo từ các bbox chuẩn hóa đã sort, không dùng input order hoặc block ID.
5. Trong band, `x` nghĩa là `bbox[0]`:
   - RTL: `(-x, y, width, height)`.
   - LTR: `(x, y, width, height)`.

Connected component có tính bắc cầu có chủ ý: một bridge chạm đúng ngưỡng `0.5` với hai hàng sẽ nhập cả hai hàng thành một band, rồi toàn band sort theo `bbox[0]`. Với bbox lồng hoặc lệch, RTL vẫn dùng mép trái `bbox[0]`, không đổi sang mép phải `x + width`; LTR dùng cùng mép trái với dấu thuận.

Ngưỡng `0.5` thuộc `layout_order`. Fixture thật chỉ cho cận trên; synthetic tall-bridge là gate chứng minh ngưỡng thấp như `0.25` nối sai, còn synthetic two-row bridge khóa chaining tại đúng `0.5`. O(n²) được chấp nhận vì fixture lớn nhất hiện có 21 blocks; không thêm spatial index.

### 5.3 Spread và gutter

1. Project bbox lên trục x và merge các interval chồng/tiếp xúc.
2. Tạo gap giữa các merged interval.
3. Chọn gap duy nhất thỏa bất đẳng thức chặt `lo < image_w/2 < hi`; `gutter_x = (lo + hi) / 2`.
4. Không có gap chứa tâm thì fallback `image_w/2`. Trường hợp bbox phủ tâm vì thế đi đúng nhánh fallback.
5. Gán block vào nửa trang theo `center_x` so với gutter.
6. Sort từng nửa bằng row-band algorithm.
7. RTL trả nửa phải trước; LTR trả nửa trái trước.

Không chọn gap rộng nhất: một panel gap trong một nửa trang có thể rộng hơn gutter thật và làm đan xen hai trang.

## 6. HTTP contract và error envelope

Tạo `server/contracts.py` làm nguồn model duy nhất cho production và acceptance `/translate-items`.

### 6.1 Request

Item có exact allowlist:

```json
{
  "id": "block-id",
  "text": "source text",
  "reading_order": 0,
  "bbox": [10, 20, 30, 40]
}
```

Body có `items`, `src_lang`, `dst_lang`, `page_width`, `page_height`, `reading_direction`.

- `extra="forbid"` ở mọi trust boundary model.
- `bbox` đúng bốn số nguyên không âm.
- `page_width/page_height` là số nguyên dương.
- `reading_direction` bắt buộc `rtl | ltr`.
- ID không trùng.
- Theo đúng thứ tự mảng, `reading_order` phải bằng `[0, 1, ..., n-1]`, không trùng hoặc hở.
- Caller gửi items đã sort. Server validate rồi dựng prompt; không sort, suy direction hoặc âm thầm sửa payload.

`reading_order` cố ý trùng array index: nó vừa hiện diện tường minh trong prompt, vừa bắt caller sort sai ngay tại boundary. Không được xóa vì cho rằng dư thừa.

Duplicate-ID và dense-order checks nằm trong shared model validator. Việc này thay đổi điểm phát lỗi nhưng không nới bất kỳ ràng buộc nào.

### 6.2 Request validation envelope

Không dùng FastAPI `{"detail": [...]}` cho validation của `/translate-items`, vì extension hiện đọc `data.error` và `data.error_code`. `server/contracts.py` cung cấp một `RequestValidationError` handler dùng chung và cả `main.app` lẫn `acceptance_app.app` đăng ký handler đó.

Handler chỉ ánh xạ khi `request.url.path == "/translate-items"`:

```json
{
  "error": "mô tả ngắn của lỗi đầu tiên",
  "error_code": "invalid_request"
}
```

Message lấy `msg` của lỗi Pydantic đầu tiên, bỏ prefix `Value error, ` nếu có và fallback thành `invalid request`. Với các route khác, handler delegate về `request_validation_exception_handler()` mặc định để không thay đổi contract ngoài phạm vi.

`server/tests/test_translate_endpoint.py` assertion duplicate ID được cập nhật thành envelope mới, ví dụ:

```json
{"error": "duplicate input id", "error_code": "invalid_request"}
```

Gate phải phủ ít nhất duplicate ID, reading order không dense và extra field trên cả production/acceptance. Extension phải giữ `error.errorCode == "invalid_request"`; full-page trace dùng `status: "failed"` nhưng bảo toàn `error_code: "invalid_request"`, không ghi đè thành `translation_failed` hoặc `null`.

### 6.3 Response

Server trả mỗi expected ID đúng một lần. Extension chấp nhận response reorder, map bằng ID, nhưng reject missing/foreign/duplicate ID. Chỉ sau khi toàn response hợp lệ mới cache hoặc render.

## 7. Prompt, kích thước trang và version

`GeminiTranslator.translate_items()` nhận page context bằng keyword arguments: `page_width`, `page_height`, `reading_direction`. Prompt render JSON tường minh để unit test phân biệt field với text ngẫu nhiên.

Giữ allowlist projection hiện có và mở rộng đúng:

```python
HTTP_TRANSLATE_ITEM_PROMPT_FIELDS = (
    "id",
    "text",
    "reading_order",
    "bbox",
)
```

Không dump tùy ý `model_dump()` vào prompt. Prompt chứa page context dạng JSON với `page_width`, `page_height`, `reading_direction`; positive fake-client test là gate chứng minh context thật sự tới Gemini. `_normalize_items` giữ nguyên.

Kích thước lấy từ `producer.page.image_w/image_h`, tức decoded full-image dimensions cùng hệ tọa độ với bbox. Giá trị phải là integer dương; thiếu/sai thì `failProducer`, tuyệt đối không fallback về DOM natural dimensions. Warm sibling copy dimensions từ `analysis || sibling` để reuse vẫn có geometry đầy đủ.

Các version được rollout theo đúng task sở hữu:

- Task 4 thêm `layout_order = "reading-order-v1"` cùng direction/cache identity và version-shape gates.
- Task 5 thêm recognizer ES/PT `paddleocr-latin-ppocrv6-v1`.
- Task 6 bump nguyên tử cặp `prompt = "comic-page-items-v2"` và `policy = "full-page-v1"` cùng contract/prompt/orchestration.

`layout_order` không bị dời xuống Task 6. Gate cache chứng minh cùng block/context tạo key khác khi direction, layout, prompt hoặc policy đổi.

## 8. Cache identity và lifecycle

- `analysisKey` và `ocrKey` không chứa direction hoặc `layout_order`; đổi hướng phải tái dùng detector/OCR.
- `ocrKey` vẫn chứa `src_lang` và recognizer version, nên cache ES/PT không nhập nhằng dù engine runtime dùng chung.
- `overlayKey` và `translationKeyForBatch` chứa explicit `reading_direction` và `layout_order`.
- Ordered context hash dùng ordered tuples `{reading_order, block_id, src_text}`; không dựa vào arrival order.
- `page_kind` không có key riêng vì là hàm tất định của ảnh đã nằm trong source/analysis identity.
- Legacy `hotOcr` namespace giữ để đọc artifact cũ; đường full-page không ghi hot OCR theo microbatch.

`PageCache.purgeIncompatible()` hiện so toàn object versions và purge mọi page row khi bất kỳ version nào đổi. Vì vậy rollout `layout_order`, prompt/policy và recognizer mới sẽ purge page cache một lần, bao gồm re-OCR. Đây là chi phí cold-start được chấp nhận, không được mô tả sai là “chỉ translation cache đổi” ở tầng lifecycle. Job ledger vẫn sống và rehydrate phải lọc version cũ như hiện tại.

File baseline/worklog lịch sử giữ nguyên version đã đúng tại thời điểm capture; không sửa chuỗi cũ để giống config mới.

## 9. Hỗ trợ Portuguese và shared Latin engine

`server/config.py` là nguồn ngôn ngữ production:

```python
LANGS = ("ja", "es", "pt")
```

`server/main.py` dùng `config.LANGS` cho source-language validation và `/health.langs`, không giữ danh sách thứ hai. `server/ocr.py` giữ insertion order `ja`, `es`, `pt`:

```text
ja -> MangaOcrEngine
es -> PaddleLatinEngine
pt -> PaddleLatinEngine
```

`OcrRegistry` cache theo engine class thay vì language. Vì vậy `registry.get("es") is registry.get("pt")` và constructor Latin chỉ chạy một lần. Public API và OCR cache identity vẫn tách theo `src_lang`.

`PaddleLatinEngine` pin model đang được định danh:

```python
PaddleOCR(lang="es", ocr_version="PP-OCRv6", ...)
```

Trong PaddleOCR 3.7.0, cả ES và PT thuộc `_PPOCRV6_LANGS` và chọn cùng `PP-OCRv6_medium_det`/`PP-OCRv6_medium_rec`; dùng chung instance là tương đương model chính xác. Pin `ocr_version` ngăn dependency upgrade âm thầm đổi model mà không bump cache version.

`PIPELINE_VERSIONS["recognizers"]["es"]` và `["pt"]` cùng là `paddleocr-latin-ppocrv6-v1`. Đổi ES từ `paddleocr-es-v1` làm invalid OCR cache ES một lần có chủ ý.

`server/translator.py` thêm `LANG_NAMES["pt"] = "Portuguese"`. Prompt gate với `src_lang="pt"` phải chứa `from Portuguese` và không chứa `from pt`. Popup expose ES/PT riêng và translator nhận đúng `pt`.

Gate đồng bộ:

- Production: mọi language trong `/health.langs` có entry trong `versions.recognizers`.
- `OcrRegistry().langs == list(config.LANGS)` mà không gọi `get()`.
- Production `ENGINES["es"] is ENGINES["pt"] is PaddleLatinEngine` mà không load model.
- Fake engine test chứng minh ES/PT trả cùng object và init count bằng một.
- Acceptance recursive version-shape gate đi xuống `versions.recognizers` và so tập key với production; acceptance `/health` không có `langs`, nên không áp gate production một cách rỗng nghĩa.
- Chỉ fake `/health` phục vụ PT và background-progressive version shape cần thêm PT; không churn fixture không chạy PT.
- `server/tests/test_health.py` expectation là `["ja", "es", "pt"]`.
- `server/tests/test_ocr.py` expectation được cập nhật tĩnh thành `["ja", "es", "pt"]`, nhưng file này không được chạy vì nạp model thật và ảnh fixture. Handoff ghi rõ assertion chỉ được xác nhận ở lần chạy có model sau này.

## 10. Full-page orchestration

Spec B khai tử đồng thời queue/timer microbatch `3/8` và `250/500 ms`: pending translation queue, attempted IDs, numeric batch counter, translation chain và timer cleanup. Không để batch đầu chạy trước khi có complete reading order.

`applyOcrBlock()` còn đúng ba nhiệm vụ:

1. mark `first_ocr`;
2. thêm block vào page artifact;
3. persist artifact.

Nó không ghi progressive `hotOcr` hoặc gọi `queueTranslation()`.

`runProducer()` thực hiện:

1. chạy/reuse OCR;
2. kiểm retired;
3. cleanup prewarm nếu cần;
4. validate `image_w/image_h`;
5. gọi helper tạo ordered view;
6. dịch full page hoặc replay toàn bộ translation cache;
7. kiểm retired trước side effects;
8. finish producer.

### 10.1 Số request và cache hit

- Zero blocks: không request, trace rỗng.
- All-hot translation cache: không request; apply cached items theo ordered view, trace rỗng.
- Partial-hot: không render subset trước. Gửi toàn bộ ordered page một lần và thay thế tất cả translations sau khi response hợp lệ.
- Network path: tối đa một extension `/translate-items` request cho mỗi producer. Một page có thể có nhiều request qua nhiều producer khi retry, replacement hoặc click lại. Retry/failover bên trong server không tính là extension HTTP request mới.
- Nhiều consumers/jobs cùng page có thể chia sẻ producer và request như hiện tại.

Persisted partial replay có thể hiển thị `trans_text` cũ trước attempt mới theo hành vi hiện tại; attempt mới vẫn gửi cả trang và thay toàn bộ kết quả nguyên tử.

### 10.2 Atomic response và retirement

Response được validate exact ID set trước mọi cache/apply. Response reorder hợp lệ được map bằng ID rồi apply theo ordered view. Invalid response không được cache hoặc emit một phần.

Nếu producer retired trong lúc request đang chạy, response thành công vẫn được validate và có thể warm hot translation cache; không apply, emit, persist page hoặc finish. Visible disconnect/cancellation giữ hành vi hiện tại; không cần thêm abort HTTP chỉ để tối ưu đường hiếm.

## 11. Lỗi và telemetry

OCR block error không chặn dịch các OCR block thành công; trang kết thúc `partial` nếu còn block lỗi. Translation failure là atomic: mọi OCR block tham gia full-page request không có translation mới, được tính failed và page `partial`. Kích thước ảnh invalid đi qua `failProducer`.

Giữ error object hiện có: `error.status`, `error.errorCode` và `isRateLimited()`. Không thêm tên snake_case lên JavaScript error. `postJson()` lấy `error_code` từ server; trace bảo toàn machine-readable code và chỉ dùng `translation_failed` khi server/client không cung cấp mã cụ thể.

Giữ `producer.translationBatchTrace` và `page_metrics[].translation_batches` của Spec A. Với full-page:

- zero blocks/all-hot: `[]`;
- mỗi network attempt: đúng một trace:

```json
{
  "batch_id": 1,
  "phase": "full_page",
  "block_ids": ["mọi ordered ID"],
  "block_count": 3,
  "started_ms": 100,
  "duration_ms": 200,
  "status": "success",
  "cache_hit": false,
  "error_code": null
}
```

`status` giữ taxonomy `success`, `failed`, `rate_limited`, `invalid_response`; `error_code` có thể là `invalid_request`, `rate_limited`, `invalid_response` hoặc fallback `translation_failed` tương ứng.

`first_ocr` và `ocr_done` giữ nguyên nghĩa. `first_translation` và `first_overlay` chuyển về sau khi OCR toàn trang hoàn tất. Đây là latency trade-off có chủ ý để lấy page context, không được báo cáo như tối ưu first-overlay.

### 11.1 Deferred review gates cho Task 6

- Finding 4: khi Task 6 sửa orchestration, chuyển validation `reading_direction` cấp `start_scope` ra khỏi vòng lặp job và chốt taxonomy `scope_error`; Task 4 giữ nguyên taxonomy hiện tại để tránh đổi telemetry ngoài scope.
- Finding 6: caller nối `orderPage()` trong Task 6 phải bắt lỗi duplicate geometry vào đường `failProducer`/`completeJob` có `error_code`, không để promise reject không được xử lý.

## 12. Acceptance offline

### 12.1 Reading-order comparator

Node test đọc trực tiếp manifest Spec A, dùng `image`, `width`, `height`, `page_kind`, `reading_direction`, bbox và expected `reading_order`; direction phải được truyền từ từng manifest entry vào helper, không hard-code RTL, không hard-code filename và không viết lại thuật toán bằng Python.

Trên cả ba fixture:

- input block bị shuffle;
- helper output exact-match fixture block IDs theo expected order;
- inferred `page_kind` exact-match manifest: `single`, `spread`, `spread`;
- hai spread có gutter trong hand-written expected gaps:
  - `s-manga_ja_1`: `515 < gutter_x < 594`;
  - `s-manga_ja_2`: `502 < gutter_x < 597`;
- input artifact không bị mutate.

Synthetic cases dùng ID có lexical order mâu thuẫn geometry và expected viết tay:

- single RTL/LTR, mỗi band có ít nhất hai x khác nhau;
- spread RTL/LTR có block ở cả hai nửa;
- LTR vẫn band top-down, không được tạo bằng `reverse(RTL)`;
- panel-gap có gap không chứa tâm rộng hơn gap chứa tâm;
- bbox phủ tâm và no-gap đi fallback `image_w/2`;
- adversarial tall bridge: threshold `0.5` pass, negative control `0.25` fail.
- two-row bridge chạm đúng `0.5` nhập cả hai hàng bằng connected-component chaining;
- bbox lồng/lệch khóa RTL và LTR theo `bbox[0]`, với expected viết tay và lexical ID mâu thuẫn geometry.

Ba fixture thật không biện minh cận thấp của `0.5`; tall-bridge là gate gánh yêu cầu này.

### 12.2 Contract, prompt và error

Tests production và acceptance phải phủ:

- exact allowlist, bbox shape/nonnegative, positive dimensions và required direction;
- duplicate ID, foreign/extra field và non-dense/out-of-order `reading_order` trả `422` + `error_code: "invalid_request"`;
- `server/tests/test_translate_endpoint.py` assertion duplicate ID dùng envelope mới;
- extension nhận `invalid_request` và full-page trace có error code khác `null`;
- server không sort hoặc infer direction;
- prompt có exact JSON page context, `reading_order`, bbox và Portuguese name;
- translator response reorder exact IDs được chấp nhận; missing/foreign/duplicate bị reject nguyên tử.

### 12.3 Settings, cache và version

Tests phủ popup default/display, content storage/onChanged, ba background descriptor boundaries, legacy persisted descriptor, prewarm missing -> RTL nhưng không persist page, invalid direction, key-layer invariants và coarse `PageCache.purgeIncompatible()`.

Recursive version-shape test phải đi xuống nested `recognizers`. Mọi production `/health.langs` phải có recognizer version. Cùng block/context phải đổi translation key khi direction/layout/prompt/policy đổi nhưng giữ analysis/OCR key khi chỉ direction/layout đổi.

### 12.4 Full-page scenarios

Gate chính:

- không request translation trước OCR complete;
- tối đa một request mỗi producer, zero request cho no-block/all-hot;
- partial-hot gửi lại toàn trang và không emit subset sớm;
- response reorder apply đúng reading order;
- invalid response/contract fail atomically;
- stale response chỉ warm cache, không emit;
- retry tạo producer/trace mới hợp lệ trên cùng page;
- OCR errors vẫn cho translation successes; translation failure fail toàn full-page attempt;
- retirement/disconnect không tạo stale page side effects;
- full-page trace đúng shape và telemetry metric giữ nguyên nguồn attribution.

Chỉ rewrite các scenario gắn trực tiếp với microbatch: in-flight replacement, partial replay missing IDs, failed batch/later batch, exact IDs + later click retry và stale cloud response. Các scenario Spec A còn lại phải pass không đổi; failure là regression, không được sửa test để hợp thức hóa.

## 13. Frozen control và worklog

Spec B merge toàn bộ branch Spec A; không cherry-pick riêng fixture. Comparator chỉ viết sau merge và `full_page` chỉ ship sau comparator gate.

Control artifact của Spec A giữ byte-for-byte:

```text
docs/superpowers/worklogs/2026-08-01-real-page-quality-baseline.json
```

Không rebaseline file này bằng full-page traces vì sẽ làm hai arm A/B dùng cùng policy. Spec B tạo worklog JSON ngày mới, chứa:

```json
{
  "control_baseline_path": "docs/superpowers/worklogs/2026-08-01-real-page-quality-baseline.json",
  "control_baseline_commit": "SHA thật của Task 1 merge commit",
  "control_policy": "microbatch-3-8-250-500-v1"
}
```

Artifact cuối không được để placeholder và không dùng Spec A tip thay merge commit SHA.

Gate bảo vệ control:

1. `git diff --exit-code <control_baseline_commit> -- docs/superpowers/worklogs/2026-08-01-real-page-quality-baseline.json`;
2. semantic tripwire tổng policy batches vẫn là `25`;
3. chạy `server/tests/test_real_page_quality.py`, dùng fake generate/sleep hoàn toàn offline.

Live Gemini rerun và chấm tay không phải gate của vertical slice. Nếu cần so chất lượng thật sau này, đó là paced task riêng sau checkpoint. Runtime telemetry mới được ghi vào worklog Spec B, không sửa control lịch sử.

## 14. Thứ tự rollout và review checkpoint

Mỗi task dừng để review; không chuyển task tiếp theo khi checkpoint hiện tại chưa được duyệt.

1. Merge toàn bộ `feat/spec-a-telemetry-quality-gate` vào `feat/v3` bằng merge commit.
2. Chạy full Spec A offline gate theo worklog, vẫn loại `server/tests/test_ocr.py`; ghi SHA merge commit làm immutable control baseline.
3. Thêm `reading-order.js`, dual-load/VM wiring và comparator; comparator phải xanh trước bước sau.
4. Thêm direction setting/boundaries, cache identity, `layout_order`, acceptance health layout và recursive version-shape gates.
5. Thêm PT: shared engine instance, pin PP-OCRv6, config/main/translator/popup, health/recognizer gates và lightweight tests.
6. Ship một atomic vertical slice gồm shared strict contract, request-validation envelope, page-context prompt, cặp prompt/policy version, full-page orchestration, trace mới và xóa microbatch.
7. Trước checkpoint vertical slice, chạy full Spec A extension tests, mọi Spec B offline gate, `server/tests/test_real_page_quality.py`, control diff/tripwire và `git diff --check`. Exclusion duy nhất là `server/tests/test_ocr.py`; không chạy live quality probe.
8. Chỉ đóng checkpoint/commit khi mọi gate yêu cầu xanh và không có scenario Spec A ngoài danh sách rewrite bị sửa để né regression.
9. Sau checkpoint, capture runtime telemetry vào worklog Spec B mới, ghi rõ first-overlay regression/trade-off và đưa qua review.

## 15. Điều kiện hoàn tất Spec B

- Reading-order helper production exact-match ba fixture và toàn bộ synthetic gates cho RTL/LTR.
- Server reject mọi Pydantic contract violation của `/translate-items` bằng `422` + `invalid_request`, không sort hoặc suy input.
- Direction/layout thay đổi không làm đổi analysis/OCR keys nhưng làm đổi translation/overlay keys.
- ES/PT dùng đúng một pinned PP-OCRv6 runtime instance trong khi cache identity vẫn tách.
- Mỗi producer có tối đa một full-page extension request; no-block/all-hot có zero request.
- Response, cache và render là atomic theo exact IDs; retirement không tạo stale side effects.
- Spec A telemetry/error taxonomy còn nguyên và trace full-page có machine-readable error code.
- Frozen control không đổi, mọi required offline gate xanh, `server/tests/test_ocr.py` chỉ được cập nhật tĩnh chứ không chạy.
- Design doc này được người dùng duyệt trước khi viết implementation plan.
