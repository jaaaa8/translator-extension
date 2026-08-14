---
title: feat/v1
note_type: version-summary
version: feat/v1
base: root
date_start: 2026-07-21
date_end: 2026-07-29
status: done
tags:
  - mangatranslator/version
---

# feat/v1

## Kết luận

Nền tảng server/extension/OCR/layout hình thành qua 33 non-merge commit và merge `62948d7`; trạng thái done chỉ áp dụng delta version, không che Foundation Task 8 còn mở.

## Git facts

- Range topology: `feat/v1`.
- Non-merge commit: 33.
- Khoảng thời gian: 2026-07-21 → 2026-07-29.
- Merge được ghi riêng: `62948d7` — Merge branch 'main' vào feat/v1.

## Work items

- [[2026-07-21-manga-translator-foundation-worklog]]
- [[2026-07-23-in-bubble-ocr-recall-worklog]]
- [[2026-07-23-layout-translation-actions-worklog]]

## Vấn đề và cách giải quyết

- **Vấn đề:** Thiếu pipeline end-to-end từ server tới overlay. **Cách giải quyết:** Dựng FastAPI, detector/OCR/Gemini pipeline và Chrome MV3 overlay.
- **Vấn đề:** OCR bubble và hành động layout gặp lỗi recall, responsive source và stale race. **Cách giải quyết:** Tách B2/B3, cải thiện crop/padding/upscale và harden layout race.
- **Vấn đề:** Quota một Gemini project có thể dừng phiên dịch. **Cách giải quyết:** Thêm failover Gemini hai project với giới hạn concurrency.

## Verification

Git topology ghi 33 non-merge commit và merge `62948d7`; worklog lịch sử giữ evidence triển khai. Không chạy lại product tests trong migration này.

## Còn lại

Foundation Task 8 vẫn mở; version sau không cung cấp bằng chứng đóng riêng task này.

## Key commits

- `b6100ee` — Add MangaTranslator design spec (extension + local FastAPI pipeline)
- `5cd5b78` — feat: full /translate pipeline (detect -> ocr -> gemini)
- `d3a3776` — feat: content script - image detection, document-coords overlay, autofit
- `44351ad` — feat: diagnostic tool tách B2/B3 + knob conf/input_size cho detector
- `6084405` — fix: guard responsive sources and language races
- `d016038` — feat: fail over to a secondary Gemini project on quota
