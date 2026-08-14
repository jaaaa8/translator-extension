---
title: "Layout translation actions"
note_type: worklog
work_item: layout-translation-actions
date_start: 2026-07-23
date_end: 2026-07-28
status: done
versions:
  - "[[feat-v1]]"
specs:
  - "[[2026-07-23-layout-modes-unified-design]]"
plans:
  - "[[2026-07-28-layout-translation-actions]]"
artifacts: []
tags:
  - mangatranslator/worklog
---

# Layout translation actions

> [!summary] Tóm tắt
> **Vấn đề:** Luồng dịch chưa có hành động theo bố cục và dễ dính race từ responsive source hoặc kết quả stale.
>
> **Quyết định/fix:** Thêm hành động dịch theo layout rồi harden token, responsive source và language race.
>
> **Kết quả:** Thread A đóng sau vòng hardening cuối.

## Liên kết

- Phiên bản: [[feat-v1]]
- Spec: [[2026-07-23-layout-modes-unified-design]]
- Plan: [[2026-07-28-layout-translation-actions]]
- Artifact: Không có.

---
### Thread A — 2 bố cục đọc (webtoon dọc + reader ngang)

> [!success] Spec đã viết & commit
> Spec: `docs/superpowers/specs/2026-07-23-layout-modes-unified-design.md` — **plan chưa viết** (đợi user review spec).

**Chốt: một nút thống nhất, KHÔNG chế độ** (user chọn). Tái dùng gần hết code: định vị per-`<img>` theo tọa độ tài liệu + batch 1-call Gemini **đã dùng chung được cho cả 2 bố cục**. Chỉ vá 2 chỗ:
- `done: WeakSet<img>` → `translated: WeakMap<img, src>` — sửa gốc bug reader (lật trang đổi `src` trên cùng element → được dịch lại).
- `MutationObserver` gỡ overlay cũ ngay khi ảnh đổi `src`/rời DOM → chữ trang cũ không lơ lửng đè trang mới.

Giữ thủ công (không auto-translate/auto-scroll). Dùng `bestSource()` của thread B (hai thread độc lập). **Fullscreen API thật → backlog** (user chọn để sau).


### Việc còn lại của Thread A

- [ ] Thread A: viết plan (writing-plans) sau khi user duyệt spec

## Thread A — hành động dịch theo bố cục hoàn tất trên v2 ✅ (2026-07-28)

> [!success] Kết quả
> Thread A trong [[2026-07-23-in-bubble-ocr-recall-worklog#Backlog rút ra cho v2]] đã được triển khai, review và kiểm chứng tự động trên nhánh local `feat/v2` tại commit `5fa5b50`. Nhánh `feat/layout-translation-actions` được giữ lại làm điểm dự phòng; lịch sử bắt đầu từ `feat/v1`.

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
> [[2026-07-23-layout-translation-actions-worklog#Thread A — hành động dịch theo bố cục hoàn tất trên v2 ✅ (2026-07-28)|Thread A]] hiện ở nhánh `feat/v1`, commit `6084405`. Không còn finding Critical/Important sau scoped re-review.

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

