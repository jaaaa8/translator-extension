# Thiết kế P0: dịch progressive và tái sử dụng pipeline OCR

**Ngày:** 2026-07-30 | **Nhánh:** `feat/v2`

**Trạng thái:** thiết kế và bổ sung session page cache đã được người dùng duyệt theo từng phần ngày 2026-07-30

## 1. Kết quả cuối cùng đối với người dùng

Spec này biến thao tác **Dịch trang đang xem** và **Dịch webtoon đã tải** từ một lượt chờ toàn bộ thành một luồng có kết quả dần:

1. Ảnh và vùng chữ gần viewport được xử lý trước.
2. Những bản dịch đầu tiên xuất hiện ngay khi một nhóm nhỏ vùng chữ hoàn tất, không chờ toàn bộ scope.
3. Đổi ngôn ngữ đích chỉ dịch lại văn bản; không tải, phát hiện vùng chữ, crop hay OCR lại.
4. Đổi ngôn ngữ nguồn hoặc recognizer, ví dụ Manga OCR sang PaddleOCR, giữ lại ảnh, vùng chữ và crop đã chuẩn bị; chỉ chạy nhận dạng và dịch lại.
5. Bấm dịch lại không cho kết quả cũ đè lên kết quả mới, nhưng cũng không xóa các artifact hợp lệ có thể tái sử dụng.
6. Rời viewport không làm mất overlay. Khi ảnh thực sự đổi nguồn, phần hiển thị cũ được tách để không phủ nhầm ảnh, còn dữ liệu vẫn được giữ trong cache.
7. Quay lại nguồn ảnh cũ rồi bấm **Dịch** có thể khôi phục kết quả từ cache còn hiệu lực.
8. Lỗi một vùng, một ảnh hoặc một batch dịch không làm mất kết quả hợp lệ của phần còn lại.
9. Với **Dịch trang đang xem**, lật sang trang kế tiếp không hủy trang cũ: job cũ tiếp tục nền và lưu page artifact trong phiên Chrome.
10. Quay lại một trang đã dịch trong cùng phiên Chrome rồi bấm **Dịch** sẽ dựng lại overlay mà không gọi fetch, detector, OCR hoặc Gemini khi exact page artifact đã hoàn tất.

Người dùng vẫn chủ động bắt đầu bằng nút **Dịch**. P0 không tự dịch ảnh mới khi lật trang hoặc khi trang lazy-load.

## 2. Cơ sở thiết kế

Nguồn sự thật được dùng theo thứ tự:

1. Code và test hiện tại, được truy vết bằng CodeGraph.
2. Kiến trúc và quan hệ liên tài liệu được kiểm tra bằng Graphify.
3. [Workflow thực tế](../../../work-flow.md), mô tả luồng as-is đã kiểm chứng.
4. [Roadmap revised](../../../ocr-manga-extension-roadmap-revised-2026-07-30.md), mô tả hướng tối ưu mục tiêu.
5. Roadmap cũ chỉ dùng làm lịch sử quyết định.

Luồng hiện tại là:

```text
chọn toàn scope
  -> tạo mọi OCR job bằng Promise.all
  -> mỗi ảnh chỉ trả một JSON sau khi OCR xong
  -> chờ OCR xong toàn scope
  -> một call Gemini
  -> thay toàn bộ overlay
```

Các số đo lịch sử ngày 2026-07-29 cho thấy detector chỉ mất khoảng 0,18–0,67 giây, trong khi vòng recognizer mất khoảng 7–13 giây. Vì vậy P0 giữ model và detector hiện tại, nhưng stream kết quả recognizer và dịch theo micro-batch.

## 3. Quyết định phạm vi

P0 là một vertical slice end-to-end gồm:

- identity và cache key đúng;
- cache riêng cho phân tích ảnh, OCR và bản dịch;
- `requestId`, `jobId`, `blockId` ổn định;
- scheduler hữu hạn, ưu tiên viewport;
- endpoint OCR NDJSON bổ sung;
- `chrome.runtime.Port` cho event dài hạn;
- Gemini micro-batch theo ID;
- upsert overlay theo từng block;
- cancellation theo consumer, không xóa artifact dùng chung;
- background-owned job cho scope `visible` và session page cache bằng `chrome.storage.session`;
- rehydrate job `visible` chưa hoàn tất sau service-worker restart trong cùng phiên Chrome;
- metric TTFT, total time và correctness.

P0 không gồm:

- thay detector hoặc recognizer;
- PaddleOCR GPU;
- DeepL draft hoặc Gemini refine pass;
- IndexedDB hoặc cache qua browser restart;
- Shadow DOM, tiling, ONNX/WebGPU hoặc browser-local OCR;
- reading-order heuristic mới;
- WebSocket hay server-side task registry;
- tự khám phá và tự dịch ảnh mới;
- tiếp tục chính in-flight server task sau browser/local-server restart; khi server khỏe lại, background chỉ được phép khởi chạy lại stage còn thiếu từ page artifact.

Các API `/ocr`, `/translate-texts` và `/translate` hiện tại được giữ để tương thích và smoke test.

## 4. “Công việc cũ” nghĩa là gì

Một lần bấm **Dịch** tạo một `requestId`. Request chỉ là **quyền nhận và hiển thị kết quả** của người dùng. Công việc thật được tách thành ba artifact dùng chung:

| Artifact | Nội dung | Có thể dùng lại khi |
|---|---|---|
| Phân tích ảnh | kích thước ảnh, crop viewport, detector regions, dedupe, bbox gốc và crop đã upscale/thêm viền | đổi recognizer, source language hoặc target language |
| OCR | `blockId`, bbox và `srcText` của một recognizer cụ thể | đổi target language hoặc bấm lại cùng cấu hình |
| Bản dịch | `transText` cho đúng block, target, model, prompt và policy version | quay lại cùng ảnh/cấu hình hoặc bấm lại |
| Page artifact | descriptor job, dimensions, block OCR/bản dịch, trạng thái và LRU metadata trong `chrome.storage.session` | lật nhiều manga page rồi quay lại trong cùng phiên Chrome |

“Lượt tải ảnh đang chạy” chỉ là fetch blob ảnh từ URL bởi service worker trước khi upload sang localhost. Nó không phải thao tác lật trang của browser.

Khi có request mới, coordinator phải **đăng ký nhu cầu của request mới trước**, rồi mới gỡ nhu cầu render của request cũ. Nhờ vậy:

- đổi `vi` sang `en` vẫn giữ nguyên fetch, phân tích và OCR đang chạy;
- đổi Manga OCR sang PaddleOCR vẫn giữ fetch và phân tích đang chạy;
- chỉ công việc không còn request nào cần mới được cân nhắc hủy.

Riêng manual job scope `visible`, background gắn một cache-consumer `persistUntilDone` ngay khi nhận job. Lật trang chỉ gỡ render subscriber; cache-consumer vẫn giữ producer chạy tới trạng thái terminal. Scope `loaded` và prewarm không có quyền giữ này và tiếp tục dùng cancellation theo consumer.

Cancel không bao giờ xóa artifact đã hoàn thành. Artifact chỉ mất do LRU eviction, đổi version, cache session bị xóa hoặc process kết thúc.

## 5. Identity và cache key

### 5.1 ID theo vòng đời

- `requestId`: UUID mới cho mỗi thao tác người dùng; không dùng làm cache key.
- `jobId`: duy nhất cho một ảnh/crop trong một request; dùng cho progress và ownership.
- `blockId`: ổn định đối với cùng analysis artifact, dùng để upsert và map OCR ↔ translation.

`blockId` được tạo từ digest của `analysisKey`, bbox nguyên trong hệ tọa độ ảnh gốc và ordinal nếu có hai region trùng bbox. Region trùng không được silently overwrite. Bbox không dùng số thứ tự array làm identity.

P0 giữ thứ tự region hiện tại sau dedupe và thêm tie-break bằng bbox để kết quả ổn định. Tài liệu không gọi thứ tự đó là semantic reading order; heuristic manga RTL/LTR nâng cao nằm ngoài P0.

### 5.2 Key theo artifact

```text
sourceRevision = hash(canonicalSourceUrl + naturalDimensions)

analysisKey = hash(
  sourceRevision
  + canonicalCrop
  + detectorVersion
  + dedupeVersion
  + sharedPrepVersion
)

ocrKey = hash(
  analysisKey
  + srcLang
  + recognizerName
  + recognizerVersion
)

translationKey(block) = hash(
  ocrKey
  + blockId
  + hash(srcText)
  + batchContextHash
  + dstLang
  + translatorModel
  + promptVersion
  + translationPolicyVersion
)

overlayKey = hash(
  sourceRevision
  + canonicalCrop
  + ocrKey
  + dstLang
  + translatorModel
  + promptVersion
  + translationPolicyVersion
)

pageArtifactKey = hash(
  overlayKey
  + pageCacheSchemaVersion
)
```

`batchContextHash` là hash của danh sách `{blockId, srcText}` theo đúng thứ tự batch đã gửi. Nó ngăn một bản dịch phụ thuộc ngữ cảnh của batch A bị dùng như thể đến từ batch B. `overlayKey` trỏ tới artifact hiển thị hoàn chỉnh hoặc một phần của đúng source/cấu hình. `pageArtifactKey` thêm schema version để record session cũ không được đọc bằng schema mới.

`canonicalCrop` tiếp tục dùng quy tắc hiện tại: crop normalized làm tròn sáu chữ số; crop phủ toàn ảnh được canonicalize thành `full`.

Chỉ preprocessing thật sự dùng chung mới nằm trong `sharedPrepVersion`. Nếu một recognizer sau này cần preprocessing riêng, bước đó thuộc OCR stage và phải được đưa vào `ocrKey`; không được làm bẩn analysis artifact dùng chung.

URL nguồn chỉ xuất hiện trong input tạo hash, không ghi nguyên URL có query nhạy cảm vào log. Nếu một site thay nội dung ảnh nhưng giữ nguyên URL và kích thước trong cùng session, cache không thể phát hiện; trường hợp này nằm ngoài P0 vì browser không cung cấp revision signal đáng tin cậy mà không fetch lại.

### 5.3 Single-flight

Mỗi `analysisKey`, `ocrKey`, `translationKey` và `pageArtifactKey` có tối đa một producer đang chạy. Mọi request cần exact key đó trở thành consumer của cùng producer. Khác crop, model hoặc version luôn tạo miss đúng.

## 6. Kiến trúc mục tiêu

```text
Popup
  -> gửi action + scope + language snapshot
  -> đọc progress + số trang nền/cache/lỗi; không sở hữu vòng đời request

Content script
  -> tạo requestId và candidate jobs
  -> ưu tiên viewport, giới hạn outstanding
  -> aggregate OCR blocks thành translation micro-batch
  -> validate event và upsert overlay theo blockId

chrome.runtime.Port
  <-> event/progress/cancel giữa content và service worker

Service worker
  -> coordinator theo stage key + consumer set
  -> priority queue và AbortController
  -> sở hữu manual job visible sau khi content disconnect
  -> job ledger + page artifact trong chrome.storage.session
  -> fetch ảnh cross-origin khi analysis miss
  -> bridge NDJSON từ localhost
  -> giữ RAM cache làm hot layer

Local server
  -> analysis cache: decode/crop/detect/dedupe/prepare
  -> recognizer theo srcLang, yield từng block
  -> partial OCR cache theo ocrKey + blockId
  -> structured Gemini translation theo ID

Content overlay
  -> một bubble node cho mỗi blockId
  -> stale guard trên mọi event
  -> tách phần hiển thị khi source đổi; không xóa artifact
```

Popup đóng không hủy request vì content và service worker sở hữu vòng đời. Khi popup mở lại, nó hỏi trạng thái hiện hành thay vì khởi tạo request mới.

Full document navigation hoặc thay DOM image chỉ tách render subscriber. Manual job `visible` đã được background chấp nhận vẫn chạy nhờ cache-consumer. Khi service worker khởi động lại trong cùng phiên Chrome, nó đọc job ledger, đổi trạng thái `running` cũ thành `queued` và tiếp tục phần chưa có artifact.

## 7. Data flow

### 7.1 Cold path

1. Người dùng bấm một trong hai nút Dịch.
2. Content snapshot `scope`, `srcLang`, `dstLang`, tạo `requestId` và candidate jobs như workflow hiện tại. Với `visible`, background persist descriptor trước khi trả event `page_job_accepted`.
3. `visible` giữ `currentSrc` và viewport crop; `loaded` giữ `bestSource` và full image.
4. Scheduler sort ảnh đang thấy trước, sau đó theo khoảng cách tới viewport. Tối đa bốn job outstanding ở content; background giữ concurrency hiện tại là hai cho tới khi benchmark chứng minh mức khác tốt hơn.
5. Service worker kiểm tra artifact cache từ translation trở ngược về OCR và analysis.
6. Khi analysis miss, service worker fetch blob một lần và gọi endpoint stream với file, `analysisKey` và `srcLang`.
7. Server decode, crop, detect, dedupe và chuẩn bị crop. `analysis_ready` được phát sau khi artifact này đã vào cache.
8. Server nhận dạng tuần tự. Sau mỗi `engine.read()`, nó cache block thành công rồi phát `ocr_block`.
9. Content gom block theo priority. Batch đầu flush khi đủ ba block hoặc 250 ms sau block đầu tiên; các batch sau flush khi đủ tám block, sau 500 ms, hoặc khi job/scope hết block.
10. Service worker gọi endpoint structured translation. Sau khi validate exact ID set, từng translation được ghi vào RAM cache và page artifact session.
11. Nếu render subscriber còn hợp lệ, background phát translation về content; nếu trang đã lật, nó chỉ tiếp tục cập nhật cache.
12. Content chạy stale guards rồi upsert đúng bubble. `scope_done` kết thúc progress, nhưng overlay đầu tiên đã xuất hiện trước đó.

Hai timeout flush là giới hạn tối đa tính từ block pending đầu tiên; timer không trì hoãn batch đã đạt số lượng. Đây là policy P0 và có `translationPolicyVersion` để thay đổi sau benchmark mà không dùng nhầm cache cũ.

### 7.2 Đổi ngôn ngữ đích

Ví dụ `ja → vi` đổi thành `ja → en`:

```text
analysisKey hit
  -> ocrKey hit hoặc join OCR đang chạy
  -> translationKey miss vì dstLang mới
  -> chỉ gọi dịch cho target mới
```

Không fetch ảnh, detect, crop/prep hay gọi recognizer lại khi cache tương ứng còn hiệu lực.

### 7.3 Đổi source language hoặc recognizer

Ví dụ Manga OCR đổi sang PaddleOCR:

```text
analysisKey giữ nguyên
  -> ocrKey mới vì recognizer/srcLang đổi
  -> dùng lại bbox và prepared crops
  -> recognizer mới chạy
  -> dịch kết quả mới
```

Không fetch, decode, detect, dedupe hoặc chuẩn bị crop lại khi analysis cache còn hiệu lực.

### 7.4 Đổi trở lại cấu hình cũ

Nếu OCR và translation artifact cũ chưa bị LRU eviction, content replay các event cache và render lại mà không chạy inference hoặc gọi cloud. Exact page artifact trong `chrome.storage.session` vẫn dùng được sau page navigation và service-worker restart của cùng phiên Chrome.

### 7.5 Lật liên tục nhiều single page

1. Job A được background persist và phát `page_job_accepted`.
2. Người dùng lật sang B; subscriber A disconnect nhưng cache-consumer A còn sống.
3. Job B vào hàng foreground; A chuyển thành background FIFO; prewarm luôn đứng sau cả hai.
4. Mỗi OCR/translation batch hợp lệ của A được flush vào page artifact dù A không còn DOM để render.
5. Quay lại A rồi bấm **Dịch**:
   - `complete`: replay toàn bộ overlay, không có network/inference/cloud call;
   - `partial`: replay block đã có và chỉ tiếp tục phần thiếu;
   - `queued/running`: replay block đã có và gắn subscriber mới vào producer hiện hành.

Cache unit P0 là exact `source + canonicalCrop + configuration`. Viewport crop khác là artifact khác; P0 không hợp nhất nhiều crop của cùng source.

## 8. Cancellation và stale work

Coordinator giữ consumer set cho từng stage producer. Một thao tác mới chỉ bỏ render consumer của request cũ sau khi đã gắn request mới vào các exact-key producer cần tái sử dụng.

Consumer policy theo scope:

| Loại công việc | Khi DOM/popup disconnect | Khi request mới bắt đầu |
|---|---|---|
| manual `visible` khác source | gỡ render subscriber; giữ `persistUntilDone` cache-consumer | job cũ tiếp tục background |
| manual cùng source + exact config | gắn lại subscriber | join producer/page artifact cũ |
| manual cùng source + target mới | không render target cũ | giữ analysis/OCR; bỏ translation batch target cũ chưa gửi |
| manual cùng source + recognizer mới | không render recognizer cũ | giữ analysis; recognizer cũ dừng sau block hiện tại nếu không còn consumer khác |
| `loaded` webtoon | không có cache-consumer giữ toàn scope | supersede/cancel stale work như thiết kế gốc |
| prewarm | không có cache-consumer | hủy đầu tiên khi cần tài nguyên |

Một thao tác mới vẫn supersede render request hiện hành của cùng DOM image ngay cả khi không tìm được candidate mới. Nó không gỡ producer manual `visible` của source khác đã được chấp nhận, consumer thuộc tab khác, hoặc exact-key producer hợp lệ.

| Trạng thái công việc | Không còn consumer | Request mới vẫn cần exact key |
|---|---|---|
| queued | xóa khỏi queue nếu không có `persistUntilDone` | giữ nguyên vị trí hoặc tăng priority |
| fetch blob | `AbortController.abort()` | tiếp tục cùng fetch, không tải lần hai |
| upload/NDJSON request | abort network nếu không còn giá trị | giữ stream và chuyển/replay event cho request mới |
| analysis đang detect/prep | để stage nguyên tử hiện tại hoàn tất và cache, không chạy OCR tiếp | tiếp tục và dùng chung artifact |
| `engine.read()` đang chạy | cho block hiện tại hoàn tất/cache; không bắt đầu block kế tiếp | tiếp tục cùng producer |
| Gemini request đã gửi | không hứa hủy call cloud; cache response hợp lệ nhưng không render stale | giữ/replay nếu exact translation key |
| artifact đã hoàn thành | không xóa | trả cache hit |

Background abort stream làm FastAPI thấy client disconnect. Generator kiểm disconnect/cancel giữa hai block, không cố ngắt một `engine.read()` đang chạy. Không thêm WebSocket hoặc task registry trong P0.

Mỗi event tới content phải qua bốn guard:

1. `requestId` vẫn là request hiện hành của DOM image.
2. DOM image còn kết nối khi chuẩn bị render.
3. `currentSrc`/source identity vẫn khớp job.
4. Snapshot `srcLang` và `dstLang` vẫn khớp request.

Event stale có thể hoàn thiện cache đúng key nhưng không được phép chạm DOM.

## 9. Giao thức

### 9.1 OCR stream bổ sung

Thêm `POST /ocr-stream`; giữ `POST /ocr` hiện tại. Request nhận một trong hai dạng:

- file + `analysis_key` + `src_lang` cho cold path;
- `analysis_key` + `src_lang` không có file khi background biết analysis cache đang sống.

Nếu background tham chiếu analysis đã bị server evict/restart, server trả lỗi `analysis_missing`; background fetch file và retry cold path đúng một lần.

NDJSON tối thiểu:

```json
{"type":"analysis_ready","analysis_key":"a1","image_w":1200,"image_h":1800,"regions":12}
{"type":"ocr_block","ocr_key":"o1","block_id":"b1","bbox":[420,180,260,140],"src_text":"..."}
{"type":"ocr_block_error","ocr_key":"o1","block_id":"b2","code":"recognizer_failed"}
{"type":"image_done","ocr_key":"o1","recognized":11,"failed":1}
{"type":"job_error","stage":"decode","code":"invalid_image"}
```

Server stream dùng stage key; service worker bọc event gửi qua Port bằng `requestId` và `jobId` của từng consumer. Điều này cho phép một producer phục vụ request mới mà không buộc server chạy lại.

### 9.2 Structured translation bổ sung

Thêm `POST /translate-items`:

```json
{
  "src_lang":"ja",
  "dst_lang":"vi",
  "items":[
    {"id":"b1","text":"..."},
    {"id":"b2","text":"..."}
  ]
}
```

```json
{
  "items":[
    {"id":"b1","translation":"..."},
    {"id":"b2","translation":"..."}
  ]
}
```

Server và client đều validate: không thiếu ID, không có ID lạ, không duplicate và mỗi ID xuất hiện đúng một lần. Sai contract làm hỏng batch đó, không làm mất OCR hoặc các batch dịch đã xác nhận.

### 9.3 Port events

Các event hiển thị tối thiểu:

```json
{"type":"progress","request_id":"r1","stage":"ocr","done":4,"total":12}
{"type":"page_job_accepted","request_id":"r1","page_artifact_key":"p1","state":"queued"}
{"type":"translation","request_id":"r1","job_id":"j1","block_id":"b1","trans_text":"..."}
{"type":"block_error","request_id":"r1","job_id":"j1","block_id":"b2","stage":"ocr"}
{"type":"page_status","background":2,"cached":8,"failed":1}
{"type":"scope_done","request_id":"r1","images":3,"translated":30,"failed":1}
```

Event được xử lý idempotent. Nhận lại cùng translation cho cùng `blockId` chỉ cập nhật cùng node, không tạo bubble trùng.

## 10. Cache và vòng đời

P0 có ba lớp cache, mỗi lớp giữ đúng dữ liệu cần thiết:

- `chrome.storage.session`: job ledger và page artifact cho manual scope `visible`;
- service-worker RAM: hot metadata/OCR/translation maps và in-flight single-flight;
- local-server RAM: analysis/prepared crops và partial OCR cache.

Giới hạn:

- session page cache có soft budget 8 MiB dưới quota 10 MiB của Chrome;
- server analysis cache tối đa 32 artifact và 128 MiB prepared crops, chạm giới hạn nào trước thì evict LRU;
- server partial OCR cache tối đa 256 `ocrKey` records;
- service-worker hot OCR cache tối đa 256 image records;
- service-worker hot translation cache tối đa 2.048 block records.

Một page record tối thiểu:

```json
{
  "schema_version":"page-v1",
  "page_artifact_key":"p1",
  "source_url":"https://...",
  "crop":"full",
  "src_lang":"ja",
  "dst_lang":"vi",
  "versions":{"detector":"...","recognizer":"...","translator":"...","prompt":"...","policy":"..."},
  "state":"queued|running|partial|complete|failed",
  "image_w":1200,
  "image_h":1800,
  "blocks":[{"block_id":"b1","bbox":[1,2,3,4],"src_text":"...","trans_text":"...","state":"complete"}],
  "created_at":0,
  "updated_at":0,
  "last_accessed_at":0,
  "last_error":null
}
```

Background giữ quyền truy cập mặc định của `storage.session`; không expose cache cho content script. Canonical source URL phải được lưu để rehydrate/fetch lại nhưng không được ghi nguyên query nhạy cảm vào log.

Write policy:

1. Persist job descriptor trước khi phát `page_job_accepted`.
2. Flush block OCR/bản dịch sau mỗi validated batch và khi state đổi.
3. Cache write không chặn render hiện hành; lỗi write đi qua policy quota bên dưới.
4. Không lưu full image bytes hoặc prepared crop trong Chrome storage.

Eviction policy khi vượt soft budget:

1. xóa record sai schema/version;
2. xóa page `complete` ít được dùng nhất;
3. xóa terminal `partial/failed` ít được dùng nhất;
4. không xóa `queued/running`;
5. nếu vẫn không đủ chỗ, từ chối nhận job mới với lỗi rõ ràng.

Khi service worker khởi động lại trong cùng phiên Chrome, mọi record `running` được chuyển về `queued`, block đã persist được replay và chỉ stage thiếu được chạy lại. Nếu local server đã restart, server cache miss có thể buộc fetch/detect/prep lại; correctness không thay đổi.

Version đổi luôn tạo key mới. Cancel, rời viewport, đổi ngôn ngữ hoặc đổi nguồn DOM không xóa page artifact. Browser restart, disable/reload/update extension làm `storage.session` mất đúng thiết kế. P0 chưa thêm nút clear cache hoặc trang quản lý cache.

## 11. Chính sách overlay và lật trang

Ba trạng thái phải được phân biệt:

1. **Ảnh chỉ rời viewport:** không gỡ overlay, không cancel và không xóa cache. Overlay cuộn cùng ảnh; khi quay lại vẫn còn.
2. **DOM image đổi `src`/`currentSrc`:** tách hoặc ẩn overlay cũ ngay để không phủ chữ trang trước lên ảnh mới; giữ artifact trong cache. Manual job `visible` đã được chấp nhận tiếp tục nền; không tự dịch source mới.
3. **DOM image bị xóa:** xóa node overlay để tránh leak, nhưng vẫn giữ artifact theo LRU.

Khi người dùng bấm **Dịch** trên source hiện tại:

- exact `pageArtifactKey`/`overlayKey` hit: gắn/replay overlay từ session hoặc hot cache;
- translation hit nhưng overlay node không còn: dựng lại node từ artifact;
- cache thiếu stage nào: chỉ chạy từ stage thiếu đó.

Quay về source cũ không tự làm overlay xuất hiện. Người dùng bấm **Dịch** để khôi phục, đúng với workflow thủ công đã duyệt.

`enabled=false` chỉ ẩn overlay; không ngầm hủy producer đang được request khác hoặc cache cần.

## 12. Error handling

| Lỗi | Hành vi mục tiêu |
|---|---|
| server offline | giữ job `queued`, không retry vòng lặp; chạy lại khi health thành công hoặc người dùng bấm Dịch |
| fetch ảnh lỗi/URL hết hạn | page `failed` hoặc `partial`; quay lại source hiện hành rồi bấm Dịch để retry |
| decode/validation/detector lỗi | kết thúc ảnh đó vì chưa có analysis artifact; ảnh khác tiếp tục |
| một recognizer block lỗi | phát `ocr_block_error`, tiếp tục block khác; chỉ block lỗi retry |
| một ảnh lỗi | scope và ảnh khác tiếp tục |
| một translation batch lỗi | giữ OCR và các batch đã dịch; chỉ batch lỗi retry |
| response Gemini sai ID | reject toàn batch response; không gắn theo array index |
| result về muộn | cache đúng key nếu hợp lệ; stale guards chặn render |
| popup đóng | request tiếp tục; mở lại đọc progress hiện tại |
| content Port disconnect vì lật single page | gỡ render subscriber; `visible` job tiếp tục nhờ cache-consumer |
| service worker restart trong cùng Chrome session | rehydrate `queued/running`, replay persisted blocks và tiếp tục stage thiếu |
| Gemini đang bay khi worker chết | có thể gọi lại một lần sau resume; ID/stale guards vẫn ngăn render trùng/sai |
| `storage.session` quota/write lỗi | evict theo policy rồi retry một lần; nếu vẫn lỗi, render hiện tại, giữ state xử lý và đặt `last_error=cache_failed` |
| server cache eviction/restart | tính lại từ stage bị miss; page artifact hợp lệ vẫn được replay |
| browser restart | session page cache và job ledger bị xóa |

Không có lỗi cục bộ nào được phép xóa artifact hợp lệ của block/ảnh khác.

Khi retry cùng `ocrKey`, server replay block đã thành công từ partial cache và chỉ gọi recognizer cho block còn thiếu hoặc từng lỗi; detector/prep không chạy lại nếu `analysisKey` còn sống.

## 13. Progress và trạng thái người dùng

Popup chỉ cần trạng thái ngắn:

- `Đang chuẩn bị ảnh x/y`;
- `Đang nhận dạng vùng a/b`;
- `Đang dịch vùng c/b`;
- `Đang dịch nền: n trang`;
- `Đã cache: n trang`;
- `Lỗi: n trang`;
- exact hit: `Khôi phục từ cache`;
- `Hoàn tất: n vùng, m lỗi`;
- lỗi có hành động **Thử lại** bằng chính nút Dịch.

Không thêm dashboard, lịch sử job hay nút pause trong P0.

## 14. Tiêu chí nghiệm thu

Các con số sau là pass/fail target, không phải khẳng định code hiện tại đã đạt:

### 14.1 Trải nghiệm và hiệu năng

- Scope `visible`: time-to-first-translation p50 ≤ 5 giây, p95 ≤ 8 giây trên máy baseline.
- Scope `loaded`: block gần viewport xuất hiện trước khi toàn scope hoàn tất; TTFT không tăng tuyến tính theo số ảnh loaded.
- Total-scope time không chậm hơn baseline quá 10% khi recognizer không đổi.
- Detector/block recall bằng baseline; không tăng tốc bằng cách bỏ narration, SFX hoặc text ngoài bubble.

### 14.2 Reuse

- Đổi target language tạo **0** fetch, detect, prep và recognizer call mới cho exact cache key.
- Đổi source language/recognizer tạo **0** fetch, decode, detect, dedupe và prep mới; chỉ recognizer + translation chạy lại.
- Đổi trở lại cấu hình cũ tạo **0** inference/cloud call nếu artifact chưa bị evict.
- Hai request cùng exact key dùng một producer, không tạo duplicate fetch/inference.

### 14.3 Race và cancellation

- Request mới không nhận translation của request cũ.
- Tất cả queued work không còn consumer bị loại, trừ manual `visible` còn `persistUntilDone` cache-consumer.
- Fetch không còn consumer bị abort.
- `engine.read()` stale hiện tại được phép hoàn tất một block nhưng không bắt đầu block kế tiếp.
- Cloud call đã gửi có thể hoàn tất/cache nhưng không render stale.
- Không có translation gắn sai, thiếu hoặc trùng `blockId`.

### 14.4 Overlay

- Rời viewport rồi quay lại không mất overlay.
- Source đổi không hiển thị chữ nguồn cũ trên ảnh mới.
- Artifact nguồn cũ vẫn còn và được khôi phục khi quay lại rồi bấm Dịch, nếu cache chưa evict.
- DOM image bị xóa không để lại overlay node mồ côi.

### 14.5 Session page cache

- Bấm Dịch A rồi lật sang B trước khi A xong: A đạt terminal state và không có block A render trên B.
- Quay lại exact A rồi bấm Dịch tạo **0 fetch, 0 detector, 0 recognizer và 0 Gemini call** khi page artifact `complete` còn sống.
- Page `partial` replay ngay block đã có và chỉ retry phần thiếu.
- Service-worker restart rehydrate job trong cùng Chrome session mà không tạo duplicate block/overlay.
- Foreground page chạy trước detached background page; background page chạy trước prewarm.
- Vượt 8 MiB chỉ evict terminal LRU; không evict `queued/running`.
- Không đủ chỗ cho job mới trả lỗi rõ; không âm thầm nhận rồi bỏ.
- Browser restart xóa session cache đúng thiết kế.
- Policy này không thay đổi cancellation của scope `loaded`.

## 15. Chiến lược kiểm thử

### 15.1 Extension unit tests

- key separation và version invalidation;
- exact-key cache hit/single-flight ở ba stage;
- atomic replace: đăng ký request mới trước khi release request cũ;
- priority queue, bounded outstanding và prewarm priority thấp;
- cancel matrix cho queued/fetch/shared producer;
- scope policy: `visible` giữ cache-consumer, `loaded` và prewarm không giữ;
- session page record schema, state transition và exact-key lookup;
- session write/rehydrate qua service-worker restart giả lập;
- 8 MiB LRU eviction không xóa `queued/running` và từ chối rõ khi hết chỗ;
- NDJSON parser với một dòng bị chia qua nhiều network chunk;
- Port event reorder/duplicate/stale;
- upsert một node theo `blockId`;
- offscreen giữ overlay, source change detach display nhưng giữ artifact;
- đổi `vi → en`, đổi recognizer và đổi trở lại.

### 15.2 Server tests

- analysis cache reuse không gọi detector/prep lần hai;
- recognizer khác dùng cùng prepared crops;
- partial OCR cache và cancel check giữa block;
- một recognizer exception không kết thúc block khác;
- `/ocr-stream` phát NDJSON hợp lệ và giữ bbox ảnh gốc;
- `/translate-items` reject missing/foreign/duplicate ID;
- retry chỉ batch dịch lỗi;
- `/ocr`, `/translate-texts` và `/translate` cũ vẫn pass.

### 15.3 Integration/browser fixture

- bản dịch đầu xuất hiện trước `scope_done`;
- ảnh gần viewport hoàn tất trước ảnh xa;
- bấm dịch hai lần khi fetch/OCR/Gemini đang chạy;
- đóng/mở popup giữa request;
- bấm Dịch A, lật sang B trước khi A hoàn tất, quay lại A và bấm Dịch;
- giả lập content Port disconnect và service-worker restart giữa job `visible`;
- spy xác nhận exact page hit không gọi fetch/OCR/Gemini;
- một block, một ảnh và một batch dịch lần lượt bị inject lỗi;
- chạy cả `visible` crop và `loaded` full image.

### 15.4 Benchmark

Dùng cùng fixture, máy, model, prompt và điều kiện cold/warm. Ghi bằng monotonic clock:

- queue wait;
- fetch/upload;
- analysis/detector;
- từng recognizer block;
- first/total translation;
- first overlay, viewport complete và scope complete;
- cache hit/miss reason, stale work và cancel latency.

Benchmark lịch sử trong roadmap chỉ là baseline tham khảo; acceptance phải chạy lại bằng harness của implementation.

## 16. Rủi ro và giới hạn đã chấp nhận

| Rủi ro | Kiểm soát P0 |
|---|---|
| Micro-batch tăng Gemini calls/429 | batch 3 rồi 8, timer hữu hạn, đo calls và 429; không thêm translator thứ hai |
| Micro-batch giảm consistency | giữ thứ tự ổn định và cùng prompt; không hứa chapter-level consistency trong P0 |
| Server cache prepared crops tốn RAM | LRU theo cả count và byte size; không giữ full image bytes |
| Streaming event reorder/duplicate | stable IDs, exact-set validation và idempotent upsert |
| Cancel nhầm shared work | consumer set và atomic replacement |
| Session page cache đạt quota | soft cap 8 MiB, terminal LRU, không evict active job, từ chối rõ nếu vẫn đầy |
| Nhiều trang được bấm nhanh tạo backlog | concurrency giữ ở 2, foreground > background FIFO > prewarm; descriptors nằm trong budget session |
| Service worker restart giữa job | job ledger rehydrate, persisted block replay, stage thiếu chạy lại |
| Worker chết khi Gemini đang bay | chấp nhận khả năng một call bị lặp; ID/upsert bảo vệ correctness, chưa thêm distributed transaction |
| URL ảnh hết hạn trước khi background fetch/retry | giữ trạng thái failed/partial; quay lại dùng source hiện hành để retry |
| Browser/server restart | browser restart xóa session theo chủ ý; server restart chỉ làm miss heavy stage cache |
| Cùng URL/cùng kích thước nhưng nội dung đổi | source guard hiện tại không phát hiện; thêm content fingerprint chỉ khi có fixture thực tế |

## 17. Điều kiện hoàn thành P0

P0 chỉ hoàn thành khi:

1. Toàn bộ test cũ và test mới pass.
2. Hai scope render progressive qua cùng event path.
3. Reuse và cancellation đạt các assertion ở mục 14, không chỉ được quan sát bằng mắt.
4. Không có stale overlay trong race test đổi source/ngôn ngữ.
5. Accuracy/block count không hồi quy trên fixture baseline.
6. TTFT và total-time đạt gate đã định hoặc có số đo chứng minh rõ nguyên nhân không thuộc transport P0 để quay lại thiết kế.
7. Manual `visible` job tiếp tục/cache sau navigation và exact page hit đạt assertion zero-call ở mục 14.5.
8. Scope `loaded` giữ nguyên cancellation; không bị session page-cache policy giữ job ngoài ý muốn.

Sau khi spec này được người dùng review, bước kế tiếp mới là viết implementation plan theo Superpowers. Spec này không tự cho phép bắt đầu sửa code.
