import time
from concurrent.futures import ThreadPoolExecutor
from threading import Lock

import cv2
import numpy as np
import pytest

from server.detector import TextRegion
from server.pipeline import Pipeline, _prep_crop


class FakeDetector:
    def detect(self, img):
        return [
            TextRegion(bbox=(10, 10, 100, 50), vertical=False),
            TextRegion(bbox=(20, 100, 80, 40), vertical=True),  # OCR trả rỗng → loại
            TextRegion(bbox=(20, 500, 80, 40), vertical=False),  # ngoài biên ảnh → loại
        ]


class EdgeDetector:
    def detect(self, img):
        h, w = img.shape[:2]
        return [TextRegion(bbox=(w - 1, h - 1, 1, 1), vertical=False)]


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


class OverlapDetector:
    def __init__(self):
        self.active = 0
        self.max_active = 0
        self.lock = Lock()

    def detect(self, img):
        with self.lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        time.sleep(0.02)
        with self.lock:
            self.active -= 1
        return [TextRegion(bbox=(0, 0, 20, 20), vertical=False)]


class OverlapEngine:
    def __init__(self):
        self.active = 0
        self.max_active = 0
        self.lock = Lock()

    def read(self, crop):
        with self.lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        time.sleep(0.1)
        with self.lock:
            self.active -= 1
        return ""


class SharedOcr:
    langs = ["ja", "es"]

    def __init__(self, engine):
        self.engine = engine

    def get(self, lang):
        return self.engine


def encode_png(w, h):
    return cv2.imencode(".png", np.zeros((h, w, 3), np.uint8))[1].tobytes()


def make_pipeline():
    return Pipeline(detector=FakeDetector(), ocr=FakeOcr(), translator=FakeTranslator())


def test_prep_crop_upscales_small():
    out = _prep_crop(np.zeros((20, 100, 3), np.uint8))
    assert out.shape[0] >= 48  # small crop is enlarged


def test_prep_crop_pads_large_only():
    out = _prep_crop(np.zeros((80, 200, 3), np.uint8))
    assert out.shape[:2] == (96, 216)  # 8px border only; no upscale


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


def test_ocr_image_returns_blocks_without_translation():
    out = make_pipeline().ocr_image(encode_png(300, 200), "es")
    assert out["blocks"] == [{"bbox": [10, 10, 100, 50], "src_text": "hola"}]


def test_ocr_image_crops_before_detection_and_offsets_blocks():
    out = make_pipeline().ocr_image(
        encode_png(301, 201),
        "es",
        crop=(0.1, 0.1, 0.5, 0.5),
    )

    assert out["image_w"] == 301 and out["image_h"] == 201
    assert out["blocks"] == [{"bbox": [40, 30, 100, 50], "src_text": "hola"}]


def test_ocr_image_converts_normalized_crop_with_floor_and_ceil():
    pipeline = Pipeline(detector=EdgeDetector(), ocr=FakeOcr(), translator=FakeTranslator())

    out = pipeline.ocr_image(encode_png(301, 201), "es", crop=(0.1, 0.1, 0.5, 0.5))

    assert out["blocks"] == [{"bbox": [150, 100, 1, 1], "src_text": "hola"}]


@pytest.mark.parametrize(
    "crop",
    [(-0.1, 0, 1, 1), (0, 0, 0, 1), (0.8, 0, 0.2, 1), (0, 0.8, 1, 0.2)],
)
def test_ocr_image_rejects_invalid_crop(crop):
    with pytest.raises(ValueError, match="crop"):
        make_pipeline().ocr_image(encode_png(300, 200), "es", crop=crop)


def test_ocr_image_serializes_shared_models():
    detector = OverlapDetector()
    engine = OverlapEngine()
    pipeline = Pipeline(detector=detector, ocr=SharedOcr(engine), translator=FakeTranslator())
    image = encode_png(300, 200)

    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda _: pipeline.ocr_image(image, "es"), range(2)))

    assert detector.max_active == 1
    assert engine.max_active == 1
