# Thiết kế: Cải thiện recall/độ chính xác OCR trong bóng thoại (thread B — path Latin)

Ngày: 2026-07-23 · Nhánh: `feat/v1` · Tiếp nối: `docs/superpowers/specs/2026-07-21-manga-translator-design.md`

## Bối cảnh & vấn đề

Triệu chứng gốc (thread B): cùng 1 trang, bóng thoại dịch được / bóng không. Path Nhật (`manga-ocr`, chuyên manga) chạy ổn trên s-manga. Path **Latin** (`PaddleOCR` general, lang `es`) vừa sót vừa đọc sai trên font truyện in hoa nhiều dòng.

Dữ liệu chẩn đoán (trang thật `mangadex.jpeg` — thoại Bồ Đào Nha, đối chiếu 2 bản overlay):

- **`mangadex_trans.png`** (ảnh hiển thị NHỎ trên web): chữ vỡ nặng, đọc mảnh vụn ("EU SÓ... TAVA VENDO SE MEU PÉ FEDIA..." → chỉ ra "hôi không, bằng cách").
- **`mangadex_trans_eng_normal_size.png`** (full-res): đọc **gần đúng hết** — chỉ còn 3 bóng sạch vẫn không có overlay.

→ Kết luận hai lỗi tách bạch:

### Lỗi 1 — vỡ chữ phụ thuộc độ phân giải (gốc rễ đã xác định)

`background.js:49` fetch `img.currentSrc`. Với `srcset`, khi trang hiển thị ảnh trong khung nhỏ, trình duyệt chọn **biến thể độ phân giải thấp** làm `currentSrc` → OCR nhận pixel thấp → PaddleOCR vỡ chữ. Bản full-res đọc tốt xác nhận đây là thủ phạm chính của phần "garbling".

### Lỗi 2 — sót bóng sạch, KHÔNG phụ thuộc độ phân giải

Ở bản full-res, 3 bóng rõ ràng vẫn trắng: "POR FAVOR, ESQUEÇA O QUE ACABOU DE VER!", "SIM... EU NÃO VOU CONTAR PRA NINGUÉM SOBRE", "EU ME PREOCUPO COM ISSO TAMBÉM". Đây là B2 (detector sót bbox) hoặc B3 (PaddleOCR trả rỗng → `pipeline.py:48 if not text: continue` loại block). **Chưa xác định tầng nào — không tinh chỉnh mù.**

## Nguyên tắc

Sửa từ tầng thấp nhất đang hỏng. Không đoán knob khi chưa có dữ liệu chẩn đoán. Không đụng code vendor (`server/vendor/comic_text_detector`) — mọi knob truyền qua constructor/config.

## Phase 1 — Công cụ chẩn đoán (làm trước)

Script CLI `server/diagnose.py`:

```
python -m server.diagnose <ảnh> --lang es [--conf 0.4] [--input-size 1024]
```

Chạy đúng pipeline thật (`Detector.detect` → clamp bbox như `pipeline.py` → `engine.read`), xuất cạnh file gốc:

1. **`<ảnh>.diag.png`** — vẽ mọi bbox detector trả về, đánh số; ô **xanh nếu OCR ra chữ / đỏ nếu OCR rỗng**.
2. **`<ảnh>.diag.txt`** — mỗi block 1 dòng: `#idx  bbox=[x,y,w,h]  conf=…  text="…"` (hoặc `<rỗng>`).

Đọc 2 file phân định ngay cho 3 bóng sót:
- Không ô nào phủ lên bóng → **B2 detector sót**.
- Có ô đỏ trên bóng → **B3 PaddleOCR rỗng**.

Cờ `--conf` / `--input-size` cho phép A/B knob detector bằng cách chạy lại, không sửa code.

**Thay đổi phụ trợ:** `TextRegion` (`detector.py`) thêm field `conf: float` (lấy từ `blk.confidence`) để diagnostic hiển thị độ tự tin. `Detector.detect` gắn giá trị này. Không ảnh hưởng pipeline hiện tại (chỉ thêm field).

Script giữ lại làm công cụ tái dùng, không phải code vứt.

## Phase 2 — Áp fix theo bằng chứng

### 2a. Lỗi 1 — nguồn full-res

**Extension (capture):** thay `img.currentSrc || img.src` bằng chọn **nguồn độ phân giải cao nhất**:
- Nếu ảnh có `srcset`: parse chọn ứng viên có mô tả `w`/`x` lớn nhất.
- Ngược lại: `img.src` (URL gốc, không descriptor) thường là full-res.

Sửa ở `content.js` (chỗ dựng message `ocrImage`) — nơi biết `img`. `background.js` giữ nguyên (nhận URL đã chọn).

**Phụ trợ server (an toàn kép):** trong `pipeline.ocr_image`, nếu crop bóng nhỏ hơn ngưỡng chiều cao (vd < 32px), **upscale** trước khi đưa vào engine Latin. Chỉ áp cho path cần (crop nhỏ) để không phí thời gian.

*Cạm bẫy đã biết (ghi nhận, không giải trong spec này):* nguồn full-res của MangaDex nằm sau Cloudflare + token → re-fetch có thể fail (Bug 1 tiến độ). Nếu chọn full-res làm hỏng capture site có token, fallback về `currentSrc`. Fix capture bền vững (canvas-from-img / captureVisibleTab) vẫn là backlog B1 riêng.

### 2b. Lỗi 2 — bóng sót (hướng chốt sau Phase 1)

Theo kết quả diagnostic, dừng ở nấc thang đủ:

**Nếu B2 (detector sót):**
- Đưa `conf_thresh` và `input_size` vào `config.py` đọc từ `.env` (đúng pattern `GEMINI_MODEL`), plumb qua `Detector.__init__` → vendor `TextDetector`.
- Tinh chỉnh bằng diagnostic: hạ `conf_thresh` (thử 0.25) và/hoặc tăng `input_size` (thử 1536) tới khi 3 bóng có bbox mà không sinh bbox rác.

**Nếu B3 (PaddleOCR rỗng):**
1. **Pad + upscale crop** trước PaddleOCR (bóng cắt sát mép + chữ nhỏ là thủ phạm kinh điển). Không thêm dep.
2. Nếu vẫn kém: cân nhắc bỏ loại cứng `if not text: continue` — giữ block cho Gemini (rủi ro sinh rác, cân nhắc kỹ).
3. Nếu OCR Latin vẫn bất lực: **đưa crop bóng thẳng cho Gemini đọc+dịch** (multimodal, gộp B3+B4). Phương án cuối — tốn token ảnh, rủi ro 429.

## Kiểm thử

- Diagnostic: chạy trên `mangadex.jpeg` và fixture `es_page.png`, assert số block > 0 và file `.diag.png`/`.diag.txt` sinh ra. Self-check `__main__` nhỏ theo ponytail.
- Fix Lỗi 1 (chọn srcset): hàm chọn-nguồn tách riêng, testable thuần JS — test 1 ca `srcset` nhiều biến thể trả URL lớn nhất, 1 ca không `srcset` trả `img.src`.
- Fix Lỗi 2: chạy lại diagnostic sau khi chỉnh knob, xác nhận 3 bóng có text; suite `pytest` hiện có vẫn xanh (không phá pipeline).
- Kiểm chứng tay: reload extension + F5 trang thật, bấm "Dịch trang này", xác nhận 3 bóng có overlay và chữ không vỡ ở kích thước hiển thị nhỏ.

## Ngoài phạm vi (backlog, không làm phiên này)

- Capture bền vững qua Cloudflare/token (canvas-from-img, captureVisibleTab) — backlog B1.
- Chữ ngoài bóng thoại + inpaint viền (thread C).
- `manifest.json all_frames: true`, badge đếm capture fail — backlog B0/B1.
- Thêm ngôn ngữ Hàn/Trung (thread D).
