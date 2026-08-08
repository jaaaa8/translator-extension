import numpy as np

from server.detector import DetectionResult, TextRegion
from server.region_resolver import resolve_regions


def closed_bubble_fixture():
    image = np.zeros((100, 120, 3), np.uint8)
    image[10:90, 10:110] = 255
    raw = np.zeros((100, 120), np.uint8)
    raw[30:38, 25:37] = 255
    raw[42:50, 25:39] = 255
    return image, raw, raw.copy()


def open_narration_fixture():
    image = np.zeros((100, 120, 3), np.uint8)
    image[20:80, 20:120] = 255
    raw = np.zeros((100, 120), np.uint8)
    raw[35:43, 35:50] = 255
    detection = DetectionResult(raw, raw.copy(), (TextRegion((35, 35, 15, 8), False),))
    return image, detection


def test_closed_light_component_groups_two_horizontal_fragments():
    image, raw, refined = closed_bubble_fixture()
    detection = DetectionResult(
        raw,
        refined,
        (
            TextRegion((25, 30, 12, 8), False),
            TextRegion((25, 42, 14, 8), False),
        ),
    )

    resolved = resolve_regions(image, detection)

    assert len(resolved) == 1
    assert resolved[0].bounded is True
    assert resolved[0].bbox == (25, 30, 14, 20)
    assert resolved[0].source_bbox == (10, 10, 100, 80)
    assert resolved[0].source_bgr.shape == (80, 100, 3)
    assert resolved[0].raw_mask.shape == (80, 100)
    assert resolved[0].refined_mask.shape == (80, 100)
    assert resolved[0].container_mask.shape == (80, 100)
    assert [row.bbox for row in resolved[0].fragments] == [(25, 30, 12, 8), (25, 42, 14, 8)]


def test_open_component_stays_unbounded_translation_candidate():
    image, detection = open_narration_fixture()

    resolved = resolve_regions(image, detection)

    assert len(resolved) == 1
    assert resolved[0].bounded is False
    assert resolved[0].container_mask is None
    assert resolved[0].source_bbox == (35, 35, 15, 8)


def test_adjacent_closed_bubbles_do_not_group():
    image = np.zeros((100, 140, 3), np.uint8)
    image[10:90, 10:60] = 255
    image[10:90, 80:130] = 255
    raw = np.zeros((100, 140), np.uint8)
    raw[35:43, 25:40] = 255
    raw[35:43, 95:110] = 255
    detection = DetectionResult(
        raw,
        raw.copy(),
        (TextRegion((25, 35, 15, 8), False), TextRegion((95, 35, 15, 8), False)),
    )

    resolved = resolve_regions(image, detection)

    assert len(resolved) == 2
    assert [row.bbox for row in resolved] == [(25, 35, 15, 8), (95, 35, 15, 8)]
    assert all(row.bounded for row in resolved)


def test_mixed_orientation_in_one_component_does_not_group():
    image, raw, refined = closed_bubble_fixture()
    detection = DetectionResult(
        raw,
        refined,
        (TextRegion((25, 30, 12, 8), False), TextRegion((25, 42, 14, 8), True)),
    )

    resolved = resolve_regions(image, detection)

    assert len(resolved) == 2
    assert [row.vertical for row in resolved] == [False, True]


def test_same_union_bbox_from_distinct_groups_keeps_first_result():
    image = np.zeros((100, 140, 3), np.uint8)
    image[10:90, 10:130] = 255
    raw = np.zeros((100, 140), np.uint8)
    raw[40:50, 20:100] = 255
    detection = DetectionResult(
        raw,
        raw.copy(),
        (TextRegion((20, 40, 80, 10), False), TextRegion((20, 40, 80, 10), True)),
    )

    resolved = resolve_regions(image, detection)

    assert len(resolved) == 1
    assert resolved[0].bbox == (20, 40, 80, 10)
    assert resolved[0].vertical is False


def test_unbounded_fragment_key_cannot_collide_with_bounded_component_label():
    image = np.zeros((100, 160, 3), np.uint8)
    image[10:50, 10:60] = 255
    image[70:90, 100:160] = 255
    raw = np.zeros((100, 160), np.uint8)
    raw[20:28, 20:35] = 255
    raw[75:83, 120:135] = 255
    detection = DetectionResult(
        raw,
        raw.copy(),
        (TextRegion((20, 20, 15, 8), False), TextRegion((120, 75, 15, 8), False)),
    )

    resolved = resolve_regions(image, detection)

    assert len(resolved) == 2
    assert [row.bounded for row in resolved] == [True, False]
