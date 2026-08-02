import copy
import hashlib
import json
import subprocess
from pathlib import Path

import pytest

from server.real_page_quality import load_manifest, match_required_regions, validate_manifest


FIXTURE_DIR = Path(__file__).parent / "fixtures" / "real_pages"
MANIFEST = FIXTURE_DIR / "manifest.json"
EXPECTED_IMAGES = {
    "mangadex_pt.png": "8c25aea5e76a9264d83698ee4953b4e037593a49c05b2517de4ebd14a1d84c60",
    "s-manga_ja_1.png": "267ac9ea29bdf0bfbb3686e2806a77b0c52d1178f2810c426ba357b277976023",
    "s-manga_ja_2.png": "7d6867a5c37db97d1f6ce32d5e5fd082d3bf3ac8e9f6914a2497b51f1fd0b9b0",
    "references/mangadex_pt_overlay_partial_and_crop.png": "2f1a89dda583183971c891bf945d583394887191bb816f8dbbe686002aba40d2",
    "references/s-manga_ja_overlay_1.png": "e10082842e79b116bc2e4fc3a5c354dce2f05567672c9023a15ac61fd0dd8f40",
    "references/s-manga_ja_overlay_2.png": "9e5c9c6952786e2e5c8263e46677bf14568df5a7c060b660b9501330c103c3a4",
}


def test_reviewed_manifest_and_six_canonical_images_are_valid():
    manifest = validate_manifest(MANIFEST)
    sources = {item["id"]: item for item in manifest["fixtures"] if item["role"] == "source_page"}
    references = [item for item in manifest["fixtures"] if item["role"] == "failure_reference"]

    assert set(sources) == {"mangadex_pt", "s-manga_ja_1", "s-manga_ja_2"}
    assert {item["image"] for item in manifest["fixtures"]} == set(EXPECTED_IMAGES)
    assert [len(sources[name]["regions"]) for name in sources] == [7, 21, 17]
    assert all(region["required"] is True for source in sources.values() for region in source["regions"])
    assert sources["mangadex_pt"]["src_lang"] == "pt"
    assert sources["mangadex_pt"]["reading_direction"] == "rtl"
    ja1 = sources["s-manga_ja_1"]
    assert ja1["regions"][1] == {
        "fixture_block_id": "b02",
        "bbox": [824, 173, 133, 19],
        "reading_order": 1,
        "kind": "sign",
        "src_text": "新人ヒーロー募集中！くわしくはＨＰへ",
        "required": True,
    }
    assert [region["bbox"] for region in ja1["regions"][:6]] == [
        [1010, 50, 58, 154],
        [824, 173, 133, 19],
        [659, 45, 30, 60],
        [596, 162, 54, 127],
        [963, 362, 117, 145],
        [770, 353, 76, 147],
    ]
    assert len(references) == 3
    assert set(references[0]) >= {"id", "role", "image", "sha256", "source_page", "labels"}
    labels = {item["source_page"]: set(item["labels"]) for item in references}
    assert labels == {
        "mangadex_pt": {
            "partial_translation",
            "overlay_missing",
            "white_bbox_exposes_source",
            "text_clipped",
        },
        "s-manga_ja_1": {
            "fragmented_blocks",
            "text_clipped",
            "oversized_text",
            "source_text_exposed",
        },
        "s-manga_ja_2": {"fragmented_blocks", "text_clipped", "source_text_exposed"},
    }
    assert "detector_missing_bubble" not in labels["mangadex_pt"]


def test_manifest_validator_rejects_broken_source_region_and_reference_schema(tmp_path):
    original = load_manifest(MANIFEST)
    source_index = next(i for i, item in enumerate(original["fixtures"]) if item["role"] == "source_page")
    reference_index = next(i for i, item in enumerate(original["fixtures"]) if item["role"] == "failure_reference")
    cases = [
        (lambda data: data["fixtures"][source_index].pop("source_name"), "source_name"),
        (lambda data: data["fixtures"][source_index].update(regions={}), "regions"),
        (
            lambda data: data["fixtures"][source_index]["regions"][0].update(fixture_block_id=""),
            "fixture_block_id",
        ),
        (lambda data: data["fixtures"][source_index]["regions"][0].update(bbox=[0, 1, 10, 10]), "bbox"),
        (lambda data: data["fixtures"][source_index]["regions"][0].update(reading_order=2), "reading_order"),
        (lambda data: data["fixtures"][source_index]["regions"][0].update(kind="caption"), "kind"),
        (lambda data: data["fixtures"][source_index]["regions"][0].update(src_text=""), "src_text"),
        (lambda data: data["fixtures"][source_index]["regions"][0].update(required=1), "required"),
        (lambda data: data["fixtures"][reference_index].update(source_page="missing"), "source_page"),
        (lambda data: data["fixtures"][reference_index].update(labels=[]), "labels"),
    ]

    for mutate, message in cases:
        data = copy.deepcopy(original)
        mutate(data)
        path = tmp_path / f"invalid-{message}.json"
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        with pytest.raises(ValueError, match=message):
            validate_manifest(path, image_root=FIXTURE_DIR)


def test_manifest_validator_rejects_fixture_hash_drift(tmp_path):
    data = load_manifest(MANIFEST)
    data["fixtures"][0]["sha256"] = "0" * 64
    path = tmp_path / "hash-drift.json"
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    with pytest.raises(ValueError, match="sha256"):
        validate_manifest(path, image_root=FIXTURE_DIR)


def test_manifest_validator_rejects_png_dimension_drift(tmp_path):
    data = load_manifest(MANIFEST)
    data["fixtures"][0].update(width=9999, height=9999)
    path = tmp_path / "dimension-drift.json"
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    with pytest.raises(ValueError, match="width/height"):
        validate_manifest(path, image_root=FIXTURE_DIR)


def test_manifest_validator_rejects_duplicate_fixtures_images_and_ids(tmp_path):
    original = load_manifest(MANIFEST)
    source = next(item for item in original["fixtures"] if item["role"] == "source_page")
    cases = [
        ("fixture-count", lambda data: data["fixtures"].append(copy.deepcopy(data["fixtures"][0])), "sáu"),
        (
            "image",
            lambda data: data["fixtures"][1].update(image=data["fixtures"][0]["image"]),
            "image trùng",
        ),
        (
            "fixture-id",
            lambda data: data["fixtures"][1].update(id=data["fixtures"][0]["id"]),
            "fixture id trùng",
        ),
        (
            "region-id",
            lambda data: next(item for item in data["fixtures"] if item["id"] == source["id"])[
                "regions"
            ][1].update(fixture_block_id=source["regions"][0]["fixture_block_id"]),
            "fixture_block_id trùng",
        ),
    ]

    for name, mutate, message in cases:
        data = copy.deepcopy(original)
        mutate(data)
        path = tmp_path / f"duplicate-{name}.json"
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        with pytest.raises(ValueError, match=message):
            validate_manifest(path, image_root=FIXTURE_DIR)


def test_canonical_images_are_tracked_once_by_sha():
    tracked = subprocess.run(
        ["git", "ls-files", "--", "*.png"], check=True, capture_output=True, text=True
    ).stdout.splitlines()
    sha_paths = {}
    for name in tracked:
        path = Path(name)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        sha_paths.setdefault(digest, []).append(path.as_posix())

    for relative, digest in EXPECTED_IMAGES.items():
        canonical = f"server/tests/fixtures/real_pages/{relative}"
        assert sha_paths.get(digest) == [canonical]


def test_match_required_regions_reports_missing_duplicate_and_unexpected():
    expected = [
        {"fixture_block_id": "b01", "bbox": [0, 0, 10, 10], "required": True},
        {"fixture_block_id": "b02", "bbox": [20, 0, 10, 10], "required": True},
    ]
    detected = [
        {"bbox": [0, 0, 10, 10]},
        {"bbox": [100, 100, 10, 10]},
    ]

    result = match_required_regions(expected, detected)

    assert result["missing"] == ["b02"]
    assert result["unexpected"] == [1]
    assert result["duplicate"] == []

    duplicate = match_required_regions(
        [{"fixture_block_id": "b01", "bbox": [0, 0, 10, 10], "required": True}],
        [{"bbox": [0, 0, 10, 10]}, {"bbox": [0, 0, 10, 10]}],
    )
    assert duplicate["duplicate"]
    assert duplicate["unexpected"] == [1]


def test_match_required_regions_accepts_one_to_one_matches():
    expected = [
        {"fixture_block_id": "b01", "bbox": [0, 0, 10, 10], "required": True},
        {"fixture_block_id": "b02", "bbox": [20, 0, 10, 10], "required": True},
    ]
    detected = [{"bbox": [1, 1, 10, 10]}, {"bbox": [20, 0, 10, 10]}]

    result = match_required_regions(expected, detected)

    assert result == {
        "matches": {"b01": 0, "b02": 1},
        "missing": [],
        "duplicate": [],
        "unexpected": [],
    }


def test_match_required_regions_reports_one_detection_overlapping_two_anchors():
    expected = [
        {"fixture_block_id": "b01", "bbox": [0, 0, 10, 10], "required": True},
        {"fixture_block_id": "b02", "bbox": [5, 0, 10, 10], "required": True},
    ]

    result = match_required_regions(expected, [{"bbox": [2, 0, 11, 10]}])

    assert result["missing"] == ["b02"]
    assert result["unexpected"] == []
    assert result["duplicate"] == [
        {"detected_index": 0, "fixture_block_ids": ["b01", "b02"]}
    ]


def test_match_required_regions_rejects_iou_exactly_at_threshold():
    expected = [{"fixture_block_id": "b01", "bbox": [0, 0, 10, 10], "required": True}]

    result = match_required_regions(expected, [{"bbox": [0, 0, 5, 10]}], min_iou=0.5)

    assert result == {
        "matches": {},
        "missing": ["b01"],
        "duplicate": [],
        "unexpected": [0],
    }
