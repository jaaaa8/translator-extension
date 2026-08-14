---
title: feat/v3
note_type: version-summary
version: feat/v3
base: feat/v2
date_start: 2026-07-31
date_end: 2026-08-05
status: done
tags:
  - mangatranslator/version
---

# feat/v3

## Kết luận

72 non-merge commit bổ sung telemetry/quality gate trang thật, reading order và full-page translation.

## Git facts

- Range topology: `feat/v2..feat/v3`.
- Non-merge commit: 72.
- Khoảng thời gian: 2026-07-31 → 2026-08-05.

## Work items

- [[2026-08-01-telemetry-real-fixture-quality-gate-worklog]]
- [[2026-08-03-paced-quality-gate-rerun-worklog]]
- [[2026-08-04-reading-order-full-page-translation-worklog]]
- [[2026-08-02-cross-model-review-protocol-worklog]]
- [[2026-08-02-rtk-code-intelligence-routing-worklog]]

## Vấn đề và cách giải quyết

- **Vấn đề:** Telemetry thiếu attribution và fixture trang thật canonical. **Cách giải quyết:** Thêm cache telemetry, first-overlay attribution, policy probe và offline quality gate.
- **Vấn đề:** Reading direction, Portuguese OCR và full-page contract chưa đầy đủ. **Cách giải quyết:** Thêm reading order, Latin OCR dùng chung, strict contract và cleanup.
- **Vấn đề:** Review/routing agent thiếu giao thức evidence rõ ràng. **Cách giải quyết:** Thiết kế cross-model review cùng RTK/code-intelligence routing.

## Verification

Topology delta `feat/v2..feat/v3` có 72 non-merge commit; JSON quality evidence được giữ nguyên. Migration không tái chạy các gate sản phẩm.

## Còn lại

Done mô tả delta v3; backlog ngoài work items này không tự động đóng.

## Key commits

- `43c0016` — feat: report server analysis cache telemetry
- `01d1dfe` — feat: attribute first overlay timing per page
- `c6d963b` — test: add reviewed real-page OCR fixtures
- `a7c16da` — feat: add deterministic real-page policy probe
- `1fa3e15` — test: enforce offline translation quality gate
- `665769a` — feat: pace real-page quality probe
- `04e695e` — feat: add deterministic page reading order
- `fec60ac` — feat: share pinned Latin OCR for Portuguese
- `a37fbde` — feat: translate complete pages in reading order
- `3fc910d` — fix: retire terminal producers before cleanup
