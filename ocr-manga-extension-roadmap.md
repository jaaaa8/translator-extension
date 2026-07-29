# Roadmap tối ưu extension OCR manga/comic

## Mục tiêu và nguyên tắc

Extension hiện ưu tiên độ chính xác: phát hiện được text trong bóng thoại, narration và text ngoài bóng thoại; OCR chạy local, còn dịch chạy cloud. Vấn đề chính là độ trễ cảm nhận và tổng thời gian xử lý chapter. Hướng tối ưu nên là giảm thời gian chờ của người dùng và lượng công việc dư thừa, **không đánh đổi độ bao phủ text đã đạt được**.

Nguyên tắc triển khai:

- Đo trước khi thay đổi: tối ưu theo dữ liệu profiling, không theo cảm giác.
- Ưu tiên ảnh/vùng gần viewport và hiển thị kết quả sớm.
- Giữ detector comic chuyên dụng; không thay bằng bubble detector làm cổng bắt buộc vì sẽ bỏ sót SFX, narration và chữ đè lên artwork.
- Tách cache OCR khỏi cache dịch; mọi cache phải có version của model/prompt.
- Hủy công việc không còn cần thiết thay vì chỉ bỏ kết quả về muộn.

---

## 1. Cấu trúc hiện tại

```text
Popup
  └─ translateLoaded / translateVisible
       └─ Content script: chọn ảnh ứng viên
            └─ Background/service worker: queue, cache, fetch cross-origin
                 └─ Server local: detect vùng chữ + OCR
                      └─ Content script: gom toàn bộ text
                           └─ Server: Gemini dịch một request cho cả scope
                                └─ Content script: render overlay trên trang
```

### 1.1 Popup

- Hai scope: `loaded` quét mọi ảnh đã tải trong DOM; `visible` chỉ xử lý phần ảnh giao viewport.
- `translate()` khóa hai nút trong khi chạy, gửi `translatePage` đến tab đang mở và hiển thị tổng số ảnh/bubble sau khi hoàn tất.
- `prewarmInitialPage()` chỉ chạy sau khi settings và `/health` đã sẵn sàng; chọn ảnh lớn nhất trong viewport để đưa model OCR vào trạng thái nóng và tận dụng luôn kết quả cache.

### 1.2 Content script: chọn ảnh và lập yêu cầu

`translatePage()` quét `document.querySelectorAll('img')`, sau đó `selectCandidates()`:

1. Chỉ giữ ảnh đã tải, `naturalWidth`/`naturalHeight` đủ lớn (ngưỡng hiện tại 400 px), loại icon/avatar/banner.
2. Với scope `visible`, chỉ giữ ảnh có diện tích giao viewport.
3. Chọn nguồn ảnh:
   - `loaded`: duyệt `srcset` và ưu tiên descriptor lớn nhất để OCR không bị ảnh responsive độ phân giải thấp.
   - `visible`: dùng `currentSrc`, vì crop được quy đổi theo chính ảnh đang render.
4. Với `visible`, tính `viewportCrop()` kèm đệm 10%.
5. Bỏ ảnh đã dịch theo key.

Mỗi job hiện gồm `{ img, source, crop, key }`. Tất cả job được gửi bằng `Promise.all`; service worker mới là nơi giới hạn thực thi.

### 1.3 Service worker: điều tiết, cache và tải ảnh

- `pump()` giới hạn tối đa `MAX_CONCURRENT = 2` yêu cầu OCR.
- `ocrCache` lưu kết quả OCR; `ocrInFlight` gộp các yêu cầu đồng thời cùng key (single-flight).
- Worker fetch URL ảnh với quyền cross-origin, đóng gói `multipart/form-data` gồm ảnh, `src_lang` và crop, rồi POST `/ocr`; timeout OCR là 60 giây.
- Dịch được gọi qua `translateTexts`, POST `/translate-texts`, timeout 300 giây. Lỗi không phải prewarm sẽ bật badge `!`.

### 1.4 Server OCR local

Pipeline `/ocr` hiện tại:

```text
decode bytes
→ lưu kích thước ảnh gốc
→ crop (nếu có), giữ offset
→ Comic Text Detector
→ clamp bbox + cắt crop từng vùng
→ upscale vùng thấp hơn 48px + thêm viền trắng 8px
→ lazy-load recognizer theo src_lang
→ trả blocks với bbox theo tọa độ ảnh gốc
```

- `ja` dùng Manga OCR (GPU khi có); `es` dùng PaddleOCR CPU với các model phụ tắt.
- `_ocr_lock` hiện serial hóa toàn bộ `Pipeline.ocr_image()` vì model dùng chung.
- Kết quả có `image_w`, `image_h` và `blocks[{bbox, src_text}]`; client không cần biết server có crop/preprocess hay không.

### 1.5 Gom và dịch

- Content script gom `src_text` từ mọi ảnh thành một mảng phẳng; mỗi slot lưu `indices` để gắn bản dịch trả về đúng block.
- Nếu không có text, gỡ overlay cũ và không gọi Gemini.
- Nếu có text, toàn bộ scope dùng một lần gọi Gemini để giữ nhất quán đại từ/mức lịch sự.
- Translator yêu cầu JSON array có đúng số phần tử, retry tối đa hai lần khi số lượng lệch; khi 429 thì thử key phụ và giữ key hoạt động mới nếu thành công.

### 1.6 Overlay

- Overlay là `div.mt-overlay` đặt trực tiếp dưới `document.body`; mỗi bubble là `div.mt-bubble` dùng `textContent`.
- `position()` lấy vị trí document của ảnh rồi scale bbox theo `rect.width / image_w`.
- `fitText()` giảm cỡ chữ từ 18px xuống tối thiểu 10px đến khi không tràn.
- `ResizeObserver` reposition khi ảnh đổi kích thước; với scope visible, `IntersectionObserver` gỡ overlay khi ảnh rời viewport.
- Scroll/resize gọi `repositionOverlays()` và `schedulePrune()`.

### 1.7 Bảo vệ race condition hiện có

1. `manualRequests: WeakMap<img, request>` loại kết quả của lần bấm cũ theo từng ảnh.
2. `isCurrentSource()` kiểm tra ảnh vẫn còn trong DOM và nguồn ảnh chưa bị lazy-loader thay đổi.
3. Snapshot `requestSrcLang`/`requestDstLang` lúc bắt đầu để cấu hình giữa chừng không làm lẫn OCR và dịch.
4. `pruneOverlays()` gỡ overlay của ảnh bị đổi nguồn, được gom vào `requestAnimationFrame`.

Đây là nền tảng đúng và cần giữ khi tái cấu trúc.

---

## 2. Các điểm nghẽn hiệu năng chính

| Mức ưu tiên | Điểm nghẽn | Tác động | Nhận định |
|---|---|---|---|
| P0 | `_ocr_lock` khóa cả decode, detect, prep và recognition | Hai request client không tạo concurrency ML thật | `MAX_CONCURRENT=2` chủ yếu chỉ overlap fetch/upload/chờ, inference vẫn nối đuôi |
| P0 | Chờ OCR xong toàn scope rồi mới dịch | Time-to-first-translation cao | Mất lợi ích của việc ảnh/vùng đầu đã xử lý xong |
| P0 | `Promise.all` bắn toàn bộ ảnh | Queue/message/promise lớn ở webtoon dài | Worker có giới hạn chạy nhưng content script vẫn tạo toàn bộ công việc ngay |
| P1 | Recognize từng bbox thay vì batch | GPU/CPU sử dụng chưa hiệu quả | Detector thường trả nhiều vùng cho cùng một ảnh/tile |
| P1 | OCR cache trong RAM service worker | Cache mất khi Manifest V3 worker ngủ | Prewarm và lần dịch sau không ổn định |
| P1 | Reposition mọi overlay theo scroll | Có thể gây jank khi nhiều bubble | Tọa độ document không đổi chỉ vì scroll thông thường |
| P1 | `fitText()` giảm từng pixel | Layout thrashing | Nhiều lần đo layout cho mỗi bubble |
| P2 | Một request Gemini cho scope rất lớn | Payload/rate-limit/retry có failure domain lớn | Tối ưu context tốt nhưng sẽ gãy ở chapter dài |
| P2 | Crop dựa trên rect đơn giản | Có thể sai với `object-fit`, transform, clip | Độ đúng visual giảm ở site không chuẩn |
| P2 | Không cancel công việc cũ thực sự | GPU/network vẫn bị chiếm | Token chỉ ngăn render stale, không giải phóng tài nguyên |

---

## 3. Hạng mục cần sửa

### P0 — làm trước

#### 3.1 Thu hẹp lock OCR theo stage

Thay `_ocr_lock` cho toàn pipeline bằng lock tối thiểu:

```text
decode/crop/preprocess: chạy ngoài lock
detector inference: detector lock riêng
recognizer inference: lock riêng theo engine/language
```

Mục tiêu là để request B có thể decode/crop/prep trong khi GPU đang infer request A. Chỉ tăng concurrency inference sau khi benchmark VRAM, độ ổn định và throughput; lock hiện tại có thể là điều kiện đúng nếu model không thread-safe.

#### 3.2 Batch recognition trong một ảnh hoặc tile

Sau detector:

```text
detect toàn bộ vùng
→ prep tất cả crop
→ group theo orientation/aspect ratio
→ recognizer.read_batch(crops)
```

Không tăng số worker trước khi xác minh recognizer batch. Một session GPU có batch nhỏ thường tốt hơn nhiều session tranh GPU.

#### 3.3 Scheduler ưu tiên viewport và giới hạn outstanding jobs

Thay `Promise.all` không giới hạn bằng scheduler nhỏ phía content script:

- chỉ giữ 4–8 job outstanding;
- với scope `loaded`, sort ảnh theo khoảng cách tới tâm viewport;
- ưu tiên P0: đang thấy, P1: ảnh kế tiếp, P2: phần xa hơn;
- prewarm là priority thấp và bị hủy khi có tác vụ người dùng.

Việc này không đổi accuracy, nhưng cải thiện rõ rệt cảm giác phản hồi.

#### 3.4 Tách key OCR, key bản dịch và version

Khóa hiện tại phải phản ánh đúng đầu ra:

```text
ocrKey = source + srcLang + normalizedCrop + detectorVersion + recognizerVersion + prepVersion
translationKey = OCR-result-hash + srcLang + dstLang + translatorModel + promptVersion
overlayKey = source + normalizedCrop + srcLang + dstLang + translationKey
```

`dstLang` bắt buộc có trong trạng thái “đã dịch”, nếu không đổi ngôn ngữ đích có thể bị bỏ qua sai. Quantize crop hoặc dùng crop theo pixel gốc để tránh số float gần nhau tạo cache key khác nhau.

#### 3.5 Chuyển giao thức dịch từ index sang ID ổn định

Gửi:

```json
[{"id":"page-3:block-7","text":"..."}]
```

Nhận:

```json
[{"id":"page-3:block-7","translation":"..."}]
```

Server/client cần validate: tất cả ID yêu cầu xuất hiện đúng một lần, không có ID lạ, không có duplicate. Đây là bảo vệ chắc hơn việc chỉ so `length` của hai array.

### P1 — làm sau khi có số đo P0

#### 3.6 Cancellation thực sự

- Gắn `requestId` cho một lần dịch.
- Job chưa chạy: xóa khỏi queue.
- Job fetch/upload: dùng `AbortController`.
- Khi request mới bắt đầu: hủy job stale, không chỉ bỏ kết quả.
- Server-side cancellation chỉ làm khi profiling cho thấy inference stale chiếm đáng kể; tối thiểu kiểm disconnect/cancel flag giữa detect và recognize.

#### 3.7 Persistent cache

Giữ `Map` làm L1 cache nhanh và dùng IndexedDB làm L2:

```text
key, blocks, dimensions, model/prompt version,
createdAt, lastAccessedAt, byteEstimate
```

Thêm giới hạn dung lượng, LRU/TTL, nút xóa cache và tùy chọn không lưu dữ liệu ở chế độ riêng tư. `ocrInFlight` vẫn chỉ nằm RAM.

#### 3.8 Overlay cô lập và giảm reflow

- Chuyển root overlay sang Shadow DOM để CSS trang không ảnh hưởng.
- `pointer-events: none` mặc định; chỉ mở tương tác nếu có nhu cầu copy/sửa.
- Chỉ reposition khi ResizeObserver, nguồn ảnh/DOM layout thay đổi; scroll chủ yếu chỉ prune/kiểm tra visibility.
- Đổi `fitText()` sang binary search trong khoảng 10–18px, batch các thay đổi bằng `requestAnimationFrame`.

#### 3.9 Chunk dịch có kiểm soát

Giữ một call khi scope nhỏ. Khi vượt ngưỡng (ví dụ số block/tổng ký tự đã đo), chia theo nhóm đọc gần nhau thay vì chia theo ảnh cứng. Mỗi batch dùng glossary/style context rút gọn từ batch trước để giảm mất nhất quán.

### P2 — chỉ thực hiện khi profiling chứng minh cần

#### 3.10 Tiling và streaming detector → recognizer

Áp dụng cho webtoon/ảnh rất cao:

```text
tile 1024–1536px, overlap 96–160px
detector tile N+1 chạy song song recognizer vùng tile N
→ quy đổi bbox về ảnh gốc
→ merge/NMS vùng trùng tại overlap
```

Không nên thêm trước cho manga page thường nếu detector hiện đã đủ nhanh; đây là độ phức tạp lớn nhất trong roadmap.

#### 3.11 Reading order, region type và fallback

- Xác định reading mode theo site/user: manga RTL, comic LTR, webtoon top-down.
- Phân loại `dialogue`, `narration`, `sfx`, `sign`, `unknown` sau text detection (không dùng bubble detection để lọc đầu vào).
- Với confidence thấp: retry preprocessing/resolution hoặc recognizer fallback.

---

## 4. Công nghệ có thể áp dụng thêm

| Nhu cầu | Công nghệ/hướng áp dụng | Khi nên dùng |
|---|---|---|
| Inference local trong browser | ONNX Runtime Web + WebGPU | Khi muốn giảm round-trip server và model đã chuyển ONNX, benchmark tốt trên Chrome mục tiêu |
| Xử lý ảnh ngoài main thread | `ImageBitmap`, `OffscreenCanvas`, dedicated Worker/offscreen document | Khi decode/crop/overlay gây jank; không cần nếu server local vẫn là kiến trúc chính |
| Cache bền trong extension | IndexedDB | Cần ngay khi cache RAM bị mất do MV3 worker ngủ |
| Điều tiết công việc | Priority queue + `AbortController` | Cần khi webtoon dài, lazy-load hoặc người dùng bấm lại liên tục |
| Quan sát ảnh mới | `MutationObserver` + `IntersectionObserver` | Reader infinite-scroll/lazy-loading |
| OCR detector | Giữ Comic Text Detector; cân nhắc model ONNX/RT-DETR chuyên comic sau benchmark | Chỉ thay khi có tập ảnh benchmark cho thấy nhanh hơn mà không giảm recall |
| Recognition đa ngôn ngữ | Manga OCR cho tiếng Nhật; PaddleOCR/recognizer chuyên ngôn ngữ khác | Cần manhwa/manhua/comic Latin; route theo lựa chọn người dùng hoặc chapter-level language lock |
| Batch server GPU | API batch của recognizer hoặc queue nội bộ gom crop 10–30ms | Khi benchmark cho thấy nhiều crop nhỏ và GPU utilization thấp |
| Overlay isolation | Shadow DOM | Nên làm sớm nếu extension hỗ trợ nhiều web lạ |
| Observability | OpenTelemetry-style trace IDs hoặc JSON timing đơn giản | Bắt đầu bằng log/timing đơn giản; chỉ thêm hệ thống lớn nếu cần phân tích dài hạn |
| Screenshot fallback | `chrome.tabs.captureVisibleTab` | Chỉ khi ảnh/canvas không fetch được; cần xử lý scroll/DPR/zoom nên không dùng mặc định |

### Ghi chú về browser-local OCR

Browser-local OCR có thể giảm upload và latency sau warm-up, nhưng không mặc định “nhanh hơn”: tải model, WebGPU compatibility, RAM và conversion model là chi phí thật. Hướng hợp lý là benchmark theo từng giai đoạn:

1. Tối ưu server pipeline và scheduler trước.
2. Dùng ONNX/WebGPU cho detector hoặc recognizer trên một nhóm người dùng/máy thử nghiệm.
3. Giữ server local/hybrid fallback cho hardware không phù hợp và ảnh khó.

---

## 5. Lộ trình ưu tiên đề xuất

### Phase 0 — Baseline (1–2 ngày)

Thêm metric và lưu một bộ benchmark đại diện: manga page thường, trang chữ dày, webtoon dài, ảnh responsive nhỏ/ảnh gốc lớn, trang lazy-load, và ảnh chứa SFX/narration. Chưa đổi thuật toán.

**Tiêu chí hoàn thành:** có p50/p95 cho từng stage, recall detector/OCR baseline và time-to-first-translation.

### Phase 1 — Quick wins, ít rủi ro

1. Thêm version + `dstLang` vào key.
2. Dùng ID ổn định cho request/response dịch.
3. Scheduler giới hạn outstanding job và ưu tiên viewport.
4. Cancellation queue/fetch.
5. Shadow DOM, binary-search `fitText`, bỏ reposition toàn bộ chỉ vì scroll.

**Mục tiêu:** giảm latency cảm nhận mà không thay model hay giảm recall.

### Phase 2 — Throughput OCR

1. Đo rồi thu hẹp `_ocr_lock` theo stage.
2. Batch recognizer theo ảnh/tile và thử 1 detector + 1 recognizer trước.
3. Điều chỉnh `MAX_CONCURRENT` theo GPU/CPU benchmark, không cố định bằng trực giác.
4. IndexedDB L2 cache.

**Mục tiêu:** giảm p95 OCR/page và tăng cache hit rate, không làm tăng lỗi/VRAM crash.

### Phase 3 — Scale cho chapter dài

1. Ngưỡng chunk dịch theo token/ký tự/block.
2. Progressive translation theo batch đọc gần nhau, có style/glossary context.
3. Tiling + detector/recognizer streaming cho ảnh vượt ngưỡng chiều cao đã đo.
4. Reading order theo mode và region classification/fallback confidence.

**Mục tiêu:** xử lý webtoon dài mà không tăng time-to-first-result tuyến tính theo số ảnh.

### Phase 4 — Đánh giá kiến trúc local browser/hybrid

Prototype ONNX Runtime Web + WebGPU chỉ cho một stage/model đã benchmark. Đưa vào production khi nó đạt recall gần bằng backend và p95 tốt hơn trên phần lớn máy mục tiêu; nếu không, giữ backend local là đường chính.

---

## 6. Kiến trúc mục tiêu đề xuất

```text
Popup
  └─ requestId + scope + language snapshot
       ▼
Content scheduler
  ├─ discovery + candidate filter
  ├─ priority P0/P1/P2 theo viewport
  ├─ max outstanding jobs
  └─ cancel request cũ
       ▼
Service worker
  ├─ queue + AbortController
  ├─ L1 Map / L2 IndexedDB
  ├─ ocrInFlight single-flight
  └─ cross-origin fetch
       ▼
OCR server/local inference
  ├─ decode/crop/prep ngoài lock
  ├─ detector lock riêng
  ├─ region events hoặc batch regions
  ├─ recognizer batch + lock theo engine
  └─ blockId + bbox gốc + confidence + timings
       ▼
Translation aggregator
  ├─ reading order
  ├─ {id, text} protocol + validation
  ├─ one call cho scope nhỏ / chunk có context cho scope lớn
  └─ translation cache versioned
       ▼
Shadow-DOM overlay
  ├─ render incremental
  ├─ source/request validity checks
  ├─ ResizeObserver + visibility/prune
  └─ font fitting theo batch
```

### Các invariants cần giữ

- Bbox trả về luôn trong hệ tọa độ ảnh gốc, dù OCR crop/tile/upscale ở đâu.
- Detector text-region là đầu vào chính, không giới hạn vào bubble.
- Kết quả về muộn không được render nếu request/source/language không còn hiện hành.
- OCR failure của một ảnh/block không làm hỏng các ảnh/block khác.
- Mọi cache record có version để model hoặc prompt mới không bị che bởi dữ liệu cũ.

---

## 7. Metric và profiling cần bổ sung

### 7.1 Trace theo request và job

Mỗi lần bấm tạo `requestId`; mỗi ảnh/tile tạo `jobId`; mỗi block có `blockId`. Ghi timing monotonic cho:

```text
candidate selection
queue wait
cache lookup (L1/L2)
fetch/download
upload
server decode
crop/preprocess
detector inference
recognizer init (cold-start)
recognizer inference/batch size
serialization/response
translation queue wait
Gemini request/first byte/total
overlay render/fitText/reposition
end-to-end
```

### 7.2 KPI chính

| Nhóm | Metric |
|---|---|
| Trải nghiệm | time-to-first-OCR-block, time-to-first-translation, time-to-viewport-complete, total-scope time (p50/p95) |
| OCR | detector recall/precision trên bộ benchmark, recognizer CER/WER theo ngôn ngữ, số block bỏ sót, false-positive SFX/noise |
| Hiệu năng | queue wait, detector/recognizer ms, crop per batch, ảnh/giây, block/giây, GPU VRAM/CPU/RAM |
| Cache | L1 hit, L2 hit, in-flight dedupe hit, miss reason, cache size/eviction |
| Dịch | request size/tokens, tỉ lệ JSON/ID validation fail, retry rate, 429 rate, latency, chi phí ước tính/block |
| Độ bền | cancel rate, stale-result drop rate, source-changed drop rate, timeout/error rate theo site |
| UI | layout/reposition ms, số bubble, long task/jank khi scroll |

### 7.3 Cách dùng số liệu

- So sánh trước/sau bằng cùng bộ ảnh và cùng máy/GPU.
- Theo dõi p95 chứ không chỉ trung bình; reader thực tế thường có ảnh lớn bất thường.
- Đừng tăng concurrency nếu queue wait giảm nhưng p95 inference, VRAM lỗi hoặc OCR error tăng.
- Giữ benchmark accuracy riêng cho dialogue, narration và SFX để không “tối ưu” bằng cách âm thầm bỏ vùng khó.

---

## 8. Các câu hỏi còn bỏ ngỏ

1. `_ocr_lock` đang bảo vệ thành phần nào cụ thể: detector, Manga OCR, PaddleOCR, CUDA context hay dữ liệu dùng chung? Các engine có thực sự không thread-safe không?
2. Thời gian thực tế hiện phân bổ thế nào giữa download, detector, recognizer, chờ queue, Gemini và render overlay?
3. Dữ liệu người dùng chủ yếu là manga page thường hay webtoon ảnh rất cao? Kích thước ảnh p50/p95 và số block p50/p95 là bao nhiêu?
4. `MAX_CONCURRENT=2` được chọn từ benchmark VRAM/throughput hay chỉ là giới hạn an toàn? Tối ưu cho CPU-only và CUDA có cần profile khác nhau không?
5. Recognizer hiện có hỗ trợ `read_batch()` hay API tương đương không? Nếu không, batch ở mức engine có thực tế/đáng conversion không?
6. Người dùng thường bấm `loaded` hay `visible`? Có cần progressive render trong scope loaded trước khi toàn scope hoàn tất không?
7. Cần hỗ trợ những ngôn ngữ nguồn/đích nào ngoài `ja` và `es`? Có thể để người dùng chọn source language theo chapter để tránh classifier tự động không?
8. Có site nào dùng `object-fit`, CSS transform, canvas, tile ảnh, anti-hotlink hoặc virtualized DOM làm crop/position/fetch hiện tại sai không?
9. OCR cache có chứa nội dung nhạy cảm không? Chính sách lưu local, TTL, giới hạn dung lượng và chế độ private cần như thế nào?
10. Số block/tổng ký tự nào bắt đầu làm một Gemini call chậm hoặc lỗi? Giới hạn model/API hiện tại là gì?
11. Cần consistency dịch ở mức cả chapter hay chỉ page/viewport? Điều này quyết định chiến lược chunk + glossary.
12. Overlay mong muốn là thay thế text, subtitle, tooltip hay selectable/copyable text? Bản dịch dài hơn bbox được phép tràn/mở rộng đến đâu?
13. Có yêu cầu offline/privacy-first không? Nếu có, mức chấp nhận model download, RAM và WebGPU compatibility là bao nhiêu?
14. Có bộ ảnh golden test kèm ground truth vùng text và transcript chưa? Nếu chưa, cần tạo trước khi thay detector/threshold/concurrency.
15. Prewarm có thực sự cải thiện first-use latency bao nhiêu, và có gây tải/chi phí không mong muốn khi người dùng chỉ mở popup không?

---

## Kết luận ngắn

Không cần rewrite toàn bộ. Đường ngắn nhất để tăng tốc mà giữ độ chính xác là: **đo timing → ưu tiên/cancel công việc theo viewport → batch recognizer và thu hẹp lock → persistent cache → chỉ sau đó mới cân nhắc tiling, streaming và ONNX/WebGPU**. Kiến trúc tách OCR local khỏi dịch cloud, bbox theo ảnh gốc và cơ chế chống stale result hiện tại là các phần nên giữ nguyên.
