import numpy as np

from server.artifacts import (
    AnalysisArtifact,
    BoundedLru,
    PreparedFragment,
    PreparedRegion,
    RenderArtifact,
    RenderBlockArtifact,
    stable_block_id,
)


def artifact(key, size):
    crop = np.zeros((size, 1, 1), np.uint8)
    region = PreparedRegion(
        "b",
        (1, 2, 3, 4),
        (1, 2, 3, 4),
        (PreparedFragment((1, 2, 3, 4), crop, False),),
        crop,
        crop,
        crop,
        None,
        False,
        True,
    )
    return AnalysisArtifact(key, 100, 200, (region,), crop.nbytes)


def test_stable_block_id_changes_only_with_identity_inputs():
    a = stable_block_id("analysis-a", (1, 2, 3, 4), 0)
    assert a == stable_block_id("analysis-a", (1, 2, 3, 4), 0)
    assert a != stable_block_id("analysis-a", (1, 2, 3, 4), 1)
    assert a != stable_block_id("analysis-b", (1, 2, 3, 4), 0)


def test_lru_evicts_by_count_and_touch():
    cache = BoundedLru(max_items=2)
    cache.put("a", 1)
    cache.put("b", 2)
    assert cache.get("a") == 1
    assert cache.put("c", 3) == ["b"]
    assert cache.peek("a") == 1


def test_lru_evicts_by_bytes():
    cache = BoundedLru(max_items=32, max_bytes=5, size_of=lambda value: value.byte_size)
    cache.put("a", artifact("a", 3))
    assert cache.put("b", artifact("b", 3)) == ["a"]


def test_lru_rejects_oversize_without_mutating_existing_key():
    cache = BoundedLru(max_items=2, max_bytes=3, size_of=len)
    assert cache.put("a", b"ok") == []
    assert cache.put("a", b"xxxx") is None
    assert cache.get("a") == b"ok"


def test_lru_without_byte_cap_accepts_values():
    cache = BoundedLru(max_items=2)
    assert cache.put("a", object()) == []
    assert cache.peek("a") is not None


def test_analysis_artifact_accounts_for_prepared_region_arrays_and_excludes_png():
    source_rgb = np.zeros((2, 3, 3), np.uint8)
    ocr_crop = np.zeros((2, 1, 3), np.uint8)
    raw_mask = np.zeros((2, 3), np.uint8)
    refined_mask = np.zeros((2, 3), np.uint8)
    container_mask = np.zeros((2, 3), np.uint8)
    region = PreparedRegion(
        "block",
        (1, 2, 3, 4),
        (5, 6, 7, 8),
        (PreparedFragment((1, 2, 3, 4), ocr_crop, False),),
        source_rgb,
        raw_mask,
        refined_mask,
        container_mask,
        False,
        True,
    )
    byte_size = 42
    analysis = AnalysisArtifact("analysis", 100, 200, (region,), byte_size)
    render = RenderArtifact(
        "render-v1",
        "render-key",
        analysis.key,
        100,
        200,
        (
            RenderBlockArtifact(
                "block", "patch", (1, 2, 3, 4), None, None, "image/png", b"PNG", None
            ),
        ),
        3,
    )

    assert analysis.byte_size == (
        source_rgb.nbytes
        + ocr_crop.nbytes
        + raw_mask.nbytes
        + refined_mask.nbytes
        + container_mask.nbytes
    )
    assert render.blocks[0].patch_png == b"PNG"
    assert not hasattr(analysis, "patch_png")
