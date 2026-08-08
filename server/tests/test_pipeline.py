import time
from concurrent.futures import ThreadPoolExecutor
from threading import Event, Lock, Thread

import cv2
import numpy as np
import pytest

from server.detector import TextRegion
from server.pipeline import Pipeline, _dedupe_regions, _prep_crop


class FakeDetector:
    def detect(self, img):
        return [
            TextRegion(bbox=(10, 10, 100, 50), vertical=False),
            TextRegion(bbox=(20, 100, 80, 40), vertical=True),  # OCR trả rỗng → loại
            TextRegion(bbox=(20, 500, 80, 40), vertical=False),  # ngoài biên ảnh → loại
        ]


class EdgeDetector:
    def detect(self, img):
        h, w = img.shape[:2]
        return [TextRegion(bbox=(w - 1, h - 1, 1, 1), vertical=False)]


class FakeEngine:
    def __init__(self):
        self.texts = iter(["hola", ""])  # block 2 rỗng → phải bị loại

    def read(self, crop):
        return next(self.texts)


class FakeOcr:
    langs = ["ja", "es"]

    def get(self, lang):
        return FakeEngine()


class FakeTranslator:
    def translate(self, texts, src, dst):
        return [f"{dst}:{t}" for t in texts]


class OverlapDetector:
    def __init__(self):
        self.active = 0
        self.max_active = 0
        self.lock = Lock()

    def detect(self, img):
        with self.lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        time.sleep(0.02)
        with self.lock:
            self.active -= 1
        return [TextRegion(bbox=(0, 0, 20, 20), vertical=False)]


class OverlapEngine:
    def __init__(self):
        self.active = 0
        self.max_active = 0
        self.lock = Lock()

    def read(self, crop):
        with self.lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        time.sleep(0.1)
        with self.lock:
            self.active -= 1
        return ""


class SharedOcr:
    langs = ["ja", "es"]

    def __init__(self, engine):
        self.engine = engine

    def get(self, lang):
        return self.engine


def encode_png(w, h):
    return cv2.imencode(".png", np.zeros((h, w, 3), np.uint8))[1].tobytes()


def make_pipeline():
    return Pipeline(detector=FakeDetector(), ocr=FakeOcr(), translator=FakeTranslator())


def test_prep_crop_upscales_small():
    out = _prep_crop(np.zeros((20, 100, 3), np.uint8))
    assert out.shape[0] >= 48  # small crop is enlarged


def test_prep_crop_pads_large_only():
    out = _prep_crop(np.zeros((80, 200, 3), np.uint8))
    assert out.shape[:2] == (96, 216)  # 8px border only; no upscale


def test_process_returns_schema():
    out = make_pipeline().process(encode_png(300, 200), "es", "vi")
    assert out["image_w"] == 300 and out["image_h"] == 200
    assert out["blocks"] == [
        {"bbox": [10, 10, 100, 50], "src_text": "hola", "trans_text": "vi:hola"}
    ]


def test_empty_ocr_blocks_are_dropped_not_translated():
    out = make_pipeline().process(encode_png(300, 200), "es", "en")
    assert len(out["blocks"]) == 1  # block OCR rỗng không xuất hiện


def regions(*bboxes):
    return [TextRegion(bbox=b, vertical=False) for b in bboxes]


def bboxes(regs):
    return [r.bbox for r in regs]


def test_dedupe_drops_near_duplicate_boxes_keeping_the_larger():
    # toạ độ thật từ mangadex.jpeg: detector trả hai box lệch nhau 1 pixel
    kept = _dedupe_regions(regions((379, 141, 121, 89), (379, 141, 122, 89)))
    assert bboxes(kept) == [(379, 141, 122, 89)]


def test_dedupe_keeps_nested_boxes_with_small_overlap():
    # trang ja: box nhỏ nằm TRỌN trong box lớn nhưng IoU chỉ ~0.02 — có thể là
    # hiệu ứng âm thanh riêng, giữ cả hai để không mất chữ
    inner, outer = (1293, 770, 29, 57), (1070, 770, 277, 307)
    assert set(bboxes(_dedupe_regions(regions(inner, outer)))) == {inner, outer}


def test_dedupe_keeps_partially_overlapping_boxes():
    # hai vùng chữ dọc chồng nhau IoU ~0.35 — dưới ngưỡng, giữ cả hai
    a, b = (1208, 772, 234, 331), (1070, 770, 277, 307)
    assert len(_dedupe_regions(regions(a, b))) == 2


class DupeDetector:
    def detect(self, img):
        return regions((10, 10, 100, 50), (10, 10, 101, 50))


class ClampDuplicateDetector:
    def detect(self, img):
        return regions((-10, 10, 20, 20), (0, 10, 10, 20))


class OutsideDetector:
    def detect(self, img):
        return regions((-40, 10, 20, 20))


def test_duplicate_regions_are_ocred_once():
    engine = CountingEngine()
    pipeline = Pipeline(
        detector=DupeDetector(),
        ocr=SharedOcr(engine),
        translator=FakeTranslator(),
    )

    out = pipeline.ocr_image(encode_png(300, 200), "es")
    assert engine.calls == 1
    assert out["blocks"] == [{"bbox": [10, 10, 101, 50], "src_text": "hola"}]


def test_regions_equal_after_clamp_are_ocred_once():
    engine = CountingEngine()
    pipeline = Pipeline(
        detector=ClampDuplicateDetector(),
        ocr=SharedOcr(engine),
        translator=FakeTranslator(),
    )

    analysis = pipeline.analyze(encode_png(300, 200), None, "clamp-dedupe")
    events = list(pipeline.iter_ocr("clamp-dedupe", "es", "clamp-dedupe-ocr"))
    blocks = [event for event in events if event["type"] == "ocr_block"]

    assert (len(analysis.regions), engine.calls, len(blocks)) == (1, 1, 1)
    assert blocks[0]["bbox"] == [0, 10, 10, 20]


def test_region_fully_outside_image_is_dropped():
    pipeline = Pipeline(
        detector=OutsideDetector(),
        ocr=FakeOcr(),
        translator=FakeTranslator(),
    )

    analysis = pipeline.analyze(encode_png(300, 200), None, "outside")

    assert analysis.regions == ()


class CountingEngine:
    def __init__(self):
        self.calls = 0

    def read(self, crop):
        self.calls += 1
        return "hola"


def test_bad_image_raises():
    with pytest.raises(ValueError):
        make_pipeline().process(b"not an image", "ja", "vi")


def test_ocr_image_returns_blocks_without_translation():
    out = make_pipeline().ocr_image(encode_png(300, 200), "es")
    assert out["blocks"] == [{"bbox": [10, 10, 100, 50], "src_text": "hola"}]


def test_ocr_image_crops_before_detection_and_offsets_blocks():
    out = make_pipeline().ocr_image(
        encode_png(301, 201),
        "es",
        crop=(0.1, 0.1, 0.5, 0.5),
    )

    assert out["image_w"] == 301 and out["image_h"] == 201
    assert out["blocks"] == [{"bbox": [40, 30, 100, 50], "src_text": "hola"}]


def test_ocr_image_converts_normalized_crop_with_floor_and_ceil():
    pipeline = Pipeline(detector=EdgeDetector(), ocr=FakeOcr(), translator=FakeTranslator())

    out = pipeline.ocr_image(encode_png(301, 201), "es", crop=(0.1, 0.1, 0.5, 0.5))

    assert out["blocks"] == [{"bbox": [150, 100, 1, 1], "src_text": "hola"}]


@pytest.mark.parametrize(
    "crop",
    [(-0.1, 0, 1, 1), (0, 0, 0, 1), (0.8, 0, 0.2, 1), (0, 0.8, 1, 0.2)],
)
def test_ocr_image_rejects_invalid_crop(crop):
    with pytest.raises(ValueError, match="crop"):
        make_pipeline().ocr_image(encode_png(300, 200), "es", crop=crop)


def test_ocr_image_serializes_shared_models():
    detector = OverlapDetector()
    engine = OverlapEngine()
    pipeline = Pipeline(detector=detector, ocr=SharedOcr(engine), translator=FakeTranslator())
    image = encode_png(300, 200)

    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda _: pipeline.ocr_image(image, "es"), range(2)))

    assert detector.max_active == 1
    assert engine.max_active == 1


class CountingDetector:
    def __init__(self):
        self.calls = 0

    def detect(self, image):
        self.calls += 1
        return [TextRegion(bbox=(10, 10, 40, 20), vertical=False)]


class BlockingCountingDetector(CountingDetector):
    def __init__(self):
        super().__init__()
        self.entered = Event()
        self.release = Event()

    def detect(self, image):
        self.calls += 1
        self.entered.set()
        assert self.release.wait(1)
        return [TextRegion(bbox=(10, 10, 40, 20), vertical=False)]


class ThreeRegionDetector:
    def detect(self, image):
        return [
            TextRegion(bbox=(10, 10, 40, 20), vertical=False),
            TextRegion(bbox=(60, 10, 40, 20), vertical=False),
            TextRegion(bbox=(110, 10, 40, 20), vertical=False),
        ]


class TwoRegionDetector:
    def detect(self, image):
        return [
            TextRegion(bbox=(10, 10, 40, 20), vertical=False),
            TextRegion(bbox=(60, 10, 40, 20), vertical=False),
        ]


class SequenceEngine:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = 0

    def read(self, crop):
        self.calls += 1
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


class CancelAfterFirstEngine:
    def __init__(self, cancelled):
        self.cancelled = cancelled
        self.calls = 0

    def read(self, crop):
        self.calls += 1
        self.cancelled[0] = True
        return "hola"


def test_analysis_is_reused_across_recognizers():
    detector = CountingDetector()
    pipeline = Pipeline(detector=detector, ocr=FakeOcr(), translator=FakeTranslator())
    data = encode_png(300, 200)
    pipeline.analyze(data, None, "a1")
    pipeline.analyze(data, None, "a1")
    assert detector.calls == 1


def test_analyze_with_status_reports_direct_cache_hit():
    pipeline = make_pipeline()
    image_bytes = encode_png(300, 200)

    _, first_hit = pipeline.analyze_with_status(image_bytes, None, "same")
    _, second_hit = pipeline.analyze_with_status(image_bytes, None, "same")

    assert (first_hit, second_hit) == (False, True)


def test_analyze_with_status_reports_hit_after_waiting_for_lock():
    detector = BlockingCountingDetector()
    pipeline = Pipeline(detector=detector, ocr=FakeOcr(), translator=FakeTranslator())
    image_bytes = encode_png(300, 200)

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(pipeline.analyze_with_status, image_bytes, None, "same")
        assert detector.entered.wait(1)
        second = pool.submit(pipeline.analyze_with_status, image_bytes, None, "same")
        detector.release.set()
        cold_artifact, cold_hit = first.result(timeout=2)
        waited_artifact, waited_hit = second.result(timeout=2)

    assert cold_hit is False
    assert waited_hit is True
    assert waited_artifact is cold_artifact
    assert detector.calls == 1


def test_iter_ocr_retries_only_failed_block():
    engine = SequenceEngine(["hola", RuntimeError("bad"), "adios", "retry"])
    pipeline = Pipeline(
        detector=ThreeRegionDetector(),
        ocr=SharedOcr(engine),
        translator=FakeTranslator(),
    )
    pipeline.analyze(encode_png(300, 200), None, "a1")
    first = list(pipeline.iter_ocr("a1", "es", "o1"))
    assert [event["type"] for event in first].count("ocr_block_error") == 1
    second = list(pipeline.iter_ocr("a1", "es", "o1"))
    assert engine.calls == 4
    assert second[-1]["type"] == "image_done"
    assert second[-1]["failed"] == 0


def test_cancel_is_checked_between_engine_reads():
    cancelled = [False]
    engine = CancelAfterFirstEngine(cancelled)
    pipeline = Pipeline(
        detector=TwoRegionDetector(),
        ocr=SharedOcr(engine),
        translator=FakeTranslator(),
    )
    pipeline.analyze(encode_png(300, 200), None, "a1")
    events = list(pipeline.iter_ocr("a1", "es", "o1", lambda: cancelled[0]))
    assert engine.calls == 1


def test_cancelled_while_waiting_for_ocr_lock_does_not_start_a_read():
    checked = Event()
    allow_precheck_return = Event()
    precheck_returned = Event()
    cancelled = Event()
    engine = CountingEngine()
    pipeline = Pipeline(
        detector=CountingDetector(),
        ocr=SharedOcr(engine),
        translator=FakeTranslator(),
    )
    pipeline.analyze(encode_png(300, 200), None, "a1")

    def cancellation_requested():
        if not checked.is_set():
            checked.set()
            assert allow_precheck_return.wait(1)
            precheck_returned.set()
            return False
        return cancelled.is_set()

    worker = Thread(
        target=lambda: list(pipeline.iter_ocr("a1", "es", "o1", cancellation_requested))
    )
    worker.start()
    assert checked.wait(1)
    with pipeline._ocr_lock:
        allow_precheck_return.set()
        assert precheck_returned.wait(1)
        cancelled.set()
    worker.join(1)

    assert not worker.is_alive()
    assert engine.calls == 0
