from math import ceil, floor
from threading import Lock

import cv2
import numpy as np

_MIN_CROP_H = 48


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

    @property
    def langs(self) -> list[str]:
        return self.ocr.langs

    def ocr_image(
        self,
        image_bytes: bytes,
        src_lang: str,
        crop: tuple[float, float, float, float] | None = None,
    ) -> dict:
        """Detect + OCR thuần local, không gọi Gemini — extension gom text nhiều ảnh
        rồi dịch chung 1 call qua /translate-texts để không chạm rate limit."""
        with self._ocr_lock:
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

            work_h, work_w = work.shape[:2]
            engine = self.ocr.get(src_lang)
            blocks = []
            for region in self.detector.detect(work):
                x, y, bw, bh = region.bbox
                # clamp vào biên ảnh — detector có thể trả box chạm/vượt mép
                x, y = max(0, x), max(0, y)
                x2, y2 = min(work_w, x + bw), min(work_h, y + bh)
                if x2 <= x or y2 <= y:
                    continue
                crop_rgb = cv2.cvtColor(work[y:y2, x:x2], cv2.COLOR_BGR2RGB)
                text = engine.read(_prep_crop(crop_rgb)).strip()
                if not text:
                    continue
                blocks.append(
                    {
                        "bbox": [offset_x + x, offset_y + y, x2 - x, y2 - y],
                        "src_text": text,
                    }
                )
            return {"image_w": image_w, "image_h": image_h, "blocks": blocks}

    def process(self, image_bytes: bytes, src_lang: str, target_lang: str) -> dict:
        out = self.ocr_image(image_bytes, src_lang)
        texts = [b["src_text"] for b in out["blocks"]]
        for block, trans in zip(out["blocks"], self.translator.translate(texts, src_lang, target_lang)):
            block["trans_text"] = trans
        return out
