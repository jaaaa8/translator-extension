# Thiết kế tài liệu giải thích workflow MangaTranslator

**Ngày:** 2026-08-03

**Trạng thái:** Đã được người dùng duyệt; sẵn sàng triển khai theo implementation plan

**Artifact đích:** `workflow-guide.md` tại thư mục gốc repository

## 1. Mục tiêu

Tạo một tài liệu tiếng Việt giúp người mới hiểu chính xác MangaTranslator hiện hoạt động thế nào trên `feat/v3`, từ lúc chọn hành động trong popup đến lúc overlay xuất hiện. Tài liệu phải mở đầy đủ “hộp đen OCR”: chọn nguồn ảnh, tính crop, detector resize ảnh, dedupe bbox, chia region, preprocessing, nhánh MangaOCR/PaddleOCR, streaming, translation, cache và vòng đời khi chuyển trang.

Tài liệu chỉ mô tả code hiện tại. Không trộn đề xuất tối ưu, roadmap, hành vi ở nhánh chưa merge hoặc kiến trúc mong muốn vào luồng đang chạy.

`work-flow.md` hiện tại được giữ nguyên. Tài liệu mới không thay thế spec, plan, worklog, benchmark report hay test evidence.

## 2. Nguồn sự thật và ranh giới phiên bản

Nội dung phải được đối chiếu với source hiện tại, ưu tiên:

- `extension/popup.js`;
- `extension/content.js`;
- `extension/srcset.js`;
- `extension/background.js`;
- `extension/page-cache.js`;
- `server/main.py`;
- `server/pipeline.py`;
- `server/detector.py`;
- `server/ocr.py`;
- `server/artifacts.py`;
- `server/translator.py`;
- phần vendor detector được gọi bởi `server/detector.py`;
- package MangaOCR và PaddleOCR đang được môi trường hiện tại gọi trực tiếp.

Nhánh `feat/spec-a-telemetry-quality-gate` chưa merge không được mô tả như hành vi hiện tại. Khi roadmap, worklog hoặc benchmark mâu thuẫn source, source trên `feat/v3` thắng.

## 3. Kiến trúc tài liệu

`workflow-guide.md` gồm 11 phần theo vòng đời dữ liệu:

1. **Đọc nhanh trong hai phút:** đường đi ngắn nhất từ thao tác người dùng đến overlay.
2. **Thành phần và dữ liệu chính:** popup, content script, background, local server, detector, recognizer, Gemini, overlay; `request`, `job`, `producer`, `consumer`, `region`, `block`, `artifact`.
3. **Chọn ảnh và nguồn ảnh:** điều kiện `400×400`, `visible`/`loaded`, `currentSrc`, `srcset` và full-resolution source.
4. **Viewport crop và hệ tọa độ:** crop chuẩn hóa, padding 10%, đổi sang pixel bằng `floor`/`ceil`, offset và bbox ảnh gốc.
5. **Tạo key và xếp lịch job:** các cache key, priority, concurrency và producer/consumer.
6. **Detector xử lý ảnh:** decode, optional crop, letterbox/resize `1024×1024`, inference, scale bbox ngược, dedupe và `block_id`.
7. **Chia region và nhận dạng:** clip bbox, BGR→RGB, upscale tối thiểu 48 px, viền trắng 8 px, MangaOCR và PaddleOCR.
8. **OCR streaming, dịch và overlay:** NDJSON events, micro-batch, `/translate-items`, stale guard và block upsert.
9. **Các tầng cache:** in-flight stage, server LRU, background hot cache và `chrome.storage.session`.
10. **Chuyển trang và restart:** source/DOM thay đổi, supersession, `visible` background completion, `loaded` retirement, Port reconnect, service-worker restart, Chrome restart và server restart.
11. **Metrics hiện tại:** queue, fetch, analysis, first OCR, first translation, first overlay và total, gồm các giới hạn instrumentation hiện có.

## 4. Thiết kế trực quan

Tài liệu dùng đúng ba sơ đồ Mermaid chính, đặt ngay trước phần văn bản mà chúng giải thích.

### 4.1 Sơ đồ 1 — End-to-end sequence

Participants:

- Người dùng;
- Popup;
- Content script;
- Background;
- Cache;
- Local server;
- Gemini;
- Overlay.

Sơ đồ phải thể hiện:

1. `translatePage` và candidate snapshot;
2. source/crop selection;
3. tạo `request_id`, `job_id` và binding;
4. `start_scope` qua Port;
5. `/health`, key construction và cache lookup;
6. exact page hit phát lại translation;
7. cold/partial path qua `/ocr-stream`;
8. `analysis_ready`, `ocr_block`, micro-batch và `/translate-items`;
9. Gemini trả kết quả theo ID;
10. `validBinding`, `upsertOverlayBlock` hoặc loại stale result;
11. `scope_done`.

### 4.2 Sơ đồ 2 — Bên trong OCR

Sơ đồ flowchart đi theo chuỗi:

```text
image bytes
→ cv2.imdecode BGR
→ optional normalized crop
→ detector letterbox 1024×1024
→ bbox về kích thước work
→ xyxy thành x,y,w,h
→ dedupe IoU
→ clip region
→ cộng crop offset
→ BGR sang RGB
→ upscale nếu height < 48
→ viền trắng 8 px
→ MangaOCR hoặc PaddleOCR
→ ocr_block với bbox ảnh gốc
```

Hai nhánh recognizer phải được vẽ riêng. PaddleOCR phải thể hiện detector nội bộ và recognizer nội bộ; MangaOCR phải thể hiện PIL/grayscale/ViT generation.

### 4.3 Sơ đồ 3 — Cache và chuyển trang

Sơ đồ phải thể hiện cả cache decision và request lifecycle:

- exact page artifact → replay;
- OCR sibling → chỉ dịch lại;
- analysis sibling → gọi không image;
- server còn artifact → bỏ detector;
- server trả `409 analysis_missing` → retry kèm image;
- request cũ `visible` → demote background và persist;
- request cũ `loaded` không còn consumer → retire;
- service worker restart → mất memory maps, rehydrate visible jobs;
- Chrome restart → mất `chrome.storage.session`;
- local server restart → mất analysis/OCR LRU.

Không tạo HTML, ảnh xuất riêng, dependency hoặc visual tương tác ngoài Markdown/Mermaid.

## 5. Contract chi tiết phải mô tả

### 5.1 Chọn ảnh và crop

- Chỉ xét `<img>`; canvas hiện không thuộc pipeline.
- Candidate phải `complete`, có source và có `naturalWidth`, `naturalHeight` đều ít nhất 400.
- `visible` chỉ lấy ảnh giao viewport, dùng `currentSrc || src`, tính crop từ phần ảnh thật sau `object-fit`, cộng padding 10% và chuẩn hóa sáu chữ số thập phân.
- Crop phủ toàn ảnh được canonicalize thành `full`.
- `loaded` lấy mọi ảnh đủ điều kiện đã load, dùng `bestSource()` và không tạo viewport crop.
- `bestSource()` ưu tiên ứng viên `srcset` có descriptor lớn nhất trong source set phù hợp.
- Content snapshot source, source signature, crop, kích thước tự nhiên, scope và cặp ngôn ngữ trước khi gửi job.

### 5.2 Key và scheduler

- `sourceRevision`: URL bỏ fragment + kích thước tự nhiên.
- `analysis_key`: source revision + crop + detector/dedupe/preprocessing versions.
- `ocr_key`: analysis + source language + recognizer version.
- `overlay_key`: OCR + destination language + translator/prompt/policy versions.
- `page_artifact_key`: overlay + page schema.
- Scheduler có `MAX_CONCURRENT = 2`, `MAX_OUTSTANDING_PER_REQUEST = 4`.
- Priority là foreground `0`, background `1`, prewarm `2`; foreground/prewarm ưu tiên khoảng cách viewport, background giữ FIFO.

### 5.3 Detector và analysis artifact

1. Decode bytes thành ảnh BGR.
2. Nếu có crop, dùng `floor` cho trái/trên và `ceil` cho phải/dưới; giữ `offset_x`, `offset_y`.
3. Detector nhận `work`, tức toàn ảnh hoặc phần crop.
4. Vendor giữ tỷ lệ, letterbox vào `1024×1024`, chạy model rồi scale output về `work`.
5. Wrapper đổi `xyxy` thành `(x, y, width, height)`.
6. Dedupe xử lý box lớn trước và bỏ box sau nếu `IoU > 0.5`.
7. Clip bbox trong biên `work`; bỏ box rỗng.
8. Cộng offset để bbox trở lại tọa độ ảnh nguồn.
9. Tạo `block_id` từ `analysis_key`, bbox và ordinal.
10. `AnalysisArtifact` giữ image dimensions, bbox và prepared RGB crops.

Nếu CUDA detector khởi tạo lỗi, wrapper fallback CPU. Field `vertical` hiện không chọn recognizer; `src_lang` mới là điều kiện rẽ nhánh.

### 5.4 Region preprocessing

- Cắt region từ `work` bằng bbox đã clip.
- Đổi BGR sang RGB.
- Nếu chiều cao nhỏ hơn 48 px, scale cả hai chiều theo `48/current_height` bằng `INTER_CUBIC`.
- Thêm viền trắng 8 px ở bốn phía.
- Resize chỉ áp dụng cho recognizer input; bbox overlay vẫn theo ảnh gốc.

### 5.5 MangaOCR

- `OcrRegistry` lazy-load `MangaOcrEngine` cho `src_lang = ja`.
- Project truyền prepared RGB crop dưới dạng `PIL.Image`.
- Package MangaOCR đổi grayscale rồi RGB, dùng `ViTImageProcessor`, `model.generate(max_length=300)`, tokenizer decode và post-process.
- MangaOCR tự chọn CUDA nếu PyTorch thấy CUDA; constructor chạy warm-up của package một lần.
- Project đọc từng region; lớp engine hiện không cung cấp batch path.

### 5.6 PaddleOCR

- `OcrRegistry` lazy-load `PaddleLatinEngine` cho `src_lang = es`.
- Engine dùng `PaddleOCR(lang="es")`.
- Tắt document orientation, document unwarping và text-line orientation; tắt MKL-DNN trên Windows CPU.
- `predict(crop_rgb)` chạy Paddle text detector và text recognizer bên trong region do comic detector cắt ra.
- Các `rec_texts` được nối bằng dấu cách.
- Project đọc từng region; không gọi batch interface ở lớp engine.

### 5.7 Lock, streaming và block failure

- Detector và recognizer dùng chung `_ocr_lock` nên ML inference được serialize.
- `analysis_ready` được phát trước các OCR block.
- Region thành công và có text → `ocr_block`.
- Region thành công nhưng text rỗng → được đánh dấu đã xử lý, không tạo translation block.
- Recognizer lỗi → `ocr_block_error`; region không được đánh dấu complete nên lần sau có thể retry riêng region đó.
- Sau tất cả region → `image_done`.
- Một block lỗi không được xóa block đã thành công.

### 5.8 Translation micro-batch

- Batch đầu: tối đa 3 block hoặc 250 ms.
- Batch sau: tối đa 8 block hoặc 500 ms.
- Batch flush khi đủ số lượng, hết timer hoặc OCR hoàn tất.
- `translationChain` serialize các batch của một producer.
- `/translate-items` dùng `{id, text}` và kiểm tra ID duy nhất ở extension, endpoint và translator normalization.
- `GeminiTranslator` yêu cầu JSON ID-keyed, temperature `0.2`, JSON MIME; tối đa hai attempt theo behavior hiện tại và có thể chuyển secondary client khi attempt đầu gặp 429.
- `hotTranslations` chỉ bỏ qua server/Gemini khi toàn batch hit; partial hit vẫn gửi lại toàn batch.

### 5.9 Overlay và completion

- Translation chỉ render sau `validBinding`: job/request, image request ownership, connected DOM, source, source signature và languages đều phải khớp.
- Overlay là một container trên mỗi image binding; block được upsert theo `block_id`.
- Bbox ảnh nguồn được scale sang rendered image rectangle.
- `object-fit: contain` và `scale-down` dùng phần ảnh thật thay vì toàn CSS box.
- Font bắt đầu 18 px và giảm đến tối thiểu 10 px.
- Producer chờ OCR và toàn bộ translation chain trước `image_done`.
- Page là `complete` khi không có block lỗi/thiếu translation, ngược lại là `partial`.
- `scope_done` chỉ phát khi mọi expected job đã complete.
- `cache_hit` chỉ true khi mọi job là exact page hit.

## 6. Cache contract hiện tại

### 6.1 Background in-flight state

- `analysisStages` chia sẻ owner/promise/event theo `analysis_key`.
- `ocrStages` chia sẻ blocks/errors/completion theo `ocr_key`.
- Đây là single-flight state, không phải persistent cache; stage bị giải phóng khi hết consumer.

### 6.2 Server LRU

- `_analysis_cache`: tối đa 32 artifact và 128 MiB; giữ prepared region crops thật.
- `_ocr_cache`: tối đa 256 artifact; giữ completed IDs, blocks, failures và complete flag.
- Cả hai mất khi local server restart.

### 6.3 Background hot maps

- `hotTranslations`: tối đa 2.048 entry và được progressive path đọc lại.
- `hotOcr`: legacy `ocrImage` đọc/ghi; progressive path hiện ghi dưới `ocr_key` nhưng không đọc lại, nên không được mô tả như progressive reuse đang hoạt động.
- Hot maps mất khi service worker dừng.

### 6.4 Browser session cache

- `PageCache` dùng `chrome.storage.session`, ngân sách 8 MiB.
- Chỉ scope `visible` lookup/persist page artifact và job ledger.
- Stored page chỉ chứa metadata, versions, crop, dimensions, state và blocks; không chứa image bytes hoặc prepared RGB crops.
- Exact page hit replay toàn bộ translation.
- OCR sibling hit reuse bbox/`src_text` và chỉ dịch lại.
- Analysis sibling chỉ là cờ browser; server phải còn artifact thật. Nếu không, background xử lý `409` bằng một retry có image.
- Page có version metadata không tương thích bị purge.

### 6.5 Prewarm

- Popup khỏe mạnh prewarm một lần ảnh visible có diện tích hiển thị lớn nhất; đổi source language cũng prewarm lại.
- Prewarm chạy detector/OCR, không dịch và không render.
- Prewarm độc lập chủ yếu làm nóng model/server RAM; nó không tự tạo complete page artifact.
- Chuyển trang khi popup đã đóng không tự prewarm hoặc dịch.

## 7. Chuyển trang và request lifecycle

### 7.1 Source hoặc DOM thay đổi

- `MutationObserver` theo dõi `src`, `srcset`, `sizes`, `media`, `type` và child changes.
- Overlay bị prune nếu node rời DOM, source signature đổi hoặc source hiện tại không còn khớp.
- `validBinding` bỏ event cũ.
- Source change tự nó không gửi cancel tới background; computation cũ có thể tiếp tục đến completion hoặc đến request replacement.

### 7.2 Request mới supersede request cũ

- Content tạo request mới, resolve request cũ với `superseded`, snapshot job mới và gửi `replaces_request_id`.
- Background attach request mới trước rồi release consumer cũ.
- Exact replacement tiếp tục dùng producer đang chạy.
- Cùng source/crop nhưng page key khác có thể reuse analysis/OCR stage; producer cũ retire nếu không còn consumer.
- Request cũ `visible` không có replacement tương ứng được demote background và tiếp tục persist.
- Request cũ `loaded` không còn consumer bị retire, hủy translation timer/pending batch, cancel queued task và giải phóng stage.

### 7.3 Popup, Port và restart

- Đóng popup không dừng job; work nằm trên Port content↔background.
- Content unload/full navigation làm Port disconnect và release request.
- Port rớt khi content còn sống: content reconnect rồi gửi lại active `start_scope`.
- Service worker restart mất in-memory maps; visible queued/running jobs được rehydrate thành queued và resume; loaded jobs không được phục hồi.
- Chrome restart xóa `chrome.storage.session`, nhưng không tự xóa server RAM nếu local server vẫn chạy.
- Local server restart xóa analysis/OCR LRU; browser metadata stale dẫn đến `409` rồi retry kèm image.

## 8. Metrics hiện tại

- `queue_wait_ms`: producer accepted → task bắt đầu.
- `fetch_ms`: thời gian background fetch source image.
- `analysis_ms`: background đọc `analysis_ready.analysis_ms`, nhưng production `/ocr-stream` hiện không phát field này nên giá trị thường là `0`.
- `first_ocr_ms`: producer accepted → `ocr_block` đầu tiên.
- `first_translation_ms`: producer accepted → translation đầu tiên được apply.
- `first_overlay_ms`: content bắt đầu request → block đầu tiên được upsert; trả riêng trong kết quả `translatePage` và gửi background bằng `render_metric`.
- `total_ms`: request accepted → `scope_done`.

Không mô tả `analysis_ms` như measurement detector hoàn chỉnh. Không đặt `first_overlay_ms` bên trong `scope_done.metrics`, vì source hiện tại không làm vậy.

## 9. Quy tắc trình bày

- Viết tiếng Việt; giữ identifier kỹ thuật trong backtick.
- Định nghĩa thuật ngữ trước lần sử dụng quan trọng đầu tiên.
- Mỗi bước quan trọng phải nói rõ input, xử lý, output và cache nào có thể bỏ qua bước đó.
- Dùng ba sơ đồ chính đã duyệt và bảng nhỏ cho cache/metrics khi bảng dễ đọc hơn prose.
- Tách rõ bbox detector trong crop, bbox ảnh gốc và tọa độ CSS overlay.
- Tách rõ comic detector bên ngoài với Paddle detector bên trong.
- Khi một cấu trúc có tên “cache” nhưng không được current progressive path đọc lại, phải nói rõ giới hạn đó.
- Không gắn số dòng source dễ lỗi thời; chỉ nhắc file/symbol khi cần.
- Không sao chép payload đầy đủ nếu ví dụ rút gọn đủ giải thích contract.

## 10. Ngoài phạm vi

Tài liệu không chứa:

- đề xuất tối ưu hoặc đánh giá nên sửa code thế nào;
- C, C++, Rust, Paddle GPU hoặc runtime migration;
- benchmark table hay kết luận hiệu năng;
- ma trận xử lý lỗi chi tiết;
- API/message legacy ngoài chỗ cần phân biệt `hotOcr`;
- roadmap, feature chưa merge hoặc future architecture;
- source map phục vụ code navigation;
- debug runbook hoặc checklist test;
- canvas/capture workflow chưa tồn tại.

## 11. Tiêu chí hoàn thành

1. Chỉ tạo `workflow-guide.md`; `work-flow.md` không đổi.
2. Có đúng 11 phần và ba Mermaid diagram đã duyệt.
3. Người mới có thể lần theo ảnh từ DOM đến overlay mà không cần đọc source.
4. `visible` và `loaded` không bị mô tả lẫn nhau.
5. Detector resize, crop coordinate conversion, dedupe, region preprocessing và bbox offset được mô tả đúng thứ tự.
6. MangaOCR và PaddleOCR được tách nhánh đúng theo current engine calls.
7. Paddle detector nội bộ không bị bỏ sót; detector `vertical` không bị mô tả như router.
8. Mỗi cache layer nói rõ location, key, payload, lifetime và bước được bỏ qua.
9. `hotOcr` không bị quảng bá sai thành progressive cache hit path.
10. SPA source swap, request supersession, Port disconnect, service-worker restart, Chrome restart và server restart được phân biệt.
11. `analysis_ms` và `first_overlay_ms` được mô tả theo instrumentation thực tế.
12. Mọi identifier, endpoint, constant và version-sensitive behavior được nhắc đều tồn tại trong current `feat/v3` source.
13. Không có nội dung ngoài phạm vi.
14. Markdown/Mermaid hợp lệ, UTF-8 hợp lệ và `git diff --check` sạch.
