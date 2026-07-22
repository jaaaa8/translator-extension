# Thiết kế: Hỗ trợ 2 bố cục đọc (webtoon dọc + reader ngang) bằng nút thống nhất

Ngày: 2026-07-23 · Nhánh: `feat/v1` · Thread A (log.txt ý 1–2, ƯU TIÊN) · Tiếp nối: `2026-07-21-manga-translator-design.md`

## Bối cảnh & vấn đề

Web đọc truyện có 2 kiểu bố cục:
- **Webtoon (dọc):** nhiều trang xếp dọc, cuộn liên tục (hoặc 1 ảnh strip rất cao).
- **Reader (ngang):** từng trang một, lật qua lại, thường full-viewport.

Kiến trúc hiện tại (`content.js`) đã định vị overlay **per-`<img>` theo tọa độ tài liệu** (`getBoundingClientRect + scrollY`, `ResizeObserver`) và nút "Dịch trang này" đã **OCR mọi ảnh đã load rồi gom 1 call Gemini**. Nên phần định vị + batch **vốn dùng chung được cho cả 2 bố cục**. Hai chỗ hỏng với reader:

1. **`done` theo element identity** (`WeakSet<img>`): reader lật trang thường **đổi `src` trên cùng element** → ảnh vẫn nằm trong `done` → trang mới không bao giờ được dịch.
2. **Overlay không reset khi lật trang:** overlay trang cũ (tọa độ + chữ Việt cũ) lơ lửng đè lên trang mới cho tới khi bị thay.

## Quyết định thiết kế

**Một nút thống nhất, KHÔNG chế độ** (đã chốt với user). Không heuristic đoán bố cục, không công tắc popup. Giữ **thủ công** (không auto-translate) đúng ý log. Cùng một hành vi phục vụ cả hai: webtoon bấm 1 lần (hoặc vài lần khi cuộn nạp thêm ảnh); reader bấm mỗi trang.

## Thành phần

### 1. `done` nhận biết theo nguồn (`content.js`)

Thay `done: WeakSet<img>` bằng `translated: WeakMap<img, string>` — map ảnh → URL nguồn đã dịch (`bestSource(img)`, xem spec thread B nếu đã có; nếu chưa, dùng `img.currentSrc || img.src`).

Ảnh đủ điều kiện dịch khi `translated.get(img) !== bestSource(img)`:
- Webtoon: ảnh mới cuộn vào chưa có trong map → dịch.
- Reader: src mới sau khi lật ≠ src đã dịch → dịch lại.

Ảnh dịch xong ghi `translated.set(img, bestSource(img))`. Ảnh OCR lỗi **không** ghi (để lần bấm sau thử lại) — giữ nguyên hành vi hiện tại.

### 2. `translateVisible()` (mở rộng `translatePage` hiện có)

Lọc ảnh: `img.complete && eligible(img) && translated.get(img) !== bestSource(img)`. Phần còn lại y hệt hiện tại: gửi `ocrImage` (background giới hạn 2 đồng thời) → gom text → **1 call Gemini** `translateTexts` → `renderOverlay` từng ảnh → ghi `translated`.

Thông điệp popup/nút đổi nhãn thành "Dịch những gì đang thấy" (mô tả đúng hành vi cả 2 bố cục). Không đổi luồng background.

### 3. Xóa overlay cũ khi lật trang / ảnh rời DOM (`content.js`)

`MutationObserver` trên `document.body`:
- `attributes` với `attributeFilter: ["src"]` trên subtree: khi một ảnh **đang có overlay** đổi `src` → gỡ `overlay.container`, xóa khỏi `overlays`, xóa `translated` cho ảnh đó (để bấm nút dịch lại).
- `childList` (subtree): khi một ảnh đang có overlay **bị gỡ khỏi DOM** → gỡ overlay tương ứng.

Nhờ vậy chữ trang cũ biến mất tức thì lúc lật trang; user bấm nút để dịch trang mới. Đây là cơ chế khiến reader không cần chế độ riêng.

### 4. Định vị — giữ nguyên

`position()` (tọa độ tài liệu + `ResizeObserver` trên img và `documentElement`) không đổi. `renderOverlay` đã xóa container cũ trước khi vẽ nên retranslate cùng ảnh sạch sẽ.

## Luồng dữ liệu

```
User bấm nút
  → translateVisible(): lọc ảnh (bestSource khác lần trước)
  → /ocr mỗi ảnh (local) → gom text → 1 call /translate-texts (Gemini)
  → renderOverlay + translated.set(img, bestSource)

Lật trang (src đổi) / ảnh rời DOM
  → MutationObserver: gỡ overlay cũ + xóa translated cho ảnh đó
  → (chờ user bấm nút cho trang mới)
```

## Xử lý lỗi

- Ảnh OCR fail: không ghi `translated` → lần bấm sau thử lại (như hiện tại). Badge `!` đỏ khi server lỗi (background sẵn có).
- MutationObserver chỉ thao tác trên ảnh **đang có trong `overlays`** → không đụng ảnh chưa dịch, không sinh việc thừa khi trang thay đổi DOM ồ ạt (webtoon lazy-load).

## Kiểm thử

- Unit (node self-check, không framework — khớp thói quen dự án): hàm lọc ảnh đủ-điều-kiện tách riêng, testable: ảnh có `translated` khớp `bestSource` → loại; src đổi → nhận lại; ảnh mới → nhận.
- Kiểm chứng tay:
  - **Webtoon** (1 site cuộn dọc): bấm nút → các trang đã load có overlay; cuộn thêm → bấm lại → trang mới có overlay, trang cũ không dịch lại.
  - **Reader** (1 site lật ngang): bấm → trang hiện tại có overlay; lật trang → overlay cũ **biến mất ngay**; bấm → trang mới có overlay đúng vị trí; lật về trang cũ → bấm → dịch lại đúng.

## Ngoài phạm vi (backlog)

- **Fullscreen API thật:** element `requestFullscreen` → overlay gắn `document.body` không hiện trong lớp fullscreen. Chỉ xử khi gặp reader thật dùng Fullscreen API (gắn overlay vào `document.fullscreenElement`). YAGNI hiện tại.
- Auto-translate / auto-scroll ép webtoon load (giữ thủ công theo log).
- Đa luồng scan/dịch/ghi theo chu kỳ 5 trang (log ý #scan) — kiến trúc hiện tại không "ghi đè file", chi phí thật là OCR + Gemini; batch 1-call hiện tại đã đủ, chưa cần pipeline đa luồng.
- Chữ ngoài bóng thoại + inpaint (thread C), Hàn/Trung (thread D).

## Phụ thuộc

Dùng `bestSource(img)` từ thread B (`2026-07-23-in-bubble-ocr-recall`). Nếu thread B chưa triển khai khi làm thread A, tạm dùng `img.currentSrc || img.src`; khi thread B xong thì thay bằng `bestSource` (một chỗ). Hai thread độc lập, thứ tự nào trước cũng được.
