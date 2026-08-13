import hashlib
import json
from pathlib import Path

import cv2


FIXTURE_DIR = Path(__file__).parent / "fixtures" / "sfx_pages"
MANIFEST = FIXTURE_DIR / "manifest.json"
EXPECTED = {
    "s-manga_ja_sfx": {
        "id": "s-manga_ja_sfx",
        "image": "s-manga_ja_sfx.png",
        "sha256": "233ced826f1a06dbdc5d950cde0fa2697647f20a38aef3c8322c79f5caabc423",
        "width": 1102,
        "height": 863,
        "src_lang": "ja",
        "reading_direction": "rtl",
        "expected_page_kind": "mixed",
    },
    "sfx_1": {
        "id": "sfx_1",
        "image": "sfx_1.jpg",
        "sha256": "3c5507f72a2cc7d8b630c6f3f9c5c0279cc7fdc1b57ac7771911230ba9eaceee",
        "width": 483,
        "height": 685,
        "src_lang": "ja",
        "reading_direction": "rtl",
        "expected_page_kind": "sfx_only",
    },
    "sfx_2": {
        "id": "sfx_2",
        "image": "sfx_2.jpg",
        "sha256": "d8d8f9b3fb37b41f430b12dd638c8492a40bf7d6b30fd5d4d0146d2970ace63f",
        "width": 537,
        "height": 800,
        "src_lang": "ja",
        "reading_direction": "rtl",
        "expected_page_kind": "sfx_only",
    },
}


def test_dedicated_sfx_fixture_pack_is_exact_and_decodable():
    assert MANIFEST.is_file()
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    assert set(manifest) == {"schema_version", "fixtures"}
    assert manifest["schema_version"] == "sfx-fixtures-v1"
    assert len(manifest["fixtures"]) == len(EXPECTED)
    fixtures = {row["id"]: row for row in manifest["fixtures"]}
    assert fixtures == EXPECTED
    assert {
        path.name for path in FIXTURE_DIR.iterdir() if path.suffix.lower() in {".png", ".jpg"}
    } == {row["image"] for row in EXPECTED.values()}

    for fixture in fixtures.values():
        path = FIXTURE_DIR / fixture["image"]
        assert hashlib.sha256(path.read_bytes()).hexdigest() == fixture["sha256"]
        image = cv2.imread(str(path), cv2.IMREAD_COLOR)
        assert image is not None
        assert [image.shape[1], image.shape[0]] == [fixture["width"], fixture["height"]]


def test_sfx_fixtures_do_not_join_historical_quality_sources():
    real_page_manifest = json.loads(
        (Path(__file__).parent / "fixtures" / "real_pages" / "manifest.json").read_text(encoding="utf-8")
    )
    historical_images = {row["image"] for row in real_page_manifest["fixtures"]}
    assert historical_images.isdisjoint(row["image"] for row in EXPECTED.values())
