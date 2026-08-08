import asyncio
import json
import time

from fastapi.testclient import TestClient

import server.main as main


class FakeStreamPipeline:
    def __init__(self):
        self.analysis = None

    def get_analysis(self, key):
        return self.analysis if self.analysis and self.analysis.key == key else None

    def analyze(self, data, crop, key):
        self.analysis = type(
            "Analysis",
            (),
            {"key": key, "image_w": 100, "image_h": 200, "regions": [1, 2]},
        )()
        return self.analysis

    def analyze_with_status(self, data, crop, key):
        return self.analyze(data, crop, key), False

    def iter_ocr(self, analysis_key, src_lang, ocr_key, cancelled):
        yield {
            "type": "ocr_block",
            "ocr_key": ocr_key,
            "block_id": "b1",
            "bbox": [1, 2, 3, 4],
            "src_text": "hola",
            "vertical": False,
        }
        yield {"type": "image_done", "ocr_key": ocr_key, "recognized": 1, "failed": 0}

    def _iter_ocr(self, analysis, analysis_key, src_lang, ocr_key, cancelled):
        yield from self.iter_ocr(analysis_key, src_lang, ocr_key, cancelled)


def events(response):
    return [json.loads(line) for line in response.text.splitlines()]


def test_ocr_stream_cold_then_warm(monkeypatch):
    pipeline = FakeStreamPipeline()
    monkeypatch.setattr(main, "_pipeline", pipeline)
    client = TestClient(main.app)
    cold = client.post(
        "/ocr-stream",
        files={"image": ("page.png", b"png", "image/png")},
        data={"analysis_key": "a1", "ocr_key": "o1", "src_lang": "es"},
    )
    cold_events = events(cold)
    assert [row["type"] for row in cold_events] == [
        "analysis_ready", "ocr_block", "image_done"
    ]
    assert cold_events[0]["analysis_cache_hit"] is False
    assert isinstance(cold_events[0]["analysis_ms"], int) and cold_events[0]["analysis_ms"] >= 0
    assert cold_events[1]["vertical"] is False
    warm = client.post(
        "/ocr-stream",
        data={"analysis_key": "a1", "ocr_key": "o2", "src_lang": "ja"},
    )
    assert warm.status_code == 200
    assert events(warm)[0]["analysis_cache_hit"] is True


def test_ocr_stream_keeps_nonzero_duration_for_delayed_cache_hit(monkeypatch):
    class DelayedHitPipeline(FakeStreamPipeline):
        def analyze_with_status(self, data, crop, key):
            time.sleep(0.01)
            return self.analyze(data, crop, key), True

    monkeypatch.setattr(main, "_pipeline", DelayedHitPipeline())
    response = TestClient(main.app).post(
        "/ocr-stream",
        files={"image": ("page.png", b"png", "image/png")},
        data={"analysis_key": "a1", "ocr_key": "o1", "src_lang": "es"},
    )

    ready = events(response)[0]
    assert ready["analysis_cache_hit"] is True
    assert ready["analysis_ms"] > 0


def test_ocr_stream_excludes_delay_before_body_consumption(monkeypatch):
    class Request:
        async def is_disconnected(self):
            return False

    pipeline = FakeStreamPipeline()
    pipeline.analyze(b"png", None, "a1")
    clock = [1.0]
    monkeypatch.setattr(main, "_pipeline", pipeline)
    monkeypatch.setattr(main.time, "perf_counter", lambda: clock[0])

    response = asyncio.run(main.ocr_stream(
        Request(), analysis_key="a1", ocr_key="o1", src_lang="ja", image=None
    ))
    clock[0] = 11.0
    ready = json.loads(asyncio.run(anext(response.body_iterator)))

    assert ready["analysis_ms"] == 0


def test_ocr_stream_reports_analysis_missing(monkeypatch):
    monkeypatch.setattr(main, "_pipeline", FakeStreamPipeline())
    response = TestClient(main.app).post(
        "/ocr-stream",
        data={"analysis_key": "missing", "ocr_key": "o1", "src_lang": "ja"},
    )
    assert response.status_code == 409
    assert response.json() == {"error": "analysis_missing"}


def test_ocr_stream_keeps_warm_analysis_after_cache_eviction(monkeypatch):
    class EvictingPipeline(FakeStreamPipeline):
        def __init__(self):
            super().__init__()
            self.analysis = type(
                "Analysis",
                (),
                {"key": "a1", "image_w": 100, "image_h": 200, "regions": [1, 2]},
            )()
            self.get_calls = 0

        def get_analysis(self, key):
            self.get_calls += 1
            return self.analysis if self.get_calls == 1 and key == "a1" else None

        def analyze(self, data, crop, key):
            raise ValueError("decode should not run for a warm analysis")

        def _iter_ocr(self, analysis, analysis_key, src_lang, ocr_key, cancelled):
            assert analysis is self.analysis
            yield from super()._iter_ocr(analysis, analysis_key, src_lang, ocr_key, cancelled)

    pipeline = EvictingPipeline()
    monkeypatch.setattr(main, "_pipeline", pipeline)

    response = TestClient(main.app).post(
        "/ocr-stream",
        data={"analysis_key": "a1", "ocr_key": "o1", "src_lang": "ja"},
    )

    assert response.status_code == 200
    assert [row["type"] for row in events(response)] == [
        "analysis_ready", "ocr_block", "image_done"
    ]
