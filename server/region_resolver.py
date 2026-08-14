from dataclasses import dataclass

import cv2
import numpy as np

from .artifacts import BBox
from .detector import DetectionResult, TextRegion

LIGHT_THRESHOLD = 200


@dataclass(frozen=True)
class ResolvedFragment:
    bbox: BBox
    crop_bgr: np.ndarray
    vertical: bool


@dataclass(frozen=True)
class ResolvedRegion:
    bbox: BBox
    source_bbox: BBox
    fragments: tuple[ResolvedFragment, ...]
    source_bgr: np.ndarray
    raw_mask: np.ndarray
    refined_mask: np.ndarray
    container_mask: np.ndarray | None
    vertical: bool
    bounded: bool


def _clamp_bbox(bbox: BBox, width: int, height: int) -> BBox:
    x, y, box_width, box_height = bbox
    left, top = max(0, x), max(0, y)
    right, bottom = min(width, x + box_width), min(height, y + box_height)
    return left, top, max(0, right - left), max(0, bottom - top)


def _crop(array: np.ndarray, bbox: BBox) -> np.ndarray:
    x, y, width, height = bbox
    return array[y : y + height, x : x + width]


def _component_for_region(labels: np.ndarray, raw: np.ndarray, region: TextRegion) -> int:
    height, width = labels.shape
    x, y, box_width, box_height = _clamp_bbox(region.bbox, width, height)
    if not box_width or not box_height:
        return 0
    fragment_labels = _crop(labels, (x, y, box_width, box_height))
    fragment_raw = _crop(raw, (x, y, box_width, box_height))
    candidates = fragment_labels[(fragment_raw > 0) & (fragment_labels > 0)]
    if candidates.size:
        labels_seen, counts = np.unique(candidates, return_counts=True)
        return int(labels_seen[np.argmax(counts)])
    return int(labels[y + (box_height - 1) // 2, x + (box_width - 1) // 2])


def _touches_edge(labels: np.ndarray, label: int) -> bool:
    if not label:
        return True
    return bool(
        (labels[0] == label).any()
        or (labels[-1] == label).any()
        or (labels[:, 0] == label).any()
        or (labels[:, -1] == label).any()
    )


def _component_bbox(labels: np.ndarray, label: int) -> BBox:
    component = (labels == label).astype(np.uint8)
    x, y, width, height = cv2.boundingRect(component)
    return int(x), int(y), int(width), int(height)


def _union_bbox(fragments: list[TextRegion]) -> BBox:
    left = min(fragment.bbox[0] for fragment in fragments)
    top = min(fragment.bbox[1] for fragment in fragments)
    right = max(fragment.bbox[0] + fragment.bbox[2] for fragment in fragments)
    bottom = max(fragment.bbox[1] + fragment.bbox[3] for fragment in fragments)
    return left, top, right - left, bottom - top


def _group_components(
    image_bgr: np.ndarray,
    detection: DetectionResult,
    labels: np.ndarray,
    assignments: list[int],
) -> tuple[ResolvedRegion, ...]:
    height, width = labels.shape
    groups: dict[tuple[tuple[str, int], bool], list[TextRegion]] = {}
    group_labels: dict[tuple[tuple[str, int], bool], int] = {}
    seen_fragments: set[tuple[BBox, bool]] = set()
    for index, (region, label) in enumerate(zip(detection.regions, assignments)):
        fragment_key = (region.bbox, region.vertical)
        if fragment_key in seen_fragments:
            continue
        seen_fragments.add(fragment_key)
        bounded = bool(label) and not _touches_edge(labels, label)
        key = (("component", label), region.vertical) if bounded else (("fragment", index), region.vertical)
        groups.setdefault(key, []).append(region)
        group_labels[key] = label if bounded else 0

    resolved = []
    for key, fragments in groups.items():
        label = group_labels[key]
        bounded = bool(label)
        source_bbox = (
            _clamp_bbox(_component_bbox(labels, label), width, height)
            if bounded
            else _clamp_bbox(fragments[0].bbox, width, height)
        )
        source_bgr = _crop(image_bgr, source_bbox)
        raw_mask = _crop(detection.raw_mask, source_bbox)
        refined_mask = _crop(detection.refined_mask, source_bbox)
        container_mask = None
        if bounded:
            container_mask = (_crop(labels, source_bbox) == label).astype(np.uint8) * 255
        resolved_fragments = tuple(
            ResolvedFragment(
                bbox=fragment.bbox,
                crop_bgr=_crop(image_bgr, _clamp_bbox(fragment.bbox, width, height)),
                vertical=fragment.vertical,
            )
            for fragment in fragments
        )
        resolved.append(
            ResolvedRegion(
                bbox=_union_bbox(fragments),
                source_bbox=source_bbox,
                fragments=resolved_fragments,
                source_bgr=source_bgr,
                raw_mask=raw_mask,
                refined_mask=refined_mask,
                container_mask=container_mask,
                vertical=fragments[0].vertical,
                bounded=bounded,
            )
        )
    unique = []
    seen_bboxes = set()
    for region in resolved:
        if region.bbox not in seen_bboxes:
            seen_bboxes.add(region.bbox)
            unique.append(region)
    return tuple(unique)


def resolve_regions(image_bgr: np.ndarray, detection: DetectionResult) -> tuple[ResolvedRegion, ...]:
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    raw = detection.raw_mask.astype(np.uint8) > 0
    walkable = ((gray >= LIGHT_THRESHOLD) | raw).astype(np.uint8)
    _, labels = cv2.connectedComponents(walkable, connectivity=4)
    assignments = [_component_for_region(labels, raw, region) for region in detection.regions]
    return _group_components(image_bgr, detection, labels, assignments)
