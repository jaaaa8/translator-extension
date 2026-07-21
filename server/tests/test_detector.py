from pathlib import Path

import cv2
import pytest

from server.detector import Detector

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(scope="module")
def detector():
    return Detector(device="cuda")


def test_detects_text_region_ja(detector):
    img = cv2.imread(str(FIXTURES / "ja_page.png"))
    regions = detector.detect(img)
    assert len(regions) >= 1
    x, y, w, h = regions[0].bbox
    assert w > 0 and h > 0
    # vùng chữ phải nằm trong khu bóng thoại đã vẽ (100..520, 100..420)
    assert 50 < x < 550 and 50 < y < 500


def test_detects_text_region_es(detector):
    img = cv2.imread(str(FIXTURES / "es_page.png"))
    regions = detector.detect(img)
    assert len(regions) >= 1
