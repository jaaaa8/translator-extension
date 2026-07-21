import cv2
import numpy as np


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

    @property
    def langs(self) -> list[str]:
        return self.ocr.langs

    def ocr_image(self, image_bytes: bytes, src_lang: str) -> dict:
        """Detect + OCR thuần local, không gọi Gemini — extension gom text nhiều ảnh
        rồi dịch chung 1 call qua /translate-texts để không chạm rate limit."""
        arr = np.frombuffer(image_bytes, np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("không decode được ảnh")
        h, w = img.shape[:2]
        engine = self.ocr.get(src_lang)
        blocks = []
        for region in self.detector.detect(img):
            x, y, bw, bh = region.bbox
            # clamp vào biên ảnh — detector có thể trả box chạm/vượt mép
            x, y = max(0, x), max(0, y)
            x2, y2 = min(w, x + bw), min(h, y + bh)
            if x2 <= x or y2 <= y:
                continue
            crop = cv2.cvtColor(img[y:y2, x:x2], cv2.COLOR_BGR2RGB)
            text = engine.read(crop).strip()
            if not text:
                continue
            blocks.append({"bbox": [x, y, x2 - x, y2 - y], "src_text": text})
        return {"image_w": w, "image_h": h, "blocks": blocks}

    def process(self, image_bytes: bytes, src_lang: str, target_lang: str) -> dict:
        out = self.ocr_image(image_bytes, src_lang)
        texts = [b["src_text"] for b in out["blocks"]]
        for block, trans in zip(out["blocks"], self.translator.translate(texts, src_lang, target_lang)):
            block["trans_text"] = trans
        return out
