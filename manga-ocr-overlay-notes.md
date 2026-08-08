# Manga OCR Overlay Extension — Ghi chú kỹ thuật

Tài liệu tổng hợp từ thảo luận. Mục tiêu: browser extension tự viết, OCR text tiếng Nhật trên trang manga, dịch, overlay lên UI gốc.

---

## 1. Kiến trúc tổng thể

Nguyên tắc quan trọng nhất: **tách nguồn capture ra khỏi phần còn lại của pipeline.**

Detection, OCR, map toạ độ, cache, fit chữ, overlay, xử lý ngữ cảnh khi dịch — toàn bộ phần này không quan tâm ảnh đến từ đâu. Thiết kế input thành một interface:

```ts
interface CaptureSource {
  capture(): Promise<{ imageBitmap: ImageBitmap; viewportRect: DOMRect }>;
  onPageChange(cb: () => void): () => void;  // trả về hàm unsubscribe
}
```

Mỗi site là một adapter implement interface này. Lợi ích: một site không lấy được không chặn cả dự án, và bạn test được pipeline bằng file local trước khi động vào site nào.

```
CaptureSource → Detection → Crop → OCR → Translate → Overlay
                (bbox[])    (per bbox)  (batch)     (viewport coords)
```

---

## 2. Capture layer

### Chụp viewport, đừng đọc canvas

`chrome.tabs.captureVisibleTab()` trả về PNG data URL của vùng nhìn thấy.

Lý do kỹ thuật (ngoài chuyện tránh canvas tainting):

- Toạ độ trả về nằm trong **không gian viewport** — đúng hệ toạ độ cần cho overlay.
- Đọc pixel từ canvas thì phải map ngược qua transform của viewer. Ví dụ Magazine Pocket dùng CSS custom property `--ed939b3a: -3600px` để lật trang, cộng scale từ `width: 316.131px`. Chụp viewport bỏ qua toàn bộ khâu này.
- Hoạt động bất kể trang render bằng gì: canvas, img, WebGL.

### Canvas tainting (nếu vẫn đi hướng canvas)

`drawImage()` một ảnh cross-origin không kèm CORS header phù hợp → canvas bị taint, `getImageData()` và `toDataURL()` ném `SecurityError`. Ảnh vẫn hiển thị bình thường, chỉ đọc pixel và export là chết. Cách xử lý duy nhất: proxy ảnh qua backend của mình, set `Referer` phía server, trả lại bytes kèm CORS header riêng → frontend thấy same-origin.

### Khi captureVisibleTab bị chặn

Một số viewer có cơ chế phát hiện mất focus / capture. Magazine Pocket ẩn nội dung và thay bằng div `c-viewer__page__hidden`.

Hướng xử lý trong tài liệu này là **đổi nguồn, không đi vòng qua cơ chế đó** (phần bypass không có ở đây):

| Nguồn | Ưu | Nhược |
|---|---|---|
| File manga tự sở hữu | Kiểm soát resolution, có ground truth để đo accuracy | Không phải reader online |
| Mokuro | Chạy đúng pipeline này, dùng làm baseline so sánh | Cần chuẩn bị file trước |
| Site phát ảnh qua `<img>` | Adapter đơn giản nhất | Phải kiểm tra DOM từng site, đừng giả định |

Ghi chú thực tế: site có lớp bảo vệ kiểu này đổi cơ chế liên tục → phần lớn thời gian sẽ đốt vào sửa adapter thay vì cải thiện OCR/dịch, mà đó mới là thứ quyết định tool dùng được hay không.

---

## 3. Detection — lấy bounding box của bubble

**Tách detection và recognition thành hai bước, đừng dùng một model cho cả hai.**

### PaddleOCR + preset Manga & Comic
Dò mọi vùng chữ trên nguyên trang rồi đọc từng vùng, xử lý cả trang trong một lượt. Đây là thứ trả về toạ độ box. Lựa chọn mặc định cho bước này.

Có bản fine-tune riêng cho manga (`PaddleOCR-VL-For-Manga`, dựa trên PaddleOCR-VL của Baidu) — tác giả báo accuracy tăng đáng kể so với model gốc trên manga, nhưng còn yếu ở phân biệt ký tự full-width / half-width. Cần tự benchmark trước khi tin số liệu.

### VincentQQu / manga_text_bubble_detect_translate
UNet với depthwise + transpose conv, train trên dataset cá nhân + **Manga109**.

Lưu ý từ chính repo: **phần bubble detector chạy tốt, phần OCR thì không** (đặc biệt với tiếng Nhật dọc, vì repo dùng pytesseract). → Lấy detector, bỏ OCR, thay bằng manga-ocr.

Stack: `tensorflow==2.11.0`, `opencv_python_headless`, `numpy`, `Pillow`, `matplotlib`.

### Flood fill (fallback không cần model)
Dựa trên giả định: bubble thường có viền khép kín và nền màu đồng nhất. Chỉ giữ contour trong cùng, flood fill, lấy vùng bên trong.

- Rẻ, nhanh, không cần model.
- Chết với bubble không viền, chữ đè lên tranh, và sound effect nằm ngoài bubble.

### Ghi chú về dataset
Manga109 là dataset tham chiếu chính. Nghiên cứu trong mảng này thường phân biệt text **trong** bubble (dễ) và text **ngoài** bubble / sound effect (khó) — nếu chỉ cần hội thoại thì bỏ qua nhóm khó là hợp lý.

---

## 4. Recognition — đọc chữ trong box

### manga-ocr (kha-white) — lựa chọn chính

- Đọc được text **nhiều dòng trong một lượt forward** → cả bubble xử lý một lần, không cần tách dòng.
- Xử lý được tiếng Nhật dọc (tategaki), ngang, furigana, font stylized — đúng những chỗ OCR đa dụng gãy.
- **Không dùng Tesseract** cho tiếng Nhật dọc.

**Rủi ro cần biết:** manga-ocr dùng transformer decoder có hiểu tiếng Nhật, nên đôi khi nó *chế* ra câu nghe hợp lý. Với công cụ dịch đây là lỗi nguy hiểm vì output vẫn trông đúng.
→ **Luôn hiện text gốc cạnh bản dịch** để đối chiếu được.

### Chạy trong browser
Có bản chạy model manga-ocr trực tiếp trên trình duyệt (không cần Python/CUDA). Quan trọng với extension: tránh round-trip server cho từng bubble.

### Quy tắc chọn model
- Một bubble đã crop / một dòng → **manga-ocr**
- Nguyên trang chưa crop → **PaddleOCR + preset manga** (detect vùng rồi đọc từng vùng)

---

## 5. Overlay

- Render vào **Shadow DOM** → CSS của site không đánh nhau với overlay.
- Div `position: fixed` theo toạ độ viewport. Container `pointer-events: none`, chỉ bật lại ở chỗ chữ.
- **Bắt sự kiện lật trang:** viewer kiểu Magazine Pocket lật trang bằng cách đổi CSS custom property, không phải scroll thường → `MutationObserver` trên attribute `style` của `.c-viewer__pages` đáng tin hơn là listen scroll. Vẫn nên debounce resize.
- **Nở chữ:** Nhật → Việt thường dài ra. Cần auto-shrink font cho vừa box, hoặc chuyển sang kiểu click/hover mới hiện full text.

---

## 6. Cache & performance

- OCR mỗi bubble tốn kém. **Cache theo hash của vùng ảnh đã crop** — không có thì lật qua lật lại là OCR lại từ đầu.
- Cache cả kết quả dịch theo hash của text gốc.

---

## 7. Chất lượng dịch

Gom các bubble trong cùng một panel rồi **dịch theo lô kèm ngữ cảnh**, đừng dịch từng bubble riêng lẻ. Hội thoại manga lược chủ ngữ rất nhiều — dịch lẻ ra câu vô nghĩa.

Thứ tự đọc: manga đọc phải → trái, trên → dưới. Sort bbox theo thứ tự đó trước khi gom lô, nếu không ngữ cảnh sẽ đảo lộn.

---

## 8. Nguồn dữ liệu manga (thảo luận riêng, dùng khi cần dataset)

### MangaDex API
Public, miễn phí. Không dùng canvas — phát ảnh tĩnh qua `<img>`, và API trả thẳng URL nên không cần parse HTML.

Luồng lấy ảnh chapter:

1. `GET https://api.mangadex.org/at-home/server/:chapterId`
2. Response: `baseUrl`, `chapter.hash`, `chapter.data` (chất lượng gốc), `chapter.dataSaver` (nén)
3. Ghép URL: `baseUrl` / `data` hoặc `data-saver` / `hash` / `filename`

Điểm dễ sai:

- `baseUrl` chỉ đảm bảo hiệu lực **15 phút**. Hết hạn thì gọi lại endpoint. **Đừng hardcode** — nó được tối ưu theo vị trí địa lý và có rate limit chặt hơn. Nó là một string, không nhất thiết có dạng domain → dùng nguyên xi.
- **Đừng gửi auth header khi fetch ảnh.** Nếu trúng node bên thứ ba trên `mangadex.network` là lộ token cho người vận hành node.
- Với mỗi ảnh lấy từ `baseUrl` không thuộc `mangadex.org`, phải POST kết quả (thành công *hoặc* thất bại) về `https://api.mangadex.network/report` — trường `url`, `success`, `cached`, `bytes`, `duration`. Đa số script bỏ qua bước này.
- Rate limit tính theo IP.

Điều kiện dùng API: credit nhóm scanlation, tôn trọng yêu cầu gỡ nội dung của họ, không chạy quảng cáo hoặc bán dịch vụ dựa trên nội dung.

### Metadata
AniList (GraphQL) hoặc Jikan — tên, cover, mô tả, thể loại, số chapter. Miễn phí, không cần key.

---

## 9. Điểm yếu lớn nhất hiện tại

Không phải khâu lấy ảnh, mà là **accuracy của detection + OCR + chất lượng dịch**. Ưu tiên:

1. Dựng bộ test có ground truth (dùng file tự sở hữu) để đo được detection recall/precision.
2. So baseline với Mokuro.
3. Chỉ khi pipeline đã ổn mới đi rộng ra nhiều adapter.

---

## Không có trong tài liệu này

Phần đi vòng qua cơ chế chống capture của Magazine Pocket — mình không viết phần đó, nên nó không nằm ở đây. Mục 2 xử lý tình huống bằng cách đổi nguồn.
