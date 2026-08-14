---
title: "In-bubble OCR recall"
note_type: worklog
work_item: in-bubble-ocr-recall
date_start: 2026-07-23
date_end: 2026-07-28
status: done
versions:
  - "[[feat-v1]]"
specs:
  - "[[2026-07-23-in-bubble-ocr-recall-design]]"
plans:
  - "[[2026-07-23-in-bubble-ocr-recall]]"
artifacts: []
tags:
  - mangatranslator/worklog
---

# In-bubble OCR recall

> [!summary] Tóm tắt
> **Vấn đề:** OCR thật bỏ sót chữ trong bubble và chưa tách rõ lỗi detector B2 với recognizer B3.
>
> **Quyết định/fix:** Thêm chẩn đoán B2/B3, full-resolution crop, padding và upscale có kiểm soát.
>
> **Kết quả:** Recall OCR được cải thiện và Thread B đóng với bằng chứng lịch sử được giữ nguyên.

## Liên kết

- Phiên bản: [[feat-v1]]
- Spec: [[2026-07-23-in-bubble-ocr-recall-design]]
- Plan: [[2026-07-23-in-bubble-ocr-recall]]
- Artifact: Không có.

---
## Phiên brainstorm v2 + chẩn đoán bug thật (2026-07-23)

> [!info] Bối cảnh
> Đọc `log.txt` (ý tưởng mới cho v2) và brainstorm theo skill. **Chưa động vào code** — phiên này là định hướng + chẩn đoán bug thật trên site thật, để chốt việc làm trước cho v2.

### Hai reframe quan trọng (log.txt hiểu lệch kiến trúc hiện tại)

- **"Scan theo HTML hay theo màn hình?" → Không cái nào.** Hiện scan theo **pixel của từng `<img>`**: `comic-text-detector` (model thị giác) chạy server-side trên điểm ảnh → **vốn đã HTML-agnostic, chạy mọi web** miễn nội dung nằm trong `<img>` ≥400px đã load. Điểm mù thật: site render trang bằng `<canvas>` / CSS background / `<iframe>` / div ghép (không phải `<img>`).
- **"Ghi đè file là nặng nhất" → Không hề ghi đè file.** Chỉ phủ `<div>` trong suốt (rất rẻ). Hai chi phí thật: OCR cục bộ (2 ảnh song song) + **1 call Gemini mỗi lần bấm** (chỗ dính 429). Pipeline nên tối ưu quanh Gemini + OCR, không phải "ghi đè".

### Phân rã log.txt thành các hướng (theo ưu tiên user)

| Hướng | Nội dung | Ưu tiên |
|---|---|---|
| **A** | Hai chế độ bố cục: dọc nhiều trang (webtoon) + ngang từng trang (manga reader) | ƯU TIÊN |
| **B** | Độ chính xác scan/OCR chữ **trong** bóng thoại | **Làm TRƯỚC** (user chọn) |
| C | Chữ **ngoài** bóng thoại + viền mỏng/inpaint | Không ưu tiên (phụ thuộc B) |
| D | Thêm Hàn/Trung | Không ưu tiên (chỉ thêm 1 entry vào OCR registry) |

→ **Đã chốt: brainstorm thread B trước.**

### Mô hình phân tầng lỗi cho thread B

`B0 trigger → B1 capture ảnh → B2 detect bóng → B3 OCR → B4 call Gemini → B5 phủ div`

Nguyên tắc: **sửa từ tầng thấp nhất đang hỏng** — vô nghĩa khi tinh chỉnh detector (B2) nếu ảnh chưa bao giờ tới được detector.

### Phân bố triệu chứng (user test thật)

- **40%** — cùng 1 trang, bóng dịch được / bóng không → **B2/B3 recall**
- **30%** — cả trang không ra gì → phần lớn là **B0/B1** (chưa tới được server)
- **30%** — bóng trống, không overlay → B2/B3
- Gần như **mọi thoại NGOÀI bóng** đều không có overlay (đúng dự kiến — đang xử in-bubble trước)

### Hai bug thật đã khoanh vùng

> [!bug] Bug 1 — MangaDex `TypeError: Failed to fetch` (tầng B1 capture)
> `background.js` gọi `fetch(imageURL)` để tải LẠI ảnh → fail ở tầng mạng (khác hẳn `HTTP 403`). Ảnh MangaDex nằm sau **Cloudflare + URL có token**; SW fetch lại bằng request mới → **mất ngữ cảnh phiên của trang** (cookie clearance, referer, token) → bị chặn.
> **Gốc rễ kiến trúc:** fetch lại URL ảnh từ background là mong manh — trình duyệt đã có sẵn pixel trong `<img>`.
> **Hướng sửa:** lấy pixel thẳng từ `<img>` đã load bằng `<canvas>.toBlob()` trong content script, bỏ hẳn cú fetch thứ 2. **Cạm bẫy:** ảnh cross-origin không CORS → canvas bị taint, `toBlob` ném SecurityError → cần dự phòng (`chrome.tabs.captureVisibleTab`, hoặc rule DNR chèn referer).

> [!bug] Bug 2 — s-manga.net: bóng dịch được / bóng không (tầng B2/B3 recall)
> Đây mới là **"dịch đủ chữ trong bóng thoại"** cần xử trước, và xảy ra trên site mà capture ĐÃ chạy tốt → ca sạch để mổ. Nguyên nhân server-side: `comic-text-detector` bỏ sót vùng, hoặc OCR trả rỗng → block bị loại (`if not text: continue` trong `pipeline.py`).
> **Điều tra tiếp:** chạy 1 trang thật qua pipeline, vẽ bbox detect được để thấy chính xác bóng nào bị sót.

### Ghi chú site

- **MangaDex** — Cloudflare + CDN token (`mangadex.network`). Capture qua re-fetch = fail. Reader kiểu cuộn.
- **s-manga.net** (Nhật) — load **từng trang một** (reader ngang). Capture OK, nhưng bug recall hiện diện.

### Phát hiện phụ (đáng vá khi làm B0/B1)

- `manifest.json` **thiếu `"all_frames": true`** → reader nhét ảnh trong `<iframe>` thì content script (chỉ chạy frame top) không thấy ảnh nào.
- **Bẫy dev:** reload extension ở `chrome://extensions` → tab đang mở mất content script → nút báo "không kết nối được trang", phải **F5** trang.
- **Lỗ hổng quan sát:** fetch ảnh fail bị nuốt lặng (chỉ `console.warn`, không bật badge) → không phân biệt được "0 ảnh vì không phải `<img>`" với "0 ảnh vì bị chặn". Nên bật badge + đếm rõ trong dòng kết quả popup.

> [!warning] MCP browser KHÔNG dùng được phiên này
> Bộ `chrome-devtools` MCP có trong danh sách nhưng **không kết nối** (thử 4 kiểu search đều rỗng) → Claude không lái được trình duyệt từ đây. Muốn Claude tự soi site thì cần bật MCP server chrome-devtools.

### Sẵn sàng cho bước điều tra server-side

- Weights có sẵn: `server/models/comictextdetector.pt` (76MB) ✅ · vendor `comic_text_detector` ✅ · `.env` `GEMINI_MODEL=gemini-flash-lite-latest`
- **Bước tiếp đề xuất:** user lưu 1 trang thật từ s-manga (chuột phải ảnh → Save) → Claude chạy detector local, vẽ bbox, chỉ ra bóng bị sót → quyết B2 (đổi/tinh chỉnh detector) hay B3 (OCR).

### Backlog rút ra cho v2

- [ ] **Capture bền vững (B1):** canvas-from-`<img>` + dự phòng `captureVisibleTab`/DNR-referer — sửa cả MangaDex lẫn mọi site chặn hotlink
- [ ] **Recall in-bubble (B2/B3):** điều tra bằng trang thật, quyết hướng nâng detect/OCR
- [ ] `manifest.json`: thêm `all_frames: true`
- [ ] Quan sát: bật badge + đếm rõ khi capture fail
- [ ] (sau) Bố cục A · chữ ngoài bóng + inpaint C · Hàn/Trung D

## Phiên thiết kế thread B + A (2026-07-23, tiếp) — brainstorm → spec → plan

> [!info] Phạm vi phiên
> Brainstorm theo skill, ra **spec + plan cho thread B** và **spec cho thread A**. **Chưa động code** — mới là thiết kế. Có chẩn đoán thật path Latin nhờ ảnh user cung cấp.

### Thread B — recall/độ chính xác OCR bóng thoại (path Latin)

> [!success] Spec + Plan đã viết & commit
> Spec: `docs/superpowers/specs/2026-07-23-in-bubble-ocr-recall-design.md`
> Plan: `docs/superpowers/plans/2026-07-23-in-bubble-ocr-recall.md`

**Chẩn đoán từ trang thật** (`server/vendor/comic_text_detector/data/examples/mangadex.jpeg` + 2 bản overlay user gửi — thoại Bồ Đào Nha):
- **Lỗi 1 (chính, phụ thuộc độ phân giải):** `background.js:49` fetch `img.currentSrc` → khi web hiển thị ảnh nhỏ, trình duyệt chọn biến thể `srcset` **nhỏ** → OCR nhận pixel thấp → PaddleOCR vỡ chữ. Bản full-res đọc gần đúng hết ⇒ xác nhận thủ phạm.
- **Lỗi 2 (dai dẳng, KHÔNG phụ thuộc độ phân giải):** 3 bóng sạch vẫn không overlay ("POR FAVOR...", "SIM... EU NÃO VOU...", "EU ME PREOCUPO..."). Là B2 (detector sót) hay B3 (PaddleOCR rỗng) — **chưa xác định, cần diagnostic**.

**Phát hiện code:** `Detector` dùng default vendor `conf_thresh=0.4`, `input_size=1024` (2 knob recall). `keep_undetected_mask` vô dụng (chỉ sửa mask, ta dùng bbox). Vendor `group_output` **vứt conf YOLO** → không lấy conf per-box mà không sửa vendor.

**Plan 4 task:** (1) `diagnose.py` vẽ bbox xanh/đỏ tách B2/B3 + knob `conf`/`input_size` qua constructor → **decision gate chạy thật trên mangadex.jpeg**; (2) `srcset.js` chọn nguồn full-res thay `currentSrc`; (3) pad+upscale crop trong `pipeline.py`; (4) **CÓ ĐIỀU KIỆN** — knob `.env` chỉ làm nếu gate kết luận B2. Escalation B3 sâu hơn (bỏ `if not text`, Gemini multimodal) để ngỏ.


> [!link] Thread A
> Phần hành động theo bố cục được lưu tại [[2026-07-23-layout-translation-actions-worklog#Thread A — hành động dịch theo bố cục hoàn tất trên v2 ✅ (2026-07-28)|worklog layout translation actions]].

### Việc còn lại sau phiên này

- [ ] User review 2 spec (B đã có plan; A chưa) → sửa nếu cần
- [ ] Thread B: chạy `diagnose.py` trên mangadex.jpeg (decision gate B2 vs B3) → mới quyết Task 4

- [ ] Triển khai code (chưa bắt đầu)

## Task 1 — Chẩn đoán B2/B3 + knob detector ✅ (2026-07-28)

- Thêm `server/diagnose.py`: vẽ bbox xanh khi OCR có chữ, đỏ khi OCR rỗng; xuất `.diag.png` và `.diag.txt` để tách B2 (detector không có ô) với B3 (có ô đỏ).
- `Detector(device="cuda", conf_thresh=None, input_size=None)` truyền knob tùy chọn; `None` giữ nguyên default vendor `conf_thresh=0.4`, `input_size=1024`.
- Chạy: `python -m server.diagnose server/vendor/comic_text_detector/data/examples/mangadex.jpeg --lang es` → **13 block, 4 rỗng**. (PowerShell cần `PYTHONIOENCODING=utf-8` để in dòng kết quả tiếng Việt.)
- **Kết luận gate: B3, bỏ Task 4.** Cả ba bóng cần xét đều có bbox đỏ/OCR rỗng trên ảnh diagnostic: #3 “POR FAVOR...”, #7/#8 “SIM... EU NÃO VOU...”, #11 “EU ME PREOCUPO...”. Detector đã bắt được bóng; lỗi ở OCR/crop, không phải recall B2, nên không thử/không thêm knob `.env`.

## Thread B — recall OCR hoàn tất ✅ (2026-07-28)

- [x] Chọn ảnh full-res từ `srcset` thay vì phụ thuộc `currentSrc`.
- [x] Pad + upscale crop trước OCR để giữ nét chữ nhỏ sát mép bóng.
- [x] Decision gate: bỏ Task 4 vì detector đã bắt đủ bbox.
- [x] Tự động: `pytest` **30 passed**; kiểm tra Node **pass**.
- [x] Diagnostic: **13 block, 0 OCR rỗng** (trước: 13/4).
- [x] Kiểm thử tay trên browser: **PASS** — toàn bộ box và text hoạt động đúng; không còn chữ không nhận diện.

> [!success] Plan hoàn tất
> `2026-07-23-in-bubble-ocr-recall.md` không còn workload mở; các backlog khác giữ nguyên.

