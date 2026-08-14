import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

import server.main as main
from server.translator import TranslateError

PNG = cv2.imencode(".png", np.zeros((100, 100, 3), np.uint8))[1].tobytes()


class FakeTranslator:
    def __init__(self, error=None, item_reply=None):
        self.error = error
        self.item_reply = item_reply
        self.item_calls = []

    def translate(self, texts, src, dst):
        if self.error:
            raise self.error
        return [f"{dst}:{t}" for t in texts]

    def translate_items(
        self,
        items,
        src,
        dst,
        *,
        page_width,
        page_height,
        reading_direction,
    ):
        self.item_calls.append({
            "items": items,
            "src": src,
            "dst": dst,
            "page_width": page_width,
            "page_height": page_height,
            "reading_direction": reading_direction,
        })
        if self.error:
            raise self.error
        if self.item_reply is not None:
            return self.item_reply
        return [
            {"id": item["id"], "kind": "text", "translation": f"{dst}:{item['text']}"}
            for item in reversed(items)
        ]


class FakePipeline:
    langs = ["ja", "es"]

    def __init__(self, error=None, item_reply=None):
        self.error = error
        self.translator = FakeTranslator(error, item_reply)
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


@pytest.mark.parametrize("src_lang", ["es", "pt"])
def test_ocr_ok(monkeypatch, src_lang):
    monkeypatch.setattr(main, "_pipeline", FakePipeline())
    r = TestClient(main.app).post(
        "/ocr", files={"image": ("p.png", PNG, "image/png")}, data={"src_lang": src_lang}
    )
    assert r.status_code == 200
    assert r.json()["blocks"][0]["src_text"] == "hola"


def translate_body(items=None, **overrides):
    body = {
        "items": items or [
            {"id": "b1", "text": "hola", "reading_order": 0, "bbox": [1, 2, 3, 4]}
        ],
        "src_lang": "es",
        "dst_lang": "vi",
        "page_width": 100,
        "page_height": 200,
        "reading_direction": "rtl",
    }
    body.update(overrides)
    return body


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


def test_translate_items_ok(monkeypatch):
    pipeline = FakePipeline()
    monkeypatch.setattr(main, "_pipeline", pipeline)
    r = TestClient(main.app).post(
        "/translate-items",
        json=translate_body([
            {"id": "b1", "text": "hola", "reading_order": 0, "bbox": [1, 2, 3, 4]},
            {"id": "b2", "text": "adios", "reading_order": 1, "bbox": [5, 6, 7, 8]},
        ]),
    )
    assert r.status_code == 200
    assert r.json() == {"items": [
        {"id": "b1", "kind": "text", "translation": "vi:hola"},
        {"id": "b2", "kind": "text", "translation": "vi:adios"},
    ]}
    assert pipeline.translator.item_calls == [{
        "items": [
            {"id": "b1", "text": "hola", "reading_order": 0, "bbox": (1, 2, 3, 4)},
            {"id": "b2", "text": "adios", "reading_order": 1, "bbox": (5, 6, 7, 8)},
        ],
        "src": "es",
        "dst": "vi",
        "page_width": 100,
        "page_height": 200,
        "reading_direction": "rtl",
    }]


def test_translate_items_returns_sfx_as_json_null(monkeypatch):
    monkeypatch.setattr(main, "_pipeline", FakePipeline(item_reply=[
        {"id": "b1", "kind": "sfx", "translation": None},
    ]))

    response = TestClient(main.app).post("/translate-items", json=translate_body())

    assert response.status_code == 200
    assert response.json() == {"items": [{"id": "b1", "kind": "sfx", "translation": None}]}
    assert b'"translation":null' in response.content
    assert b"None" not in response.content


@pytest.mark.parametrize(
    "item_reply",
    [
        [{"id": "b1", "kind": "text", "translation": "one"}],
        [{"id": "b1", "kind": "text", "translation": "one"}, {"id": "foreign", "kind": "text", "translation": "two"}],
        [{"id": "b1", "kind": "text", "translation": "one"}, {"id": "b1", "kind": "text", "translation": "two"}],
    ],
)
def test_translate_items_rejects_invalid_translator_id_set(monkeypatch, item_reply):
    monkeypatch.setattr(main, "_pipeline", FakePipeline(item_reply=item_reply))
    r = TestClient(main.app).post(
        "/translate-items",
        json=translate_body([
            {"id": "b1", "text": "one", "reading_order": 0, "bbox": [1, 2, 3, 4]},
            {"id": "b2", "text": "two", "reading_order": 1, "bbox": [5, 6, 7, 8]},
        ]),
    )
    assert r.status_code == 502


def test_translate_items_maps_invalid_kind_to_existing_invalid_response(monkeypatch):
    monkeypatch.setattr(main, "_pipeline", FakePipeline(item_reply=[
        {"id": "b1", "kind": "sfx", "translation": "bam"},
    ]))

    response = TestClient(main.app).post("/translate-items", json=translate_body())

    assert response.status_code == 502
    assert response.json() == {
        "error": "gemini: sfx translation must be null",
        "error_code": "invalid_response",
    }


def test_translate_items_returns_machine_readable_rate_limit(monkeypatch):
    monkeypatch.setattr(
        main,
        "_pipeline",
        FakePipeline(error=TranslateError("quota", code=429, error_kind="rate_limited")),
    )

    r = TestClient(main.app).post(
        "/translate-items",
        json=translate_body(),
    )

    assert r.status_code == 429
    assert r.json() == {"error": "gemini: quota", "error_code": "rate_limited"}


def test_translate_items_returns_machine_readable_invalid_response(monkeypatch):
    monkeypatch.setattr(
        main,
        "_pipeline",
        FakePipeline(error=TranslateError("duplicate id: b1", error_kind="invalid_response")),
    )

    r = TestClient(main.app).post(
        "/translate-items",
        json=translate_body(),
    )

    assert r.status_code == 502
    assert r.json() == {"error": "gemini: duplicate id: b1", "error_code": "invalid_response"}


def test_translate_items_rejects_duplicate_input_id(monkeypatch):
    monkeypatch.setattr(main, "_pipeline", FakePipeline())
    r = TestClient(main.app).post(
        "/translate-items",
        json=translate_body([
            {"id": "b1", "text": "one", "reading_order": 0, "bbox": [1, 2, 3, 4]},
            {"id": "b1", "text": "two", "reading_order": 1, "bbox": [5, 6, 7, 8]},
        ]),
    )
    assert r.status_code == 422
    assert r.json() == {"error": "duplicate input id", "error_code": "invalid_request"}


@pytest.mark.parametrize(
    "body",
    [
        translate_body([{
            "id": "b1", "text": "hola", "reading_order": 0,
            "bbox": [1, 2, 3, 4], "extra": True,
        }]),
        translate_body(extra=True),
        translate_body([{"id": "b1", "text": "hola", "reading_order": 0, "bbox": [1, 2, 3]}]),
        translate_body([{"id": "b1", "text": "hola", "reading_order": 0, "bbox": [-1, 2, 3, 4]}]),
        translate_body(page_width=0),
        translate_body(page_height=0),
        {key: value for key, value in translate_body().items() if key != "reading_direction"},
        translate_body(reading_direction="top-down"),
        translate_body([
            {"id": "b1", "text": "one", "reading_order": 0, "bbox": [1, 2, 3, 4]},
            {"id": "b2", "text": "two", "reading_order": 2, "bbox": [5, 6, 7, 8]},
        ]),
        translate_body([
            {"id": "b1", "text": "one", "reading_order": 1, "bbox": [1, 2, 3, 4]},
            {"id": "b2", "text": "two", "reading_order": 0, "bbox": [5, 6, 7, 8]},
        ]),
    ],
)
def test_translate_items_rejects_invalid_contract(monkeypatch, body):
    monkeypatch.setattr(main, "_pipeline", FakePipeline())

    response = TestClient(main.app).post("/translate-items", json=body)

    assert response.status_code == 422
    assert response.json()["error_code"] == "invalid_request"
