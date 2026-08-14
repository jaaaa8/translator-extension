import asyncio
import base64
import json
import math
import struct
import time
import zlib
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from io import BytesIO
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

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


def decode_png(payload: bytes) -> tuple[int, int, int, bytes]:
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
    assert chunks[0][0] == b"IHDR"
    assert chunks[-1][0] == b"IEND"
    width, height, bit_depth, color_type, compression, filtering, interlace = (
        struct.unpack(">IIBBBBB", chunks[0][1])
    )
    assert (bit_depth, compression, filtering, interlace) == (8, 0, 0, 0)
    channels = {2: 3, 6: 4}[color_type]
    scanlines = zlib.decompress(b"".join(data for kind, data in chunks if kind == b"IDAT"))
    stride = width * channels
    assert len(scanlines) == height * (stride + 1)
    pixels = bytearray()
    for row in range(height):
        start = row * (stride + 1)
        assert scanlines[start] == 0
        pixels.extend(scanlines[start + 1:start + 1 + stride])
    return width, height, color_type, bytes(pixels)


def decode_rgba_png(encoded: str) -> tuple[int, int, int, bytes]:
    return decode_png(base64.b64decode(encoded, validate=True))


def pixel_at(pixels: bytes, width: int, channels: int, x: int, y: int):
    offset = (y * width + x) * channels
    return tuple(pixels[offset:offset + channels])


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
        fixture_images = [http.get(f"/{language}_page.png") for language in ("ja", "es")]
        assert all(response.status_code == 200 for response in fixture_images)
        assert all(response.headers["content-type"] == "image/png" for response in fixture_images)
        assert all(response.headers["cache-control"] == "no-store" for response in fixture_images)
        assert all(Image.open(BytesIO(response.content)).size[0] > 0 for response in fixture_images)
        payloads = [http.get(f"/assets/{page}.png") for page in "ABCD"]
        assert all(response.status_code == 200 for response in payloads)
        assert all(response.headers["cache-control"] == "no-store" for response in payloads)
        assert len({response.content for response in payloads}) == 4
        assert [response.content for response in payloads] == [page_png(page) for page in "ABCD"]
        benchmark = http.get("/assets/A.png?benchmark=1")
        assert benchmark.headers["cache-control"] == "public, max-age=31536000, immutable"


def test_benchmark_samples_are_unique_cold_sources_with_identical_raster():
    with client() as http:
        samples = {
            name: http.get(f"/assets/A.png?benchmark={name}")
            for name in ("1", "2")
        }

        assert samples["1"].content != samples["2"].content
        assert decode_png(samples["1"].content)[3] == decode_png(samples["2"].content)[3]

        for name, response in samples.items():
            events = ndjson(http.post(
                "/ocr-stream",
                data={
                    "analysis_key": f"analysis-benchmark-{name}",
                    "ocr_key": f"ocr-benchmark-{name}",
                    "src_lang": "ja",
                    "render_artifact_key": f"render-benchmark-{name}",
                },
                files={"image": (f"A-{name}.png", response.content, "image/png")},
            ))
            block = next(row for row in events if row["type"] == "ocr_block")
            assert block["block_id"] == "A-1"


def test_benchmark_controller_is_served_by_acceptance_app():
    with client() as http:
        response = http.get("/fixture-benchmark.js")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/javascript")
    assert response.content


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


def test_page_a_source_and_patch_are_visually_consistent():
    expected_bbox = [80, 80, 240, 120]
    known_raw_ink = {(106, 102), (182, 120), (234, 102)}

    with client() as http:
        post_json(http, "/__acceptance/reset")
        source = http.get("/assets/A.png", headers={"sec-fetch-dest": "image"})
        events = ndjson(http.post(
            "/ocr-stream",
            **ocr_form("A", "analysis-A", "ocr-A"),
        ))
        block = next(row for row in events if row["type"] == "ocr_block")
        artifact = http.post("/render-artifact", data={
            "analysis_key": "analysis-A",
            "render_artifact_key": "render-A",
            "source_content_hash": "unused-on-key-hit",
        }).json()
        candidate = artifact["blocks"][0]

    assert source.status_code == 200
    assert block["bbox"] == expected_bbox
    assert candidate["patch_bbox"] == expected_bbox
    assert candidate["clean_region"] == expected_bbox

    patch_width, patch_height, patch_type, patch_pixels = decode_rgba_png(
        candidate["patch_rgba"]
    )
    assert (patch_width, patch_height) == tuple(expected_bbox[2:])
    assert patch_type == 6

    source_width, source_height, source_type, source_pixels = decode_png(source.content)
    assert (source_width, source_height, source_type) == (800, 1200, 2)
    for point in ((50, 50), (350, 50), (50, 230), (350, 230)):
        assert pixel_at(source_pixels, source_width, 3, *point) == (204, 204, 204)
    for point in ((200, 48), (48, 140)):
        assert pixel_at(source_pixels, source_width, 3, *point) == (96, 96, 96)
    for point in ((200, 60), (60, 140)):
        assert pixel_at(source_pixels, source_width, 3, *point) == (255, 255, 255)
    raw_ink = {
        (x, y)
        for y in range(source_height)
        for x in range(source_width)
        if pixel_at(source_pixels, source_width, 3, x, y) == (0, 0, 0)
    }
    assert known_raw_ink <= raw_ink
    left, top, width, height = expected_bbox
    assert all(left <= x < left + width and top <= y < top + height for x, y in raw_ink)

    raw_ink_mask = {(x - left, y - top) for x, y in raw_ink}
    fixture_scale_range = (0.426, 0.464)
    max_minification_footprint = 1 / min(fixture_scale_range)
    dilation_radius = 3
    assert dilation_radius == math.ceil(max_minification_footprint)
    expected_erase_mask = {
        (x + dx, y + dy)
        for x, y in raw_ink_mask
        for dx in range(-dilation_radius, dilation_radius + 1)
        for dy in range(-dilation_radius, dilation_radius + 1)
        if 0 <= x + dx < width and 0 <= y + dy < height
    }
    for x, y in expected_erase_mask - raw_ink_mask:
        assert pixel_at(source_pixels, source_width, 3, left + x, top + y) == (
            255, 255, 255
        )
    actual_erase_mask = set()
    for y in range(patch_height):
        for x in range(patch_width):
            red, green, blue, alpha = pixel_at(
                patch_pixels, patch_width, 4, x, y
            )
            assert alpha in {0, 255}
            if alpha:
                assert (red, green, blue) == (255, 255, 255)
                actual_erase_mask.add((x, y))
    assert raw_ink_mask <= actual_erase_mask
    assert actual_erase_mask == expected_erase_mask

    def composited_pixel(x: int, y: int):
        source_pixel = pixel_at(source_pixels, source_width, 3, x, y)
        if not (left <= x < left + width and top <= y < top + height):
            return source_pixel
        red, green, blue, alpha = pixel_at(
            patch_pixels, patch_width, 4, x - left, y - top
        )
        patch_pixel = (red, green, blue)
        return tuple(
            (patch_channel * alpha + source_channel * (255 - alpha) + 127) // 255
            for source_channel, patch_channel in zip(source_pixel, patch_pixel)
        )

    assert all(composited_pixel(x, y) == (255, 255, 255) for x, y in raw_ink)
    for point in ((90, 90), (400, 400)):
        assert composited_pixel(*point) == pixel_at(
            source_pixels, source_width, 3, *point
        )


def test_page_d_long_text_uses_bubble_safe_render_geometry():
    with client() as http:
        post_json(http, "/__acceptance/reset")
        source_a = http.get("/assets/A.png", headers={"sec-fetch-dest": "image"})
        source_d = http.get("/assets/D.png", headers={"sec-fetch-dest": "image"})
        events = ndjson(http.post(
            "/ocr-stream",
            **ocr_form("D", "analysis-D", "ocr-D"),
        ))
        block = next(row for row in events if row["type"] == "ocr_block")
        candidate = http.post("/render-artifact", data={
            "analysis_key": "analysis-D",
            "render_artifact_key": "render-D",
            "source_content_hash": "unused-on-key-hit",
        }).json()["blocks"][0]

    with Image.open(BytesIO(source_a.content)) as image:
        source_a_pixels = image.convert("RGB").tobytes()
    with Image.open(BytesIO(source_d.content)) as image:
        source_d_pixels = image.convert("RGB").tobytes()
    assert source_d_pixels == source_a_pixels
    assert block["bbox"] == [80, 80, 240, 120]
    assert candidate["patch_bbox"] == [80, 80, 240, 120]
    assert candidate["fit_bbox"] == [100, 90, 200, 100]

    for x, y in ((100, 90), (300, 90), (100, 190), (300, 190)):
        assert (x - 200) ** 2 * 80 ** 2 + (y - 140) ** 2 * 140 ** 2 < (
            140 ** 2 * 80 ** 2
        )

    width, height, color_type, pixels = decode_rgba_png(candidate["patch_rgba"])
    assert (width, height, color_type) == (240, 120, 6)
    assert pixel_at(pixels, width, 4, 106 - 80, 102 - 80) == (255, 255, 255, 255)
    assert pixel_at(pixels, width, 4, 0, 0) == (255, 255, 255, 0)


def test_non_rendered_pages_keep_source_ink_inside_speech_bubble():
    with client() as http:
        sources = {
            page: http.get(f"/assets/{page}.png", headers={"sec-fetch-dest": "image"})
            for page in ("B", "C")
        }

    for source in sources.values():
        with Image.open(BytesIO(source.content)) as image:
            width, height = image.size
            pixels = image.convert("RGB").load()
            black_ink = {
                (x, y)
                for y in range(height)
                for x in range(width)
                if pixels[x, y] == (0, 0, 0)
            }

        assert black_ink
        assert all(
            (x - 200) ** 2 * 80 ** 2 + (y - 140) ** 2 * 140 ** 2
            < 140 ** 2 * 80 ** 2
            for x, y in black_ink
        )


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
            "fit_bbox": [100, 90, 200, 100],
            "manifest": {"D-1"}, "rendered": {"D-1"},
            "skips": {}, "coverage": 1.0,
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
                    assert color_type == 6
                    assert width > 0 and height > 0
                    assert len(pixels) == width * height * 4
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
                block_id: row["reason"]
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
