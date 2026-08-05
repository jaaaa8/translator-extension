# Spec B final-review fix report

## Root cause

`finishProducer()` and `failProducer()` completed their existing consumers, then awaited `removeProducerJobs()` before deleting `producers[pageKey]`. A late scope in that await-window attached to the terminal producer; its `enqueued` flag prevented a new schedule, so the new consumer did not receive `image_done` or `scope_done`.

## RED / GREEN evidence

- RED before the production change: `node extension/test/background-progressive.test.js` exited 1 with `timed out waiting for scope_done event`; the late port contained only `page_job_accepted` and `progress` for terminal partial state.
- Mutation check: moving either `producers.delete(producer.pageKey)` back after `await removeProducerJobs(producer)` reproduced the same focused-test timeout.
- GREEN: `node extension/test/background-progressive.test.js` printed `background-progressive.test.js transport OK`.
- GREEN: `node extension/test/popup.test.js` printed `popup.test.js OK`.

## Change and record

- Implementation commit: `3fc910d86c4a32b959b92dbd4a570a4cd969ceda` (`fix: retire terminal producers before cleanup`).
- Files: `extension/background.js`, `extension/test/background-progressive.test.js`, `extension/test/popup.test.js`.
- Worklog status: `resolved-after-final-review`, pinned to the implementation SHA above. Frozen control/runtime numbers and live-quality claims were not edited.

## Verification

- Focused Node gates above, plus the complete sequential 10-file Node suite.
- `git diff --check` clean for both commits.
- No Python tests, live server checks, or `server/tests/test_ocr.py` execution.
