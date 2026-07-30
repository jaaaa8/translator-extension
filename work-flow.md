# MangaTranslator — workflow thực tế và đối chiếu roadmap

**Ngày kiểm chứng:** 2026-07-30

**Trạng thái:** mô tả **as-is** của code hiện tại; không mô tả kiến trúc mục tiêu như tính năng đã triển khai.

## 1. Nguồn sự thật và kết luận

Thứ tự ưu tiên khi có mâu thuẫn:

1. Code và test hiện tại.
2. Kết quả đo đã ghi nhận ngày 2026-07-29.
3. `ocr-manga-extension-roadmap-revised-2026-07-30.md` cho kiến trúc mục tiêu.
4. `ocr-manga-extension-roadmap.md` cho lịch sử quyết định.

Workflow đang chạy vẫn là **request/response theo toàn scope**:

```text
Popup
  -> content script chọn tất cả ảnh phù hợp
  -> Promise.all tạo toàn bộ OCR job
  -> background xếp hàng tối đa 2 job
  -> server trả JSON sau khi OCR xong cả ảnh
  -> content chờ OCR xong toàn scope
  -> một call Gemini cho toàn bộ text
  -> render lại overlay theo từng ảnh
```

Code hiện **chưa có** `requestId`, `jobId`, `blockId`, scheduler ưu tiên viewport, cancellation, NDJSON, `chrome.runtime.Port`, translation micro-batch hay upsert từng block. Roadmap revised nhận định đúng khoảng cách này.

## 2. Khởi động và vòng đời model

1. `run_server.bat` kích hoạt `venv` và chạy Uvicorn tại `127.0.0.1:8910`.
2. FastAPI lifespan gọi `get_pipeline()` một lần khi server khởi động.
3. `Pipeline` khởi tạo Comic Text Detector, OCR registry và Gemini clients.
4. Detector được nạp khi tạo pipeline; recognizer `ja`/`es` chỉ được tạo ở lần `OcrRegistry.get(lang)` đầu tiên.
5. Vì recognizer lazy-load, prewarm hiện tại có thể trả chi phí cold-start trước thao tác dịch, chứ lifespan không thực sự nạp sẵn mọi recognizer.

Nguồn: `run_server.bat`, `server/main.py:15-30`, `server/pipeline.py:43-63`, `server/ocr.py:41-53`.

## 3. Mở popup và prewarm

```text
Mở popup
  -> đọc enabled/srcLang/dstLang từ chrome.storage.local
  -> gửi health tới background
  -> background GET /health
  -> khi settings và health đều sẵn sàng, server healthy
     -> popup gửi prewarmPage(srcLang) tới tab hiện tại
     -> content chọn đúng 1 ảnh có diện tích giao viewport lớn nhất
     -> gửi ocrImage(prewarm=true)
     -> OCR/cache như request thường
     -> không dịch, không render, không đánh dấu ảnh đã dịch
```

Đổi source language khi popup còn mở sẽ prewarm lại ngôn ngữ mới nếu server healthy. Lỗi prewarm chỉ log warning; nếu một thao tác tay cùng tham gia single-flight bị lỗi thì thao tác tay vẫn bật badge.

Nguồn: `extension/popup.js:8-45`, `extension/content.js:31-70`, `extension/background.js:69-86`; test: `popup.test.js`, `content.test.js`, `background.test.js`.

## 4. Workflow một thao tác dịch

### 4.1 Popup phát lệnh

- `Dịch webtoon đã tải` gửi `{type: "translatePage", scope: "loaded"}`.
- `Dịch trang đang xem` gửi `{type: "translatePage", scope: "visible"}`.
- Hai nút bị disable trong vòng đời của popup hiện tại cho tới callback cuối.
- Popup chỉ nhận kết quả cuối `{ok, images, blocks}`; chưa nhận progress.

Nguồn: `extension/popup.js:47-70`.

### 4.2 Content script snapshot và chọn ảnh

`translatePage(scope)` snapshot `srcLang` và `dstLang`, lấy mọi `<img>`, rồi gọi `selectCandidates()`.

Điều kiện chung:

- ảnh đã load hoàn chỉnh;
- `naturalWidth >= 400` và `naturalHeight >= 400`;
- có source hợp lệ;
- key hiện tại chưa được đánh dấu hoàn tất cho chính DOM image đó.

Khác biệt theo scope:

| Scope | Source OCR | Phần OCR | Điều kiện visibility |
|---|---|---|---|
| `loaded` | candidate descriptor lớn nhất trong source-set đang được `<picture>` chọn; nếu không có thì `img.src` | toàn ảnh | không yêu cầu đang thấy |
| `visible` | `img.currentSrc || img.src` | giao viewport, đệm 10%, chuẩn hóa `[0,1]`, làm tròn 6 chữ số | diện tích giao viewport phải lớn hơn 0 |

Key “đã dịch” hiện là:

```text
source | srcLang | normalizedCrop-or-full
```

Key này thiếu `dstLang` và version model/prompt. Vì vậy đổi `vi` sang `en` có thể bỏ qua sai ảnh đã dịch trước đó.

Nguồn: `extension/content.js:73-95`, `extension/srcset.js:4-98`; test: `srcset.test.js`, `content.test.js`.

### 4.3 Đánh dấu request mới nhưng chưa hủy việc cũ

Content tạo một object token mới và ghi vào `manualRequests` cho mọi ảnh thuộc scope. Token này chỉ ngăn kết quả cũ render; nó không:

- xóa job khỏi background queue;
- abort fetch/upload;
- ngắt request server;
- ngắt `engine.read()`.

Ngay cả thao tác mới không tạo job nào cũng supersede thao tác cũ trên ảnh liên quan. Test hiện có khóa regression này.

Nguồn: `extension/content.js:91-95,113-139`; test: `content.test.js`.

### 4.4 Tạo OCR job và điều tiết phía background

Content gọi:

```js
await Promise.all(jobs.map((job) => requestOcr(job, requestSrcLang)))
```

Do đó mọi Promise/message được tạo ngay. Background mới là nơi điều tiết:

- queue FIFO trong RAM;
- tối đa `MAX_CONCURRENT = 2` job;
- không priority, không request ownership, không cancel;
- cache hoàn tất `Map` và single-flight `Map` dùng cùng OCR key;
- cache mất khi MV3 service worker ngủ.

Nguồn: `extension/content.js:97-99`, `extension/background.js:1-48`; test: `background.test.js` xác nhận giới hạn 2, cache và single-flight.

### 4.5 Background tải ảnh và gọi `/ocr`

Với cache miss:

1. Service worker fetch lại URL ảnh bằng quyền cross-origin.
2. Đóng gói blob, `src_lang` và bốn crop field nếu có vào `FormData`.
3. POST `/ocr` với timeout 60 giây.
4. Chỉ response thành công được cache.
5. Lỗi thao tác tay bật badge `!`; lỗi chỉ thuộc prewarm thì im lặng.

Hiện chưa có fallback cho canvas, CSS background, iframe không được inject hoặc site chặn hotlink.

Nguồn: `extension/manifest.json:5-15`, `extension/background.js:50-87,106-121`.

### 4.6 Server xử lý một ảnh

`POST /ocr` kiểm source language và quy tắc crop “đủ bốn field hoặc không field nào”, rồi gọi `Pipeline.ocr_image()`.

Toàn bộ pipeline dưới đây nằm trong một `_ocr_lock` dùng chung:

```text
decode bytes bằng OpenCV
  -> lưu image_w/image_h gốc
  -> crop normalized bằng floor(start)/ceil(end), lưu offset
  -> Comic Text Detector trên ảnh/crop làm việc
  -> dedupe IoU > 0.5, giữ box diện tích lớn hơn
  -> clamp box vào biên ảnh
  -> RGB crop
  -> nếu cao < 48 px thì upscale; luôn thêm viền trắng 8 px
  -> lazy-load recognizer theo srcLang
  -> engine.read() tuần tự từng region
  -> bỏ text rỗng
  -> cộng offset để bbox trở lại tọa độ ảnh gốc
  -> trả một JSON hoàn chỉnh {image_w, image_h, blocks[]}
```

`ja` dùng Manga OCR; `es` dùng PaddleOCR CPU với các model định hướng phụ và MKLDNN tắt. Exception của một `engine.read()` hiện làm hỏng **cả ảnh**; chưa có error event riêng từng block.

Một chi tiết quan trọng: `_dedupe_regions()` sort region theo **diện tích giảm dần**. Vì vậy thứ tự `blocks` hiện không được chứng minh là reading order, dù prompt Gemini mô tả chúng là các dòng “in reading order”.

Nguồn: `server/main.py:39-59`, `server/pipeline.py:25-115`, `server/ocr.py:5-53`; test: `test_pipeline.py`, `test_ocr.py`, `test_detector.py`.

### 4.7 Gom OCR và gọi dịch

Content chờ toàn bộ `Promise.all` kết thúc, sau đó:

- bỏ qua ảnh OCR lỗi nhưng không đánh dấu hoàn tất để lần sau thử lại;
- flatten mọi `src_text` thành một array;
- lưu index để map array dịch về từng block;
- nếu toàn bộ OCR thành công nhưng không có text, gỡ overlay cũ và đánh dấu ảnh hoàn tất;
- nếu có text, gửi đúng một message `translateTexts` cho toàn scope.

Background POST `/translate-texts` với timeout 300 giây. Server gọi Gemini một lần với các dòng đánh số và yêu cầu JSON array cùng độ dài/cùng thứ tự.

Retry thực tế:

- output JSON lỗi hoặc sai length: thử lại cùng client, tổng tối đa 2 call;
- HTTP 429 và có key phụ: dùng call thứ hai cho client kia; thành công thì promote client đó;
- HTTP 429 với một key: dừng ngay;
- extension không retry thêm.

Identity hiện chỉ là vị trí array. Không có ID, kiểm duplicate, kiểm ID lạ hay bảo vệ reorder ngoài length.

Nguồn: `extension/content.js:100-128`, `extension/background.js:89-103`, `server/main.py:62-74`, `server/translator.py:23-66`; test: `test_translator.py`, `test_translate_endpoint.py`.

### 4.8 Render và lifecycle overlay

Sau translation response, mỗi ảnh lại qua hai guard:

1. token trong `manualRequests` vẫn là request mới nhất;
2. DOM image còn kết nối và source theo scope chưa đổi.

Ảnh hợp lệ được gắn `trans_text` theo index rồi **thay toàn bộ overlay của ảnh**:

- một `div.mt-overlay` absolute dưới `document.body`;
- một `div.mt-bubble` cho mỗi block;
- bbox scale bằng `rect.width/image_w` và `rect.height/image_h`;
- font giảm tuyến tính từ 18 px tới 10 px;
- `ResizeObserver` reposition;
- overlay scope `visible` có `IntersectionObserver` và bị gỡ khi ảnh rời viewport;
- `MutationObserver` hiện chỉ schedule prune khi DOM/source attributes đổi, không tự khám phá hoặc tự dịch ảnh mới;
- không có scroll listener; tọa độ document khiến overlay cuộn cùng trang.

`enabled=false` chỉ ẩn overlay hiện có; nó không hủy pipeline đang chạy.

Nguồn: `extension/content.js:130-248`, `extension/overlay.css`.

## 5. State thực tế

| State | Nơi giữ | Sống bao lâu | Identity hiện tại |
|---|---|---|---|
| settings | `chrome.storage.local` | qua restart | `enabled`, `srcLang`, `dstLang` |
| OCR completed cache | background `Map` | tới khi worker ngủ | URL + srcLang + crop |
| OCR single-flight | background `Map` | tới khi Promise settle | URL + srcLang + crop |
| queue | background array | tới khi worker sống/job chạy | không có request ID |
| translated marker | content `WeakMap` | vòng đời content script/DOM node | source + srcLang + crop |
| newest manual action | content `WeakMap` | vòng đời DOM node | object token, không cancel |
| overlay ownership | content `Map` | tới khi remove/prune/navigation | DOM image |
| active Gemini project | server memory | vòng đời server | client index |

## 6. Error và partial-success thực tế

| Điểm lỗi | Hành vi hiện tại |
|---|---|
| server offline | popup báo offline khi mở; health không polling |
| fetch ảnh lỗi | ảnh trả `{ok:false}`, badge bật cho thao tác tay |
| crop thiếu field hoặc ngoài `[0,1]` | `/ocr` trả 422 |
| ảnh không decode được | `/ocr` trả 422 |
| detector/recognizer exception | `/ocr` trả 500; mất toàn ảnh |
| một ảnh OCR lỗi trong scope | các ảnh khác vẫn được dịch; ảnh lỗi được retry ở lần bấm sau |
| mọi OCR block rỗng | không gọi Gemini; gỡ overlay và đánh dấu ảnh hoàn tất |
| Gemini lỗi/quota | toàn translation phase thất bại; OCR thành công vẫn còn trong background cache |
| result về muộn | vẫn tiêu tốn tài nguyên nhưng bị guard chặn render nếu stale |
| Port/service worker restart | chưa có Port/resume protocol; state RAM mất |

## 7. Đối chiếu hai roadmap

### 7.1 Những gì bản revised đã sửa đúng so với bản cũ

| Chủ đề | Roadmap cũ | Roadmap revised | Kết luận kiểm tra |
|---|---|---|---|
| `_ocr_lock` | phần phase sau vẫn còn đề xuất thu hẹp | loại khỏi roadmap gần | Revised đúng với số đo ~0.02 s lợi ích |
| batch recognizer | vẫn xuất hiện trong phase throughput | loại vì API hiện tại không nhanh/không đúng | Revised đúng |
| bottleneck cảm nhận | nêu nhưng cạnh tranh với nhiều tối ưu khác | chốt stream/render progressive là P0 | Revised đúng |
| cache bền | mặc định IndexedDB | thử `chrome.storage.session` trước | Revised tối giản và phù hợp hơn |
| Shadow DOM/tiling/WebGPU | đặt tương đối sớm | chỉ làm khi fixture/metric chứng minh | Revised đúng YAGNI |
| giao thức | mô tả chung | có event mẫu và identity rõ | Revised triển khai được hơn |
| tiêu chí thành công | chủ yếu định tính | có TTFT/total/correctness gate | Revised kiểm chứng được hơn |

### 7.2 Đối chiếu roadmap revised với code hiện tại

| Hạng mục revised | Trạng thái code | Kết luận |
|---|---|---|
| giữ OCR local, dịch cloud, bbox ảnh gốc | đã có | giữ nguyên |
| dedupe IoU 0.5 | đã có và có regression test | giữ nguyên |
| `dstLang` + version trong key | chưa có | correctness slice đầu tiên |
| `requestId`/`jobId`/`blockId` | chưa có | bắt buộc trước streaming |
| structured translation theo ID | chưa có | đang dùng array index |
| NDJSON + `StreamingResponse` | chưa có | target, không phải as-is |
| `chrome.runtime.Port` | chưa có | target, không phải as-is |
| upsert overlay theo `blockId` | chưa có | hiện replace toàn ảnh |
| scheduler ưu tiên viewport | chưa có | hiện `Promise.all` + FIFO |
| cancellation queued/fetch | chưa có | token chỉ drop stale render |
| micro-batch dịch | chưa có | hiện một Gemini call cuối scope |
| persistent/session cache | chưa có | chỉ `Map` RAM |
| Shadow DOM | chưa có | giữ ngoài P0 |
| PaddleOCR GPU | chưa có | spike riêng, không chạm venv ổn định |

### 7.3 Các điểm spec mới phải làm rõ hơn roadmap revised

1. **Reading order:** block hiện bị sort theo diện tích; spec phải định nghĩa thứ tự ổn định trước khi micro-batch/context translation.
2. **Observer hiện có:** giữ `MutationObserver` phục vụ prune; câu “không thêm MutationObserver toàn trang” chỉ nên cấm auto-discovery/auto-translate mới.
3. **Model lifecycle:** detector eager nhưng recognizer lazy; không mô tả chung là “mọi model load lúc startup”.
4. **Granularity lỗi:** as-is cô lập theo ảnh; target mới muốn cô lập theo block phải định nghĩa event/error và tiêu chí đánh dấu `image_done`.
5. **API compatibility:** `/ocr` JSON và `/translate` smoke path phải được giữ; endpoint stream nên là đường bổ sung.
6. **Identity:** `blockId` tạo từ bbox cần quy tắc canonical/duplicate rõ; bbox giống nhau sau dedupe không được silently collide.
7. **Translation policy:** transport progressive không đồng nghĩa tự động chọn DeepL hay refine; P0 nên benchmark Gemini micro-batch trước.
8. **Popup lifetime:** progress/cancel không thể dựa vào popup DOM luôn mở; content/background phải sở hữu request lifecycle.

## 8. Phạm vi spec khuyến nghị

Một spec P0 dạng vertical slice là phạm vi nhỏ nhất vẫn tạo giá trị end-to-end:

```text
correct identity/key
  -> request/job/block IDs
  -> stream OCR block qua endpoint bổ sung + Port
  -> bounded viewport-first scheduler
  -> translation micro-batch theo ID
  -> upsert overlay + stale guards trên từng event
  -> cancel queued/fetch stale
  -> đo TTFT và total-time regression
```

Không đưa PaddleOCR GPU, DeepL refine, IndexedDB, Shadow DOM, tiling hoặc ONNX/WebGPU vào cùng spec. Chúng là các spike/spec độc lập sau khi P0 có số đo.

## 9. Bằng chứng kiểm chứng

- CodeGraph được dùng để truy vết entry point, call path và blast radius; các file được báo chờ index đã được đọc lại trực tiếp.
- Graphify BFS nối các community popup/content/background, OCR pipeline, overlay và các design docs; graph được dùng làm bối cảnh kiến trúc, không thay cho current source.
- Node: `background.test.js`, `content.test.js`, `srcset.test.js`, `popup.test.js` — **4/4 pass**.
- Python: `pytest server/tests -q` — **50 pass**, 3 warning dependency/deprecation không làm test fail.

Điểm chưa được kiểm lại trong lượt này: benchmark latency 2026-07-29 và acceptance browser trên site thật. Các con số latency trong roadmap vẫn là bằng chứng lịch sử, chưa phải benchmark tự động tái lập ở mỗi test run.
