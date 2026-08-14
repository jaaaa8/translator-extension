---
title: "Cold benchmark fixture"
note_type: worklog
work_item: cold-benchmark-fixture
date_start: 2026-07-31
date_end: 2026-07-31
status: done
versions:
  - "[[feat-v2]]"
specs:
  - "[[2026-07-31-cold-benchmark-fixture-design]]"
plans:
  - "[[2026-07-31-cold-benchmark-fixture]]"
artifacts:
  - "[[2026-07-31-cold-warm-benchmark.json]]"
tags:
  - mangatranslator/worklog
---

# Cold benchmark fixture

> [!summary] Tóm tắt
> **Vấn đề:** Chưa có số liệu production phân biệt cold và warm bằng fixture ổn định.
>
> **Quyết định/fix:** Khóa fixture và chạy 20 cold cùng 20 warm trên production server.
>
> **Kết quả:** Benchmark hoàn tất và JSON evidence được giữ byte-for-byte.

## Liên kết

- Phiên bản: [[feat-v2]]
- Spec: [[2026-07-31-cold-benchmark-fixture-design]]
- Plan: [[2026-07-31-cold-benchmark-fixture]]
- Artifact: [[2026-07-31-cold-warm-benchmark.json]]

---
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

