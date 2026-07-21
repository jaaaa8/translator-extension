from pathlib import Path

import cv2
import pytest

from server.ocr import OcrRegistry

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(scope="module")
def registry():
    return OcrRegistry(device="cuda")


def crop_bubble(name):
    img = cv2.imread(str(FIXTURES / name))
    crop = img[100:420, 100:520]  # vùng bóng thoại của fixture
    return cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)


def test_registry_langs(registry):
    assert registry.langs == ["ja", "es"]


def test_manga_ocr_reads_japanese(registry):
    text = registry.get("ja").read(crop_bubble("ja_page.png"))
    assert "こんにちは" in text.replace(" ", "")


def test_paddle_reads_spanish(registry):
    text = registry.get("es").read(crop_bubble("es_page.png"))
    assert "hola" in text.lower()
