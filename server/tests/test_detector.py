import sys
import types
from pathlib import Path
from types import SimpleNamespace

import cv2
import numpy as np
import pytest

from server.detector import DetectionResult, Detector, MODEL, TextRegion

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(scope="module")
def detector():
    return Detector(device="cuda")


def test_detects_text_region_ja(detector):
    img = cv2.imread(str(FIXTURES / "ja_page.png"))
    result = detector.detect(img)
    regions = result.regions
    assert len(regions) >= 1
    x, y, w, h = regions[0].bbox
    assert w > 0 and h > 0
    # vùng chữ phải nằm trong khu bóng thoại đã vẽ (100..520, 100..420)
    assert 50 < x < 550 and 50 < y < 500


def test_detects_text_region_es(detector):
    img = cv2.imread(str(FIXTURES / "es_page.png"))
    result = detector.detect(img)
    regions = result.regions
    assert len(regions) >= 1


def test_constructor_forwards_optional_detector_knobs(monkeypatch):
    class FakeTextDetector:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    fake_inference = types.ModuleType("inference")
    fake_inference.TextDetector = FakeTextDetector
    monkeypatch.setitem(sys.modules, "inference", fake_inference)

    detector = Detector(device="cpu", conf_thresh=0.25, input_size=1536)

    assert detector._model.kwargs == {
        "model_path": str(MODEL),
        "device": "cpu",
        "conf_thresh": 0.25,
        "input_size": 1536,
    }


def test_detect_returns_masks_regions_and_vertical():
    raw = np.zeros((20, 30), np.uint8)
    refined = np.full((20, 30), 255, np.uint8)
    block = SimpleNamespace(xyxy=(1, 2, 11, 12), vertical=True)
    detector = Detector.__new__(Detector)
    detector._model = lambda image: (raw, refined, [block])

    result = detector.detect(np.zeros((20, 30, 3), np.uint8))

    assert isinstance(result, DetectionResult)
    assert result.raw_mask is raw
    assert result.refined_mask is refined
    assert result.regions == (TextRegion((1, 2, 10, 10), True),)
