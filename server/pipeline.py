from dataclasses import replace
from hashlib import sha256
from math import ceil, floor
from threading import Lock

import cv2
import numpy as np

from .artifacts import (
    AnalysisArtifact,
    BoundedLru,
    OcrArtifact,
    PreparedFragment,
    PreparedRegion,
    stable_block_id,
)
from .region_resolver import resolve_regions

_MIN_CROP_H = 48
ANALYSIS_MAX_BYTES = 128 * 1024 * 1024
# Detector trả hai box gần trùng cho cùng một bóng (đo được IoU 0.99 và 0.93 trên
# mangadex.jpeg) → OCR hai lần, chữ trùng lên Gemini, overlay vẽ đè. Ngưỡng để rộng
# vì box lồng nhau của chữ dọc chỉ tới ~0.36 và phải giữ nguyên.
_DEDUPE_IOU = 0.5


def _iou(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> float:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    iw = min(ax + aw, bx + bw) - max(ax, bx)
    ih = min(ay + ah, by + bh) - max(ay, by)
    if iw <= 0 or ih <= 0:
        return 0.0
    inter = iw * ih
    return inter / (aw * ah + bw * bh - inter)


def _dedupe_regions(regions: list) -> list:
    """Bỏ box gần trùng, giữ box to hơn — box to không cắt cụt chữ."""
    kept = []
    for region in sorted(regions, key=lambda r: -r.bbox[2] * r.bbox[3]):
        if not any(_iou(region.bbox, k.bbox) > _DEDUPE_IOU for k in kept):
            kept.append(region)
    return kept


def _clamp_bbox(bbox, width, height):
    x, y, box_width, box_height = bbox
    left, top = max(0, x), max(0, y)
    right, bottom = min(width, x + box_width), min(height, y + box_height)
    return left, top, max(0, right - left), max(0, bottom - top)


def _offset_bbox(bbox, offset_x, offset_y):
    x, y, box_width, box_height = bbox
    return offset_x + x, offset_y + y, box_width, box_height


def _region_byte_size(region):
    arrays = [region.source_rgb, region.raw_mask, region.refined_mask]
    if region.container_mask is not None:
        arrays.append(region.container_mask)
    arrays.extend(fragment.crop_rgb for fragment in region.fragments)
    return sum(array.nbytes for array in arrays)


def _prep_crop(crop_rgb: np.ndarray) -> np.ndarray:
    """Upscale short OCR crops, then give text at the edge a white border."""
    h = crop_rgb.shape[0]
    if h < _MIN_CROP_H:
        s = _MIN_CROP_H / h
        crop_rgb = cv2.resize(crop_rgb, None, fx=s, fy=s, interpolation=cv2.INTER_CUBIC)
    return cv2.copyMakeBorder(crop_rgb, 8, 8, 8, 8, cv2.BORDER_CONSTANT, value=(255, 255, 255))


class Pipeline:
    def __init__(self, device: str = "cuda", detector=None, ocr=None, translator=None):
        # import trong hàm để test với fake không phải load model thật
        if detector is None:
            from .detector import Detector

            detector = Detector(device=device)
        if ocr is None:
            from .ocr import OcrRegistry

            ocr = OcrRegistry(device=device)
        if translator is None:
            from .translator import GeminiTranslator

            translator = GeminiTranslator()
        self.device = device
        self.detector = detector
        self.ocr = ocr
        self.translator = translator
        # ponytail: shared ML models run serially; split locks only if measured throughput needs it
        self._ocr_lock = Lock()
        self._analysis_lock = Lock()
        self._analysis_cache = BoundedLru(
            max_items=8,
            max_bytes=ANALYSIS_MAX_BYTES,
            size_of=lambda artifact: artifact.byte_size,
        )
        self._ocr_cache = BoundedLru(max_items=256)

    @property
    def langs(self) -> list[str]:
        return self.ocr.langs

    def get_analysis(self, key):
        return self._analysis_cache.get(key)

    def _decode_crop(self, image_bytes, crop):
        arr = np.frombuffer(image_bytes, np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("không decode được ảnh")
        image_h, image_w = img.shape[:2]
        offset_x = offset_y = 0
        work = img
        if crop is not None:
            left, top, right, bottom = crop
            if not (0 <= left < right <= 1 and 0 <= top < bottom <= 1):
                raise ValueError("crop outside image")
            offset_x = floor(left * image_w)
            offset_y = floor(top * image_h)
            crop_right = ceil(right * image_w)
            crop_bottom = ceil(bottom * image_h)
            work = img[offset_y:crop_bottom, offset_x:crop_right]
        return img, image_w, image_h, work, offset_x, offset_y

    def analyze(self, image_bytes, crop, analysis_key):
        artifact, _ = self.analyze_with_status(image_bytes, crop, analysis_key)
        return artifact

    def analyze_with_status(self, image_bytes, crop, analysis_key):
        cached = self.get_analysis(analysis_key)
        if cached is not None:
            return cached, True
        with self._analysis_lock:
            cached = self.get_analysis(analysis_key)
            if cached is not None:
                return cached, True
            img, image_w, image_h, work, offset_x, offset_y = self._decode_crop(image_bytes, crop)
            work_h, work_w = work.shape[:2]
            detection = self.detector.detect(work)
            deduped = _dedupe_regions(list(detection.regions))
            resolved = resolve_regions(work, replace(detection, regions=tuple(deduped)))
            prepared = []
            seen_bboxes = set()
            for region in resolved:
                union_bbox = _clamp_bbox(region.bbox, work_w, work_h)
                if not union_bbox[2] or not union_bbox[3]:
                    continue
                page_bbox = _offset_bbox(union_bbox, offset_x, offset_y)
                if page_bbox in seen_bboxes:
                    continue
                seen_bboxes.add(page_bbox)
                fragments = []
                for fragment in region.fragments:
                    fragment_bbox = _clamp_bbox(fragment.bbox, work_w, work_h)
                    if not fragment_bbox[2] or not fragment_bbox[3]:
                        continue
                    fragments.append(
                        PreparedFragment(
                            _offset_bbox(fragment_bbox, offset_x, offset_y),
                            _prep_crop(cv2.cvtColor(fragment.crop_bgr, cv2.COLOR_BGR2RGB)),
                            fragment.vertical,
                        )
                    )
                if not fragments:
                    continue
                prepared.append(
                    PreparedRegion(
                        stable_block_id(analysis_key, page_bbox, 0),
                        page_bbox,
                        _offset_bbox(region.source_bbox, offset_x, offset_y),
                        tuple(fragments),
                        cv2.cvtColor(region.source_bgr, cv2.COLOR_BGR2RGB),
                        region.raw_mask.copy(),
                        region.refined_mask.copy(),
                        region.container_mask,
                        region.vertical,
                        region.bounded,
                    )
                )
            artifact = AnalysisArtifact(
                analysis_key,
                image_w,
                image_h,
                tuple(prepared),
                sum(_region_byte_size(region) for region in prepared),
            )
            self._analysis_cache.put(analysis_key, artifact)
            return artifact, False

    def iter_ocr(self, analysis_key, src_lang, ocr_key, cancelled=lambda: False):
        analysis = self._analysis_cache.get(analysis_key)
        if analysis is None:
            raise KeyError("analysis_missing")
        yield from self._iter_ocr(analysis, analysis_key, src_lang, ocr_key, cancelled)

    def _iter_ocr(self, analysis, analysis_key, src_lang, ocr_key, cancelled):
        record = self._ocr_cache.get(ocr_key)
        if record is None:
            record = OcrArtifact(ocr_key, analysis_key)
            self._ocr_cache.put(ocr_key, record)

        for region in analysis.regions:
            cached = record.blocks.get(region.block_id)
            if cached is not None:
                yield {"type": "ocr_block", "ocr_key": ocr_key, **cached}

        if record.complete:
            yield {
                "type": "image_done",
                "ocr_key": ocr_key,
                "recognized": len(record.blocks),
                "failed": 0,
            }
            return

        with self._ocr_lock:
            engine = self.ocr.get(src_lang)
        for region in analysis.regions:
            if region.block_id in record.completed_ids:
                continue
            if cancelled():
                return
            texts = []
            failed = False
            fragments = sorted(
                region.fragments,
                key=(
                    (lambda fragment: (-fragment.bbox[0], fragment.bbox[1]))
                    if region.vertical
                    else (lambda fragment: (fragment.bbox[1], fragment.bbox[0]))
                ),
            )
            for fragment in fragments:
                if cancelled():
                    return
                try:
                    with self._ocr_lock:
                        if cancelled():
                            return
                        text = engine.read(fragment.crop_rgb).strip()
                except Exception:
                    failed = True
                    continue
                if text and not any(
                    text == existing_text or _iou(fragment.bbox, existing_bbox) > _DEDUPE_IOU
                    for existing_text, existing_bbox in texts
                ):
                    texts.append((text, fragment.bbox))
            if texts:
                block = {
                    "block_id": region.block_id,
                    "bbox": list(region.bbox),
                    "src_text": "\n".join(text for text, _ in texts),
                    "vertical": region.vertical,
                }
                record.blocks[region.block_id] = block
                yield {"type": "ocr_block", "ocr_key": ocr_key, **block}
            if failed:
                record.failures[region.block_id] = "recognizer_failed"
                yield {
                    "type": "ocr_block_error",
                    "ocr_key": ocr_key,
                    "block_id": region.block_id,
                    "code": "recognizer_failed",
                }
                continue
            record.completed_ids.add(region.block_id)
            record.failures.pop(region.block_id, None)

        record.complete = len(record.completed_ids) == len(analysis.regions)
        yield {
            "type": "image_done",
            "ocr_key": ocr_key,
            "recognized": len(record.blocks),
            "failed": len(analysis.regions) - len(record.completed_ids),
        }

    def ocr_image(
        self,
        image_bytes: bytes,
        src_lang: str,
        crop: tuple[float, float, float, float] | None = None,
    ) -> dict:
        """Detect + OCR thuần local, không gọi Gemini — extension gom text nhiều ảnh
        rồi dịch chung 1 call qua /translate-texts để không chạm rate limit."""
        digest = sha256(image_bytes).hexdigest()
        analysis_key = f"legacy:{digest}:{crop}"
        ocr_key = f"{analysis_key}:{src_lang}"
        analysis = self.analyze(image_bytes, crop, analysis_key)
        blocks = {}
        for event in self.iter_ocr(analysis_key, src_lang, ocr_key):
            if event["type"] == "ocr_block":
                blocks[event["block_id"]] = {
                    "bbox": event["bbox"],
                    "src_text": event["src_text"],
                }
        ordered = [blocks[region.block_id] for region in analysis.regions if region.block_id in blocks]
        return {"image_w": analysis.image_w, "image_h": analysis.image_h, "blocks": ordered}

    def process(self, image_bytes: bytes, src_lang: str, target_lang: str) -> dict:
        out = self.ocr_image(image_bytes, src_lang)
        texts = [b["src_text"] for b in out["blocks"]]
        for block, trans in zip(out["blocks"], self.translator.translate(texts, src_lang, target_lang)):
            block["trans_text"] = trans
        return out
