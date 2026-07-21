import cv2
import numpy as np
import pytest

from server.detector import TextRegion
from server.pipeline import Pipeline


class FakeDetector:
    def detect(self, img):
        return [
            TextRegion(bbox=(10, 10, 100, 50), vertical=False),
            TextRegion(bbox=(20, 100, 80, 40), vertical=True),  # OCR trả rỗng → loại
            TextRegion(bbox=(20, 500, 80, 40), vertical=False),  # ngoài biên ảnh → loại
        ]


class FakeEngine:
    def __init__(self):
        self.texts = iter(["hola", ""])  # block 2 rỗng → phải bị loại

    def read(self, crop):
        return next(self.texts)


class FakeOcr:
    langs = ["ja", "es"]

    def get(self, lang):
        return FakeEngine()


class FakeTranslator:
    def translate(self, texts, src, dst):
        return [f"{dst}:{t}" for t in texts]


def encode_png(w, h):
    return cv2.imencode(".png", np.zeros((h, w, 3), np.uint8))[1].tobytes()


def make_pipeline():
    return Pipeline(detector=FakeDetector(), ocr=FakeOcr(), translator=FakeTranslator())


def test_process_returns_schema():
    out = make_pipeline().process(encode_png(300, 200), "es", "vi")
    assert out["image_w"] == 300 and out["image_h"] == 200
    assert out["blocks"] == [
        {"bbox": [10, 10, 100, 50], "src_text": "hola", "trans_text": "vi:hola"}
    ]


def test_empty_ocr_blocks_are_dropped_not_translated():
    out = make_pipeline().process(encode_png(300, 200), "es", "en")
    assert len(out["blocks"]) == 1  # block OCR rỗng không xuất hiện


def test_bad_image_raises():
    with pytest.raises(ValueError):
        make_pipeline().process(b"not an image", "ja", "vi")
