import base64
from concurrent.futures import Future
from hashlib import sha256
from threading import Event

import pytest
from fastapi.testclient import TestClient

from server.artifacts import AnalysisArtifact, RenderArtifact, RenderBlockArtifact
import server.main as main
import server.pipeline as pipeline_module
from server.pipeline import Pipeline


def analysis(key="analysis-1"):
    return AnalysisArtifact(key, 100, 90, (), 0)


def render(analysis_key="analysis-1", render_key="render-1", *, byte_size=3):
    return RenderArtifact(
        "render-v1",
        render_key,
        analysis_key,
        100,
        90,
        (
            RenderBlockArtifact(
                "block-1",
                "patch-1",
                (1, 2, 3, 4),
                (2, 3, 1, 2),
                (1, 2, 3, 4),
                "image/png",
                b"PNG",
                None,
            ),
        ),
        byte_size,
    )


def make_pipeline(artifact=None):
    pipeline = Pipeline(detector=object(), ocr=object(), translator=object())
    if artifact is not None:
        pipeline._analysis_cache.put(artifact.key, artifact)
    return pipeline


def shutdown_render_executor(pipeline):
    executor = getattr(pipeline, "_render_executor", None)
    if executor is not None:
        executor.shutdown(wait=True)


def test_render_artifact_reports_missing_key_first_artifact(monkeypatch):
    pipeline = make_pipeline()
    monkeypatch.setattr(main, "_pipeline", pipeline)
    try:
        response = TestClient(main.app).post(
            "/render-artifact",
            data={
                "analysis_key": "missing",
                "render_artifact_key": "render-1",
                "source_content_hash": sha256(b"png").hexdigest(),
            },
        )
    finally:
        shutdown_render_executor(pipeline)

    assert response.status_code == 409
    assert response.json() == {"error": "artifact_missing"}


def test_render_artifact_rejects_source_identity_mismatch_before_analysis(monkeypatch):
    class FakePipeline:
        analyze_calls = 0

        def get_render(self, key):
            return None

        def get_analysis(self, key):
            return None

        def analyze(self, data, crop, key):
            self.analyze_calls += 1
            raise AssertionError("hash mismatch must fail before analysis")

    pipeline = FakePipeline()
    monkeypatch.setattr(main, "_pipeline", pipeline)

    response = TestClient(main.app).post(
        "/render-artifact",
        files={"image": ("page.png", b"png", "image/png")},
        data={
            "analysis_key": "analysis-1",
            "render_artifact_key": "render-1",
            "source_content_hash": sha256(b"different").hexdigest(),
        },
    )

    assert response.status_code == 409
    assert response.json() == {"error": "source_identity_mismatch"}
    assert pipeline.analyze_calls == 0


def test_render_artifact_upload_returns_complete_http_payload(monkeypatch):
    expected = render()

    class FakePipeline:
        def __init__(self):
            self.cached_analysis = None

        def get_render(self, key):
            return None

        def get_analysis(self, key):
            return self.cached_analysis

        def analyze(self, data, crop, key):
            assert data == b"png"
            assert crop is None
            self.cached_analysis = analysis(key)
            return self.cached_analysis

        def ensure_render(self, analysis_key, render_key, *, analysis=None):
            assert (analysis_key, render_key) == ("analysis-1", "render-1")
            future = Future()
            future.set_result(expected)
            return future

    monkeypatch.setattr(main, "_pipeline", FakePipeline())

    response = TestClient(main.app).post(
        "/render-artifact",
        files={"image": ("page.png", b"png", "image/png")},
        data={
            "analysis_key": "analysis-1",
            "render_artifact_key": "render-1",
            "source_content_hash": sha256(b"png").hexdigest(),
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "schema_version": "render-v1",
        "render_artifact_key": "render-1",
        "analysis_key": "analysis-1",
        "image_w": 100,
        "image_h": 90,
        "blocks": [
            {
                "block_id": "block-1",
                "patch_id": "patch-1",
                "patch_bbox": [1, 2, 3, 4],
                "clean_region": [2, 3, 1, 2],
                "fit_bbox": [1, 2, 3, 4],
                "patch_mime": "image/png",
                "patch_rgba": base64.b64encode(b"PNG").decode("ascii"),
                "reason": None,
            }
        ],
        "byte_size": 3,
    }


@pytest.mark.parametrize("with_image", [False, True], ids=["warm-cache", "upload"])
def test_render_artifact_forwards_resolved_analysis_after_cache_eviction(
    monkeypatch, with_image
):
    resolved = analysis()
    expected = render()
    pipeline = make_pipeline()
    analysis_lookups = 0

    def get_analysis(key):
        nonlocal analysis_lookups
        assert key == "analysis-1"
        analysis_lookups += 1
        return resolved if not with_image and analysis_lookups == 1 else None

    def analyze_image(data, crop, key):
        assert with_image
        assert (data, crop, key) == (b"png", None, "analysis-1")
        return resolved

    def build(artifact, render_key):
        # Mutation caught: discarding the resolved artifact or omitting analysis=analysis.
        assert artifact is resolved
        assert render_key == "render-1"
        return expected

    monkeypatch.setattr(pipeline, "get_analysis", get_analysis)
    monkeypatch.setattr(pipeline, "analyze", analyze_image)
    monkeypatch.setattr(pipeline_module, "build_render_artifact", build, raising=False)
    monkeypatch.setattr(main, "_pipeline", pipeline)
    request = {
        "data": {
            "analysis_key": "analysis-1",
            "render_artifact_key": "render-1",
            "source_content_hash": sha256(b"png").hexdigest(),
        }
    }
    if with_image:
        request["files"] = {"image": ("page.png", b"png", "image/png")}

    try:
        response = TestClient(main.app).post("/render-artifact", **request)
    finally:
        shutdown_render_executor(pipeline)

    assert response.status_code == 200
    assert response.json()["render_artifact_key"] == "render-1"


def test_ensure_render_singleflights_concurrent_callers_and_caches_once(monkeypatch):
    pipeline = make_pipeline(analysis())
    started = Event()
    release = Event()
    calls = []
    expected = render()

    def build(artifact, render_key):
        calls.append((artifact.key, render_key))
        started.set()
        assert release.wait(2)
        return expected

    monkeypatch.setattr(pipeline_module, "build_render_artifact", build, raising=False)
    try:
        first = pipeline.ensure_render("analysis-1", "render-1")
        assert started.wait(1)
        second = pipeline.ensure_render("analysis-1", "render-1")
        assert first is second
        release.set()
        assert first.result(timeout=2) is expected
        assert pipeline.get_render("render-1") is expected
        assert pipeline.ensure_render("analysis-1", "render-1").result(timeout=1) is expected
        assert calls == [("analysis-1", "render-1")]
    finally:
        release.set()
        shutdown_render_executor(pipeline)


def test_ensure_render_does_not_cache_oversize_artifact(monkeypatch):
    pipeline = make_pipeline(analysis())
    expected = render(byte_size=128 * 1024 * 1024 + 1)
    monkeypatch.setattr(
        pipeline_module,
        "build_render_artifact",
        lambda artifact, render_key: expected,
        raising=False,
    )
    try:
        assert pipeline.ensure_render("analysis-1", "render-1").result(timeout=2) is expected
        assert pipeline.get_render("render-1") is None
    finally:
        shutdown_render_executor(pipeline)


def test_ensure_render_removes_failed_future_for_retry(monkeypatch):
    pipeline = make_pipeline(analysis())
    expected = render()
    calls = 0

    def build(artifact, render_key):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("clean failed")
        return expected

    monkeypatch.setattr(pipeline_module, "build_render_artifact", build, raising=False)
    try:
        with pytest.raises(RuntimeError, match="clean failed"):
            pipeline.ensure_render("analysis-1", "render-1").result(timeout=2)
        assert pipeline.ensure_render("analysis-1", "render-1").result(timeout=2) is expected
        assert calls == 2
    finally:
        shutdown_render_executor(pipeline)


def test_ensure_render_rejects_resolved_analysis_with_different_key():
    pipeline = make_pipeline()
    try:
        with pytest.raises(ValueError, match="analysis_key_mismatch"):
            pipeline.ensure_render(
                "analysis-1",
                "render-1",
                analysis=analysis("different-analysis"),
            )
    finally:
        shutdown_render_executor(pipeline)
