import cv2
import numpy as np

from server.artifacts import AnalysisArtifact, PreparedRegion
from server.rendering import build_render_artifact


_DEFAULT_CONTAINER = object()


def _analysis(
    *,
    source_bbox=(17, 23, 30, 24),
    bounded=True,
    raw_mask=None,
    refined_mask=None,
    container_mask=_DEFAULT_CONTAINER,
):
    height, width = source_bbox[3], source_bbox[2]
    if raw_mask is None:
        raw_mask = np.zeros((height, width), np.uint8)
        raw_mask[10:14, 13:17] = 255
        raw_mask[7, 10] = 255
    if refined_mask is None:
        refined_mask = np.zeros((height, width), np.uint8)
        refined_mask[7:17, 10:20] = 255
    if container_mask is _DEFAULT_CONTAINER:
        container_mask = np.zeros((height, width), np.uint8)
        container_mask[2:-2, 2:-2] = 255

    source_rgb = np.full((height, width, 3), 255, np.uint8)
    source_rgb[raw_mask > 0] = 0
    source_rgb[1, 1] = (240, 20, 10)
    source_rgb[1, -2] = (5, 30, 220)
    x, y, _, _ = source_bbox
    region = PreparedRegion(
        block_id="block-1",
        bbox=(x + 10, y + 7, 10, 10),
        source_bbox=source_bbox,
        fragments=(),
        source_rgb=source_rgb,
        raw_mask=raw_mask,
        refined_mask=refined_mask,
        container_mask=container_mask,
        vertical=False,
        bounded=bounded,
    )
    arrays = [source_rgb, raw_mask, refined_mask]
    if container_mask is not None:
        arrays.append(container_mask)
    return (
        AnalysisArtifact("analysis-1", 100, 90, (region,), sum(row.nbytes for row in arrays)),
        raw_mask,
        refined_mask,
    )


def _decode_rgba(png):
    encoded = np.frombuffer(png, np.uint8)
    bgra = cv2.imdecode(encoded, cv2.IMREAD_UNCHANGED)
    assert bgra is not None
    return cv2.cvtColor(bgra, cv2.COLOR_BGRA2RGBA)


def _assert_failure(artifact, reason):
    block = artifact.blocks[0]
    assert block.reason == reason
    assert (
        block.patch_id,
        block.patch_bbox,
        block.clean_region,
        block.fit_bbox,
        block.patch_mime,
        block.patch_png,
    ) == (None, None, None, None, None, None)
    assert artifact.byte_size == 0


def test_builds_lossless_patch_with_inward_feather_and_page_space_geometry():
    analysis, raw_mask, refined_mask = _analysis()

    artifact = build_render_artifact(analysis, "render-1")

    assert artifact.schema_version == "render-v1"
    assert artifact.render_artifact_key == "render-1"
    assert artifact.analysis_key == "analysis-1"
    assert (artifact.image_w, artifact.image_h) == (100, 90)
    block = artifact.blocks[0]
    assert block.block_id == "block-1"
    assert block.reason is None
    assert block.patch_mime == "image/png"
    assert block.patch_bbox == (17, 23, 30, 24)
    assert block.clean_region == (27, 30, 10, 10)
    assert block.fit_bbox == (23, 29, 18, 12)
    assert artifact.byte_size == len(block.patch_png)

    rgba = _decode_rgba(block.patch_png)
    alpha = rgba[..., 3]
    assert rgba.shape == (24, 30, 4)
    assert np.all(alpha[refined_mask == 0] == 0)
    assert np.all(alpha[raw_mask > 0] == 255)
    feather = alpha[(refined_mask > 0) & (raw_mask == 0)]
    assert np.any((feather > 0) & (feather < 255))
    assert np.all(rgba[..., :3][raw_mask > 0] > 240)


def test_png_round_trip_preserves_asymmetric_rgb_channels():
    analysis, _, _ = _analysis()

    rgba = _decode_rgba(build_render_artifact(analysis, "render-1").blocks[0].patch_png)

    assert rgba[1, 1, :3].tolist() == [240, 20, 10]
    assert rgba[1, -2, :3].tolist() == [5, 30, 220]


def test_patch_id_includes_page_space_patch_bbox():
    first, _, _ = _analysis(source_bbox=(17, 23, 30, 24))
    shifted, _, _ = _analysis(source_bbox=(18, 23, 30, 24))

    first_block = build_render_artifact(first, "render-1").blocks[0]
    shifted_block = build_render_artifact(shifted, "render-2").blocks[0]

    assert first_block.patch_png == shifted_block.patch_png
    assert first_block.patch_id != shifted_block.patch_id
    assert len(first_block.patch_id) == 64
    int(first_block.patch_id, 16)


def test_unbounded_region_fails_closed_as_unsupported():
    analysis, _, _ = _analysis(bounded=False, container_mask=None)

    _assert_failure(build_render_artifact(analysis, "render-1"), "unsupported_region")


def test_empty_refined_mask_fails_cleaning_closed():
    analysis, _, _ = _analysis(refined_mask=np.zeros((24, 30), np.uint8))

    _assert_failure(build_render_artifact(analysis, "render-1"), "clean_failed")


def test_refined_mask_must_cover_every_raw_ink_pixel():
    raw = np.zeros((24, 30), np.uint8)
    raw[10:14, 13:17] = 255
    refined = np.zeros_like(raw)
    refined[10:14, 14:17] = 255
    analysis, _, _ = _analysis(raw_mask=raw, refined_mask=refined)

    _assert_failure(build_render_artifact(analysis, "render-1"), "clean_failed")


def test_bounded_region_without_container_fails_layout_closed():
    analysis, _, _ = _analysis(container_mask=None)

    _assert_failure(build_render_artifact(analysis, "render-1"), "layout_failed")


def test_container_without_padded_component_fails_layout_closed():
    container = np.zeros((24, 30), np.uint8)
    container[:, 13:17] = 255
    analysis, _, _ = _analysis(container_mask=container)

    _assert_failure(build_render_artifact(analysis, "render-1"), "layout_failed")
