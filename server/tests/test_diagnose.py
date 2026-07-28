import numpy as np

from server.diagnose import diagnose_image


class _FakeRegion:
    def __init__(self, bbox):
        self.bbox = bbox
        self.vertical = False


class _FakeDetector:
    def detect(self, img):
        return [_FakeRegion((10, 10, 40, 20)), _FakeRegion((60, 60, 40, 20))]


class _FakeEngine:
    def __init__(self, outs):
        self._outs = list(outs)

    def read(self, crop_rgb):
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
    detector = type("Detector", (), {"detect": lambda self, _: [_FakeRegion((-10, 10, 40, 20))]})()

    _, rows = diagnose_image(img, detector, _FakeEngine(["Hola"]))

    assert rows[0]["bbox"] == [-10, 10, 40, 20]
