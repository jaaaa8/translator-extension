---
title: feat/v2
note_type: version-summary
version: feat/v2
base: feat/v1
date_start: 2026-07-29
date_end: 2026-07-31
status: done
tags:
  - mangatranslator/version
---

# feat/v2

## Kết luận

66 non-merge commit chuyển pipeline sang progressive delivery, thêm acceptance harness và benchmark production cold/warm.

## Git facts

- Range topology: `feat/v1..feat/v2`.
- Non-merge commit: 66.
- Khoảng thời gian: 2026-07-29 → 2026-07-31.

## Work items

- [[2026-07-29-viewport-ocr-prewarm-gemini-failover-worklog]]
- [[2026-07-29-progressive-translation-worklog]]
- [[2026-07-30-browser-acceptance-harness-worklog]]
- [[2026-07-31-cold-benchmark-fixture-worklog]]

## Vấn đề và cách giải quyết

- **Vấn đề:** Latency toàn trang, box trùng và session reload làm trải nghiệm chậm. **Cách giải quyết:** Streaming OCR/translation theo stable id, dedupe và session page artifacts.
- **Vấn đề:** Race/restart/fault browser chưa tái lập có kiểm soát. **Cách giải quyết:** Dựng acceptance control plane với fault cases.
- **Vấn đề:** Thiếu baseline production cold so với warm. **Cách giải quyết:** Chạy fixture 20 cold + 20 warm và lưu JSON evidence.

## Verification

Topology delta `feat/v1..feat/v2` có 66 non-merge commit; browser và benchmark evidence nằm trong worklogs/artifacts. Migration không tái chạy product tests.

## Còn lại

Không suy ra Foundation Task 8 đã đóng chỉ từ trạng thái done của delta v2.

## Key commits

- `b920fdd` — feat: prewarm and dedupe viewport OCR jobs
- `36fd4d0` — docs: specify progressive translation workflow
- `770d728` — feat: stream OCR blocks over NDJSON
- `91b1553` — feat: translate comic blocks by stable id
- `90e88bc` — feat: persist session page artifacts
- `4ea75ea` — test: add browser acceptance control plane
- `daf80e2` — docs: benchmark 20 cold + 20 warm tren server production
