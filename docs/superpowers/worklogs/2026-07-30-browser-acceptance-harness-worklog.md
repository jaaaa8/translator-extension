---
title: "Browser acceptance harness"
note_type: worklog
work_item: browser-acceptance-harness
date_start: 2026-07-30
date_end: 2026-07-31
status: done
versions:
  - "[[feat-v2]]"
specs:
  - "[[2026-07-30-browser-acceptance-harness-design]]"
plans:
  - "[[2026-07-30-browser-acceptance-harness]]"
artifacts: []
tags:
  - mangatranslator/worklog
---

# Browser acceptance harness

> [!summary] Tóm tắt
> **Vấn đề:** Các race, restart và fault phía browser chưa có control plane để tái lập.
>
> **Quyết định/fix:** Dựng acceptance harness với fixture, fault controls và các case Chrome có kiểm soát.
>
> **Kết quả:** Các case trong phạm vi harness, gồm full Chrome restart, được đóng.

## Liên kết

- Phiên bản: [[feat-v2]]
- Spec: [[2026-07-30-browser-acceptance-harness-design]]
- Plan: [[2026-07-30-browser-acceptance-harness]]
- Artifact: Không có.

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
- [x] **Benchmark production:** đã chạy 20 cold + 20 warm trên cùng máy — xem [[2026-07-31-cold-benchmark-fixture-worklog#Benchmark production — 20 cold + 20 warm (2026-07-31)|mục benchmark]]. Không có timing synthetic nào được dùng để tuyên bố hiệu năng thật.
- [x] Đã đóng P0 và merge: benchmark production xong, final whole-branch review sạch, `feat/v3` fast-forward vào `feat/v2`.

Liên quan: [[2026-07-29-progressive-translation-worklog#Cập nhật Task 9–10 — 2026-07-30|mốc Task 9–10 trước]].

#mangatranslator/progressive-session-cache/task9-task10
## Case 8 — full Chrome restart PASS (2026-07-31)

> [!success] Kết quả người dùng nhìn thấy
> Trước restart: `Đã cache: 1`. Sau khi đóng toàn bộ Chrome và mở lại: `Đã cache: 0`. Dịch lại Reader A hoàn tất `1 ảnh, 1 thoại, 0 lỗi` và tạo lại `Đã cache: 1`. Điều này xác nhận cache chỉ sống trong phiên Chrome và không làm mất khả năng dịch lại.

> [!info] Bằng chứng kỹ thuật và phần khó
> Log production phát sinh mới `GET /health`, `POST /ocr-stream`, `POST /translate-items`, nên đây là cold pipeline thật, không phải exact cache hit. Công cụ điều khiển Chrome không nối lại được sau full restart dù extension/native host đều khỏe; kiểm thử được tiếp tục thủ công. Đây là khó khăn của công cụ test, không phải lỗi MangaTranslator.

- Case 8: **PASS**, cache phiên đi theo chuỗi **1 → 0 → 1**.
- Gate chức năng còn lại lúc đó: benchmark production tối thiểu **20 cold + 20 warm** trên cùng máy — đã chạy xong ngày 2026-07-31.
- Repo worklog đã ghi bằng commit `4f40952`; review độc lập không có lỗi Critical/Important/Minor.

