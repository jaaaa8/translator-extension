import cv2
import numpy as np
from fastapi.testclient import TestClient

import server.main as main
from server.translator import TranslateError

PNG = cv2.imencode(".png", np.zeros((100, 100, 3), np.uint8))[1].tobytes()


class FakePipeline:
    langs = ["ja", "es"]

    def __init__(self, error=None):
        self.error = error

    def process(self, data, src, dst):
        if self.error:
            raise self.error
        return {"image_w": 100, "image_h": 100, "blocks": []}


def post(client, src="ja", dst="vi"):
    return client.post(
        "/translate",
        files={"image": ("p.png", PNG, "image/png")},
        data={"src_lang": src, "target_lang": dst},
    )


def test_translate_ok(monkeypatch):
    monkeypatch.setattr(main, "_pipeline", FakePipeline())
    r = post(TestClient(main.app))
    assert r.status_code == 200
    assert r.json() == {"image_w": 100, "image_h": 100, "blocks": []}


def test_unsupported_lang_422(monkeypatch):
    monkeypatch.setattr(main, "_pipeline", FakePipeline())
    r = post(TestClient(main.app), src="fr")
    assert r.status_code == 422


def test_gemini_error_502(monkeypatch):
    monkeypatch.setattr(main, "_pipeline", FakePipeline(error=TranslateError("quota")))
    r = post(TestClient(main.app))
    assert r.status_code == 502
    assert "gemini" in r.json()["error"]


def test_other_error_500(monkeypatch):
    monkeypatch.setattr(main, "_pipeline", FakePipeline(error=ValueError("bad image")))
    r = post(TestClient(main.app))
    assert r.status_code == 500
