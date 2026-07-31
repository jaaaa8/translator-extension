
## Hoàn tất plan recall OCR trong bóng thoại ✅ (2026-07-28)

- [x] Task 1 — Chẩn đoán B2/B3: xác nhận B3; trước khi sửa có **13 block, 4 OCR rỗng**.
- [x] Task 2 — Extension chọn nguồn ảnh full-res từ `srcset` thay vì phụ thuộc `currentSrc`.
- [x] Task 3 — Pad + upscale crop trước OCR để giữ nét chữ nhỏ sát mép bóng.
- [x] Task 4 — Không triển khai knob detector theo decision gate: detector đã bắt đủ bbox, lỗi nằm ở OCR/crop.
- [x] Regression tự động: `pytest` **30 passed**; các kiểm tra Node **pass**.
- [x] Diagnostic sau sửa: **13 block, 0 OCR rỗng** (trước: 13/4).
- [x] Kiểm thử tay trên browser: **PASS** — toàn bộ box và text hoạt động đúng; không còn chữ không nhận diện.

> [!success] Kết luận
> Plan `2026-07-23-in-bubble-ocr-recall.md` đã hoàn tất. Thread B không còn workload mở; các backlog khác giữ nguyên.