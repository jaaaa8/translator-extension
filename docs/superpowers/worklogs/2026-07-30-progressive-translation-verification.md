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

A source/OCR was held; B then completed source/OCR/translation and rendered
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

- Case 8, a full Chrome restart/session-clearing check, remains pending and is
  not claimed.
- The 20-cold/20-warm real-production benchmark remains pending; no synthetic
  timing has been presented as production measurement.
- Known warnings: FastAPI/Starlette `httpx` deprecation, vendored detector
  `pkg_resources` deprecation, and missing Paddle `ccache`.
