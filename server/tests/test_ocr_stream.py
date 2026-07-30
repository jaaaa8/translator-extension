import json

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

    def iter_ocr(self, analysis_key, src_lang, ocr_key, cancelled):
        yield {
            "type": "ocr_block",
            "ocr_key": ocr_key,
            "block_id": "b1",
            "bbox": [1, 2, 3, 4],
            "src_text": "hola",
        }
        yield {"type": "image_done", "ocr_key": ocr_key, "recognized": 1, "failed": 0}


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
    assert [row["type"] for row in events(cold)] == [
        "analysis_ready", "ocr_block", "image_done"
    ]
    warm = client.post(
        "/ocr-stream",
        data={"analysis_key": "a1", "ocr_key": "o2", "src_lang": "ja"},
    )
    assert warm.status_code == 200


def test_ocr_stream_reports_analysis_missing(monkeypatch):
    monkeypatch.setattr(main, "_pipeline", FakeStreamPipeline())
    response = TestClient(main.app).post(
        "/ocr-stream",
        data={"analysis_key": "missing", "ocr_key": "o1", "src_lang": "ja"},
    )
    assert response.status_code == 409
    assert response.json() == {"error": "analysis_missing"}
