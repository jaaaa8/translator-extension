import numpy as np
from PIL import Image


class MangaOcrEngine:
    def __init__(self, device: str = "cuda"):
        from manga_ocr import MangaOcr

        self._mocr = MangaOcr()  # tự dùng GPU nếu torch thấy CUDA

    def read(self, crop_rgb: np.ndarray) -> str:
        return self._mocr(Image.fromarray(crop_rgb))


class PaddleLatinEngine:
    def __init__(self, device: str = "cuda"):
        from paddleocr import PaddleOCR

        # wheel CPU — crop nhỏ nên đủ nhanh, khỏi cài paddlepaddle-gpu trên Windows.
        # Tắt các model phụ (chỉnh hướng trang/dòng) — crop bóng thoại luôn thẳng
        self._ocr = PaddleOCR(
            lang="es",
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
            # paddlepaddle 3.x trên Windows CPU lỗi PIR/oneDNN nếu bật mkldnn
            enable_mkldnn=False,
        )

    def read(self, crop_rgb: np.ndarray) -> str:
        result = self._ocr.predict(crop_rgb)
        if not result:
            return ""
        texts = result[0].get("rec_texts") or []
        return " ".join(texts)


ENGINES = {"ja": MangaOcrEngine, "es": PaddleLatinEngine}


class OcrRegistry:
    def __init__(self, device: str = "cuda"):
        self._device = device
        self._cache = {}

    @property
    def langs(self) -> list[str]:
        return list(ENGINES)

    def get(self, lang: str):
        if lang not in self._cache:
            self._cache[lang] = ENGINES[lang](self._device)
        return self._cache[lang]
