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
