---
title: Progressive translation verification
note_type: artifact
artifact_type: verification
work_item: progressive-translation
date_start: 2026-07-30
date_end: 2026-07-30
status: done
versions:
  - "[[feat-v2]]"
tags:
  - mangatranslator/artifact
---
# Progressive translation verification — 2026-07-30

## Revision and automated evidence

- Controlled browser-acceptance work: `6056c67..b2037be`, including health
  contract fix `023b00c`, fixture-only prewarm fix `a351855`, and its reviewed
  boundary coverage `b2037be`.
- Exact Node gate: 8/8 files passed. Python suite: 85 passed, 3 known
  dependency/deprecation warnings, 0 failed. `git diff --check` passed.
- Chrome used the one enabled unpacked extension
  `dkfmlgjnanglgccfjfojakbdpgdlepbi`.
- Automated VM coverage remains the production-module cross-layer suite for
  cache, scheduling, progressive Port delivery, restart/replay, scoped
  cancellation, faults, and 100-sample summary retention; it is not a source
  of production timings.

## Real Chrome browser acceptance

### Case 1 — PASS: stale A/B navigation

A's OCR was held; B then completed source/OCR/translation and rendered
exactly `en:B:block-1`. Before A release, counters were `page_load=8,
source=2, ocr_stream=2, translation=1, source_aborted=0, ocr_aborted=0,
active_source=0, peak_source=1`. Releasing A produced no translation/A event,
no A overlay, and no duplicate B overlay.

Retry 1 exposed a harness contract defect: acceptance `/health` omitted
versions required by `buildKeys()`; `023b00c` supplied them. Synthetic A/B
pixels are visually identical despite byte-distinct inputs, and an auxiliary
in-app localhost tab prewarmed and polluted counters. Closing it plus a stable
double reset isolated the passing run.

### Case 6 — PASS: worker-stop replay

After extension Reload cleared session, the popup precondition was
`background=0, cached=0, errors=0`, then only A/vi was held in translation.
Stopping the MV3 worker caused two aborted replay attempts and a third held
attempt; release completed it. Final popup state was `background=0, cached=1,
errors=0`, with exactly one `vi:A:block-1` bubble.

An earlier run was inconclusive: cross-case session state left
`background=1, cached=2` after replay. Fake-background cleanup probes did not
reproduce a code defect; the clean retry separated session contamination from
the confirmed replay behavior.

### Case 7 — PASS: loaded-scope cancellation

The clean popup precondition was `background=0, cached=0, errors=0`, and
opening it generated no prewarm source event. Final counts were `page_load=3,
source=2, ocr_stream=0, translation=0, source_aborted=2, ocr_aborted=0,
active_source=0, peak_source=2`; events were A entered/held, B entered/held,
then A/B aborted, with no C source event.

`a351855` skips prewarm only on the loopback acceptance fixture; `b2037be`
covers localhost, wrong-port, and missing-parameter boundaries. Initial review
found those three test gaps; re-review approved the test-only follow-up. One
attempt stayed on `acceptance=reader` and had only A (operator URL mistake,
not scheduler behavior). A later multi-turn attempt allowed MV3 sleep/reconnect
and A/B replay; Translate → 3 seconds → F5 produced the clean absolute-two
abort result.

### Case 8 — PASS: full Chrome restart clears session cache

The static production fixture was `http://127.0.0.1:8000/fixture.html`, Reader
A, against production `server.main:app` PID `25764`. Before restart, the popup
began at `background=0, cached=0, errors=0`; visible translation completed as
`1 image, 1 dialogue, 0 errors` and settled at `background=0, cached=1,
errors=0`.

The user closed the full Chrome process and reopened it. Reader A then showed
`background=0, cached=0, errors=0`, proving `chrome.storage.session` cleared
from one cached page to zero. The production log checkpoint after popup
prewarm was line 31; the visible translation added exactly three lines through
line 34: `GET /health 200`, `POST /ocr-stream 200`, and
`POST /translate-items 200`. The popup again reported `1 image, 1 dialogue,
0 errors` and ended at `cached=1`. Those requests prove A ran cold after
restart rather than using an exact page-cache hit.

Chrome control correctly became unavailable when the browser process exited,
and one reconnection attempt failed. Diagnostics found Chrome running, the
ChatGPT Chrome Extension installed and enabled in the selected Default
profile, and the native-host manifest/registry correct, but the control
connection did not auto-reconnect. The test therefore continued manually;
the popup transition and production log independently establish the result.

### Case 9 — PASS: loaded ordering

With `hold.source=[A,C]`, A entered/held, B source/OCR/translation completed
and rendered first as `vi:B:block-1`, then C entered/held. Releasing A/C
completed both; final `active_source=0` and popup failures were zero. One
MV3 sleep/reconnect replay occurred across a chat delay, so this case claims
first-result ordering and idempotent completion, not exact no-replay. Final
`background=0, cached=0, errors=0` is expected for loaded scope: it has no
`persistUntilDone` cache consumer.

### Case 10 — PASS: controlled faults

- OCR block fault (`fail.ocr_block=[B]`, `blocks.B=2`): counts
  `page_load=4, source=4, ocr_stream=4, translation=4, aborted=0, active=0,
  peak=1`; B OCR failed but B translation completed. Popup was `4 images,
  4 dialogues, 1 error`; B had only `vi:B:block-1`, no B-2.
- Source-after-load fault (`fail.source_after_load=[C]`): counts
  `page_load=0, source=4, ocr_stream=3, translation=3, aborted=0, active=0,
  peak=1`; C entered then failed with no OCR/translation C, while A/B/D
  completed. Popup was `4 images, 3 dialogues, 1 error`; DOM had one bubble on
  A/B/D and none on C.
- Translation batch fault (`fail.translation_batch=[D]`, `blocks.D=4`): counts
  `page_load=0, source=4, ocr_stream=4, translation=5, source_aborted=0,
  ocr_aborted=0, active=0, peak=1`; D failed then retried/completed and showed
  only `vi:D:block-4`, no D1-D3. Popup was `4 images, 4 dialogues, 3 errors`.

The first run-3 click used “Translate current page”, yielding A only and
cache 1; harness events confirmed that scope. This was an operator misclick,
not a product failure. Extension Reload plus page F5 cleared session/overlays;
the top loaded-webtoon action produced the clean passing run. All loaded-scope
final popup states were `background=0, cached=0, errors=0`, as expected.

## Benchmark — 20 cold and 20 warm visible samples (2026-07-31)

Raw per-sample evidence: `docs/superpowers/worklogs/2026-07-31-cold-warm-benchmark.json`.

### Harness

Chrome `150.0.7871.187` in a throwaway profile, driven over CDP by a
dependency-free Node `24.15.0` script (scratchpad, not committed). Chrome 150
ignores `--load-extension`, so the worktree extension
`D:\MangaTranslator\.worktrees\progressive-session-translation\extension` was
installed through `Extensions.loadUnpacked` under
`--enable-unsafe-extension-debugging`; it took the same id
`dkfmlgjnanglgccfjfojakbdpgdlepbi` used in the acceptance cases. A DevTools
session stayed attached to the MV3 worker for the whole run, so no sleep,
reconnect, or replay noise entered the samples.

Each sample is the popup's own action — `chrome.tabs.sendMessage(tab,
{type: "translatePage", scope: "visible", srcLang: "ja", dstLang: "vi"})` —
issued from the worker, with `fixture-benchmark.js` advancing `#readerPage`
between samples exactly as designed. The popup was never opened, so no prewarm
assisted any counted sample. Server was production `server.main:app` on
`127.0.0.1:8910`, `cuda`, `page_schema=page-v1`,
`translator_model=gemini-flash-lite-latest`,
`policy=microbatch-3-8-250-500-v1`; fixture served from `127.0.0.1:8000`.

Pass 1 (cold) ran 20 unique sources `ja_page.png?benchmark=1..20`. Because
`buildKeys()` derives `analysisKey` from `sourceUrl.href`, each source missed
both `chrome.storage.session` and the server `_analysis_cache`/`_ocr_cache`.
Pass 2 (warm) replayed the same 20 sources after a page reload, with session
storage untouched. Each pass discarded one warm-up sample.

### Results

| metric | cold p50 | cold p95 | cold max | warm p50 | warm p95 |
| --- | --- | --- | --- | --- | --- |
| `first_overlay_ms` | 984 | 1322 | 1401 | 4 | 8 |
| `total_ms` | 986 | 1323 | 1402 | 3 | 6 |
| `first_translation_ms` | 977 | 1315 | 1393 | n/a | n/a |
| `first_ocr_ms` | 207 | 240 | 538 | n/a | n/a |
| `queue_wait_ms` | 1 | 2 | 3 | n/a | n/a |
| `fetch_ms` | 4 | 4 | 5 | 0 | 0 |
| `analysis_ms` | 0 | 0 | 0 | 0 | 0 |

Cold: 20/20 `cacheHit=false`, 20 unique sources, 0 failed blocks,
`translation_calls=21` (20 counted plus the discarded warm-up),
`rate_limited=0`, `stale_work=0`. Warm: 20/20 `cacheHit=true`,
`translation_calls=0` — exact page hits reached zero server calls.
`blocks=1` on all 40 samples, unchanged between passes.
`cancel_latency_ms` is null: this benchmark never cancels, and case 7 already
covers cancellation.

### Gate

- Visible first overlay p50 ≤ 5 s: **PASS** at 0.98 s.
- Visible first overlay p95 ≤ 8 s: **PASS** at 1.32 s.
- Block count must not decrease: **PASS**, 1 block on every sample.
- Total ≤ 10% slower than baseline: **NOT EVALUATED**. No numeric
  pre-progressive total-scope time for this fixture is recorded anywhere in
  the repository, and the legacy `ocrImage` path is OCR-only, so it is not a
  like-for-like comparison. Closing this needs a recorded baseline, not
  another run of this harness.

### Limits of this measurement

`ja_page.png` is an 800x1200 synthetic page holding exactly one speech bubble.
These numbers therefore bound the transport, scheduling, and cache paths, not
the latency of a dense real manga page: the OCR loop runs once per sample here,
while a real page runs it per block. The gate above is the gate the plan
defined on this fixture; it is not a claim about production reading latency.

One further real cost is excluded by design: the first OCR request after the
server starts pays lazy model construction. A separate single-sample warm-up
run measured `first_ocr_ms=9234`, `first_overlay_ms=10281` for that first
request, against `first_ocr_ms` around 207 ms once the engine is resident.

## Service state

Acceptance PID `25752` (`server.acceptance_app:app`) was stopped and port 8910
verified empty. A combined stop/start command was policy-blocked before it ran;
split exact `Stop-Process`, start, and health verification succeeded.
Production is restored as PID `25764` running `server.main:app`. Its health is
`ok`, device `cuda`, languages `ja`/`es`, and the complete production version
contract: detector `comic-text-detector-v1`, dedupe
`iou-0.5-area-bbox-v2`, prep `upscale48-border8-v1`, recognizers
`manga-ocr-v1`/`paddleocr-es-v1`, translator
`gemini-flash-lite-latest`, prompt `comic-items-v1`, policy
`microbatch-3-8-250-500-v1`, and `page_schema=page-v1`.

## Pending and warnings

- The 20-cold/20-warm real-production benchmark is done; see the benchmark
  section above. No synthetic timing has been presented as production
  measurement.
- The total-vs-baseline sub-gate stays open for lack of a recorded baseline,
  and the one-bubble fixture keeps these timings a floor rather than a
  production reading latency.
- Known warnings: FastAPI/Starlette `httpx` deprecation, vendored detector
  `pkg_resources` deprecation, and missing Paddle `ccache`.
