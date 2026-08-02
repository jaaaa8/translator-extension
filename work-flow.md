# MangaTranslator workflow (current)

## Progressive translation

```text
popup action
  -> content snapshot + candidate descriptors
  -> start_scope Port
  -> background page/job lookup + viewport-first scheduler
  -> /ocr-stream analysis_ready + ocr_block
  -> background micro-batch /translate-items
  -> content stale guard + blockId upsert
  -> page artifact complete/partial in chrome.storage.session
```

`visible` snapshots the current viewport crop and persists its manual job until
completion. `loaded` snapshots every eligible loaded image at full-image scope;
nearer images are scheduled first, and disconnected requests do not keep loaded
jobs alive. Leaving the viewport does not remove an overlay. Replacing the image
source or DOM node detaches it without deleting the cached artifact.

The content script owns request freshness and rendering. Consecutive actions use
`replaces_request_id`; late events must match request, job, source signature,
crop, and languages before they can upsert a bubble. A Port reconnect resends the
active scope, while the service worker rehydrates persisted visible jobs from
`chrome.storage.session` after restart.

The background owns cache identity, scheduling, OCR streaming, translation
micro-batches, partial failures, and completion. Exact page artifacts replay
without source, OCR, or translation calls. An OCR-compatible sibling can reuse
analysis/OCR while translating for another destination language. Cache keys
include source/crop, dimensions, languages, model versions, prompt/policy, and
schema version; metrics never participate in identity or persisted artifacts.

## Status and metrics

The popup reads `{background,cached,failed}` from `pageStatus`; closing it does
not own or cancel work. `scope_done.metrics` reports queue wait, fetch, analysis,
first OCR, first translation, and total milliseconds. Content reports the first
visible overlay through `render_metric`. The development-only
`benchmarkSummary` runtime message returns p50/p95 latency aggregates and bounded
counters from the latest 100 in-memory samples. It never returns URLs, OCR text,
translations, or session page records.

## Compatibility

Legacy runtime messages (`ocrImage`, `translateTexts`, `health`, `prewarmJob`)
and server endpoints (`/ocr`, `/translate-texts`, `/translate`) remain available.
Prewarm uses the lowest scheduler tier, performs OCR only, and does not render.

## 2026-08-01 — Telemetry và real-page quality gate

`scope_done.page_metrics` có một row cho mỗi job. Các mốc stage (`queue_wait_ms`,
`first_ocr_ms`, `ocr_done_ms`, `first_translation_ms`, `final_translation_ms`,
`first_overlay_ms`, `total_ms`) là elapsed từ lúc producer nhận job; `accepted_offset_ms`
là offset producer-accepted so với lúc scope nhận request. `translation_batches[].duration_ms`
là duration của từng request extension → `/translate-items`. Stage không chạy phải giữ
`null`, không thay bằng `0`; aggregate scope chỉ dùng fallback `0` cho `fetch_ms`/
`analysis_ms` khi không có page row đo được.

Regression handoff hiện tại: Python suite `server/tests` có 183 passed (3 warning dependency)
và 9 JS test file có exit 0; đây là automated coverage, không thay thế evidence browser/Gemini bên dưới.

Fixture canonical được serve cục bộ tại `127.0.0.1:8000`; mở trang fixture bằng Chrome
với extension đã cài, thực hiện đúng một popup action cho cold/warm và lấy `page_metrics`
từ service-worker runtime sample. Baseline `translation_batches[].block_ids` của cold run
được ghép một-một với bbox fixture. Capture Gemini dùng runner
`server.run_real_page_probe run` với manifest và baseline đã chọn; evaluate offline dùng
`server.run_real_page_probe evaluate --manifest ... --capture ... --scores ... --out ...`.
Không dùng evaluator để gọi Gemini.

Worklog `docs/superpowers/worklogs/2026-08-01-real-page-quality-baseline.json` là nguồn
quyết định hiện tại: real-browser telemetry cold/warm đã chạy; detector/OCR transcript và
reading order fixture đã được người đọc review, và `jaa` đã xác nhận 16 rubric rows hợp
lệ. Policy probe có 16 response hợp lệ nhưng decision vẫn `inconclusive`: JA1
`batch_control` chỉ có một response hợp lệ. Portuguese chỉ là diagnostic
(`production_pt_supported=false`), không phải production proof. Không có policy Spec B/C
hay sửa overlay Spec C trong gate này.

### Cổng chuyển giao Spec B/C

Chỉ khi có policy thắng, Spec B mới được đổi production `/translate-items`: prompt item
phải mang đúng allowlist `id`, `text`, `reading_order`, `bbox` và page dimensions như
`comic-page-eval-v1`; prompt version, policy version và cache key phải đổi cùng contract.
Đây là việc Spec B, không được đưa vào commit telemetry này. Spec C vẫn sở hữu overlap,
crop che chữ, clipping, erasure/inpainting và semantics `partial`/popup.
