import asyncio
import base64
import json
import struct
import time
import zlib
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from pathlib import Path

from fastapi.testclient import TestClient

from server import config
from server.acceptance_app import (
    AcceptanceConfig,
    AcceptanceState,
    EVENT_LIMIT,
    app,
    asset,
    page_png,
    state,
    wait_gate,
)

EXPECTED_LONG_TRANSLATION = (
    "vi:long acceptance translation long acceptance translation "
    "long acceptance translation long acceptance translation long acceptance translation "
    "long acceptance translation long acceptance translation long acceptance translation "
    "long acceptance translation long acceptance translation long acceptance translation "
    "long acceptance translation long acceptance translation long acceptance translation "
    "long acceptance translation long acceptance translation long acceptance translation "
    "long acceptance translation long acceptance translation long acceptance translation"
)


def version_shape(value):
    if isinstance(value, dict):
        return {key: version_shape(child) for key, child in sorted(value.items())}
    return str


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
        "data": {
            "analysis_key": analysis,
            "ocr_key": ocr,
            "src_lang": "ja",
            "render_artifact_key": f"render-{page}",
        },
        "files": {"image": (f"{page}.png", page_png(page), "image/png")},
    }


def translate_body(items=None, **overrides):
    body = {
        "items": items or [
            {"id": "A-1", "text": "A:block-1", "reading_order": 0, "bbox": [1, 2, 3, 4]}
        ],
        "src_lang": "es",
        "dst_lang": "vi",
        "page_width": 800,
        "page_height": 1200,
        "reading_direction": "rtl",
    }
    body.update(overrides)
    return body


def ndjson(response):
    return [json.loads(line) for line in response.text.splitlines() if line.strip()]


def decode_rgba_png(encoded: str) -> tuple[int, int, int, bytes]:
    payload = base64.b64decode(encoded, validate=True)
    assert payload.startswith(b"\x89PNG\r\n\x1a\n")
    offset = 8
    chunks = []
    while offset < len(payload):
        length = struct.unpack(">I", payload[offset:offset + 4])[0]
        kind = payload[offset + 4:offset + 8]
        data = payload[offset + 8:offset + 8 + length]
        crc = struct.unpack(">I", payload[offset + 8 + length:offset + 12 + length])[0]
        assert zlib.crc32(kind + data) & 0xFFFFFFFF == crc
        chunks.append((kind, data))
        offset += 12 + length
        if kind == b"IEND":
            break
    assert offset == len(payload)
    assert [kind for kind, _ in chunks] == [b"IHDR", b"IDAT", b"IEND"]
    width, height, bit_depth, color_type, compression, filtering, interlace = (
        struct.unpack(">IIBBBBB", chunks[0][1])
    )
    assert (bit_depth, compression, filtering, interlace) == (8, 0, 0, 0)
    scanline = zlib.decompress(chunks[1][1])
    assert len(scanline) == 1 + width * height * 4
    assert scanline[0] == 0
    return width, height, color_type, scanline[1:]


def test_health_exposes_complete_fixed_versions_for_extension_keys():
    with client() as http:
        payload = http.get("/health").json()
        assert "langs" not in payload
        assert version_shape(payload["versions"]) == version_shape(config.PIPELINE_VERSIONS)
        assert version_shape(payload["patch_versions"]) == version_shape(config.PATCH_VERSIONS)
        assert set(payload["versions"]["recognizers"]) == set(
            config.PIPELINE_VERSIONS["recognizers"]
        )
        assert payload["versions"]["layout_order"] == "reading-order-v1"
        assert payload["versions"] == config.PIPELINE_VERSIONS
        assert payload["patch_versions"] == config.PATCH_VERSIONS


def test_health_fixture_and_assets_are_isolated_and_deterministic():
    with client() as http:
        health = http.get("/health").json()
        assert health["status"] == "ok"
        assert health["versions"]["page_schema"] == "page-v2"
        fixture = http.get("/fixture.html?acceptance=reader")
        assert fixture.status_code == 200
        assert "MangaTranslator layout fixture" in fixture.text
        payloads = [http.get(f"/assets/{page}.png") for page in "ABCD"]
        assert all(response.status_code == 200 for response in payloads)
        assert all(response.headers["cache-control"] == "no-store" for response in payloads)
        assert len({response.content for response in payloads}) == 4
        assert [response.content for response in payloads] == [page_png(page) for page in "ABCD"]
        benchmark = http.get("/assets/A.png?benchmark=1")
        assert benchmark.headers["cache-control"] == "public, max-age=31536000, immutable"


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
        assert page_load.headers["cache-control"] == "no-store"
        with ThreadPoolExecutor(max_workers=1) as pool:
            held = pool.submit(
                http.get,
                "/assets/A.png",
                headers={"sec-fetch-dest": "empty"},
            )
            assert wait_for_count(http, "active_source", 1)
            assert post_json(http, "/__acceptance/release/source/A").status_code == 200
            released = held.result(timeout=2)
            assert released.status_code == 200
            assert released.headers["cache-control"] == "no-store"
        failed = http.get("/assets/C.png", headers={"sec-fetch-dest": "empty"})
        assert failed.status_code == 500
        assert failed.headers["cache-control"] == "no-store"
        snapshot = http.get("/__acceptance/state").json()
        assert snapshot["counts"]["source"] == 2
        assert snapshot["counts"]["peak_source"] == 1
        assert any(
            row["event"] == "failed" and row["page"] == "C"
            for row in snapshot["events"]
        )


def test_reset_discards_terminal_accounting_from_held_source_request():
    with client() as http:
        post_json(http, "/__acceptance/reset")
        post_json(http, "/__acceptance/config", {
            "hold": {"source": ["A"]},
            "fail": {},
            "blocks": {},
        })
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(
                http.get,
                "/assets/A.png",
                headers={"sec-fetch-dest": "empty"},
            )
            assert wait_for_event(http, stage="source", page="A", event="held")
            assert post_json(http, "/__acceptance/reset").status_code == 200
            assert pending.result(timeout=2).status_code == 200

        snapshot = http.get("/__acceptance/state").json()
        assert snapshot["counts"] == {
            "page_load": 0,
            "source": 0,
            "ocr_stream": 0,
            "translation": 0,
            "source_aborted": 0,
            "ocr_aborted": 0,
            "active_source": 0,
            "peak_source": 0,
        }
        assert snapshot["events"] == []


def test_disconnected_source_response_is_not_cached():
    class DisconnectedRequest:
        headers = {"sec-fetch-dest": "empty"}

        async def is_disconnected(self):
            return True

    async def exercise():
        await state.reset()
        await state.configure(AcceptanceConfig(hold={"source": ["A"]}))
        try:
            return await asset("A", DisconnectedRequest())
        finally:
            await state.reset()

    response = asyncio.run(exercise())
    assert response.status_code == 499
    assert response.headers["cache-control"] == "no-store"


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
        assert events[1]["vertical"] is False


def test_ocr_stream_requires_or_reuses_analysis_image_mapping():
    with client() as http:
        post_json(http, "/__acceptance/reset")
        omitted = http.post("/ocr-stream", **{
            **ocr_form("A", "analysis-omitted", "ocr-omitted"),
            "data": {
                "analysis_key": "analysis-omitted",
                "ocr_key": "ocr-omitted",
                "src_lang": "ja",
            },
        })
        # Mutation caught: restoring the optional Task 5 compatibility seam.
        assert omitted.status_code == 422
        missing = http.post("/ocr-stream", data={
            "analysis_key": "analysis-A",
            "ocr_key": "ocr-missing",
            "src_lang": "ja",
            "render_artifact_key": "render-A",
        })
        assert missing.status_code == 409

        cold = http.post("/ocr-stream", **ocr_form("A", "analysis-A", "ocr-cold"))
        assert cold.status_code == 200
        assert ndjson(cold)[0]["analysis_cache_hit"] is False
        assert ndjson(cold)[0]["analysis_ms"] == 0
        warm = http.post("/ocr-stream", data={
            "analysis_key": "analysis-A",
            "ocr_key": "ocr-warm",
            "src_lang": "ja",
            "render_artifact_key": "render-A",
        })
        assert warm.status_code == 200
        assert ndjson(warm)[0]["analysis_cache_hit"] is True
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
        first = http.post("/translate-items", json=translate_body([
            {"id": "D-1", "text": "D:block-1", "reading_order": 0, "bbox": [1, 2, 3, 4]},
            {"id": "D-2", "text": "D:block-2", "reading_order": 1, "bbox": [5, 6, 7, 8]},
            {"id": "D-3", "text": "D:block-3", "reading_order": 2, "bbox": [9, 10, 11, 12]},
        ], src_lang="ja"))
        assert first.status_code == 502
        second = http.post("/translate-items", json=translate_body([
            {"id": "D-4", "text": "D:block-4", "reading_order": 0, "bbox": [13, 14, 15, 16]},
        ], src_lang="ja"))
        assert second.status_code == 200
        row = second.json()["items"][0]
        assert row == {
            "id": "D-4",
            "kind": "text",
            "translation": EXPECTED_LONG_TRANSLATION,
        }


def test_synthetic_pages_freeze_translation_manifest_and_render_candidates():
    expected = {
        "A": {
            "translation_row": {
                "id": "A-1", "kind": "text", "translation": "vi:A:block-1",
            },
            "fit_bbox": [80, 80, 240, 120],
            "manifest": {"A-1"}, "rendered": {"A-1"}, "skips": {}, "coverage": 1.0,
        },
        "B": {
            "translation_row": {"id": "B-1", "kind": "sfx", "translation": None},
            "fit_bbox": [80, 80, 240, 120],
            "manifest": set(), "rendered": set(), "skips": {}, "coverage": None,
        },
        "C": {
            "translation_row": {
                "id": "C-1", "kind": "text", "translation": "vi:C:block-1",
            },
            "fit_bbox": [80, 80, 240, 120],
            "manifest": {"C-1"}, "rendered": set(),
            "skips": {"C-1": "unsupported_region"}, "coverage": 0.0,
        },
        "D": {
            "translation_row": {
                "id": "D-1", "kind": "text",
                "translation": EXPECTED_LONG_TRANSLATION,
            },
            "fit_bbox": [80, 80, 12, 12],
            "manifest": {"D-1"}, "rendered": set(),
            "skips": {"D-1": "fit_failed"}, "coverage": 0.0,
        },
    }
    with client() as http:
        post_json(http, "/__acceptance/reset")
        for page, golden in expected.items():
            analysis_key = f"analysis-{page}"
            render_key = f"render-{page}"
            events = ndjson(http.post(
                "/ocr-stream",
                **ocr_form(page, analysis_key, f"ocr-{page}"),
            ))
            block = next(row for row in events if row["type"] == "ocr_block")
            translated = http.post("/translate-items", json=translate_body([
                {
                    "id": block["block_id"],
                    "text": block["src_text"],
                    "reading_order": 0,
                    "bbox": block["bbox"],
                }
            ], src_lang="ja")).json()["items"]
            assert translated == [golden["translation_row"]]
            assert all(set(row) == {"id", "kind", "translation"} for row in translated)
            manifest = {row["id"] for row in translated if row["kind"] == "text"}
            assert manifest == golden["manifest"]

            artifact = http.post("/render-artifact", data={
                "analysis_key": analysis_key,
                "render_artifact_key": render_key,
                "source_content_hash": "unused-on-key-hit",
            })
            assert artifact.status_code == 200
            payload = artifact.json()
            assert payload["render_artifact_key"] == render_key
            for row in payload["blocks"]:
                if row["reason"] is None:
                    assert row["patch_mime"] == "image/png"
                    width, height, color_type, pixels = decode_rgba_png(row["patch_rgba"])
                    assert (width, height, color_type, len(pixels)) == (1, 1, 6, 4)
                    repeated = http.post("/render-artifact", data={
                        "analysis_key": "ignored-on-key-hit",
                        "render_artifact_key": render_key,
                        "source_content_hash": "ignored-on-key-hit",
                    }).json()
                    repeated_row = next(
                        item for item in repeated["blocks"]
                        if item["block_id"] == row["block_id"]
                    )
                    assert repeated_row["patch_rgba"] == row["patch_rgba"]
            candidates = {row["block_id"]: row for row in payload["blocks"]}
            assert {tuple(row["fit_bbox"]) for row in payload["blocks"]} == {
                tuple(golden["fit_bbox"])
            }
            candidate_reasons = {
                block_id: (
                    row["reason"]
                    if row["reason"] is not None
                    else "fit_failed"
                    if row["fit_bbox"] == [80, 80, 12, 12]
                    else None
                )
                for block_id, row in candidates.items()
            }
            rendered = {
                block_id for block_id in manifest
                if candidate_reasons[block_id] is None
            }
            skips = {
                block_id: candidate_reasons[block_id]
                for block_id in manifest
                if candidate_reasons[block_id] is not None
            }
            coverage = len(rendered) / len(manifest) if manifest else None
            assert rendered == golden["rendered"]
            assert skips == golden["skips"]
            assert coverage == golden["coverage"]

        missing = http.post("/render-artifact", data={
            "analysis_key": "missing-analysis",
            "render_artifact_key": "missing-render",
            "source_content_hash": "unused",
        })
        assert missing.status_code == 409
        assert missing.json() == {"error": "artifact_missing"}


def test_render_artifact_is_key_first_but_validates_source_on_a_key_miss():
    with client() as http:
        post_json(http, "/__acceptance/reset")
        assert http.post(
            "/ocr-stream", **ocr_form("A", "analysis-A", "render-source-A")
        ).status_code == 200

        key_hit = http.post("/render-artifact", data={
            "analysis_key": "ignored-analysis",
            "render_artifact_key": "render-A",
            "source_content_hash": "ignored-on-key-hit",
        }, files={"image": ("B.png", page_png("B"), "image/png")})
        assert key_hit.status_code == 200
        assert key_hit.json()["analysis_key"] == "analysis-A"
        assert [row["block_id"] for row in key_hit.json()["blocks"]] == ["A-1"]

        key_miss = http.post("/render-artifact", data={
            "analysis_key": "fresh-analysis-A",
            "render_artifact_key": "render-key-miss-valid",
            "source_content_hash": sha256(page_png("A")).hexdigest(),
        }, files={"image": ("A.png", page_png("A"), "image/png")})
        assert key_miss.status_code == 200
        assert {
            "render_artifact_key": key_miss.json()["render_artifact_key"],
            "analysis_key": key_miss.json()["analysis_key"],
            "block_ids": [row["block_id"] for row in key_miss.json()["blocks"]],
        } == {
            "render_artifact_key": "render-key-miss-valid",
            "analysis_key": "fresh-analysis-A",
            "block_ids": ["A-1"],
        }

        mismatch = http.post("/render-artifact", data={
            "analysis_key": "analysis-A",
            "render_artifact_key": "render-key-miss",
            "source_content_hash": sha256(page_png("A")).hexdigest(),
        }, files={"image": ("B.png", page_png("B"), "image/png")})
        assert mismatch.status_code == 409
        assert mismatch.json() == {"error": "source_identity_mismatch"}


def test_translation_holds_then_returns_each_input_id_once():
    with client() as http:
        post_json(http, "/__acceptance/reset")
        post_json(http, "/__acceptance/config", {
            "hold": {"translation": ["C"]},
            "fail": {},
            "blocks": {"C": 2},
        })
        body = translate_body([
            {"id": "C-1", "text": "C:block-1", "reading_order": 0, "bbox": [1, 2, 3, 4]},
            {"id": "C-2", "text": "C:block-2", "reading_order": 1, "bbox": [5, 6, 7, 8]},
        ])
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
        unsupported = http.post(
            "/translate-items", json=translate_body(src_lang="fr")
        )
        assert unsupported.status_code == 422
        duplicate = http.post("/translate-items", json=translate_body([
            {"id": "A-1", "text": "A:block-1", "reading_order": 0, "bbox": [1, 2, 3, 4]},
            {"id": "A-1", "text": "A:block-2", "reading_order": 1, "bbox": [5, 6, 7, 8]},
        ], src_lang="ja"))
        assert duplicate.status_code == 422
        assert duplicate.json() == {
            "error": "duplicate input id",
            "error_code": "invalid_request",
        }
        mixed = http.post("/translate-items", json=translate_body([
            {"id": "A-1", "text": "A:block-1", "reading_order": 0, "bbox": [1, 2, 3, 4]},
            {"id": "B-1", "text": "B:block-1", "reading_order": 1, "bbox": [5, 6, 7, 8]},
        ], src_lang="ja"))
        assert mixed.status_code == 422


def test_acceptance_ocr_and_translation_allow_pt_but_reject_fr():
    with client() as http:
        post_json(http, "/__acceptance/reset")
        pt_ocr = ocr_form("A", "analysis-pt", "ocr-pt")
        pt_ocr["data"]["src_lang"] = "pt"
        assert http.post("/ocr-stream", **pt_ocr).status_code == 200

        fr_ocr = ocr_form("A", "analysis-fr", "ocr-fr")
        fr_ocr["data"]["src_lang"] = "fr"
        assert http.post("/ocr-stream", **fr_ocr).status_code == 422
        assert http.post(
            "/translate-items", json=translate_body(src_lang="pt")
        ).status_code == 200
        assert http.post(
            "/translate-items", json=translate_body(src_lang="fr")
        ).status_code == 422


def test_translate_items_maps_shared_contract_errors_only_on_exact_path():
    invalid_bodies = [
        translate_body(extra=True),
        translate_body([
            {"id": "A-1", "text": "A:block-1", "reading_order": 0, "bbox": [1, 2, 3, 4]},
            {"id": "A-2", "text": "A:block-2", "reading_order": 2, "bbox": [5, 6, 7, 8]},
        ]),
    ]
    with client() as http:
        for body in invalid_bodies:
            response = http.post("/translate-items", json=body)
            assert response.status_code == 422
            assert set(response.json()) == {"error", "error_code"}
            assert response.json()["error_code"] == "invalid_request"

        other = http.post("/__acceptance/reset", json={"unexpected": True})
        assert other.status_code == 422
        assert set(other.json()) == {"detail"}


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
