---
title: feat/v5
note_type: version-summary
version: feat/v5
base: feat/v4
date_start: 2026-08-09
date_end: 2026-08-14
status: incomplete
tags:
  - mangatranslator/version
---

# feat/v5

## Kết luận

25 non-merge commit hiện có triển khai Spec C tới Task 14. Task 15, Gate A–G và cold/warm benchmark đã PASS trong worktree, nhưng code/spec/evidence còn uncommitted nên version vẫn incomplete tới khi Git integration hoàn tất.

## Git facts

- Range topology: `feat/v4..feat/v5`.
- Non-merge commit: 25.
- Khoảng thời gian: 2026-08-09 → 2026-08-14.

## Work items

- [[2026-08-08-in-place-clean-overlay-rendering-worklog]]

## Vấn đề và cách giải quyết

- **Vấn đề:** Overlay cần render artifact lossless, atomic paint, recovery và delivery accounting. **Cách giải quyết:** Thêm artifact primitives, page-space resolver, late join và atomic overlay.
- **Vấn đề:** Telemetry phải phân biệt translation thành công với painted outcome. **Cách giải quyết:** Thêm bounded OCR recovery, per-job delivery và atomic overlay acceptance gate.
- **Vấn đề:** Fixture sai hình học và cleanup sớm làm visual gate sai cùng warm telemetry thiếu mẫu. **Cách giải quyết:** Dùng source/patch xác định, giữ timestamp trên binding và khóa browser cold/warm bằng sample count.

## Verification

Topology delta `feat/v4..feat/v5` vẫn có 25 non-merge commit. Canonical worklog ghi Task 15 PASS với server **273 passed**, extension **50 passed**, cold `20` mẫu và warm `21` mẫu; kết quả chưa thuộc Git topology vì chưa commit.

## Còn lại

Stage/commit riêng code/spec/evidence Task 15 khi người dùng yêu cầu, rồi refresh Git facts trước khi chuyển version sang `done`.

## Key commits

- `82c122b` — feat: add spec c artifact primitives
- `5f61499` — feat: add detection result and region resolver
- `d1e2d1f` — feat: build lossless render artifacts
- `3719e36` — feat: join translation with render artifacts
- `3b4397b` — feat: render clean translation overlays atomically
- `fc8dbed` — feat: add bounded ocr recovery
- `b1ec9cc` — feat: track per-job delivery across recovery
- `6770d74` — feat: add atomic overlay acceptance gate
