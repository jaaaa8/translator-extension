# Browser Acceptance Harness Design

Date: 2026-07-30
Status: approved for implementation planning

## Goal

Provide deterministic real-Chrome evidence for the remaining Task 10 browser
acceptance cases that require delayed work, worker interruption, cancellation,
scheduling order, or injected failures. The harness must exercise the real
extension while keeping every control and fault outside the production server.

## Non-goals

- Do not add debug, delay, or fault routes to `server/main.py`.
- Do not replace the production OCR/Gemini benchmark. The synthetic harness
  verifies orchestration and failure semantics; the existing real server is
  still used for performance sampling.
- Do not retain real image bytes, URLs, OCR text, or translations in harness
  state or logs.
- Do not add browser automation dependencies.

## Decision

Use a separate opt-in FastAPI application instead of production feature flags
or manual DevTools throttling.

Manual timing cannot reproduce cancellation and restart races reliably.
Production flags would reduce file count but expose fault behavior in the real
application. A synthetic localhost application gives deterministic control
without changing production behavior.

## Components

### Synthetic acceptance server

Create `server/acceptance_app.py`. It is launched explicitly and is never
imported by `server/main.py`.

The application binds to `127.0.0.1:8910`, serves the acceptance fixture and
synthetic page assets, and implements the extension-compatible endpoints:

- `GET /health`
- `POST /ocr-stream`
- `POST /translate-items`

It also implements test-only control endpoints:

- `POST /__acceptance/reset`
- `POST /__acceptance/config`
- `POST /__acceptance/release/{stage}/{page}`
- `GET /__acceptance/state`

The control endpoints accept only loopback requests. Every mutating POST
requires `application/json`; reset and release accept an empty `{}` body. The
app does not enable CORS.

### Fixture modes

Extend `extension/test/fixture.html` only when an `acceptance` query value is
present. Inline fixture setup runs before `document_idle`, so the extension
sees the final intended image set.

- `acceptance=reader`: one A/B reader image for stale-navigation and worker
  restart cases.
- `acceptance=loaded`: exactly three images with deterministic near/far
  positions for loaded-scope cancellation and priority.
- `acceptance=faults`: A/B/C/D images for mixed valid and failed work.

Normal fixture behavior without the query parameter remains unchanged.

The acceptance panel configures or releases gates and displays counters and a
bounded event log. Shell calls to the same endpoints remain available for
precise before/after measurements.

### Automated harness tests

Create `server/tests/test_acceptance_app.py` for the control protocol,
synthetic API behavior, failure injection, counters, and bounded state.

No production extension source changes are part of the harness design.

## Control model

Configuration uses synthetic page labels `A`, `B`, `C`, and `D` only.

```json
{
  "hold": {
    "source": ["A"],
    "ocr": ["A"],
    "translation": ["A"]
  },
  "fail": {
    "source_after_load": ["C"],
    "ocr_block": ["B"],
    "translation_batch": ["D"]
  },
  "blocks": {
    "A": 1,
    "B": 2,
    "D": 4
  }
}
```

Each gate is keyed by `stage + page`. Releasing a gate wakes every matching
request, including a request replayed after service-worker interruption.
`reset` releases all gates before clearing state so old requests cannot remain
blocked.

Unknown stages, pages, fault names, invalid block counts, and malformed bodies
return `422` without mutating state.

## Synthetic data flow

1. Chrome loads the fixture and named image assets from the acceptance server.
   The app produces valid, byte-distinct A/B/C/D PNG payloads from the existing
   fixture image using Python's standard library, so no image dependency or
   additional binary fixture is required.
2. Assets return `Cache-Control: no-store`, ensuring the extension's later
   source fetch reaches the harness.
3. The harness maps known asset bytes to a synthetic page label and associates
   the label with the submitted analysis key.
4. `/ocr-stream` emits deterministic NDJSON using the production event shapes:
   `analysis_ready`, zero or more `ocr_block`/`ocr_block_error` events, and
   `image_done`.
5. `/translate-items` returns deterministic text derived from the synthetic
   page label and destination language. Page D has four blocks so the first
   three-block batch can fail while a later one-block batch succeeds.
6. The real extension scheduler, storage, cancellation, replay, stale guards,
   micro-batching, and overlay rendering process those responses unchanged.

## Observable state

`GET /__acceptance/state` returns synthetic labels and numbers only:

```json
{
  "counts": {
    "source": 3,
    "ocr_stream": 2,
    "translation": 1,
    "source_aborted": 2,
    "ocr_aborted": 0,
    "active_source": 0,
    "peak_source": 2
  },
  "events": [
    {"seq": 1, "stage": "source", "page": "A", "event": "entered"}
  ]
}
```

Events record `entered`, `held`, `released`, `failed`, `completed`, and
`aborted` where applicable. Sequence numbers are monotonic. The event list is
capped at 500 rows; counters are not truncated.

## Acceptance case mapping

### Case 1: stale A/B navigation

Hold A during OCR. Start visible translation for A, switch to B, and translate
B. B must render first. After A is released, no A text may appear on B.

### Case 6: service-worker restart replay

Hold A translation after OCR artifacts are persisted. Interrupt/reload only
the MV3 service worker, then release A. Rehydration must finish the job without
duplicate bubbles. The event log must show the replayed attempt and the DOM
must contain one element per block ID.

### Case 7: loaded-scope cancellation

Use exactly three loaded images. Hold two source requests so both scheduler
slots are occupied and the third stays queued. Reload or navigate away from the
content page. Both active requests must abort, and the queued third source must
never enter the harness.

### Case 9: near-before-far priority and status

Place one image near the viewport and the others farther away. Hold a far
image, start loaded scope, and verify the near image's overlay/event occurs
first. Releasing the far image completes the scope. Closing and reopening the
popup must preserve correct background/cache/failed counts.

### Case 10: controlled partial failures

Run three isolated configurations:

- one valid page plus B with one good OCR block and one `ocr_block_error`;
- one valid page plus C whose extension source fetch fails after initial page
  load;
- D with four OCR blocks where the first translation batch fails and the final
  batch succeeds.

In every run, valid overlays remain visible and popup failure counts match the
synthetic state.

## Error and disconnect handling

- Held asset and OCR handlers check for client disconnects and increment the
  corresponding aborted counter once.
- Releasing or resetting an already released gate is idempotent.
- Faults are deterministic until reset; batch failure state advances only
  after the configured batch is actually entered.
- A failed request produces the same HTTP/NDJSON shape consumed by the real
  extension, not a harness-only shortcut.
- State mutations are protected so concurrent requests cannot corrupt active
  or peak counters.

## Security and data retention

- The harness is a separate localhost-only application and is not reachable
  through the production app.
- Control routes reject non-loopback clients and do not enable CORS.
- JSON-only mutating requests prevent cross-origin HTML form submissions from
  mutating state.
- Logs contain only synthetic labels, stages, event names, sequence numbers,
  and counters.
- The bounded event log prevents an acceptance run from retaining an
  unbounded request history.

## Verification

Automated tests must prove:

- reset/config/release validation and idempotence;
- hold/release for source, OCR, and translation;
- first page load success followed by configured extension source failure;
- source and OCR disconnect accounting;
- correct NDJSON ordering with good and failed OCR blocks;
- failed first translation batch followed by a successful later batch;
- event ordering, peak concurrency, and the 500-row limit;
- loopback and JSON control boundaries.

After the focused tests pass, run the exact eight-file Node gate, the complete
Python suite, `git diff --check`, and an independent code review. Then execute
browser cases 1, 6, 7, 9, and 10 against the synthetic app. Case 8 remains a
real full-Chrome restart check. The real production server remains the only
source for the 20-cold/20-warm performance benchmark.

## Run and cleanup

Stop the production server on port 8910, then run:

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m uvicorn server.acceptance_app:app --host 127.0.0.1 --port 8910
```

Open the appropriate fixture mode served by the acceptance app. At the end of
acceptance, stop the synthetic app and restart `server.main:app` before real
performance sampling.

## Success criteria

- All new harness tests and existing suites pass.
- Production server behavior and routes are unchanged.
- Browser cases produce deterministic counter and event sequences on repeated
  runs.
- No acceptance result is inferred solely from visual timing.
- Worklog records actual pass/fail evidence and leaves any unexecuted case
  explicitly pending.
