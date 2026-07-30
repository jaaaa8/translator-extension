import asyncio
import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi.testclient import TestClient

from server.acceptance_app import (
    AcceptanceConfig,
    AcceptanceState,
    EVENT_LIMIT,
    app,
    page_png,
    wait_gate,
)


def client() -> TestClient:
    return TestClient(
        app,
        base_url="http://127.0.0.1",
        client=("127.0.0.1", 50000),
    )


def post_json(http: TestClient, path: str, body: dict | None = None):
    return http.post(path, json={} if body is None else body)


def wait_for_count(http: TestClient, key: str, value: int, timeout: float = 2.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if http.get("/__acceptance/state").json()["counts"][key] == value:
            return True
        time.sleep(0.01)
    return False


def wait_for_event(
    http: TestClient,
    *,
    stage: str,
    page: str,
    event: str,
    timeout: float = 2.0,
):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        rows = http.get("/__acceptance/state").json()["events"]
        if any(
            row["stage"] == stage
            and row["page"] == page
            and row["event"] == event
            for row in rows
        ):
            return True
        time.sleep(0.01)
    return False


def ocr_form(page: str, analysis: str, ocr: str):
    return {
        "data": {"analysis_key": analysis, "ocr_key": ocr, "src_lang": "ja"},
        "files": {"image": (f"{page}.png", page_png(page), "image/png")},
    }


def ndjson(response):
    return [json.loads(line) for line in response.text.splitlines() if line.strip()]


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


def test_reset_and_release_require_an_empty_json_object():
    with client() as http:
        for path in ("/__acceptance/reset", "/__acceptance/release/ocr/B"):
            assert http.post(path, content=b"").status_code == 415
            json_headers = {"content-type": "application/json"}
            assert http.post(path, content=b"", headers=json_headers).status_code == 422
            assert http.post(path, content=b"{", headers=json_headers).status_code == 422
            assert http.post(path, json={"unexpected": True}).status_code == 422
            assert http.post(path, json={}).status_code == 200


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
            held = pool.submit(
                http.get,
                "/assets/A.png",
                headers={"sec-fetch-dest": "empty"},
            )
            assert wait_for_count(http, "active_source", 1)
            assert post_json(http, "/__acceptance/release/source/A").status_code == 200
            assert held.result(timeout=2).status_code == 200
        failed = http.get("/assets/C.png", headers={"sec-fetch-dest": "empty"})
        assert failed.status_code == 500
        snapshot = http.get("/__acceptance/state").json()
        assert snapshot["counts"]["source"] == 2
        assert snapshot["counts"]["peak_source"] == 1
        assert any(
            row["event"] == "failed" and row["page"] == "C"
            for row in snapshot["events"]
        )


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
        assert events[2] == {
            "type": "ocr_block_error",
            "ocr_key": "ocr-B",
            "block_id": "B-2",
            "code": "recognizer_failed",
        }
        assert events[-1] == {
            "type": "image_done", "recognized": 1, "failed": 1
        }


def test_ocr_stream_requires_or_reuses_analysis_image_mapping():
    with client() as http:
        post_json(http, "/__acceptance/reset")
        missing = http.post("/ocr-stream", data={
            "analysis_key": "analysis-A",
            "ocr_key": "ocr-missing",
            "src_lang": "ja",
        })
        assert missing.status_code == 409

        cold = http.post("/ocr-stream", **ocr_form("A", "analysis-A", "ocr-cold"))
        assert cold.status_code == 200
        warm = http.post("/ocr-stream", data={
            "analysis_key": "analysis-A",
            "ocr_key": "ocr-warm",
            "src_lang": "ja",
        })
        assert warm.status_code == 200
        assert ndjson(warm)[1]["block_id"] == "A-1"
        assert ndjson(warm)[1]["src_text"] == "A:block-1"


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


def test_translation_holds_then_returns_each_input_id_once():
    with client() as http:
        post_json(http, "/__acceptance/reset")
        post_json(http, "/__acceptance/config", {
            "hold": {"translation": ["C"]},
            "fail": {},
            "blocks": {"C": 2},
        })
        body = {
            "src_lang": "es",
            "dst_lang": "vi",
            "items": [
                {"id": "C-1", "text": "C:block-1"},
                {"id": "C-2", "text": "C:block-2"},
            ],
        }
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(http.post, "/translate-items", json=body)
            assert wait_for_event(
                http, stage="translation", page="C", event="held"
            )
            post_json(http, "/__acceptance/release/translation/C")
            response = pending.result(timeout=2)
        assert response.status_code == 200
        rows = response.json()["items"]
        assert [row["id"] for row in rows] == ["C-1", "C-2"]
        assert len({row["id"] for row in rows}) == 2


def test_translation_rejects_unsupported_duplicate_and_mixed_page_inputs():
    with client() as http:
        post_json(http, "/__acceptance/reset")
        unsupported = http.post("/translate-items", json={
            "src_lang": "fr",
            "items": [{"id": "A-1", "text": "A:block-1"}],
        })
        assert unsupported.status_code == 422
        duplicate = http.post("/translate-items", json={
            "src_lang": "ja",
            "items": [
                {"id": "A-1", "text": "A:block-1"},
                {"id": "A-1", "text": "A:block-2"},
            ],
        })
        assert duplicate.status_code == 422
        mixed = http.post("/translate-items", json={
            "src_lang": "ja",
            "items": [
                {"id": "A-1", "text": "A:block-1"},
                {"id": "B-1", "text": "B:block-1"},
            ],
        })
        assert mixed.status_code == 422
