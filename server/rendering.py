from __future__ import annotations

from hashlib import sha256
import json

import cv2
import numpy as np

from .artifacts import AnalysisArtifact, RenderArtifact, RenderBlockArtifact


INPAINT_RADIUS = 3
FEATHER_PX = 2
FIT_PADDING_PX = 4


def _failure(block_id: str, reason: str) -> RenderBlockArtifact:
    return RenderBlockArtifact(block_id, None, None, None, None, None, None, reason)


def _valid_source(region, analysis: AnalysisArtifact) -> bool:
    x, y, width, height = region.source_bbox
    shape = (height, width)
    return bool(
        width > 0
        and height > 0
        and x >= 0
        and y >= 0
        and x + width <= analysis.image_w
        and y + height <= analysis.image_h
        and isinstance(region.source_rgb, np.ndarray)
        and region.source_rgb.dtype == np.uint8
        and region.source_rgb.shape == (height, width, 3)
        and isinstance(region.raw_mask, np.ndarray)
        and region.raw_mask.shape == shape
        and isinstance(region.refined_mask, np.ndarray)
        and region.refined_mask.shape == shape
    )


def _page_bbox(local_bbox, source_bbox):
    x, y, width, height = local_bbox
    return source_bbox[0] + x, source_bbox[1] + y, width, height


def _fit_bbox(region, raw_mask, analysis: AnalysisArtifact):
    container = region.container_mask
    if not isinstance(container, np.ndarray) or container.shape != raw_mask.shape:
        return None
    container = (container > 0).astype(np.uint8)
    kernel_size = 2 * FIT_PADDING_PX + 1
    interior = cv2.erode(
        container,
        np.ones((kernel_size, kernel_size), np.uint8),
        borderType=cv2.BORDER_CONSTANT,
        borderValue=0,
    )
    if not np.any(interior):
        return None

    moments = cv2.moments(raw_mask, binaryImage=True)
    if moments["m00"] == 0:
        return None
    centroid_x = int(moments["m10"] / moments["m00"])
    centroid_y = int(moments["m01"] / moments["m00"])
    count, labels, stats, _ = cv2.connectedComponentsWithStats(interior, connectivity=8)
    label = int(labels[centroid_y, centroid_x])
    if count <= 1 or label == 0:
        return None

    local_bbox = tuple(
        int(stats[label, field])
        for field in (
            cv2.CC_STAT_LEFT,
            cv2.CC_STAT_TOP,
            cv2.CC_STAT_WIDTH,
            cv2.CC_STAT_HEIGHT,
        )
    )
    fit_bbox = _page_bbox(local_bbox, region.source_bbox)
    x, y, width, height = fit_bbox
    if (
        width <= 0
        or height <= 0
        or x < 0
        or y < 0
        or x + width > analysis.image_w
        or y + height > analysis.image_h
    ):
        return None
    return fit_bbox


def _build_block(region, analysis: AnalysisArtifact) -> RenderBlockArtifact:
    if not region.bounded:
        return _failure(region.block_id, "unsupported_region")
    if not _valid_source(region, analysis):
        return _failure(region.block_id, "clean_failed")

    raw_mask = (region.raw_mask > 0).astype(np.uint8) * 255
    refined_mask = (region.refined_mask > 0).astype(np.uint8) * 255
    if (
        not np.any(raw_mask)
        or not np.any(refined_mask)
        or np.any((raw_mask > 0) & (refined_mask == 0))
    ):
        return _failure(region.block_id, "clean_failed")

    try:
        cleaned_rgb = cv2.inpaint(
            region.source_rgb, refined_mask, INPAINT_RADIUS, cv2.INPAINT_TELEA
        )
    except cv2.error:
        return _failure(region.block_id, "clean_failed")
    if cleaned_rgb.shape != region.source_rgb.shape:
        return _failure(region.block_id, "clean_failed")

    fit_bbox = _fit_bbox(region, raw_mask, analysis)
    if fit_bbox is None:
        return _failure(region.block_id, "layout_failed")

    distance = cv2.distanceTransform(refined_mask, cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
    alpha = np.clip(distance * (255.0 / FEATHER_PX), 0, 255).astype(np.uint8)
    alpha[refined_mask == 0] = 0
    alpha[raw_mask > 0] = 255
    rgba = np.dstack((cleaned_rgb, alpha))
    encoded_bgra = cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA)
    encoded, patch = cv2.imencode(".png", encoded_bgra)
    if not encoded:
        return _failure(region.block_id, "clean_failed")
    patch_png = patch.tobytes()
    patch_bbox = region.source_bbox
    bbox_bytes = json.dumps(list(patch_bbox), separators=(",", ":")).encode("ascii")
    patch_id = sha256(patch_png + bbox_bytes).hexdigest()
    clean_region = _page_bbox(cv2.boundingRect(refined_mask), region.source_bbox)
    return RenderBlockArtifact(
        region.block_id,
        patch_id,
        patch_bbox,
        clean_region,
        fit_bbox,
        "image/png",
        patch_png,
        None,
    )


def build_render_artifact(
    analysis: AnalysisArtifact, render_artifact_key: str
) -> RenderArtifact:
    blocks = tuple(_build_block(region, analysis) for region in analysis.regions)
    return RenderArtifact(
        "render-v1",
        render_artifact_key,
        analysis.key,
        analysis.image_w,
        analysis.image_h,
        blocks,
        sum(len(block.patch_png) for block in blocks if block.patch_png is not None),
    )
