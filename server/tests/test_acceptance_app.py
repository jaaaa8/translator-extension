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
