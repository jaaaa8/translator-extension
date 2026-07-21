# MangaTranslator — Thiết kế hệ thống dịch & overlay truyện tranh trên browser

**Ngày:** 2026-07-21
**Trạng thái:** Đã duyệt thiết kế, chờ lập kế hoạch triển khai

## Mục tiêu

Dịch tự động trang truyện tranh (manga/manhua/webtoon) ngay khi đang đọc trên browser: phát hiện bóng thoại trong ảnh, OCR, dịch, và overlay chữ dịch đè đúng vị trí bóng thoại trên trang web.

## Phạm vi đã chốt

- **Ngôn ngữ nguồn:** Nhật (`ja`), Tây Ban Nha (`es`) — kiến trúc mở để thêm nguồn sau.
- **Ngôn ngữ đích:** Việt (`vi`), Anh (`en`) — cùng một engine dịch, chỉ là tham số.
- **Người dùng chọn tay** ngôn ngữ nguồn và đích qua popup extension (không auto-detect ở v1).
- **Kích hoạt:** nút **"Dịch trang này"** trong popup — dịch các ảnh đã load tại thời điểm bấm; cuộn thêm rồi bấm lại để dịch tiếp. *(Đổi từ chế độ tự động IntersectionObserver sau khi chạy thật: free tier Gemini giới hạn request/phút rất thấp, tự động theo cuộn bắn quá nhiều call → 429.)*
- **Engine dịch:** Gemini API (online), gom toàn bộ thoại của **mọi ảnh trong một lần bấm** vào đúng **một** request — vừa giữ ngữ cảnh vừa không chạm rate limit.
- **Sản phẩm cá nhân, chạy local:** không đóng gói installer, không publish store; extension load unpacked, server chạy bằng script.
- **Phần cứng:** NVIDIA RTX 3050 4GB VRAM, CUDA — đủ cho các model đã chọn (~1GB VRAM tổng); fallback CPU nếu CUDA lỗi.

**Ngoài scope v1** (thêm sau không đổi kiến trúc): inpainting/LaMa quality mode, auto-detect ngôn ngữ nguồn, WebSocket streaming, lấy màu nền bubble từ ảnh, engine dịch thứ hai, đóng gói installer, Firefox.

## Kiến trúc tổng thể

Hai tiến trình độc lập, giao tiếp qua REST trên localhost:

```
┌─ Trang web truyện ──────────────────────────────┐
│  content script                                  │
│  • tìm ảnh truyện + IntersectionObserver         │
│  • vẽ/đồng bộ div overlay                        │
└────────────┬────────────────────▲────────────────┘
             │ (ảnh cần dịch)     │ (JSON blocks)
┌────────────▼────────────────────┴────────────────┐
│  background service worker                       │
│  • fetch bytes ảnh (tránh CORS taint)            │
│  • POST → localhost, cache theo url+src+dst      │
└────────────┬────────────────────▲────────────────┘
             │ REST multipart     │ JSON
┌────────────▼────────────────────┴────────────────┐
│  FastAPI server (localhost:8910, load model 1 lần)│
│  detect (comic-text-detector, CUDA)              │
│   → OCR (registry: ja=manga-ocr, es=PaddleOCR)   │
│   → translate (Gemini, gom cả trang 1 request)   │
└──────────────────────────────────────────────────┘
```

**Lý do chọn REST** (thay vì WebSocket / Native Messaging): payload là ảnh + JSON theo kiểu request/response, stateless, dễ test bằng curl; extension MV3 khai báo `host_permissions` cho `http://127.0.0.1:*/*` nên không dính CORS. WebSocket chỉ thêm khi cần streaming kết quả từng bubble. Native Messaging bị giới hạn 1MB/message chiều native→extension, không hợp truyền ảnh.

**Lý do tự ghép pipeline** (thay vì wrap manga-image-translator): output cần là JSON tọa độ cho div overlay chứ không phải ảnh render lại; OCR tiếng Tây Ban Nha và việc mở rộng ngôn ngữ cần kiểm soát riêng. Vẫn tái sử dụng model của cộng đồng (comic-text-detector, manga-ocr).

## Cấu trúc thư mục

```
MangaTranslator/
├─ server/
│  ├─ main.py          # FastAPI app + endpoints
│  ├─ pipeline.py      # detect → ocr → translate
│  ├─ detector.py      # wrap comic-text-detector
│  ├─ ocr.py           # registry {"ja": MangaOcr, "es": PaddleLatin}
│  ├─ translator.py    # translate(texts, src, dst) → Gemini
│  ├─ config.py        # đọc .env: GEMINI_API_KEY, PORT, DEVICE
│  └─ tests/
└─ extension/
   ├─ manifest.json    # MV3
   ├─ background.js
   ├─ content.js
   ├─ overlay.css
   └─ popup.html + popup.js
```

## Extension (Chrome MV3)

### Luồng xử lý một lần bấm "Dịch trang này"

1. Popup gửi `translatePage` cho content script của tab hiện tại.
2. Content script gom mọi `<img>` đã load có `naturalWidth/Height ≥ 400` (lọc banner/avatar/icon) và chưa dịch xong.
3. Với từng ảnh: background fetch bytes → POST `/ocr` (thuần local, giới hạn **2 request đồng thời**, cache theo `url + srcLang`).
4. Gom toàn bộ `src_text` của mọi ảnh → **một** POST `/translate-texts` (= 1 call Gemini duy nhất).
5. Phân phối bản dịch về từng block, vẽ overlay.
6. Ảnh OCR lỗi **không** bị đánh dấu đã xử lý — bấm nút lần nữa sẽ thử lại; ảnh thành công thì bỏ qua ở lần sau. Công tắc bật/tắt chỉ ẩn/hiện overlay, không tốn call dịch lại.

### Overlay — định vị theo tọa độ tài liệu

- Mỗi block là một `div` absolute trong container gắn vào `document.body` — không đụng DOM quanh ảnh gốc, không phá layout trang.
- **Định vị theo document coordinates** (`top = vị_trí_ảnh + scrollY` tại thời điểm vẽ): overlay là phần tử "trong trang" nên trình duyệt tự cuộn nó cùng ảnh — chữ dính chặt vào bóng thoại khi cuộn, không cần scroll listener, không trễ nhịp.
- Chỉ reposition khi layout thay đổi thật: resize cửa sổ, zoom, trang chèn nội dung làm ảnh xê dịch — bắt bằng `ResizeObserver` trên ảnh và trên body.
- Scale tọa độ: bbox server trả theo pixel ảnh gốc; nhân với `img.getBoundingClientRect().width / img.naturalWidth`.
- Style bubble: nền trắng, bo góc, chữ đen, `font-size` auto-fit giảm dần đến khi vừa khung (sàn 10px). Chữ dọc tiếng Nhật dịch ra vẫn render ngang, dựa vào auto-fit.

### Popup

- Nút **"Dịch trang này"** + dòng kết quả ("xong: n ảnh, m thoại" / lỗi).
- Công tắc ẩn/hiện overlay.
- Dropdown ngôn ngữ nguồn (Nhật / Tây Ban Nha) và ngôn ngữ đích (Việt / Anh) — lưu lựa chọn vào `chrome.storage`.
- Đèn trạng thái server (gọi `/health`).

## Server (Python + FastAPI)

- Chạy `run_server.bat` / `python -m server`; load cả 3 model một lần lúc khởi động lên CUDA, fallback CPU kèm cảnh báo.
- **Pipeline mỗi ảnh:**
  1. `detector.py` — comic-text-detector trả text block (bbox + hướng chữ). Dùng chung mọi ngôn ngữ.
  2. `ocr.py` — registry tra theo `src_lang`, crop từng block đưa vào engine tương ứng. Thêm ngôn ngữ mới = thêm một entry + một class engine.
  3. `translator.py` — gom toàn bộ text của trang thành mảng đánh số, một request Gemini (model flash), prompt: "thoại truyện tranh, dịch tự nhiên, giữ xưng hô nhất quán", yêu cầu trả JSON array đúng số phần tử, temperature thấp. Lệch số phần tử → retry 1 lần → vẫn lỗi thì trả lỗi cho ảnh đó.
- Ngôn ngữ đích không hard-code danh sách phía server — là tham số truyền thẳng vào prompt.

## API contract

```
GET  /health
→ 200 {status:"ok", device:"cuda", langs:["ja","es"]}

POST /ocr  (multipart: image=bytes, src_lang="ja"|"es")   ← extension dùng, thuần local
→ 200 {image_w, image_h, blocks:[{bbox:[x,y,w,h], src_text}]}
→ 422 sai tham số | 500 {error}

POST /translate-texts  (JSON: {texts:[...], src_lang, target_lang})   ← 1 call Gemini/lần bấm
→ 200 {translations:[...]}  (cùng độ dài, cùng thứ tự texts)
→ 502 {error:"gemini: ..."}

POST /translate  (multipart: image=bytes, src_lang, target_lang)   ← giữ cho smoke test 1 ảnh
→ 200 {image_w, image_h, blocks:[{bbox, src_text, trans_text}]}
→ 422 | 502 | 500
```

## Xử lý lỗi

| Tình huống | Hành vi |
|---|---|
| Server chưa bật | Badge đỏ trên icon extension, popup báo "Server offline"; thăm dò lại `/health` mỗi 10s |
| Fetch ảnh thất bại (site chặn hotlink) | Bỏ qua ảnh đó, log console (fallback fetch trong page context là nâng cấp v2) |
| Không phát hiện text | `blocks: []` → đánh dấu ảnh đã xử lý, không gửi lại |
| Gemini lỗi/hết quota | Server trả 502; extension retry 1 lần sau 3s rồi hiện badge cảnh báo |
| Request quá lâu | Timeout phía extension 60s/ảnh |

## Testing

- **Server:** `pytest` với 2 ảnh fixture (1 trang manga Nhật, 1 trang tiếng Tây Ban Nha): detect ra block, OCR ra đúng chữ mẫu. Gemini được mock trong test pipeline; 1 integration test gọi Gemini thật chạy tay khi muốn.
- **Extension:** trang HTML fixture local chứa ảnh mẫu để kiểm tra overlay (vị trí, scale, cuộn trang); kiểm thử thủ công trên 2 site đọc truyện thật.
- **Smoke test:** script curl bắn ảnh mẫu vào `/translate`, in blocks.
