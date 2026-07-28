# Thiết kế: Hỗ trợ 2 bố cục đọc bằng hai hành động rõ ràng

Ngày: 2026-07-23 · Tái kiểm tra: 2026-07-28 · Nhánh: `feat/v1` · Thread A (log.txt ý 1–2, ƯU TIÊN) · Tiếp nối: `2026-07-21-manga-translator-design.md`

## Bối cảnh & vấn đề

Web đọc truyện có 2 kiểu bố cục:
- **Webtoon (dọc):** nhiều trang xếp dọc, cuộn liên tục (hoặc 1 ảnh strip rất cao).
- **Reader (ngang):** từng trang một, lật qua lại, thường full-viewport.

Kiến trúc hiện tại (`content.js`) đã định vị overlay **per-`<img>` theo tọa độ tài liệu** (`getBoundingClientRect + scrollY`, `ResizeObserver`) và nút "Dịch trang này" đã **OCR mọi ảnh đã load rồi gom 1 call Gemini**. Phần định vị + batch dùng chung được cho cả hai bố cục, nhưng lần tái kiểm tra xác nhận bốn chỗ cần sửa:

1. **`done` theo element identity** (`WeakSet<img>`): reader lật trang thường **đổi `src` trên cùng element** → ảnh vẫn nằm trong `done` → trang mới không bao giờ được dịch.
2. **Overlay không reset khi lật trang:** overlay trang cũ (tọa độ + chữ Việt cũ) lơ lửng đè lên trang mới cho tới khi bị thay.
3. **Hai bố cục cần tập ảnh khác nhau:** webtoon cần mọi ảnh hợp lệ đã load; reader một trang chỉ cần ảnh đang giao với viewport. Một bộ lọc chung không thể đáp ứng cả hai mà không đoán layout.
4. **Kết quả bất đồng bộ có thể bị cũ:** nếu reader lật trang trong lúc OCR/Gemini đang chạy, kết quả của nguồn cũ có thể quay về sau và vẽ lên nguồn mới.

## Quyết định thiết kế

**Hai hành động rõ ràng trong popup, dùng chung một pipeline** (đã chốt lại với user ngày 2026-07-28):

- **Dịch webtoon đã tải** (`scope: "loaded"`): mọi ảnh hoàn tất tải, hợp lệ và chưa dịch đúng nguồn hiện tại.
- **Dịch trang đang xem** (`scope: "visible"`): chỉ các ảnh hợp lệ đang giao với viewport.

Không heuristic đoán layout, không lưu chế độ và không auto-translate. User chủ động chọn hành động phù hợp với website; webtoon bấm lại khi cuộn làm load thêm ảnh, reader bấm sau mỗi lần lật trang. Phạm vi hỗ trợ là reader dùng DOM `<img>`/`<picture>`.

## Thành phần

### 1. Hai hành động popup (`popup.html`, `popup.js`)

Thay nút hiện tại bằng hai nút gửi cùng message `translatePage` kèm `scope`:

- `scope: "loaded"` cho **Dịch webtoon đã tải**.
- `scope: "visible"` cho **Dịch trang đang xem**.

`content.js` chỉ nhận đúng hai giá trị scope trên; giá trị khác trả lỗi thay vì ngầm chọn hành vi. Khi một hành động đang chạy, disable cả hai nút và dùng vùng kết quả hiện tại để báo số ảnh/block hoặc lỗi. `images` đếm nguồn hoàn tất còn hiện hành trong lần bấm đó (kể cả nguồn không có text); `blocks` đếm block đã dịch và vẽ. Job OCR lỗi hoặc bị cũ không được tính. Không thêm setting, dependency hay luồng background mới.

### 2. Chọn ảnh theo scope (`srcset.js`, `content.js`)

Mở rộng `srcset.js` (đã được manifest load trước `content.js`) với hai predicate thuần và export chúng cùng `bestSource` cho Node self-check:

- `isViewportVisible(img, viewportWidth, viewportHeight)`: yêu cầu `getClientRects()` không rỗng, rect có kích thước và giao với viewport.
- `isCurrentSource(img, source)`: yêu cầu ảnh còn connected và `bestSource(img) === source`.

`content.js` giữ việc gom candidate. Bộ lọc chung yêu cầu:

- `img.complete`.
- `eligible(img)`.
- Có `source = bestSource(img)`.
- `translated.get(img) !== source`.

Sau đó áp dụng scope:

- `loaded`: nhận toàn bộ ảnh qua bộ lọc chung.
- `visible`: chỉ nhận ảnh có rect khác 0 và giao với viewport (`bottom > 0`, `right > 0`, `top < innerHeight`, `left < innerWidth`). Ảnh nhìn thấy một phần vẫn được nhận để hỗ trợ spread hai trang.

Không suy đoán bố cục từ số ảnh, hướng xếp hoặc CSS của website.

### 3. Trạng thái theo nguồn và chặn kết quả cũ (`content.js`)

Thay `done: WeakSet<img>` bằng `translated: WeakMap<img, string>`, map ảnh → URL nguồn đã hoàn tất. Khi bắt đầu, mỗi job chụp bất biến `{ img, source: bestSource(img) }` và OCR đúng `source` đó.

Trước khi ghi trạng thái hoặc vẽ overlay, `isCurrentSource(img, source)` phải đúng:

- `img.isConnected`.
- `bestSource(img) === source`.

Nếu một điều kiện sai, bỏ kết quả cũ, không vẽ và không ghi `translated`. Chỉ ghi `translated.set(img, source)` sau khi nguồn đó hoàn tất thành công; ảnh OCR lỗi không được ghi để lần bấm sau thử lại. Ảnh OCR thành công nhưng không có text vẫn được ghi hoàn tất nếu job còn hiện hành.

### 4. Vòng đời overlay (`content.js`)

Mỗi entry trong `overlays` sở hữu `{ container, data, source, scope, resizeObserver, intersectionObserver }`; `intersectionObserver` là observer thật cho scope `visible`, ngược lại là `null`. Một hàm `removeOverlay(img)` duy nhất:

- Gỡ container.
- Disconnect các observer của entry.
- Xóa entry khỏi `overlays`.
- Xóa ảnh khỏi `translated` để có thể dịch lại khi cần.

`renderOverlay` gọi cleanup trước khi thay overlay, lưu `ResizeObserver` thay vì tạo observer không thể disconnect, rồi định vị như hiện tại.

`MutationObserver` trên `document.body` theo dõi `childList` và các thuộc tính nguồn liên quan (`src`, `srcset`, `sizes`, `media`, `type`) trong subtree. Mỗi batch mutation chỉ schedule một lần quét ở animation frame kế tiếp; quét `overlays` và cleanup entry khi ảnh rời DOM hoặc `bestSource(img) !== entry.source`. Cách quét cũng xử lý `<picture><source>` và ancestor bị gỡ mà không cần phân tích từng `removedNode`.

Overlay từ scope `visible` có thêm `IntersectionObserver`; khi ảnh hoàn toàn rời viewport, cleanup overlay cũ nhưng **không** tự dịch ảnh mới. Overlay scope `loaded` không bị gỡ chỉ vì user cuộn khỏi ảnh, nên webtoon giữ bản dịch khi cuộn đi rồi quay lại.

### 5. Định vị

Giữ `position()` theo tọa độ tài liệu. `ResizeObserver` toàn trang và listener `window.resize` tiếp tục định vị mọi overlay; cùng lần đó quét nguồn để bắt `currentSrc` thay đổi do responsive layout.

## Luồng dữ liệu

```
User chọn "webtoon đã tải" hoặc "trang đang xem"
  → translatePage(scope)
  → chọn ảnh theo scope + chụp { img, source }
  → /ocr từng source (background giữ giới hạn 2 đồng thời)
  → gom text OCR thành công
  → 1 call /translate-texts (Gemini)
  → với từng job còn hiện hành: renderOverlay + translated.set(img, source)

Nguồn đổi / ảnh rời DOM / ảnh scope visible rời viewport
  → observer gọi removeOverlay(img)
  → kết quả OCR/Gemini cũ quay về sẽ bị source guard loại
  → chờ user bấm hành động phù hợp cho ảnh mới
```

Tất cả overlay hợp lệ được tạo đồng bộ sau khi request dịch trả về, nên nhìn như xuất hiện cùng lúc. Webtoon lazy-load thêm ảnh không làm phát sinh công việc tự động; user bấm lại và bộ lọc chỉ nhận nguồn mới/chưa hoàn tất.

## Xử lý lỗi

- Ảnh OCR fail: bỏ riêng ảnh đó, không ghi `translated` → lần bấm sau thử lại. Các ảnh OCR thành công trong cùng batch vẫn tiếp tục.
- Gemini fail: không vẽ batch đó và không ghi hoàn tất, nên lần bấm sau thử lại toàn bộ nguồn liên quan. Badge `!` đỏ giữ hành vi background hiện có.
- Job bị cũ do lật trang: bỏ im lặng, không coi là lỗi server.
- Popup mất kết nối/content script: giữ thông báo F5 hiện tại.

## Hiệu năng

- OCR vẫn chạy tối đa 2 ảnh đồng thời qua queue hiện có; đây là phần tốn thời gian chính.
- Toàn bộ text OCR thành công đi trong **một** request Gemini để giữ ngữ cảnh và tránh lặp call/429.
- Tạo overlay là tuyến tính theo số block và rẻ hơn đáng kể so với OCR/Gemini.
- Chưa chunk request theo số trang. Chỉ thêm chunk tuần tự khi một chapter thật chạm giới hạn payload/model hoặc timeout 60 giây; không xây pipeline suy đoán trước nhu cầu.

## Kiểm thử

### Tự động, không thêm framework

Mở rộng self-check Node dùng `assert` hiện có cho helper ảnh:

- Scope `loaded` nhận mọi ảnh hợp lệ chưa hoàn tất.
- Scope `visible` loại ảnh zero-size/offscreen và nhận ảnh giao viewport một phần.
- Cùng element đổi source được nhận lại.
- Job có source cũ hoặc ảnh đã disconnect bị loại trước khi render.

Tiếp tục chạy kiểm tra `bestSource` cho `srcset` và `<picture>`.

### Kiểm chứng tay

- **Webtoon** (fixture + 1 site cuộn dọc): hành động loaded tạo overlay cho mọi ảnh đã load; cuộn đi/quay lại vẫn còn; bấm lại không dịch nguồn cũ; load thêm rồi bấm lại chỉ dịch ảnh mới.
- **Reader đổi source trên cùng `<img>`:** hành động visible chỉ dịch trang đang thấy; lật trang gỡ overlay cũ; bấm lại vẽ đúng trang mới.
- **Reader carousel dùng nhiều `<img>`:** khi ảnh cũ rời viewport, overlay của nó biến mất; ảnh preload ngoài viewport không được dịch.
- **Race:** lật trang khi OCR/Gemini đang chạy không được làm overlay cũ xuất hiện lại.
- **Nguồn responsive:** đổi `srcset`/`<picture><source>` làm cleanup overlay và cho phép dịch lại.
- **Popup:** khi đang chạy, cả hai hành động bị disable và kết quả báo đúng số ảnh/block hoặc lỗi.

## Ngoài phạm vi (backlog)

- **Fullscreen API thật:** element `requestFullscreen` → overlay gắn `document.body` không hiện trong lớp fullscreen. Chỉ xử khi gặp reader thật dùng Fullscreen API (gắn overlay vào `document.fullscreenElement`). YAGNI hiện tại.
- Reader vẽ trang bằng `<canvas>` hoặc CSS `background-image`; thiết kế này chỉ hỗ trợ `<img>`/`<picture>`.
- Tự động nhận diện webtoon/reader hoặc ghi nhớ mode theo website; hai hành động explicit thay thế nhu cầu đó.
- Auto-translate / auto-scroll ép webtoon load (giữ thủ công theo log).
- Đa luồng scan/dịch/ghi theo chu kỳ 5 trang (log ý #scan) — kiến trúc hiện tại không "ghi đè file", chi phí thật là OCR + Gemini; batch 1-call hiện tại đã đủ, chưa cần pipeline đa luồng.
- Chữ ngoài bóng thoại + inpaint (thread C), Hàn/Trung (thread D).

## Phụ thuộc

`bestSource(img)` từ thread B đã có trong `extension/srcset.js` (commit `b70600c`, bổ sung `<picture>` ở `42ca1b4`). Không cần dependency mới hoặc thay đổi server/API.
