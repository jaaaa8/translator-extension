# Thiết kế tối ưu kiến trúc Chrome extension OCR/dịch manga-comic

> Bản chỉnh sửa ngày 2026-07-30. Tài liệu này lấy `D:\MangaTranslator\ocr-manga-extension-roadmap.md` và số đo thực tế ngày 2026-07-29 làm nguồn chính, sau đó đối chiếu với code hiện tại và ngữ cảnh brainstorming trước đó. File gốc không bị thay đổi.

## 1. Kết luận điều hành

Không cần viết lại toàn bộ hệ thống và chưa nên chuyển OCR sang browser. Kiến trúc hiện tại đúng ở các ranh giới quan trọng: extension chọn ảnh và quản lý UI; server local phát hiện/nhận dạng; cloud chỉ dịch; bbox luôn quy về ảnh gốc; kết quả cũ phải qua nhiều lớp kiểm tra trước khi render.

Thứ tự tối ưu đã được số đo sửa lại:

1. **Sửa correctness nhỏ nhưng chắc chắn:** thêm `dstLang` vào trạng thái “đã dịch”, version hóa key và dùng `blockId` ổn định.
2. **Giảm độ trễ cảm nhận:** stream từng block OCR, ưu tiên viewport và render bản dịch theo đợt nhỏ. Đây là P0 vì hiện người dùng nhìn màn hình trống 12–60 giây.
3. **Giảm công việc thừa:** giữ dedupe box đã triển khai; giới hạn job outstanding; hủy job cũ trước khi chạy hoặc đang fetch.
4. **Tăng throughput thật:** thử PaddleOCR GPU cho `es` trong venv tách biệt. Đây là cơ hội tăng tốc lớn nhất còn lại nhưng có rủi ro DLL trên Windows.
5. **Chỉ làm khi số đo yêu cầu:** cache bền hơn, Shadow DOM, chunk/refine bản dịch, tiling, ONNX/WebGPU và browser-local OCR.

Hai hướng đã được đo và phải loại khỏi roadmap triển khai gần:

- Thu hẹp `_ocr_lock`: chỉ lấy lại khoảng 0.01–0.02 giây trong khi vòng OCR mất 7–13 giây.
- Batch recognizer hiện tại: PaddleOCR vẫn loop nội bộ; recognizer-only không đọc đúng crop nhiều dòng; Manga OCR không có batch API.

## 2. Bằng chứng thực tế và trạng thái code

### 2.1 Baseline đã đo

Số đo warm trên cùng máy/GPU:

| Stage | `ja` — 24 vùng | `es` — 13 vùng |
|---|---:|---:|
| Decode | ~0.01 s | ~0.01 s |
| Detector | 0.18 s | 0.67 s |
| Vòng nhận dạng OCR | **7.18 s** | **13.15 s** |
| End-to-end | 11.8 s | 14.7 s |

Vòng nhận dạng chiếm 91–99% thời gian xử lý local. Manga OCR GPU có trung vị khoảng 0.179 giây/crop; PaddleOCR CPU khoảng 1.068 giây/crop cộng khoảng 0.237 giây overhead mỗi call.

### 2.2 Tối ưu đã chứng minh hiệu quả

Dedupe detector box với IoU `> 0.5`, giữ box lớn hơn, đã được triển khai tại `server/pipeline.py` trong commit `9eeb19f`:

- `es`: 13 → 11 box; 12.62 s → 9.77 s, giảm 23%.
- `ja`: giữ nguyên 24 box; không mất chữ trên hai mẫu đã kiểm tra.
- Ngưỡng 0.5 tránh xóa các box lồng nhau của chữ dọc Nhật có IoU khoảng 0.36.

### 2.3 Trạng thái code hiện tại đã đối chiếu

Tại thời điểm viết bản này:

- `extension/content.js` vẫn dùng `Promise.all()` cho toàn bộ ảnh, gom toàn bộ text, gọi dịch một lần rồi mới render.
- `extension/background.js` vẫn dùng message một lần (`sendMessage`), chưa có `chrome.runtime.connect`, NDJSON hay event streaming.
- `server/main.py` chỉ có `/ocr` trả JSON hoàn chỉnh; chưa có endpoint streaming.
- `server/pipeline.py` đã dedupe box nhưng vẫn nhận dạng tuần tự từng vùng dưới `_ocr_lock`.
- `extension/srcset.js::jobKey()` chưa có `dstLang`; bug đổi ngôn ngữ đích rồi ảnh bị bỏ qua vẫn còn.
- Giao thức dịch vẫn là `texts: string[]` → `translations: string[]`, chỉ kiểm số phần tử.
- Chưa có cancellation thực; token hiện tại chỉ ngăn render stale result.

Do đó B2 “stream và vẽ dần” là quyết định đã chốt trong tài liệu, **chưa phải tính năng đã tồn tại trong code**.

## 3. Kiến trúc hiện tại

```text
Popup
  └─ translateLoaded / translateVisible
       ▼
Content script
  ├─ querySelectorAll("img")
  ├─ lọc ảnh ≥ 400 px
  ├─ loaded: chọn nguồn lớn nhất trong srcset
  └─ visible: dùng currentSrc + viewport crop 10%
       ▼ N message ocrImage tạo cùng lúc
Service worker
  ├─ queue, MAX_CONCURRENT = 2
  ├─ OCR Map cache + single-flight
  ├─ fetch ảnh cross-origin
  └─ POST /ocr
       ▼
Server local
  ├─ decode/crop
  ├─ Comic Text Detector
  ├─ dedupe box
  ├─ prep crop
  └─ Manga OCR hoặc PaddleOCR
       ▼ tất cả OCR hoàn tất
Content script
  └─ gom text của toàn scope
       ▼ một request
Gemini translator
  └─ JSON array cùng thứ tự
       ▼
Content script
  └─ render toàn bộ overlay
```

Luồng này tối ưu số lần gọi Gemini và giữ ngữ cảnh trang, nhưng tạo head-of-line blocking: không có overlay nào trước khi toàn bộ OCR và dịch hoàn tất.

## 4. Điểm mạnh phải giữ

### 4.1 Ranh giới OCR local và dịch cloud

Giữ `/ocr` độc lập với `/translate-texts`:

- OCR có thể cache/retry mà không gọi lại Gemini.
- N ảnh không biến thành N call dịch mặc định.
- Có thể thay recognizer hoặc translator độc lập.
- Ảnh không cần gửi lên dịch vụ dịch cloud.

Endpoint `/translate` gộp OCR + dịch chỉ nên tiếp tục là đường test/curl.

### 4.2 Hệ tọa độ bbox ảnh gốc

Server phải tiếp tục trả `image_w`, `image_h` và bbox đã cộng crop/tile offset. Client không được phải hiểu server đã crop, upscale hay tile ra sao.

### 4.3 Detector text-region chuyên comic

Không thay bằng bubble detector làm cổng bắt buộc. Detector hiện phải tiếp tục bao phủ dialogue, narration, SFX và text nằm trực tiếp trên artwork. Bubble/region classification chỉ là metadata bổ sung sau detection.

### 4.4 Chọn nguồn ảnh theo scope

- `loaded`: ưu tiên biến thể `srcset` lớn nhất để OCR không bị ảnh thấp pixel.
- `visible`: dùng `currentSrc` để phép quy đổi viewport crop khớp ảnh đang render.

### 4.5 Bốn lớp chống stale result

Giữ nguyên các invariant sau khi streaming:

1. Token request theo từng `img`.
2. Kiểm tra ảnh còn trong DOM và nguồn còn hiện hành.
3. Snapshot source/target language khi bắt đầu.
4. Prune overlay khi source thay đổi.

Streaming làm số lần cập nhật tăng lên, nên các kiểm tra này phải chạy cho **mỗi event**, không chỉ khi request kết thúc.

### 4.6 Single-flight và prewarm có kiểm soát

Single-flight cùng OCR key vẫn hữu ích. Prewarm chỉ được giữ nếu benchmark cold/warm chứng minh lợi ích; nó phải có priority thấp và nhường ngay cho thao tác người dùng.

## 5. Bottleneck và mức ưu tiên mới

| Ưu tiên | Vấn đề | Bằng chứng/tác động | Quyết định |
|---|---|---|---|
| P0 | Chờ toàn scope rồi mới dịch/render | `visible` trống 12–15 s; `loaded` trống 40–60 s | Stream OCR và dịch theo micro-batch ưu tiên viewport |
| P0 | `dstLang` thiếu trong translated key | Bug sống khi đổi `vi` ↔ `en` | Sửa key trước refactor lớn |
| P0 | Mapping dịch dựa trên index | Streaming/chunk dễ lệch block | Thêm `requestId`, `jobId`, `blockId`; trả kết quả theo ID |
| P0 | `Promise.all` tạo mọi job ngay | Công việc xa viewport chiếm queue | Scheduler nhỏ, giới hạn outstanding và ưu tiên viewport |
| P1 | `es` chạy PaddleOCR CPU | Chậm hơn khoảng 6×/crop so với Manga OCR GPU | Spike `paddlepaddle-gpu` trong venv riêng; không cài đè |
| P1 | Không hủy queue/fetch cũ | Job stale vẫn chiếm tài nguyên | Hủy queued/fetch; server cancel chỉ giữa các block |
| P1 | Cache Map mất khi MV3 worker ngủ | Prewarm/cache hit không ổn định | Thử `chrome.storage.session` trước; IndexedDB khi thực sự cần bền qua restart/dung lượng lớn |
| P1 | Một call Gemini cho scope lớn | Failure domain và latency tăng | Đặt ngưỡng dựa trên benchmark; chunk theo reading order |
| P1 | Overlay có thể reflow/CSS collision | `fitText` loop và reposition khi scroll | Đo trước; binary search và Shadow DOM nếu có lỗi/jank |
| P2 | Crop đơn giản | Sai với `object-fit`, transform, clip | Thêm site fixture trước khi sửa phép biến đổi |
| P2 | Webtoon ảnh rất cao | Có thể làm detector resize và mất chữ nhỏ | Chỉ tile khi bộ dữ liệu thực tế chứng minh |
| Loại | Thu hẹp `_ocr_lock` | Lợi ích khoảng 0.02 s | Không làm lúc này |
| Loại | Batch recognizer hiện tại | Đã đo không nhanh/không đúng | Không đưa vào kiến trúc mục tiêu |

## 6. Ba hướng kiến trúc đã cân nhắc

### A. Giữ model, stream pipeline hiện tại — khuyến nghị

Thêm event streaming, scheduler, ID ổn định và render incremental; không đổi detector/recognizer trước.

Ưu điểm: tác động đúng TTFT, ít rủi ro accuracy, tận dụng code hiện có. Nhược điểm: tổng thời gian OCR gần như không đổi nếu chưa đưa PaddleOCR lên GPU.

### B. Tối ưu recognizer trước

Đưa `es` lên GPU hoặc thay recognizer Latin, giữ luồng request/response hiện tại.

Ưu điểm: giảm tổng thời gian thật. Nhược điểm: người dùng vẫn chờ tới cuối; Paddle/Torch đã có xung đột DLL thực tế; model thay thế có thể không đọc được crop nhiều dòng.

### C. Chuyển OCR vào browser bằng ONNX Runtime Web/WebGPU

Ưu điểm: không cần server local, có thể giảm round-trip và cải thiện đóng gói sản phẩm. Nhược điểm: conversion model, tải model, RAM, WebGPU compatibility và accuracy đều chưa được chứng minh; round-trip hiện không phải bottleneck.

**Quyết định:** làm A trước; chạy B như spike tách biệt sau khi A có benchmark; chưa làm C.

## 7. Kiến trúc mục tiêu

```text
Popup
  └─ action + requestId + scope + language snapshot
       ▼
Content scheduler
  ├─ chọn candidate như hiện tại
  ├─ ưu tiên viewport / khoảng cách tới viewport
  ├─ giới hạn job outstanding
  └─ gửi cancel cho request cũ
       ▼ Port dài hạn
Service worker
  ├─ priority queue
  ├─ AbortController cho fetch/request
  ├─ L1 Map + single-flight
  ├─ optional chrome.storage.session
  └─ bridge stream từ localhost về content
       ▼
OCR server
  ├─ header: kích thước ảnh + metadata
  ├─ detect toàn vùng + dedupe như hiện tại
  ├─ nhận dạng tuần tự như hiện tại
  ├─ yield một block ngay khi đọc xong
  └─ image_done / error / cancelled
       ▼ block events
Translation aggregator
  ├─ sắp xếp/ghép theo blockId
  ├─ flush batch đầu nhỏ, batch sau lớn hơn
  ├─ structured response theo ID
  └─ optional refine toàn scope
       ▼ translation events
Shadow-DOM overlay hoặc overlay hiện tại
  ├─ upsert theo blockId
  ├─ kiểm request/source/language cho mỗi event
  └─ hoàn thiện/progress/error từng phần
```

### 7.1 Event protocol tối thiểu

Không cần framework streaming mới. NDJSON giữa server và background, `chrome.runtime.Port` giữa background và content là đủ.

```json
{"type":"image_start","request_id":"r1","job_id":"j1","image_w":1200,"image_h":1800}
{"type":"ocr_block","request_id":"r1","job_id":"j1","block_id":"j1:420,180,260,140","bbox":[420,180,260,140],"src_text":"..."}
{"type":"translation","request_id":"r1","job_id":"j1","block_id":"j1:420,180,260,140","trans_text":"...","stage":"final"}
{"type":"image_done","request_id":"r1","job_id":"j1","blocks":12}
{"type":"scope_done","request_id":"r1","images":3,"blocks":31}
```

Quy tắc:

- Mọi event có `request_id`; event theo ảnh có thêm `job_id`.
- `block_id` được tạo từ `job_id` và bbox đã lượng tử hóa; không dùng thứ tự array làm identity.
- Một lỗi nhận dạng block không kết thúc toàn scope.
- `scope_done` là mốc duy nhất để popup báo hoàn tất.
- Client bỏ event nếu request/source/language không còn hiện hành.

### 7.2 Chiến lược dịch progressive

Giữ một call Gemini toàn scope và “hiện bản dịch sớm” là hai mục tiêu xung đột. Ba chính sách có thể benchmark trên cùng transport B2:

1. **Gemini micro-batch:** batch đầu 3–4 block gần viewport, các batch sau 8–12 block hoặc flush theo timer ngắn. Đơn giản nhất nhưng tăng call và có thể giảm consistency.
2. **DeepL draft → Gemini refine:** DeepL trả bản nháp nhanh từng batch; khi scope xong, Gemini sửa toàn bộ theo ngữ cảnh rồi upsert cùng `blockId`. TTFT tốt và vẫn có bản cuối nhất quán, nhưng tăng chi phí/dịch hai lần và có thể gây thay chữ trước mắt người dùng.
3. **Gemini một lần ở cuối:** giữ nguyên chi phí/context nhưng chỉ stream tiến độ OCR, không giải quyết TTFT bản dịch.

Khuyến nghị: hoàn thành transport + upsert trước; benchmark Gemini micro-batch làm baseline. Chỉ thêm DeepL nếu Gemini micro-batch vi phạm rate-limit hoặc consistency. Không hard-code cả hai translator ngay từ đầu.

## 8. Tối ưu theo từng layer

### 8.1 Popup

- Giữ hai scope `visible` và `loaded`.
- Snapshot ngôn ngữ khi bắt đầu và gắn `requestId`.
- Hiển thị tiến độ ngắn: `đang OCR`, `đang dịch`, `x/y vùng`; không cần dashboard.
- Một thao tác mới phải cancel request cũ cùng tab trước khi enqueue request mới.
- Prewarm có priority thấp, debounce khi đổi source language và không bật badge khi lỗi.

### 8.2 Content script

- Thay `Promise.all` bằng vòng scheduler nhỏ; bắt đầu với 4 job outstanding ở content, giữ background `MAX_CONCURRENT=2` cho tới khi benchmark khác chứng minh tốt hơn.
- Sort `loaded` theo ảnh đang thấy trước, rồi theo khoảng cách tới viewport.
- Giữ `bestSource`, `viewportCrop`, source validation và request token.
- Upsert overlay theo `blockId`; không xóa/rerender cả ảnh khi chỉ có một block mới.
- Mỗi event phải qua `manualRequests`, `isCurrentSource` và language snapshot.
- Không thêm MutationObserver/IntersectionObserver toàn trang nếu reader hiện tại chưa cần infinite scroll; dùng khi có site fixture chứng minh.

### 8.3 Background/service worker

- Dùng Port cho stream, message thường cho health/settings vẫn đủ.
- Queue phải chứa `requestId`, priority và `AbortController`.
- Job chưa chạy: xóa khỏi queue khi cancel.
- Job đang fetch/post: abort ngay.
- Job đã ở trong `engine.read()`: không giả vờ có thể dừng giữa call; chỉ kiểm cancel trước block tiếp theo.
- Giữ single-flight theo OCR key; không gộp hai request khác crop hoặc model version.

### 8.4 Server/API

- Giữ `/ocr` JSON để test/tương thích; thêm một đường streaming nhỏ thay vì thay toàn bộ API ngay.
- `StreamingResponse` phát NDJSON sau detection và sau mỗi `engine.read()`.
- Trả lỗi theo block/job; chỉ lỗi decode/validation mới kết thúc ảnh.
- Giữ bbox ở tọa độ ảnh gốc.
- Không tách lock theo stage lúc này. Thêm cancel check giữa các block là đủ.
- Dùng `time.perf_counter()` quanh detector, dedupe, từng engine read và tổng request; chưa cần OpenTelemetry.

### 8.5 Detector

- Giữ Comic Text Detector hiện tại và dedupe IoU 0.5.
- Thêm regression case cho box lồng chữ dọc Nhật trước khi đổi threshold.
- Ghi `regions_before_dedupe`, `regions_after_dedupe`, detector time.
- Không thêm bubble detector, classifier region hoặc model mới nếu mục tiêu hiện tại chỉ là tốc độ và recall đã đạt.

### 8.6 Recognizer

- Giữ Manga OCR cho `ja`.
- Giữ PaddleOCR CPU làm fallback ổn định cho `es` trong môi trường hiện tại.
- Spike PaddleOCR GPU phải ở venv riêng; kiểm tra cả hai import order `torch → paddle` và `paddle → torch`, startup server, VRAM, CER/WER và crash lặp.
- Mọi recognizer thay thế cho Latin phải đọc đúng **crop nhiều dòng**, không chỉ benchmark line recognition.
- Không tạo nhiều worker GPU hay batch wrapper quanh API hiện tại khi benchmark đã bác bỏ.

### 8.7 Translator

- Chuyển input/output sang object có ID:

```json
{"items":[{"id":"j1:b1","text":"..."}]}
```

```json
{"items":[{"id":"j1:b1","translation":"..."}]}
```

- Validate tập ID: không thiếu, không lạ, không duplicate.
- Nếu SDK/model Gemini hiện tại hỗ trợ response schema, dùng schema; nếu không, JSON mode + validation ID hiện tại là đủ.
- Version hóa `promptVersion` và `translatorModel` trong translation key.
- Retry chỉ phần batch lỗi; không dịch lại các batch đã xác nhận.
- Đặt giới hạn batch theo tổng ký tự/token đo được, không theo số ảnh cố định.

### 8.8 Overlay

- Giai đoạn B2 chỉ cần upsert bubble theo `blockId` trên cơ chế overlay hiện có.
- Chuyển sang Shadow DOM khi đã có ít nhất một CSS collision thực tế hoặc khi mở rộng site support.
- Đổi `fitText` sang binary search 10–18 px nếu metric cho thấy layout cost đáng kể.
- Scroll thông thường chỉ prune/visibility; reposition khi resize/layout/source thay đổi.
- `pointer-events: none` mặc định; chỉ bật tương tác khi có yêu cầu copy/sửa.

### 8.9 Cache

Tách ba identity:

```text
ocrKey = source + srcLang + normalizedCrop
       + detectorVersion + recognizerVersion + prepVersion

translationKey = hash(ordered blockId + srcText)
               + srcLang + dstLang + translatorModel + promptVersion

overlayKey = source + normalizedCrop + srcLang + dstLang + translationKey
```

- L1: `Map` trong service worker.
- L2 tối thiểu: `chrome.storage.session` nếu mục tiêu chỉ là sống qua service-worker sleep.
- IndexedDB chỉ khi cần cache qua browser restart, lưu nhiều chapter hoặc quota/session đã đo là không đủ.
- Không cache image bytes; chỉ cache dimensions, bbox, source text và metadata phiên bản.
- `ocrInFlight` chỉ ở RAM.
- Có giới hạn dung lượng, clear cache và không lưu trong chế độ riêng tư nếu sản phẩm yêu cầu.

## 9. Công nghệ có thể áp dụng thêm

| Công nghệ | Giá trị | Quyết định hiện tại |
|---|---|---|
| FastAPI `StreamingResponse` + NDJSON | Stream block không cần WebSocket | Dùng cho B2 |
| `chrome.runtime.connect` / Port | Kênh event dài hạn giữa content và worker | Dùng cho B2 |
| `AbortController` | Hủy fetch/request stale | Dùng P0/P1 |
| `chrome.storage.session` | Cache qua MV3 worker sleep với ít code | Thử trước IndexedDB |
| IndexedDB | Cache lớn và bền qua browser restart | Chỉ dùng khi có nhu cầu đo được |
| Shadow DOM | Cô lập CSS overlay | P1, sau fixture collision |
| PaddleOCR GPU | Cơ hội throughput lớn cho `es` | Spike venv riêng |
| DeepL | Draft translation nhanh | Chỉ thử sau transport B2 |
| ONNX Runtime Web + WebGPU | Browser-local inference | P2 research |
| `OffscreenCanvas` / `ImageBitmap` | Decode/crop ngoài main thread | Chỉ khi browser-side image work gây jank |
| `captureVisibleTab` | Fallback canvas/CORS | Chỉ cho site không fetch được ảnh |

## 10. Concurrency, batching, cancellation, tiling và streaming

### 10.1 Concurrency

- `_ocr_lock` khiến ML inference hiện vẫn tuần tự. `MAX_CONCURRENT=2` chủ yếu overlap fetch/upload và giữ một request chờ server.
- Không tăng concurrency theo số core/GPU bằng trực giác.
- Benchmark các profile `1`, `2`, `3` request với cùng dataset; chọn profile có p95 scope tốt nhất mà không tăng VRAM crash/CER.
- Ưu tiên đúng job quan trọng hơn tăng số job chạy song song.

### 10.2 Batching

- Không batch recognizer hiện tại: đã đo thất bại.
- Batching đáng dùng ở translator và event flush, nơi API thực sự nhận mảng.
- Batch đầu nhỏ để TTFT thấp; batch sau lớn hơn để giảm call. Các con số 3–4 và 8–12 chỉ là điểm bắt đầu benchmark, không phải config vĩnh viễn.

### 10.3 Cancellation

```text
queued       → xóa ngay
fetch/upload → AbortController
waiting lock → bỏ trước khi vào inference nếu kiểm được
engine.read  → không ngắt giữa call; bỏ trước block kế tiếp
translated   → bỏ event nếu token/source/language stale
```

Server-side task registry/WebSocket cancel không cần ở P0. Chỉ thêm nếu log cho thấy job stale vẫn chiếm phần đáng kể thời gian OCR.

### 10.4 Tiling

Tiling không phải tối ưu tốc độ hiện tại vì detector chỉ mất 0.18–0.67 giây và accuracy đang ổn. Chỉ bật cho ảnh vượt ngưỡng chiều cao được xác định từ dữ liệu p95 hoặc khi detector resize làm mất text nhỏ.

Nếu cần:

```text
tile 1024–1536 px
overlap 96–160 px
→ quy bbox về ảnh gốc
→ dedupe tại overlap
```

Ngưỡng cuối phải đến từ benchmark, không hard-code theo tài liệu này.

### 10.5 Streaming

- Detector hiện trả toàn bộ vùng trước; streaming bắt đầu sau detection, điều này vẫn đủ vì detector rất nhanh.
- Recognizer yield từng block; translation aggregator flush theo ưu tiên.
- Không cần detector và recognizer “đua” trên cùng ảnh ở P0.
- Với webtoon rất cao sau này, mới cân nhắc detector tile N+1 overlap recognizer tile N.

## 11. Roadmap thực thi

### P0 — sửa đúng và xóa màn hình trống

1. Chốt baseline tự động cho hai mẫu hiện có; lưu TTFT, total time, block count và output text.
2. Sửa translated/overlay key có `dstLang` và version; thêm regression test đổi `vi` → `en`.
3. Thêm `requestId`, `jobId`, `blockId`; đổi giao thức dịch từ index sang ID.
4. Thêm endpoint NDJSON streaming và Port bridge.
5. Upsert overlay theo từng translation event, giữ đủ bốn kiểm tra stale.
6. Thay `Promise.all` bằng scheduler ưu tiên viewport và giới hạn outstanding.
7. Thêm cancel queue/fetch; prewarm luôn có priority thấp.
8. Benchmark Gemini micro-batch và chọn batch policy tối thiểu đạt TTFT mục tiêu.

**Điều kiện ra khỏi P0:** TTFT giảm rõ rệt, không mất block, không render sai ngôn ngữ/nguồn và total time không hồi quy đáng kể.

### P1 — throughput, độ bền và UI

1. Spike PaddleOCR GPU trong venv riêng; chỉ tích hợp nếu nhanh ít nhất 2× trên `es` và accuracy không giảm.
2. Thử `chrome.storage.session` cho OCR cache; chỉ nâng IndexedDB nếu quota/persistence không đủ.
3. Thử DeepL draft → Gemini refine nếu Gemini micro-batch không đạt rate-limit/consistency.
4. Thêm response schema nếu Gemini SDK/model đang dùng hỗ trợ ổn định.
5. Tối ưu overlay: binary-search font; giảm reposition; Shadow DOM khi có fixture/site lỗi.
6. Đặt ngưỡng chunk translation cho chapter dài từ benchmark thực.

### P2 — chỉ theo nhu cầu dữ liệu

1. Tiling webtoon và overlap dedupe.
2. Hỗ trợ `object-fit`, CSS transform, canvas/screenshot fallback theo site fixture.
3. Prototype một stage ONNX/WebGPU; không rewrite toàn pipeline.
4. Region classification, reading-order nâng cao và recognizer fallback cho SFX.
5. Cache bền nhiều chapter/IndexedDB nếu người dùng thực sự quay lại chapter cũ.

### Không làm

- Thu hẹp `_ocr_lock` lúc này.
- Batch wrapper cho recognizer hiện tại.
- OpenTelemetry/trace platform đầy đủ.
- Browser-local rewrite trước khi có benchmark model và hardware mục tiêu.
- Bubble detector làm cổng lọc bắt buộc.

## 12. Risk và trade-off

| Risk | Hệ quả | Cách kiểm soát |
|---|---|---|
| Streaming làm event về không đúng thứ tự | Gắn sai bubble/bản dịch | `blockId`, upsert idempotent, validate request/source/language |
| Gemini micro-batch mất context | Đại từ/giọng văn không nhất quán | Batch theo reading order; gửi context ngắn; benchmark refine pass |
| DeepL draft dịch trung thành lỗi OCR | Bản nháp có thể sai rõ | Gắn stage draft/final nội bộ; Gemini refine; không dùng nếu UX thay chữ gây khó chịu |
| Nhiều call dịch tăng 429/chi phí | Chậm hoặc lỗi từng phần | Batch tăng dần, retry theo batch, đo calls/chapter và cost/block |
| Paddle GPU xung đột Torch DLL | Server không khởi động | Venv/prototype riêng, không cài đè môi trường ổn định |
| Dedupe xóa box lồng hợp lệ | Mất chữ dọc/SFX | Giữ IoU 0.5 và golden regression Nhật/Latin |
| Port/service worker bị ngắt | Scope dở dang | Event idempotent, báo lỗi từng job, cho phép bấm retry; chưa cần resume phức tạp |
| Cache stale sau đổi model/prompt | Kết quả cũ che cải tiến | Version trong mọi key |
| Cache chứa nội dung nhạy cảm | Rủi ro privacy | Chỉ lưu text/bbox cần thiết, clear cache, policy private |
| Shadow DOM làm khó copy/style | UX giảm | `pointer-events` và interaction mode rõ ràng; chỉ triển khai khi cần |
| Tiling tạo duplicate ở overlap | OCR/dịch lặp | Offset chuẩn + dedupe overlap trước recognition khi có thể |

## 13. Câu hỏi còn bỏ ngỏ

Các câu hỏi này không chặn P0; chúng quyết định P1/P2:

1. Tỉ lệ sử dụng thực tế giữa manga page thường và webtoon ảnh rất cao là bao nhiêu? Kích thước ảnh và block count p50/p95?
2. `MAX_CONCURRENT=2` từng được chọn từ benchmark hay chỉ là giới hạn an toàn?
3. Ngoài `ja`, `es` → `vi`, `en`, ngôn ngữ nào thật sự nằm trong scope sản phẩm?
4. Consistency cần ở mức viewport, page hay cả chapter?
5. Người dùng có chấp nhận bản dịch nháp đổi thành bản final sau vài giây không?
6. Chi phí/rate-limit DeepL + Gemini có chấp nhận được không, và ảnh/text có yêu cầu privacy nào?
7. Site mục tiêu nào dùng `object-fit`, transform, canvas, ảnh ghép tile, anti-hotlink hoặc virtualized DOM?
8. Overlay cần chỉ đọc, selectable/copyable, hay thay thế text hoàn toàn? Bản dịch dài hơn bbox được phép mở rộng tới đâu?
9. Cache cần sống qua service-worker sleep, browser restart hay nhiều ngày/chapter?
10. Prewarm giảm cold-start bao nhiêu trên máy thật, và bao nhiêu lần chạy vô ích khi người dùng chỉ mở popup?
11. Ngưỡng block/ký tự nào bắt đầu làm Gemini chậm, lỗi JSON hoặc 429? Hiện mới biết 24 block vẫn ổn.
12. Đã có golden dataset đủ dialogue, narration, SFX, chữ dọc và Latin nhiều dòng chưa?

## 14. Checklist benchmark

### 14.1 Bộ dữ liệu

- [ ] Hai ảnh baseline hiện có: `mangadex.jpeg` (`es`) và `AisazuNihaIrarenai-003.jpg` (`ja`).
- [ ] Manga Nhật chữ dọc, box lồng nhau.
- [ ] Comic Latin nhiều dòng trong một bubble.
- [ ] Narration và text ngoài bubble.
- [ ] SFX nhỏ/lớn, nghiêng hoặc hòa vào artwork.
- [ ] Ảnh responsive có `srcset` thấp/cao.
- [ ] Webtoon dài và trang có nhiều ảnh loaded.
- [ ] Fixture đổi `src`, đổi `dstLang`, bấm dịch hai lần và cancel.
- [ ] Fixture CSS collision/object-fit nếu các site mục tiêu dùng.

### 14.2 Điều kiện đo

- [ ] Ghi hardware, driver, Python/Chrome/model version.
- [ ] Đo cold và warm riêng.
- [ ] Dùng cùng ảnh, cùng crop, cùng language và cùng prompt.
- [ ] Chạy đủ vòng để lấy p50/p95; không so một lần chạy.
- [ ] Tách detector, dedupe, từng engine read, translation và overlay timing bằng monotonic clock.
- [ ] Ghi block count trước/sau dedupe và số request dịch.

### 14.3 Correctness

- [ ] Detector recall không thấp hơn baseline cho dialogue/narration/SFX.
- [ ] Không có overlay trùng cho box đã dedupe.
- [ ] Bbox overlay đúng khi visible crop và loaded full image.
- [ ] Mọi translation ID khớp đúng một block; không thiếu/lạ/trùng.
- [ ] Đổi `vi` → `en` thực sự OCR/cache đúng và render lại tiếng Anh.
- [ ] Kết quả request cũ không xuất hiện sau request mới.
- [ ] Source lazy-load đổi giữa chừng không nhận overlay cũ.
- [ ] Lỗi một block/ảnh không xóa kết quả hợp lệ của block/ảnh khác.

### 14.4 Performance và UX

- [ ] Time-to-first-OCR-block p50/p95.
- [ ] Time-to-first-translation p50/p95.
- [ ] Time-to-viewport-complete p50/p95.
- [ ] Total-scope time p50/p95.
- [ ] Queue wait, cancel latency và stale work ratio.
- [ ] CPU, RAM, VRAM peak và crash rate.
- [ ] Cache hit L1/session và số OCR call tránh được.
- [ ] Translation calls/chapter, 429/retry rate và chi phí/block.
- [ ] Long task/layout time khi render và scroll.

## 15. Tiêu chí thành công

Các ngưỡng ban đầu dưới đây dùng để quyết định pass/fail; điều chỉnh sau khi có nhiều máy hơn:

- TTFT bản dịch cho scope `visible`: p50 ≤ 5 giây, p95 ≤ 8 giây trên máy baseline.
- Scope `loaded`: block gần viewport phải xuất hiện trước khi toàn scope hoàn tất; TTFT không tăng tuyến tính theo số ảnh loaded.
- Tổng thời gian của B2 không chậm hơn baseline quá 10% nếu chưa đổi recognizer.
- Detector/block recall bằng baseline; không chấp nhận tăng tốc bằng cách bỏ narration, SFX hoặc text ngoài bubble.
- Không có translation gắn sai ID, overlay stale hoặc bug đổi ngôn ngữ đích trong test race.
- Cancel phải loại toàn bộ job queued và dừng fetch đang chạy; inference hiện tại được phép hoàn tất block đang đọc nhưng không bắt đầu block stale tiếp theo.
- Cache exact-key phải tránh 100% OCR call lặp trong cùng session; cache version mới phải miss đúng.
- PaddleOCR GPU chỉ được tích hợp nếu `es` nhanh ít nhất 2×, output không giảm chất lượng và server khởi động ổn định nhiều lần.
- Không tăng crash/timeout/429 có ý nghĩa thống kê so với baseline.

## 16. Quyết định cuối cùng

Đường ngắn nhất có cơ sở thực tế là:

```text
sửa dstLang/version key
→ thêm ID ổn định
→ stream block + ưu tiên viewport + upsert overlay
→ cancel queued/fetch stale
→ benchmark translation micro-batch
→ spike PaddleOCR GPU trong venv riêng
→ chỉ sau đó mới cân nhắc cache lớn, DeepL refine, tiling và WebGPU
```

Mục tiêu P0 không phải làm OCR engine nhanh hơn bằng mọi giá. Mục tiêu là để người dùng thấy bản dịch hữu ích sớm trong khi vẫn giữ độ bao phủ text đã đạt được; đồng thời không tiếp tục đầu tư vào hai hướng đã bị số đo bác bỏ: thu hẹp lock và batch recognizer hiện tại.
