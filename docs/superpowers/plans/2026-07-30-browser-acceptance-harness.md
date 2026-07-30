# Browser Acceptance Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic localhost-only synthetic server and fixture controls that let the real Chrome extension prove Task 10 cases 1, 6, 7, 9, and 10 without exposing fault behavior in production.

**Architecture:** A separate `server.acceptance_app:app` serves byte-distinct synthetic page images, protocol-compatible health/OCR/translation endpoints, and a bounded control/state API. The existing fixture gains query-selected reader, loaded, and fault modes plus a small control panel; production `server.main:app` remains untouched.

**Tech Stack:** Python 3.12, FastAPI, Starlette `TestClient`, Python standard library, plain HTML/CSS/JavaScript, Chrome MV3 extension.

## Global Constraints

- Do not modify `server/main.py` or expose acceptance controls through the production app.
- Bind the acceptance app to `127.0.0.1:8910`; reject non-loopback control requests and do not enable CORS.
- Every mutating control request requires `Content-Type: application/json`; reset and release use an empty `{}` body.
- Add no dependency and no binary fixture; generate byte-distinct valid A/B/C/D PNG payloads from the existing fixture image with Python's standard library.
- Retain only synthetic page labels, stages, event names, sequence numbers, and numeric counters; cap events at 500 rows.
- Return `Cache-Control: no-store` on synthetic page assets.
- Normal `extension/test/fixture.html` behavior without an `acceptance` query parameter must remain unchanged.
- Use TDD for every implementation task and preserve the live untracked `.tmp-task10-browser/` directory.
- The synthetic app verifies orchestration only; run the real production server for the 20-cold/20-warm performance benchmark.

## File Map

- Create `server/acceptance_app.py`: isolated synthetic app, state machine, gates, fault injection, fixture/assets, and extension-compatible endpoints.
- Create `server/tests/test_acceptance_app.py`: control, asset, gate, fault, disconnect, ordering, and retention tests.
- Modify `extension/test/fixture.html`: query-selected acceptance modes and localhost control panel; unchanged normal mode.
- Modify `docs/superpowers/worklogs/2026-07-30-progressive-translation-verification.md`: record only observed harness/browser results after execution.

---

### Task 1: Acceptance Control Plane and Synthetic Assets

**Files:**
- Create: `server/acceptance_app.py`
- Create: `server/tests/test_acceptance_app.py`

**Interfaces:**
- Produces: `app: FastAPI` for `uvicorn server.acceptance_app:app`.
- Produces: `await AcceptanceState.configure(config: AcceptanceConfig) -> None`.
- Produces: `await AcceptanceState.release(stage: str, page: str) -> None`.
- Produces: `await AcceptanceState.reset() -> None`.
- Produces: `await AcceptanceState.snapshot() -> dict[str, object]`.
- Produces: `await AcceptanceState.gate(stage: str, page: str) -> asyncio.Event | None`.
- Produces: `await AcceptanceState.record(stage: str, page: str, event: str) -> None`.
- Produces: `page_png(page: str) -> bytes` with a stable, unique digest for A/B/C/D.
- Produces routes: `/health`, `/fixture.html`, `/assets/{page}.png`, `/__acceptance/reset`, `/__acceptance/config`, `/__acceptance/release/{stage}/{page}`, and `/__acceptance/state`.

- [ ] **Step 1: Write failing control-plane tests**

Create `server/tests/test_acceptance_app.py` with these concrete tests and helpers:

```python
import asyncio
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi.testclient import TestClient

from server.acceptance_app import (
    AcceptanceConfig,
    AcceptanceState,
    EVENT_LIMIT,
    app,
    page_png,
)


def client() -> TestClient:
    return TestClient(
        app,
        base_url="http://127.0.0.1",
        client=("127.0.0.1", 50000),
    )


def post_json(http: TestClient, path: str, body: dict | None = None):
    return http.post(path, json={} if body is None else body)


def test_health_fixture_and_assets_are_isolated_and_deterministic():
    with client() as http:
        health = http.get("/health").json()
        assert health["status"] == "ok"
        assert health["versions"]["page_schema"] == "acceptance-page-v1"
        fixture = http.get("/fixture.html?acceptance=reader")
        assert fixture.status_code == 200
        assert "MangaTranslator layout fixture" in fixture.text
        payloads = [http.get(f"/assets/{page}.png") for page in "ABCD"]
        assert all(response.status_code == 200 for response in payloads)
        assert all(response.headers["cache-control"] == "no-store" for response in payloads)
        assert len({response.content for response in payloads}) == 4
        assert [response.content for response in payloads] == [page_png(page) for page in "ABCD"]


def test_control_validation_reset_release_and_snapshot():
    with client() as http:
        assert post_json(http, "/__acceptance/reset").status_code == 200
        config = {
            "hold": {"source": ["A"], "ocr": ["B"], "translation": ["D"]},
            "fail": {
                "source_after_load": ["C"],
                "ocr_block": ["B"],
                "translation_batch": ["D"],
            },
            "blocks": {"A": 1, "B": 2, "C": 1, "D": 4},
        }
        assert post_json(http, "/__acceptance/config", config).status_code == 200
        state = http.get("/__acceptance/state").json()
        assert state["config"] == config
        assert post_json(http, "/__acceptance/release/ocr/B").status_code == 200
        assert post_json(http, "/__acceptance/release/ocr/B").status_code == 200
        assert "B" not in http.get("/__acceptance/state").json()["config"]["hold"]["ocr"]
        assert post_json(http, "/__acceptance/reset").status_code == 200
        reset = http.get("/__acceptance/state").json()
        assert reset["counts"] == {
            "page_load": 0,
            "source": 0,
            "ocr_stream": 0,
            "translation": 0,
            "source_aborted": 0,
            "ocr_aborted": 0,
            "active_source": 0,
            "peak_source": 0,
        }
        assert reset["events"] == []


def test_control_rejects_non_json_unknown_values_and_non_loopback():
    with client() as http:
        assert http.post("/__acceptance/reset", content=b"").status_code == 415
        bad_stage = {"hold": {"decode": ["A"]}, "fail": {}, "blocks": {}}
        assert post_json(http, "/__acceptance/config", bad_stage).status_code == 422
        bad_page = {"hold": {"ocr": ["Z"]}, "fail": {}, "blocks": {}}
        assert post_json(http, "/__acceptance/config", bad_page).status_code == 422
        assert post_json(http, "/__acceptance/release/ocr/Z").status_code == 422
    with TestClient(
        app,
        base_url="http://example.test",
        client=("203.0.113.1", 50000),
    ) as remote:
        assert remote.post("/__acceptance/reset", json={}).status_code == 403


def test_event_log_is_bounded_and_reset_sets_old_gates():
    runtime = AcceptanceState()

    async def exercise():
        await runtime.configure(AcceptanceConfig(hold={"source": ["A"]}))
        gate = await runtime.gate("source", "A")
        for index in range(EVENT_LIMIT + 3):
            await runtime.record("source", "A", f"event-{index}")
        snapshot = await runtime.snapshot()
        await runtime.reset()
        return gate, snapshot

    gate, snapshot = asyncio.run(exercise())
    assert gate is not None and gate.is_set()
    assert len(snapshot["events"]) == EVENT_LIMIT
    assert snapshot["events"][0]["seq"] == 4
    assert snapshot["events"][-1]["seq"] == EVENT_LIMIT + 3
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_acceptance_app.py -q
```

Expected: collection fails with `ModuleNotFoundError: No module named 'server.acceptance_app'`.

- [ ] **Step 3: Implement the control state, validation, fixture, and assets**

Create `server/acceptance_app.py` with these constants and public shapes:

```python
import asyncio
import ipaddress
import struct
import zlib
from collections import deque
from hashlib import sha256
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, ConfigDict, Field, model_validator

PAGES = frozenset("ABCD")
STAGES = frozenset({"source", "ocr", "translation"})
FAULTS = frozenset({"source_after_load", "ocr_block", "translation_batch"})
EVENT_LIMIT = 500
ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "extension" / "test" / "fixture.html"
BASE_PNG = (ROOT / "extension" / "test" / "ja_page.png").read_bytes()


class HoldConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source: set[str] = Field(default_factory=set)
    ocr: set[str] = Field(default_factory=set)
    translation: set[str] = Field(default_factory=set)


class FailConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_after_load: set[str] = Field(default_factory=set)
    ocr_block: set[str] = Field(default_factory=set)
    translation_batch: set[str] = Field(default_factory=set)


class AcceptanceConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    hold: HoldConfig = Field(default_factory=HoldConfig)
    fail: FailConfig = Field(default_factory=FailConfig)
    blocks: dict[str, int] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_labels(self):
        configured = set().union(
            self.hold.source,
            self.hold.ocr,
            self.hold.translation,
            self.fail.source_after_load,
            self.fail.ocr_block,
            self.fail.translation_batch,
            self.blocks,
        )
        if not configured <= PAGES:
            raise ValueError("unknown synthetic page")
        if any(value < 1 or value > 16 for value in self.blocks.values()):
            raise ValueError("block count must be between 1 and 16")
        return self
```

Implement `page_png` by inserting a valid `tEXt` chunk immediately before the
existing PNG `IEND` chunk:

```python
def page_png(page: str) -> bytes:
    if page not in PAGES:
        raise KeyError(page)
    chunk_type = b"tEXt"
    chunk_data = f"acceptance-page\0{page}".encode()
    chunk = (
        struct.pack(">I", len(chunk_data))
        + chunk_type
        + chunk_data
        + struct.pack(">I", zlib.crc32(chunk_type + chunk_data) & 0xFFFFFFFF)
    )
    iend = BASE_PNG.rfind(b"\x00\x00\x00\x00IEND")
    if iend < 0:
        raise RuntimeError("fixture PNG has no IEND chunk")
    return BASE_PNG[:iend] + chunk + BASE_PNG[iend:]


PAGE_BY_DIGEST = {sha256(page_png(page)).hexdigest(): page for page in PAGES}
```

Implement `AcceptanceState` with an `asyncio.Lock`, one `asyncio.Event` per
held `(stage, page)`, `deque(maxlen=EVENT_LIMIT)`, a monotonic sequence, exact
counter keys from the test, and JSON-safe `snapshot()` output. `configure`
replaces the previous configuration. `release` removes the label from the
selected hold set and sets the matching event. `reset` sets every old event
before clearing config, counters, events, analysis mappings, and consumed
one-shot translation faults. `snapshot()` serializes the config with
`model_dump(mode="json")` and sorts every page-label list so endpoint output is
deterministic.

Add a dependency used by every control route through
`dependencies=[Depends(control_request)]`:

```python
async def control_request(request: Request) -> None:
    host = request.client.host if request.client else ""
    try:
        loopback = ipaddress.ip_address(host).is_loopback
    except ValueError:
        loopback = False
    if not loopback:
        raise HTTPException(status_code=403, detail="loopback only")
    if request.method == "POST":
        media_type = request.headers.get("content-type", "").split(";", 1)[0]
        if media_type != "application/json":
            raise HTTPException(status_code=415, detail="application/json required")
```

Return fixed acceptance versions from `/health`, serve `FIXTURE` through
`FileResponse`, and serve `/assets/{page}.png` through `Response` with
`media_type="image/png"` and `Cache-Control: no-store`. Task 2 will add source
gates to the same asset route.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_acceptance_app.py -q
```

Expected: all Task 1 tests pass.

- [ ] **Step 5: Run formatting/diff checks and commit Task 1**

Run:

```powershell
git diff --check
git status --short
git add server/acceptance_app.py server/tests/test_acceptance_app.py
git commit -m "test: add browser acceptance control plane"
```

Expected: `.tmp-task10-browser/` remains untracked and the two Task 1 files are
the only committed paths.

---

### Task 2: Protocol-Compatible Gates and Fault Injection

**Files:**
- Modify: `server/acceptance_app.py`
- Modify: `server/tests/test_acceptance_app.py`

**Interfaces:**
- Consumes: `AcceptanceState`, `AcceptanceConfig`, `PAGE_BY_DIGEST`, and control routes from Task 1.
- Produces: held/failing extension source requests through `GET /assets/{page}.png` when `Sec-Fetch-Dest` is not `image`.
- Produces: `POST /ocr-stream` with production NDJSON event shapes.
- Produces: `POST /translate-items` with production item-ID semantics.
- Produces counters/events required by browser cases: entered, held, released, failed, completed, and aborted.

- [ ] **Step 1: Add failing source gate/failure tests**

Append tests that distinguish the initial `<img>` load from the extension's
later service-worker fetch:

```python
def test_source_load_is_free_but_extension_fetch_can_hold_release_and_fail():
    with client() as http:
        post_json(http, "/__acceptance/reset")
        post_json(http, "/__acceptance/config", {
            "hold": {"source": ["A"]},
            "fail": {"source_after_load": ["C"]},
            "blocks": {},
        })
        page_load = http.get("/assets/A.png", headers={"sec-fetch-dest": "image"})
        assert page_load.status_code == 200
        with ThreadPoolExecutor(max_workers=1) as pool:
            held = pool.submit(http.get, "/assets/A.png", headers={"sec-fetch-dest": "empty"})
            assert wait_for_count(http, "active_source", 1)
            assert post_json(http, "/__acceptance/release/source/A").status_code == 200
            assert held.result(timeout=2).status_code == 200
        failed = http.get("/assets/C.png", headers={"sec-fetch-dest": "empty"})
        assert failed.status_code == 500
        state = http.get("/__acceptance/state").json()
        assert state["counts"]["source"] == 2
        assert state["counts"]["peak_source"] == 1
        assert any(row["event"] == "failed" and row["page"] == "C" for row in state["events"])
```

Add `wait_for_count(http, key, value, timeout=2.0)` using `time.monotonic()` and
`time.sleep(0.01)`; on timeout it returns `False` rather than hiding the final
state.

- [ ] **Step 2: Add failing OCR stream tests**

Use the real multipart field names and assert event ordering:

```python
def ocr_form(page: str, analysis: str, ocr: str):
    return {
        "data": {"analysis_key": analysis, "ocr_key": ocr, "src_lang": "ja"},
        "files": {"image": (f"{page}.png", page_png(page), "image/png")},
    }


def ndjson(response):
    return [json.loads(line) for line in response.text.splitlines() if line.strip()]


def test_ocr_stream_holds_releases_and_preserves_good_block_on_fault():
    with client() as http:
        post_json(http, "/__acceptance/reset")
        post_json(http, "/__acceptance/config", {
            "hold": {"ocr": ["B"]},
            "fail": {"ocr_block": ["B"]},
            "blocks": {"B": 2},
        })
        payload = ocr_form("B", "analysis-B", "ocr-B")
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(http.post, "/ocr-stream", **payload)
            assert wait_for_event(http, stage="ocr", page="B", event="held")
            post_json(http, "/__acceptance/release/ocr/B")
            events = ndjson(pending.result(timeout=2))
        assert [row["type"] for row in events] == [
            "analysis_ready", "ocr_block", "ocr_block_error", "image_done"
        ]
        assert events[-1] == {
            "type": "image_done", "recognized": 1, "failed": 1
        }
```

Also test a request without `image`: it returns `409` until its
`analysis_key` has been populated, then replays the same page label from the
stored analysis mapping.

Add a direct disconnect test around the shared gate helper so abort accounting
does not depend on thread timing:

Update the Task 1 import to include `wait_gate` after Task 2 defines it.

```python
def test_wait_gate_counts_source_and_ocr_disconnects_once():
    class DisconnectedRequest:
        async def is_disconnected(self):
            return True

    async def exercise():
        runtime = AcceptanceState()
        await runtime.configure(AcceptanceConfig(
            hold={"source": ["A"], "ocr": ["B"]}
        ))
        assert not await wait_gate("source", "A", DisconnectedRequest(), runtime)
        assert not await wait_gate("ocr", "B", DisconnectedRequest(), runtime)
        return await runtime.snapshot()

    snapshot = asyncio.run(exercise())
    assert snapshot["counts"]["source_aborted"] == 1
    assert snapshot["counts"]["ocr_aborted"] == 1
```

- [ ] **Step 3: Add failing translation batch tests**

Define request models compatible with the production endpoint and prove a
one-shot D failure followed by success:

```python
def test_translation_batch_fault_is_consumed_once_and_ids_stay_exact():
    with client() as http:
        post_json(http, "/__acceptance/reset")
        post_json(http, "/__acceptance/config", {
            "hold": {},
            "fail": {"translation_batch": ["D"]},
            "blocks": {"D": 4},
        })
        first = http.post("/translate-items", json={
            "src_lang": "ja",
            "dst_lang": "vi",
            "items": [
                {"id": "D-1", "text": "D:block-1"},
                {"id": "D-2", "text": "D:block-2"},
                {"id": "D-3", "text": "D:block-3"},
            ],
        })
        assert first.status_code == 502
        second = http.post("/translate-items", json={
            "src_lang": "ja",
            "dst_lang": "vi",
            "items": [{"id": "D-4", "text": "D:block-4"}],
        })
        assert second.status_code == 200
        assert second.json() == {
            "items": [{"id": "D-4", "translation": "vi:D:block-4"}]
        }
```

Add a held translation test that waits for the state event, releases the gate,
and verifies the response completes with each input ID exactly once.

- [ ] **Step 4: Run the new tests and verify RED**

Run:

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_acceptance_app.py -q
```

Expected: failures show that source gating, `/ocr-stream`, and
`/translate-items` are not implemented yet.

- [ ] **Step 5: Implement source request classification and accounting**

In the asset route, treat `Sec-Fetch-Dest: image` as a page load. It increments
`page_load` and always succeeds. Every other request increments `source`,
`active_source`, and `peak_source`, records `entered`, applies the source gate,
and then either fails or completes. Use `try/finally` so `active_source`
returns to zero exactly once.

Implement this shared wait operation:

```python
async def wait_gate(
    stage: str,
    page: str,
    request: Request,
    runtime: AcceptanceState = state,
) -> bool:
    gate = await runtime.gate(stage, page)
    if gate is None:
        return True
    await runtime.record(stage, page, "held")
    while not gate.is_set():
        if await request.is_disconnected():
            await runtime.aborted(stage, page)
            return False
        try:
            await asyncio.wait_for(gate.wait(), timeout=0.05)
        except TimeoutError:
            pass
    await runtime.record(stage, page, "released")
    return True
```

For a disconnected asset request, return status `499`; Chrome may discard that
response, while the harness retains the aborted counter/event.

- [ ] **Step 6: Implement deterministic OCR streaming**

Add production-compatible form parameters and an async generator. Resolve the
page from the uploaded image digest and store `analysis_key -> page`; without
an image, return `409` when the mapping is absent. Emit:

```python
{"type": "analysis_ready", "analysis_key": analysis_key,
 "image_w": 800, "image_h": 1200, "regions": block_count}
```

Then wait on the OCR gate. For a normal page, emit one `ocr_block` per configured
block with IDs like `A-1`, bbox `[80, 80, 240, 120]`, and `src_text` like
`A:block-1`. For `ocr_block` fault pages, emit the first good block, one
`ocr_block_error` with `code="recognizer_failed"`, and finish with the exact
recognized/failed counts. Finish every non-disconnected stream with
`image_done`.

- [ ] **Step 7: Implement deterministic translation and one-shot batch failure**

Validate `src_lang` in `{"ja", "es"}`, reject duplicate input IDs with `422`,
derive a single page label from every `text`, and reject mixed-page batches.
Apply the translation gate. If the configured page has an unconsumed
`translation_batch` fault, mark it consumed, record `failed`, and return `502`.
Otherwise return:

```python
{"items": [
    {"id": item.id, "translation": f"{body.dst_lang}:{item.text}"}
    for item in body.items
]}
```

Record one translation count per endpoint call, not per block.

- [ ] **Step 8: Verify Task 2 and commit**

Run:

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_acceptance_app.py -q
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests -q
git diff --check
git add server/acceptance_app.py server/tests/test_acceptance_app.py
git commit -m "test: add deterministic acceptance faults"
```

Expected: focused and full Python suites pass, and only the two Task 2 files are
committed.

---

### Task 3: Acceptance Fixture Modes and Control Panel

**Files:**
- Modify: `extension/test/fixture.html`
- Modify: `server/tests/test_acceptance_app.py`

**Interfaces:**
- Consumes: Task 1 fixture/asset/control routes and Task 2 state schema.
- Produces: `acceptance=reader`, `acceptance=loaded`, and `acceptance=faults` DOM modes before extension `document_idle`.
- Produces: panel actions for reset, configure preset, release, and state refresh.

- [ ] **Step 1: Add a failing fixture contract test**

Append:

```python
def test_fixture_declares_all_acceptance_modes_and_panel_controls():
    with client() as http:
        html = http.get("/fixture.html?acceptance=reader").text
    for token in [
        'acceptance === "reader"',
        'acceptance === "loaded"',
        'acceptance === "faults"',
        'id="acceptancePanel"',
        'id="acceptanceStage"',
        'id="acceptancePage"',
        'id="acceptanceState"',
        'data-action="reset"',
        'data-action="hold"',
        'data-action="release"',
        'data-action="faults"',
    ]:
        assert token in html
```

- [ ] **Step 2: Run the fixture test and verify RED**

Run:

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_acceptance_app.py::test_fixture_declares_all_acceptance_modes_and_panel_controls -q
```

Expected: FAIL because the fixture has no acceptance modes or panel.

- [ ] **Step 3: Add query-selected image sets before content script startup**

In the existing inline script, compute:

```javascript
const acceptance = new URLSearchParams(location.search).get("acceptance");
const acceptanceSources = Object.fromEntries(
  ["A", "B", "C", "D"].map((page) => [page, `/assets/${page}.png`])
);
```

When `acceptance === "reader"`, remove the webtoon section and spacer, keep the
reader image, and set reader A/B sources to acceptance A/B. When
`acceptance === "loaded"`, remove the reader section and replace the webtoon
children with exactly A/B/C images. Assign A/B/C classes that create far-above,
near, and far-below positions while keeping all three loaded. When
`acceptance === "faults"`, remove the reader section and replace the webtoon
children with A/B/C/D images. Do not run any of this mutation when
`acceptance` is absent.

- [ ] **Step 4: Add the localhost acceptance panel**

Add hidden markup that becomes visible only for a valid acceptance mode:

```html
<aside id="acceptancePanel" hidden>
  <strong>Acceptance controls</strong>
  <select id="acceptanceStage">
    <option value="source">source</option>
    <option value="ocr">ocr</option>
    <option value="translation">translation</option>
  </select>
  <select id="acceptancePage">
    <option>A</option><option>B</option><option>C</option><option>D</option>
  </select>
  <button data-action="reset">Reset</button>
  <button data-action="hold">Hold</button>
  <button data-action="release">Release</button>
  <button data-action="faults">Fault preset</button>
  <pre id="acceptanceState"></pre>
</aside>
```

Use same-origin `fetch` with JSON bodies. `hold` posts a complete replacement
config containing the selected stage/page. `faults` posts the fixed A/B/C/D
fault preset from the design spec. `release` posts `{}` to the selected path.
After every mutation and every 500 ms while the panel is visible, refresh
`/__acceptance/state`; stop polling on `pagehide`.

- [ ] **Step 5: Verify normal mode stayed unchanged**

Run the existing static server and inspect the no-query fixture source:

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_acceptance_app.py -q
node --test extension/test/srcset.test.js extension/test/content.test.js extension/test/content-progressive.test.js
git diff --check
```

Expected: focused Python and content/source-selection tests pass. The default
fixture still contains two webtoon images and one A/B reader before any
acceptance query is applied.

- [ ] **Step 6: Commit Task 3**

Run:

```powershell
git add extension/test/fixture.html server/tests/test_acceptance_app.py
git commit -m "test: add controlled browser acceptance fixture"
```

Expected: only the fixture and its contract test are committed.

---

### Task 4: Full Verification, Real-Chrome Evidence, and Worklog

**Files:**
- Modify: `docs/superpowers/worklogs/2026-07-30-progressive-translation-verification.md`

**Interfaces:**
- Consumes: complete synthetic app and fixture from Tasks 1-3.
- Produces: reproducible browser evidence for Task 10 cases 1, 6, 7, 9, and 10.
- Produces: updated repository worklog with actual counters/events and explicit pending items.

- [ ] **Step 1: Run the fresh automated verification gate**

Run:

```powershell
node --test extension/test/background.test.js extension/test/background-progressive.test.js extension/test/page-cache.test.js extension/test/srcset.test.js extension/test/content.test.js extension/test/content-progressive.test.js extension/test/popup.test.js extension/test/progressive-integration.test.js
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests -q
git diff --check
```

Expected: Node reports 8/8 passing files; Python includes all acceptance-app
tests and passes; diff check is clean.

- [ ] **Step 2: Replace the production test server with the acceptance app**

Resolve the exact listener PID on port 8910, verify its executable and command
line, stop only that PID, then start the acceptance app hidden:

```powershell
$listener = Get-NetTCPConnection -LocalPort 8910 -State Listen
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
$process | Select-Object ProcessId, ExecutablePath, CommandLine
Stop-Process -Id $listener.OwningProcess
Start-Process -FilePath 'D:\MangaTranslator\venv\Scripts\python.exe' `
  -ArgumentList '-m','uvicorn','server.acceptance_app:app','--host','127.0.0.1','--port','8910' `
  -WorkingDirectory 'D:\MangaTranslator\.worktrees\progressive-session-translation' `
  -RedirectStandardOutput 'D:\MangaTranslator\.worktrees\progressive-session-translation\.tmp-task10-browser\acceptance.out.log' `
  -RedirectStandardError 'D:\MangaTranslator\.worktrees\progressive-session-translation\.tmp-task10-browser\acceptance.err.log' `
  -WindowStyle Hidden
```

Verify `/health` reports `acceptance-page-v1` before opening the fixture.

- [ ] **Step 3: Execute case 1 stale navigation**

Reset/configure `hold.ocr=["A"]`, open
`http://127.0.0.1:8910/fixture.html?acceptance=reader`, start A translation,
switch to B and start B translation, then wait until B appears. Release A and
assert the reader DOM contains B text only. Save the final state JSON and DOM
counts in the worklog.

- [ ] **Step 4: Execute case 6 worker restart replay**

Reset/configure `hold.translation=["A"]`, start visible A, and wait until the
harness records translation `held`. In `chrome://serviceworker-internals`, find
`chrome-extension://ammnjkhmbdkobkdcddpbkmpignmckddn/` and click **Stop** for
that worker only; do not click the extension card's Reload button. Release A,
reopen the popup to wake the worker, and assert the job completes with one DOM
bubble per block ID and no duplicated translated text. Record both translation
attempt events and final cache/background counts.

- [ ] **Step 5: Execute case 7 loaded-scope cancellation**

Reset/configure `hold.source=["A","B"]`, open `acceptance=loaded`, and start
`Dịch webtoon đã tải`. Wait for `active_source=2` and verify no `source/C`
`entered` event exists. Navigate the fixture tab away or reload it. Assert
`source_aborted=2`, `active_source=0`, and still no `source/C entered` event.

- [ ] **Step 6: Execute case 9 near-before-far and popup status**

Reset/configure source holds for the far A/C pages, return to
`acceptance=loaded`, scroll B into the viewport, and start loaded scope. Verify
the first translated overlay/event belongs to B. Release A/C, wait for
completion, close/reopen the popup, and record matching background/cache/error
status and state counters.

- [ ] **Step 7: Execute case 10 three controlled failure runs**

Run `acceptance=faults` three times with reset between runs:

1. Configure `ocr_block=["B"]`, translate A/B, and assert A plus B's good block remain while failed count is one.
2. Configure `source_after_load=["C"]`, translate A/C, and assert A remains while C contributes one failed image.
3. Configure `translation_batch=["D"]` and `blocks.D=4`, translate D, and assert the later D-4 block remains after the first three-block batch fails.

For each run, store the config, state counters/events, popup result, and DOM
bubble texts/counts in the worklog. Do not infer a pass from appearance alone.

- [ ] **Step 8: Stop the acceptance app and restore production server**

Resolve and verify the current port-8910 listener, stop only the acceptance
process, then restart `server.main:app` with the same hidden-process pattern.
Verify `/health` returns production `page-v1` versions before benchmark work.

- [ ] **Step 9: Update and commit the evidence worklog**

Update `docs/superpowers/worklogs/2026-07-30-progressive-translation-verification.md`
with commit range, exact automated counts, the five harness case results,
counter/event evidence, test difficulties, and reasons for every failure or
retry. Leave case 8 full-browser restart and the 20/20 production benchmark
explicitly pending until actually executed.

Run:

```powershell
git diff --check
git add docs/superpowers/worklogs/2026-07-30-progressive-translation-verification.md
git commit -m "docs: record controlled browser acceptance"
```

Expected: only verified facts are marked pass; no synthetic timing is reported
as production performance.

---

## Post-plan Continuation

After this plan completes, resume the existing Task 10 plan for:

1. full Chrome restart clearing `chrome.storage.session` (browser case 8);
2. at least 20 real cold and 20 real warm visible samples against
   `server.main:app`;
3. final repository and Obsidian worklog updates;
4. fresh whole-branch review and `superpowers:finishing-a-development-branch`.
