import json
from pathlib import Path

import cv2
import pytest

from server.detector import Detector
from server.ocr import OcrRegistry
from server.pipeline import Pipeline

FIXTURES = Path(__file__).parent / "fixtures"
SFX_FIXTURES = FIXTURES / "sfx_pages"
SFX_CASES = json.loads((SFX_FIXTURES / "manifest.json").read_text(encoding="utf-8"))["fixtures"]


@pytest.fixture(scope="module")
def registry():
    return OcrRegistry(device="cuda")


@pytest.fixture(scope="module")
def detector():
    return Detector(device="cuda")


@pytest.fixture(scope="module")
def pipeline(registry, detector):
    value = Pipeline(detector=detector, ocr=registry, translator=object())
    yield value
    value._render_executor.shutdown(wait=True)


def crop_bubble(name):
    img = cv2.imread(str(FIXTURES / name))
    crop = img[100:420, 100:520]  # vùng bóng thoại của fixture
    return cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)


def test_registry_langs(registry):
    assert registry.langs == ["ja", "es", "pt"]


def test_manga_ocr_reads_japanese(registry):
    text = registry.get("ja").read(crop_bubble("ja_page.png"))
    assert "こんにちは" in text.replace(" ", "")


def test_paddle_reads_spanish(registry):
    text = registry.get("es").read(crop_bubble("es_page.png"))
    assert "hola" in text.lower()


@pytest.mark.parametrize("fixture", SFX_CASES, ids=lambda row: row["id"])
def test_sfx_source_yields_ocr_text(pipeline, fixture):
    result = pipeline.ocr_image(
        (SFX_FIXTURES / fixture["image"]).read_bytes(),
        fixture["src_lang"],
    )

    assert [result["image_w"], result["image_h"]] == [fixture["width"], fixture["height"]]
    assert result["blocks"]
    assert all(block["src_text"] for block in result["blocks"])
