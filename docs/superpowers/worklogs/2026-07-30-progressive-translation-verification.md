# Progressive translation verification — 2026-07-30

## Revision and automated evidence

- Task 10 base/implementation: `ec3df53..50c3b81`.
- Fix Round 1: the commit containing this worklog, whose parent is `50c3b81`
  (reproduce with `git diff 50c3b81 HEAD`).
- Fix Round 2: the commit containing this worklog, whose parent is `6f00f49`
  (reproduce with `git diff 6f00f49 HEAD`).
- Fix Round 3: the commit containing this worklog, whose parent is `5731c7c`
  (reproduce with `git diff 5731c7c HEAD`).
- Fix Round 4: the commit containing this worklog, whose parent is `13b4ac1`
  (reproduce with `git diff 13b4ac1 HEAD`).
- Fix Round 5: the commit containing this worklog, whose parent is `de48fab`
  (reproduce with `git diff de48fab HEAD`).
- Focused cross-layer test: 1/1 passed.
- Exact Node suite: 8/8 files passed.
- Python: 69 passed, 3 dependency/deprecation warnings, 0 failed.
- Cross-layer harness loads production `page-cache.js`, `background.js`,
  `srcset.js`, and `content.js` in two VMs connected only through paired fake
  Ports. It shares fake `chrome.storage.session` and a fake NDJSON server.
- Automated cases verified: stale A/B navigation, exact artifact replay with no
  extra source/OCR/translation calls, exact-crop miss, near-before-far loaded
  scheduling, replacement while source/OCR/translation are each deferred,
  Port disconnect plus simulated worker termination (old Port delivery, storage
  mutation, and fetch continuations revoked) followed by new-VM restart/replay,
  isolated OCR/image/translation
  faults with valid output retained, visible and loaded scopes, repeated status
  reads during live work, `scope_done` monotonic metrics, first-overlay merge,
  actual 100-sample eviction, and absence of URL/OCR/translation text from
  `benchmarkSummary`.
- Warm exact-cache replay uses asynchronous Port delivery; its late
  `render_metric` updates the matching retained sample. After eviction, a late
  metric for the old request is ignored, proving correlation state is bounded
  with the same 100-sample lifetime.
- Mixed progressive Port and legacy `ocrImage` runtime traffic shares the single
  two-slot scheduler. The deferred mixed-path regression observes peak source/
  OCR work <= 2 while both public response paths complete.
- Benchmark counters union producer identities across the retained request
  samples, so duplicate consumers and cross-request sharing count each actual
  producer call once without exposing those identities in the runtime summary.
- Retained counter contributors are shared lightweight records containing only
  `translation_calls`, `rate_limited`, and `stale_work` numbers; samples retain
  no producer/page/descriptor/block/URL/text/promise graph, and contributor
  reachability ends with the same 100-sample eviction lifecycle.

## Browser acceptance

Status: **pending; not executed and P0 is not claimed complete**.

This run had no Chrome instance with this worktree loaded as an unpacked
extension and no controllable extension service-worker DevTools target. Loading
an unpacked extension and reloading its MV3 worker require user-visible Chrome
state; shell-only HTTP processes do not provide that environment. Therefore no
browser case was marked pass. The ten cases in Task 10 Step 7 remain pending:
stale A/B navigation, exact cache network silence, offscreen retention, source
detach, destination-language OCR reuse, worker restart replay, loaded-scope
cancellation, browser-restart session clearing, near/far priority plus popup
reopen, and the three fault controls.

## Benchmark

Status: **pending; no 20-sample measurements were fabricated**.

| Mode | Samples | first overlay p50 | first overlay p95 | total vs baseline | blocks |
|---|---:|---:|---:|---:|---:|
| cold visible | 0 | pending | pending | pending | pending |
| warm visible | 0 | pending | pending | pending | pending |

The automated VM test proves the summary shape and privacy boundary only. A
real run still needs at least 20 cold and 20 warm visible samples on one machine,
hardware/Chrome/Python/model versions, queue/fetch/analysis/first OCR/first
translation/total/cancel timings, hit/miss reasons, stale work, translation
calls/429, and a same-fixture baseline. Targets remain p50 <= 5 s, p95 <= 8 s,
total regression <= 10%, and no block-count loss.

## Warnings and open acceptance

- FastAPI/Starlette reports the existing `httpx` deprecation warning.
- `pkg_resources` is deprecated in the vendored detector utility.
- Paddle reports that `ccache` is not installed.
- Automated integration does not replace the pending real-browser cases or
  performance measurements above.
