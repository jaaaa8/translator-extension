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

- [x] Chọn ảnh full-res từ `srcset` thay vì phụ thuộc `currentSrc`.
- [x] Pad + upscale crop trước OCR để giữ nét chữ nhỏ sát mép bóng.
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

---

## Dedupe box trùng — xong ✅ (2026-07-29)

Commit `9eeb19f` trên `feat/v2`. `server/pipeline.py`: `_iou()` + `_dedupe_regions()` bỏ box có IoU > `_DEDUPE_IOU = 0.5`, **giữ box to hơn** (box to không cắt cụt chữ), gọi ngay trong vòng lặp của `ocr_image()`.

| Trang | Box | OCR trước | OCR sau | Chữ mất |
|---|---|---|---|---|
| `es` mangadex | 13 → 11 | 12.62s | **9.77s (−23%)** | không |
| `ja` Aisazu | 24 → 24 | 7.12s | 6.88s | không |

> [!warning] Độ chính xác trên hai box trùng là **hoà, không phải thắng**
> Heuristic "giữ box to hơn" cho kết quả lẫn lộn trên đúng hai bóng bị trùng của `es`:
> - bóng 1 **kém đi**: `MEL` (đúng phải là `MEU`)
> - bóng 7 **tốt lên**: `EU NÃO VOU` thay vì `ELI NÃO VOUI`
>
> Cái thắng chắc chắn là **mỗi bóng giờ chỉ còn một overlay** thay vì hai cái chồng nhau, cộng 23% thời gian.

4 test mới trong `server/tests/test_pipeline.py` dùng **toạ độ đo thật**, trong đó có test giữ nguyên box lồng nhau của `ja`. Toàn bộ: 47 pytest pass, 4 suite node OK, `git diff --check` sạch.

Commit thứ hai `fde9ca5` — ghi lại số đo latency vào docs.

---

## Kiểm chứng lại `ocr-manga-extension-roadmap.md` (2026-07-29)

Đã đối chiếu từng nhận định của roadmap với code + số đo thật, và ghi thẳng kết quả vào file đó (mục `## 0` mới, cộng annotation tại chỗ ở §2, §3.1, §3.2, §3.4, §8 và Kết luận).

**Đúng, giữ nguyên:** toàn bộ mô tả kiến trúc ở mục 1; `MAX_CONCURRENT=2`, single-flight, timeout 60s/300s; một call Gemini + retry + failover 429; `fitText` 18→10px; cả 4 cơ chế chống race ở §1.7. Và quan trọng nhất: **"chờ OCR xong toàn scope rồi mới dịch" đúng là điểm nghẽn số 1** — đó chính là B2.

**Sai hoặc đặt sai ưu tiên:**

| Roadmap nói | Thực tế đo được |
|---|---|
| P0: thu hẹp `_ocr_lock` theo stage (§3.1) | Phần chạy ngoài lock là 0.01–0.02s / vòng OCR 7–13s ⇒ lấy về ~0.02s. **Bỏ** |
| P0: batch recognition (§3.2) | Paddle list-`predict()` 13.32s vs 12.94s; rec-only trả rác; manga-ocr không có API batch. **Bỏ** |
| P1: "detector trả nhiều vùng" = cơ hội batch | Vấn đề thật là **box trùng** (IoU 0.99/0.93) — roadmap bỏ sót hoàn toàn. Sửa xong được 23% |
| §1.4 có nói `es` dùng PaddleOCR CPU… | …nhưng **không đưa vào bảng điểm nghẽn §2**, nên biến mất khỏi mọi quyết định ưu tiên. Đây mới là hàng đầu bảng: 6× chậm hơn/crop |
| §7: trace 14 stage kiểu OpenTelemetry | Over-engineering khi một số hạng chiếm 91–99%. Một `perf_counter()` là đủ |
| §3.10 tiling | Hạng mục *accuracy* — user đã chốt độ chính xác hiện ổn, không liên quan |

**Bug được roadmap đoán đúng, chưa sửa:** §3.4 thiếu `dstLang` trong cache key. `extension/srcset.js` `jobKey()` = `source|srcLang|crop`, còn `selectCandidates()` bỏ qua ảnh khi `translated.get(img) === key` ⇒ đổi đích vi→en rồi bấm lại thì **ảnh đã dịch bị bỏ qua sai**. Sửa nhỏ, để dành.

**Câu hỏi mở đã trả lời:** #2 (phân bổ thời gian), #5 (không có API batch dùng được), #6 (cả hai scope đều đau ⇒ B2 phải phục vụ cả hai), #10 (24 block vẫn ổn cho một call Gemini). #1 thành vô nghĩa.

---

## DeepL thay Gemini? — phân tích (2026-07-29)

### Cái DeepL sửa được

| Vấn đề API hiện tại | DeepL |
|---|---|
| Rate limit 429 (đang phải nuôi 2 project key để xoay vòng) | Free ~500k ký tự/tháng ≈ **690 trang** ở mức ~720 ký tự/trang. Hết hạn mức thì trả tiền theo ký tự, không phải theo request |
| Gemini 2–4s/call | **~200ms** |
| JSON trả về lệch số phần tử → cả bộ máy retry 2 lần trong `translator.py` | DeepL trả **đúng N chuỗi cho N chuỗi vào**. Bỏ được toàn bộ retry + validate |
| Một call hỏng làm hỏng cả trang | Mỗi chunk độc lập |

Đã xác minh: DeepL hỗ trợ **`VI` làm ngôn ngữ đích** (`translation:true`, có glossary), `JA`/`ES` đều là source hợp lệ. Không bị chặn kỹ thuật.

### Cái DeepL làm hỏng

> [!danger] DeepL dịch trung thành **cả lỗi OCR**
> Text thật lấy từ log phiên này:
> - OCR ra `MELI PÉ FEDIA` — đúng phải là `MEU PÉ`
> - OCR ra `ELI NÃO VOUI CONTAR PRA NINGLIÉM` — đúng phải là `EU NÃO VOU CONTAR PRA NINGUÉM`
>
> LLM **âm thầm sửa** những chữ này vì nó hiểu câu. DeepL sẽ dịch nguyên rác. Với PaddleOCR CPU đang có tỉ lệ lỗi như trên, đây không phải rủi ro lý thuyết — nó xảy ra ở phần lớn bóng thoại.

Ngoài ra mất ngữ cảnh xuyên bóng: đại từ (`you` → *anh/em/mày/ngài*), mức lịch sự, SFX. Đây đúng là lý do §1.5 chọn gộp cả scope vào **một** call.

### Hybrid H1 — "dịch nháp rồi tinh chỉnh" ⭐ khuyến nghị

```text
block OCR xong → DeepL dịch ngay (~200ms) → VẼ LUÔN (bản nháp)
   ...
hết trang → 1 call Gemini cho TOÀN BỘ block → thay chữ tại chỗ (bản chuẩn)
```

- Chữ đầu tiên hiện sau **~2s** thay vì 12–60s.
- Vẫn đúng **1 call Gemini/trang** ⇒ rate limit không đổi so với hôm nay.
- Gemini vẫn thấy toàn trang ⇒ giữ nguyên nhất quán đại từ và khả năng sửa lỗi OCR.
- Rủi ro: chữ **nhảy** khi thay bản nháp bằng bản chuẩn. Giảm bằng cách chỉ thay khi text khác nhau, và cho fade.

### Kết luận

**Không thay Gemini bằng DeepL.** DeepL đóng vai *bản nháp hiện ngay*, Gemini giữ vai *bản chuẩn*. Và dù cuối cùng có làm DeepL hay không, **B2 vẫn phải làm trước** — cả hai đều cần đúng một thứ: cơ chế stream block ra và vẽ dần.

---

## Trạng thái khi đóng phiên (2026-07-29)

- Nhánh: **`feat/v2`**, **7 commit ahead của `origin/feat/v2`, CHƯA push** (user dặn đừng push).
- Đã chốt: **B2 — stream + vẽ dần**. Chưa viết code.
- B2 cần làm: server trả NDJSON theo block (`StreamingResponse`) → background nối bằng `chrome.runtime.connect` port → `content.js` vẽ theo chunk thay vì `Promise.all` toàn scope.
- Việc để dành: `dstLang` vào `jobKey()` trong `srcset.js`; test tay viewport OCR prewarming trên trình duyệt; phương án A (paddle GPU, venv riêng).

> [!danger] Bảo mật — còn nợ
> Hai Gemini API key đã bị dán vào chat trong phiên này. Cả hai **chưa từng** được ghi vào source, test, log, `.env.example` hay note nào. **Cả hai đều nằm trong transcript trên đĩa và phải được xoay/thu hồi.** `.env` chưa từng được đọc hay sửa — chỉ biết *tên biến* và độ dài.


## Progressive translation + session cache — Task 1–8 hoàn tất (2026-07-30)

> [!info] Trạng thái tại mốc cập nhật
> Plan: `docs/superpowers/plans/2026-07-30-progressive-translation-session-cache.md`  
> Worktree: `.worktrees/progressive-session-translation` · nhánh `feat/progressive-session-translation` · HEAD `bbc2395`  
> **Task 1–8 đã triển khai và review sạch. Task 9–10 chưa làm**, nên chưa coi toàn bộ plan là hoàn tất và chưa merge.

### User nhận được gì ở mốc Task 8

- Khi bấm dịch trang hiện tại, từng block có thể xuất hiện dần qua Port thay vì đợi OCR + Gemini của cả scope xong mới vẽ.
- Các trang single-page mà user thực sự bấm dịch (`visible`) được lưu thành page artifact trong cache bền vững, giới hạn **8 MiB**. Quay lại đúng trang/crop/ngôn ngữ/version có thể replay overlay từ cache mà không gọi lại OCR/Gemini.
- Bấm dịch lại hoặc đổi ngôn ngữ tạo request mới. Kết quả trễ của request cũ không được phép ghi đè bản mới; Promise cũ được kết thúc rõ ràng thay vì treo.
- Công đoạn dùng chung được giữ lại đúng tầng: đổi ngôn ngữ đích có thể dùng lại analysis/OCR; đổi recognizer vẫn dùng lại analysis nếu tương thích. Chỉ ownership của request cũ bị bỏ, không mặc định phá hủy mọi công việc nền hữu ích.
- Ảnh chỉ rời viewport **không bị gỡ overlay**; user quay lại vẫn thấy bản dịch. Overlay chỉ bị prune khi node ảnh mất kết nối hoặc source/signature thực sự đổi, tránh chữ trang cũ đè lên trang mới.
- Công việc `visible` đã được nhận có thể tiếp tục ở background và rehydrate sau service-worker restart; `loaded` là RAM-only và bị hủy khi không còn owner. Prewarm chỉ làm OCR tier thấp, không gọi dịch cloud.

### Tiến độ theo task

- [x] **Task 1 — Versioned artifacts:** thêm artifact analysis/OCR, stable block ID và LRU giới hạn item/byte.
- [x] **Task 2 — Split analysis/recognizer:** cache partial OCR theo block, retry đúng block lỗi, giữ API cũ qua compatibility wrapper.
- [x] **Task 3 — `/ocr-stream`:** NDJSON theo thứ tự `analysis_ready → block events → image_done`, hỗ trợ warm analysis và client disconnect.
- [x] **Task 4 — Structured translation:** Gemini nhận/trả block theo stable ID; bắt buộc exact ID set và chuẩn hóa về thứ tự request.
- [x] **Task 5 — Session ledger + 8 MiB page cache:** metadata-only persistence, eviction theo trạng thái/LRU, quota retry một lần, rehydrate job đang chạy về queued.
- [x] **Task 6 — Background transport/scheduler:** cache keys theo version/crop/lang, NDJSON reader, global concurrency 2, tối đa 4 job/request.
- [x] **Task 7 — Background-owned producers:** ownership/replacement/cancellation, shared stages, micro-batch 3 rồi tối đa 8, hot LRU, offline health, restart rehydrate và failure isolation.
- [x] **Task 8 — Content Port subscriber:** atomic `start_scope` kể cả zero-job, stale guards, idempotent block upsert, reconnect đúng request hiện hành và lifecycle overlay.
- [ ] **Task 9 — Popup:** snapshot `srcLang`/`dstLang`, latest-action guard, trạng thái background/cache/error và copy exact-hit.
- [ ] **Task 10 — Acceptance:** cross-layer/browser acceptance, metrics, cập nhật `work-flow.md` và verification worklog trong repo.

### Các quyết định quan trọng

> [!important] Scheduler theo lựa chọn của user
> Tier là **foreground → detached manual → prewarm**. Foreground vẫn ưu tiên ảnh gần viewport; detached manual dùng **strict FIFO**, nên job đến trước không bị job đến sau nhưng gần viewport hơn vượt mặt. Đây là chủ đích để các trang user đã bấm dịch được xử lý theo thứ tự ổn định.

> [!important] Cache không đồng nghĩa giữ mọi byte ảnh
> Cache chỉ lưu metadata, bbox, source text, translation và trạng thái. Image bytes/crop đã chuẩn bị không được phép lọt vào `chrome.storage.local`; nếu không, quota 8 MiB sẽ bị chiếm rất nhanh và còn mở đường cho payload không đúng schema.

> [!important] “Bỏ công việc cũ” được định nghĩa theo ownership
> Request UI cũ bị release và không còn quyền render. Tuy nhiên analysis/OCR stage đang hữu ích có thể tiếp tục nếu request mới hoặc visible persistence vẫn là consumer. Cách này tránh làm lại detect/crop/OCR chỉ vì đổi đích Việt → Anh.

> [!note] Chính sách overlay khi lật/di chuyển trang
> Không dùng `IntersectionObserver` để xóa khi offscreen. Chỉ source/signature change hoặc DOM disconnect mới teardown. Vì vậy quay lại trang cũ không mất overlay, nhưng reuse cùng `<img>` cho trang mới vẫn không mang chữ cũ sang.

### Những phần khó nhất và vì sao

#### 1. Task 5 — cache boundary phải qua 5 vòng fix

Đây là phần fail/review nhiều nhất. Lý do không nằm ở eviction algorithm mà ở **ranh giới dữ liệu lưu bền vững**: object job/page đi qua nhiều tầng và rất dễ vô tình mang theo binary hoặc giá trị có hình dạng “gần đúng”.

| Vòng | Test bắt được | Nguyên nhân | Cách sửa gốc |
| --- | --- | --- | --- |
| 1 | `image_bytes` bị persist; `findPage()` không touch LRU | clone cả object và read-path chưa cập nhật recency | whitelist schema page/block; dùng shared best-effort touch |
| 2 | crop dạng `data:image...` lọt vào | crop chưa có validator canonical | chỉ cho `full` hoặc rect normalized finite |
| 3 | `source_url: data:`/object và binary trong field hợp lệ | whitelist tên field nhưng thiếu type validation | validate từng field; URL chỉ `http:`, `https:`, `blob:` |
| 4 | binary timestamp, `blob:data:...`, `trans_text: null` bị xử sai | validator chưa xét nested scheme và trạng thái OCR partial | finite-number validator; kiểm origin của blob; cho null đúng state |
| 5 | clock giả trả binary làm bẩn row khi cache hit | đường đọc không dùng cùng validator với đường ghi | gom về một touch path; lỗi clock/storage không làm hỏng render |

> [!warning] Bài học
> “Không lưu image bytes” không thể chỉ kiểm một property. Phải coi persistence là trust boundary: whitelist + type-check + canonicalize ở cả write path lẫn read-touch path.

#### 2. Task 6 — priority đúng tên nhưng sai nghĩa qua 3 vòng

- Vòng đầu: `task.run()` ném lỗi đồng bộ trước khi Promise chain được gắn, làm mất scheduler slot.
- Vòng sau: một numeric `priority` bị dùng lẫn cho foreground, detached và prewarm; metadata có thể vô tình hạ foreground hoặc đẩy detached sai tier.
- Vòng cuối: comparator distance-first khiến job detached đến sau nhưng gần viewport hơn vượt job cũ, trái quyết định strict FIFO.

Fix cuối tách rõ **tier** khỏi tie-breaker: foreground/prewarm có thể dùng distance rồi sequence; detached chỉ dùng sequence. Test đối kháng cố ý cho job cũ distance 100 và job mới distance 1 để chứng minh FIFO vẫn giữ.

#### 3. Task 7 — ownership và late join giữa stream

Task này khó nhất về concurrency. Các lỗi chỉ lộ khi dựng đúng interleaving:

- loaded producer đã có OCR hữu ích nhưng không được phép persist partial nếu chưa từng có visible owner;
- hai job cùng source/crop phải dùng chung producer/network nhưng vẫn được tính là **hai consumer/job ID**;
- target mới tham gia giữa block `early` và `late` từng chỉ nhận `late`, vì shared OCR stage chưa giữ snapshot block đã phát;
- stale cloud response có thể làm nóng RAM cache nhưng không được mutate page/render của request đã retired;
- một translation batch hỏng không được reject cả chain và chặn batch sau.

Fix quan trọng là stage OCR giữ snapshot block/error + analysis metadata. Consumer tham gia muộn được seed phần đã có rồi tiếp tục nhận live event, nên không cần OCR lại và không mất block đầu.

#### 4. Task 8 — production đã sửa nhưng test “xanh giả” qua nhiều review

Review đầu bắt được ba lỗi lifecycle thật:

- reconnect callback capture message cũ rồi microtask có thể gửi lại request đã supersede;
- background release request cũ nhưng không emit `scope_done`, làm Promise content cũ treo và leak binding;
- overlay reuse giữ `image_w/image_h` của event đầu, làm scale sai nếu event sau mang dimensions mới.

Sau khi production fix, suite vẫn pass nhưng **chưa chứng minh đúng contract**:

- fake DOM có `appendChild()` no-op nên stale-event test không thể biết DOM có bị ghi hay không;
- “same-config replay” đã prune overlay trước khi replay, vì vậy chỉ chứng minh tạo overlay mới;
- prewarm chỉ có một ảnh, nên không chứng minh chọn ảnh có visible area lớn nhất;
- signature test đổi `srcset` rồi đổi `media` nhưng vẫn so với baseline ban đầu, nên vẫn pass ngay cả khi `media` bị bỏ khỏi signature.

Test harness cuối được viết lại để theo dõi identity container/bubble thật, tách từng stale guard để không guard trước che guard sau, replay khi overlay cũ còn sống, dùng hai ảnh cho prewarm và so signature tuần tự sau từng mutation.

> [!bug] Một RED là lỗi expectation, không phải lỗi production
> Coordinate test ban đầu kỳ vọng `1px`, nhưng fake image hiển thị rộng 600 px với `image_w=500`, nên đúng phải là `1.2px`. Test được sửa theo phép scale; production không đổi. Ghi rõ để tránh hiểu nhầm rằng mọi RED đều là bug sản phẩm.

### Các failure quan trọng khác

- **Task 2:** cancellation đã được check trước lock nhưng request có thể bị cancel trong lúc chờ `_ocr_lock`; cần check lần hai ngay trước `engine.read()`.
- **Task 3:** warm analysis có thể bị LRU eviction giữa bước validate và lúc generator chạy; endpoint phải pin artifact cho toàn stream.
- **Task 4:** provider trả đủ text nhưng reorder/duplicate/foreign ID từng vẫn trả HTTP 200; endpoint nay exact-set validate và normalize theo request order.
- **Môi trường:** một lần full Python suite trong sandbox fail vì model cache/network bị chặn; rerun đúng quyền pass. Các warning `.pytest_cache`, Starlette/httpx, `pkg_resources` và Paddle `ccache` là môi trường/deprecation có sẵn, không phải regression.

### Bằng chứng test và review

| Mốc | Kết quả |
| --- | --- |
| Task 1 full server | **53 passed** |
| Task 2 full server | **56 passed**; sau cancellation fix: pipeline **21 passed** |
| Task 3 full server | **59 passed** |
| Task 4 full server | **66 passed**; translator + endpoint sau exact-ID fix **32 passed** |
| Task 5 extension | **5/5 passed** sau fix round 5 |
| Task 7 extension | **6/6 passed**, final review 0 Critical/Important/Minor |
| Task 8 focused | **3/3 passed** |
| Task 8 full extension | **7/7 passed**, final review 0 Critical/Important/Minor |
| Diff hygiene | `git diff --check` pass ở các mốc hoàn tất |

### Việc tiếp theo

1. Task 9: hoàn thiện popup và snapshot ngôn ngữ ngay tại click; không khóa hai nút đến `scope_done`.
2. Task 10: chạy cross-layer tests và browser acceptance cho single-page cache/replay, đổi ngôn ngữ, reconnect/service-worker restart, source swap và quota/error paths.
3. Chỉ sau acceptance mới cập nhật workflow as-is, đóng worklog verification và cân nhắc merge.

#mangatranslator/progressive-session-cache


---

## Cập nhật Task 9–10 — 2026-07-30

> [!success] Kết quả hiện tại
> Code và kiểm thử tự động Task 9–10 đã sẵn sàng tại commit `326273e`, branch `feat/progressive-session-translation`. Final clean-room review không còn finding Critical/Important. **P0 chưa hoàn tất** vì browser acceptance và benchmark thật chưa chạy.

### User nhận được gì

- Popup không khóa hai nút khi đang dịch; chỉ action mới nhất được cập nhật kết quả.
- Popup hiển thị `Đang dịch nền · Đã cache · Lỗi`; exact hit hiển thị `Khôi phục từ cache`.
- Ngôn ngữ được chụp tại lúc click, nên đổi Việt → Anh dùng đúng config, không bị cache cũ bỏ qua.
- Trang single-page đã dịch replay được từ session cache; callback/request/worker cũ không đè lên trang mới.
- Metrics đo queue/fetch/analysis/OCR/translation/overlay/total/cancel nhưng chỉ expose aggregate, không giữ URL hay text.
- Legacy OCR, progressive Port và prewarm dùng chung scheduler 2 slot.

### Task 9

- [x] `pageStatus` load khi mở popup và refresh sau action mới nhất.
- [x] Copy status/cache-hit đúng spec; pending actions giữ payload ngôn ngữ riêng.
- [x] Extension gate tại Task 9: **7/7 passed**.

> [!note] Minor deferred
> Callback stale return trước khi đọc `chrome.runtime.lastError`, có thể tạo warning nhưng không làm sai UI.

### Task 10 — phần tự động

- [x] Harness chạy production background/content qua paired fake Port + shared fake session storage/NDJSON; không gọi tắt helper.
- [x] Bao phủ stale A/B, exact replay, crop miss, near/far, replacement ở fetch/OCR/translation, worker death/restart, lỗi riêng từng stage, visible/loaded và popup status reopen.
- [x] `work-flow.md` và verification worklog repo phản ánh workflow/kết quả thật.
- [x] Metrics ring 100 sample, late warm `render_metric`, counter shared-producer exact-once.
- [ ] 10 browser cases thật.
- [ ] Ít nhất 20 cold + 20 warm sample.

### Những vòng khó/fail quan trọng

| Vòng | RED/finding | Nguyên nhân gốc | Kết quả |
| --- | --- | --- | --- |
| TDD đầu | Thiếu `scope_done.metrics` | Background chưa phát monotonic metrics | Thêm metrics + bounded summary |
| Fix 1 | Worker cũ vẫn chạy; cancel latency = tuổi request; sai `firstOverlayMs` | Harness chỉ disconnect; mốc đo và mapping sai | Kill capability VM cũ; clock `5000 → 0 ms`; trả `first_overlay_ms` |
| Fix 2 | Warm overlay render nhưng p50/p95 null | Request bị xóa trước khi metric quay lại qua Port | Correlation theo ring; bỏ ID lạ/đã evict |
| Fix 3 | Mixed Port + legacy peak **4** | Hai pool riêng, mỗi pool cap 2 | Một scheduler chung; peak **≤2**, giữ priority/FIFO |
| Fix 4 | Gemini gọi 1 nhưng counter đếm 2 | Cộng counter theo consumer/request | Dedupe theo producer identity qua request |
| Hypothesis fail | Dedupe per-request vẫn cho cross-request `1 → 2` | Request không đại diện call thật | Test đối kháng bác bỏ; union identity trong ring |
| Fix 5 | Telemetry giữ full producer graph | Sample giữ page, URL, OCR/translation text, Promise | Chỉ giữ record 3 số: calls, 429, stale |

> [!important] Vì sao các vòng review này quan trọng
> Test xanh ban đầu chưa đủ: lỗi chỉ lộ khi delivery Port bất đồng bộ, hai request share producer, hoặc legacy và progressive chạy đồng thời. Các fix đi vào ownership/lifecycle chung thay vì vá riêng từng callback.

> [!warning] Browser/benchmark còn pending
> Phiên này chỉ có Codex in-app browser, không có Chrome đã load unpacked worktree hoặc MV3 service-worker target. Fixture localhost mở được nhưng không chứng minh extension thật; vì vậy không đánh dấu pass và không tạo benchmark giả.

### Fresh verification cuối

| Gate | Kết quả |
| --- | --- |
| HEAD | `326273e` |
| Node extension | **8/8 passed** |
| Python server | **69 passed**, 3 warning dependency/tooling có sẵn |
| Diff hygiene | clean |
| Final clean-room review | **0 Critical, 0 Important** |

### Gate còn lại để gọi P0 complete

1. Load `D:\MangaTranslator\.worktrees\progressive-session-translation\extension` dưới dạng unpacked extension trong Chrome.
2. Chạy đủ 10 browser cases ở Task 10 Step 7.
3. Chạy ít nhất 20 cold + 20 warm `visible` trên cùng máy.
4. Đạt first-overlay p50 ≤ 5 s, p95 ≤ 8 s; total regression ≤ 10%; block count không giảm.
5. Ghi hardware, Chrome/Python/model version, timings, hit/miss, stale work, translation calls và 429 vào verification worklog rồi mới đóng P0.

#mangatranslator/progressive-session-cache/task9-task10

> [!warning] Browser retry sau khi user load extension
> Chrome đang chạy và user đã load MangaTranslator, nhưng Codex chỉ phát hiện in-app browser. Kiểm tra connector cho thấy ChatGPT Chrome Extension chưa được cài/enabled trong profile được chọn và native-host manifest/registry chưa tồn tại. Vì vậy Codex chưa thể điều khiển tab Chrome hoặc MV3 service worker; **0/10 browser case vẫn pending**, không có kết quả pass giả. Bước mở khóa: cài/reinstall Chrome plugin từ ChatGPT/Codex plugin UI trong cùng Chrome profile, rồi kết nối lại.

---

## Task 9–10 — browser acceptance có kiểm soát (2026-07-31)

> [!success] Kết quả đã kiểm chứng cho user
> - Popup chụp ngôn ngữ tại lúc bấm; action mới nhất thắng và đổi Việt → Anh dịch lại đúng cache key.
> - **Dịch trang đang xem** giữ cache phiên qua F5/chuyển A–B và khôi phục trang đã dịch.
> - **Dịch webtoon đã tải** ưu tiên ảnh gần B, hủy đúng A/B khi reload và không cho C đang xếp hàng lọt vào.
> - Worker MV3 replay nhưng kết quả cuối chỉ có một bubble; lỗi nguồn/OCR/batch dịch không làm mất kết quả hợp lệ khác.

### Bằng chứng cuối

| Gate | Kết quả |
| --- | --- |
| Node extension | **8/8 file pass** |
| Python server | **85 pass, 0 fail**, 3 warning đã biết |
| Chrome thật | Case **1, 6, 7, 8, 9, 10 PASS** |
| Extension | `dkfmlgjnanglgccfjfojakbdpgdlepbi` — một bản enabled |
| Worklog repo | `4201c34`; wording review sửa ở `4590ff8` |
| Server sau test | `server.main:app`, PID `25764`, CUDA, `page_schema=page-v1` |

### Kết quả browser quan trọng

- **Case 1:** A hoàn tất source nhưng bị giữ ở OCR; B thành `en:B:block-1`. Thả A không tạo translation A và không đè/nhân đôi B.
- **Case 6:** worker Stop/replay rồi hoàn tất `background=0 · cached=1 · errors=0`; DOM chỉ có một `vi:A:block-1`.
- **Case 7:** `source=2 · source_aborted=2 · active_source=0 · peak_source=2`; A/B bị hủy, C chưa từng vào.
- **Case 9:** giữ A/C nhưng overlay đầu tiên là `vi:B:block-1`; `cached=0` đúng vì loaded-webtoon không có cache-consumer phiên.
- **Case 10:** B lỗi OCR vẫn giữ B-1; C lỗi nguồn không làm mất A/B/D; D-1..D-3 lỗi nhưng D-4 vẫn hiện `vi:D:block-4`.

### Những phần khó và các lần fail/retry

> [!bug] `/health` thiếu version contract
> Retry đầu Case 1 báo `1 ảnh, 0 thoại, 1 lỗi` trước source fetch. Harness chỉ trả `page_schema`, nhưng `buildKeys()` cần đủ detector/dedupe/prep/recognizer/translator/prompt/policy. Fix `023b00c` bổ sung contract và review độc lập pass.

> [!warning] Prewarm làm nhiễu Case 7
> Popup từng tạo consumer prewarm riêng, có thể giữ B sống sau khi loaded scope bị hủy. Fix `a351855` chỉ bỏ prewarm trên fixture loopback:8910 có query `acceptance`; website thường không đổi. Review đầu phát hiện thiếu ba boundary test (localhost, sai port, thiếu query); `b2037be` bổ sung test và re-review pass.

> [!info] Fail do môi trường/thao tác, không phải bug sản phẩm
> - Lần đầu Case 7 vẫn ở `acceptance=reader`, nên chỉ A chạy và trang không cuộn. Đổi đúng `acceptance=loaded` mới có A/B/C.
> - Giữ request lâu qua nhiều vòng chat làm MV3 worker ngủ, content reconnect và replay A/B. Chạy liền “Translate → 3 giây → F5” loại nhiễu, cho đúng hai abort.
> - Case 6 từng còn ledger case trước (`background=1, cached=2`). Fake-runtime probes không tái hiện bug; Reload extension xóa `chrome.storage.session`, retry sạch pass.
> - Case 10 từng bấm nhầm **Dịch trang đang xem**, chỉ A chạy và cache=1. Reload + F5 rồi bấm đúng nút webtoon cho `4 ảnh, 4 thoại, 3 lỗi`.
> - A/B synthetic khác byte nhưng giống hình; phải dựa event label/overlay, không dựa mắt.
> - Tab localhost phụ trong in-app browser từng kích hoạt prewarm và làm bẩn counter; đã đóng tab và double reset.

### Trạng thái còn lại

- [x] **Case 8:** restart toàn bộ Chrome để xác nhận session cache bị xóa đúng vòng đời.
- [x] **Benchmark production:** đã chạy 20 cold + 20 warm trên cùng máy — xem [[Tiến độ MangaTranslator#Benchmark production — 20 cold + 20 warm (2026-07-31)|mục benchmark]]. Không có timing synthetic nào được dùng để tuyên bố hiệu năng thật.
- [x] Đã đóng P0 và merge: benchmark production xong, final whole-branch review sạch, `feat/v3` fast-forward vào `feat/v2`.

Liên quan: [[Tiến độ MangaTranslator#Cập nhật Task 9–10 — 2026-07-30|mốc Task 9–10 trước]].

#mangatranslator/progressive-session-cache/task9-task10
## Case 8 — full Chrome restart PASS (2026-07-31)

> [!success] Kết quả người dùng nhìn thấy
> Trước restart: `Đã cache: 1`. Sau khi đóng toàn bộ Chrome và mở lại: `Đã cache: 0`. Dịch lại Reader A hoàn tất `1 ảnh, 1 thoại, 0 lỗi` và tạo lại `Đã cache: 1`. Điều này xác nhận cache chỉ sống trong phiên Chrome và không làm mất khả năng dịch lại.

> [!info] Bằng chứng kỹ thuật và phần khó
> Log production phát sinh mới `GET /health`, `POST /ocr-stream`, `POST /translate-items`, nên đây là cold pipeline thật, không phải exact cache hit. Công cụ điều khiển Chrome không nối lại được sau full restart dù extension/native host đều khỏe; kiểm thử được tiếp tục thủ công. Đây là khó khăn của công cụ test, không phải lỗi MangaTranslator.

- Case 8: **PASS**, cache phiên đi theo chuỗi **1 → 0 → 1**.
- Gate chức năng còn lại lúc đó: benchmark production tối thiểu **20 cold + 20 warm** trên cùng máy — đã chạy xong ngày 2026-07-31.
- Repo worklog đã ghi bằng commit `4f40952`; review độc lập không có lỗi Critical/Important/Minor.

## Task 10 — chuẩn bị benchmark production (2026-07-31)

> [!success] Fixture benchmark đã sẵn sàng và review sạch
> Commit thiết kế `5378ecf`; commit triển khai `1d4d8c1`. Chế độ chỉ bật trên loopback với `?benchmark=cold`, không thay đổi file production của extension. Lượt đầu hiển thị `WARM-UP` và bị loại vì popup có thể prewarm OCR; sau đó fixture tự đổi sang 20 URL ảnh duy nhất, chỉ rearm khi overlay cũ đã được gỡ, rồi dừng ở `COMPLETE`.

- TDD: regression xác nhận RED đúng nguyên nhân `WARM-UP` chưa tồn tại, sau triển khai chuyển GREEN.
- Verification implementer: Node **9/9**, Python **85 pass**, 3 warning đã biết; `git diff --check` sạch.
- Review độc lập: **Approve**, không có finding Critical/Important/Minor; xác nhận fixture thường và production extension không đổi.

> [!warning] Các phần khó và retry — không phải lỗi MangaTranslator
> - Chrome control chặn truy cập trực tiếp `chrome-extension://.../popup.html` theo chính sách bảo mật, nên không được tự động hóa popup bằng đường vòng. User vẫn bấm popup thật.
> - Browser control cho phép đọc/click nhưng không cho chèn DOM hoặc đổi `src` bằng evaluate (`createElement`/`textContent` bị chặn). Vì vậy thêm controller nhỏ ngay trong fixture test, có regression riêng.
> - Port 8910 chỉ phục vụ production API nên `/fixture.html` trả Not Found; fixture thật phải chạy ở port 8000.
> - Cả fixture 8000 và API 8910 từng dừng khi chuyển phiên. Fixture đã bật lại; lần start API có redirect log bị đóng theo shell, retry tách rời thành công với PID `19228`. `/health` hiện `status=ok`, `device=cuda`, `page_schema=page-v1`.

### Trạng thái benchmark hiện tại

- [x] Lượt WARM-UP bị loại đúng thiết kế (mỗi pass một lượt).
- [x] Thu đủ **20 cold** thật.
- [x] Thu đủ **20 warm** thật.
- [x] Trích p50/p95 và counters, đối chiếu target.

## Benchmark production — 20 cold + 20 warm (2026-07-31)

> [!success] Gate TTFT đạt với biên rất rộng
> `first_overlay_ms` cold **p50 984ms / p95 1322ms** so với target **p50 ≤ 5s, p95 ≤ 8s**. Warm (exact page cache hit) **p50 4ms / p95 8ms** và **0 call server**.

| Chỉ số | cold p50 | cold p95 | cold max | warm p50 | warm p95 |
|---|---|---|---|---|---|
| `first_overlay_ms` | 984 | 1322 | 1401 | 4 | 8 |
| `total_ms` | 986 | 1323 | 1402 | 3 | 6 |
| `first_translation_ms` | 977 | 1315 | 1393 | — | — |
| `first_ocr_ms` | 207 | 240 | 538 | — | — |
| `queue_wait_ms` | 1 | 2 | 3 | — | — |
| `fetch_ms` | 4 | 4 | 5 | 0 | 0 |

- Cold: **20/20 `cacheHit=false`**, 20 URL nguồn khác nhau, `translation_calls=21` (20 sample + 1 warm-up bị loại), `rate_limited=0`, `stale_work=0`, 0 block lỗi.
- Warm: **20/20 `cacheHit=true`**, `translation_calls=0` — cache phiên đúng là zero-call.
- `blocks=1` ở cả 40 sample ⇒ **block count không giảm**.
- Bằng chứng thô: `docs/superpowers/worklogs/2026-07-31-cold-warm-benchmark.json`.

> [!info] Cách chạy được — phần khó đã gỡ
> Chrome 150 **bỏ hẳn `--load-extension`**, nên extension trong `.worktrees` được nạp bằng lệnh CDP `Extensions.loadUnpacked` với cờ `--enable-unsafe-extension-debugging`; ID vẫn là `dkfmlgjnanglgccfjfojakbdpgdlepbi` như các case acceptance. Mỗi sample được bắn đúng message mà popup gửi (`translatePage` scope `visible`) từ service worker, còn `fixture-benchmark.js` lo đổi ảnh. Giữ một phiên DevTools bám vào MV3 worker nên **không còn nhiễu sleep/reconnect/replay** như case 7 và case 9. Popup không hề được mở ⇒ **không có prewarm** hỗ trợ sample nào.

> [!warning] Giới hạn phải nhớ khi đọc con số này
> - `ja_page.png` là trang tổng hợp 800×1200 chỉ có **đúng 1 bóng thoại**. Vòng OCR chạy 1 lần/sample, trong khi trang manga thật chạy theo số block. Đây là **cận dưới** cho transport/scheduler/cache, **không phải** độ trễ đọc truyện thật.
> - Request OCR **đầu tiên sau khi server khởi động** phải dựng model: đo được `first_ocr_ms=9234`, `first_overlay_ms=10281`, so với ~207ms khi engine đã nằm sẵn.
> - Gate "total không chậm baseline quá 10%" **chưa đánh giá được**: repo không có số baseline tiền-progressive nào, còn đường `ocrImage` cũ chỉ OCR (không dịch) nên không so ngang được.

### Chốt nhánh

Bằng chứng benchmark commit `daf80e2` trên nhánh mới `feat/v3`, sau đó fast-forward vào `feat/v2`. Review lại toàn bộ delta `326273e..daf80e2` (20 commit chưa nằm trong lần review sạch trước) **không có finding Critical/Important**: `metadataEqual` trả false cho giá trị mảng nhưng `versions` từ `/health` chỉ gồm object/string nên so version vẫn đúng, và `return` sớm cho prewarm trong `attachDescriptor` không treo request vì prewarm không có port lẫn hợp đồng completion. Gate trên cây đã merge: Node **9/9**, pytest **85 passed** với 3 warning quen thuộc.


---

## Spec A — tạm dừng sau Task 2 (2026-08-01)

> [!info] Trạng thái phiên
> Phiên Subagent-Driven Development được dừng theo yêu cầu của người dùng sau khi Task 1 và Task 2 đã qua review. Task 3 mới chỉ được trích brief trong workspace SDD; chưa giao implementer và chưa có code Task 3.

### Spec và implementation plan đã chốt

- Spec đã duyệt: `docs/superpowers/specs/2026-08-01-telemetry-real-fixture-quality-gate-design.md`.
- Implementation plan: `docs/superpowers/plans/2026-08-01-telemetry-real-fixture-quality-gate.md`.
- Mốc trên `feat/v3`: `71cad75` hoàn tất spec handoff; `d258ccf` thêm plan 8 task/48 bước TDD.
- Ranh giới giữ nguyên: Spec A chỉ xây telemetry, fixture, policy probe và quality gate. Reading order/page-context translation thuộc Spec B; lỗi overlay chồng, crop trắng che chữ và trạng thái partial thuộc Spec C.

### Phần đã triển khai trong worktree hiện tại

- Worktree: `D:\MangaTranslator\.worktrees\spec-a-telemetry-quality-gate`
- Branch: `feat/spec-a-telemetry-quality-gate`
- HEAD khi dừng: `1a36e2f`

- [x] **Task 1 — server analysis telemetry**
  - Commit `43c0016`.
  - Thêm `Pipeline.analyze_with_status()`, giữ wrapper `analyze()`.
  - `analysis_ready` phát `analysis_ms` và `analysis_cache_hit`; hit sau khi chờ `_ocr_lock` vẫn được phân loại đúng.
  - Verification: Python **88 passed**, 3 warning dependency/tooling có sẵn.
  - Task review: PASS, không có Critical/Important/Minor.

- [x] **Task 2 — per-job metric row và Gemini call trace**
  - Commit triển khai `3949937`; fix review `1a36e2f`.
  - `scope_done.page_metrics` có đúng một row/job cho producer, warm page-cache hit và lỗi trước producer; aggregate cũ vẫn giữ.
  - Trace tách khỏi counter `translationBatches`, nên microbatch 3/8 production không đổi.
  - Fix round 1 xử lý ba finding Important: stage không chạy phải là `null` thay vì `0`; late consumer phải kế thừa shared-stage timing; HTTP 429 phải phân loại theo status thay vì body text.
  - Verification: toàn bộ JS suite **9/9 file pass**; scoped re-review xác nhận **3/3 addressed**, không có breakage mới.

- [x] **Task 3 — `first_overlay_ms` theo từng trang**
  - ==Mục này đã sai khi ghi==: lúc viết worklog Task 3 chưa triển khai, nhưng worktree hiện ở HEAD `01d1dfe` với đủ commit và production diff. Xem [[Tiến độ MangaTranslator#Spec A — code review Task 1–3 (2026-08-02)]].

### Trạng thái checkout/worktree

- Checkout chính `D:\MangaTranslator` vẫn ở `feat/v3`, HEAD `d258ccf` trước khi ghi worklog này.
- Worktree hiện tại sạch tại HEAD `1a36e2f`; các commit Task 1–2 chưa merge/cherry-pick về `feat/v3`.
- Người dùng xác nhận các `.worktrees` cũ được nhắc trong lịch sử trước đã bị xóa. Kiểm tra lúc dừng cho thấy chỉ còn worktree hiện tại `spec-a-telemetry-quality-gate`; không được nhầm các đường dẫn worktree cũ trong mục 2026-07-30/31 là workspace còn hoạt động.
- Không xóa worktree hiện tại trước khi tích hợp các commit `43c0016`, `3949937`, `1a36e2f`.

### Điểm tiếp tục ở phiên sau

1. Mở ledger ignored: `.superpowers/sdd/2026-08-01-telemetry-real-fixture-quality-gate/progress.md`; Task 1–2 đã complete.
2. Bắt đầu Task 3 từ brief hiện có và giữ message contract `render_metric` theo `job_id`; producer không được chờ UI.
3. Sau Task 3 mới tiếp tục fixture/ground truth, policy probe, evaluator và manual worklog theo plan.
4. Chưa có claim về policy Gemini mới, chất lượng Portuguese production hoặc fix overlay; các gate đó vẫn pending.

#mangatranslator/spec-a/telemetry-quality-gate

---

## Spec A — code review Task 1–3 (2026-08-02)

> [!warning] Kết luận
> **Task 1 PASS. Task 2 và Task 3 chưa nên coi là xong.** Task 2 có **1 finding Critical**: commit fix `1a36e2f` sửa phân loại 429 theo HTTP status, nhưng server không bao giờ trả 429 — nên mọi rate limit thật bị trace sai. Task 3 có **1 finding Important** về mốc đo `first_overlay_ms` lệch với mọi field còn lại trong cùng row. Không được merge về `feat/v3` trước khi xử lý hai mục này.

### Phạm vi và cách kiểm chứng

- Diff review: `d258ccf..01d1dfe` trên `feat/spec-a-telemetry-quality-gate` — `43c0016` (Task 1), `3949937` + `1a36e2f` (Task 2), `01d1dfe` (Task 3).
- Chạy lại gate tại HEAD `01d1dfe`: pytest **88 passed** (3 warning dependency có sẵn), Node **9/9 file pass**. Số trong worklog trước là đúng.
- Đối chiếu từng task với `docs/superpowers/plans/2026-08-01-telemetry-real-fixture-quality-gate.md`, gồm cả Global Constraints.

### Task 1 — server analysis telemetry (`43c0016`) → PASS

Đạt yêu cầu: `analyze_with_status()` trả `(artifact, cache_hit)`, wrapper `analyze()` vẫn có caller thật ở `server/pipeline.py:226` nên không phải code chết; hit sau khi chờ `_ocr_lock` được phân loại đúng và test dùng hai `Event` + `ThreadPoolExecutor` assert `detector.calls == 1` — đúng chỗ dễ sai nhất. Mojibake `server/main.py:160` đã sửa, không đụng error code.

> [!bug] Minor 1 — `analysis_ms` cộng thêm nhiễu scheduling
> `analysis_started = time.perf_counter()` nằm trong handler (`server/main.py:101`) nhưng `analysis_ms` được tính bên trong `stream()`, mà Starlette chỉ chạy generator khi bắt đầu gửi body. Warm hit vì thế không về ≈0 như kỳ vọng.
> Fix: chuyển `analysis_started` thành dòng đầu tiên của `stream()`.

### Task 2 — per-job metric row và Gemini trace (`3949937`, `1a36e2f`) → CẦN SỬA

Phần đúng: `emptyPageMetrics()` + spread trong `completeJob()` là điểm chuẩn hoá duy nhất, không có schema class, không có row giả `0`; ràng buộc "stage không chạy = `null`" giữ nhất quán tới tận `createProducer` (`durations: { fetch_ms: null, analysis_ms: null }`); aggregate cũ không vỡ vì `scopeMetrics.value()` lọc non-finite; `page_artifact_key` là hash (`extension/background.js:110`) nên không rò URL.

> [!danger] Critical — phân loại 429 sai trong production
> `extension/background.js:701` sau fix dùng `error.status === 429`. Nhưng server **không bao giờ trả HTTP 429**: `server/translator.py:109` bắt `APIError.code == 429`, retry/đổi client, rồi `raise TranslateError(last_err)`; `server/main.py:180` map thành **HTTP 502** với body `"gemini: 429 RESOURCE_EXHAUSTED..."`.
> Hệ quả: mọi rate limit thật bị ghi `status: "failed"`, `error_code: "translation_failed"` — đúng tín hiệu mà Spec A cần để chọn/bác policy dịch.
> Test không bắt được vì fake server trả `{ ok: false, status: 429 }`, một response server thật không phát ra được.
> Đồng thời `background.js:713` vẫn giữ `String(error).includes("429")` cho counter `producer.counters.rate_limited`, nên counter (đúng) và trace (sai) mâu thuẫn nhau trên cùng một lỗi. `1a36e2f` còn đổi body fixture `"429 quota"` → `"quota exceeded"`, làm counter không tăng trong chính kịch bản rate-limit mới thêm; không test nào assert `rate_limited > 0` nên regression này im lặng.
> Fix root-cause một chỗ cho cả hai caller:
> ```javascript
> function isRateLimited(error) { return error.status === 429 || String(error).includes("429"); }
> ```
> Test đi kèm phải dùng response **502** body `"gemini: 429 RESOURCE_EXHAUSTED"`, giữ thêm ca 502-không-429 → `failed`.
> Ghi chú: finding review vòng 1 ("phân loại theo status thay vì body text") đúng về nguyên tắc nhưng sai với codebase này.

> [!warning] Important — `translation_batches` không phải "mỗi Gemini call"
> Plan viết một trace row cho mỗi network Gemini call. Thực tế một trace = một call **extension → server**, trong khi server retry 2 lần và có thể đổi client (`server/translator.py:96-115`). `duration_ms` đã gộp retry, và số trace ≤ số Gemini call thật. Không phải bug code, nhưng evaluator sẽ đọc sai nếu spec giữ nguyên câu chữ. Sửa wording, hoặc để server phát số attempt.

> [!bug] Minor 2–6
> 2. `background.js:613` — `mark(producer, "first_ocr")` giờ thừa: producer tự nằm trong `stage.consumers` nên `applyOcrBlock` (`:643`) đã mark. Xoá được 1 dòng.
> 3. `acceptScope` truyền `meta.pageKey = descriptor.page_artifact_key`, nhưng `content.js` không bao giờ gửi field này → luôn `null`. Ý định trong plan ("key nếu đã tạo") chưa đạt.
> 4. `trace.cache_hit` là hằng `false` vì trace chỉ tạo trên nhánh network (đúng plan), nên field hiện vô nghĩa.
> 5. `batch_id: producer.translationBatches` tăng trước cả nhánh cache-only → có lỗ hổng số thứ tự, `batch_id` ≠ index trong mảng trace.
> 6. `failProducer` hardcode `error_code: "request_failed"` dù `producer.page.last_error` có nguyên nhân thật. Giữ hằng là an toàn về PII, nhưng nên map các mã stage đã biết (`ocr:<code>`).

### Task 3 — `first_overlay_ms` theo từng trang (`01d1dfe`) → CẦN SỬA

Phần đúng và khó: hợp đồng ba nhánh merge được xử lý đầy đủ — `content.js` giữ `firstOverlayByJob` và gửi `render_metric` kèm `job_id` đúng một lần/job; `background.js` chặn job lạ bằng `expectedJobIds`; row đã push trước khi overlay render (đường warm replay) được patch tại chỗ; metric đến sau `scopeDone()` patch bản sao đã sanitize trong `metricSamplesByRequest` chứ không tạo row mới. Aggregate scope dùng `Math.min` nên message lệch thứ tự không phá số cũ — test integration bắn `999999` cho request đã đóng và summary không đổi. `emit()` luôn kèm `job_id: consumer.jobId` nên guard bên content không bao giờ rơi vào key `undefined`.

> [!warning] Important — `first_overlay_ms` lệch mốc so với mọi field cùng row
> Global Constraint của plan: "`*_done_ms` và `first_*_ms` là elapsed từ lúc producer được accepted". Nhưng `content.js:147` đo từ `pending.startedAt` — thời điểm **scope** bắt đầu trong content script, không phải lúc producer của trang đó được accepted.
> Với `MAX_CONCURRENT = 2`, trang thứ ba trở đi phải xếp hàng, nên `first_overlay_ms` bị cộng cả queue wait trong khi `first_translation_ms` cùng row thì không. Hiệu `first_overlay_ms - first_translation_ms` (đúng thứ cần đo cho độ trễ render) sẽ over-report đúng bằng thời gian chờ.
> Row đã có `queue_wait_ms = started - accepted`, còn thiếu `accepted - scopeStart`. Fix rẻ nhất: thêm một field `accepted_offset_ms` (chênh trong cùng đồng hồ worker, tính tại `completeJob` từ `request.acceptedAt` và `producer.timings.accepted`) để evaluator chuẩn hoá. Cách còn lại là ghi rõ trong spec rằng field này có mốc khác và không so trực tiếp được với các `*_ms` khác.

> [!bug] Minor 7 — khoảng trống test
> Ca metric đến **sau `completeJob()` của job đó nhưng trước `scopeDone()` của scope** chỉ được phủ bởi dòng `if (row) row.first_overlay_ms = ...` mà không có test. Hai ca đã test là "trước mọi completeJob" và "sau scopeDone".

### Sai lệch so với worklog 2026-08-01

- Mục Task 3 trong [[Tiến độ MangaTranslator#Spec A — tạm dừng sau Task 2 (2026-08-01)]] ghi "chưa triển khai, không có commit" là **sai ở thời điểm đọc lại**: worktree đang ở `01d1dfe` với đủ diff production và test. Đã sửa checkbox tại chỗ.
- Xác nhận đúng: cả 4 commit vẫn **chưa merge/cherry-pick** về `feat/v3`.
- Xác nhận đúng: chỉ còn một worktree `spec-a-telemetry-quality-gate`.

### Việc phải làm trước khi merge về `feat/v3`

1. Sửa Critical 429 bằng `isRateLimited()` dùng chung cho cả trace lẫn counter, kèm test dựng response 502 đúng shape production.
2. Chốt mốc `first_overlay_ms`: thêm `accepted_offset_ms` hoặc ghi rõ mốc khác trong spec.
3. Gom các Minor 1–7 vào một commit dọn.
4. Chạy lại pytest + Node, rồi mới tích hợp `43c0016`, `3949937`, `1a36e2f`, `01d1dfe`.

#mangatranslator/spec-a/telemetry-quality-gate


## Spec A — đóng review Task 1–3 (2026-08-02)

- Task 3 giữ `first_overlay_ms` theo content scope start để tương thích lịch sử benchmark. Commit `0e9523f` thêm `accepted_offset_ms`; overlay quy về mốc producer xấp xỉ `first_overlay_ms - accepted_offset_ms`. Sai số còn lại là IPC + thời gian đánh thức service worker MV3. Giá trị âm hợp lệ khi producer dùng chung được accepted trước request đến sau.
- Commit `688be55` giữ đúng aggregate `scope_done.metrics.first_overlay_ms` khi metric đến muộn; commit `0e9523f` phủ thêm nhánh metric đến sau `completeJob()` nhưng trước `scopeDone()`.
- Task 2: commit `8a997a7` phân loại đúng Gemini 429 bị server bọc thành HTTP 502 và làm trace/counter dùng chung một rule. Wording đã làm rõ một `translation_batches` trace là một request extension → server; retry/failover Gemini có thể xảy ra bên trong.
- Cleanup review: commit `6063322` loại scheduling noise khỏi `analysis_ms` và bỏ mark `first_ocr` trùng.
- Fresh verification tại HEAD `6063322`: Python **89 passed**, toàn bộ **9/9** file test Node passed, `background.js`/`content.js` syntax passed, `git diff --check` passed, worktree clean.
- Review gate Task 1–3 hiện sạch. Chưa merge vào `feat/v3`; Task 4–8 vẫn còn trong kế hoạch.

## Spec A — Task 4 canonical real-page fixtures hoàn tất (2026-08-02)

- Commit `c6d963b` thêm 6 PNG canonical, manifest reviewed 7/21/17 regions, validator/matcher stdlib và mở rộng `server.diagnose` với `--device`/`--manifest-candidate`.
- Diagnostic CPU thật: PT 8 raw → 7 anchors; JA1 21/21 với vendor index 5 được đưa trước 3/4 và poster là `sign`; JA2 17/17 giữ thứ tự đã review. Cả 3 source và 3 failure reference đã được inspect trực tiếp.
- Review fix round 1 `e27aa52`: khóa PNG IHDR dimensions, đúng 6 fixture, unique image/fixture/region ID, exact ground-truth labels/anchors và ngưỡng IoU strict `> 0.5`.
- Review fix round 2 `62c93cf`: pin trực tiếp `reading_order` JA1 để mutation hoán đổi 3↔4 không lọt test. Re-review: overall clean.
- Fresh verification tại HEAD `62c93cf`: server **102 passed** (3 warning baseline), focused fixture+diagnose **16 passed**, 6 SHA-256 exact, không còn `.tmp-real-pages`/`.diag.*`, `git diff --check` và worktree clean.
- Task 4 hoàn tất; chưa merge vào `feat/v3`. Task 5 bắt đầu.

## Spec A — re-review Task 1–3: sửa contract offset âm (2026-08-02)

- Re-review người dùng xác nhận code Task 1–3 PASS; không còn Critical/Important trong code.
- Finding tài liệu được xác nhận: luật duration không âm mâu thuẫn với `accepted_offset_ms = -10` hợp lệ của shared producer.
- Commit `fc9b16e` sửa cả contract tổng quát và mô tả field: `accepted_offset_ms` là offset, không phải duration, và có thể âm khi request đến sau dùng producer đã được accepted trước.
- Verification doc-only: review diff, search contract liên quan, `git diff --check` pass; worktree clean.
- Ba Minor `trace.cache_hit`, khoảng trống `batch_id`, và taxonomy `failProducer` vẫn park/non-blocking theo review. Task 5 đã tạm dừng sạch trước khi có diff để chờ review theo gate mới.

## 2026-08-02 — Spec A Task 4: sửa theo re-review (9cf369c)

- Đã bổ sung term_groups cho JA1 theo schema canonical / accepted_source_forms / fixture_block_ids: マッコイ (b07, b20) và タツマキ (b05, b19). Validator khóa đúng field, canonical duy nhất, danh sách text hợp lệ, ít nhất 2 block khác nhau và mọi block phải tồn tại.
- Đã sửa lỗi báo sai khi role không hợp lệ; tăng kiểm tra known_order_failures; thêm assertion semantic cho thứ tự JA1; test ảnh tracked không còn phụ thuộc CWD; ignore .tmp-real-pages.
- Đã thêm allowlist phòng thủ cho HTTP translate_items: chỉ id và text đi vào prompt. Đây là boundary hiện tại, tách khỏi policy probe Task 5 dự kiến dùng id / text / reading_order / bbox.
- Giữ nguyên duplicate semantics vì nó biểu diễn ambiguity trong graph ứng viên IoU; Task 6 có thể phân loại warning. Giữ nguyên CUDA_VISIBLE_DEVICES vì đây là quyền điều khiển thiết bị của operator.
- Kiểm chứng: pytest toàn server 112 passed; 9/9 file test Node PASS; focused 37 passed; chạy từ thư mục server 19 passed; node --check và git diff --check PASS.
- Trạng thái: Task 4 sẵn sàng để review lại. Task 5 vẫn pending, chưa triển khai tiếp.

## 2026-08-02 — Spec A Task 5: deterministic policy probe (a7c16da, 8ff3bf5, b62d777)

- Đã thêm prompt eval comic-page-eval-v1 với allowlist riêng id / text / reading_order / bbox; không serialize kind, URL hoặc API key. HTTP production vẫn giữ contract id / text và không bị Task 5 thay đổi.
- Đã thêm ba arm batch_control, ordered_microbatch và full_page. Control bắt buộc exact baseline membership; ordered microbatch chỉ mượn dãy batch size trên expected reading order; full page dùng một batch đã sort.
- Runner CLI thủ công dùng đúng một GeminiTranslator và gọi _generate để giữ retry/failover production. Core nhận fake callable nên test không cần GEMINI_API_KEY và không gọi network. Preview latency được parse nhưng từ chối rõ cho tới khi Task 6 có gate chọn full_page.
- Capture giữ fixture SHA, prompt/policy version, baseline, attempt, batch membership, timing, response keyed theo fixture ID và taxonomy success / invalid_response / rate_limited / failed. Không chạy bù attempt lỗi.
- Commit: a7c16da (runner), 8ff3bf5 (giữ taxonomy 429/invalid response), b62d777 (UTF-8 validation và baseline guard trước model).
- Kiểm chứng fresh: focused 29 passed; toàn server 122 passed, 3 warning dependency baseline; CLI help PASS với GEMINI_API_KEY rỗng; diff check, mojibake scan, sensitive-data audit và worktree clean.
- Baseline audit phát hiện flake cũ ở test JS Task 2: scenario hai job dùng một fake error queue chung nhưng hard-code lỗi phải thuộc rate-job; stress fail 2/20 vì job flush trước không deterministic. Đây là test-fixture ordering, không phải regression Task 5, nên chưa sửa trong ba commit này.
- Trạng thái: Task 5 sẵn sàng để người dùng review. Task 6 vẫn pending, chưa bắt đầu.
## 2026-08-02 — Spec A Task 5: đóng human re-review (72c5cbf)

- Đã sửa đủ 3 Important: CLI tạo thư mục cha của `--out` trước khi chạy probe; `GENERATION_TEMPERATURE` là nguồn duy nhất cho cả translator và capture; metadata `{commit, device, model, temperature}` đi qua `run_quality_probe` nên capture hoàn chỉnh được test ở core, không còn vá hậu kỳ trong CLI.
- Đã nhận thêm các Minor có lợi trực tiếp: `calls[].started` giờ tương đối từ đầu probe; response text `None` thành `invalid_response`; test không còn đọc `decode.__defaults__`.
- Giữ nguyên missing-key traceback: đây là lỗi cấu hình runtime trước API call, không phải lỗi cú pháp CLI và không gây mất capture. Flake JS hàng đợi fake toàn cục vẫn tách riêng, không trộn vào Task 5.
- TDD đã quan sát RED cho cả output parent, shared temperature, core metadata, relative start và response `None` trước khi GREEN.
- Kiểm chứng fresh tại `72c5cbf`: focused 52 passed; toàn server 127 passed, 3 warning dependency baseline; chạy từ `server/` 33 passed; CLI help với key rỗng, `git diff --check` và mojibake scan đều PASS; worktree sạch.
- Trạng thái: Task 5 đóng và chờ người dùng review. Task 6 vẫn pending, chưa bắt đầu.
## 2026-08-02 — Spec A Task 6: offline quality gate (1fa3e15, 1546912, 34a591f)

- Đã thêm `validate_capture()` làm trust boundary deterministic: khóa schema/version/hash, exact metadata `{commit, device, model, temperature}`, exact page × arm × 3 attempt theo thứ tự, exact call/batch membership, status/error taxonomy và response IDs chỉ từ các call thành công. JSON bool không được giả làm integer; ID sai kiểu bị từ chối bằng `ValueError` có kiểm soát.
- `term_forms` là annotation thủ công explicit theo `canonical → fixture_block_id → target surface form`; conflict chỉ xét trong cùng response/attempt sau `strip().casefold()`. PT luôn bắt buộc RTL, ba mục context là `not_applicable`; response `None`/non-string được ghi `invalid_response` như đã bổ sung vào spec.
- Đã thêm `evaluate_gate()` hoàn toàn offline với bốn decision `selected`, `blocked`, `no_context_headroom`, `inconclusive`; dùng `statistics.median`, safety gate trước context gate, và tie-break bằng tổng call rồi tổng latency của toàn bộ attempt kể cả attempt lỗi.
- CLI hỗ trợ cả `run ...`, invocation legacy không subcommand, và `evaluate ...`; mode evaluate không import/khởi tạo Gemini và chạy được khi `GEMINI_API_KEY` rỗng. Test Task 5 cũng đã được siết để chứng minh thư mục output tồn tại trước khi core probe bắt đầu.
- Review độc lập vòng đầu phát hiện lỗi đúng hai valid responses, call schema lỏng, PT RTL bypass, tie-break bỏ attempt lỗi và fixture term conflict chưa declarative; toàn bộ đã đóng ở `1546912`. Re-review vòng trust-boundary đóng thêm bool/int alias và ID không phải chuỗi ở `34a591f`; không còn Critical/Important.
- Kiểm chứng fresh tại `34a591f`: focused 75 passed từ repo root và 75 passed từ `server/`; toàn server 169 passed, 3 warning dependency baseline; CLI help legacy/run/evaluate PASS với key rỗng; diff check, mojibake scan và worktree sạch.
- Trạng thái: Task 6 đóng, dừng chờ người dùng review. Chưa chạy Gemini/network/real browser; Task 7 vẫn pending. Flake JS concurrency fixture giữ thành task riêng như đã thống nhất.

## 2026-08-02 — Spec A Task 6: đóng human re-review (d7092a1, b35cc4f)

- Critical `decode_eval_items()` được xác nhận và sửa ở nguồn: item translation `None`, số, chuỗi rỗng hoặc chỉ khoảng trắng đều thành `invalid_response`, không còn bị ép thành `None`/`42` hay làm hỏng toàn capture. Guard `validate_capture` vẫn giữ làm defence-in-depth cho artifact sửa tay.
- Capture metadata giờ có đúng năm field `{captured_at, commit, device, model, temperature}`. `captured_at` phải là ISO-8601 UTC có timezone, CLI sinh một lần trước probe, evaluator echo nguyên giá trị và không tạo timestamp mới.
- Mâu thuẫn worklog Task 7 được đóng bằng contract nhỏ hơn: CLI `evaluate` chỉ sinh artifact deterministic dùng nguyên làm section `manual_review`; Task 7 ráp `telemetry_validation`, raw `policy_probe` và `manual_review`, rồi tái lập/so sánh riêng section evaluator. Không thêm envelope hoặc telemetry input chưa được thiết kế.
- Các Minor đã đóng: `--attempts` chỉ nhận `3`; baseline lỗi có prefix `capture không hợp lệ`; PT→RTL nằm ở manifest/capture boundary thay vì phụ thuộc manual scores; spec ghi rõ tie-break tính mọi attempt/call trên cả ba trang; blocked arm báo đủ các trang lỗi và mọi PT arm có `context_score: not_applicable`.
- TDD RED đã tái hiện 4 translation xấu lọt decoder, timestamp contract hai chiều, attempts sai đi tới I/O, baseline mất taxonomy, PT-LTR lọt manifest, report dừng ở trang đầu và PT arm thiếu context key trước khi GREEN.
- Kiểm chứng fresh: focused 87 passed từ repo root và 87 passed từ `server/`; full server 181 passed, 3 warning dependency baseline. Lần full đầu trong sandbox fail 2 OCR test vì không được đọc model cache/socket; chạy lại ngoài sandbox trên cùng HEAD pass 181/181.
- Đính chính mục Task 6 trước: metadata bốn field và câu “không còn Critical/Important” đã bị review này thay thế; sau `d7092a1` + `b35cc4f` các finding trong review hiện đã đóng.
- Trạng thái: Task 6 dừng chờ người dùng review lại. Task 7 chưa bắt đầu; chưa chạy Gemini/network/real-browser capture.

## 2026-08-02 — Spec A Task 6: re-review PASS và đóng 2 Minor (356d6b9, 1b7308c)

- Re-review tại `b35cc4f` kết luận PASS: Critical, hai Important và 5/5 Minor cũ đã đóng; Task 7 không còn blocker.
- Accept Minor tài liệu: `manual_review` được sửa thành nguyên artifact `evaluate` với `{captured_at, decision, reason, pages, arms}` và đủ bốn decision; rubric từng attempt vẫn ở `captures/2026-08-01-manual-scores.json`.
- Partially accept cách vá Minor evidence: bỏ nhánh skip để arm `inconclusive` vẫn ghi `critical_error`/safety quan sát được, nhưng giữ nguyên ưu tiên trạng thái `inconclusive` và thêm guard cho trang có 0 response hợp lệ để tránh `statistics.median([])`.
- Hai test hồi quy đã RED đúng hai lỗi: mất `critical_error` khỏi `reasons`, và crash ở 0 valid response; sau fix đều GREEN. Focused fresh đạt 89 passed từ repo root và 89 passed từ `server/`.
- Trong env resolver unpinned: 180 passed + 2 detector error do thiếu pkg_resources + 1 OCR failure do PaddleOCR API lệch. Trên venv dự án cùng HEAD 1b7308c: 183 passed, 3 warnings, 0 fail/0 error. Ba lỗi của env unpinned nằm ngoài diff Task 6.
- Commit code/test `356d6b9`; commit spec `1b7308c`; worktree sạch. Task 6 đóng và dừng chờ review; Task 7 chưa bắt đầu.
## 2026-08-03 — Spec A Task 7: real-page baseline + offline quality gate (277f9df)

- Capture thủ công dùng đúng Chrome thật, extension đã cài và popup thật trên fixture server 8000 với production API 8910/CUDA. Môi trường, fixture hash, model và toàn bộ page_metrics đã được lưu trong worklog JSON.
- JA1 cold: 21/21, analysis_cache_hit=false, batch 2+11+8, total page 14163 ms, first overlay 10509 ms; warm cache hit, first overlay 13 ms. JA2 cold: 17/17, batch 2+11+4, total page 12099 ms, first overlay 8954 ms; warm cache hit, first overlay 12 ms.
- PT chỉ là diagnostic vì production_pt_supported=false và dùng recognizer src_lang=es: 7/7, batch 1+1+2+1+2. Translation live PT không tham gia quality score.
- Hai run JA1 trước mẫu cold được chọn không bị giấu: run đầu chỉ dịch 3/21 do hai response Gemini decode/validation lỗi sau HTTP 200; run recovery có analysis cache hit nên không đủ điều kiện cold. Cả hai không được dùng làm baseline.
- Policy probe chạy đúng một lần với 3 page × 3 arm × 3 attempt: 27 attempt, 55 call success, 20 call rate_limited, 16 response hợp lệ. Không chạy bù attempt lỗi; preview probe không chạy vì condition_not_met.
- Rubric chấm đủ 16 response hợp lệ. Evaluator offline kết luận inconclusive vì JA1 batch_control chỉ có 1 response hợp lệ; không policy nào được chọn và không claim cải thiện chất lượng.
- Ba artifact commit: docs/superpowers/worklogs/2026-08-01-real-page-quality-baseline.json, captures/2026-08-01-policy-probe.json và captures/2026-08-01-manual-scores.json. manual_review tái lập đúng từ capture + scores.
- Kiểm chứng fresh: test_real_page_quality.py 89 passed; 27 attempt/16 score validate; decision tái lập inconclusive; diff check và sensitive-data scan sạch; scratch đã xóa; server tạm đã dừng.
- Task 7 hoàn tất ở commit 277f9df và dừng chờ review. Task 8 chưa bắt đầu.
## 2026-08-03 — Spec A Task 7: human rubric sign-off (7721576)

- Reviewer jaa đã đọc phiếu source → translation và xác nhận toàn bộ 16 rubric row hợp lệ. manual-scores giờ ghi reviewer=jaa cho đúng 16/16 row; điểm, critical_error, term_forms và note không đổi.
- Minor tài liệu đã sửa: điểm từng attempt, note và reviewer nằm ở captures/2026-08-01-manual-scores.json; section manual_review trong worklog giữ nguyên artifact evaluator.
- Evaluator tái lập tuyệt đối cùng kết quả inconclusive vì JA1 batch_control chỉ có một response hợp lệ; không policy nào được chọn.
- Kiểm chứng fresh: test_real_page_quality.py 89 passed; toàn server 183 passed, 3 warning baseline; diff check sạch; scratch human-review đã xóa.
- Commit 7721576. Dừng chờ re-review Task 7; Task 8 chưa bắt đầu.

## 2026-08-03 — Spec A Task 8: regression, audit và handoff

- Nhánh cô lập feat/spec-a-telemetry-quality-gate hiện ở ca7d435 (fix: preserve translation error taxonomy); Task 8 gồm 2eda03d, eef60a1 và fix whole-branch review ca7d435. Chưa merge vào feat/v3.
- work-flow.md đã ghi cách đọc scope_done.page_metrics, duration/elapsed/null, carve-out first_overlay_ms, các lệnh serve/capture/evaluate, quyết định quality hiện tại và cổng chuyển giao Spec B/C.
- Whole-branch review phát hiện false positive: lỗi JSON có chuỗi char 429 có thể bị ghi nhầm rate_limited. ca7d435 giữ code/error_kind có cấu trúc qua translator → /translate-items → extension/probe; rate limit, invalid_response và generation_error không còn suy từ message. Scoped re-review: PASS.
- Fresh automated verification tại ca7d435: pytest server/tests -q = 188 passed, 3 warning dependency; cả 9 file test JS PASS; node --check, CLI help, git diff --check và worktree cleanliness PASS.
- Evidence thủ công đã có từ Task 7: telemetry real Chrome cold/warm đã chạy; detector/OCR transcript và reading order canonical đã được người đọc review; reviewer jaa đã xác nhận đủ 16 rubric rows hợp lệ. Automated PASS không thay thế các evidence này.
- Quality decision vẫn inconclusive vì JA1 batch_control chỉ có 1 response hợp lệ. PT chỉ là diagnostic (production_pt_supported=false, recognizer es), không phải production proof. Spec B policy và Spec C overlay chưa triển khai.
- Dừng tại đây để chờ review Task 8 của người dùng.

### 2026-08-03 — Task 8 review fix (e90552a)

- Accept Important: work-flow.md đã đổi regression evidence từ 183 thành 188 passed để khớp HEAD sau 5 test taxonomy mới.
- Accept Minor: đã ghi contract lỗi máy đọc được của /translate-items: error_code rate_limited/invalid_response/generation_error; chỉ rate_limited dùng HTTP 429, hai loại còn lại dùng 502; consumer không suy taxonomy từ text error.
- Không triển khai ghi chú giả định về subtype ValueError/rate_limited vì chưa có type hoặc caller như vậy.
- Fresh verification: pytest server/tests -q = 188 passed, 3 warning dependency; 9/9 file JS PASS; git diff --check sạch. Chỉ work-flow.md thay đổi trong e90552a.
- Nhánh/worktree vẫn chưa merge; dừng chờ re-review Task 8.

## 2026-08-03 — Spec A paced quality-gate rerun: chọn `full_page`

- Pacing code ở `665769a`; capture checkpoint ở `7f96193`. Capture metadata trỏ đúng code commit `665769a5d25cb4d9e9d6933fa8fec883165b4ba3`, gồm 27 attempt / 75 logical call / 74 gap, minimum gap `10.0000673s`; 74 call success, 1 `invalid_response`, không chạy bù.
- Capture có 26 response hợp lệ. Reviewer `jaa` chấm đủ 26/26 rubric row; giữ nguyên hai lỗi thuật ngữ thật của JA1 `batch_control` (`Tatsumaki` bị dịch thành `lốc xoáy`) với `terms = 0`.
- Review phát hiện spec cũ không biểu diễn được term-form conflict dù rubric cho phép điểm 0. Commit `a6f3a24` sửa guard nhỏ nhất: surface form xung đột chỉ hợp lệ khi `terms == 0`; conflict với `terms` 1/2 vẫn bị từ chối. TDD đã quan sát RED, sau sửa test term-surface đạt 3 passed.
- Evaluator offline với nguyên điểm `jaa` trả `decision=selected`, `selected=full_page`, reason `candidate duy nhất đạt gate`. `ordered_microbatch` bị block; `full_page` pass.
- Commit quyết định `4e002bd`; worklog mới: `docs/superpowers/worklogs/2026-08-03-real-page-quality-gate-rerun.json`. `telemetry_validation_reference` tái dùng section `telemetry_validation` của worklog 2026-08-01 tại commit `277f9dfe62fda44c47239d86b82ac44c78786f7f`; không chụp browser telemetry mới.
- Fresh verification cuối Task 3: `pytest server/tests -q` = 196 passed, 3 warnings; score file khớp nguyên `points.json`, worklog khớp evaluator, sensitive-data scan 0 match và `git diff --check` sạch.
- Trạng thái: Spec B được phép bắt đầu với policy `full_page` sau checkpoint review này. Spec C vẫn hoãn tới checkpoint tiếp theo; chưa triển khai production Spec B/C.

## 2026-08-05 — Spec B Tasks 1–4: merge fixture, reading order và direction/cache

- Spec B đã qua design/plan review; triển khai trên `feat/v3` theo checkpoint review từng task. Plan: `docs/superpowers/plans/2026-08-04-reading-order-full-page-translation.md` (`7313536`, amendment `9237454`). Task 5 chưa bắt đầu.
- Task 1 PASS: merge Spec A bằng merge commit `9b1d153df7bccbb8dce34eaa451e47d32ee70bab`, parent Spec A `18bb9f875795ff2d8d80a5516e3b9ee5f1a74ffd`; fixture/control được đưa vào trước comparator và `full_page`.
- Task 2 PASS: baseline cuối `193 passed`, Node `9/9`, evaluator `98 passed`, semantic policy batch count `25`. Race timing telemetry test-only được ổn định ở `0d47b5c`; control worklog ở `c35569a`, giữ `control_baseline_commit=9b1d153...`.
- Task 3 PASS: `04e695e` thêm helper `extension/reading-order.js` và comparator Node gọi đúng helper production. Exact-match: `mangadex_pt` 7/7 (single), `s-manga_ja_1` 21/21 (spread, gutter 554.5), `s-manga_ja_2` 17/17 (spread, gutter 549.5); synthetic RTL/LTR, panel-gap, fallback, tall-bridge và mutation threshold đều xanh.
- Task 3 follow-up PASS: `c806f14` đóng arrival-order ambiguity bằng hai lớp — server loại exact normalized bbox trùng sau clamp/trước OCR, còn `orderPage()` reject duplicate full bbox; bump dedupe version thành `iou-0.5-area-clamp-exact-v3`. Gate: Python `25 passed`, ba Node gate PASS.
- Task 4 PASS: `1ee4b07` thêm UI `readingDirection` RTL/LTR (mặc định hiển thị RTL nhưng không persist lúc startup), snapshot theo request, và normalize đúng ba boundary `acceptScope`, `offlineLedger`, `prewarmJob`. `layout_order=reading-order-v1`; direction/layout không vào analysis/OCR key nhưng vào overlay/translation key; rollout purge page cache một lần, ledger sống sót.
- Gate Task 4: năm Node gate PASS, Python `17 passed, 1 warning`, `git diff --check` PASS. Không chạy `server/tests/test_ocr.py`.
- Deferred Minor không chặn: popup test mock `||=` có thể che việc xóa HTML ID; fake translation FIFO có race 429 trong harness, không phải regression production.
- Checkpoint hiện tại: HEAD `1ee4b0708436fad0209e29dc2284c40999286281`; Tasks 1–4 hoàn tất và đã review. Bước kế tiếp là Task 5 (PT/shared Latin engine và version-shape), chưa triển khai.

## 2026-08-05 — Đối chiếu plan ban đầu và bug trong Tasks 1–4

### Amendment của plan trước khi triển khai (`7313536` → `9237454`)

- **Task 3 — comparator fixture:** bản plan đầu duyệt toàn bộ `manifest.fixtures`, trong khi manifest có 3 `source_page` và 3 `failure_reference` không có `regions`, dimensions hay reading metadata. Cách cũ sẽ ném `TypeError` hoặc so với dữ liệu `undefined`. Amendment lọc `role === source_page` và assert đúng 3 trang trước khi exact-match.
- **Task 4 — default direction:** siết rõ `rtl` lúc startup chỉ là default hiển thị/state; không được tự ghi `readingDirection` vào storage. Test thêm `first.writes == []` để giữ nguyên nguyên tắc “chỉ persist field người dùng đổi”.
- **Task 4 — version-shape gate:** ghi rõ assertion shape cấp cao vốn đã PASS trước Task 4; red signal thật là thiếu `layout_order`. Việc kiểm sâu `recognizers` chỉ bắt đầu có ý nghĩa ở Task 5.
- **Task 4 — migration cache có chủ ý:** đổi context từ `{blockId, srcText}` sang `{reading_order, block_id, src_text}` tạo namespace hot-translation cache mới; bump `layout_order` cũng purge coarse page cache một lần. Đây là migration cost đã duyệt, không phải regression.

### Phát hiện khi thực thi và cách xử lý

#### Task 1 — merge Spec A

- **Lệch so với plan:** không có. Merge nguyên branch Spec A bằng merge commit hai parent `9b1d153`, đúng thứ tự fixture/control trước comparator và `full_page`.
- **Bug:** không phát hiện conflict hay regression; các dirty/untracked file ngoài phạm vi được giữ nguyên.

#### Task 2 — baseline/control

- **Bug:** `progressive-integration.test.js` thỉnh thoảng đọc `cancel_latency_ms.p50` khi metric replacement cancellation chưa được ghi. Race xảy ra vì `acceptScope()` có `await`, producer chạy ở task queue khác, và request cũ có thể đã bị `scopeDone` xóa khỏi `requests` trước lúc `releaseRequest(oldRequestId)` chạy; tái hiện 17/50 vòng.
- **Thay đổi so với plan:** thêm Task 2a test-only, commit `0d47b5c`; production code không đổi.
- **Cách xử lý:** nâng `eventually()` để `await` được async predicate và chờ `replacement.summary().cancel_latency_ms.p50` hữu hạn trước khi cho held pipeline chạy tiếp. Sau đó mới đóng control worklog ở `c35569a`.
- **Kết quả:** baseline ổn định: Python `193 passed`, Node `9/9`, evaluator `98 passed`, policy batch count `25`.

#### Task 3 — reading order

- **Bug contract/thuật toán:** hai block có bbox giống hệt làm mọi geometry sort key hòa nhau; `Array.sort` stable sẽ vô tình giữ arrival order, trái invariant “không dùng arrival/vendor/block ID”. Đây không chỉ là fake input: hai detector region khác nhau có thể trở thành cùng bbox sau clamp vào crop boundary; dedupe IoU trước clamp không bảo vệ được ca này, dẫn tới OCR hai lần và hai block cùng tọa độ.
- **Thay đổi so với plan:** ngoài helper/comparator extension ở `04e695e`, thêm follow-up `c806f14` chạm `server/pipeline.py`, `server/tests/test_pipeline.py`, `server/config.py` và guard/test phía extension — các file server này chưa nằm trong map Task 3 ban đầu.
- **Cách xử lý hai lớp:** server dedupe exact normalized bbox ngay sau clamp và trước tạo crop/OCR; `orderPage()` reject duplicate full bbox để chặn cache cũ, fake caller hoặc regression upstream. Test phủ cả hai hoán vị input và ca hai bbox cùng x/y nhưng khác size vẫn hợp lệ.
- **Cache migration:** bump dedupe version từ `iou-0.5-area-bbox-v2` lên `iou-0.5-area-clamp-exact-v3`, tránh tái dùng artifact cũ có duplicate geometry.
- **Kết quả:** Python focused `25 passed`; comparator exact-match cả 3 fixture và toàn bộ synthetic/mutation gate PASS.

#### Task 4 — direction/version/cache

- **Lệch so với final plan:** không có thay đổi production ngoài phạm vi đã duyệt; implementation `1ee4b07` đi đúng ba normalization boundary (`acceptScope`, `offlineLedger`, `prewarmJob`) và đúng phân tầng key.
- **Bug mới:** không phát hiện production bug. Các RED ban đầu (control direction rỗng, descriptor thiếu field, thiếu `layout_order`) là TDD signal dự kiến, không phải regression.
- **Kết quả:** năm Node gate PASS, Python `17 passed, 1 warning`, `git diff --check` PASS.

### Minor còn mở, không được ghi nhầm là đã sửa

- Popup harness dùng mock `||=` nên có thể che regression xóa `readingDirection` hoặc `currentLanguages` khỏi HTML. Reviewer xếp Minor; chưa sửa trong Tasks 1–4.
- Fake translation FIFO có race 429 trong harness. Scoped review xác nhận không phải regression production; không thêm workaround vào production, để lại cho đợt cleanup test harness.
- Không chạy `server/tests/test_ocr.py` trong bất kỳ gate nào vì file này load model thật và ảnh fixture; finding tĩnh liên quan file được xác nhận bằng đọc source.

- Đính chính ký hiệu ở amendment Task 3: comparator lọc trường role có giá trị literal source_page; đây không phải tên biến JavaScript.

## 2026-08-05 — Spec B review fix Tasks 3–4

- Review sau checkpoint Tasks 1–4: Tasks 1, 2 và 4 giữ nguyên PASS; Task 3 cần bổ sung hồ sơ clamp và regression test. Không revert code.
- **Finding Important về `c806f14`:** commit này thực tế gồm hai thay đổi độc lập: (1) clamp detector bbox thành giao thật với work image, nên bbox tràn mép có đúng width/height phần còn nằm trong ảnh và region hoàn toàn ngoài ảnh bị loại; (2) dedupe exact normalized bbox sau clamp trước crop/OCR. Version `iou-0.5-area-clamp-exact-v3` bao phủ cả hai về cache identity.
- Commit `f84bc3b` thêm regression test detector bbox `(-40, 10, 20, 20)` phải cho `analysis.regions` rỗng. Mutation về clamp semantics cũ cho RED đúng nguyên nhân: sinh region ma `(0, 10, 20, 20)`; khôi phục code hiện tại cho GREEN.
- Task 3 cũng khóa hai hành vi đã duyệt bằng expected viết tay: connected-components được phép chain khi bridge đạt ngưỡng `0.5` với hai hàng; RTL/LTR sort trong band theo `bbox[0]` (cạnh trái), kể cả bbox lồng/lệch. Không đổi thuật toán.
- `stable_block_id` vẫn giữ tham số ordinal để tránh API churn ngoài scope; pipeline truyền `0` có chủ ý vì exact normalized bbox giờ unique.
- Commit `a7dab1a` sửa hai Minor Task 4: row cache có `reading_direction` sai được cô lập/xóa theo từng job thay vì làm `ready` reject hoặc nhân đôi job hợp lệ; popup gửi direction explicit cùng `srcLang`/`dstLang`, content normalize và snapshot direction của chính action nên click ngay sau đổi hướng không phụ thuộc `storage.onChanged`.
- Commit `73c3c73` cập nhật design spec với clamp semantics, cache version và các quyết định Task 3/4 trên.
- Verification của implementer: toàn bộ 10 Node test scripts PASS; `server/tests/test_pipeline.py` + `test_artifacts.py` = `28 passed`; syntax và `git diff --check` PASS. Không chạy `server/tests/test_ocr.py`.
- Independent reviewer Terra medium: **PASS** cho cả spec compliance và task quality; không còn Critical/Important/Minor chặn Task 5.
- Deferred sang Task 6: normalize field cấp scope trước job loop và map lỗi `orderPage()` vào taxonomy job/producer thay vì unhandled rejection. Fake translation FIFO race vẫn là harness flake đã biết.
- Checkpoint mới: HEAD `73c3c73`; Task 5 chưa bắt đầu.


## 2026-08-05 — Spec B Task 5: Portuguese dùng chung Latin OCR

- Commit `fec60ac64069380a7a163b20f4df976d167e2cbb` thêm `pt` vào public language contract, popup và translator; `config.LANGS` là nguồn production duy nhất.
- ES/PT vẫn là hai alias và hai OCR cache identity riêng, nhưng dùng chung một instance `PaddleLatinEngine` cache theo class. Paddle được pin `lang=es`, `ocr_version=PP-OCRv6`; không tạo engine `lang=pt` thứ hai.
- Recognizer versions: JA `manga-ocr-v1`; ES/PT cùng `paddleocr-latin-ppocrv6-v1`. Acceptance `/health` giữ shape riêng và có recognizer PT.
- Verification: server `199 passed, 2 warnings` với `server/tests/test_ocr.py` bị loại tuyệt đối; full Node gate `2×10/10`; fake probe xác nhận shared instance, một init và exact Paddle kwargs; `git diff --check` sạch.
- `server/tests/test_ocr.py` chỉ đổi expectation tĩnh `['ja', 'es', 'pt']`, không chạy model/fixture test này.
- External review: **PASS**, một Minor không chặn deferred sang Task 6 — `server/acceptance_app.py` quảng cáo PT nhưng `/ocr` và `/translate-items` còn allowlist `{ja, es}` tại dòng hiện hành 350 và 406. Task 6 phải thêm `pt` vào đúng hai literal và giữ gate từ chối `fr`.
- Dirty user files và deletion `Welcome.md` được giữ nguyên, không stage. Chưa push; Task 6 chưa bắt đầu.

## 2026-08-05 — Spec B Task 6: strict contract và full-page vertical slice

- Commit `a37fbdec0dd2dd2d717a9fd754a07b98a475540b` thay microbatch bằng một request dịch toàn trang sau `image_done`; policy/prompt được bump nguyên tử thành `full-page-v1` và `comic-page-items-v2`.
- `server/contracts.py` là nguồn Pydantic contract dùng chung cho production/acceptance: exact fields, bbox 4 số không âm, dimensions dương, direction bắt buộc, ID unique và `reading_order` dense theo array. Lỗi `/translate-items` dùng `error_code=invalid_request`; route khác giữ FastAPI `detail`.
- Background tạo ordered shallow-copy bằng `MangaReadingOrder.orderPage()`, dùng decoded `image_w/image_h`, gửi tối đa một request/producer. Zero/all-hot không request; partial-hot gửi lại toàn page; response ID được validate nguyên tử trước cache/render; stale success chỉ warm cache.
- Đã xóa toàn bộ queue 3/8, timer 250/500 ms, pending/attempted IDs, numeric batch counter, translation chain và phase `microbatch`. Năm scenario được duyệt đã rewrite sang semantics full-page.
- Deferred review đã đóng: invalid direction phát đúng một `scope_error`; duplicate geometry và invalid dimensions đi qua `failProducer/completeJob` với error code máy đọc được; acceptance `/ocr-stream` và `/translate-items` nhận PT, vẫn từ chối `fr`.
- Fresh controller verification: server `211 passed, 2 warnings` với `server/tests/test_ocr.py` bị loại tuyệt đối; Node `2×10/10`; deletion/static tripwire PASS; control baseline không đổi; staging rỗng.
- Independent reviewer Terra medium: **Spec Compliance PASS**, **Task Quality Approved**, không có Critical/Important/Minor. Task 7 full offline/quality checkpoint chưa bắt đầu; chưa gọi vertical slice là đóng.

### 2026-08-05 — External review Task 6

- Verdict giữ **PASS**; không có Critical/Important. Hai Minor dưới đây chưa sửa và phải còn trong final whole-branch triage.
- Minor 1: `replayPage()` chỉ replay translation khi `cacheHit`. Trong cửa sổ producer đã set `page.state=complete` nhưng chưa persist, consumer mới có thể gắn vào producer, nhận `image_done` thành công nhưng không nhận translation event. Correction đề xuất: replay khi `cacheHit || page.state === complete`; thêm regression test giữ completion persistence. Partial-hot vẫn không replay.
- Minor 2: scenario `partial page replays complete blocks and requests only missing IDs` đã đổi assertion sang full-page nhưng chưa đổi tên. Rename thành `partial page requests the complete ordered page without replaying cached blocks`.
- Không sửa production/test và không tạo commit ở checkpoint review này. Task 7 chưa bắt đầu.

## 2026-08-05 — Spec B Task 7: full offline checkpoint

- Commit checkpoint `18aa2f8ef435d91b92494495119583e9cfda05a2` chỉ cập nhật worklog Spec B; implementation được khóa tại `a37fbdec0dd2dd2d717a9fd754a07b98a475540b`.
- Full server gate: `211 passed, 2 warnings`; lệnh có explicit `--ignore=server/tests/test_ocr.py`. File test OCR model thật không được chạy.
- Full Node suite tuần tự: `10/10`; comparator reading-order exact-match đủ 3 source fixture và synthetic gates. Evaluator offline: `98 passed`; semantic policy batch count: `25`.
- Frozen control tại `9b1d153...` không đổi; versions chốt `reading-order-v1`, ES/PT `paddleocr-latin-ppocrv6-v1`, `comic-page-items-v2`, `full-page-v1`; obsolete microbatch match = 0.
- Independent reviewer Terra medium: PASS, không có Critical/Important/Minor cho Task 7. Đây chỉ là offline vertical-slice checkpoint; chưa tuyên bố runtime telemetry hoặc live quality hoàn tất.
- Hai Minor Task 6 vẫn deferred: race replay cho consumer gắn vào producer đã complete trước persist, và tên scenario partial-page đã lỗi thời. Không sửa lén trong Task 7.
- Không push; dirty files của user và deletion `Welcome.md` giữ nguyên. Dừng trước Task 8 để chờ review.


## 2026-08-05 — Spec B post-checkpoint fix `8a4b08d`

- Commit `8a4b08d3d43c9d8510bf4bef6ed8e24f1ff59679` đóng hai Minor Task 6: consumer đến sau khi producer đã `complete` nhưng còn chờ persist được replay translation; scenario partial-hot được đổi tên đúng semantics full-page.
- Worklog Task 7 vẫn pin checkpoint implementation tại `a37fbdec0dd2dd2d717a9fd754a07b98a475540b`; `8a4b08d` là production fix phát sinh sau checkpoint, không viết lại lịch sử evidence.
- Fresh verification tại HEAD `8a4b08d`: server `211 passed, 2 warnings` với explicit `--ignore=server/tests/test_ocr.py`; Node `10/10`. Không chạy model/fixture test `server/tests/test_ocr.py`.
- Follow-up mở cho final whole-branch triage: consumer có thể gắn vào terminal producer `partial` sau vòng `completeJob()` nhưng trước `producers.delete()`, rồi không nhận `image_done`/`scope_done`. Correction đề xuất là xóa producer khỏi map trước khi await `removeProducerJobs()` trong cả `finishProducer()` và `failProducer()`; chưa sửa production trong lượt cập nhật hồ sơ này.


## 2026-08-05 — Spec B Task 8 runtime + final whole-branch review

- Runtime được capture trên `feat/v3` từ build `bec403b`; worklog telemetry: `b46b716`, amendment evidence: `78bcf2f`.
- JA1 RTL network: 21 block, `ocr_done=38 ms`, `first_overlay=23782 ms`, đúng một batch `full_page`.
- JA1 translation-memory hot: 21 block, `first_overlay=26 ms`, `translation_batches=[]`, `translation_calls=0`; đây không phải page-artifact cache hit.
- JA2 RTL post-reset: 17 block, `ocr_done=35 ms`, `first_overlay=3314 ms`, đúng một batch `full_page`. Popup prewarm được quan sát nên không gọi đây là model-cold.
- LTR manual: popup/content/background/request đều mang `reading_direction=ltr`, kích thước 1105×868, 17 item.
- PT public: OCR/request mang `src_lang=pt`, RTL, kích thước 500×782, 7 item; `ocr_done=5095 ms`, `first_overlay=48725 ms`.
- Shared Latin observation có giới hạn: cùng PID server, Paddle creation markers `0 → 4` khi PT và vẫn `4` sau ES prewarm; chỉ kết luận ES không tạo sequence thứ hai trong cùng process, không suy marker thành proof unique instance.
- Trade-off được xác nhận: mọi network `full_page` chỉ có translation/overlay sau `ocr_done`; đây là đánh đổi context toàn trang, không phải claim tối ưu latency.

### Final review fix

- Final whole-branch review phát hiện race merge-blocking: late consumer có thể gắn vào terminal `partial` producer trong cửa sổ awaited cleanup và mất `image_done`/`scope_done`.
- Commit `3fc910d` xóa producer khỏi map trước `await removeProducerJobs()` ở cả `finishProducer()` và `failProducer()`; regression giữ đúng cleanup window bao phủ `partial` và `failed`.
- Popup harness Minor cũng đóng: bỏ fallback mock cho `readingDirection`/`currentLanguages`.
- Regression RED: timeout chờ `scope_done`; mutation đưa delete trở lại sau await tái tạo lỗi. GREEN: focused background/popup và full Node suite `10/10`.
- Commit `9353618` đóng follow-up trong worklog và pin đúng SHA production `3fc910d`; net diff không còn artifact `.superpowers/sdd`.

### Trạng thái checkpoint

- HEAD hiện tại: `935361855cc34d10ca0abd6d8e3becf9d0fa2f7a`.
- Frozen control Spec A và privacy scan sạch; không chạy live-quality hay `server/tests/test_ocr.py`.
- Task 8 review và final-fix scoped re-review đều PASS; không còn finding Critical/Important mở.
- Chưa gọi Spec B hoàn tất cho tới khi người dùng duyệt checkpoint cuối. Việc xóa `Welcome.md` vẫn được giữ nguyên và không nằm trong commit Spec B.

## 2026-08-05 — Spec B post-final review stale-stage follow-up

- Review sau `9353618` phát hiện cửa sổ hẹp: producer đã bị xóa khỏi map nhưng OCR/analysis stage cũ chưa release trong lúc `removeProducerJobs()` đang await; request muộn sau lỗi trước `ocr_done` có thể bám vào promise đã reject và fail mà không retry.
- Commit `1855a2700d35362619208579cca185aab14782ff` đổi cả `finishProducer()` và `failProducer()` sang thứ tự đồng bộ `releaseProducerStages()` → `producers.delete()` → `await removeProducerJobs()`.
- Regression `pre-ocr-failed`: thứ tự cũ RED `{translated:0, failed:1}`; bản sửa GREEN `{translated:1, failed:0}`, tổng call `source=2`, `ocr=1`, `translate=1`.
- Focused `background-progressive.test.js` và full Node suite `10/10` PASS; Terra medium re-review không còn finding Critical/Important/Minor. `server/tests/test_ocr.py` không chạy.
- Worklog record commit: `32718b2`; Spec B vẫn chờ người dùng duyệt checkpoint cuối.

## 2026-08-05 — Spec B closed

- Người dùng duyệt checkpoint cuối: Spec B `reading-order-full-page-translation` hoàn tất, không còn finding mở; pull request đã được người dùng tạo và nhánh kế tiếp là `feat/v4`.
- Final implementation: `1855a2700d35362619208579cca185aab14782ff`; pre-closure worklog: `32718b2c1291fd7a9db3ee331b1207acb639aac5`; verification HEAD trên `feat/v4`: `e0e948e58c3e00513e28f15fdb139eac5415dbe1`.
- Fresh close gate: Python `211 passed, 2 warnings`; Node `10/10`; `server/tests/test_ocr.py` bị loại và không chạy.
- Chấp nhận trade-off: Spec B ưu tiên reading order tất định, chất lượng context toàn trang và một translation request mỗi page; cold first-overlay latency là debt riêng, không phải claim tối ưu latency.
- Các dòng HEAD/checkpoint cũ phía trên là snapshot lịch sử; mục này là trạng thái đóng hiện hành. Bước tiếp theo: brainstorm Spec C về overlay an toàn.

## 2026-08-09 — Spec C: in-place clean overlay rendering (Tasks 1–2)

### Design spec

- Design `docs/superpowers/specs/2026-08-08-in-place-clean-overlay-rendering-design.md` chốt kiến trúc phân tầng analysis/OCR/render, giữ tọa độ public ở page-space và tách clean-patch khỏi OCR.
- Hồ sơ spec + plan được tạo tại `b07d192`; các finding review cuối của plan được đóng tại `5325561`.

### Implementation plan

- Plan `docs/superpowers/plans/2026-08-09-in-place-clean-overlay-rendering.md` được duyệt để triển khai theo checkpoint, TDD và review độc lập từng task.
- Task 3 chịu trách nhiệm migrate `server/pipeline.py` sang contract `DetectionResult`; vì vậy call site cũ ở pipeline được defer có chủ ý trong checkpoint Task 2.

### Task 1 — artifact primitives

- Commit `82c122bee95bf534a7554f04d6f0b211e9f80435` (`feat: add spec c artifact primitives`) thêm `PreparedFragment`, mở rộng `PreparedRegion`, thêm render artifact và chính sách LRU từ chối item vượt byte cap mà không phá entry cũ.
- Verification: `server/tests/test_artifacts.py` = **6 passed**; independent review = **PASS**.

### Task 2 — detector adapter + region resolver

- Detector trả `DetectionResult`; `diagnose_image()` dùng `.regions`; resolver tách namespace component/fragment, dedupe exact union bbox theo thứ tự tất định và giữ mask/source geometry cho bước chuẩn bị artifact.
- Review finding đã đóng đủ bốn mục: diagnose contract, grouping-key collision, duplicate union bbox và real-detector tests dùng `result.regions`.
- Verification được người dùng duyệt: targeted gate **20 passed, 2 deselected**; detector adapter **2 passed, 2 deselected**; `git diff --check` exit 0 (chỉ cảnh báo LF/CRLF). Hai real-model tests không chạy, đúng gate đã duyệt.
- Trạng thái checkpoint: Task 2 **PASS**, thay đổi vẫn chưa commit; bước kế tiếp là Task 3 migrate pipeline/OCR stream.

## 2026-08-09 — Spec C Tasks 2–4: page-space OCR và lossless render artifact

### Chuỗi commit đã xác minh

- Task 2: `5f61499` — `feat: add detection result and region resolver`.
- Task 3: `aeb8006` — `feat: integrate page-space fragment ocr`.
- Task 4: `d1e2d1f` — `feat: build lossless render artifacts`.
- Dòng checkpoint trước đó ghi Task 2 chưa commit là snapshot lịch sử tại thời điểm ghi; mục này supersede trạng thái hiện hành. Worktree `feat/v5` và index sạch sau commit Task 4; chưa push.

### Task 3 — pipeline page-space và OCR theo fragment

- Pipeline chuyển sang `DetectionResult`, resolve region trước khi chuẩn bị artifact, cộng crop offset đúng một lần và giữ mask bằng buffer sở hữu riêng để byte accounting khớp dữ liệu cache thật.
- OCR chạy theo từng fragment, sort ngang/dọc rồi nối bằng newline. Dedupe fragment dùng **text trùng hoặc geometry overlap mạnh**; lazy `OcrRegistry.get()` và từng `engine.read()` được khóa riêng để không khởi tạo model hai lần.
- Review corrections đã đóng: materialize raw/refined masks, sửa dedupe từ `and` thành `or`, và serialize lazy engine initialization.
- Verification: focused **37 passed, 1 warning**; gate Task 1–3 **57 passed, 2 deselected, 1 warning**. Warning duy nhất là `StarletteDeprecationWarning` từ dependency.

### Task 4 — clean patch lossless và fit geometry

- `server/rendering.py` tạo `RenderArtifact` schema `render-v1` với Telea inpaint (`radius=3`), feather inward `2px`, fit padding `4px`, PNG RGBA lossless và `patch_id` phụ thuộc encoded bytes cùng page-space patch bbox.
- Capability fail closed: unbounded → `unsupported_region`; mask/source không hợp lệ → `clean_failed`; container/interior không bố trí an toàn → `layout_failed`. Test pixel khóa alpha ngoài refined mask bằng 0, raw ink bằng 255, offset page-space và round-trip không đảo kênh đỏ/xanh.
- Review ban đầu nêu container chạm biên source ROI là open. Reconsideration **WITHDRAW confirmed**: resolver xác định `bounded` theo biên ảnh đầy đủ trước khi crop `source_bbox` khít component, nên container hợp lệ chạm biên ROI là trạng thái bình thường. Important và Minor liên quan đã được reviewer retract; final verdict **PASS**, không có finding mới.
- Verification Task 4: **8 passed**. Gate Task 1–4: **65 passed, 2 deselected, 1 warning**; warning duy nhất là `StarletteDeprecationWarning` từ dependency. Commit diff sạch; worktree và index sạch.
- Không chạy hai real-detector tests, real-model tests hoặc `server/tests/test_ocr.py`, đúng gate đã duyệt.

> [!success] Checkpoint Spec C Task 4
> Tasks 1–4 đã PASS và được commit riêng. Bước triển khai kế tiếp là Task 5; chưa bắt đầu trong checkpoint này.
## 2026-08-09 — Spec C Tasks 5–8 và post-review fixes

### Trạng thái xác nhận

> [!success] Task 5 và Task 7 đã PASS
> Hai finding Medium hậu kiểm đã được xác minh, sửa bằng TDD, review độc lập và commit riêng. Final combined review không còn finding Critical/Important/Medium.

### Chuỗi commit mới nhất

- Task 5: `1362c7f` — `feat: add render artifact cache and api`.
- Task 6: `866e906` — `feat: add strict sfx translation contract`.
- Task 7: `7b6cfd7` — `feat: persist strict page-v2 cache`.
- Task 8: `cd69c37` — `feat: add content-hash source identity`.
- Post-review fix Task 5: `fed64d4` — `fix: retain analysis for render artifacts`.
- Post-review fix Task 7: `78edc37` — `fix: require translated manifest blocks`.

### Task 5 — render artifact cache/API và correction

- Thêm `/render-artifact`, render singleflight/cache và contract `render_artifact_key`; đường `/ocr-stream` chuẩn bị render cho cả cold và warm analysis.
- Review fix `fed64d4`: `/render-artifact` giữ chính `AnalysisArtifact` vừa resolve ở cả upload và warm/no-image path, rồi truyền `analysis=analysis` vào `ensure_render()`. Vì vậy LRU eviction giữa analyze và render không còn biến upload hợp lệ thành `409 artifact_missing`.
- Regression RED tái hiện cả hai nhánh nhận `409`; GREEN focused **9 passed**, adjacent Task 5 gate **49 passed**. Independent reviewer: **Approved**.

### Task 6 — strict SFX translation contract

- Response dịch dùng strict shape `{id, kind, translation}`; text yêu cầu bản dịch non-empty, SFX yêu cầu `translation=null`.
- Page policy không paint SFX và giữ SFX ngoài manifest render. Commit `866e906` đã được review PASS trong phạm vi server.

### Task 7 — strict page-v2 persistence và correction

- `PageCache` persist strict `page-v2`, tách version domain cho translation, patch và layout-fit; render stale bị loại chọn lọc mà không xóa translation hợp lệ.
- Review fix `78edc37`: mỗi `manifest_id` phải ánh xạ tới **đúng một** block `kind=text`, `state=translated`, với `trans_text` là string non-empty sau `.trim()`.
- Validation mới reject missing ID, duplicate ID, `kind=null`, state `ocr_complete/failed`, và translation null/empty/whitespace. Empty manifest/all-SFX và resumable block ngoài manifest vẫn hợp lệ.
- TDD RED: **17 passed, 9 failed** gồm 8 mutation cases và parent; GREEN page-cache: **26/26 passed**. Independent reviewer: **Approved**.

### Task 8 — exact source identity và runtime handoff

- Shared source pool dedupe theo URL, tối đa hai fetch FIFO, refcount/final-abort, retry sau failure; SHA-256 tính trên exact fetched bytes.
- Artifact keys dùng đúng bốn identity domain; `LAYOUT_FIT_VERSION` chỉ thuộc runtime/purge identity. Extension luôn gửi required `render_artifact_key`; strict page-v2 runtime handoff đã được nối hoàn chỉnh.
- Commit `cd69c37` được hậu kiểm **Approved**, không có finding.

### Verification cuối sau hai correction

- Full extension gate tuần tự: **39 passed, 0 failed** với `--test-concurrency=1`.
- Broad server gate: **262 passed, 2 deselected, 1 warning**.
- Warning duy nhất là `StarletteDeprecationWarning` từ dependency.
- Final combined reviewer Terra medium: **Approved**, không có Critical/Important/Medium.
- HEAD hiện tại: `78edc37` trên `feat/v5`; worktree và index sạch; chưa push.
- Không chạy `server/tests/test_ocr.py`, real-model hoặc hai real-detector tests.

### Việc còn lại

> [!todo] Task 9
> Cần gate end-to-end strict `{id, kind, translation}`. Fake extension hiện còn trả response shape cũ, nên các gate extension hiện tại chưa chứng minh đầy đủ luồng SFX từ server contract tới DOM/runtime.

## 2026-08-12 — Spec C Tasks 9–11: overlay in-place hoàn tất review

### Verdict cuối

> [!success] Tasks 9–11 PASS
> Luồng producer join, atomic clean-overlay và durable render outcome/recovery đã được triển khai, hậu kiểm và sửa theo review. Không còn finding Critical, Important hoặc Minor mở trong phạm vi ba task.

### Chuỗi commit

- Task 9: `3719e36` — `feat: join translation with render artifacts`.
- Task 10: `3b4397b` — `feat: render clean translation overlays atomically`.
- Task 11: `774c06e` — `feat: persist render outcomes and recovery breakers`.
- Review fix Task 11: `f4f7bb6` — `fix: harden render recovery persistence`.
- Review fix Task 10: `6926ef6` — `fix: stabilize translated overlay rendering`.
- Follow-up Minor Task 10: `9662524` — `fix: restore overlay font after resize`.

### Kết quả theo task

- **Task 9 — PASS:** translation strict `{id, kind, translation}` được join với `RenderArtifact`; cold path và warm replay dùng đúng `render_artifact_key`, không paint SFX, và giữ các guard huỷ/stale của producer.
- **Task 10 — PASS:** clean patch decode xong mới mount; `.mt-render-block` chỉ xuất hiện khi patch và text đã sẵn sàng; fit được đo trên probe có layout thật, lưu outcome `painted`/`fit_failed`, và resize lớn trở lại khôi phục cỡ chữ tối đa thay vì giảm đơn điệu.
- **Task 11 — PASS:** render outcomes chỉ persist khi đủ manifest theo canonical order; mismatch breaker bền vững chặn cold revisit khỏi chạy lại analysis/render/Gemini; các page write được tuần tự hóa để không ghi đè identity mới; stale collector/producer và shared OCR stage được cô lập đúng.

### Review corrections đã đóng

- Cold breaker giữ nguyên OCR manifest/translation và được kiểm tra độc lập với terminal cache hit; revisit cùng sentinel sau service-worker restart phát sinh `0` render, `0` OCR, `0` Gemini.
- Overlay khôi phục `color: #111` và font-family tường minh; decode reject không để lại `.mt-overlay` rỗng; transient persistence failure không làm mất collector; invalid geometry được ghi nhận bằng reason hợp lệ.
- Finding `vertical-rl` đã **WITHDRAW** sau đo trực tiếp trên Chrome 151: `scrollWidth/clientWidth` phát hiện đúng overflow ở các case chữ dọc, RTL, vertical-lr và nhánh resize.
- Minor font-size không hồi lại sau chu kỳ shrink → grow đã được sửa bằng TDD: `18px → 12px → 18px`.

### Verification và trạng thái

- Full extension gate: **39 passed, 0 failed**.
- `node --check` và `git diff --check`: PASS ở checkpoint cuối.
- Không chạy server tests hoặc `server/tests/test_ocr.py` trong lượt review/fix Tasks 9–11 này.
- Worktree `spec-c-in-place-overlay-rendering` trên `feat/v5` sạch, ahead `origin/feat/v5` **17 commit**; chưa push.

### Nhật ký lỗi và các fix round

#### Task 9 — join translation với RenderArtifact

1. **Vòng triển khai đầu — event chưa có render payload và warm replay chưa fetch artifact**
   - **Lỗi/RED:** translation event thiếu toàn bộ `patch_*`, `fit_bbox`, `text`, `layout_fit_version`, `layout_hint`; warm replay có `renderKey=0` thay vì `1`.
   - **Lý do:** luồng cũ emit translation ngay sau Gemini và cache chỉ biết text, chưa có readiness join với `RenderArtifact`.
   - **Cách giải quyết:** producer sở hữu hai promise `translationReady` và `renderReady`; fetch render theo key trước, chỉ retry một lần bằng blob khi server trả `409 artifact_missing`; validate schema/key/dimensions/manifest; chỉ emit text sau khi cả hai promise hoàn tất. SFX vẫn được lưu đúng strict contract nhưng không paint.
   - **Kết quả:** cold và warm đều phát event đủ patch/text; warm replay đúng một render key-call và không gọi Gemini.

2. **Fix round 1 — cold translation bị serialize theo render**
   - **Lỗi/RED:** khi test giữ render promise, translation cũng không thể hoàn tất và timeout ở mốc “translation completed while render held”.
   - **Lý do:** production `await producer.renderReady` trước khi bắt đầu `/translate-items`; hai công việc độc lập bị chạy tuần tự, làm mất mục tiêu latency của producer join.
   - **Cách giải quyết:** bỏ đúng `await` chặn trước translation; khởi động render và translation song song, nhưng giữ `Promise.all([renderReady, translationReady])` ngay trước emit để atomicity không đổi.
   - **Kết quả:** cả hai thứ tự hoàn tất render-trước và translation-trước đều GREEN; không có partial patch/text event.

3. **Fix round 2 — ghost translation sau khi render đã thất bại**
   - **Lỗi/RED nhanh:** render reject trước network nhưng continuation muộn vẫn tạo một `/translate-items` call.
   - **Lỗi/RED chậm:** translation request đã đi; sau render reject, response muộn vẫn ghi một entry vào hot translation cache dù producer đã terminal.
   - **Lý do:** strict join ngăn emit nhưng không huỷ sibling continuation; translation pipeline không biết render sibling đã thất bại.
   - **Cách giải quyết:** render rejection đặt `producer.cancelled=true` trước khi rethrow; translation kiểm tra trạng thái sau digest, trước network, sau response và trước apply/cache. Tách rõ `cancelled && !retired` với producer bị replacement: sibling bị huỷ không được cache/apply, còn producer `retired` vẫn được phép warm cache rồi dừng trước page/event apply.
   - **Kết quả:** fast race có zero late network; slow race có zero hot-cache/page/event mutation; invariant stale replacement warm-cache vẫn giữ nguyên.

#### Task 10 — DOM patch + text nguyên tử

1. **Vòng triển khai đầu — wrapper mount quá sớm, fit không revalidate và thiếu identity handoff**
   - **Lỗi/RED:** wrapper đã xuất hiện trước `patch.decode()` (`1 !== 0`); cached 18px được giữ dù chỉ 12px mới vừa hộp; upstream translation thiếu `render_artifact_key`.
   - **Lý do:** `.mt-bubble` cũ chỉ append text, không có lifecycle detached patch+text; fitter tin profile cache; background chưa chuyển render identity tới content.
   - **Cách giải quyết:** dựng detached `.mt-render-block` gồm `.mt-clean-patch` + `.mt-translated-text`, chờ decode và recheck binding rồi mới append đúng một lần; revalidate cả `scrollWidth` lẫn `scrollHeight` xuống sàn 10px; handoff `render_artifact_key` trên mọi renderable translation.
   - **Kết quả:** visible DOM luôn atomic và upstream integration khóa đúng render identity.

2. **Self-review fix — resize fit fail nhưng block tràn vẫn còn**
   - **Lỗi/RED:** re-fit sau resize trả `null`, nhưng live block count vẫn là `1`.
   - **Lý do:** `position()` phát hiện không fit nhưng chỉ bỏ qua cập nhật, không thu hồi UI đã paint.
   - **Cách giải quyết:** khi resize không fit ở 10px, remove block hiện hữu và gửi metric `painted:false`, `reason:"fit_failed"` nếu binding vẫn hợp lệ.
   - **Kết quả:** không còn chữ tràn trên clean patch; collector Task 11 nhận được outcome đầy đủ.

3. **Affected-harness fix — benchmark vẫn dùng selector `.mt-bubble`**
   - **Lỗi/RED:** benchmark không advance source sang `?benchmark=1`.
   - **Lý do:** UI class đã đổi nhưng controller benchmark vẫn query selector legacy.
   - **Cách giải quyết:** đổi đúng selector sang `.mt-translated-text` và thêm regression selector-specific.
   - **Kết quả:** fixture benchmark GREEN mà không mở thêm production scope.

4. **Review fix — đo text trên detached node cho kết quả giả**
   - **Lỗi/RED:** fake DOM ban đầu cho phép detached node có layout metrics nên production nhận sai 18px; fake sát browser hơn trả 0 và làm test fail.
   - **Lý do:** DOM node chưa connected không có layout box thật trong browser.
   - **Cách giải quyết:** dùng probe riêng, hidden/offscreen và nối tạm vào DOM để đo; wrapper thật vẫn detached; probe luôn cleanup bằng `finally` trước visible commit.
   - **Kết quả:** profile hợp lệ 12px được đo từ layout thật mà không phá atomic mount.

5. **Review fix — `scope_done` đến trước decode làm mất block hợp lệ**
   - **Lỗi/RED:** decode chậm hoàn tất sau normal `scope_done` cho live block count `0` thay vì `1`.
   - **Lý do:** cleanup xóa binding ngay ở terminal accounting, trong khi Chrome Port delivery và image decode là các task bất đồng bộ riêng.
   - **Cách giải quyết:** đánh dấu `completedScopeIds` cho normal success; final `validBinding` vẫn revalidate request/image/source/signature/language. `scope_error`, supersede và source change vẫn stale fail-closed.
   - **Kết quả:** normal late decode được paint và ghi metric; các sibling lỗi/stale vẫn không mount.

6. **Review fix — copy `CSSStyleDeclaration` như plain object**
   - **Lỗi/RED:** connected probe vẫn không commit fit 12px khi fake chuyển sang `CSSStyleDeclaration`-like behavior.
   - **Lý do:** `Object.assign(probe.style, element.style)` không copy các value width/height/writing-mode như kỳ vọng trong browser.
   - **Cách giải quyết:** copy tường minh đúng ba field `width`, `height`, `writingMode` cần cho phép đo.
   - **Kết quả:** test sát browser GREEN, không thêm abstraction CSS chung.

7. **Review fix 1 — blanket catch nuốt lỗi renderer thật**
   - **Lỗi/RED:** invalid geometry sau decode tạo zero log vì `.catch(() => {})`, trong khi đây không phải decode failure tạm thời.
   - **Lý do:** một catch boundary xử lý chung cả expected decode rejection và unexpected renderer exception.
   - **Cách giải quyết:** bắt riêng `patch.decode()` rejection và return yên lặng; terminal catch còn lại log đúng một lần với request/job/block identity và Error gốc.
   - **Kết quả:** decode reject vẫn zero block/metric/log; lỗi bất ngờ có dấu vết nhưng không tạo unhandled rejection.

8. **External review fix 2 — màu/font kế thừa và overlay root rỗng**
   - **Lỗi:** `.mt-translated-text` mất `color`/`font-family`, có thể thành chữ sáng trên patch sáng; decode reject xảy ra sau `ensureOverlay()`, để lại root rỗng.
   - **Cách giải quyết:** khôi phục `color:#111` và font stack trước phép đo; dời `ensureOverlay()` xuống sau decode + binding recheck.
   - **Tranh chấp `vertical-rl`:** đề xuất sửa overflow probe được **Challenge** thay vì áp dụng mù. Đo thật trên Chrome 151 cho thấy `scrollWidth/clientWidth` bắt đúng 8/8 case chữ dọc và các bước resize, nên finding được **WITHDRAW** và không có speculative code change.

9. **Follow-up review fix 3 — cỡ chữ chỉ giảm, không hồi lại khi hộp lớn lên**
   - **Lỗi/RED:** chu kỳ resize `18px → 12px → hộp lớn` vẫn giữ 12px.
   - **Lý do:** `position()` dùng `block.profile.font_px` hiện tại làm search ceiling, trong khi fitter chỉ giảm dần.
   - **Cách giải quyết:** mỗi lần resize reset riêng ceiling về 18px nhưng giữ `line_height` đã đo.
   - **Kết quả:** regression GREEN `18px → 12px → 18px`; không đổi lifecycle hoặc metric contract.

#### Task 11 — durable render outcomes và bounded recovery

1. **Vòng triển khai/takeover — collector chưa canonical và recovery phá shared OCR stage**
   - **Lỗi collector:** metric block ngoài manifest có thể chiếm slot, làm `blocks.size` đủ sớm, persist invalid rồi collector bị bỏ; scenario hợp lệ sau đó timeout.
   - **Giải quyết:** chỉ nhận block thuộc `manifestIds`, giữ outcome đầu tiên cho duplicate và persist đúng canonical order khi đủ toàn manifest; identity sai, disconnect và supersede đều invalid collector; giới hạn 128 collector.
   - **Lỗi recovery:** reset mismatch xóa thẳng `ocrStages.delete(producer.ocrKey)`, làm peer dùng chung mất live stage.
   - **Giải quyết:** tách `ocrStageKey` nội bộ; recovery dùng key `${ocrKey}:manifest-recovery`, còn wire/cache `ocr_key` giữ nguyên.
   - **Kết quả:** canonical manifest bền vững không chứa patch bytes; peer giữ original OCR stage và recovery có stage riêng.

2. **Review fix 1 — stale collector ghi đè PageRow identity mới**
   - **Lỗi/RED:** request khác đã ghi `new-render`/cleaner `c2`, nhưng collector cũ persist `activeProducer.page` và phục hồi `old-render`/`c1`.
   - **Lý do:** validate trên object in-memory cũ rồi ghi lại whole row.
   - **Cách giải quyết:** đọc PageRow fresh ngay trước ready write, guard page/render/manifest/patch identity và chỉ ghi row fresh; `persist()` bỏ qua producer có identity cũ.
   - **Kết quả:** race “new identity đã tồn tại trước collector read” được chặn, nhưng self-review tiếp tục phát hiện khoảng TOCTOU giữa fresh get và put.

3. **Review fix 2 — guard fresh-row vẫn hở TOCTOU**
   - **Lỗi/RED:** identity bump chen vào giữa `getPage()` và `putPage()`, sau đó collector cũ vẫn thắng; stale mismatch producer cũng có thể ghi sentinel old-render vào row `c2`.
   - **Lý do:** check-and-write gồm hai storage await nhưng chưa có serialization theo page.
   - **Cách giải quyết:** thêm `pageWriteTails`/`serializePageWrite(page_artifact_key)` cho producer persist, identity bump, collector ready và mismatch claim/sentinel; reread và identity recheck nằm bên trong cùng chain; mismatch stale trả `stale` thay vì ghi.
   - **Kết quả:** queued collector không thể overwrite identity bump hoặc durable sentinel.

4. **Review fix 3 — các writer kề cạnh vẫn nằm ngoài chain**
   - **Lỗi/RED:** terminal render error ghi lại c1 sau c2; retire producer cũ ghi đè hoặc xóa row c2; attach A đọc null rồi ghi placeholder đè row mới do attach B tạo.
   - **Lý do:** mới serialize happy-path collector/mismatch, còn terminal catch, retire và creation vẫn là whole-row writer độc lập.
   - **Cách giải quyết:** terminal partial write, retire partial/remove và fresh-create đều chạy trong page write chain, reread identity ngay trước mutation.
   - **Kết quả:** toàn bộ writer PageRow trong background cùng tuân một ownership/order invariant.

5. **Review fix 4 — LRU touch tự nó là stale whole-row writer**
   - **Lỗi/RED:** `getPage()`/`findPage()` đọc snapshot rồi `_touch()` ghi lại cả row; nếu ready render được persist trong khoảng đó, stale touch làm mất `ready-patch`.
   - **Lý do:** thao tác tưởng là read/LRU update thực chất là read-modify-write whole PageRow ngoài page chain.
   - **Cách giải quyết:** `findPage(..., {touch:false})` chỉ lấy candidate; `findPageForReuse()` vào page chain, đọc/touch fresh và recheck predicate. Initial visible `getPage()` cũng serialize. Active producer cùng render/patch identity được join trước cache read để tránh deadlock cho late consumer.
   - **Kết quả:** initial read và cả ba dynamic find path không thể erase ready render; regression late-consumer Task 9 vẫn pass.

6. **Review fix 5 — request mới reuse producer đã cancelled/retired**
   - **Lỗi/RED đầu:** early path gắn consumer vào cancelled producer và request không complete.
   - **Lỗi/RED fallback:** PageRow non-terminal bypass early guard rồi fallback vẫn reuse stale/mismatched producer và release acquisition của producer mới.
   - **Lỗi cleanup kề cạnh:** sau khi replacement được cài vào map, `failProducer(stale)` hoặc `finishProducer(stale)` xóa vô điều kiện theo page key, làm mất owner mới.
   - **Cách giải quyết:** dùng chung `reusableProducer()` ở early và fallback: producer phải live, không cancelled/retired, render và patch identity đều khớp. Khi thay owner, `finishProducer()`/`failProducer()` chỉ delete nếu map vẫn trỏ đúng object producer đang cleanup.
   - **Kết quả:** stale producer không nhận consumer/acquisition mới và cleanup cũ không xóa replacement.

7. **External review fix 6 — cold breaker, transient collector failure và invalid geometry**
   - **Cold breaker RED:** mismatch kép trên cold path ghi đè `producer.page` bằng cache copy cũ, làm mất `ocr_done`, `manifest_ids` và translated blocks; sau service-worker restart mỗi revisit lại tốn render + OCR + Gemini.
   - **Giải quyết:** persist breaker trên PageRow recovered của chính producer, chỉ merge mismatch count/render sentinel; kiểm tra fresh sentinel độc lập với `terminalHit`. Revisit cùng sentinel sau restart trở thành zero paid network.
   - **Collector RED:** `finally` xóa collector cả khi PageCache write lỗi transient, nên canonical outcomes không thể retry.
   - **Giải quyết:** chỉ xóa khi write durable hoặc identity proven stale; lỗi transient reset `persisting=false` để metric/replay sau thử lại.
   - **Geometry RED:** artifact `reason:null` nhưng patch/fit geometry sai không emit và cũng không prefill outcome, làm collector mãi thiếu block.
   - **Giải quyết:** normalize sang enum có sẵn `layout_failed`, không nới schema.
   - **Kết quả:** full extension suite cuối **39/39 PASS**; cold sentinel giữ đủ OCR/manifest/translation và chặn recovery trả phí đúng thiết kế.

> [!note] Vì sao Task 11 có nhiều vòng fix?
> Các lỗi đều là interleaving khác nhau của cùng một invariant: **PageRow mới hơn không được bị whole-row writer cũ ghi đè, và producer/collector cũ không được sở hữu tài nguyên của request mới**. Mỗi RED dùng barrier xác định để chứng minh một writer cụ thể trước khi mở rộng serialization/ownership guard; không thêm transaction framework khi chưa có race tái hiện được.


## 2026-08-13 — Spec C Task 12: bounded OCR recovery hoàn tất review

### Verdict cuối

> [!success] Task 12 PASS
> Durable OCR-recovery ledger, partial overlay replay và bounded recovery đã được triển khai, sửa đủ 4 finding ban đầu và bổ sung coverage cho nhánh terminal breaker. Không còn finding mở trong phạm vi Task 12.

### Chuỗi commit

- Task 12: `fc8dbed` — `feat: add bounded ocr recovery`.
- Review fix: `d314949` — `fix: harden bounded ocr recovery`.
- Follow-up coverage: `146597e` — `test: cover partial recovery breaker cleanup`.

### Kết quả Task 12

- Ledger `mt:ocr-recovery:<ocr_key>` dùng schema chính xác `ocr-recovery-v1`, claim bền vững tối đa một lần theo OCR identity và không bị eviction như PageRow terminal.
- Page `partial + manifest + ocr_done=false` replay overlay trước; chỉ claimant mới chạy một OCR recovery. Revisit, đổi `dst_lang` hoặc prompt không tiêu thêm OCR budget; đổi OCR identity tạo budget mới.
- OCR snapshot không đổi giữ manifest/translation authoritative và không gọi Gemini; snapshot đổi chạy đúng một full-page translation cho item set mới.
- Orphan ledger chỉ được thu gom ở lifecycle có thể làm mất PageRow cuối: remove, purge, eviction và rehydrate.

### Nhật ký lỗi và các fix round

1. **Vòng triển khai đầu — thiếu durable claim và partial recovery state machine**
   - **Lỗi/RED:** `claimOcrRecovery` chưa tồn tại; ledger sai schema không bị purge; concurrent partial pages có thể lặp OCR; partial manifest đi thẳng producer cũ thay vì replay trước.
   - **Cách giải quyết:** thêm exact ledger schema, serialized one-shot claim theo `ocr_key`, protected eviction và orphan GC; replay manifest trước claim, rồi reset producer sang scratch OCR chỉ cho claimant.
   - **Kết quả:** concurrent/restart/new-dst/new-prompt giữ tối đa một OCR POST cho cùng identity; claim write failure không phát sinh OCR hoặc Gemini.

2. **Fix round 1 — `retireProducer` ghi scratch OCR-recovery đè PageRow authoritative**
   - **Lỗi/RED:** target replacement retire producer giữa recovery làm PageRow mất `manifest_ids`/render và thay block translated cũ bằng scratch block mới.
   - **Lý do:** `persist()` có guard recovery nhưng `retireProducer()` bypass guard và persist whole scratch page.
   - **Cách giải quyết:** chặn retire persistence khi `producer.ocrRecovery`; replacement cleanup vẫn remove toàn bộ job ledger trước retire.
   - **Kết quả:** PageRow bền vẫn giữ `{state:partial, ocr_done:false, blocks:[old], manifest_ids:[old], render:[old]}` trong khi scratch đang có block `new`.

3. **Fix round 2 — partial replay bypass durable manifest-mismatch breaker của Task 11**
   - **Lỗi/RED:** render thiếu manifest ID làm request dừng trước OCR, nhưng `manifest_mismatch_count` chưa được persist và revisit tiếp tục gọi render.
   - **Lý do:** `fetchRenderArtifact()`/`replayPage()` của nhánh partial nằm ngoài mismatch handling; OCR claim lại đặt sau replay.
   - **Cách giải quyết:** bắt riêng `manifest_mismatch`, gọi `handleManifestMismatch()` trước OCR claim; lần đầu queue paid recovery của Task 11, lần hai ghi sentinel `breaker_open`, các revisit sau bị chặn trước replay.
   - **Kết quả:** chuỗi network được khóa `render:2/ocr:1/text:1` → `render:1/ocr:0/text:0` → `render:0/ocr:0/text:0`; mismatch không tiêu ledger OCR-recovery.

4. **Fix round 3 — `putPage()` quét toàn bộ storage thêm một lần cho orphan GC**
   - **Lỗi/RED:** một PageRow rewrite bình thường gọi `storage.get(null)` hai lần.
   - **Lý do:** `_put()` đã scan cho budget nhưng `putPage()` lại chạy `_gcOcrRecoveryLedgers()`, dù rewrite cùng page key không thể đổi OCR identity hợp lệ.
   - **Cách giải quyết:** `putPage()` trả thẳng `_put(...)`; giữ GC ở remove/purge/eviction/rehydrate.
   - **Kết quả:** ordinary rewrite còn đúng một inventory scan, contract return không đổi và ledger đang được tham chiếu vẫn tồn tại.

5. **Fix round 4 — `sameOcrSnapshot()` so sánh block theo vị trí**
   - **Lỗi/RED:** cùng tập block nhưng OCR event đảo thứ tự tạo một Gemini call không cần thiết; fallback `kind` có thể gắn nhầm block.
   - **Cách giải quyết:** map fallback kind theo `block_id`, canonical-sort projection của hai phía rồi mới so sánh.
   - **Kết quả:** reorder `sfx,text` giữ `ocr:1, text:0`, kind/manifest authoritative không đổi; các transition `text ↔ sfx` vẫn buộc dịch lại.

6. **Follow-up Minor — nhánh partial terminal breaker chưa có cleanup coverage**
   - **Finding:** production đã đúng nhưng test trước chỉ phủ partial mismatch lần đầu và terminal complete page; chưa khóa nhánh `action !== recover` cho partial PageRow có `manifest_mismatch_count:1`.
   - **Cách giải quyết:** thêm scenario dựng đúng partial page count 1, assert sentinel bền, zero OCR/Gemini, job ledger được dọn và revisit phải fetch source mới nhưng không gọi render.
   - **Mutation proof:** tạm bỏ `releaseProducerSource(producer)` làm test RED với `source delta=0` thay vì `1`; khôi phục source làm GREEN. Ví dụ bỏ explicit `removeJob` riêng lẻ không phải mutant hành vi vì `completeJob()` đã thực hiện cleanup theo contract chung; test khóa kết quả không còn `mt:job:` thay vì khóa số lần gọi nội bộ.
   - **Kết quả:** resource ownership của nhánh terminal breaker được bảo vệ mà không đổi production code.

### Verification và trạng thái

- Focused Task 12 gate tuần tự: **36 passed, 0 failed**.
- Full extension gate tuần tự: **48 passed, 0 failed**.
- `git diff --check`: PASS trước commit follow-up.
- Không chạy server tests, real-model tests hoặc `server/tests/test_ocr.py` trong fix round này.
- Worktree `spec-c-in-place-overlay-rendering` trên `feat/v5` sạch sau commit `146597e`, ahead `origin/feat/v5` **20 commit**; chưa push.

## 2026-08-13 — Spec C Task 13: delivery accounting và cô lập lỗi Port

### Verdict cuối

> [!success] Task 13 PASS
> Delivery được đếm riêng theo request/job và chỉ sau `postMessage` translation thành công. Lỗi transport của Port trong accepted/progress/block_error/translation/image_done không còn làm hỏng producer, OCR stage, PageRow hoặc telemetry. Independent re-review cuối không còn finding trong phạm vi F2–F5.

### Chuỗi commit

- Task 13: `b1ec9cc` — `feat: track per-job delivery across recovery`.
- Review fix direct replay: `3e21efd` — `fix: preserve cache on replay delivery failure`.
- Bộ nguồn SFX riêng: `7fa019b` — `test: add dedicated sfx image fixtures`.
- Review fix transport hoàn chỉnh: `0efab16` — `fix: contain extension port delivery failures`.

### Nhật ký lỗi và các fix round

1. **Vòng triển khai — số translated dùng kết quả chung thay vì delivery thật của từng consumer**
   - **Lỗi/RED:** page mixed text/SFX báo translated theo tổng block; consumer có Port throw hoặc disconnect có thể được tính như đã nhận; offline jobs cùng request ID không hợp nhất ownership delivery.
   - **Lý do:** chưa có ledger `Map<job_id, Set<block_id>>` ở request boundary; producer result bị dùng thay cho số translation event đã post thành công.
   - **Cách giải quyết:** seed Set cho mọi expected job, merge Set rỗng khi rehydrate, add `block_id` chỉ sau post thành công và dùng đúng Set cho `image_done`/`scope_done`.
   - **Kết quả:** mixed text/SFX, all-SFX, shared producer, late replay, disconnect, replacement và offline restore đều giữ count riêng theo consumer.

2. **Review fix 1 — translation post lỗi trong direct replay làm bẩn PageRow authoritative**
   - **Lỗi/RED:** Port chết ở translation thứ hai làm exception rơi vào render catch; PageRow complete bị hạ thành partial, `last_error` chứa lỗi Port và telemetry báo `render_failed`.
   - **Lý do:** vòng `replayPage()` gọi `postMessage` trần và chỉ ghi delivered sau toàn bộ control flow.
   - **Cách giải quyết:** dừng replay tại post lỗi, chỉ add ID sau từng post thành công; terminal count lấy số event đã giao trước lỗi.
   - **Kết quả:** chỉ block đầu được tính, request vẫn `failed:0`, `cache_hit:true`; PageRow giữ `state:complete`, `last_error:null`.

3. **Review fix 2 — các message transport kề cạnh vẫn làm hỏng pipeline**
   - **Lỗi/RED progress replay:** Port throw ở progress làm PageRow complete thành partial và telemetry `render_failed`.
   - **Lỗi/RED accepted:** Port throw ở `page_job_accepted` thoát lên `acceptScope`, request bị ghi `request_failed` dù cache/render vẫn hợp lệ.
   - **Lỗi/RED producer emit:** Port throw ở progress hoặc block_error reject shared OCR stage; valid block không được dịch, translated từ 1 thành 0.
   - **Lỗi invariant:** delivery Set bị thiếu vẫn bị fallback thành 0, che lỗi lifecycle trái contract.
   - **Cách giải quyết:** một helper `postTo()` best-effort dùng chung cho accepted/progress/block_error/translation/image_done; helper trả boolean để translation chỉ ghi delivered khi post thành công. Mọi access delivery ledger chuyển sang `Map.get(...).add/.size` nghiêm ngặt, không còn optional fallback.
   - **Kết quả:** ba biến thể direct replay accepted/progress/translation giữ PageRow và telemetry đúng; producer progress/block_error không reject OCR stage; test xóa delivery Set xác nhận fail-fast. Focused gate 2/2 và full extension gate sau commit 49/49 PASS.

### Nguồn SFX bổ sung — tách khỏi review transport

- Pack riêng chỉ gồm `s-manga_ja_sfx.png` (thoại + SFX), `sfx_1.jpg` và `sfx_2.jpg` (SFX-only); khóa đúng ba filename, SHA-256, kích thước và vai trò, không nhập vào historical quality baseline.
- Dedicated fixture gate 2/2 và production detector/OCR source gate 3/3 đã PASS.
- Quan sát chất lượng không bị che thành acceptance: `sfx_1` đạt SFX-only; trang mixed chưa nhận diện phần SFX; `sfx_2` còn một block bị phân loại text. Đây là model-quality debt ngoài fix transport Task 13.

### Verification và trạng thái

- RED xác nhận riêng: missing delivery ledger không fail-fast; accepted thành `request_failed`; replay progress thành `render_failed`; emit progress/block_error làm translated từ 1 thành 0.
- GREEN focused: **2 passed, 0 failed**.
- Post-commit full extension: **49 passed, 0 failed**.
- Hai JavaScript syntax checks và `git diff --check`: PASS.
- Independent re-review F2–F5: **Approved**, không có finding mới; phần fixture SFX được loại khỏi review theo yêu cầu.
- Worktree `spec-c-in-place-overlay-rendering` trên `feat/v5` sạch tại `0efab16`, ahead `origin/feat/v5` **24 commit**; chưa push.

## 2026-08-14 — Spec C Task 14: telemetry và acceptance gate

### Verdict cuối

> [!success] Task 14 PASS
> Telemetry `atomic_patch_v1`, acceptance protocol và deterministic gate đã hoàn tất review. Ba Minor follow-up cuối đã được vá và khóa bằng RED/GREEN hoặc mutation proof; không còn finding mở trong phạm vi Task 14.

### Commit

- `6770d74` — `feat: add atomic overlay acceptance gate`.
- Commit đúng 8 file allowlist của Task 14; `extension/content.js` không có diff cuối.

### Kết quả chính

- PageMetric có semantic/cohort/coverage/reason fields; late render metric không được ghi đè ownership labels.
- `first_overlay_ms` đo đến lúc patch + text đã decode, fit và append nguyên tử thành công.
- `render_wait_after_translation_ms` dùng render-ready mới nhất, kể cả nhánh manifest recovery.
- Acceptance app dùng đúng pipeline/patch versions, strict text/SFX schema, deterministic RGBA PNG, key-first render lookup và route-specific cache headers.
- Golden A–D khóa exact manifest/rendered/skip sets, coverage, SFX ngoài denominator và page D `fit_failed` bằng fit box 12×12.

### Trade-off được chấp nhận — percentile chỉ đo trang thực sự paint

Sau Fix 2, cả cohort `warm` và `cold` chỉ đưa row có `first_overlay_ms` hữu hạn vào percentile `render_wait_after_translation_ms`.

Dưới góc nhìn người dùng cuối:

- `first_overlay_ms` trả lời: “Mở trang bao lâu thì tôi thật sự thấy dòng dịch đầu tiên?”
- `render_wait_after_translation_ms` trả lời: “Sau khi dịch xong, tôi còn phải chờ patch sạch bao lâu trước khi thấy kết quả?”
- Một trang có render artifact về nhưng toàn bộ block `fit_failed`, `unsupported_region`, `clean_failed`, `layout_failed` hoặc decode thất bại thì người dùng không bao giờ thấy overlay. Vì vậy row đó không được dùng làm một mẫu “thời gian chờ trước khi thấy kết quả”.
- Việc lọc giống nhau ở warm/cold giữ hai cohort trên cùng tập trải nghiệm, nên chênh lệch giữa chúng phản ánh cache thay vì khác biệt tập mẫu.

> [!warning] Điểm mù cần nhớ khi vận hành
> Nếu một regression vừa làm render chậm vừa làm nhiều trang không paint, p95 có thể đứng yên hoặc đẹp lên vì `sample_count` tụt. Không được đánh giá gate chỉ bằng percentile. Luôn đọc cùng `sample_count`, `render_coverage` và `render_reason_counts`.

Trang không paint không biến mất khỏi telemetry:

- `painted: false`;
- `render_coverage: 0` khi có manifest text nhưng không render được;
- `render_reason_counts` giữ nguyên nhân như `fit_failed` hoặc `unsupported_region`;
- `sample_count` của latency cohort giảm và chính nó là tín hiệu cảnh báo.

Nếu sau này cần trả lời câu hỏi chẩn đoán server “render artifact về nhanh chậm thế nào bất kể frontend có vẽ được không”, hãy thêm cohort riêng như `cold_backend`, chỉ lọc `Number.isFinite(render_wait_after_translation_ms)`. Không nới lỏng cohort `cold` hiện tại vì sẽ mất lại tính đối xứng warm/cold và đổi ý nghĩa UX của metric.

### Verification đóng task

- Full server bằng project venv, loại đúng `server/tests/test_ocr.py`: **268 passed, 2 dependency warnings có sẵn**.
- Full extension chạy tuần tự: **50 passed, 0 failed**.
- `node --check`: **6/6**; venv `py_compile`: **2/2**; `git diff --check`: PASS.
- Browser/manual visual QA và Gate A–G tổng hợp thuộc Task 15; không dùng kết quả `/health` thay cho bằng chứng UI.
- Nhánh `feat/v5` đã commit Task 14 tại `6770d74`; chưa push.