import sys
import types
from dataclasses import dataclass
from pathlib import Path

import numpy as np

# ponytail: vendor import wandb + torchsummary nhưng chỉ dùng khi training/debug —
# stub rỗng thay vì cài thêm dep; bỏ stub nếu có ngày cần train
sys.modules.setdefault("wandb", types.ModuleType("wandb"))
_ts = types.ModuleType("torchsummary")
_ts.summary = lambda *a, **k: None
sys.modules.setdefault("torchsummary", _ts)

# ponytail: vendor dùng các alias bị NumPy 2.x gỡ — shim thay vì hạ cấp numpy
if not hasattr(np, "bool8"):
    np.bool8 = np.bool_
if not hasattr(np, "float_"):
    np.float_ = np.float64
if not hasattr(np, "int_"):
    np.int_ = np.int64

VENDOR = Path(__file__).parent / "vendor" / "comic_text_detector"
MODEL = Path(__file__).parent / "models" / "comictextdetector.pt"


@dataclass
class TextRegion:
    bbox: tuple[int, int, int, int]  # x, y, w, h theo pixel ảnh gốc
    vertical: bool


class Detector:
    def __init__(self, device: str = "cuda"):
        # ponytail: vendor dùng absolute import nội bộ nên phải chèn sys.path;
        # nếu sau này vendor lên PyPI thì thay bằng import thường
        sys.path.insert(0, str(VENDOR))
        from inference import TextDetector

        try:
            self._model = TextDetector(model_path=str(MODEL), device=device)
        except Exception as e:
            print(f"[detector] CUDA init lỗi ({e}), fallback CPU")
            self._model = TextDetector(model_path=str(MODEL), device="cpu")

    def detect(self, image_bgr: np.ndarray) -> list[TextRegion]:
        _, _, blk_list = self._model(image_bgr)
        regions = []
        for blk in blk_list:
            x1, y1, x2, y2 = (int(v) for v in blk.xyxy)
            regions.append(TextRegion(bbox=(x1, y1, x2 - x1, y2 - y1), vertical=bool(blk.vertical)))
        return regions
