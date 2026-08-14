---
title: Tiến độ MangaTranslator
aliases:
  - MangaTranslator
date: 2026-07-21
note_type: index
status: active
tags:
  - mangatranslator
  - tien-do
---
# Tiến độ MangaTranslator

Dự án dịch truyện tranh trên browser: Extension Chrome MV3 + FastAPI local server.
Spec: `docs/superpowers/specs/2026-07-21-manga-translator-design.md` · Plan: `docs/superpowers/plans/2026-07-21-manga-translator.md` · Nhánh: `feat/v1`

## Tổng quan hiện tại

> [!info] Cách đọc kho lịch sử
> Index giữ mạch thời gian; chi tiết RED/GREEN, fix round, lệnh và evidence nằm trong từng canonical worklog.

- Kho lưu trữ có 14 canonical worklog, năm version summary và sáu artifact/evidence giữ nguyên vai trò.
- Mỗi timeline link trỏ tới đúng H2 lịch sử trong worklog sở hữu.
- Quan hệ spec/plan/artifact được khai báo dạng list vì thực tế có work item many-to-many.
- Version được dựng theo Git topology, không sắp bằng author date.
- `feat/v4` là checkpoint tài liệu; Spec C đã PASS Tasks 1–15, còn `feat/v5` chờ tích hợp các thay đổi Task 15 vào Git history.

## Hành trình version

### [[feat-v1|feat/v1]]

Dựng nền server/extension/OCR/layout. Delta version đã đóng, nhưng Foundation Task 8 vẫn được giữ mở.

### [[feat-v2|feat/v2]]

Chuyển sang progressive translation, browser acceptance có kiểm soát và benchmark production cold/warm.

### [[feat-v3|feat/v3]]

Bổ sung telemetry, quality gate trang thật, reading order và full-page translation.

### [[feat-v4|feat/v4]] — checkpoint

Cả 8/8 commit là docs/chore: đây là design/documentation checkpoint, không phải product increment.

### [[feat-v5|feat/v5]] — incomplete (integration pending)

Spec C đã PASS Task 15, Gate A–G và cold/warm benchmark; code/spec/evidence Task 15 còn uncommitted nên version chưa đóng integration.

## Việc còn mở

> [!warning] Không suy diễn hoàn tất
> Focused gate hoặc version delta xanh không tự động đóng backlog khác.

- [[2026-07-21-manga-translator-foundation-worklog|Foundation]]: Task 8 vẫn mở; chưa có evidence riêng để đổi trạng thái.
- `feat/v5`: thay đổi code/spec/evidence Task 15 chưa được stage hoặc commit theo đúng yêu cầu scope control.

## Timeline

Mỗi dòng dưới đây tương ứng đúng một H2 của snapshot, giữ thứ tự nguồn và trỏ về evidence chi tiết.

- 2026-07-21 — Chia nền tảng thành tám task; Tasks 1–7 được triển khai, Task 8 vẫn mở; [[2026-07-21-manga-translator-foundation-worklog#Danh sách task|xem mốc và bằng chứng]].
- 2026-07-21 — Thiếu API nền dẫn tới dựng FastAPI, health và schema; khung server hoàn tất; [[2026-07-21-manga-translator-foundation-worklog#Task 1 — Khung server ✅ (2026-07-21)|xem mốc và bằng chứng]].
- 2026-07-21 — Cần phát hiện bubble nên tích hợp detector với cấu hình; task detector hoàn tất; [[2026-07-21-manga-translator-foundation-worklog#Task 2 — Detector ✅ (2026-07-21)|xem mốc và bằng chứng]].
- 2026-07-21 — Cần OCR thay thế được nên dựng registry engine; đường OCR hoàn tất; [[2026-07-21-manga-translator-foundation-worklog#Task 3 — OCR registry ✅ (2026-07-21)|xem mốc và bằng chứng]].
- 2026-07-21 — Cần dịch theo block nên thêm Gemini translator và validation; task dịch hoàn tất; [[2026-07-21-manga-translator-foundation-worklog#Task 4 — Gemini translator ✅ (2026-07-21)|xem mốc và bằng chứng]].
- 2026-07-21 — Ghép các bước rời thành `/translate`; pipeline detect→OCR→Gemini chạy hoàn chỉnh; [[2026-07-21-manga-translator-foundation-worklog#Task 5 — Pipeline + `/translate` ✅ (2026-07-21)|xem mốc và bằng chứng]].
- 2026-07-21 — Thiếu phía trình duyệt nên dựng MV3 scaffold và popup; extension sẵn sàng nối pipeline; [[2026-07-21-manga-translator-foundation-worklog#Task 6 — Extension scaffold ✅ (2026-07-21)|xem mốc và bằng chứng]].
- 2026-07-21 — Cần hiển thị kết quả nên content script phát hiện ảnh và vẽ overlay; task hoàn tất; [[2026-07-21-manga-translator-foundation-worklog#Task 7 — Content script + overlay ✅ (2026-07-21)|xem mốc và bằng chứng]].
- 2026-07-21 — Nhiều call Gemini và UX rời rạc được gom vào một nút/một call; redesign hoàn tất; [[2026-07-21-manga-translator-foundation-worklog#Redesign — nút bấm + gom 1 call Gemini ✅ (2026-07-21)|xem mốc và bằng chứng]].
- 2026-07-21 — Phiên đầu đóng với server, extension và pipeline hoạt động; Task 8 chưa có bằng chứng đóng; [[2026-07-21-manga-translator-foundation-worklog#Trạng thái cuối phiên 2026-07-21|xem mốc và bằng chứng]].
- 2026-07-23 — Bug OCR thật được tách thành detector và recognizer; brainstorm định hướng hai thread B/A; [[2026-07-23-in-bubble-ocr-recall-worklog#Phiên brainstorm v2 + chẩn đoán bug thật (2026-07-23)|xem mốc và bằng chứng]].
- 2026-07-23 — Các giả thuyết được chốt thành spec/plan riêng cho recall và layout; [[2026-07-23-in-bubble-ocr-recall-worklog#Phiên thiết kế thread B + A (2026-07-23, tiếp) — brainstorm → spec → plan|xem mốc và bằng chứng]].
- 2026-07-28 — Không rõ lỗi B2/B3 nên thêm chẩn đoán và knob detector; nguyên nhân được phân tách; [[2026-07-23-in-bubble-ocr-recall-worklog#Task 1 — Chẩn đoán B2/B3 + knob detector ✅ (2026-07-28)|xem mốc và bằng chứng]].
- 2026-07-28 — Recall thấp được xử lý bằng full-res, padding và upscale; Thread B đóng; [[2026-07-23-in-bubble-ocr-recall-worklog#Thread B — recall OCR hoàn tất ✅ (2026-07-28)|xem mốc và bằng chứng]].
- 2026-07-28 — Thiếu thao tác theo layout nên thêm hành động tương ứng; Thread A đóng chức năng chính; [[2026-07-23-layout-translation-actions-worklog#Thread A — hành động dịch theo bố cục hoàn tất trên v2 ✅ (2026-07-28)|xem mốc và bằng chứng]].
- 2026-07-28 — Race responsive/stale còn lại được harden; Thread A qua vòng sửa cuối; [[2026-07-23-layout-translation-actions-worklog#Tiếp tục Thread A — hardening cuối (2026-07-28)|xem mốc và bằng chứng]].
- 2026-07-29 — Quota một project gây gián đoạn nên thêm failover hai project có kiểm soát concurrency; phiên đóng; [[2026-07-29-viewport-ocr-prewarm-gemini-failover-worklog#Gemini project failover — đóng phiên cũ (2026-07-29)|xem mốc và bằng chứng]].
- 2026-07-29 — Latency đo thật dẫn tới ưu tiên streaming/session cache thay vì đổi model; [[2026-07-29-progressive-translation-worklog#Đo latency thật + phương án tối ưu (2026-07-29)|xem mốc và bằng chứng]].
- 2026-07-29 — Box trùng gây overlay lặp nên thêm dedupe; kết quả trùng được loại bỏ; [[2026-07-29-progressive-translation-worklog#Dedupe box trùng — xong ✅ (2026-07-29)|xem mốc và bằng chứng]].
- 2026-07-29 — Roadmap được đối chiếu với triển khai thật; phạm vi tiếp theo được hiệu chỉnh; [[2026-07-29-progressive-translation-worklog#Kiểm chứng lại `ocr-manga-extension-roadmap.md` (2026-07-29)|xem mốc và bằng chứng]].
- 2026-07-29 — So sánh DeepL cho thấy đổi model không giải quyết nút thắt chính; giữ hướng hiện tại; [[2026-07-29-progressive-translation-worklog#DeepL thay Gemini? — phân tích (2026-07-29)|xem mốc và bằng chứng]].
- 2026-07-29 — Phiên điều tra đóng với streaming, cache và dedupe làm hướng triển khai; [[2026-07-29-progressive-translation-worklog#Trạng thái khi đóng phiên (2026-07-29)|xem mốc và bằng chứng]].
- 2026-07-30 — Pipeline chờ lâu được tách thành streaming và session cache; Tasks 1–8 hoàn tất; [[2026-07-29-progressive-translation-worklog#Progressive translation + session cache — Task 1–8 hoàn tất (2026-07-30)|xem mốc và bằng chứng]].
- 2026-07-30 — Các phần còn lại mở rộng tới Task 9–10 và chuẩn bị acceptance/benchmark; [[2026-07-29-progressive-translation-worklog#Cập nhật Task 9–10 — 2026-07-30|xem mốc và bằng chứng]].
- 2026-07-31 — Cần tái lập race/fault thật nên dựng browser control plane và cases có kiểm soát; [[2026-07-30-browser-acceptance-harness-worklog#Task 9–10 — browser acceptance có kiểm soát (2026-07-31)|xem mốc và bằng chứng]].
- 2026-07-31 — Worker restart cần replay an toàn; full Chrome restart Case 8 đạt PASS; [[2026-07-30-browser-acceptance-harness-worklog#Case 8 — full Chrome restart PASS (2026-07-31)|xem mốc và bằng chứng]].
- 2026-07-31 — Thiếu số liệu production nên khóa fixture và quy trình cold/warm benchmark; [[2026-07-31-cold-benchmark-fixture-worklog#Task 10 — chuẩn bị benchmark production (2026-07-31)|xem mốc và bằng chứng]].
- 2026-07-31 — Chạy 20 cold + 20 warm trên production server; evidence benchmark được lưu; [[2026-07-31-cold-benchmark-fixture-worklog#Benchmark production — 20 cold + 20 warm (2026-07-31)|xem mốc và bằng chứng]].
- 2026-08-01 — Telemetry thiếu contract đầy đủ nên dừng sau Task 2 để review; [[2026-08-01-telemetry-real-fixture-quality-gate-worklog#Spec A — tạm dừng sau Task 2 (2026-08-01)|xem mốc và bằng chứng]].
- 2026-08-02 — Review Tasks 1–3 phát hiện lệch telemetry/contract; findings được phân loại và sửa; [[2026-08-01-telemetry-real-fixture-quality-gate-worklog#Spec A — code review Task 1–3 (2026-08-02)|xem mốc và bằng chứng]].
- 2026-08-02 — Các vòng sửa Tasks 1–3 được re-review; review đóng với evidence; [[2026-08-01-telemetry-real-fixture-quality-gate-worklog#Spec A — đóng review Task 1–3 (2026-08-02)|xem mốc và bằng chứng]].
- 2026-08-02 — Fixture trang thật chưa canonical nên chuẩn hóa bộ fixture; Task 4 hoàn tất; [[2026-08-01-telemetry-real-fixture-quality-gate-worklog#Spec A — Task 4 canonical real-page fixtures hoàn tất (2026-08-02)|xem mốc và bằng chứng]].
- 2026-08-02 — Offset âm vi phạm contract nên bổ sung validation; re-review Tasks 1–3 được đóng; [[2026-08-01-telemetry-real-fixture-quality-gate-worklog#Spec A — re-review Task 1–3: sửa contract offset âm (2026-08-02)|xem mốc và bằng chứng]].
- 2026-08-02 — Review fixture phát hiện sai lệch nên sửa tại `9cf369c`; Task 4 qua re-review; [[2026-08-01-telemetry-real-fixture-quality-gate-worklog#2026-08-02 — Spec A Task 4: sửa theo re-review (9cf369c)|xem mốc và bằng chứng]].
- 2026-08-02 — Policy cần tái lập nên thêm deterministic probe và coverage; Task 5 có evidence; [[2026-08-01-telemetry-real-fixture-quality-gate-worklog#2026-08-02 — Spec A Task 5: deterministic policy probe (a7c16da, 8ff3bf5, b62d777)|xem mốc và bằng chứng]].
- 2026-08-02 — Human re-review xác nhận policy probe; Task 5 đóng; [[2026-08-01-telemetry-real-fixture-quality-gate-worklog#2026-08-02 — Spec A Task 5: đóng human re-review (72c5cbf)|xem mốc và bằng chứng]].
- 2026-08-02 — Chất lượng cần gate offline nên thêm kiểm tra xác định; Task 6 chạy xanh; [[2026-08-01-telemetry-real-fixture-quality-gate-worklog#2026-08-02 — Spec A Task 6: offline quality gate (1fa3e15, 1546912, 34a591f)|xem mốc và bằng chứng]].
- 2026-08-02 — Human re-review kiểm tra gate offline và đóng vòng sửa tiếp theo; [[2026-08-01-telemetry-real-fixture-quality-gate-worklog#2026-08-02 — Spec A Task 6: đóng human re-review (d7092a1, b35cc4f)|xem mốc và bằng chứng]].
- 2026-08-02 — Hai Minor cuối được sửa và re-review PASS; Task 6 đóng; [[2026-08-01-telemetry-real-fixture-quality-gate-worklog#2026-08-02 — Spec A Task 6: re-review PASS và đóng 2 Minor (356d6b9, 1b7308c)|xem mốc và bằng chứng]].
- 2026-08-03 — Cần baseline trang thật nên chạy offline quality gate và lưu evidence Task 7; [[2026-08-01-telemetry-real-fixture-quality-gate-worklog#2026-08-03 — Spec A Task 7: real-page baseline + offline quality gate (277f9df)|xem mốc và bằng chứng]].
- 2026-08-03 — Human rubric đánh giá baseline thật và ký xác nhận Task 7; [[2026-08-01-telemetry-real-fixture-quality-gate-worklog#2026-08-03 — Spec A Task 7: human rubric sign-off (7721576)|xem mốc và bằng chứng]].
- 2026-08-03 — Regression/audit tổng hợp evidence và bàn giao Spec A sau Task 8; [[2026-08-01-telemetry-real-fixture-quality-gate-worklog#2026-08-03 — Spec A Task 8: regression, audit và handoff|xem mốc và bằng chứng]].
- 2026-08-03 — Rerun paced so sánh mode và chọn `full_page`; quyết định/evidence được lưu; [[2026-08-03-paced-quality-gate-rerun-worklog#2026-08-03 — Spec A paced quality-gate rerun: chọn `full_page`|xem mốc và bằng chứng]].
- 2026-08-05 — Fixture hợp nhất với reading order, direction và cache; Spec B Tasks 1–4 tiến triển; [[2026-08-04-reading-order-full-page-translation-worklog#2026-08-05 — Spec B Tasks 1–4: merge fixture, reading order và direction/cache|xem mốc và bằng chứng]].
- 2026-08-05 — Đối chiếu plan phát hiện bug trong Tasks 1–4; phạm vi fix được xác định; [[2026-08-04-reading-order-full-page-translation-worklog#2026-08-05 — Đối chiếu plan ban đầu và bug trong Tasks 1–4|xem mốc và bằng chứng]].
- 2026-08-05 — Review fix sửa lỗi Tasks 3–4; contract reading order được củng cố; [[2026-08-04-reading-order-full-page-translation-worklog#2026-08-05 — Spec B review fix Tasks 3–4|xem mốc và bằng chứng]].
- 2026-08-05 — Portuguese thiếu OCR phù hợp nên dùng chung Latin OCR đã pin; Task 5 hoàn tất; [[2026-08-04-reading-order-full-page-translation-worklog#2026-08-05 — Spec B Task 5: Portuguese dùng chung Latin OCR|xem mốc và bằng chứng]].
- 2026-08-05 — Cần vertical slice đầy đủ nên siết contract và dịch full-page; Task 6 hoàn tất; [[2026-08-04-reading-order-full-page-translation-worklog#2026-08-05 — Spec B Task 6: strict contract và full-page vertical slice|xem mốc và bằng chứng]].
- 2026-08-05 — Checkpoint offline tổng hợp toàn pipeline Spec B; Task 7 đạt gate; [[2026-08-04-reading-order-full-page-translation-worklog#2026-08-05 — Spec B Task 7: full offline checkpoint|xem mốc và bằng chứng]].
- 2026-08-05 — Finding sau checkpoint được sửa tại `8a4b08d`; checkpoint sạch; [[2026-08-04-reading-order-full-page-translation-worklog#2026-08-05 — Spec B post-checkpoint fix `8a4b08d`|xem mốc và bằng chứng]].
- 2026-08-05 — Runtime và whole-branch review kiểm chứng Spec B; Task 8 hoàn tất; [[2026-08-04-reading-order-full-page-translation-worklog#2026-08-05 — Spec B Task 8 runtime + final whole-branch review|xem mốc và bằng chứng]].
- 2026-08-05 — Review cuối phát hiện stale-stage nên thêm cleanup follow-up; race được đóng; [[2026-08-04-reading-order-full-page-translation-worklog#2026-08-05 — Spec B post-final review stale-stage follow-up|xem mốc và bằng chứng]].
- 2026-08-05 — Spec B đóng sau verification và cleanup cuối; [[2026-08-04-reading-order-full-page-translation-worklog#2026-08-05 — Spec B closed|xem mốc và bằng chứng]].
- 2026-08-09 — Spec C bắt đầu để render sạch tại chỗ; primitives và resolver Tasks 1–2 hình thành; [[2026-08-08-in-place-clean-overlay-rendering-worklog#2026-08-09 — Spec C: in-place clean overlay rendering (Tasks 1–2)|xem mốc và bằng chứng]].
- 2026-08-09 — OCR quy về page-space và lưu render artifact lossless; Tasks 2–4 hoàn tất; [[2026-08-08-in-place-clean-overlay-rendering-worklog#2026-08-09 — Spec C Tasks 2–4: page-space OCR và lossless render artifact|xem mốc và bằng chứng]].
- 2026-08-09 — Join/render atomic cùng post-review fixes hoàn tất Tasks 5–8; [[2026-08-08-in-place-clean-overlay-rendering-worklog#2026-08-09 — Spec C Tasks 5–8 và post-review fixes|xem mốc và bằng chứng]].
- 2026-08-12 — Cache, recovery và overlay in-place được review; Tasks 9–11 hoàn tất; [[2026-08-08-in-place-clean-overlay-rendering-worklog#2026-08-12 — Spec C Tasks 9–11: overlay in-place hoàn tất review|xem mốc và bằng chứng]].
- 2026-08-13 — OCR vùng lỗi được retry có giới hạn; Task 12 đóng sau review; [[2026-08-08-in-place-clean-overlay-rendering-worklog#2026-08-13 — Spec C Task 12: bounded OCR recovery hoàn tất review|xem mốc và bằng chứng]].
- 2026-08-13 — Delivery accounting tách lỗi Port và bảo toàn kết quả; Task 13 hoàn tất; [[2026-08-08-in-place-clean-overlay-rendering-worklog#2026-08-13 — Spec C Task 13: delivery accounting và cô lập lỗi Port|xem mốc và bằng chứng]].
- 2026-08-14 — Telemetry và atomic acceptance gate đạt Task 14; Task 15 browser/manual vẫn mở; [[2026-08-08-in-place-clean-overlay-rendering-worklog#2026-08-14 — Spec C Task 14: telemetry và acceptance gate|xem mốc và bằng chứng]].
- 2026-08-14 — Fixture sai hình học và race telemetry làm Gate B/G thiếu tin cậy; sửa bằng patch xác định + binding-local timestamp, visual QA và cold/warm benchmark đạt Task 15; [[2026-08-08-in-place-clean-overlay-rendering-worklog#2026-08-14 — Spec C Task 15: browser/manual acceptance và cold/warm benchmark|xem mốc và bằng chứng]].

## Work items

Các work item là đơn vị ownership; spec, plan và artifact liên quan được khai báo trong frontmatter từng note.

### [[2026-07-21-manga-translator-foundation-worklog|MangaTranslator foundation]]

- Phiên bản: [[feat-v1]].
- Trạng thái: `incomplete`.
- Mạch chính: Server, extension và pipeline nền tảng; Tasks 1–7 đóng, Task 8 còn mở.

### [[2026-07-23-in-bubble-ocr-recall-worklog|In-bubble OCR recall]]

- Phiên bản: [[feat-v1]].
- Trạng thái: `done`.
- Mạch chính: Chẩn đoán B2/B3 và cải thiện full-res, padding, upscale; Thread B đóng.

### [[2026-07-23-layout-translation-actions-worklog|Layout translation actions]]

- Phiên bản: [[feat-v1]].
- Trạng thái: `done`.
- Mạch chính: Hành động dịch theo layout cùng hardening stale/responsive races; Thread A đóng.

### [[2026-07-29-viewport-ocr-prewarm-gemini-failover-worklog|Viewport OCR prewarm và Gemini failover]]

- Phiên bản: [[feat-v2]].
- Trạng thái: `done`.
- Mạch chính: Prewarm/dedupe viewport OCR và failover Gemini hai project có kiểm soát concurrency.

### [[2026-07-29-progressive-translation-worklog|Progressive translation]]

- Phiên bản: [[feat-v2]].
- Trạng thái: `done`.
- Mạch chính: Streaming, session cache, latency, dedupe, roadmap và quyết định giữ Gemini.

### [[2026-07-30-browser-acceptance-harness-worklog|Browser acceptance harness]]

- Phiên bản: [[feat-v2]].
- Trạng thái: `done`.
- Mạch chính: Control plane/fault harness và các case Chrome có kiểm soát.

### [[2026-07-31-cold-benchmark-fixture-worklog|Cold benchmark fixture]]

- Phiên bản: [[feat-v2]].
- Trạng thái: `done`.
- Mạch chính: 20 cold + 20 warm trên production server với JSON evidence.

### [[2026-08-01-telemetry-real-fixture-quality-gate-worklog|Telemetry và real-fixture quality gate]]

- Phiên bản: [[feat-v3]].
- Trạng thái: `done`.
- Mạch chính: Telemetry, fixture thật, policy probe, offline quality gate và human review.

### [[2026-08-03-paced-quality-gate-rerun-worklog|Paced quality-gate rerun]]

- Phiên bản: [[feat-v3]].
- Trạng thái: `done`.
- Mạch chính: Pace probe chọn `full_page` và lưu quyết định/evidence.

### [[2026-08-04-reading-order-full-page-translation-worklog|Reading order và full-page translation]]

- Phiên bản: [[feat-v3]].
- Trạng thái: `done`.
- Mạch chính: Reading order, direction, Portuguese Latin OCR, strict contract và full-page cleanup.

### [[2026-08-02-cross-model-review-protocol-worklog|Cross-model review protocol]]

- Phiên bản: [[feat-v3]], [[feat-v4]].
- Trạng thái: `done`.
- Mạch chính: Evidence-mediated review giữa Codex và Claude, áp dụng tại `5196832`.

### [[2026-08-02-rtk-code-intelligence-routing-worklog|RTK và code-intelligence routing]]

- Phiên bản: [[feat-v3]], [[feat-v4]].
- Trạng thái: `done`.
- Mạch chính: Đo truncation và chốt intelligence-first, RTK-last tại `5196832`.

### [[2026-08-03-workflow-guide-worklog|Workflow guide]]

- Phiên bản: [[feat-v4]].
- Trạng thái: `done`.
- Mạch chính: End-to-end workflow bằng `workflow-guide.md` và commit `c2de341`.

### [[2026-08-08-in-place-clean-overlay-rendering-worklog|In-place clean overlay rendering]]

- Phiên bản: [[feat-v4]], [[feat-v5]].
- Trạng thái: `done`.
- Mạch chính: Spec C Tasks 1–15, Gate A–G, visual QA và cold/warm benchmark đã PASS; thay đổi Task 15 chờ Git integration riêng.
