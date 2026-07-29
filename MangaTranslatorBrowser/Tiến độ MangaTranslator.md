---
title: Tiến độ MangaTranslator
date: 2026-07-21
tags:
  - mangatranslator
  - tien-do
status: in-progress
---

# Tiến độ MangaTranslator

Dự án dịch truyện tranh trên browser: Extension Chrome MV3 + FastAPI local server.
Spec: `docs/superpowers/specs/2026-07-21-manga-translator-design.md` · Plan: `docs/superpowers/plans/2026-07-21-manga-translator.md` · Nhánh: `feat/v1`

## Danh sách task

- [x] Task 1 — Khung server + `/health` + môi trường
- [x] Task 2 — Fixture ảnh + vendor comic-text-detector + `detector.py`
- [x] Task 3 — OCR registry (`ja` = manga-ocr, `es` = PaddleOCR)
- [x] Task 4 — `translator.py` (Gemini, gom cả trang, retry 1 lần)
- [x] Task 5 — `pipeline.py` + `POST /translate` + smoke script
- [x] Task 6 — Extension: manifest + popup + background ✅ đã kiểm tra tay
- [x] Task 7 — Extension: content script + overlay ✅ đã kiểm tra tay (bản redesign nút bấm)
- [ ] Task 8 — E2E trên site thật + README ← **việc còn lại duy nhất**

## Task 1 — Khung server ✅ (2026-07-21)

> [!success] Commit `e659570` — feat: server skeleton with /health endpoint
> Test: `1 passed` (`server/tests/test_health.py`)

- venv Python **3.12.13** (không dùng 3.14 mặc định — paddle chưa chắc có wheel)
- torch **2.5.1+cu121**, `torch.cuda.is_available() == True` (RTX 3050)
- Cài torch CUDA *trước* requirements để manga-ocr không kéo bản CPU đè lên
- Files: `server/config.py` (đọc `.env`), `server/main.py` (`GET /health` → `{status, device, langs:["ja","es"]}`), `run_server.bat`, `.env.example`, `.gitignore`

> [!note] Sự cố ngoài lề đã xử lý
> Hook `rtk hook claude` trong `~/.claude/settings.json` báo `command not found` mỗi lệnh Bash (rtk chưa cài) → đã gỡ hook, ghi memory `rtk-hook-removed`.

## Task 2 — Detector ✅ (2026-07-21)

> [!success] Commit — feat: text detection via vendored comic-text-detector
> Test: `2 passed` (`server/tests/test_detector.py`) — detect được cả 2 fixture tổng hợp, đúng vị trí bóng thoại

- Repo vendor tên thật là `dmMaze/comic-text-detector` (**gạch ngang**, plan ghi nhầm gạch dưới)
- Weights `comictextdetector.pt` (76MB) tải trực tiếp từ release `zyddnys/manga-image-translator@beta-0.2.1` — không cần Google Drive
- API vendor khớp plan: `TextDetector(model_path, device)` → `(mask, mask_refined, blk_list)`, blk có `.xyxy`/`.vertical`
- Vá tương thích trong `server/detector.py` (không sửa code vendor):
	- stub `wandb` + `torchsummary` (import chỉ dùng khi training)
	- shim alias NumPy 2.x đã gỡ: `np.bool8`, `np.float_`, `np.int_`
	- cài thêm `torchvision 0.20.1+cu121` (dep inference thật của YOLOv5 NMS)
- Fixture: `server/tests/make_fixtures.py` sinh `ja_page.png` (chữ dọc MS Gothic) + `es_page.png` (Arial Bold) — đã commit cả PNG

## Task 3 — OCR registry ✅ (2026-07-21)

> [!success] Commit — feat: OCR registry with manga-ocr (ja) and PaddleOCR (es)
> Test: `3 passed` riêng + `6 passed` toàn suite (không hỏng detector)

- `server/ocr.py`: registry `ENGINES = {"ja": MangaOcrEngine, "es": PaddleLatinEngine}` — thêm ngôn ngữ = thêm 1 entry
- **Nâng torch 2.5.1+cu121 → 2.6.0+cu124**: transformers mới chặn `torch.load` với torch <2.6 (CVE-2025-32434); driver 581.95/CUDA 13.0 chạy cu124 thoải mái, `cuda: True` sau nâng cấp
- **PaddleOCR 3.x đổi API** so với plan: `show_log`/`use_angle_cls` bị gỡ → dùng `predict()` + `rec_texts`; tắt `use_doc_orientation_classify`/`use_doc_unwarping`/`use_textline_orientation` (crop bóng thoại luôn thẳng)
- **Bug paddlepaddle 3.x Windows CPU**: `NotImplementedError ... onednn_instruction` khi predict → fix bằng `enable_mkldnn=False`
- OCR đọc đúng cả 2 fixture: `こんにちは世界` (dọc) và `Hola amigo`

## Task 4 — Gemini translator ✅ (2026-07-21)

> [!success] Commit — feat: Gemini translator with whole-page batching and one retry
> Test: `6 passed` (mock toàn bộ, không tốn quota) — pass ngay lần đầu, không lệch plan

- `server/translator.py`: `translate(texts, src, dst)` — gom mọi bubble của trang vào **một** request Gemini (giữ ngữ cảnh xưng hô), `response_mime_type: application/json`, temperature 0.2
- Retry 1 lần khi JSON lệch số phần tử; hết 2 lần → `TranslateError` (endpoint sẽ map thành HTTP 502)
- Ngôn ngữ đích là tham số prompt, không hard-code — thêm đích mới không cần sửa code

## Task 5 — Pipeline + `/translate` ✅ (2026-07-21)

> [!success] Commit — feat: full /translate pipeline (detect -> ocr -> gemini)
> Test: `19 passed` toàn suite + smoke test THẬT pass cả 2 nhánh

- Smoke thật qua Gemini: `こんにちは世界` → **"Chào thế giới"**, `Hola amigo` → **"Chào anh bạn."** — server sống end-to-end trên `localhost:8910`
- Bug thật bắt được nhờ TDD: detector trả bbox chạm/vượt biên ảnh → crop rỗng → cv2 nổ; fix gốc bằng clamp bbox trong `pipeline.py`
- **Đổi model Gemini 2 lần** (ghi nhớ cho sau):
	- `gemini-2.5-flash` → 404 "no longer available to new users"
	- `gemini-flash-latest` → 503 quá tải liên tục; `gemini-2.0-flash` → 429 hết quota free
	- Chốt **`gemini-3-flash-preview`** — hoạt động ổn với key hiện tại (đặt trong `.env`, đổi lúc nào cũng được)
- `main.py`: `/translate` là sync def (threadpool, không chặn `/health`), lifespan preload model, lỗi map 422/502/500 đúng spec

## Task 6 — Extension scaffold ✅ (2026-07-21)

> [!success] Commit — feat: extension scaffold - manifest, popup, background queue/cache
> Syntax check: `node --check` OK, manifest JSON hợp lệ. Kiểm tra tay theo checklist bên dưới.

- `manifest.json` MV3: `host_permissions <all_urls>` (gọi localhost không dính CORS + fetch ảnh CDN)
- `background.js`: hàng đợi tối đa **2 request đồng thời**, cache `url|src|dst`, timeout 60s, retry 1 lần sau 3s, badge `!` đỏ khi server lỗi
- `popup.html/js`: công tắc bật/tắt + dropdown nguồn (ja/es) + đích (vi/en) lưu `chrome.storage.local`, đèn trạng thái server
- Lệch spec có chủ đích: bỏ polling `/health` 10s (MV3 service worker ngủ) → badge khi lỗi + popup check mỗi lần mở

> [!todo] Checklist kiểm tra tay (làm khi tiện)
> 1. `chrome://extensions` → bật Developer mode → Load unpacked → chọn thư mục `extension/`
> 2. Server đang chạy → popup phải hiện "● server: cuda" màu xanh
> 3. Đóng/mở popup — dropdown giữ nguyên lựa chọn
> 4. Tắt server → popup hiện "● server offline" màu đỏ

## Task 7 — Content script + overlay ✅ (2026-07-21)

> [!success] Commit — feat: content script - image detection, document-coords overlay, autofit
> `node --check` OK. Kiểm tra bằng mắt theo checklist bên dưới (server 8910 + fixture 8000 đang chạy).

- `content.js`: quét `<img>` ≥400×400, `MutationObserver` bắt lazy-load, `IntersectionObserver rootMargin 800px` dịch trước khi vào màn hình
- Overlay theo **tọa độ tài liệu** (`top = rect + scrollY`): trình duyệt tự cuộn overlay cùng ảnh — không scroll listener, không trễ nhịp; chỉ reposition khi resize/layout đổi (`ResizeObserver`)
- Auto-fit font 18px→10px tới khi vừa bubble; bubble = div trắng bo góc, `pointer-events: none` (không chặn click trang)
- `extension/test/fixture.html` + 2 ảnh fixture, serve qua `http.server 8000`

## Redesign — nút bấm + gom 1 call Gemini ✅ (2026-07-21)

> [!bug] Sự cố khi chạy thật lần đầu
> Chế độ tự động (IntersectionObserver) bắn 1 call Gemini/ảnh khi cuộn → **429 rate limit dồn dập**, cạn luôn quota ngày của `gemini-3-flash-preview`. Bug phụ: ảnh lỗi bị đánh dấu "đã xử lý" vĩnh viễn → nhìn như chết hẳn.

> [!success] Commit — refactor: button-triggered translation, batch all texts into one Gemini call
> Test: `24 passed`; smoke `/ocr` + `/translate-texts` OK

- Server tách endpoint: `POST /ocr` (detect+OCR thuần local, không giới hạn) + `POST /translate-texts` (**1 call Gemini cho toàn bộ text mọi ảnh**); `/translate` giữ cho smoke
- Extension: bỏ auto mode → nút **"Dịch trang này"** trong popup, dịch ảnh đã load lúc bấm, bấm lại để dịch thêm/thử lại ảnh lỗi; công tắc giờ chỉ ẩn/hiện overlay (không tốn call dịch lại)
- Translator: gặp 429 thì **không retry** (vô ích, tốn thêm call)
- `.env` đổi sang `gemini-flash-lite-latest` (flash-preview cạn quota ngày; mai reset đổi lại nếu muốn chất lượng cao hơn — lite dịch câu Nhật hơi lệch)
- Spec đã cập nhật khớp thiết kế mới

> [!success] ĐÃ KIỂM TRA TAY OK (2026-07-21, cuối phiên)
> Người dùng xác nhận "everything work" trên fixture: nút "Dịch trang này" chạy đúng, overlay đè đúng vị trí, mô hình 1 call Gemini/lần bấm hoạt động.

## Trạng thái cuối phiên 2026-07-21

**Đã xong:** Task 1-7 + redesign nút bấm — server FastAPI (detect + OCR + Gemini) và extension Chrome hoạt động end-to-end, đã kiểm chứng tay trên fixture. Nhánh `feat/v1`, chưa merge về master.

**Việc còn lại (Task 8):**
- Test trên 2 site đọc truyện thật (1 manga Nhật raw, 1 truyện Tây Ban Nha) — kiểm ảnh lazy-load, ảnh hotlink-blocked, lọc banner
- Viết `README.md` (hướng dẫn chạy)
- Cân nhắc merge `feat/v1` → `master`

**Cách chạy lại hệ thống (2 terminal):**
1. API server: `run_server.bat` (chờ log model load xong; cần `.env` có GEMINI_API_KEY — đã có sẵn)
2. Trang fixture (nếu cần test): `cd extension\test` → `..\..\venv\Scripts\python -m http.server 8000`
3. Extension đã load unpacked trong Chrome — chỉ cần server bật là dùng được trên mọi trang

> [!warning] Nhớ về model Gemini
> `.env` đang để `gemini-flash-lite-latest` (dịch tạm được, câu Nhật hơi lệch). Quota `gemini-3-flash-preview` reset theo ngày — đổi lại trong `.env` + restart server nếu muốn dịch tốt hơn. `gemini-2.5-flash` bị khóa user mới (404), `gemini-2.0-flash` hết quota free (429).

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

### Thread A — 2 bố cục đọc (webtoon dọc + reader ngang)

> [!success] Spec đã viết & commit
> Spec: `docs/superpowers/specs/2026-07-23-layout-modes-unified-design.md` — **plan chưa viết** (đợi user review spec).

**Chốt: một nút thống nhất, KHÔNG chế độ** (user chọn). Tái dùng gần hết code: định vị per-`<img>` theo tọa độ tài liệu + batch 1-call Gemini **đã dùng chung được cho cả 2 bố cục**. Chỉ vá 2 chỗ:
- `done: WeakSet<img>` → `translated: WeakMap<img, src>` — sửa gốc bug reader (lật trang đổi `src` trên cùng element → được dịch lại).
- `MutationObserver` gỡ overlay cũ ngay khi ảnh đổi `src`/rời DOM → chữ trang cũ không lơ lửng đè trang mới.

Giữ thủ công (không auto-translate/auto-scroll). Dùng `bestSource()` của thread B (hai thread độc lập). **Fullscreen API thật → backlog** (user chọn để sau).

### Việc còn lại sau phiên này

- [ ] User review 2 spec (B đã có plan; A chưa) → sửa nếu cần
- [ ] Thread B: chạy `diagnose.py` trên mangadex.jpeg (decision gate B2 vs B3) → mới quyết Task 4
- [ ] Thread A: viết plan (writing-plans) sau khi user duyệt spec
- [ ] Triển khai code (chưa bắt đầu)

## Task 1 — Chẩn đoán B2/B3 + knob detector ✅ (2026-07-28)

- Thêm `server/diagnose.py`: vẽ bbox xanh khi OCR có chữ, đỏ khi OCR rỗng; xuất `.diag.png` và `.diag.txt` để tách B2 (detector không có ô) với B3 (có ô đỏ).
- `Detector(device="cuda", conf_thresh=None, input_size=None)` truyền knob tùy chọn; `None` giữ nguyên default vendor `conf_thresh=0.4`, `input_size=1024`.
- Chạy: `python -m server.diagnose server/vendor/comic_text_detector/data/examples/mangadex.jpeg --lang es` → **13 block, 4 rỗng**. (PowerShell cần `PYTHONIOENCODING=utf-8` để in dòng kết quả tiếng Việt.)
- **Kết luận gate: B3, bỏ Task 4.** Cả ba bóng cần xét đều có bbox đỏ/OCR rỗng trên ảnh diagnostic: #3 “POR FAVOR...”, #7/#8 “SIM... EU NÃO VOU...”, #11 “EU ME PREOCUPO...”. Detector đã bắt được bóng; lỗi ở OCR/crop, không phải recall B2, nên không thử/không thêm knob `.env`.

## Thread B — recall OCR hoàn tất ✅ (2026-07-28)

- [x] Chọn ảnh full-res từ `srcset`.
- [x] Pad + upscale crop trước OCR.
- [x] Decision gate: bỏ Task 4 vì detector đã bắt đủ bbox.
- [x] Tự động: `pytest` **30 passed**; kiểm tra Node **pass**.
- [x] Diagnostic: **13 block, 0 OCR rỗng** (trước: 13/4).
- [x] Kiểm thử tay trên browser: **PASS** — toàn bộ box và text hoạt động đúng; không còn chữ không nhận diện.

> [!success] Plan hoàn tất
> `2026-07-23-in-bubble-ocr-recall.md` không còn workload mở; các backlog khác giữ nguyên.

## Thread A — hành động dịch theo bố cục hoàn tất trên v2 ✅ (2026-07-28)

> [!success] Kết quả
> Thread A trong [[#Backlog rút ra cho v2]] đã được triển khai, review và kiểm chứng tự động trên nhánh local `feat/v2` tại commit `5fa5b50`. Nhánh `feat/layout-translation-actions` được giữ lại làm điểm dự phòng; lịch sử bắt đầu từ `feat/v1`.

> [!note] Quyết định được tái chốt
> Ghi chú cũ “một nút thống nhất” ở phần thiết kế phía trên đã được thay thế khi recheck spec ngày 2026-07-28: popup có **đúng hai hành động thủ công**, dùng chung pipeline và không tự đoán layout.

- [x] **Dịch webtoon đã tải** (`scope: "loaded"`): chọn mọi `<img>` hợp lệ đã load, kể cả ảnh đang ngoài viewport.
- [x] **Dịch trang đang xem** (`scope: "visible"`): chỉ chọn ảnh hợp lệ đang giao với viewport.
- [x] Đổi `done: WeakSet<img>` thành `translated: WeakMap<img, source>` để cùng một node được dịch lại khi nguồn ảnh đổi.
- [x] Snapshot `bestSource(img)` trước OCR; bỏ kết quả nếu node rời DOM hoặc nguồn đã đổi trong lúc OCR/Gemini chạy.
- [x] Giữ queue OCR hiện tại tối đa 2 request song song và gom text thành đúng 1 call `translateTexts`.
- [x] Tập trung teardown qua `removeOverlay(img)`; observer theo dõi thay đổi `src`/`srcset`/`<picture>`, node bị thay và ảnh visible rời viewport.
- [x] Vá race cuối: callback `IntersectionObserver` cũ không còn xóa overlay mới thay thế; observer hiện tại vẫn xóa đúng overlay nó sở hữu.
- [x] Fixture có điều khiển đổi `src`, thay `<img>` node và đẩy trang vào/ra viewport.

### Bằng chứng triển khai

- Spec: `docs/superpowers/specs/2026-07-23-layout-modes-unified-design.md`.
- Plan: `docs/superpowers/plans/2026-07-28-layout-translation-actions.md`.
- Commits: `95ad970` (spec/plan) → `1f3bc08` (selection) → `12c0d0f` (popup + pipeline) → `c49662e` (lifecycle) → `5fa5b50` (observer ownership guard) → `37ff1ab` (diagnostic cleanup) → `6084405` (responsive-source/language race guards).
- Tự động: `srcset.test.js` **PASS**; syntax check `srcset.js`, `content.js`, `popup.js`, `background.js` **PASS**; popup contract, protected-file diff và regression stale-observer **PASS**.
- Review cuối: **ready to merge**, không có finding Critical/Important.
- `graphify update .`: hoàn tất; không có thay đổi topology sau lần kiểm chứng cuối.

> [!success] Acceptance browser đã PASS
> User đã kiểm thử tay extension và xác nhận kết quả đạt yêu cầu trước khi merge.

### Trạng thái phiên bản và việc còn lại

- `feat/v2` đã được fast-forward vào nhánh chính của checkout, `feat/v1`, tại `6084405`.
- `extension/manifest.json` vẫn là `0.1.0`; chỉ bump lên `0.2.0` khi đóng gói release v2 hoàn chỉnh.
- Minor cleanup đã xử lý tại `37ff1ab`: sửa mojibake ở lỗi `scope` không hỗ trợ và cập nhật comment pipeline cũ trong `content.js`.
- Backlog v2 khác vẫn mở: capture bền vững cho site chặn hotlink, `all_frames`, quan sát lỗi capture, chữ ngoài bóng/inpaint và ngôn ngữ mới.

## Tiếp tục Thread A — hardening cuối (2026-07-28)

> [!success] Code, review, acceptance và merge hoàn tất
> [[#Thread A — hành động dịch theo bố cục hoàn tất trên v2 ✅ (2026-07-28)|Thread A]] hiện ở nhánh `feat/v1`, commit `6084405`. Không còn finding Critical/Important sau scoped re-review.

- [x] Commit `37ff1ab` sửa mojibake của lỗi `scope không hỗ trợ` và cập nhật comment pipeline hai hành động; regression RED→GREEN, task review sạch.
- [x] Final review phát hiện hai race thật: `<picture>` có thể chọn nhầm fallback `img.srcset`, và ngôn ngữ có thể đổi trong lúc chờ OCR.
- [x] Commit `6084405` làm `currentSrc` quyết định đúng source set của `<picture>`, vẫn lấy candidate full-res trong set đó; snapshot `srcLang`/`dstLang` một lần cho toàn action.
- [x] Thêm `content.test.js` dependency-free để đổi storage khi OCR đang pending; payload OCR + dịch vẫn giữ `ja`/`vi` của lúc bắt đầu.
- [x] Kiểm chứng mới: `srcset.test.js OK`, `content.test.js OK`; syntax check `srcset.js`, `content.js`, `popup.js`, `background.js`; popup labels/scopes; `git diff --check` đều **PASS**.
- [x] `graphify update .` hoàn tất: **321 nodes, 445 edges, 27 communities**. Cảnh báo còn lại chỉ là 6 file config/generated không sinh node và community labels chưa relabel.

> [!success] Acceptance browser hoàn tất
> User xác nhận kiểm thử tay **PASS** ngày 2026-07-28.

- [x] Fixture local: đổi `src`, thay node, ra/vào viewport và race lật trang nhanh.
- [x] Site webtoon dọc thật: loaded scope dịch ảnh mới load, không xử lý lại nguồn cũ, overlay loaded vẫn giữ khi cuộn.
- [x] Reader từng trang/spread thật: visible scope chỉ dịch trang hiện tại; đổi `<picture>`/lật trang gỡ overlay cũ và kết quả trễ không vẽ nhầm.
- [x] Fast-forward `feat/v1` từ `58ec6ea` lên `6084405`; chạy lại `srcset.test.js`, `content.test.js`, bốn syntax check và `git diff --check` trên checkout sau merge — đều **PASS**.
- [x] Xóa nhánh local `feat/v2` và standalone clone `.worktrees/layout-translation-actions`; `.worktrees` hiện trống.

`extension/manifest.json` vẫn là `0.1.0`; bump `0.2.0` để lại cho bước đóng gói release, không thuộc merge này.

## Gemini project failover — đóng phiên cũ (2026-07-29)

> [!info] Bối cảnh
> Phiên trước bị **user tạm dừng** giữa chừng. Spec: `docs/superpowers/specs/2026-07-29-viewport-ocr-prewarm-gemini-failover-design.md` · Ledger: `.superpowers/sdd/2026-07-29-gemini-project-failover/` · Handoff: `docs/superpowers/worklogs/2026-07-29-session-handoff.md`
> Việc còn lại đúng một món: **re-review độc lập fix round 1**. Phiên này làm nốt.

### Re-review fix round 1 → phát hiện 2 lỗi Important

> [!bug] `"429" in last_err` khớp chuỗi, không khớp mã lỗi
> Bất kỳ exception nào có chữ `429` trong text đều bị coi là hết quota. Thủ phạm thực tế: reply hỏng → `json.loads` báo vị trí lỗi, ký tự sai ở offset 428 cho ra `Expecting value: line 1 column 429 (char 428)`.
> **Hậu quả kép:** tốn 1 call của project phụ, **và** vì call fallback đó thành công với `switched=True` nên client phụ **được promote vĩnh viễn** cho mọi lần dịch sau.

> [!bug] Nhánh 429 khi chỉ có 1 key không có test
> `.env.example` mặc định `GEMINI_API_KEY_SECONDARY=` rỗng ⇒ **một client là hình dạng mặc định**, vậy mà guard `len(self._clients) > 1` không test nào chạm tới. Hành vi vốn đã đúng, chỉ là không được chắn regression.

Bốn test 429 cũ ném `RuntimeError("429 ...")` nên **pass nhờ đúng cái trùng chuỗi đang là bug**. Nay ném fake mang `code = 429` theo đúng hình dạng SDK.

### Fix round 2 ✅

- [x] `server/translator.py`: đổi sang `getattr(e, "code", None) == 429` — đọc status HTTP dạng int mà `google.genai.errors.APIError.__init__` gán, `ClientError` kế thừa.
- [x] RED trước khi sửa: `test_decode_error_mentioning_429_does_not_use_secondary` fail với `assert ['unused'] == ['ok']` — `['unused']` chính là reply của client phụ, tức reply hỏng đã fail over thật.
- [x] Test tự kiểm tiền đề của chính nó (`assert "429" in str(decode_error.value)`) nên không mục ruỗng thành tautology nếu Python đổi câu chữ lỗi.
- [x] Thêm `test_single_key_429_raises_without_second_call`: đúng 1 call + `TranslateError`.
- [x] Bỏ `raising=False` trong monkeypatch — nó che lỗi gõ sai tên biến config; suite vẫn pass ⇒ xác nhận tên `GEMINI_API_KEY_SECONDARY` có thật.
- [x] Đối chiếu với **SDK thật** chứ không chỉ fake: `ClientError(429, ...)` có `code == 429` khớp, `ServerError(503, ...)` không khớp.

**Đánh đổi đã chấp nhận:** 429 tới dưới dạng *không phải* `APIError` (ví dụ proxy trả HTML) sẽ không còn kích hoạt failover mà retry cùng client rồi fail. Hỏng theo hướng nhẹ, trong khi khớp chuỗi hỏng theo hướng nặng hơn là promote nhầm project phụ.

**Hoãn có chủ đích:** `client_index = 1 - client_index` hard-code đúng 2 client — khớp trần 2 project của spec, tổng quát hóa bây giờ là abstraction không ai dùng.

### Kiểm chứng

| Lệnh | Kết quả |
| --- | --- |
| `pytest server/tests/test_translator.py -q` | 13 passed |
| `pytest server/tests/test_translator.py server/tests/test_translate_endpoint.py -q` | 23 passed, 1 warning |
| `pytest server/tests --ignore=server/tests/test_ocr.py -q` | 43 passed, 2 warnings |

Warning còn lại là deprecation Starlette/httpx và `pkg_resources` của vendor — có sẵn từ trước.

> [!success] Smoke test đã chạy — PASS (2026-07-29)
> `こんにちは世界` → `Xin chào thế giới`, call Gemini thật qua `scripts\smoke.ps1`. Cả hai project đều hợp lệ khi ép chạy riêng từng client: `primary OK` / `secondary OK`. Failover đã thực sự có hiệu lực.
> Commit `d016038`, nay nằm trên `feat/v2` cùng `b920fdd` (viewport OCR), `f570693` (docs), `de58b42` (config). **Chưa push** theo yêu cầu user.

> [!warning] Còn nợ
> - **Kiểm thử browser tay của plan viewport OCR prewarming vẫn chưa chạy.**
> - Key Gemini bị dán vào chat (cả phiên trước lẫn phiên này) **phải revoke/xoay vòng**; chưa từng lọt vào source, test, log hay `.env.example`. Transcript nằm trên đĩa nên coi như đã lộ.
> - `.git` **đã ghi được trở lại** ở phiên này (phiên trước read-only nên mọi ghi chú "commits unavailable" chỉ đúng với phiên đó).

## Đo latency thật + phương án tối ưu (2026-07-29)

> [!info] Vì sao đo trước khi sửa
> User chốt: **độ chính xác giữ nguyên**, chỉ tối ưu latency, và đau ở cả hai kiểu đọc như nhau. Roadmap `ocr-manga-extension-roadmap.md` đoán nút thắt nằm ở cache/concurrency — **đo xong thì sai**.

### Số warm, một trang thật

| | ja (Aisazu, 24 bóng) | es (mangadex, 13 bóng) |
| --- | --- | --- |
| decode | 0.02s | 0.01s |
| detect | 0.67s | 0.18s |
| **OCR loop** | **7.18s (91%)** | **13.15s (99%)** |
| Gemini | ~4.1s | ~1.7s |
| **end-to-end `/translate`** | **11.8s** | **14.7s** |

Per-crop: manga-ocr (GPU) median **0.179s**, max 1.94s — PaddleOCR (**CPU**) median **1.068s**, overhead cố định 0.237s/call. Cold start lần đầu sau khi bật server: +6–8s mỗi model.

**Kết luận: OCR loop là tất cả.** detect/decode không có gì để lấy; `MAX_CONCURRENT=2` phía client là trang trí vì `_ocr_lock` serialize toàn bộ.

### Phương án A — đưa PaddleOCR lên GPU (TẠM GÁC)

Bốn cách *không cần cài gì* đều đã đo và **loại**:

| Thử | Kết quả |
| --- | --- |
| `enable_mkldnn=True` | Vỡ đúng lỗi PIR mà comment `server/ocr.py:26` mô tả — comment vẫn đúng, không phải nợ cũ |
| Batch cả list vào 1 call | 13.32s vs 12.94s — `predict()` chỉ loop nội bộ, không được gì |
| rec-only (bỏ detect nội bộ) | Nhanh 53× (0.020s/crop) nhưng ra `['T','TA','E','AP']` — crop là **cả bóng nhiều dòng**, `TextRecognition` chỉ đọc một dòng |
| 1 call cả trang rồi gom dòng về bóng | **Chậm hơn** (16.84s vs 12.62s) và đổi text |

Wheel hiện tại `paddle 3.3.1`, **`is_compiled_with_cuda() == False`** → `device="gpu"` chỉ in *"not available, switching to CPU"*. Nên A **bắt buộc cài `paddlepaddle-gpu`**, không có đường vòng.

> [!danger] Rủi ro DLL đã được chứng minh
> Import `paddle` trước `torch` làm hỏng `torch/lib/shm.dll` (`WinError 127`) — gặp thật khi viết probe. Sở dĩ server chạy được là vì `paddleocr` được import **lười** bên trong `PaddleLatinEngine.__init__`, nên torch luôn lên trước.
> Nhét CUDA runtime của paddle cạnh cu121 của torch trên Windows có thể làm **hỏng path `ja` đang chạy tốt**.
> **Cách an toàn khi làm A:** dựng **venv riêng** để thử, chứng minh paddle GPU chạy + đo tốc độ, rồi mới quyết có đổi venv chính không. Không cài đè lên venv đang chạy.

### Phương án B — vẽ chữ dần (ĐANG LÀM)

Hiện tại OCR hết cả trang (7–13s) → 1 call Gemini → **rồi mới vẽ**. User nhìn màn hình trống suốt 12–15s. B không giảm tổng thời gian, nhưng cắt mạnh **thời gian tới chữ đầu tiên**. Chọn B vì nó độc lập với chuyện paddle có lên GPU được hay không.

### Phương án C — bỏ `_ocr_lock` chạy song song (KHÔNG LÀM)

Chỉ đáng khi CPU-bound. Sau A thì hệ thành GPU-bound mà chỉ có một GPU ⇒ gần như vô nghĩa.

### Phát hiện phụ — detector trả box trùng

```
es: [0](379,141,500,230) vs [1](379,141,501,230)  IoU=0.99  ← lệch 1 pixel
    [7](501,422,574,488) vs [8](500,423,575,490)  IoU=0.93
```

2/13 bóng bị OCR **hai lần**: ~2.0s trong 13.15s là công toi, chữ trùng gửi lên Gemini, overlay vẽ đè cùng một câu hai lần.

Trang `ja` khác kiểu: 7 cặp **lồng nhau** (contain≈1.0 nhưng IoU thấp — box nhỏ nằm trong box lớn, chữ dọc). Với ngưỡng IoU 0.5 thì `ja` không mất box nào. **Không đụng phần lồng nhau** vì nó có thể là hiệu ứng âm thanh riêng, và user đã chốt giữ nguyên độ chính xác.
