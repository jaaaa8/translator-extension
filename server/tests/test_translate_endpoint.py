import cv2
import numpy as np
from fastapi.testclient import TestClient

import server.main as main
from server.translator import TranslateError

PNG = cv2.imencode(".png", np.zeros((100, 100, 3), np.uint8))[1].tobytes()


class FakeTranslator:
    def __init__(self, error=None):
        self.error = error

    def translate(self, texts, src, dst):
        if self.error:
            raise self.error
        return [f"{dst}:{t}" for t in texts]


class FakePipeline:
    langs = ["ja", "es"]

    def __init__(self, error=None):
        self.error = error
        self.translator = FakeTranslator(error)
        self.last_crop = None

    def process(self, data, src, dst):
        if self.error:
            raise self.error
        return {"image_w": 100, "image_h": 100, "blocks": []}

    def ocr_image(self, data, src, crop=None):
        if self.error:
            raise self.error
        self.last_crop = crop
        return {"image_w": 100, "image_h": 100, "blocks": [{"bbox": [1, 2, 3, 4], "src_text": "hola"}]}


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


def test_ocr_ok(monkeypatch):
    monkeypatch.setattr(main, "_pipeline", FakePipeline())
    r = TestClient(main.app).post(
        "/ocr", files={"image": ("p.png", PNG, "image/png")}, data={"src_lang": "es"}
    )
    assert r.status_code == 200
    assert r.json()["blocks"][0]["src_text"] == "hola"


def test_ocr_unsupported_lang_422(monkeypatch):
    monkeypatch.setattr(main, "_pipeline", FakePipeline())
    r = TestClient(main.app).post(
        "/ocr", files={"image": ("p.png", PNG, "image/png")}, data={"src_lang": "fr"}
    )
    assert r.status_code == 422


def test_ocr_forwards_complete_crop(monkeypatch):
    pipeline = FakePipeline()
    monkeypatch.setattr(main, "_pipeline", pipeline)

    r = TestClient(main.app).post(
        "/ocr",
        files={"image": ("p.png", PNG, "image/png")},
        data={"src_lang": "es", "crop_left": 0.1, "crop_top": 0.2, "crop_right": 0.8, "crop_bottom": 0.9},
    )

    assert r.status_code == 200
    assert pipeline.last_crop == (0.1, 0.2, 0.8, 0.9)


def test_ocr_rejects_partial_crop(monkeypatch):
    monkeypatch.setattr(main, "_pipeline", FakePipeline())
    r = TestClient(main.app).post(
        "/ocr",
        files={"image": ("p.png", PNG, "image/png")},
        data={"src_lang": "es", "crop_left": 0.1},
    )
    assert r.status_code == 422


def test_translate_texts_ok(monkeypatch):
    monkeypatch.setattr(main, "_pipeline", FakePipeline())
    r = TestClient(main.app).post(
        "/translate-texts",
        json={"texts": ["hola", "adiós"], "src_lang": "es", "target_lang": "vi"},
    )
    assert r.status_code == 200
    assert r.json() == {"translations": ["vi:hola", "vi:adiós"]}


def test_translate_texts_gemini_error_502(monkeypatch):
    monkeypatch.setattr(main, "_pipeline", FakePipeline(error=TranslateError("quota")))
    r = TestClient(main.app).post(
        "/translate-texts", json={"texts": ["x"], "src_lang": "ja", "target_lang": "vi"}
    )
    assert r.status_code == 502
