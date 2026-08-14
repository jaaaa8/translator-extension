import json

import numpy as np

from server.detector import DetectionResult, TextRegion
from server.diagnose import _configure_device, _parse_args, _write_manifest_candidate, diagnose_image


def _detection(image, *regions):
    raw = np.zeros(image.shape[:2], np.uint8)
    return DetectionResult(raw, raw.copy(), tuple(regions))


class _FakeDetector:
    def detect(self, img):
        return _detection(img, TextRegion((10, 10, 40, 20), False), TextRegion((60, 60, 40, 20), False))


class _FakeEngine:
    def __init__(self, outs):
        self._outs = list(outs)
        self.crops = []

    def read(self, crop_rgb):
        self.crops.append(crop_rgb)
        return self._outs.pop(0)


def test_diagnose_rows_and_colors():
    img = np.full((200, 200, 3), 255, np.uint8)
    annotated, rows = diagnose_image(img, _FakeDetector(), _FakeEngine(["Hola", ""]))

    assert [r["text"] for r in rows] == ["Hola", ""]
    assert rows[0]["bbox"] == [10, 10, 40, 20]
    assert (annotated == [0, 180, 0]).all(axis=2).any()
    assert (annotated == [0, 0, 220]).all(axis=2).any()


def test_diagnose_preserves_raw_bbox_when_crop_is_clamped():
    img = np.full((50, 50, 3), 255, np.uint8)
    detector = type(
        "Detector", (), {"detect": lambda self, image: _detection(image, TextRegion((-10, 10, 40, 20), False))}
    )()

    _, rows = diagnose_image(img, detector, _FakeEngine(["Hola"]))

    assert rows[0]["bbox"] == [-10, 10, 40, 20]


def test_diagnose_prepares_crop_before_ocr():
    engine = _FakeEngine(["Hola"])
    detector = type(
        "Detector", (), {"detect": lambda self, image: _detection(image, TextRegion((10, 10, 40, 20), False))}
    )()

    diagnose_image(np.full((100, 100, 3), 255, np.uint8), detector, engine)

    assert engine.crops[0].shape == (64, 112, 3)


def test_diagnose_cli_keeps_cuda_default_and_accepts_cpu_candidate_path():
    default = _parse_args(["page.png"])
    explicit = _parse_args(
        ["page.png", "--device", "cpu", "--manifest-candidate", "candidate.json"]
    )

    assert default.device == "cuda"
    assert default.manifest_candidate is None
    assert explicit.device == "cpu"
    assert explicit.manifest_candidate == "candidate.json"


def test_manifest_candidate_contains_only_raw_diagnostic_fields(tmp_path):
    path = tmp_path / "candidate.json"

    _write_manifest_candidate(
        path,
        [{"idx": 3, "bbox": [1, 2, 30, 40], "text": "texto"}],
    )

    assert json.loads(path.read_text(encoding="utf-8")) == {
        "candidates": [
            {
                "raw_vendor_index": 3,
                "bbox": [1, 2, 30, 40],
                "transcript": "texto",
            }
        ]
    }


def test_cpu_diagnostic_hides_cuda_before_model_import(monkeypatch):
    monkeypatch.setenv("CUDA_VISIBLE_DEVICES", "3")

    _configure_device("cpu")

    assert __import__("os").environ["CUDA_VISIBLE_DEVICES"] == "-1"
