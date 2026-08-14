import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
from threading import Event
import time

import numpy as np
from fastapi.testclient import TestClient

from server.artifacts import (
    AnalysisArtifact,
    PreparedFragment,
    PreparedRegion,
    RenderArtifact,
)
import server.main as main
import server.pipeline as pipeline_module
from server.pipeline import Pipeline


class FakeStreamPipeline:
    def __init__(self):
        self.analysis = None
        self.render_calls = []

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

    def ensure_render(self, analysis_key, render_artifact_key, *, analysis=None):
        self.render_calls.append((analysis_key, render_artifact_key, analysis))


def events(response):
    return [json.loads(line) for line in response.text.splitlines()]


def test_ocr_stream_cold_then_warm(monkeypatch):
    pipeline = FakeStreamPipeline()
    monkeypatch.setattr(main, "_pipeline", pipeline)
    client = TestClient(main.app)
    cold = client.post(
        "/ocr-stream",
        files={"image": ("page.png", b"png", "image/png")},
        data={"analysis_key": "a1", "ocr_key": "o1", "src_lang": "es", "render_artifact_key": "render-1"},
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
        data={"analysis_key": "a1", "ocr_key": "o2", "src_lang": "ja", "render_artifact_key": "render-2"},
    )
    assert warm.status_code == 200
    assert events(warm)[0]["analysis_cache_hit"] is True
    # Mutation caught: dropping render preparation from either cold or warm
    # stream after making the key required.
    assert [(analysis, render) for analysis, render, _ in pipeline.render_calls] == [
        ("a1", "render-1"),
        ("a1", "render-2"),
    ]


def test_ocr_stream_keeps_nonzero_duration_for_delayed_cache_hit(monkeypatch):
    class DelayedHitPipeline(FakeStreamPipeline):
        def analyze_with_status(self, data, crop, key):
            time.sleep(0.01)
            return self.analyze(data, crop, key), True

    monkeypatch.setattr(main, "_pipeline", DelayedHitPipeline())
    response = TestClient(main.app).post(
        "/ocr-stream",
        files={"image": ("page.png", b"png", "image/png")},
        data={"analysis_key": "a1", "ocr_key": "o1", "src_lang": "es", "render_artifact_key": "render-1"},
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
        Request(), analysis_key="a1", ocr_key="o1", src_lang="ja", image=None,
        render_artifact_key="render-1",
    ))
    clock[0] = 11.0
    ready = json.loads(asyncio.run(anext(response.body_iterator)))

    assert ready["analysis_ms"] == 0


def test_ocr_stream_reports_analysis_missing(monkeypatch):
    monkeypatch.setattr(main, "_pipeline", FakeStreamPipeline())
    response = TestClient(main.app).post(
        "/ocr-stream",
        data={"analysis_key": "missing", "ocr_key": "o1", "src_lang": "ja", "render_artifact_key": "render-1"},
    )
    assert response.status_code == 409
    assert response.json() == {"error": "analysis_missing"}


def test_ocr_stream_requires_render_artifact_key(monkeypatch):
    # Mutation caught: restoring the optional Task 5 compatibility seam.
    monkeypatch.setattr(main, "_pipeline", FakeStreamPipeline())
    response = TestClient(main.app).post(
        "/ocr-stream",
        files={"image": ("page.png", b"png", "image/png")},
        data={"analysis_key": "a1", "ocr_key": "o1", "src_lang": "ja"},
    )

    assert response.status_code == 422


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
        data={"analysis_key": "a1", "ocr_key": "o1", "src_lang": "ja", "render_artifact_key": "render-1"},
    )

    assert response.status_code == 200
    assert [row["type"] for row in events(response)] == [
        "analysis_ready", "ocr_block", "image_done"
    ]


def test_ocr_stream_uses_captured_analysis_for_render_after_cache_eviction(monkeypatch):
    class Request:
        async def is_disconnected(self):
            return False

    class Ocr:
        langs = ["ja", "es", "pt"]

        def get(self, lang):
            return object()

    artifact = AnalysisArtifact("analysis-1", 100, 200, (), 0)
    pipeline = Pipeline(detector=object(), ocr=Ocr(), translator=object())
    pipeline._analysis_cache.put(artifact.key, artifact)
    render_started = Event()
    render_release = Event()
    rendered = []

    def build_render(current, render_key):
        rendered.append((current, render_key))
        render_started.set()
        assert render_release.wait(2)
        return RenderArtifact("render-v1", render_key, current.key, 100, 200, (), 0)

    monkeypatch.setattr(pipeline_module, "build_render_artifact", build_render)
    monkeypatch.setattr(main, "_pipeline", pipeline)
    try:
        response = asyncio.run(main.ocr_stream(
            Request(),
            analysis_key="analysis-1",
            ocr_key="ocr-1",
            src_lang="ja",
            render_artifact_key="render-1",
            image=None,
        ))
        for index in range(8):
            other = AnalysisArtifact(f"other-{index}", 1, 1, (), 0)
            pipeline._analysis_cache.put(other.key, other)
        assert pipeline.get_analysis("analysis-1") is None

        ready = json.loads(asyncio.run(anext(response.body_iterator)))
        assert ready["type"] == "analysis_ready"
        assert render_started.wait(1)
        future = pipeline.ensure_render("analysis-1", "render-1")
        done = json.loads(asyncio.run(anext(response.body_iterator)))
        assert done["type"] == "image_done"
        render_release.set()
        assert future.result(timeout=2).analysis_key == "analysis-1"
        assert rendered == [(artifact, "render-1")]
    finally:
        render_release.set()
        pipeline._render_executor.shutdown(wait=True)


def test_ocr_stream_render_build_overlaps_ocr_without_sharing_ocr_lock(monkeypatch):
    analysis_done = Event()
    render_started = Event()
    render_release = Event()
    ocr_entered = Event()
    ocr_release = Event()
    render_observations = []

    class Engine:
        def read(self, crop):
            ocr_entered.set()
            assert render_started.wait(2)
            assert ocr_release.wait(2)
            return "hola"

    class Ocr:
        langs = ["ja", "es", "pt"]

        def get(self, lang):
            return Engine()

    fragment = PreparedFragment((1, 2, 3, 4), np.zeros((4, 3, 3), np.uint8), False)
    region = PreparedRegion(
        "block-1",
        (1, 2, 3, 4),
        (1, 2, 3, 4),
        (fragment,),
        np.zeros((4, 3, 3), np.uint8),
        np.ones((4, 3), np.uint8),
        np.ones((4, 3), np.uint8),
        np.ones((4, 3), np.uint8),
        False,
        True,
    )
    artifact = AnalysisArtifact("analysis-1", 100, 200, (region,), 0)
    pipeline = Pipeline(detector=object(), ocr=Ocr(), translator=object())

    def analyze_with_status(data, crop, key):
        assert key == artifact.key
        pipeline._analysis_cache.put(key, artifact)
        analysis_done.set()
        return artifact, False

    def build_render(current, render_key):
        render_observations.append(analysis_done.is_set())
        render_started.set()
        assert render_release.wait(3)
        return RenderArtifact("render-v1", render_key, current.key, 100, 200, (), 0)

    pipeline.analyze_with_status = analyze_with_status
    monkeypatch.setattr(pipeline_module, "build_render_artifact", build_render, raising=False)
    monkeypatch.setattr(main, "_pipeline", pipeline)
    client = TestClient(main.app)
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(
                client.post,
                "/ocr-stream",
                files={"image": ("page.png", b"png", "image/png")},
                data={
                    "analysis_key": "analysis-1",
                    "ocr_key": "ocr-1",
                    "render_artifact_key": "render-1",
                    "src_lang": "ja",
                },
            )
            assert render_started.wait(2)
            assert ocr_entered.wait(2)
            assert not render_release.is_set()
            ocr_release.set()
            response = pending.result(timeout=2)
            assert response.status_code == 200
            assert [row["type"] for row in events(response)] == [
                "analysis_ready", "ocr_block", "image_done"
            ]
            assert pipeline.get_render("render-1") is None
        render_release.set()
        pipeline.ensure_render("analysis-1", "render-1").result(timeout=2)
        assert render_observations == [True]
    finally:
        ocr_release.set()
        render_release.set()
        executor = getattr(pipeline, "_render_executor", None)
        if executor is not None:
            executor.shutdown(wait=True)
